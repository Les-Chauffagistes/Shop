import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchStatus } from "../../prisma/generated/client";
import * as boBatchRoute from "@/app/api/backoffice/batches/[batchId]/route";
import * as boAcceptRoute from "@/app/api/backoffice/orders/[orderId]/accept/route";
import * as boCancelLinesRoute from "@/app/api/backoffice/orders/[orderId]/cancel-lines/route";
import * as boDismissRoute from "@/app/api/backoffice/orders/[orderId]/dismiss-excess/route";
import * as boRefundRoute from "@/app/api/backoffice/orders/[orderId]/refund/route";
import * as boOrderRoute from "@/app/api/backoffice/orders/[orderId]/route";
import * as boAttentionRoute from "@/app/api/backoffice/orders/attention/route";
import * as boBlocksRoute from "@/app/api/backoffice/order-blocks/route";
import * as paymentsRoute from "@/app/api/internal/payments/route";
import * as orderRoute from "@/app/api/orders/[orderId]/route";
import * as renounceRoute from "@/app/api/orders/[orderId]/renounce/route";
import * as eligibilityRoute from "@/app/api/orders/eligibility/route";
import * as ordersRoute from "@/app/api/orders/route";
import * as profileRoute from "@/app/api/profile/route";
import * as wishlistsRoute from "@/app/api/wishlists/route";
import { ACCEPTS_ORDERS, BATCH_STATUS_LABELS } from "@/server/batch-status";
import { changeBatchStatus } from "@/server/batches";
import { toErrorResponse } from "@/server/errors";
import { prisma } from "./db";
import { TEST_PAYMENT_SECRET } from "./env";
import {
  authUserIdOf,
  type Catalog,
  cancelOrder,
  createBatch,
  createCatalog,
  createUser,
  EXPECTED_SATS,
  failureOf,
  moveBatch,
  pay as payOrder,
  placeOrder,
  receivePayment,
  SILENT_PRICE,
  untilAnotherSessionWaitsOnLock,
  wish,
} from "./fixtures";
import { ADMIN, call, type Reply, SAME_ORIGIN, signIn } from "./http";

// Backend v5i/v5j puis migration v5k (décisions Hugo 2026-10-09) : e-mail du profil et de la facture,
// classer sans suite, excédent jamais renvoyé avec une annulation, factures impayées annulées par toute
// fermeture des commandes (verrou des factures avant le lot), options retirées des wishlists.

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

const ALICE = "8001";
const FEE = 2_000n;
/** Adresse de remboursement : les annulations partent sans rester bloquées sur « adresse manquante » */
const REFUND_ADDRESS = "bc1qalicerefundaaaaaaaaaaaaaaaaaaaaaaaaaa";
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
const patch = (handler: Handler, body: unknown, params: Record<string, string> = {}) =>
  call(handler, { body, params, method: "PATCH", headers: SAME_ORIGIN });
const order = (batchId: string, extra: object = {}) => post(ordersRoute.POST, { batchId, lines: [{}], billingAddress: BILLING, ...extra });
const adminOrder = (orderId: string) => call(boOrderRoute.GET, { params: { orderId } });
const dismiss = (orderId: string, body: object = {}) => post(boDismissRoute.POST, body, { orderId });
let txSeq = 0;
const pay = (address: string, amountSats: bigint) =>
  call(paymentsRoute.POST, {
    body: { address, txid: `v5k-${++txSeq}-${address}`, vout: 0, amountSats: amountSats.toString() },
    headers: { authorization: `Bearer ${TEST_PAYMENT_SECRET}` },
  });
const profileEmail = async (authUserId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { auth_user_id: BigInt(authUserId) } })).email;

/** Code et statut HTTP qu'aurait une erreur levée par une écriture directe en base. */
async function httpErrorOf(promise: Promise<unknown>) {
  const response = toErrorResponse(await failureOf(promise));
  return { status: response.status, code: (await response.json()).error.code };
}

let catalog: Catalog;
let batchId: string;

beforeEach(async () => {
  cookieJar.clear();
  catalog = await createCatalog();
  batchId = await createBatch(catalog, { quantity: 5 });
});

/** Commande payée par Alice (API), avec `extraSats` de trop. */
async function paidOrder(extraSats = 0n, lot = batchId) {
  await as(ALICE);
  const created = await order(lot, { contactEmail: "alice@example.fr", refundAddress: REFUND_ADDRESS });
  expect(created.status).toBe(201);
  expect((await pay(created.body.payment.address, BigInt(created.body.payment.expectedSats) + extraSats)).status).toBe(201);
  return created.body as { id: string; payment: { address: string; expectedSats: string } };
}

describe("profil : e-mail de contact", () => {
  it("lecture et modification ; format refusé par la base (422) ; pas d'effacement (400)", async () => {
    await as(null);
    expectError(await call(profileRoute.GET), 401, "unauthenticated");
    await as(ALICE);
    expect((await call(profileRoute.GET)).body).toEqual({ email: null });

    const changed = await patch(profileRoute.PATCH, { email: "  Alice@Example.fr " });
    expect(changed).toMatchObject({ status: 200, body: { email: "Alice@Example.fr" } }); // espaces retirés, casse gardée
    expect((await call(profileRoute.GET)).body).toEqual({ email: "Alice@Example.fr" });

    for (const email of ["alice", "alice@exemple", "a b@exemple.fr"]) {
      expectError(await patch(profileRoute.PATCH, { email }), 422, "invalid_contact_email");
    }
    for (const email of ["", "   ", null]) expectError(await patch(profileRoute.PATCH, { email }), 400, "invalid_input");
    expectError(await patch(profileRoute.PATCH, { email: `${"a".repeat(250)}@b.fr` }), 400, "invalid_input");
    expectError(await patch(profileRoute.PATCH, { email: "a@b.fr", pseudo: "x" }), 400, "invalid_input");
    expect(await profileEmail(ALICE)).toBe("Alice@Example.fr");

    const crossSite = await call(profileRoute.PATCH, {
      body: { email: "pirate@evil.test" },
      method: "PATCH",
      headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
    });
    expectError(crossSite, 403, "cross_origin");
  });
});

describe("création de facture : e-mail de contact", () => {
  it("sans profil ni saisie : 422 contact_email_required, rien n'est écrit", async () => {
    await as(ALICE);
    const eligibility = await call(eligibilityRoute.GET, { path: `/?batchId=${batchId}` });
    expect(eligibility.body.profileEmail).toBeNull();
    expectError(await order(batchId), 422, "contact_email_required");
    expectError(await order(batchId, { contactEmail: "" }), 422, "contact_email_required");
    expect(await prisma.order.count()).toBe(0);
  });

  it("e-mail saisi : instantané sur la facture et mémorisé sur le profil ; ensuite, le profil suffit", async () => {
    await as(ALICE);
    const first = await order(batchId, { contactEmail: " alice@example.fr " });
    expect(first.status).toBe(201);
    expect(first.body.contactEmail).toBe("alice@example.fr");
    expect(await profileEmail(ALICE)).toBe("alice@example.fr");
    expect((await call(eligibilityRoute.GET, { path: `/?batchId=${batchId}` })).body.profileEmail).toBe("alice@example.fr");

    // Une autre facture (autre lot) sans saisie : la base copie l'e-mail du profil
    const other = await createBatch(catalog, { quantity: 5 });
    const second = await order(other);
    expect(second.body.contactEmail).toBe("alice@example.fr");

    // E-mail différent : mémorisé sur le profil ; l'instantané des factures précédentes ne change pas
    const third = await order(await createBatch(catalog, { quantity: 5 }), { contactEmail: "alice.pro@example.fr" });
    expect(third.body.contactEmail).toBe("alice.pro@example.fr");
    expect(await profileEmail(ALICE)).toBe("alice.pro@example.fr");
    expect((await call(orderRoute.GET, { params: { orderId: first.body.id } })).body.contactEmail).toBe("alice@example.fr");
  });

  it("e-mail mal formé : 422 invalid_contact_email, ni facture ni profil modifié", async () => {
    await as(ALICE);
    await patch(profileRoute.PATCH, { email: "alice@example.fr" });
    expectError(await order(batchId, { contactEmail: "alice@" }), 422, "invalid_contact_email");
    expect(await prisma.order.count()).toBe(0);
    expect(await profileEmail(ALICE)).toBe("alice@example.fr");
  });

  it("refus de la base (dernier rempart) : instantané jamais réécrit, format contrôlé", async () => {
    const alice = await createUser();
    const orderId = await placeOrder({ catalog, batchId, customer: alice, contactEmail: "alice@example.fr" });
    expect(
      await httpErrorOf(prisma.order.update({ where: { id: orderId }, data: { contact_email: "autre@example.fr" } })),
    ).toEqual({ status: 500, code: "internal" });
    expect(await httpErrorOf(prisma.user.update({ where: { id: alice.userId }, data: { email: "pas-un-email" } }))).toEqual({
      status: 422,
      code: "invalid_contact_email",
    });
  });
});

describe("backoffice : e-mail de la facture et du profil", () => {
  it("facture, « À traiter » et « Blocages » montrent l'instantané et le profil (les deux s'ils diffèrent)", async () => {
    const paid = await paidOrder(500n); // excédent : « à traiter »
    await as(ALICE);
    await patch(profileRoute.PATCH, { email: "alice.nouveau@example.fr" });

    await as(ADMIN);
    expect((await adminOrder(paid.id)).body).toMatchObject({ contactEmail: "alice@example.fr", profileEmail: "alice.nouveau@example.fr" });
    const attention = (await call(boAttentionRoute.GET)).body.items;
    expect(attention).toEqual([
      expect.objectContaining({ orderId: paid.id, contactEmail: "alice@example.fr", profileEmail: "alice.nouveau@example.fr" }),
    ]);

    // Blocage : trois factures abandonnées ; e-mail de la dernière facture sur ce lot et e-mail du profil
    const bob = await createUser();
    await prisma.user.update({ where: { id: bob.userId }, data: { email: "bob@example.fr" } });
    for (const [minutesAgo, email] of [[180, "bob.1@example.fr"], [120, "bob.2@example.fr"], [60, "bob.3@example.fr"]] as const) {
      await placeOrder({ catalog, batchId, customer: bob, expiredMinutesAgo: minutesAgo, contactEmail: email });
    }
    const blocks = (await call(boBlocksRoute.GET)).body.items;
    expect(blocks).toEqual([
      expect.objectContaining({ user: expect.objectContaining({ id: bob.userId }), contactEmail: "bob.3@example.fr", profileEmail: "bob@example.fr" }),
    ]);
  });
});

describe("classer sans suite (dismiss-excess)", () => {
  it("excédent ≤ frais d'une commande payée : classé une fois, journalisé, la facture sort de « À traiter »", async () => {
    const paid = await paidOrder(1_500n);
    await as(ALICE);
    expectError(await dismiss(paid.id), 403, "forbidden");

    await as(ADMIN);
    const before = (await adminOrder(paid.id)).body;
    expect(before).toMatchObject({
      unsettledSats: "1500",
      dismissal: null,
      attention: { reason: "overpayment_decision", canDismiss: true, networkFeeSats: FEE.toString() },
    });
    expectError(await dismiss(paid.id, { reason: "x".repeat(501) }), 400, "invalid_input");

    const done = await dismiss(paid.id, { reason: "  Client prévenu, montant inférieur aux frais  " });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: "paid",
      unsettledSats: "0",
      attention: null,
      dismissal: { sats: "1500", networkFeeSats: FEE.toString(), reason: "Client prévenu, montant inférieur aux frais", dismissedBy: ADMIN },
    });
    expect((await call(boAttentionRoute.GET)).body.items).toEqual([]);
    const journal = await prisma.orderExcessDismissal.findUniqueOrThrow({ where: { order_id: paid.id } });
    expect(journal).toMatchObject({ sats: 1_500n, network_fee_sats: FEE, dismissed_by_auth_user_id: 1n });

    // Le client voit le classement (sans le motif ni l'admin) ; plus rien « en cours de traitement »
    await as(ALICE);
    const mine = (await call(orderRoute.GET, { params: { orderId: paid.id } })).body;
    expect(mine.dismissal).toEqual({ sats: "1500", networkFeeSats: FEE.toString(), createdAt: expect.any(String) });
    expect(mine.payment.underReviewSats).toBe("0");

    await as(ADMIN);
    expectError(await dismiss(paid.id), 409, "excess_already_dismissed");
  });

  it("refus : excédent au-delà des frais, rien à classer, facture en attente, facture inconnue", async () => {
    const big = await paidOrder(FEE + 1n);
    await as(ADMIN);
    expect((await adminOrder(big.id)).body.attention).toMatchObject({ canDismiss: false });
    const above = await dismiss(big.id);
    expectError(above, 409, "excess_above_network_fee");
    expect(above.body.error.details).toEqual({ unsettledSats: "2001", networkFeeSats: "2000" });

    const exact = await paidOrder(0n, await createBatch(catalog, { quantity: 5 }));
    await as(ADMIN);
    expectError(await dismiss(exact.id), 409, "nothing_to_dismiss");

    await as(ALICE);
    const pending = (await order(await createBatch(catalog, { quantity: 5 }))).body;
    await pay(pending.payment.address, 500n);
    await as(ADMIN);
    expectError(await dismiss(pending.id), 409, "nothing_to_dismiss");
    expectError(await dismiss("00000000-0000-4000-8000-000000000000"), 404, "order_not_found");
    expectError(await dismiss("pas-un-uuid"), 404, "order_not_found");
  });

  it("versement arrivé après un classement : de nouveau « à traiter », pas de second classement, l'admin rembourse", async () => {
    const paid = await paidOrder(1_000n);
    await as(ADMIN);
    expect((await dismiss(paid.id)).status).toBe(200);
    await pay(paid.payment.address, 3_000n);
    const after = (await adminOrder(paid.id)).body;
    expect(after).toMatchObject({ unsettledSats: "3000", attention: { reason: "overpayment_decision", canDismiss: false } });
    expectError(await dismiss(paid.id), 409, "excess_already_dismissed");
    const refunded = await post(boRefundRoute.POST, { reason: "Second versement", cause: "overpayment" }, { orderId: paid.id });
    expect(refunded.body).toMatchObject({ unsettledSats: "0", attention: null });
    expect(refunded.body.refunds.at(-1)).toMatchObject({ kind: "overpayment", amountSats: "1000", networkFeeSats: "2000" });
  });

  it("facture annulée dont le versement est classé : nouveau versement complet, elle ne s'accepte plus", async () => {
    await as(ALICE);
    const created = (await order(batchId, { contactEmail: "alice@example.fr" })).body;
    await cancelOrder(prisma, created.id);
    await pay(created.payment.address, 800n);
    await as(ADMIN);
    expect((await adminOrder(created.id)).body.attention).toMatchObject({ reason: "admin_decision", canDismiss: true });
    expect((await dismiss(created.id)).body).toMatchObject({ status: "cancelled", attention: null, dismissal: { sats: "800" } });

    await pay(created.payment.address, BigInt(created.payment.expectedSats));
    const after = (await adminOrder(created.id)).body;
    expect(after.attention).toMatchObject({ reason: "admin_decision", canAccept: false, canDismiss: false });
    expect(after.attention.label).toMatch(/classés sans suite/);
    expectError(await post(boAcceptRoute.POST, {}, { orderId: created.id }), 409, "order_not_acceptable");
    // Dernier rempart : la base refuse aussi l'acceptation (Order_dismissed_final)
    expect(
      await httpErrorOf(prisma.order.update({ where: { id: created.id }, data: { status: "paid", paid_at: new Date() } })),
    ).toEqual({ status: 409, code: "order_not_acceptable" });
  });

  it("deux classements simultanés : un seul passe, l'autre 409 (verrou de la facture)", async () => {
    const paid = await paidOrder(700n);
    await as(ADMIN);
    const replies = await Promise.all([dismiss(paid.id), dismiss(paid.id)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(replies.find((r) => r.status === 409)!.body.error.code).toBe("excess_already_dismissed");
    expect(await prisma.orderExcessDismissal.count({ where: { order_id: paid.id } })).toBe(1);
  });

  it("codes des contraintes de la base : montant faux, second classement, au-delà des frais", async () => {
    const paid = await paidOrder(1_200n);
    const write = (sats: bigint, fee = FEE) =>
      prisma.orderExcessDismissal.create({ data: { order_id: paid.id, sats, network_fee_sats: fee, dismissed_by_auth_user_id: 1n } });
    expect(await httpErrorOf(write(1_000n))).toEqual({ status: 409, code: "nothing_to_dismiss" });
    expect(await httpErrorOf(write(1_200n, 1_000n))).toEqual({ status: 409, code: "excess_above_network_fee" });
    await write(1_200n);
    // Sans nouveau versement, rien n'est plus non affecté : la base refuse le montant avant l'index unique
    expect(await httpErrorOf(write(1_200n))).toEqual({ status: 409, code: "nothing_to_dismiss" });
    // Nouveau versement : le montant est juste, l'index unique refuse le second classement
    await receivePayment(prisma, paid.id, 300n);
    expect(await httpErrorOf(write(300n))).toEqual({ status: 409, code: "excess_already_dismissed" });
  });
});

describe("annulation de toute une commande payée : l'excédent ne part jamais avec elle", () => {
  it.each(["shop_stock", "shop_defective_machine", "admin_other", "user_renounce"] as const)(
    "motif %s : remboursée, excédent « à traiter », l'admin le classe ou le rembourse",
    async (cause) => {
      const paid = await paidOrder(1_500n);
      await as(ADMIN);
      const cancelled = await post(boCancelLinesRoute.POST, { reason: "Annulation", cause }, { orderId: paid.id });
      expect(cancelled.body).toMatchObject({ status: "refunded", unsettledSats: "1500", attention: { reason: "admin_decision", canDismiss: true } });
      expect(cancelled.body.refunds.map((r: { kind: string }) => r.kind)).toEqual(["cancellation"]);
      expect((await dismiss(paid.id)).body).toMatchObject({ status: "refunded", attention: null, dismissal: { sats: "1500" } });
    },
  );

  it("renoncement de l'utilisateur : pas de reliquat ; excédent au-delà des frais remboursé ensuite par l'admin", async () => {
    const paid = await paidOrder(5_000n);
    await as(ALICE);
    const renounced = await post(renounceRoute.POST, {}, { orderId: paid.id });
    expect(renounced.body).toMatchObject({ status: "refunded", payment: { underReviewSats: "5000" } });
    expect(renounced.body.refunds).toHaveLength(1);
    await as(ADMIN);
    const detail = (await adminOrder(paid.id)).body;
    expect(detail.attention).toMatchObject({ reason: "admin_decision", canDismiss: false });
    expect(detail.attention.refundCauses.map((c: { cause: string }) => c.cause)).toEqual(["overpayment", "admin_other"]);
    const refunded = await post(boRefundRoute.POST, { reason: "Excédent après renoncement", cause: "overpayment" }, { orderId: paid.id });
    expect(refunded.body).toMatchObject({ unsettledSats: "0" });
    expect(refunded.body.refunds.at(-1)).toMatchObject({ kind: "overpayment", cause: "overpayment", amountSats: "3000" });
  });

  it("excédent classé puis annulation complète : les sats classés ne sont pas remboursés une seconde fois", async () => {
    const paid = await paidOrder(900n);
    await as(ADMIN);
    expect((await dismiss(paid.id)).status).toBe(200);
    const cancelled = await post(boCancelLinesRoute.POST, { reason: "Machine morte", cause: "shop_defective_machine" }, { orderId: paid.id });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "refunded", unsettledSats: "0", attention: null });
    const debited = cancelled.body.refunds.reduce((sum: bigint, r: { amountSats: string }) => sum + BigInt(r.amountSats), 0n);
    expect(debited).toBe(BigInt(paid.payment.expectedSats));
  });
});

describe("lot qui ferme les commandes : factures impayées annulées, verrou des factures d'abord", () => {
  async function packagingBatch() {
    const lot = await createBatch(catalog, { quantity: 5, status: "inspection" });
    await moveBatch(lot, "inspection", "packaging");
    // Une machine remise au transporteur (condition du passage En transit) : attribuée à une commande payée
    const buyer = await createUser();
    const paidId = await placeOrder({ catalog, batchId: lot, customer: buyer, contactEmail: "acheteur@example.fr" });
    await payOrder(paidId);
    const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: paidId } });
    const machine = await prisma.machine.create({
      data: { batch_id: lot, model_id: catalog.modelId, logistical_status: "ready", functional_status: "ok", received_at: new Date() },
    });
    await prisma.orderLineAssignment.create({
      data: { order_line_id: line.id, batch_id: lot, machine_id: machine.id, changed_by_auth_user_id: 1n },
    });
    await prisma.machine.update({ where: { id: machine.id }, data: { logistical_status: "in_transit", shipped_at: new Date() } });
    return lot;
  }
  const transitionTo = async (lot: string, to: BatchStatus) => {
    await as(ADMIN);
    const detail = (await call(boBatchRoute.GET, { params: { batchId: lot } })).body;
    return detail.transitions.find((t: { to: string }) => t.to === to);
  };

  it("la table ACCEPTS_ORDERS du domaine est exactement batch_accepts_orders", async () => {
    const statuses = Object.keys(BATCH_STATUS_LABELS) as BatchStatus[];
    const rows = await prisma.$queryRaw<{ s: BatchStatus }[]>`
      SELECT s::text AS s FROM unnest(${statuses}::batch_status[]) s WHERE coalesce("batch_accepts_orders"(s), false)`;
    expect(rows.map((r) => r.s).sort()).toEqual([...ACCEPTS_ORDERS].sort());
  });

  it("En transit : la confirmation annonce les factures annulées, la transition les annule (jamais supprimées)", async () => {
    const lot = await packagingBatch();
    const alice = await createUser();
    const bob = await createUser();
    const unpaid = await placeOrder({ catalog, batchId: lot, customer: alice, contactEmail: "alice@example.fr" });
    const partial = await placeOrder({ catalog, batchId: lot, customer: bob, contactEmail: "bob@example.fr" });
    await receivePayment(prisma, partial, 1_000n);

    const transition = await transitionTo(lot, "in_transit");
    expect(transition).toMatchObject({ allowed: true, cancelsPendingOrders: 1 });
    expect(transition.warnings.join(" ")).toMatch(/1 facture en attente de paiement, sans versement, sera annulée/);
    expect((await transitionTo(lot, "tuning")).cancelsPendingOrders).toBe(0);

    await changeBatchStatus(lot, { from: "packaging", to: "in_transit" }, { authUserId: ADMIN });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: unpaid } })).status).toBe("cancelled");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: partial } })).status).toBe("pending_payment");
    expect(await prisma.order.count({ where: { batch_id: lot, status: { in: ["cancelled", "pending_payment"] } } })).toBe(2);
  });

  it("paiement en cours pendant le passage En transit : pas d'interblocage, la facture payée échappe à l'annulation", async () => {
    const lot = await packagingBatch();
    const alice = await createUser();
    const orderId = await placeOrder({ catalog, batchId: lot, customer: alice, contactEmail: "alice@example.fr" });
    let moving: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      // Paiement complet en cours : la facture est verrouillée ; son COMMIT prend le verrou du lot (Order_check)
      await receivePayment(tx, orderId, EXPECTED_SATS);
      await tx.order.update({ where: { id: orderId }, data: { status: "paid", paid_at: new Date() } });
      moving = changeBatchStatus(lot, { from: "packaging", to: "in_transit" }, { authUserId: ADMIN });
      await untilAnotherSessionWaitsOnLock();
    });
    await moving;
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: lot } })).status).toBe("in_transit");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("paid");
  });

  it("clôture : sans facture en attente, rien à annoncer", async () => {
    const lot = await packagingBatch();
    await changeBatchStatus(lot, { from: "packaging", to: "in_transit" }, { authUserId: ADMIN });
    await prisma.machine.updateMany({ where: { batch_id: lot }, data: { logistical_status: "delivered", delivered_at: new Date() } });
    expect(await transitionTo(lot, "closed")).toMatchObject({ allowed: true, cancelsPendingOrders: 0, warnings: [] });
  });
});

describe("option retirée d'un lot : wishlists ajustées, l'admin confirme, l'utilisateur est prévenu", () => {
  it("retrait au sondage d'une valeur choisie : 409 sans confirmation, puis ajustement journalisé et optionWithdrawals", async () => {
    // Troisième valeur : le menu garde un choix une fois Silent kit retiré
    await prisma.optionValue.create({ data: { option_id: catalog.optionId, label: "Air Flow", price: 3_500n, position: 2 } });
    const survey = await createBatch(catalog, { quantity: 5, status: "survey" });
    const alice = await createUser();
    const wishlist = await wish(catalog, survey, alice, [{ optionId: catalog.optionId, valueId: catalog.silentId, price: SILENT_PRICE }]);

    await as(ADMIN);
    const { updatedAt } = (await call(boBatchRoute.GET, { params: { batchId: survey } })).body;
    const withdraw = { expectedUpdatedAt: updatedAt, optionValues: [{ optionValueId: catalog.silentId, enabled: false }] };
    const refused = await patch(boBatchRoute.PATCH, withdraw, { batchId: survey });
    expectError(refused, 409, "withdrawn_value_has_choices");
    expect(refused.body.error.message).toMatch(/« Silent kit »/);
    expect(refused.body.error.details).toEqual({ wishlists: 1 });
    expect(await prisma.wishlistOptionWithdrawal.count()).toBe(0);

    expect((await patch(boBatchRoute.PATCH, { ...withdraw, confirmResetChoices: true }, { batchId: survey })).status).toBe(200);

    await as(String(await authUserIdOf(prisma, alice.userId)));
    const [mine] = (await call(wishlistsRoute.GET)).body.items;
    expect(mine).toMatchObject({ id: wishlist.id, outdated: false, amount: "50000" });
    expect(mine.items).toEqual([expect.objectContaining({ label: "Sans kit", unitPrice: "0", offered: true })]);
    expect(mine.optionWithdrawals).toEqual([
      {
        optionId: catalog.optionId,
        optionTitle: "Kit de ventilation",
        withdrawnValueId: catalog.silentId,
        withdrawnValueLabel: "Silent kit",
        withdrawnUnitPrice: SILENT_PRICE.toString(),
        defaultValueId: catalog.noKitId,
        defaultValueLabel: "Sans kit",
        createdAt: expect.any(String),
      },
    ]);
  });

  it("retrait d'une valeur que personne n'a choisie : aucune confirmation demandée", async () => {
    await prisma.optionValue.create({ data: { option_id: catalog.optionId, label: "Air Flow", price: 3_500n, position: 2 } });
    const survey = await createBatch(catalog, { quantity: 5, status: "survey" });
    await wish(catalog, survey, await createUser());
    await as(ADMIN);
    const { updatedAt } = (await call(boBatchRoute.GET, { params: { batchId: survey } })).body;
    const reply = await patch(
      boBatchRoute.PATCH,
      { expectedUpdatedAt: updatedAt, optionValues: [{ optionValueId: catalog.silentId, enabled: false }] },
      { batchId: survey },
    );
    expect(reply.status).toBe(200);
  });
});
