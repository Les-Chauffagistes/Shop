import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  type Catalog,
  createBatch,
  createCatalog,
  createUser,
  type Customer,
  EXPECTED_SATS,
  failureOf,
  moveBatch,
  pay,
  placeOrder,
  receivePayment,
  setRefundAddress,
  untilAnotherSessionWaitsOnLock,
  writeRefundAddress,
  writeUserRefund,
} from "./fixtures";

// Jalon 4, migration v5e : adresse de remboursement mémorisée sur la facture, envoi d'un remboursement
// (adresse effective, immuabilité), renoncement de l'utilisateur à une commande payée jusqu'à la
// Précommande incluse, remboursement par l'admin d'une facture expirée partiellement payée (frais à la
// charge de l'utilisateur). Adapté en v5f : motif (cause), frais du renoncement et de l'excédent à la charge de
// l'utilisateur, adresse écrite avec un acteur déclaré.

type Tx = Prisma.TransactionClient;

let catalog: Catalog;
let alice: Customer;
let bob: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
  bob = await createUser();
});

const ADDRESS_A = "bc1qalicerefundaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS_B = "bc1qalicerefundbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_C = "bc1qalicerefundcccccccccccccccccccccccccc";

const USER = { initiated_by: "user" } as const;
const ADMIN = { initiated_by: "admin", created_by_auth_user_id: ADMIN_AUTH_USER_ID } as const;

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { refunds: true } });

async function balanceOf(orderId: string) {
  const [row] = await prisma.$queryRaw<
    {
      status: string;
      refunded_sats: bigint;
      unsettled_sats: bigint;
      awaiting_user_decision: boolean;
      needs_admin_decision: boolean;
      needs_admin_attention: boolean;
      abandoned_at: Date | null;
      unsent_refund_sats: bigint;
      refund_address_missing: boolean;
      user_renounce_allowed: boolean;
    }[]
  >`SELECT "status"::text AS "status", "refunded_sats", "unsettled_sats", "awaiting_user_decision", "needs_admin_decision",
           "needs_admin_attention", "abandoned_at", "unsent_refund_sats", "refund_address_missing", "user_renounce_allowed"
    FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row;
}

function toSend(orderId: string) {
  return prisma.$queryRaw<
    { refund_id: string; destination_address: string | null; destination_source: string | null; address_missing: boolean }[]
  >`SELECT "refund_id", "destination_address", "destination_source", "address_missing"
    FROM "refunds_to_send" WHERE "order_id" = ${orderId}::uuid ORDER BY "created_at"`;
}

/** Facture payée de `lines` machines (sans kit : 50 000 c chacune), `extraSats` reçus en plus du montant attendu. */
async function paidOrder(batchId: string, customer: Customer, { lines = 1, extraSats = 0n, refundAddress }: { lines?: number; extraSats?: bigint; refundAddress?: string } = {}) {
  const orderId = await placeOrder({ catalog, batchId, customer, lines: Array(lines).fill(false), refundAddress });
  if (extraSats > 0n) await receivePayment(prisma, orderId, EXPECTED_SATS + extraSats);
  await pay(orderId);
  return orderId;
}

const lineIdsOf = async (orderId: string) =>
  (await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } })).map((l) => l.id);

const FEE = 300n;

/**
 * Annulation de machines d'une commande payée, au prorata (brut). Renoncement de l'utilisateur (v5f) : frais à
 * sa charge, déduits ; admin : motif admin_other, frais boutique. Toutes les machines annulées : ce qui reste
 * reçu est remboursé (reliquat d'excédent, sans frais : une seule ligne les porte) et la facture passe à remboursée.
 */
async function writeCancellation(
  tx: Tx,
  orderId: string,
  lineIds: string[],
  by: { initiated_by: "user" } | { initiated_by: "admin"; created_by_auth_user_id: bigint },
) {
  const lines = await tx.orderLine.findMany({ where: { id: { in: lineIds } } });
  const amount = lines.reduce((sum, l) => sum + l.amount, 0n);
  const [{ sats }] = await tx.$queryRaw<{ sats: bigint }[]>`SELECT "refund_prorata_sats"(${orderId}::uuid, ${amount}) AS "sats"`;
  const user = by.initiated_by === "user";
  const fees = user
    ? ({ cause: "user_renounce", network_fee_payer: "user" } as const)
    : ({ cause: "admin_other", network_fee_payer: "shop" } as const);
  const refund = await tx.refund.create({
    data: {
      order_id: orderId, kind: "cancellation", ...by, ...fees, amount, amount_sats: user ? sats - FEE : sats, network_fee_sats: FEE,
      reason: "Renoncement",
    },
  });
  await tx.orderLine.updateMany({ where: { id: { in: lineIds } }, data: { refund_id: refund.id } });
  if ((await tx.orderLine.count({ where: { order_id: orderId, refund_id: null } })) > 0) return;
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const [{ refunded }] = await tx.$queryRaw<{ refunded: bigint }[]>`
    SELECT "refunded_sats" AS "refunded" FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  // Reliquat d'excédent : jamais quand l'utilisateur renonce lui-même (v5k, Refund_cause_check) ; l'admin le peut
  if (!user && order.received_sats > refunded) {
    await tx.refund.create({
      data: {
        order_id: orderId,
        kind: "overpayment",
        ...by,
        ...fees,
        amount: 0n,
        amount_sats: order.received_sats - refunded,
        network_fee_sats: 0n,
        reason: "Renoncement (excédent)",
      },
    });
  }
  await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
}

const renounce = (orderId: string, lineIds: string[]) => prisma.$transaction((tx) => writeCancellation(tx, orderId, lineIds, USER));

/** Remboursement décidé par l'admin d'un paiement partiel, frais réseau à la charge de l'utilisateur. */
async function writeAdminUserFeeRefund(tx: Tx, orderId: string, feeSats: bigint, by: Partial<typeof ADMIN> = ADMIN) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const refund = await tx.refund.create({
    data: {
      order_id: orderId,
      kind: "cancellation",
      cause: "partial_payment",
      initiated_by: "admin",
      ...by,
      amount: order.total_amount,
      amount_sats: order.received_sats - feeSats,
      network_fee_sats: feeSats,
      network_fee_payer: "user",
      reason: "Utilisateur contacté sans réponse : versement remboursé, frais réseau à sa charge",
    },
  });
  await tx.orderLine.updateMany({ where: { order_id: orderId }, data: { refund_id: refund.id } });
  await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
}

const send = (refundId: string, destination: string, data: Partial<Prisma.RefundUncheckedUpdateInput> = {}, db: Tx | typeof prisma = prisma) =>
  db.refund.update({
    where: { id: refundId },
    data: { sent_at: new Date(0), reference: "txid-refund", destination_address: destination, sent_by_auth_user_id: ADMIN_AUTH_USER_ID, ...data },
  });

/** Excédent de 1 000 sats remboursé par l'admin (jamais d'office depuis v5h), frais à la charge de l'utilisateur (v5f) : 700 versés. */
const OVERPAYMENT = {
  kind: "overpayment", cause: "overpayment", ...ADMIN, network_fee_payer: "user", network_fee_sats: FEE,
  amount: 0n, amount_sats: 1_000n - FEE, reason: "Excédent de paiement",
} as const;

async function overpaymentRefund(orderId: string) {
  return prisma.refund.create({ data: { order_id: orderId, ...OVERPAYMENT } });
}

describe("adresse de remboursement de la facture (Order.refund_address)", () => {
  it("saisie à la création (facultative) ; format ; jamais une adresse de paiement de la boutique", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const withAddress = await placeOrder({ catalog, batchId, customer: alice, refundAddress: ADDRESS_A });
    expect((await orderOf(withAddress)).refund_address).toBe(ADDRESS_A);
    const without = await placeOrder({ catalog, batchId, customer: bob });
    expect((await orderOf(without)).refund_address).toBeNull();

    const own = (await orderOf(without)).payment_address;
    const other = (await orderOf(withAddress)).payment_address;
    const setAddress = (refund_address: string | null) => setRefundAddress(without, refund_address);
    expect(await constraintOf(setAddress("pas une adresse"))).toBe("Order_refund_address_check");
    expect(await constraintOf(setAddress(own))).toBe("Order_refund_address_ours"); // sa propre adresse : aussi CHECK à l'insertion
    expect(await constraintOf(setAddress(other))).toBe("Order_refund_address_ours");
    const carol = await createUser();
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: carol, refundAddress: other }))).toBe("Order_refund_address_ours");

    // Modifiable (et effaçable) tant que rien n'est envoyé
    await setAddress(ADDRESS_B);
    await setAddress(null);
    expect((await orderOf(without)).refund_address).toBeNull();
  });

  it("sans adresse effective, le remboursement est « à traiter » ; l'adresse de la facture sert aux remboursements automatiques", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { extraSats: 1_000n });
    const refund = await overpaymentRefund(orderId);

    expect(await toSend(orderId)).toEqual([{ refund_id: refund.id, destination_address: null, destination_source: null, address_missing: true }]);
    expect(await balanceOf(orderId)).toMatchObject({ unsent_refund_sats: 700n, refund_address_missing: true, needs_admin_attention: true });
    // Envoi impossible sans adresse
    expect(await constraintOf(prisma.refund.update({ where: { id: refund.id }, data: { sent_at: new Date(), reference: "t" } }))).toBe(
      "Refund_sent_check",
    );

    // L'utilisateur renseigne puis corrige son adresse : le remboursement non envoyé la suit
    await setRefundAddress(orderId, ADDRESS_A);
    await setRefundAddress(orderId, ADDRESS_B);
    expect(await toSend(orderId)).toEqual([{ refund_id: refund.id, destination_address: ADDRESS_B, destination_source: "order", address_missing: false }]);
    expect(await balanceOf(orderId)).toMatchObject({ refund_address_missing: false, needs_admin_attention: false });
  });
});

describe("envoi d'un remboursement", () => {
  it("adresse inscrite = adresse effective ; date posée par la base ; ensuite tout est figé, adresse de la facture comprise", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { extraSats: 1_000n, refundAddress: ADDRESS_A });
    const refund = await overpaymentRefund(orderId);

    // L'utilisateur a changé d'adresse depuis que l'admin l'a lue : l'envoi vers l'ancienne est refusé
    await setRefundAddress(orderId, ADDRESS_B);
    expect(await constraintOf(send(refund.id, ADDRESS_A))).toBe("Refund_sent_destination");
    // Forme de l'envoi
    expect(await constraintOf(send(refund.id, ADDRESS_B, { reference: " " }))).toBe("Refund_reference_check");
    expect(await constraintOf(prisma.refund.update({ where: { id: refund.id }, data: { sent_by_auth_user_id: 1n } }))).toBe(
      "Refund_sent_by_check",
    );

    const before = new Date();
    const sent = await send(refund.id, ADDRESS_B);
    expect(sent.sent_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000); // horloge de la base, pas 1970
    expect(sent).toMatchObject({ destination_address: ADDRESS_B, reference: "txid-refund", sent_by_auth_user_id: ADMIN_AUTH_USER_ID });
    expect(await toSend(orderId)).toEqual([]);
    expect(await balanceOf(orderId)).toMatchObject({ unsent_refund_sats: 0n, refund_address_missing: false });

    const change = (data: Prisma.RefundUncheckedUpdateInput) => prisma.refund.update({ where: { id: refund.id }, data });
    for (const data of [
      { destination_address: ADDRESS_C },
      { reference: "autre" },
      { sent_at: null },
      { sent_at: new Date() },
      { amount_sats: 699n },
      { reason: "autre motif" },
      { sent_by_auth_user_id: null },
    ] satisfies Prisma.RefundUncheckedUpdateInput[]) {
      expect(await constraintOf(change(data))).toBe("Refund_sent_frozen");
    }
    expect(await constraintOf(change({ created_by_auth_user_id: 2n }))).toBe("Refund_immutable");
    expect(await constraintOf(prisma.refund.delete({ where: { id: refund.id } }))).toBe("Refund_append_only");
    expect(await constraintOf(setRefundAddress(orderId, ADDRESS_C))).toBe("Order_refund_address_frozen");
  });

  it("adresse choisie par l'admin sur le remboursement : prioritaire, jamais une adresse de la boutique ; envoi déjà fait à la création", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { extraSats: 1_000n, refundAddress: ADDRESS_A });
    const refund = await overpaymentRefund(orderId);
    const ours = (await orderOf(await placeOrder({ catalog, batchId, customer: bob }))).payment_address;

    expect(await constraintOf(prisma.refund.update({ where: { id: refund.id }, data: { destination_address: ours } }))).toBe(
      "Refund_destination_ours",
    );
    expect(await constraintOf(prisma.refund.update({ where: { id: refund.id }, data: { destination_address: "court" } }))).toBe(
      "Refund_destination_address_check",
    );
    await prisma.refund.update({ where: { id: refund.id }, data: { destination_address: ADDRESS_C } });
    expect(await toSend(orderId)).toMatchObject([{ destination_address: ADDRESS_C, destination_source: "refund" }]);
    expect(await constraintOf(send(refund.id, ADDRESS_A))).toBe("Refund_sent_destination");
    await send(refund.id, ADDRESS_C);

    // Remboursement enregistré déjà envoyé (service de paiement : sent_by NULL) ; date de la base
    const other = await paidOrder(batchId, await createUser(), { extraSats: 1_000n });
    const direct = await prisma.refund.create({
      data: {
        order_id: other,
        ...OVERPAYMENT,
        destination_address: ADDRESS_B,
        reference: "txid-service",
        sent_at: new Date(0),
      },
    });
    expect(direct.sent_at!.getTime()).toBeGreaterThan(0);
    expect(direct.sent_by_auth_user_id).toBeNull();
  });

  it("concurrence : un changement d'adresse pendant l'envoi attend, puis est refusé ; l'envoi qui suit un changement le voit", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { extraSats: 1_000n, refundAddress: ADDRESS_A });
    const refund = await overpaymentRefund(orderId);

    // Changement d'adresse validé d'abord (ligne Order verrouillée) : l'envoi vers l'ancienne adresse échoue
    let sending: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await writeRefundAddress(tx, orderId, ADDRESS_B);
      sending = failureOf(send(refund.id, ADDRESS_A));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await sending!)?.constraint).toBe("Refund_sent_destination");

    // Envoi validé d'abord : le changement d'adresse attend, puis voit l'envoi
    let changing: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await send(refund.id, ADDRESS_B, {}, tx);
      changing = failureOf(setRefundAddress(orderId, ADDRESS_C));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await changing!)?.constraint).toBe("Order_refund_address_frozen");
    expect((await orderOf(orderId)).refund_address).toBe(ADDRESS_B);
    // v5f : journal des changements, le changement refusé n'y figure pas
    const log = await prisma.orderRefundAddressChange.findMany({ where: { order_id: orderId }, orderBy: { created_at: "asc" } });
    expect(log.map((c) => [c.old_address, c.new_address, c.actor])).toEqual([
      [null, ADDRESS_A, "user"],
      [ADDRESS_A, ADDRESS_B, "user"],
    ]);
  });
});

describe("renoncement de l'utilisateur à une commande payée", () => {
  it("en Précommande : une machine au prorata, puis le reste ; l'excédent reste à l'admin (v5k) ; frais à la charge de l'utilisateur, une fois par envoi ; pas un abandon", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { lines: 2, extraSats: 1_000n, refundAddress: ADDRESS_A });
    const [first, second] = await lineIdsOf(orderId);
    expect(await balanceOf(orderId)).toMatchObject({ user_renounce_allowed: true });

    await renounce(orderId, [first]);
    expect(await balanceOf(orderId)).toMatchObject({ status: "paid", refunded_sats: EXPECTED_SATS / 2n, user_renounce_allowed: true });

    await renounce(orderId, [second]);
    const order = await orderOf(orderId);
    expect(order.status).toBe("refunded");
    expect(order.refunds.map((r) => [r.kind, r.cause, r.network_fee_payer, r.amount_sats, r.network_fee_sats])).toEqual([
      ["cancellation", "user_renounce", "user", EXPECTED_SATS / 2n - FEE, FEE],
      ["cancellation", "user_renounce", "user", EXPECTED_SATS / 2n - FEE, FEE],
    ]);
    // Le prix payé est rendu ; l'excédent reste « à traiter » (décision de l'admin) 
    expect(await balanceOf(orderId)).toMatchObject({
      refunded_sats: EXPECTED_SATS,
      unsettled_sats: 1_000n,
      needs_admin_decision: true,
      abandoned_at: null,
      refund_address_missing: false,
      user_renounce_allowed: false,
    });
    expect((await toSend(orderId)).map((r) => r.destination_address)).toEqual([ADDRESS_A, ADDRESS_A]);
    // Ni délai ni compteur d'abandons : une nouvelle facture est possible tout de suite
    await placeOrder({ catalog, batchId, customer: alice });
  });

  it("après la Précommande, seul l'admin annule (tracé) ; l'utilisateur ne renonce qu'à une commande payée, sans rabais", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { lines: 2 });
    const [first, second] = await lineIdsOf(orderId);
    await moveBatch(batchId, "preorder", "ordering");

    expect(await balanceOf(orderId)).toMatchObject({ user_renounce_allowed: false });
    expect(await constraintOf(renounce(orderId, [first]))).toBe("Refund_user_renounce_window");
    // L'admin, à tout statut, avec son identifiant
    expect(
      await constraintOf(prisma.$transaction((tx) => writeCancellation(tx, orderId, [first], { initiated_by: "admin", created_by_auth_user_id: null! }))),
    ).toBe("Refund_admin_traced_check");
    await prisma.$transaction((tx) => writeCancellation(tx, orderId, [first], ADMIN));
    await moveBatch(batchId, "ordering", "awaiting_reception");
    await prisma.$transaction((tx) => writeCancellation(tx, orderId, [second], ADMIN));
    expect((await orderOf(orderId)).refunds.map((r) => [r.initiated_by, r.created_by_auth_user_id])).toEqual([
      ["admin", ADMIN_AUTH_USER_ID],
      ["admin", ADMIN_AUTH_USER_ID],
    ]);

    // Facture non payée (annulée puis payée) : relève de l'admin
    const other = await createBatch(catalog, { quantity: 5 });
    const cancelled = await placeOrder({ catalog, batchId: other, customer: bob });
    await prisma.order.update({ where: { id: cancelled }, data: { status: "cancelled" } });
    await receivePayment(prisma, cancelled, EXPECTED_SATS);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: cancelled } });
    expect(
      await constraintOf(
        prisma.refund.create({
          data: {
            order_id: cancelled, kind: "cancellation", cause: "user_renounce", ...USER, network_fee_payer: "user", network_fee_sats: FEE,
            amount: order.total_amount, amount_sats: EXPECTED_SATS - FEE, reason: "x",
          },
        }),
      ),
    ).toBe("Refund_user_renounce_paid");

    // Rabais : décision de l'admin seulement (v5f : Refund_cause_check remplace Refund_initiator_check) ; le
    // remboursement d'un paiement partiel n'est jamais un automatisme
    const paid = await paidOrder(other, await createUser());
    const refund = (data: Partial<Prisma.RefundUncheckedCreateInput>) =>
      prisma.refund.create({
        data: { order_id: paid, kind: "discount", cause: "discount", ...USER, amount: 100n, amount_sats: 80n, network_fee_sats: 10n, reason: "x", ...data },
      });
    expect(await constraintOf(refund({}))).toBe("Refund_cause_check");
    expect(await constraintOf(refund({ initiated_by: "system" }))).toBe("Refund_cause_check");
    const partial = await placeOrder({ catalog, batchId: other, customer: await createUser(), expiredMinutesAgo: 10 });
    await receivePayment(prisma, partial, 30_000n);
    expect(
      await constraintOf(
        refund({ order_id: partial, kind: "cancellation", cause: "partial_payment", initiated_by: "system", network_fee_payer: "user" }),
      ),
    ).toBe("Refund_cause_check");
  });

  it("concurrence : un renoncement validé avant le passage à Commande en cours passe, la transition attend", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { lines: 2 });
    const [first] = await lineIdsOf(orderId);

    let moving: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await writeCancellation(tx, orderId, [first], USER); // verrou du lot
      moving = (async () => moveBatch(batchId, "preorder", "ordering"))();
      await untilAnotherSessionWaitsOnLock();
    });
    await moving;
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("ordering");
    expect((await orderOf(orderId)).refunds).toMatchObject([{ initiated_by: "user", kind: "cancellation" }]);
  });

  it("concurrence : un passage à Commande en cours validé avant le renoncement le fait échouer", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { lines: 2 });
    const [first] = await lineIdsOf(orderId);

    let renouncing: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.batchStatusTransition.create({
        data: { batch_id: batchId, from_status: "preorder", to_status: "ordering", changed_by_auth_user_id: ADMIN_AUTH_USER_ID },
      });
      renouncing = failureOf(renounce(orderId, [first]));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await renouncing!)?.constraint).toBe("Refund_user_renounce_window");
    expect((await orderOf(orderId)).refunds).toEqual([]);
  });
});

describe("remboursement par l'admin d'une facture expirée partiellement payée, frais à la charge de l'utilisateur", () => {
  it("après la fin de la réservation seulement, tracé (admin, motif), si le versement couvre les frais", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const expired = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 60 });
    await receivePayment(prisma, expired, 30_000n);
    expect(await balanceOf(expired)).toMatchObject({ awaiting_user_decision: true, needs_admin_attention: true });

    const adminRefund = (orderId: string, fee: bigint, by?: Partial<typeof ADMIN>) =>
      prisma.$transaction((tx) => writeAdminUserFeeRefund(tx, orderId, fee, by));
    expect(await constraintOf(adminRefund(expired, 30_000n))).toBe("Refund_user_net_positive");
    expect(await constraintOf(adminRefund(expired, 400n, { created_by_auth_user_id: undefined }))).toBe("Refund_admin_traced_check");

    // Réservation vivante : l'utilisateur peut encore compléter, seul lui choisit le remboursement
    const live = await placeOrder({ catalog, batchId, customer: bob });
    await receivePayment(prisma, live, 30_000n);
    expect(await constraintOf(adminRefund(live, 400n))).toBe("Refund_partial_payment_after_expiry");
    await prisma.$transaction((tx) => writeUserRefund(tx, live, 400n));

    await adminRefund(expired, 400n);
    const order = await orderOf(expired);
    expect(order).toMatchObject({ status: "refunded", paid_at: null });
    expect(order.refunds).toMatchObject([
      { initiated_by: "admin", created_by_auth_user_id: ADMIN_AUTH_USER_ID, network_fee_payer: "user", amount_sats: 29_600n, network_fee_sats: 400n },
    ]);
    // Rien à décider ; sans adresse, l'admin la demande à l'utilisateur (« à traiter »)
    expect(await balanceOf(expired)).toMatchObject({
      refunded_sats: 30_000n,
      unsettled_sats: 0n,
      awaiting_user_decision: false,
      needs_admin_decision: false,
      refund_address_missing: true,
      needs_admin_attention: true,
    });
    expect((await balanceOf(expired)).abandoned_at).toEqual(order.expires_at); // abandon daté de l'expiration, comme avant
  });

  it("concurrence : un appoint complet validé avant le remboursement de l'admin le fait échouer", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    await receivePayment(prisma, orderId, 30_000n);

    let refunding: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await receivePayment(tx, orderId, 50_000n); // ligne Order verrouillée
      refunding = failureOf(prisma.$transaction((tx2) => writeAdminUserFeeRefund(tx2, orderId, 400n)));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await refunding!)?.constraint).toBe("Refund_partial_payment_allowed");
    expect((await orderOf(orderId)).refunds).toEqual([]);
  });

  it("concurrence : un appoint arrivé après le remboursement de l'admin est tracé et « à traiter »", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    await receivePayment(prisma, orderId, 30_000n);

    let paying: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await writeAdminUserFeeRefund(tx, orderId, 400n);
      paying = (async () => receivePayment(prisma, orderId, 50_000n))();
      await untilAnotherSessionWaitsOnLock();
    });
    await paying;
    expect(await balanceOf(orderId)).toMatchObject({ status: "refunded", needs_admin_decision: true, unsettled_sats: 50_000n });
  });
});
