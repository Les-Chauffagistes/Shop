import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as addressesRoute from "@/app/api/addresses/route";
import * as boBatchOrdersRoute from "@/app/api/backoffice/batches/[batchId]/orders/route";
import * as boBatchesRoute from "@/app/api/backoffice/batches/route";
import * as boReleasesRoute from "@/app/api/backoffice/order-block-releases/route";
import * as boBlocksRoute from "@/app/api/backoffice/order-blocks/route";
import * as boAcceptRoute from "@/app/api/backoffice/orders/[orderId]/accept/route";
import * as boCancelLinesRoute from "@/app/api/backoffice/orders/[orderId]/cancel-lines/route";
import * as boRefundRoute from "@/app/api/backoffice/orders/[orderId]/refund/route";
import * as boOrderRoute from "@/app/api/backoffice/orders/[orderId]/route";
import * as boAttentionRoute from "@/app/api/backoffice/orders/attention/route";
import * as paymentsRoute from "@/app/api/internal/payments/route";
import * as cancelRoute from "@/app/api/orders/[orderId]/cancel/route";
import * as refundRoute from "@/app/api/orders/[orderId]/refund/route";
import * as orderRoute from "@/app/api/orders/[orderId]/route";
import * as eligibilityRoute from "@/app/api/orders/eligibility/route";
import * as ordersRoute from "@/app/api/orders/route";
import * as shopBatchRoute from "@/app/api/shop/batches/[batchId]/route";
import * as wishlistsRoute from "@/app/api/wishlists/route";
import { cancelOrder, createOrder, orderInput } from "@/server/orders";
import { recordPayment } from "@/server/payments";
import { prisma } from "./db";
import { TEST_PAYMENT_SECRET } from "./env";
import {
  type Catalog,
  createBatch,
  createCatalog,
  type Customer,
  moveBatch,
  placeOrder,
  priorityOverAt,
  receivePayment,
  setShopSettings,
  wish,
} from "./fixtures";
import { ADMIN, call, type Reply, SAME_ORIGIN, signIn } from "./http";

// Jalon 4 : factures (précommande), paiement Bitcoin simulé, annulation, remboursements, « à traiter ».

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

const ALICE = "3001";
const BOB = "3002";

/** Taux et frais par défaut du service simulé (config.ts) : 1 BTC = 90 000,00 €, frais 2 000 sats. */
const sats = (cents: bigint) => (cents * 100_000_000n + 8_999_999n) / 9_000_000n;
const FEE = 2_000n;
const RESALE = 50_000n;
const SILENT = 7_500n;

const ADDRESS = { fullName: "Alice Martin", line1: "1 rue de la Paix", postalCode: "69001", city: "Lyon", country: "fr" };

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
const order = (batchId: string, lines: object[] = [{}], extra: object = {}) =>
  post(ordersRoute.POST, { batchId, lines, billingAddress: ADDRESS, ...extra });
const getOrder = (orderId: string) => call(orderRoute.GET, { params: { orderId } });
const cancel = (orderId: string) => post(cancelRoute.POST, {}, { orderId });
const pay = (address: string, amountSats: bigint, txid: string = randomUUID(), vout = 0) =>
  call(paymentsRoute.POST, {
    body: { address, txid, vout, amountSats: amountSats.toString() },
    headers: { authorization: `Bearer ${TEST_PAYMENT_SECRET}` },
  });

/** Identifiant local et adresse d'un utilisateur de la boutique (créé par une première requête authentifiée). */
async function customer(authUserId: string): Promise<Customer> {
  await as(authUserId);
  await call(ordersRoute.GET);
  const user = await prisma.user.findUniqueOrThrow({ where: { auth_user_id: BigInt(authUserId) } });
  const address = await prisma.address.create({
    data: { user_id: user.id, full_name: "Client", line1: "1 rue", postal_code: "69001", city: "Lyon", country: "FR" },
  });
  return { userId: user.id, addressId: address.id };
}

const input = (batchId: string, lines: object[] = [{}]) => orderInput.parse({ batchId, lines, billingAddress: ADDRESS });

let catalog: Catalog;
let batchId: string;

beforeEach(async () => {
  cookieJar.clear();
  catalog = await createCatalog();
  batchId = await createBatch(catalog, { quantity: 3 });
});

describe("création d'une facture", () => {
  it("lignes configurées aux prix de la base, montant BTC au taux figé, adresse propre à la facture", async () => {
    await as(ALICE);
    const reply = await order(batchId, [{ choices: [{ optionId: catalog.optionId, optionValueId: catalog.silentId }] }, {}]);
    expect(reply.status).toBe(201);
    const o = reply.body;
    expect(o).toMatchObject({
      status: "pending_payment",
      statusLabel: "En attente de paiement",
      kind: "preorder",
      totalAmount: (RESALE * 2n + SILENT).toString(),
      batch: { id: batchId, status: "preorder", isPublic: true, acceptsOrders: true },
      payment: { method: "bitcoin", expectedSats: sats(RESALE * 2n + SILENT).toString(), receivedSats: "0" },
      actions: { canCancel: true, canRequestRefund: false, awaitingTopUp: false },
      billingAddress: { fullName: "Alice Martin", country: "FR", company: null },
    });
    expect(o.payment.address).toMatch(/^bcrt1q/);
    expect(o.shippingAddress).toEqual(o.billingAddress);
    // Lignes dans l'ordre de la requête (position posée par la base)
    expect(o.lines.map((l: { amount: string; position: number }) => [l.position, l.amount])).toEqual([
      [1, (RESALE + SILENT).toString()],
      [2, RESALE.toString()],
    ]);
    const silentLine = o.lines[0];
    expect(o.refundAddress).toBeNull();
    expect(silentLine.items).toEqual([expect.objectContaining({ label: "Silent kit", unitPrice: SILENT.toString() })]);
    // Réservation de 30 min (expires_at : horloge de la base ; created_at : celle du client Prisma)
    expect(Math.abs(new Date(o.expiresAt).getTime() - new Date(o.createdAt).getTime() - 30 * 60_000)).toBeLessThan(1_000);

    // Une autre facture, une autre adresse ; l'adresse de facturation identique est reprise
    await as(BOB);
    const other = await order(batchId);
    expect(other.body.payment.address).not.toBe(o.payment.address);
    await as(ALICE);
    expect((await call(addressesRoute.GET)).body.items).toHaveLength(1);
  });

  it("refuse un montant envoyé par le client, les champs inconnus et une écriture cross-site", async () => {
    await as(ALICE);
    expectError(await order(batchId, [{ amount: "1" }]), 400, "invalid_input");
    expectError(await order(batchId, [{}], { totalAmount: "1" }), 400, "invalid_input");
    const crossSite = await call(ordersRoute.POST, {
      body: { batchId, lines: [{}], billingAddress: ADDRESS },
      headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
    });
    expectError(crossSite, 403, "cross_origin");
    await as(null);
    expectError(await order(batchId), 401, "unauthenticated");
  });

  it("lot au sondage ou en transit : 409 ; brouillon ou inconnu : 404", async () => {
    await as(ALICE);
    const other = await createCatalog("S21");
    const survey = await createBatch(other, { quantity: 3, status: "survey" });
    const draft = await createBatch(other, { quantity: 3, status: "draft" });
    const transit = await createBatch(other, { quantity: 3, status: "inspection" });
    await moveBatch(transit, "inspection", "packaging");
    await moveBatch(transit, "packaging", "in_transit");
    const reply = await order(survey);
    expectError(reply, 409, "batch_not_open");
    expect(reply.body.error.message).toContain("pas encore ouvertes");
    expectError(await order(transit), 409, "batch_not_open");
    expectError(await order(draft), 404, "batch_not_found");
    expectError(await order(randomUUID()), 404, "batch_not_found");
  });

  it("plafond de machines par facture lu dans les réglages, cité dans le message ; stock restant", async () => {
    await as(ALICE);
    await setShopSettings({ order_max_lines: 2 });
    const tooMany = await order(batchId, Array.from({ length: 101 }, () => ({})));
    expectError(tooMany, 422, "order_too_many_lines");
    expect(tooMany.body.error.message).toBe("Une facture compte au plus 2 machines : vous en demandez 101.");
    expect(tooMany.body.error.details).toEqual({ maxLines: 2 });

    await setShopSettings({ order_max_lines: 10 });
    const stock = await order(batchId, [{}, {}, {}, {}]);
    expectError(stock, 409, "out_of_stock");
    expect(stock.body.error.message).toBe("Il ne reste que 3 machines sur ce lot : vous en demandez 4.");
  });

  it("une seule facture en attente par utilisateur et par lot", async () => {
    await as(ALICE);
    const first = await order(batchId);
    const second = await order(batchId);
    expectError(second, 409, "order_already_pending");
    expect(second.body.error.details).toEqual({ orderId: first.body.id });
    const eligibility = await call(eligibilityRoute.GET, { path: `/api/orders/eligibility?batchId=${batchId}` });
    expect(eligibility.body).toMatchObject({
      pendingOrderId: first.body.id,
      availableQuantity: 2,
      maxMachinesPerOrder: 10,
      refusal: { code: "order_already_pending" },
    });
  });

  it("concurrence : 4 clients pour 2 places, 2 factures seulement", async () => {
    const small = await createBatch(await createCatalog("S21"), { quantity: 2 });
    const customers = await Promise.all(["3101", "3102", "3103", "3104"].map(customer));
    const results = await Promise.allSettled(customers.map((c) => createOrder(c.userId, input(small))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "out_of_stock" });
    }
  });

  it("concurrence : deux factures simultanées du même utilisateur, une seule passe", async () => {
    const alice = await customer(ALICE);
    const results = await Promise.allSettled([createOrder(alice.userId, input(batchId)), createOrder(alice.userId, input(batchId))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
      code: "order_already_pending",
    });
  });
});

describe("journée de priorité", () => {
  it("réservée aux wishlists, dans la limite de leur nombre ; finit à la dernière conversion", async () => {
    const other = await createCatalog("S21");
    const lot = await createBatch(other, { quantity: 5, status: "survey", priorityOpen: true });
    const alice = await customer(ALICE);
    const w1 = await wish(other, lot, alice, [{ optionId: other.optionId, valueId: other.silentId, price: SILENT }]);
    const w2 = await wish(other, lot, alice);
    await moveBatch(lot, "survey", "preorder");

    await as(BOB);
    const refused = await order(lot);
    expectError(refused, 409, "order_priority_window");
    expect(refused.body.error.details).toMatchObject({ machinesLeft: 0, priorityEndsAt: expect.any(String) });

    await as(ALICE);
    const quota = await order(lot, [{}, {}, {}]);
    expectError(quota, 409, "order_priority_quota");
    expect(quota.body.error.details.machinesLeft).toBe(2);
    expectError(await order(lot, [{ wishlistId: w1.id }, { wishlistId: w1.id }]), 400, "invalid_input");

    const created = await order(lot, [{ wishlistId: w1.id }, { wishlistId: w2.id }]);
    expect(created.status).toBe(201);
    expect(created.body.lines.map((l: { wishlistId: string }) => l.wishlistId).sort()).toEqual([w1.id, w2.id].sort());
    const fromW1 = created.body.lines.find((l: { wishlistId: string }) => l.wishlistId === w1.id);
    expect(fromW1.items[0]).toMatchObject({ label: "Silent kit", unitPrice: SILENT.toString() });
    expect(created.body.totalAmount).toBe((RESALE * 2n + SILENT).toString());

    // Payée : toutes les wishlists actives sont converties, la journée se termine
    expect((await pay(created.body.payment.address, BigInt(created.body.payment.expectedSats))).body.actions).toEqual(["accepted"]);
    await as(BOB);
    expect((await order(lot)).status).toBe(201);
  });

  it("wishlist d'un autre utilisateur : 404", async () => {
    const other = await createCatalog("S21");
    const lot = await createBatch(other, { quantity: 5, status: "survey" });
    const bob = await customer(BOB);
    const w = await wish(other, lot, bob);
    await moveBatch(lot, "survey", "preorder", priorityOverAt());
    await as(ALICE);
    expectError(await order(lot, [{ wishlistId: w.id }]), 404, "wishlist_not_found");
  });
});

describe("annulation, délai et blocage", () => {
  it("annuler libère la place, puis délai de 5 min (429 + Retry-After)", async () => {
    await as(ALICE);
    const created = await order(batchId, [{}, {}, {}]);
    const cancelled = await cancel(created.body.id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", cancelledAt: expect.any(String) });
    expect((await cancel(created.body.id)).body.status).toBe("cancelled"); // rejouée : sans effet

    const again = await order(batchId);
    expectError(again, 429, "order_cooldown");
    expect(again.body.error.message).toMatch(/vous pourrez en créer une nouvelle à \d\d:\d\d\./);
    const retryAfter = Number(again.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(250);
    expect(retryAfter).toBeLessThanOrEqual(300);
    expect(again.body.error.details.cooldownEndsAt).toEqual(expect.any(String));

    await as(BOB);
    expect((await order(batchId, [{}, {}, {}])).status).toBe(201); // la place est libre
  });

  it("annulation refusée : paiement reçu, facture expirée, facture d'un autre", async () => {
    const alice = await customer(ALICE);
    const created = await order(batchId);
    await pay(created.body.payment.address, 1_000n);
    expectError(await cancel(created.body.id), 409, "order_cancel_paid");

    const expiredId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 40 });
    expectError(await cancel(expiredId), 409, "order_cancel_expired");
    await as(BOB);
    expectError(await cancel(created.body.id), 404, "order_not_found");
    expectError(await getOrder(created.body.id), 404, "order_not_found");
  });

  it("3 abandons : bloqué jusqu'à la levée de l'admin", async () => {
    const alice = await customer(ALICE);
    for (const minutes of [60, 120, 180]) await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: minutes });
    const blocked = await order(batchId);
    expectError(blocked, 409, "order_creation_blocked");
    expect(blocked.body.error.details.blockedAt).toEqual(expect.any(String));

    await as(ADMIN);
    const blocks = await call(boBlocksRoute.GET, { path: `/api/backoffice/order-blocks?batchId=${batchId}` });
    expect(blocks.body.items).toEqual([
      expect.objectContaining({ user: { id: alice.userId, authUserId: ALICE }, abandonedOrders: 3, lastReleasedAt: null }),
    ]);
    const counters = (await call(boBatchesRoute.GET)).body.items[0].counters;
    expect(counters).toMatchObject({ blockedUsers: 1 });
    const release = await post(boReleasesRoute.POST, { userId: alice.userId, batchId, reason: "Client contacté" });
    expect(release.status).toBe(201);
    expect(release.body).toMatchObject({ releasedBy: ADMIN, reason: "Client contacté" });
    expect((await call(boBlocksRoute.GET)).body.items).toEqual([]);

    await as(ALICE);
    expect((await order(batchId)).status).toBe(201);
  });
});

describe("paiement (point d'entrée interne)", () => {
  it("secret exigé ; adresse inconnue : 404", async () => {
    const body = { address: "bcrt1qx", txid: "t", vout: 0, amountSats: "1" };
    expectError(await call(paymentsRoute.POST, { body }), 401, "unauthenticated");
    expectError(await call(paymentsRoute.POST, { body, headers: { authorization: "Bearer faux" } }), 401, "unauthenticated");
    expectError(await pay("bcrt1qinconnue", 1n), 404, "unknown_payment_address");
  });

  it("paiement complet : payée ; rejoué : compté une fois ; même sortie pour un autre montant : 409", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    const expected = BigInt(created.payment.expectedSats);
    const first = await pay(created.payment.address, expected, "tx-1");
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ duplicate: false, actions: ["accepted"], order: { status: "paid" } });
    const replay = await pay(created.payment.address, expected, "tx-1");
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ duplicate: true, actions: [], order: { receivedSats: expected.toString() } });
    expectError(await pay(created.payment.address, expected + 1n, "tx-1"), 409, "payment_conflict");

    const after = (await getOrder(created.id)).body;
    expect(after).toMatchObject({ status: "paid", paidAt: expect.any(String), actions: { canCancel: false } });
    expect(after.payments).toEqual([expect.objectContaining({ txid: "tx-1", vout: 0, amountSats: expected.toString() })]);
  });

  it("appoint : paiement partiel en attente, complété ensuite", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    const expected = BigInt(created.payment.expectedSats);
    expect((await pay(created.payment.address, 100_000n)).body.actions).toEqual([]);
    expect((await getOrder(created.id)).body).toMatchObject({
      status: "pending_payment",
      payment: { outstandingSats: (expected - 100_000n).toString() },
      actions: { awaitingTopUp: true, canRequestRefund: true, canCancel: false },
    });
    expect((await pay(created.payment.address, expected - 100_000n)).body.actions).toEqual(["accepted"]);
  });

  it("excédent au-dessus des frais : accepté, mais rien n'est remboursé d'office (décision Hugo 2026-10-09) ; l'admin décide", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    const expected = BigInt(created.payment.expectedSats);
    const extra = 5_000n;
    const reply = await pay(created.payment.address, expected + extra);
    expect(reply.body.actions).toEqual(["accepted"]);
    expect(reply.body.order).toMatchObject({ status: "paid", needsAdminAttention: true });
    // Le client voit que son surplus est entre les mains de l'équipe (aucun remboursement)
    const seen = (await getOrder(created.id)).body;
    expect(seen.refunds).toEqual([]);
    expect(seen.payment).toMatchObject({ receivedSats: (expected + extra).toString(), underReviewSats: extra.toString() });
    expect(await prisma.refund.count({ where: { order_id: created.id } })).toBe(0);

    await as(ADMIN);
    const attention = (await call(boAttentionRoute.GET)).body.items;
    expect(attention).toEqual([
      expect.objectContaining({
        orderId: created.id, unsettledSats: extra.toString(),
        attention: expect.objectContaining({ reason: "overpayment_decision", canAccept: false, canRefund: true }),
      }),
    ]);
    // Excédent supérieur aux frais : les deux motifs sont proposés, avec le payeur des frais
    expect(attention[0].attention.refundCauses).toEqual([
      expect.objectContaining({ cause: "admin_other", networkFeePayer: "shop" }),
      expect.objectContaining({ cause: "overpayment", networkFeePayer: "user" }),
    ]);
    const refunded = await post(boRefundRoute.POST, { reason: "Surplus rendu", cause: "overpayment" }, { orderId: created.id });
    expect(refunded.status).toBe(200);
    expect(refunded.body.refunds).toEqual([
      expect.objectContaining({
        kind: "overpayment", initiatedBy: "admin", amount: "0", amountSats: (extra - FEE).toString(),
        networkFeeSats: FEE.toString(), networkFeePayer: "user",
      }),
    ]);
    const [{ unrefunded }] = await prisma.$queryRaw<{ unrefunded: boolean }[]>`
      SELECT "overpayment_unrefunded" AS "unrefunded" FROM "order_payment_balance" WHERE "order_id" = ${created.id}::uuid`;
    expect(unrefunded).toBe(false);
  });

  it("excédent qui ne dépasse pas les frais : « à traiter », seul le motif aux frais de la boutique est proposé, celui de l'utilisateur est refusé (v5f)", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    const expected = BigInt(created.payment.expectedSats);
    const reply = await pay(created.payment.address, expected + FEE);
    expect(reply.body.actions).toEqual(["accepted"]);
    expect(reply.body.order).toMatchObject({ status: "paid", needsAdminAttention: true });
    expect((await getOrder(created.id)).body.refunds).toEqual([]);
    expect((await getOrder(created.id)).body.payment.underReviewSats).toBe(FEE.toString());

    await as(ADMIN);
    const attention = (await call(boAttentionRoute.GET)).body.items;
    expect(attention).toEqual([
      expect.objectContaining({
        orderId: created.id, unsettledSats: FEE.toString(),
        attention: expect.objectContaining({ reason: "overpayment_decision", canAccept: false, canRefund: true }),
      }),
    ]);
    // Le motif « excédent » (frais à l'utilisateur) ne serait pas applicable : il n'est pas proposé
    expect(attention[0].attention.refundCauses).toEqual([expect.objectContaining({ cause: "admin_other", networkFeePayer: "shop" })]);
    expectError(
      await post(boRefundRoute.POST, { reason: "Essai", cause: "overpayment" }, { orderId: created.id }),
      409,
      "refund_below_network_fee",
    );
    const refunded = await post(boRefundRoute.POST, { reason: "Excédent rendu, frais offerts", cause: "admin_other" }, { orderId: created.id });
    expect(refunded.status).toBe(200);
    // Plus d'excédent à décider ; reste à obtenir l'adresse de remboursement (v5e)
    expect(refunded.body).toMatchObject({ status: "paid", unsettledSats: "0", attention: { reason: "refund_address_missing" } });
    expect(refunded.body.refunds).toEqual([
      expect.objectContaining({ kind: "overpayment", amountSats: FEE.toString(), networkFeePayer: "shop" }),
    ]);
    expect(await prisma.refund.findFirstOrThrow({ where: { order_id: created.id } })).toMatchObject({ cause: "admin_other", initiated_by: "admin" });
  });

  it("concurrence : la même sortie reçue 5 fois n'est comptée qu'une fois", async () => {
    const alice = await customer(ALICE);
    const created = await createOrder(alice.userId, input(batchId));
    const expected = BigInt(created.payment.expectedSats);
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => recordPayment({ address: created.payment.address, txid: "tx-same", vout: 1, amountSats: expected })),
    );
    expect(replies.filter((r) => !r.duplicate)).toHaveLength(1);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: created.id } });
    expect(o).toMatchObject({ status: "paid", received_sats: expected });
  });

  it("concurrence : deux moitiés simultanées s'additionnent, payée une fois", async () => {
    const alice = await customer(ALICE);
    const created = await createOrder(alice.userId, input(batchId));
    const expected = BigInt(created.payment.expectedSats);
    const half = expected / 2n;
    const replies = await Promise.all([
      recordPayment({ address: created.payment.address, txid: "tx-a", vout: 0, amountSats: half }),
      recordPayment({ address: created.payment.address, txid: "tx-b", vout: 0, amountSats: expected - half }),
    ]);
    expect(replies.flatMap((r) => r.actions)).toEqual(["accepted"]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ status: "paid", received_sats: expected });
  });

  it("paiement tardif : accepté s'il reste de la place, sinon remboursé intégralement", async () => {
    const alice = await customer(ALICE);
    const bob = await customer(BOB);
    const lateId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    const late = await prisma.order.findUniqueOrThrow({ where: { id: lateId } });
    expect((await recordPayment({ address: late.payment_address, txid: "late-1", vout: 0, amountSats: late.expected_sats })).actions).toEqual([
      "accepted",
    ]);

    const tooLateId = await placeOrder({ catalog, batchId, customer: bob, expiredMinutesAgo: 10 });
    await createOrder(bob.userId, input(batchId, [{}, {}])); // les 2 dernières places
    const tooLate = await prisma.order.findUniqueOrThrow({ where: { id: tooLateId } });
    const reply = await recordPayment({ address: tooLate.payment_address, txid: "late-2", vout: 0, amountSats: tooLate.expected_sats });
    expect(reply.actions).toEqual(["refunded_no_stock"]);
    const refund = await prisma.refund.findFirstOrThrow({ where: { order_id: tooLateId } });
    expect(refund).toMatchObject({ kind: "cancellation", amount_sats: tooLate.expected_sats, network_fee_payer: "shop" });
    expect(reply.order.status).toBe("refunded");
  });

  it("concurrence : annulation contre paiement, l'une ou l'autre, jamais les deux", async () => {
    const alice = await customer(ALICE);
    const created = await createOrder(alice.userId, input(batchId));
    const [cancelled, paid] = await Promise.allSettled([
      cancelOrder(alice.userId, created.id),
      recordPayment({ address: created.payment.address, txid: "race", vout: 0, amountSats: BigInt(created.payment.expectedSats) }),
    ]);
    expect(paid.status).toBe("fulfilled"); // un paiement n'est jamais refusé
    const o = await prisma.order.findUniqueOrThrow({ where: { id: created.id } });
    if (cancelled.status === "fulfilled") {
      expect(o.status).toBe("cancelled"); // à traiter par l'admin
      const [{ needs }] = await prisma.$queryRaw<{ needs: boolean }[]>`
        SELECT "needs_admin_decision" AS "needs" FROM "order_payment_balance" WHERE "order_id" = ${created.id}::uuid`;
      expect(needs).toBe(true);
    } else {
      expect(cancelled.reason).toMatchObject({ code: "order_cancel_paid" });
      expect(o.status).toBe("paid");
    }
  });
});

describe("remboursement du versement par l'utilisateur", () => {
  it("paiement partiel : remboursé moins les frais réseau à sa charge, puis délai (abandon)", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    await pay(created.payment.address, 300_000n);
    expectError(await post(refundRoute.POST, { refundAddress: "pas une adresse" }, { orderId: created.id }), 400, "invalid_input");
    const reply = await post(refundRoute.POST, { refundAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }, { orderId: created.id });
    expect(reply.status).toBe(200);
    // L'adresse est écrite sur la facture ; le remboursement n'a pas d'adresse propre (choix de l'admin seulement)
    expect(reply.body).toMatchObject({ status: "refunded", refundedAt: expect.any(String), refundAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" });
    expect(reply.body.refunds).toEqual([
      expect.objectContaining({
        kind: "cancellation",
        cause: "partial_payment",
        initiatedBy: "user",
        amountSats: (300_000n - FEE).toString(),
        networkFeeSats: FEE.toString(),
        networkFeePayer: "user",
        destinationAddress: null,
      }),
    ]);
    expect(reply.body.lines.every((l: { refunded: boolean }) => l.refunded)).toBe(true);
    expectError(await order(batchId), 429, "order_cooldown");
    expectError(await post(refundRoute.POST, { refundAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }, { orderId: created.id }), 409, "order_already_refunded");
  });

  it("versement inférieur aux frais : 409, on attend l'appoint ; rien reçu : 409", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    const body = { refundAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" };
    expectError(await post(refundRoute.POST, body, { orderId: created.id }), 409, "order_nothing_received");
    await pay(created.payment.address, 1_500n);
    const below = await post(refundRoute.POST, body, { orderId: created.id });
    expectError(below, 409, "refund_below_network_fee");
    expect(below.body.error.details).toEqual({ receivedSats: "1500", networkFeeSats: "2000" });
  });
});

describe("backoffice : à traiter, commandes d'un lot", () => {
  it("paiement complet après annulation : à traiter, accepté par l'admin", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    await cancel(created.id);
    expect((await pay(created.payment.address, BigInt(created.payment.expectedSats))).body.actions).toEqual([]);

    await as(ADMIN);
    const list = (await call(boAttentionRoute.GET)).body.items;
    expect(list).toEqual([
      expect.objectContaining({
        orderId: created.id,
        status: "cancelled",
        user: expect.objectContaining({ authUserId: ALICE }),
        attention: expect.objectContaining({ reason: "admin_decision", canAccept: true, canRefund: true }),
      }),
    ]);
    expect((await call(boBatchesRoute.GET)).body.items[0].counters.attentionOrders).toBe(1);
    const accepted = await post(boAcceptRoute.POST, {}, { orderId: created.id });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: "paid", cancelledAt: expect.any(String), attention: null });
    expect((await call(boAttentionRoute.GET)).body.items).toEqual([]);
    expectError(await post(boAcceptRoute.POST, {}, { orderId: created.id }), 409, "order_not_acceptable");
  });

  it("paiement partiel après annulation : remboursé par l'admin, frais à la charge de la boutique", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    await cancel(created.id);
    await pay(created.payment.address, 10_000n);
    await as(ADMIN);
    expectError(await post(boRefundRoute.POST, { reason: "x" }, { orderId: created.id }), 400, "invalid_input");
    const notAllowed = await post(boRefundRoute.POST, { reason: "x", cause: "partial_payment" }, { orderId: created.id });
    expectError(notAllowed, 422, "refund_cause_not_allowed");
    const refunded = await post(boRefundRoute.POST, { reason: "Paiement après annulation", cause: "admin_other" }, { orderId: created.id });
    expect(refunded.status).toBe(200);
    expect(refunded.body).toMatchObject({ status: "refunded", unsettledSats: "0" });
    expect(refunded.body.refunds).toEqual([expect.objectContaining({ amountSats: "10000", networkFeePayer: "shop" })]);

    // Un nouveau versement après le remboursement intégral : excédent à rembourser
    await pay(created.payment.address, 3_000n);
    const again = await post(boRefundRoute.POST, { reason: "Second versement", cause: "admin_other" }, { orderId: created.id });
    expect(again.body.refunds.map((r: { kind: string }) => r.kind)).toEqual(["cancellation", "overpayment"]);
    expect(again.body.refunds[1]).toMatchObject({ cause: "admin_other", initiatedBy: "admin", createdBy: ADMIN, sentBy: null });
  });

  it("facture expirée partiellement payée : l'utilisateur décide ; sans réponse, l'admin rembourse (frais à sa charge, motif obligatoire)", async () => {
    const alice = await customer(ALICE);
    const expiredId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 5 });
    await receivePayment(prisma, expiredId, 10_000n);
    await as(ADMIN);
    expect((await call(boAttentionRoute.GET)).body.items).toEqual([
      expect.objectContaining({
        orderId: expiredId,
        status: "expired",
        attention: expect.objectContaining({
          reason: "user_decision",
          canRefund: true,
          refundCauses: [
            { cause: "partial_payment", label: "Remboursement d'un paiement partiel", networkFeePayer: "user" },
            { cause: "admin_other", label: "Autre décision de la boutique", networkFeePayer: "shop" },
          ],
        }),
      }),
    ]);
    expectError(await post(boRefundRoute.POST, { reason: "  ", cause: "partial_payment" }, { orderId: expiredId }), 400, "invalid_input");
    const refunded = await post(boRefundRoute.POST, { reason: "Sans réponse après contact", cause: "partial_payment" }, { orderId: expiredId });
    expect(refunded.status).toBe(200);
    expect(refunded.body).toMatchObject({ status: "refunded", attention: { reason: "refund_address_missing" } });
    expect(refunded.body.refunds).toEqual([
      expect.objectContaining({
        cause: "partial_payment", initiatedBy: "admin", networkFeePayer: "user", amountSats: (10_000n - FEE).toString(), reason: "Sans réponse après contact",
      }),
    ]);
  });

  it("paiement partiel en cours de réservation : l'admin ne tranche pas (409 order_reservation_running)", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    await pay(created.payment.address, 10_000n);
    await as(ADMIN);
    expectError(await post(boRefundRoute.POST, { reason: "x", cause: "partial_payment" }, { orderId: created.id }), 409, "order_reservation_running");
  });

  it("annuler des machines d'une commande payée : prorata, puis remboursement intégral", async () => {
    await as(ALICE);
    const created = (await order(batchId, [{ choices: [{ optionId: catalog.optionId, optionValueId: catalog.silentId }] }, {}])).body;
    const expected = BigInt(created.payment.expectedSats);
    await pay(created.payment.address, expected + 7n); // excédent de 7 sats, pas plus que les frais : pas remboursé d'office

    await as(ADMIN);
    const plain = created.lines.find((l: { amount: string }) => l.amount === RESALE.toString());
    const one = await post(boCancelLinesRoute.POST, { lineIds: [plain.id], reason: "Renonciation" }, { orderId: created.id });
    expect(one.status).toBe(200);
    const total = RESALE * 2n + SILENT;
    const prorata = (expected * RESALE * 2n + total) / (total * 2n); // arrondi au plus proche
    expect(one.body).toMatchObject({ status: "paid" });
    expect(one.body.refunds.at(-1)).toMatchObject({ kind: "cancellation", amount: RESALE.toString(), amountSats: prorata.toString() });

    const rest = await post(
      boCancelLinesRoute.POST, { reason: "Machine défectueuse", cause: "shop_defective_machine" }, { orderId: created.id },
    );
    expect(rest.body).toMatchObject({ status: "refunded" });
    const debited = rest.body.refunds.reduce((sum: bigint, r: { amountSats: string }) => sum + BigInt(r.amountSats), 0n);
    expect(debited).toBe(expected + 7n);
    // Motifs (frais à la charge de la boutique) ; le reliquat d'excédent part avec la dernière annulation, sans frais
    const refunds = await prisma.refund.findMany({ where: { order_id: created.id }, orderBy: { created_at: "asc" } });
    expect(refunds.map((r) => [r.kind, r.cause, r.network_fee_payer, r.network_fee_sats])).toEqual([
      ["cancellation", "admin_other", "shop", FEE],
      ["cancellation", "shop_defective_machine", "shop", FEE],
      ["overpayment", "shop_defective_machine", "shop", 0n],
    ]);
    expectError(
      await post(boCancelLinesRoute.POST, { reason: "x", cause: "discount" }, { orderId: created.id }), 400, "invalid_input",
    );
    expectError(await post(boCancelLinesRoute.POST, { reason: "x" }, { orderId: created.id }), 409, "order_not_paid");
  });

  it("factures d'un lot et détail : réservés au backoffice, adresses comprises", async () => {
    await as(ALICE);
    const created = (await order(batchId)).body;
    expectError(await call(boBatchOrdersRoute.GET, { params: { batchId } }), 403, "forbidden");
    await as(ADMIN);
    const list = await call(boBatchOrdersRoute.GET, { params: { batchId } });
    expect(list.body.items).toEqual([
      expect.objectContaining({ id: created.id, user: expect.objectContaining({ authUserId: ALICE }), billingAddress: expect.any(Object) }),
    ]);
    expect((await call(boOrderRoute.GET, { params: { orderId: created.id } })).body.id).toBe(created.id);
    expectError(await call(boBatchOrdersRoute.GET, { params: { batchId: randomUUID() } }), 404, "batch_not_found");
  });
});

describe("wishlists : réglages et règles lus en base", () => {
  it("plafond lu dans ShopSettings ; une quantité au-delà cite le vrai plafond", async () => {
    const other = await createCatalog("S21");
    const lot = await createBatch(other, { quantity: 10, status: "survey" });
    await setShopSettings({ wishlist_max_per_user_per_batch: 2 });
    expect((await call(shopBatchRoute.GET, { params: { batchId: lot } })).body).toMatchObject({ wishlistLimit: 2, maxMachinesPerOrder: 10 });
    await as(ALICE);
    const reply = await post(wishlistsRoute.POST, { batchId: lot, quantity: 101 });
    expectError(reply, 409, "wishlist_limit_reached");
    expect(reply.body.error.message).toBe("Vous en demandez 101, mais il ne vous reste que 2 machines sur ce lot (maximum 2 par personne).");

    const created = await post(wishlistsRoute.POST, { batchId: lot });
    expect(created.body.items[0]).toMatchObject({
      updatedAt: expect.any(String),
      batch: { isPublic: true, priorityEndsAt: null },
    });
  });
});

describe("création d'une facture : références refusées par l'API", () => {
  it("manifestation d'intérêt d'un autre lot (422), déjà convertie en commande payée (409), adresse enregistrée inconnue (422), lot brouillon (404)", async () => {
    const alice = await customer(ALICE);
    const other = await createBatch(catalog, { quantity: 3, status: "survey" });
    const foreign = await wish(catalog, other, alice);
    expectError(await order(batchId, [{ wishlistId: foreign.id }]), 422, "wishlist_other_batch");

    // Convertie : une facture payée reprend déjà cette manifestation d'intérêt
    const survey = await createBatch(catalog, { quantity: 3, status: "survey" });
    const mine = await wish(catalog, survey, alice);
    await moveBatch(survey, "survey", "preorder", priorityOverAt());
    await as(ALICE);
    const first = (await order(survey, [{ wishlistId: mine.id }])).body;
    await pay(first.payment.address, BigInt(first.payment.expectedSats));
    expect((await getOrder(first.id)).body.status).toBe("paid");
    expectError(await order(survey, [{ wishlistId: mine.id }]), 409, "wishlist_converted");
    // Une facture payée ne s'annule pas (renoncement ou remboursement par l'admin)
    expectError(await cancel(first.id), 409, "order_not_cancellable");

    // Adresse « enregistrée » qui n'est pas celle de l'utilisateur
    const bob = await customer(BOB);
    await as(ALICE);
    expectError(
      await post(ordersRoute.POST, { batchId, lines: [{}], billingAddress: { addressId: bob.addressId } }),
      422,
      "unknown_address",
    );

    // Un lot en brouillon est invisible : comme un lot inconnu
    const draft = await createBatch(catalog, { quantity: 3, status: "draft" });
    expectError(await order(draft), 404, "batch_not_found");
    expectError(await order(randomUUID()), 404, "batch_not_found");
  });
});

describe("accepter une facture annulée d'un lot ouvert qui n'a plus de place", () => {
  it("409 out_of_stock : la facture reste annulée, il faut la rembourser", async () => {
    const lot = await createBatch(catalog, { quantity: 1 });
    await as(ALICE);
    const first = (await order(lot)).body;
    expect((await cancel(first.id)).status).toBe(200);
    // Le paiement arrive après l'annulation (la place a été reprise entre-temps par Bob)
    await pay(first.payment.address, BigInt(first.payment.expectedSats));
    await as(BOB);
    const second = (await order(lot)).body;
    await pay(second.payment.address, BigInt(second.payment.expectedSats));

    await as(ADMIN);
    const detail = (await call(boOrderRoute.GET, { params: { orderId: first.id } })).body;
    expect(detail.attention).toMatchObject({ reason: "admin_decision", canAccept: true, canRefund: true });
    expectError(await post(boAcceptRoute.POST, {}, { orderId: first.id }), 409, "out_of_stock");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("cancelled");
  });
});

describe("levée d'un blocage : références inconnues", () => {
  it("lot inconnu (404), utilisateur inconnu (422)", async () => {
    const alice = await customer(ALICE);
    await as(ADMIN);
    expectError(await post(boReleasesRoute.POST, { userId: alice.userId, batchId: randomUUID() }), 404, "batch_not_found");
    expectError(await post(boReleasesRoute.POST, { userId: randomUUID(), batchId }), 422, "unknown_user");
  });
});
