import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import { prisma } from "./db";
import {
  CONTACT_EMAIL,
  type Catalog,
  createBatch,
  createCatalog,
  createConfiguration,
  createUser,
  type Customer,
  EXPECTED_SATS,
  failureOf,
  pay,
  placeOrder,
  receivePayment,
  writeOrder,
} from "./fixtures";

// Jalon 4, migration v5d : position des lignes d'une facture posée par la base, dates de création
// posées par l'horloge de la base, paiement complet resté sans traitement dans « à traiter ».

let catalog: Catalog;
let alice: Customer;
let bob: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
  bob = await createUser();
});

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;

async function balanceOf(orderId: string) {
  const [row] = await prisma.$queryRaw<
    { awaiting_decision: boolean; needs_admin_decision: boolean; needs_admin_attention: boolean; fits_stock: boolean | null }[]
  >`SELECT "awaiting_decision", "needs_admin_decision", "needs_admin_attention", "fits_stock"
    FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row;
}

describe("OrderLine.position", () => {
  it("numérote les lignes 1, 2, 3 dans l'ordre d'insertion (createMany), en ignorant la valeur fournie", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    const { orderId, configurationIds } = await prisma.$transaction(async (tx) => {
      const configs = [];
      for (let i = 0; i < 3; i++) configs.push(await createConfiguration(tx, catalog, batchId));
      const order = await tx.order.create({
        data: {
          user_id: alice.userId,
          batch_id: batchId,
          billing_address_id: alice.addressId,
          shipping_address_id: alice.addressId,
          total_amount: configs.reduce((sum, c) => sum + c.amount, 0n),
          expected_sats: EXPECTED_SATS,
          payment_address: `bc1q${crypto.randomUUID().replaceAll("-", "")}`,
          contact_email: CONTACT_EMAIL,
        },
      });
      await tx.orderLine.createMany({
        data: configs.map((c, i) => ({
          order_id: order.id,
          user_id: alice.userId,
          batch_id: batchId,
          configuration_id: c.id,
          amount: c.amount,
          position: 100 - i,
        })),
      });
      return { orderId: order.id, configurationIds: configs.map((c) => c.id) };
    });
    const lines = await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } });
    expect(lines.map((l) => l.position)).toEqual([1, 2, 3]);
    expect(lines.map((l) => l.configuration_id)).toEqual(configurationIds);
  });

  it("numérote chaque facture à partir de 1", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    const a = await placeOrder({ catalog, batchId, customer: alice, lines: [false, true] });
    const b = await placeOrder({ catalog, batchId, customer: bob, lines: [true] });
    const positions = async (orderId: string) =>
      (await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } })).map((l) => l.position);
    expect(await positions(a)).toEqual([1, 2]);
    expect(await positions(b)).toEqual([1]);
  });

  it("est immuable", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, lines: [false, false] });
    const [first] = await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } });
    expect(await constraintOf(prisma.orderLine.update({ where: { id: first.id }, data: { position: 2 } }))).toBe("OrderLine_frozen");
  });

  it("refuse deux positions identiques dans une facture (index unique) et une position < 1 (CHECK)", async () => {
    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'OrderLine_order_id_position_key'`;
    expect(indexes[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(order_id, "?position"?\)/);
    const checks = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'OrderLine_position_check'`;
    expect(checks[0]?.def).toMatch(/"?position"? >= 1/);
  });
});

describe("dates de création : horloge de la base", () => {
  it("Order.created_at et OrderLine.created_at = début de transaction de la base ; expires_at = created_at + 30 min", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    const { orderId, dbNow } = await prisma.$transaction(async (tx) => {
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      // Écart entre l'hôte et la base : le client ne doit plus envoyer l'heure de l'hôte
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { orderId: await writeOrder(tx, { catalog, batchId, customer: alice }), dbNow: now };
    });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
    expect(order.created_at).toEqual(dbNow);
    expect(order.expires_at.getTime() - order.created_at.getTime()).toBe(30 * 60_000);
    expect(order.lines.every((l) => l.created_at.getTime() === dbNow.getTime())).toBe(true);
  });

  it("Refund.created_at = clock_timestamp() : deux remboursements d'une transaction sont ordonnés", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, lines: [false, false] });
    await receivePayment(prisma, orderId, EXPECTED_SATS + 1_000n);
    await pay(orderId);
    const lines = await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } });
    await prisma.$transaction(async (tx) => {
      const [{ sats }] = await tx.$queryRaw<{ sats: bigint }[]>`SELECT "refund_prorata_sats"(${orderId}::uuid, ${lines[0].amount}) AS sats`;
      const first = await tx.refund.create({
        data: {
          order_id: orderId, kind: "overpayment", cause: "overpayment", initiated_by: "admin", created_by_auth_user_id: 1n, network_fee_payer: "user",
          network_fee_sats: 300n, amount: 0n, amount_sats: 700n, reason: "Excédent",
        },
      });
      const second = await tx.refund.create({
        data: {
          order_id: orderId, kind: "cancellation", cause: "admin_other", initiated_by: "admin", created_by_auth_user_id: 1n,
          amount: lines[0].amount, amount_sats: sats, reason: "Annulation",
        },
      });
      await tx.orderLine.update({ where: { id: lines[0].id }, data: { refund_id: second.id } });
      expect(second.created_at.getTime()).toBeGreaterThan(first.created_at.getTime());
    });
  });

  it("une date fournie reste acceptée (tests et seed antidatent)", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(Date.now() - order.created_at.getTime()).toBeGreaterThan(39 * 60_000);
  });
});

describe("order_payment_balance : paiement complet resté sans traitement", () => {
  it("paiement complet non traité : à traiter (needs_admin_attention), fits_stock vrai s'il reste de la place", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    expect(await balanceOf(orderId)).toMatchObject({ awaiting_decision: false, needs_admin_attention: false, fits_stock: null });
    await receivePayment(prisma, orderId, EXPECTED_SATS);
    expect(await balanceOf(orderId)).toMatchObject({
      awaiting_decision: true,
      needs_admin_decision: false,
      needs_admin_attention: true,
      fits_stock: true,
    });
    await pay(orderId);
    expect(await balanceOf(orderId)).toMatchObject({ awaiting_decision: false, needs_admin_attention: false, fits_stock: null });
  });

  it("paiement tardif complet sans place : à traiter, fits_stock faux", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const late = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    const taken = await placeOrder({ catalog, batchId, customer: bob });
    await pay(taken);
    await receivePayment(prisma, late, EXPECTED_SATS);
    expect(await balanceOf(late)).toMatchObject({ awaiting_decision: true, needs_admin_attention: true, fits_stock: false });
  });

  it("réservation vivante payée intégralement qui ne tient plus dans le stock : à traiter, et ni acceptée ni remboursée", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    // Situation que les contrôles de stock (Batch_stock) empêchent de valider : simulée en désactivant
    // les triggers le temps d'une transaction (une machine du lot sort du stock alors que la place est réservée).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.machine.create({ data: { model_id: catalog.modelId, batch_id: batchId, logistical_status: "missing" } });
    });
    await receivePayment(prisma, orderId, EXPECTED_SATS);
    expect(await balanceOf(orderId)).toMatchObject({ awaiting_decision: true, needs_admin_attention: true, fits_stock: false });
    const [{ fits }] = await prisma.$queryRaw<{ fits: boolean }[]>`SELECT "Order_fits_stock"(${orderId}::uuid) AS fits`;
    expect(fits).toBe(false);
  });
});
