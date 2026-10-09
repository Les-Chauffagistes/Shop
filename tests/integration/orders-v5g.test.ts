import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  type Catalog,
  createBatch,
  createCatalog,
  createConfiguration,
  createUser,
  type Customer,
  failureOf,
  moveBatch,
  pay,
  placeOrder,
  receivePayment,
  wish,
} from "./fixtures";

// Jalon 4, migration v5g : l'admin enregistre une annulation à la demande de l'utilisateur (user_renounce,
// frais à sa charge) à toute étape ; dates de création des configurations et wishlists posées par la base.

type Tx = Prisma.TransactionClient;

let catalog: Catalog;
let alice: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
});

const FEE = 300n;
const ADMIN = { initiated_by: "admin", created_by_auth_user_id: ADMIN_AUTH_USER_ID } as const;
const RENOUNCE = { cause: "user_renounce", network_fee_payer: "user", network_fee_sats: FEE } as const;

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;

async function paidOrder(batchId: string, { lines = 2, extraSats = 0n } = {}) {
  const orderId = await placeOrder({ catalog, batchId, customer: alice, lines: Array(lines).fill(false) });
  if (extraSats > 0n) await receivePayment(prisma, orderId, (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).expected_sats + extraSats);
  await pay(orderId);
  return orderId;
}

const lineIdsOf = async (orderId: string) =>
  (await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } })).map((l) => l.id);

/** Annulation de `lineIds` au prorata (brut), frais déduits si l'utilisateur les paie ; lignes rattachées. */
async function cancelLines(tx: Tx, orderId: string, lineIds: string[], data: Partial<Prisma.RefundUncheckedCreateInput>) {
  const lines = await tx.orderLine.findMany({ where: { id: { in: lineIds } } });
  const amount = lines.reduce((sum, l) => sum + l.amount, 0n);
  const [{ sats }] = await tx.$queryRaw<{ sats: bigint }[]>`SELECT "refund_prorata_sats"(${orderId}::uuid, ${amount}) AS "sats"`;
  const refund = await tx.refund.create({
    data: {
      order_id: orderId, kind: "cancellation", amount, amount_sats: data.network_fee_payer === "user" ? sats - FEE : sats,
      initiated_by: "admin", cause: "admin_other", reason: "Annulation", ...data,
    },
  });
  await tx.orderLine.updateMany({ where: { id: { in: lineIds } }, data: { refund_id: refund.id } });
  return { refund, sats };
}

describe("annulation par l'admin à la demande de l'utilisateur (user_renounce)", () => {
  it("permise à toute étape (Commande en cours, Réception, Contrôle), frais à la charge de l'utilisateur, admin tracé", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, { lines: 3, extraSats: 1_000n });
    const [first, second, third] = await lineIdsOf(orderId);
    await moveBatch(batchId, "preorder", "ordering");

    // L'utilisateur lui-même : toujours refusé après la Précommande
    expect(
      await constraintOf(prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { ...RENOUNCE, initiated_by: "user" }))),
    ).toBe("Refund_user_renounce_window");
    // L'admin : tracé (Refund_admin_traced_check), frais à la charge de l'utilisateur (Refund_cause_fee_payer)
    expect(
      await constraintOf(prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { ...RENOUNCE, initiated_by: "admin" }))),
    ).toBe("Refund_admin_traced_check");
    expect(
      await constraintOf(
        prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { ...ADMIN, cause: "user_renounce", network_fee_payer: "shop", network_fee_sats: FEE })),
      ),
    ).toBe("Refund_cause_fee_payer");
    // Jamais un automatisme
    expect(
      await constraintOf(prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { ...RENOUNCE, initiated_by: "system" }))),
    ).toBe("Refund_cause_check");

    await prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { ...ADMIN, ...RENOUNCE }));
    await moveBatch(batchId, "ordering", "awaiting_reception");
    await prisma.$transaction((tx) => cancelLines(tx, orderId, [second], { ...ADMIN, ...RENOUNCE }));
    await moveBatch(batchId, "awaiting_reception", "inspection");

    // Reliquat d'excédent : seulement avec l'annulation de toute la facture (Refund_cause_remainder, inchangé)
    expect(
      await constraintOf(
        prisma.refund.create({
          data: { order_id: orderId, kind: "overpayment", ...ADMIN, ...RENOUNCE, network_fee_sats: 0n, amount: 0n, amount_sats: 1_000n, reason: "Reliquat" },
        }),
      ),
    ).toBe("Refund_cause_remainder");
    await prisma.$transaction(async (tx) => {
      await cancelLines(tx, orderId, [third], { ...ADMIN, ...RENOUNCE });
      // Frais portés une seule fois (Refund_fee_single_line_check)
      await tx.refund.create({
        data: { order_id: orderId, kind: "overpayment", ...ADMIN, ...RENOUNCE, network_fee_sats: 0n, amount: 0n, amount_sats: 1_000n, reason: "Reliquat" },
      });
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { refunds: { orderBy: { created_at: "asc" } } } });
    expect(order.status).toBe("refunded");
    expect(order.refunds.map((r) => [r.kind, r.cause, r.initiated_by, r.created_by_auth_user_id, r.network_fee_payer, r.network_fee_sats])).toEqual([
      ["cancellation", "user_renounce", "admin", ADMIN_AUTH_USER_ID, "user", FEE],
      ["cancellation", "user_renounce", "admin", ADMIN_AUTH_USER_ID, "user", FEE],
      ["cancellation", "user_renounce", "admin", ADMIN_AUTH_USER_ID, "user", FEE],
      ["overpayment", "user_renounce", "admin", ADMIN_AUTH_USER_ID, "user", 0n],
    ]);
    // Tout ce qui a été reçu est sorti du solde (brut = versé + frais à la charge de l'utilisateur)
    const debited = order.refunds.reduce((sum, r) => sum + r.amount_sats + (r.network_fee_payer === "user" ? r.network_fee_sats! : 0n), 0n);
    expect(debited).toBe(order.received_sats);
  });

  it("facture non payée : refusée aussi pour l'admin (Refund_user_renounce_paid)", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const cancelled = await placeOrder({ catalog, batchId, customer: alice });
    await prisma.order.update({ where: { id: cancelled }, data: { status: "cancelled" } });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: cancelled } });
    await receivePayment(prisma, cancelled, order.expected_sats);
    expect(
      await constraintOf(
        prisma.refund.create({
          data: { order_id: cancelled, kind: "cancellation", ...ADMIN, ...RENOUNCE, amount: order.total_amount, amount_sats: order.expected_sats - FEE, reason: "x" },
        }),
      ),
    ).toBe("Refund_user_renounce_paid");
  });

  it("l'admin ne verrouille pas le lot : une transition de statut n'attend pas son annulation", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId);
    await moveBatch(batchId, "preorder", "ordering");
    await prisma.$transaction(async (tx) => {
      await tx.refund.create({
        data: { order_id: orderId, kind: "cancellation", ...ADMIN, ...RENOUNCE, amount: 50_000n, amount_sats: 1_000n, reason: "x" },
      });
      // Pas de verrou du lot pris par le trigger : la ligne Batch n'est pas verrouillée par cette transaction
      const [{ locked }] = await prisma.$queryRaw<{ locked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM "Batch" WHERE "id" = ${batchId}::uuid FOR UPDATE SKIP LOCKED) IS FALSE AS "locked"`;
      expect(locked).toBe(false);
      throw new Error("rollback");
    }).catch((e: Error) => expect(e.message).toBe("rollback"));
  });
});

describe("dates de création posées par la base (Configuration, Wishlist)", () => {
  it("created_at et updated_at = début de la transaction de la base ; une valeur fournie reste acceptée", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "survey" });
    const { wishlist, txNow } = await prisma.$transaction(async (tx) => {
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT transaction_timestamp() AS "now"`;
      const configuration = await createConfiguration(tx, catalog, batchId);
      const created = await tx.wishlist.create({ data: { user_id: alice.userId, batch_id: batchId, configuration_id: configuration.id } });
      return { wishlist: created, txNow: now };
    });
    const configuration = await prisma.configuration.findUniqueOrThrow({ where: { id: wishlist.configuration_id } });
    expect(configuration.created_at).toEqual(txNow);
    expect(configuration.updated_at).toEqual(txNow);
    expect(wishlist.created_at).toEqual(txNow);

    // Antidater reste possible (seed, tests)
    const past = new Date(Date.now() - 3 * 86_400_000);
    const old = await prisma.$transaction(async (tx) => {
      const { id } = await createConfiguration(tx, catalog, batchId);
      return tx.configuration.update({ where: { id }, data: { created_at: past } });
    });
    expect(old.created_at).toEqual(past);
    const other = await wish(catalog, batchId, await createUser());
    const antidated = await prisma.wishlist.update({ where: { id: other.id }, data: { created_at: past } });
    expect(antidated.created_at).toEqual(past);
  });
});
