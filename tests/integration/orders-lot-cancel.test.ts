import { beforeEach, describe, expect, it, vi } from "vitest";
import * as boTransitionsRoute from "@/app/api/backoffice/batches/[batchId]/transitions/route";
import * as boAcceptRoute from "@/app/api/backoffice/orders/[orderId]/accept/route";
import * as boRefundRoute from "@/app/api/backoffice/orders/[orderId]/refund/route";
import * as boOrderRoute from "@/app/api/backoffice/orders/[orderId]/route";
import * as boAttentionRoute from "@/app/api/backoffice/orders/attention/route";
import * as paymentsRoute from "@/app/api/internal/payments/route";
import * as cancelRoute from "@/app/api/orders/[orderId]/cancel/route";
import * as orderRoute from "@/app/api/orders/[orderId]/route";
import * as ordersRoute from "@/app/api/orders/route";
import { changeBatchStatus } from "@/server/batches";
import { prisma } from "./db";
import { TEST_PAYMENT_SECRET } from "./env";
import {
  authUserIdOf,
  type Catalog,
  createBatch,
  createCatalog,
  createUser,
  failureOf,
  placeOrder,
  untilAnotherSessionWaitsOnLock,
} from "./fixtures";
import { ADMIN, call, type Reply, SAME_ORIGIN, signIn } from "./http";
import { pgFailureOf } from "@/server/errors";

// Jalon 4, migration v5h (décision Hugo 2026-10-09) : un lot annulé annule ses factures en attente SANS
// versement (réservation libérée), sans jamais supprimer une facture ni son adresse de paiement. Un
// versement reçu ensuite reste « à traiter » pour l'admin, sans remboursement automatique.

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

const ALICE = "7001";
const BOB = "7002";
const CAROL = "7003";
const BILLING = { fullName: "Alice Martin", line1: "1 rue de la Paix", postalCode: "69001", city: "Lyon", country: "FR" };

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({ status, code });
}

const as = async (authUserId: string | null) => {
  cookieJar.clear();
  if (authUserId) await signIn(cookieJar, authUserId);
};

type Handler = Parameters<typeof call>[0];
const post = (handler: Handler, body: object, params: Record<string, string> = {}) =>
  call(handler, { body, params, headers: SAME_ORIGIN });
const order = (batchId: string, lines = 1) =>
  post(ordersRoute.POST, { batchId, lines: Array.from({ length: lines }, () => ({})), billingAddress: BILLING, contactEmail: "client@example.fr" });
const myOrder = (orderId: string) => call(orderRoute.GET, { params: { orderId } });
const adminOrder = (orderId: string) => call(boOrderRoute.GET, { params: { orderId } });
const pay = (address: string, amountSats: bigint, txid = `tx-${address}-${amountSats}`) =>
  call(paymentsRoute.POST, {
    body: { address, txid, vout: 0, amountSats: amountSats.toString() },
    headers: { authorization: `Bearer ${TEST_PAYMENT_SECRET}` },
  });
const cancelBatch = (batchId: string, from = "preorder") =>
  post(boTransitionsRoute.POST, { from, to: "cancelled", note: "Lot abandonné" }, { batchId });
const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const availableStock = async (batchId: string) =>
  (await prisma.$queryRaw<{ n: number }[]>`SELECT "batch_available_stock"(${batchId}::uuid) AS n`)[0].n;

let catalog: Catalog;
let batchId: string;

beforeEach(async () => {
  cookieJar.clear();
  catalog = await createCatalog();
  batchId = await createBatch(catalog, { quantity: 5 });
});

describe("annulation d'un lot : factures en attente sans versement", () => {
  it("annulées avec le lot : réservation libérée, facture et adresse de paiement conservées, vue client « Lot annulé »", async () => {
    await as(ALICE);
    const created = (await order(batchId, 2)).body;
    expect(await availableStock(batchId)).toBe(3);
    const before = await orderRow(created.id);

    await as(ADMIN);
    expect((await cancelBatch(batchId)).status).toBe(201);

    const after = await orderRow(created.id);
    expect(after).toMatchObject({ status: "cancelled", payment_address: before.payment_address, total_amount: before.total_amount });
    expect(after.cancelled_at).toBeInstanceOf(Date);
    expect(await prisma.order.count({ where: { batch_id: batchId } })).toBe(1); // jamais supprimée
    expect(await prisma.orderLine.count({ where: { order_id: created.id } })).toBe(2);
    expect(await availableStock(batchId)).toBe(5); // réservation libérée

    await as(ALICE);
    const seen = (await myOrder(created.id)).body;
    expect(seen).toMatchObject({
      status: "cancelled",
      cancelReason: "batch_closed",
      batch: { status: "cancelled", acceptsOrders: false },
      payment: { address: before.payment_address, underReviewSats: "0", surplusLeftSats: "0", paidAfterRefundSats: "0" },
      actions: { canCancel: false, canRequestRefund: false, canRenounce: false, awaitingTopUp: false },
    });
  });

  it("seules les factures vivantes sans versement sont touchées : partielle, expirée, payée d'un autre lot", async () => {
    const other = await createBatch(catalog, { quantity: 5 });
    await as(ALICE);
    const unpaid = (await order(batchId)).body;
    await as(BOB);
    const partial = (await order(batchId)).body;
    await pay(partial.payment.address, 1_000n);
    await as(CAROL);
    const elsewhere = (await order(other)).body;

    await as(ADMIN);
    expect((await cancelBatch(batchId)).status).toBe(201);

    expect((await orderRow(unpaid.id)).status).toBe("cancelled");
    // Versement partiel : la facture n'est pas annulée, elle devient « à traiter » (lot fermé aux commandes)
    expect((await orderRow(partial.id)).status).toBe("pending_payment");
    expect((await adminOrder(partial.id)).body.attention).toMatchObject({ reason: "admin_decision", canAccept: false, canRefund: true });
    expect((await orderRow(elsewhere.id)).status).toBe("pending_payment");
  });

  it("facture déjà expirée : rien à annuler, le lot s'annule sans erreur et la facture reste lisible", async () => {
    const lonely = await createBatch(catalog, { quantity: 5 });
    // Facture insérée déjà expirée (les dates d'une facture sont immuables)
    const alice = await createUser();
    await as(String(await authUserIdOf(prisma, alice.userId)));
    const orderId = await placeOrder({ catalog, batchId: lonely, customer: alice, expiredMinutesAgo: 60 });
    await as(ADMIN);
    expect((await cancelBatch(lonely)).status).toBe(201);
    expect((await orderRow(orderId)).status).toBe("pending_payment");
    await as(String(await authUserIdOf(prisma, alice.userId)));
    expect((await myOrder(orderId)).body).toMatchObject({ status: "expired", batch: { status: "cancelled" } });
  });

  it("annulation refusée (commande payée) : les factures en attente restent intactes", async () => {
    await as(ALICE);
    const paid = (await order(batchId)).body;
    await pay(paid.payment.address, BigInt(paid.payment.expectedSats));
    await as(BOB);
    const waiting = (await order(batchId)).body;

    await as(ADMIN);
    expectError(await cancelBatch(batchId), 409, "transition_blocked");
    expect((await orderRow(waiting.id)).status).toBe("pending_payment");
    expect((await orderRow(paid.id)).status).toBe("paid");
  });

  it("garde de la base : annuler par SQL direct annule aussi les factures (une seule règle, dans le trigger)", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    await prisma.batchStatusTransition.create({
      data: { batch_id: batchId, from_status: "preorder", to_status: "cancelled", note: "SQL", changed_by_auth_user_id: 1n },
    });
    expect((await orderRow(created.id)).status).toBe("cancelled");
  });

  it("rien n'est supprimé : une facture annulée avec le lot ne peut toujours pas être effacée", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    await as(ADMIN);
    await cancelBatch(batchId);
    const failure = await failureOf(prisma.order.delete({ where: { id: created.id } }));
    expect(pgFailureOf(failure)?.constraint).toBe("Order_no_delete");
  });
});

describe("paiement reçu après l'annulation du lot : « à traiter », jamais remboursé d'office", () => {
  it("paiement complet sur l'adresse d'une facture annulée avec le lot : ni acceptation ni remboursement automatiques", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    const expected = BigInt(created.payment.expectedSats);
    await as(ADMIN);
    await cancelBatch(batchId);

    const paid = await pay(created.payment.address, expected);
    expect(paid.status).toBe(201);
    expect(paid.body.actions).toEqual([]);
    expect(await prisma.refund.count({ where: { order_id: created.id } })).toBe(0);
    expect((await orderRow(created.id)).status).toBe("cancelled");

    // Admin : à traiter, remboursement possible, acceptation impossible (lot fermé)
    const attention = (await call(boAttentionRoute.GET)).body.items;
    expect(attention).toEqual([
      expect.objectContaining({
        orderId: created.id,
        cancelReason: "batch_closed",
        unsettledSats: expected.toString(),
        attention: expect.objectContaining({
          reason: "admin_decision",
          canAccept: false,
          canRefund: true,
          label: expect.stringContaining("lot qui n'accepte plus de commande"),
        }),
      }),
    ]);
    expectError(await post(boAcceptRoute.POST, {}, { orderId: created.id }), 409, "order_not_acceptable");
    expect((await adminOrder(created.id)).body).toMatchObject({ status: "cancelled", cancelReason: "batch_closed" });

    // Client : son versement est traité par l'équipe, rien d'automatique
    await as(ALICE);
    expect((await myOrder(created.id)).body).toMatchObject({
      status: "cancelled",
      cancelReason: "batch_closed",
      payment: { receivedSats: expected.toString(), underReviewSats: expected.toString(), surplusLeftSats: "0", paidAfterRefundSats: "0" },
      refunds: [],
      actions: { canCancel: false, canRequestRefund: false },
    });
  });

  it("l'admin décide : remboursement (frais boutique), la facture passe à remboursée, l'argent reçu est tracé", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    const expected = BigInt(created.payment.expectedSats);
    await as(ADMIN);
    await cancelBatch(batchId);
    await pay(created.payment.address, expected);

    const refunded = await post(boRefundRoute.POST, { reason: "Lot abandonné, versement rendu", cause: "shop_stock" }, { orderId: created.id });
    expect(refunded.status).toBe(200);
    // La cause de l'annulation est conservée après le remboursement (décision Hugo 2026-10-13)
    expect(refunded.body).toMatchObject({
      status: "refunded",
      cancelReason: "batch_closed",
      unsettledSats: "0",
      payment: { surplusLeftSats: "0", paidAfterRefundSats: "0" },
      attention: { reason: "refund_address_missing" },
    });
    expect(refunded.body.refunds).toEqual([
      expect.objectContaining({ cause: "shop_stock", initiatedBy: "admin", networkFeePayer: "shop", amountSats: expected.toString() }),
    ]);
    expect(await prisma.payment.count({ where: { order_id: created.id } })).toBe(1);
  });

  it("deuxième versement après le remboursement intégral : encore « à traiter », le client le voit", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    const expected = BigInt(created.payment.expectedSats);
    await as(ADMIN);
    await cancelBatch(batchId);
    await pay(created.payment.address, expected, "tx-1");
    await post(boRefundRoute.POST, { reason: "Rendu", cause: "shop_stock" }, { orderId: created.id });
    await pay(created.payment.address, 4_000n, "tx-2");

    // Facture jamais acceptée : tout le reçu est rendu au remboursement, seul le versement tardif reste
    const payment = { underReviewSats: "4000", surplusLeftSats: "0", paidAfterRefundSats: "4000" };
    expect((await adminOrder(created.id)).body).toMatchObject({
      status: "refunded",
      cancelReason: "batch_closed",
      unsettledSats: "4000",
      payment,
      attention: { reason: "admin_decision" },
    });
    await as(ALICE);
    expect((await myOrder(created.id)).body).toMatchObject({ status: "refunded", cancelReason: "batch_closed", payment });
  });
});

describe("cause de l'annulation vue par l'API (v5l)", () => {
  it("le client annule puis le lot ferme : la facture reste « annulée par le client » (user), partout", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    expect(created.cancelReason).toBeNull();
    const cancelled = await post(cancelRoute.POST, {}, { orderId: created.id });
    expect(cancelled.body).toMatchObject({ status: "cancelled", cancelReason: "user" });

    await as(ADMIN);
    expect((await cancelBatch(batchId)).status).toBe(201);
    await pay(created.payment.address, 1_000n); // versement tardif : la facture entre dans « À traiter »
    expect((await adminOrder(created.id)).body).toMatchObject({ status: "cancelled", cancelReason: "user" });
    const items = (await call(boAttentionRoute.GET)).body.items;
    expect(items).toEqual([expect.objectContaining({ orderId: created.id, cancelReason: "user" })]);

    await as(ALICE);
    expect((await myOrder(created.id)).body).toMatchObject({ status: "cancelled", cancelReason: "user" });
  });

  it("facture jamais annulée : cancelReason null (en attente, payée)", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    await pay(created.payment.address, BigInt(created.payment.expectedSats));
    expect((await myOrder(created.id)).body).toMatchObject({ status: "paid", cancelReason: null });
  });
});

describe("concurrence : paiement et annulation du lot", () => {
  it("un paiement validé juste avant l'annulation exclut sa facture : elle reste en attente et « à traiter »", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    let cancelling: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      // Paiement en cours : la ligne de la facture est verrouillée jusqu'au COMMIT
      await tx.$executeRaw`
        INSERT INTO "Payment" ("order_id", "amount_sats", "txid", "vout") VALUES (${created.id}::uuid, 1000, 'tx-race', 0)`;
      cancelling = changeBatchStatus(batchId, { from: "preorder", to: "cancelled", note: "Lot abandonné" }, { authUserId: ADMIN });
      await untilAnotherSessionWaitsOnLock();
    });
    await cancelling;
    const after = await orderRow(created.id);
    expect(after).toMatchObject({ status: "pending_payment", received_sats: 1_000n });
    expect(after.cancelled_at).toBeNull();
    await as(ADMIN);
    expect((await adminOrder(created.id)).body.attention).toMatchObject({ reason: "admin_decision" });
  });

  it("annulation de l'utilisateur et du lot en même temps : une seule annulation, aucune erreur", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    const [cancelled, moved] = await Promise.allSettled([
      post(cancelRoute.POST, {}, { orderId: created.id }),
      changeBatchStatus(batchId, { from: "preorder", to: "cancelled", note: "Lot abandonné" }, { authUserId: ADMIN }),
    ]);
    expect(moved.status).toBe("fulfilled");
    expect(cancelled.status === "fulfilled" && cancelled.value.status).toBe(200);
    const row = await orderRow(created.id);
    expect(row.status).toBe("cancelled");
    // La première annulation validée pose la cause ; l'autre ne la réécrit pas (les deux ordres sont testés en base)
    expect(["user", "batch_closed"]).toContain(row.cancel_reason);
    expect((await myOrder(created.id)).body).toMatchObject({ status: "cancelled", cancelReason: row.cancel_reason });
  });
});
