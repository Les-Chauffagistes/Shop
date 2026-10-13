import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cancelRoute from "@/app/api/orders/[orderId]/cancel/route";
import { changeBatchStatus } from "@/server/batches";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  type Catalog,
  type Customer,
  createBatch,
  createCatalog,
  createUser,
  EXPECTED_SATS,
  failureOf,
  moveBatch,
  placeOrder,
  receivePayment,
  untilAnotherSessionWaitsOnLock,
  writeFullRefund,
} from "./fixtures";
import { ADMIN, call, SAME_ORIGIN, signIn } from "./http";

// Migration v5l (recommandations de la revue qualité v5k, validées par Hugo le 2026-10-13) :
//   1. Order.cancel_reason posé par la base (user, batch_closed, admin) ;
//   2. order_payment_balance distingue le surplus resté d'un remboursement intégral et le versement arrivé après.

type Tx = Prisma.TransactionClient;

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const cancelAsCustomer = (orderId: string) => call(cancelRoute.POST, { body: {}, params: { orderId }, headers: SAME_ORIGIN });
const closeBatch = (batchId: string) =>
  changeBatchStatus(batchId, { from: "preorder", to: "cancelled", note: "Lot abandonné" }, { authUserId: ADMIN });

type Balance = {
  status: string;
  unsettled_sats: bigint;
  received_after_refund_sats: bigint;
  surplus_left_sats: bigint;
  paid_after_refund_sats: bigint;
  surplus_left: boolean;
  paid_after_refund: boolean;
  needs_admin_decision: boolean;
};
async function balance(orderId: string): Promise<Balance> {
  const [row] = await prisma.$queryRaw<Balance[]>`
    SELECT "status"::text AS "status", "unsettled_sats", "received_after_refund_sats", "surplus_left_sats",
      "paid_after_refund_sats", "surplus_left", "paid_after_refund", "needs_admin_decision"
    FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row;
}
const refundedFlags = (surplus: bigint, late: bigint, afterRefund = late) => ({
  status: "refunded",
  unsettled_sats: surplus + late,
  received_after_refund_sats: afterRefund,
  surplus_left_sats: surplus,
  paid_after_refund_sats: late,
  surplus_left: surplus > 0n,
  paid_after_refund: late > 0n,
});

/** Commande payée (taux des tests) avec `excess` sats de trop. */
async function paidOrder(excess = 0n) {
  const id = await placeOrder({ catalog, batchId, customer: alice });
  await prisma.$transaction(async (tx) => {
    await receivePayment(tx, id, EXPECTED_SATS + excess);
    await tx.order.update({ where: { id }, data: { status: "paid", paid_at: new Date() } });
  });
  return id;
}

/**
 * Annulation de toute une commande payée par la boutique : le prix (expected_sats) est rendu, l'excédent éventuel
 * reste (v5i). Le statut refunded est posé en dernier (refunded_at sous le verrou de la facture).
 */
async function refundPrice(tx: Tx, orderId: string) {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const refund = await tx.refund.create({
    data: {
      order_id: orderId,
      kind: "cancellation",
      cause: "admin_other",
      initiated_by: "admin",
      created_by_auth_user_id: ADMIN_AUTH_USER_ID,
      amount: o.total_amount,
      amount_sats: o.expected_sats,
      reason: "Annulation de toute la commande",
    },
  });
  await tx.orderLine.updateMany({ where: { order_id: orderId }, data: { refund_id: refund.id } });
  await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
}

let catalog: Catalog;
let batchId: string;
let alice: Customer;

beforeEach(async () => {
  cookieJar.clear();
  catalog = await createCatalog();
  batchId = await createBatch(catalog, { quantity: 5 });
  alice = await createUser();
});

describe("cause de l'annulation (Order.cancel_reason)", () => {
  it("le client annule sa facture : user, posée par la base avec cancelled_at", async () => {
    const id = await placeOrder({ catalog, batchId, customer: alice });
    const { auth_user_id } = await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } });
    await signIn(cookieJar, auth_user_id.toString());
    expect((await cancelAsCustomer(id)).status).toBe(200);
    const row = await orderRow(id);
    expect(row).toMatchObject({ status: "cancelled", cancel_reason: "user" });
    expect(row.cancelled_at).not.toBeNull();
  });

  it("le lot ferme les commandes (annulé, ou en transit) : batch_closed ; une facture annulée avant par le client reste user", async () => {
    const bob = await createUser();
    const byLot = await placeOrder({ catalog, batchId, customer: alice });
    const byCustomer = await placeOrder({ catalog, batchId, customer: bob });
    await prisma.order.update({ where: { id: byCustomer }, data: { status: "cancelled" } });
    const cancelledAt = (await orderRow(byCustomer)).cancelled_at;
    await closeBatch(batchId);
    expect(await orderRow(byLot)).toMatchObject({ status: "cancelled", cancel_reason: "batch_closed" });
    // Le défaut de la revue v5k : la cause ne se déduit plus de l'état du lot
    expect(await orderRow(byCustomer)).toMatchObject({ status: "cancelled", cancel_reason: "user", cancelled_at: cancelledAt });

    const shipping = await createBatch(catalog, { quantity: 2, status: "inspection" });
    await moveBatch(shipping, "inspection", "packaging");
    const inTransit = await placeOrder({ catalog, batchId: shipping, customer: alice });
    await moveBatch(shipping, "packaging", "in_transit");
    expect(await orderRow(inTransit)).toMatchObject({ status: "cancelled", cancel_reason: "batch_closed" });
  });

  it("batch_closed refusée hors de la transition du lot ; admin donnée explicitement par l'écrivain", async () => {
    const id = await placeOrder({ catalog, batchId, customer: alice });
    expect(
      await constraintOf(prisma.order.update({ where: { id }, data: { status: "cancelled", cancel_reason: "batch_closed" } })),
    ).toBe("Order_cancel_reason_batch_closed");
    expect((await orderRow(id)).status).toBe("pending_payment");
    await prisma.order.update({ where: { id }, data: { status: "cancelled", cancel_reason: "admin" } });
    expect(await orderRow(id)).toMatchObject({ status: "cancelled", cancel_reason: "admin" });
  });

  it("jamais posée sans annulation, jamais modifiée ensuite (CHECK et Order_immutable)", async () => {
    const pending = await placeOrder({ catalog, batchId, customer: alice });
    expect(await constraintOf(prisma.order.update({ where: { id: pending }, data: { cancel_reason: "user" } }))).toBe("Order_immutable");

    const cancelled = await placeOrder({ catalog, batchId, customer: await createUser() });
    await prisma.order.update({ where: { id: cancelled }, data: { status: "cancelled" } });
    expect(await constraintOf(prisma.order.update({ where: { id: cancelled }, data: { cancel_reason: "admin" } }))).toBe("Order_immutable");
    expect(await constraintOf(prisma.order.update({ where: { id: cancelled }, data: { cancel_reason: null } }))).toBe("Order_immutable");

    // Sans les triggers (écriture SQL brute d'une facture déjà annulée, sans cause) : le CHECK refuse
    expect(
      await constraintOf(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`ALTER TABLE "Order" DISABLE TRIGGER "Order_guard"`;
          await tx.$executeRaw`UPDATE "Order" SET "cancel_reason" = NULL WHERE "id" = ${cancelled}::uuid`;
        }),
      ),
    ).toBe("Order_cancel_reason_check");
    expect((await orderRow(cancelled)).cancel_reason).toBe("user");
  });

  it("conservée quand la facture annulée est ensuite acceptée ou remboursée ; une expiration n'en pose pas", async () => {
    // Annulée par le client, payée quand même, acceptée par l'admin (lot ouvert, place)
    const accepted = await placeOrder({ catalog, batchId, customer: alice });
    await prisma.order.update({ where: { id: accepted }, data: { status: "cancelled" } });
    await prisma.$transaction(async (tx) => {
      await receivePayment(tx, accepted, EXPECTED_SATS);
      await tx.order.update({ where: { id: accepted }, data: { status: "paid", paid_at: new Date() } });
    });
    expect(await orderRow(accepted)).toMatchObject({ status: "paid", cancel_reason: "user" });

    // Annulée par le lot, payée ensuite, remboursée
    const bob = await createUser();
    const other = await createBatch(catalog, { quantity: 2 });
    const refunded = await placeOrder({ catalog, batchId: other, customer: bob });
    await closeBatch(other);
    await prisma.$transaction((tx) => writeFullRefund(tx, refunded, { receivedSats: EXPECTED_SATS }));
    expect(await orderRow(refunded)).toMatchObject({ status: "refunded", cancel_reason: "batch_closed" });

    const expired = await placeOrder({ catalog, batchId, customer: await createUser(), expiredMinutesAgo: 1 });
    await prisma.order.update({ where: { id: expired }, data: { status: "expired", expired_at: new Date() } });
    const row = await orderRow(expired);
    expect(row).toMatchObject({ status: "expired", cancel_reason: null, cancelled_at: null });
  });
});

describe("cause de l'annulation : atomicité et concurrence", () => {
  it("transition du lot annulée (ROLLBACK) : aucune facture annulée, aucune cause posée", async () => {
    const id = await placeOrder({ catalog, batchId, customer: alice });
    await failureOf(
      prisma.$transaction(async (tx) => {
        await tx.batchStatusTransition.create({
          data: { batch_id: batchId, from_status: "preorder", to_status: "cancelled", changed_by_auth_user_id: ADMIN_AUTH_USER_ID, note: "x" },
        });
        expect((await tx.order.findUniqueOrThrow({ where: { id } })).cancel_reason).toBe("batch_closed");
        throw new Error("rollback");
      }),
    );
    expect(await orderRow(id)).toMatchObject({ status: "pending_payment", cancel_reason: null, cancelled_at: null });
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("preorder");
  });

  it("le client annule pendant que le lot ferme : le lot attend, la facture garde la cause user", async () => {
    const id = await placeOrder({ catalog, batchId, customer: alice });
    let closing: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: { status: "cancelled" } }); // verrou de la facture jusqu'au COMMIT
      closing = closeBatch(batchId);
      await untilAnotherSessionWaitsOnLock();
    });
    await closing;
    expect(await orderRow(id)).toMatchObject({ status: "cancelled", cancel_reason: "user" });
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("cancelled");
  });

  it("le lot ferme pendant que le client annule : le client attend, la facture garde la cause batch_closed", async () => {
    const id = await placeOrder({ catalog, batchId, customer: alice });
    const { auth_user_id } = await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } });
    await signIn(cookieJar, auth_user_id.toString());
    let cancelling: ReturnType<typeof cancelAsCustomer> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.batchStatusTransition.create({
        data: { batch_id: batchId, from_status: "preorder", to_status: "cancelled", changed_by_auth_user_id: ADMIN_AUTH_USER_ID, note: "x" },
      });
      cancelling = cancelAsCustomer(id);
      await untilAnotherSessionWaitsOnLock();
    });
    expect((await cancelling!).status).toBe(200); // déjà annulée : sans effet
    expect(await orderRow(id)).toMatchObject({ status: "cancelled", cancel_reason: "batch_closed" });
  });
});

describe("versements d'une facture remboursée (order_payment_balance, v5l)", () => {
  it("surplus resté puis versement arrivé après : montants distincts ; un remboursement postérieur éteint d'abord le surplus", async () => {
    const id = await paidOrder(1_000n);
    await prisma.$transaction((tx) => refundPrice(tx, id));
    expect(await balance(id)).toMatchObject({ ...refundedFlags(1_000n, 0n), needs_admin_decision: true });

    await receivePayment(prisma, id, 3_000n);
    expect(await balance(id)).toMatchObject(refundedFlags(1_000n, 3_000n));

    // L'admin rembourse 1 500 sats d'excédent : imputés au surplus (le plus ancien), puis au versement tardif
    await prisma.refund.create({
      data: {
        order_id: id, kind: "overpayment", cause: "admin_other", initiated_by: "admin", created_by_auth_user_id: ADMIN_AUTH_USER_ID,
        amount: 0n, amount_sats: 1_500n, reason: "Excédent",
      },
    });
    expect(await balance(id)).toMatchObject(refundedFlags(0n, 2_500n, 3_000n));
  });

  it("facture jamais acceptée : tout le reçu est rendu au remboursement, seul un versement ultérieur reste", async () => {
    const id = await placeOrder({ catalog, batchId, customer: alice });
    await prisma.order.update({ where: { id }, data: { status: "cancelled" } });
    // Paiement et remboursement dans la même transaction : le paiement compte avant (refunded_at pris ensuite)
    await prisma.$transaction((tx) => writeFullRefund(tx, id, { receivedSats: EXPECTED_SATS }));
    expect(await balance(id)).toMatchObject({ ...refundedFlags(0n, 0n), needs_admin_decision: false });

    await receivePayment(prisma, id, 2_000n);
    expect(await balance(id)).toMatchObject({ ...refundedFlags(0n, 2_000n), needs_admin_decision: true });
  });

  it("factures non remboursées : colonnes à 0, drapeaux faux (l'excédent d'une commande payée reste refund_due_sats)", async () => {
    const id = await paidOrder(500n);
    expect(await balance(id)).toMatchObject({
      status: "paid", unsettled_sats: 500n, received_after_refund_sats: 0n, surplus_left_sats: 0n,
      paid_after_refund_sats: 0n, surplus_left: false, paid_after_refund: false,
    });
  });

  it("concurrence : un versement validé pendant qu'un remboursement attend le verrou compte AVANT (surplus resté)", async () => {
    const id = await paidOrder();
    let refunding: Promise<unknown> | undefined;
    let started!: () => void;
    const refundStarted = new Promise<void>((resolve) => (started = resolve));
    let go!: () => void;
    const paymentWritten = new Promise<void>((resolve) => (go = resolve));
    await prisma.$transaction(async (tx) => {
      // Le remboursement commence AVANT le versement (son now() le précède), puis attend le verrou de la facture
      refunding = prisma.$transaction(async (r) => {
        await r.$queryRaw`SELECT 1`;
        started();
        await paymentWritten;
        await refundPrice(r, id);
      });
      await refundStarted;
      await receivePayment(tx, id, 500n); // verrou de la facture (Payment_stamp) jusqu'au COMMIT
      go();
      await untilAnotherSessionWaitsOnLock();
    });
    await refunding;
    expect(await balance(id)).toMatchObject(refundedFlags(500n, 0n));
  });

  it("concurrence : un versement qui attend un remboursement en cours compte APRÈS (versement tardif)", async () => {
    const id = await paidOrder();
    let paying: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await refundPrice(tx, id);
      paying = receivePayment(prisma, id, 700n).then((p) => p); // une requête Prisma ne part qu'au then
      await untilAnotherSessionWaitsOnLock();
    });
    await paying;
    expect(await balance(id)).toMatchObject(refundedFlags(0n, 700n));
  });

  it("la date d'un paiement est posée par la base (valeur fournie remplacée)", async () => {
    const id = await placeOrder({ catalog, batchId, customer: alice });
    const payment = await prisma.payment.create({
      data: { order_id: id, amount_sats: 1n, txid: "tx-antidated", vout: 0, received_at: new Date("2020-01-01T00:00:00Z") },
    });
    expect(payment.received_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
