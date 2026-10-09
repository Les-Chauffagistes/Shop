import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as boAcceptRoute from "@/app/api/backoffice/orders/[orderId]/accept/route";
import * as boCancelLinesRoute from "@/app/api/backoffice/orders/[orderId]/cancel-lines/route";
import * as boRefundAddressRoute from "@/app/api/backoffice/orders/[orderId]/refund-address/route";
import * as boRefundRoute from "@/app/api/backoffice/orders/[orderId]/refund/route";
import * as boOrderRoute from "@/app/api/backoffice/orders/[orderId]/route";
import * as boSendRoute from "@/app/api/backoffice/refunds/[refundId]/send/route";
import * as boToSendRoute from "@/app/api/backoffice/refunds/to-send/route";
import * as paymentsRoute from "@/app/api/internal/payments/route";
import * as refundAddressRoute from "@/app/api/orders/[orderId]/refund-address/route";
import * as refundRoute from "@/app/api/orders/[orderId]/refund/route";
import * as renounceRoute from "@/app/api/orders/[orderId]/renounce/route";
import * as orderRoute from "@/app/api/orders/[orderId]/route";
import * as ordersRoute from "@/app/api/orders/route";
import { sendRefund } from "@/server/backoffice-orders";
import { toErrorResponse } from "@/server/errors";
import { renounceOrder, setOwnRefundAddress } from "@/server/orders";
import { prisma } from "./db";
import { TEST_PAYMENT_SECRET } from "./env";
import {
  type Catalog,
  createBatch,
  createCatalog,
  type Customer,
  failureOf,
  moveBatch,
  pay as payFixture,
  placeOrder,
  receivePayment,
  untilAnotherSessionWaitsOnLock,
  writeRefundAddress,
} from "./fixtures";
import { ADMIN, call, type Reply, SAME_ORIGIN, signIn } from "./http";

// Jalon 4, après v5d/v5e/v5f : adresse de remboursement (création, PATCH utilisateur et admin, journal),
// renoncement de l'utilisateur, remboursement par l'admin avec motif, envoi des remboursements,
// acceptation qui ne tient plus dans le stock. Accès : un utilisateur n'agit jamais sur la facture d'un autre.

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

const ALICE = "4001";
const BOB = "4002";
const FEE = 2_000n;

const ADDRESS_A = "bc1qalicerefundaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS_B = "bc1qalicerefundbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_C = "bc1qalicerefundcccccccccccccccccccccccccc";
const BILLING = { fullName: "Alice Martin", line1: "1 rue de la Paix", postalCode: "69001", city: "Lyon", country: "FR" };

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({ status, code });
}

/** Code et statut HTTP qu'aurait une erreur levée par une fonction du serveur. */
async function httpErrorOf(promise: Promise<unknown>) {
  const response = toErrorResponse(await failureOf(promise));
  return { status: response.status, code: (await response.json()).error.code };
}

const as = async (authUserId: string | null) => {
  cookieJar.clear();
  if (authUserId) await signIn(cookieJar, authUserId);
};

type Handler = Parameters<typeof call>[0];
const post = (handler: Handler, body: object, params: Record<string, string> = {}) =>
  call(handler, { body, params, headers: SAME_ORIGIN });
const patch = (handler: Handler, body: object, params: Record<string, string>) =>
  call(handler, { body, params, method: "PATCH", headers: SAME_ORIGIN });
const order = (batchId: string, lines: object[] = [{}], extra: object = {}) =>
  post(ordersRoute.POST, { batchId, lines, billingAddress: BILLING, ...extra });
const pay = (address: string, amountSats: bigint) =>
  call(paymentsRoute.POST, {
    body: { address, txid: randomUUID(), vout: 0, amountSats: amountSats.toString() },
    headers: { authorization: `Bearer ${TEST_PAYMENT_SECRET}` },
  });
const adminOrder = (orderId: string) => call(boOrderRoute.GET, { params: { orderId } });
const toSend = () => call(boToSendRoute.GET);

/** Utilisateur de la boutique créé par une première requête authentifiée (reste connecté). */
async function customer(authUserId: string): Promise<Customer> {
  await as(authUserId);
  await call(ordersRoute.GET);
  const user = await prisma.user.findUniqueOrThrow({ where: { auth_user_id: BigInt(authUserId) } });
  const address = await prisma.address.create({
    data: { user_id: user.id, full_name: "Client", line1: "1 rue", postal_code: "69001", city: "Lyon", country: "FR" },
  });
  return { userId: user.id, addressId: address.id };
}

/** Commande payée par Alice via l'API : `lines` machines sans kit, `extraSats` reçus en plus. */
async function paidOrder(batchId: string, { lines = 1, extraSats = 0n, refundAddress }: { lines?: number; extraSats?: bigint; refundAddress?: string } = {}) {
  await as(ALICE);
  const created = await order(batchId, Array.from({ length: lines }, () => ({})), refundAddress ? { refundAddress } : {});
  expect(created.status).toBe(201);
  await pay(created.body.payment.address, BigInt(created.body.payment.expectedSats) + extraSats);
  return created.body as { id: string; lines: { id: string }[]; payment: { expectedSats: string } };
}

/**
 * Commande payée avec 5 000 sats de trop, dont l'admin a remboursé l'excédent (aucun excédent n'est remboursé
 * d'office : décision Hugo 2026-10-09). Le remboursement créé est « à envoyer ».
 */
async function paidOrderWithOverpaymentRefund(batchId: string, options: { refundAddress?: string } = {}) {
  const created = await paidOrder(batchId, { extraSats: 5_000n, ...options });
  await as(ADMIN);
  const refunded = await post(boRefundRoute.POST, { reason: "Surplus rendu", cause: "overpayment" }, { orderId: created.id });
  expect(refunded.status).toBe(200);
  return created;
}

let catalog: Catalog;
let batchId: string;

beforeEach(async () => {
  cookieJar.clear();
  catalog = await createCatalog();
  batchId = await createBatch(catalog, { quantity: 5 });
});

describe("adresse de remboursement de la facture", () => {
  it("saisie à la création, changée par l'utilisateur puis par l'admin, journalisée avec l'auteur (lecture seule au backoffice)", async () => {
    await as(ALICE);
    expectError(await order(batchId, [{}], { refundAddress: "pas une adresse" }), 400, "invalid_input");
    const created = await order(batchId, [{}], { refundAddress: ADDRESS_A });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ refundAddress: ADDRESS_A, actions: { canEditRefundAddress: true, canRenounce: false } });
    const orderId = created.body.id;

    const changed = await patch(refundAddressRoute.PATCH, { refundAddress: ADDRESS_B }, { orderId });
    expect(changed.status).toBe(200);
    expect(changed.body.refundAddress).toBe(ADDRESS_B);
    expectError(await patch(refundAddressRoute.PATCH, { refundAddress: "court" }, { orderId }), 400, "invalid_input");
    expectError(await patch(refundAddressRoute.PATCH, {}, { orderId }), 400, "invalid_input");
    // Une adresse de paiement de la boutique (celle de la facture d'un autre) : refusée par la base
    await as(BOB);
    const bobs = (await order(batchId)).body;
    await as(ALICE);
    expectError(await patch(refundAddressRoute.PATCH, { refundAddress: bobs.payment.address }, { orderId }), 422, "refund_address_ours");
    expect((await patch(refundAddressRoute.PATCH, { refundAddress: null }, { orderId })).body.refundAddress).toBeNull();

    await as(ADMIN);
    const byAdmin = await patch(boRefundAddressRoute.PATCH, { refundAddress: ADDRESS_C }, { orderId });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.refundAddress).toBe(ADDRESS_C);
    expect(byAdmin.body.refundAddressChanges.map((c: Record<string, unknown>) => [c.oldAddress, c.newAddress, c.actor, c.actorAuthUserId])).toEqual([
      [null, ADDRESS_A, "user", ALICE],
      [ADDRESS_A, ADDRESS_B, "user", ALICE],
      [ADDRESS_B, null, "user", ALICE],
      [null, ADDRESS_C, "admin", ADMIN],
    ]);
    expectError(await patch(boRefundAddressRoute.PATCH, { refundAddress: ADDRESS_A }, { orderId: randomUUID() }), 404, "order_not_found");
  });

  it("remboursement du versement : l'adresse va sur la facture (journalisée), pas sur le remboursement ; facultative si la facture en a une", async () => {
    await as(ALICE);
    const created = (await order(batchId, [{}], { refundAddress: ADDRESS_A })).body;
    await pay(created.payment.address, 300_000n);
    const refunded = await post(refundRoute.POST, {}, { orderId: created.id });
    expect(refunded.status).toBe(200);
    expect(refunded.body).toMatchObject({ status: "refunded", refundAddress: ADDRESS_A });
    expect(refunded.body.refunds).toEqual([expect.objectContaining({ cause: "partial_payment", initiatedBy: "user", destinationAddress: null })]);

    await as(ADMIN);
    const sending = (await toSend()).body.items;
    expect(sending).toEqual([
      expect.objectContaining({
        orderId: created.id, cause: "partial_payment", causeLabel: "Remboursement d'un paiement partiel", initiatedBy: "user",
        amountSats: (300_000n - FEE).toString(), networkFeePayer: "user",
        destinationAddress: ADDRESS_A, destinationSource: "order", addressMissing: false,
        user: expect.objectContaining({ authUserId: ALICE }),
      }),
    ]);
  });
});

describe("renoncement de l'utilisateur", () => {
  it("une machine au prorata puis le reste avec le reliquat d'excédent ; frais à sa charge, portés une fois ; pas un abandon", async () => {
    const created = await paidOrder(batchId, { lines: 2, extraSats: 1_500n, refundAddress: ADDRESS_A });
    const expected = BigInt(created.payment.expectedSats);
    const detail = (await call(orderRoute.GET, { params: { orderId: created.id } })).body;
    expect(detail).toMatchObject({ status: "paid", actions: { canRenounce: true } });
    expect(detail.lines.map((l: { position: number }) => l.position)).toEqual([1, 2]);

    expectError(await post(renounceRoute.POST, { lineIds: [randomUUID()] }, { orderId: created.id }), 422, "unknown_order_line");
    const one = await post(renounceRoute.POST, { lineIds: [created.lines[0].id] }, { orderId: created.id });
    expect(one.status).toBe(200);
    const half = (expected + 1n) / 2n; // prorata arrondi au plus proche
    expect(one.body).toMatchObject({ status: "paid", actions: { canRenounce: true } });
    expect(one.body.refunds).toEqual([
      expect.objectContaining({
        kind: "cancellation", cause: "user_renounce", initiatedBy: "user", networkFeePayer: "user",
        networkFeeSats: FEE.toString(), amountSats: (half - FEE).toString(),
      }),
    ]);

    const rest = await post(renounceRoute.POST, {}, { orderId: created.id });
    expect(rest.body).toMatchObject({ status: "refunded", actions: { canRenounce: false } });
    expect(rest.body.refunds.map((r: Record<string, string>) => [r.kind, r.cause, r.networkFeeSats, r.amountSats])).toEqual([
      ["cancellation", "user_renounce", FEE.toString(), (half - FEE).toString()],
      ["cancellation", "user_renounce", FEE.toString(), (expected - half - FEE).toString()],
      ["overpayment", "user_renounce", "0", "1500"],
    ]);
    // Pas un abandon : Alice peut créer une nouvelle facture tout de suite
    expect((await order(batchId)).status).toBe(201);
  });

  it("refus : lot passé en Commande en cours, facture non payée, prorata qui ne couvre pas les frais", async () => {
    const created = await paidOrder(batchId);
    await moveBatch(batchId, "preorder", "ordering");
    expect((await call(orderRoute.GET, { params: { orderId: created.id } })).body.actions.canRenounce).toBe(false);
    expectError(await post(renounceRoute.POST, {}, { orderId: created.id }), 409, "order_renounce_closed");

    const lot = await createBatch(catalog, { quantity: 5 });
    const alice = await customer(ALICE);
    const pending = (await order(lot)).body;
    expectError(await post(renounceRoute.POST, {}, { orderId: pending.id }), 409, "order_not_paid");

    // 2 machines pour 3 000 sats : 1 500 sats par machine, pas plus que les frais (2 000)
    const other = await createBatch(catalog, { quantity: 5 });
    const small = await placeOrder({ catalog, batchId: other, customer: alice, lines: [false, false], expectedSats: 3_000n });
    await payFixture(small);
    const lineId = (await prisma.orderLine.findFirstOrThrow({ where: { order_id: small } })).id;
    const below = await post(renounceRoute.POST, { lineIds: [lineId] }, { orderId: small });
    expectError(below, 409, "refund_below_network_fee");
    expect(below.body.error.details).toEqual({ refundSats: "1500", networkFeeSats: FEE.toString() });
  });

  it("concurrence : passage à Commande en cours validé d'abord, le renoncement qui l'attendait est refusé", async () => {
    const created = await paidOrder(batchId);
    const alice = await prisma.user.findUniqueOrThrow({ where: { auth_user_id: BigInt(ALICE) } });
    let renouncing: Promise<{ status: number; code: string }> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.batchStatusTransition.create({
        data: { batch_id: batchId, from_status: "preorder", to_status: "ordering", changed_by_auth_user_id: 1n },
      });
      renouncing = httpErrorOf(renounceOrder(alice.id, created.id, {}));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(await renouncing!).toEqual({ status: 409, code: "order_renounce_closed" });
    expect(await prisma.refund.count({ where: { order_id: created.id } })).toBe(0);
  });

  it("concurrence : renoncement et passage à Commande en cours simultanés, l'un ou l'autre ordre, jamais d'état bancal", async () => {
    for (let i = 0; i < 4; i++) {
      const lot = await createBatch(catalog, { quantity: 5 });
      const created = await paidOrder(lot);
      const alice = await prisma.user.findUniqueOrThrow({ where: { auth_user_id: BigInt(ALICE) } });
      const [renounced, moved] = await Promise.allSettled([renounceOrder(alice.id, created.id, {}), moveBatch(lot, "preorder", "ordering")]);
      expect(moved.status).toBe("fulfilled");
      const refunds = await prisma.refund.findMany({ where: { order_id: created.id } });
      if (renounced.status === "fulfilled") {
        expect(refunds.map((r) => r.cause)).toEqual(["user_renounce"]);
        expect((await prisma.order.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("refunded");
      } else {
        expect(await httpErrorOf(Promise.reject(renounced.reason))).toEqual({ status: 409, code: "order_renounce_closed" });
        expect(refunds).toEqual([]);
      }
    }
  });
});

describe("remboursement par l'admin : motif choisi parmi ceux permis", () => {
  it("paiement reçu après un remboursement intégral : motif « excédent » (frais à l'utilisateur) proposé et appliqué", async () => {
    await as(ALICE);
    const created = (await order(batchId, [{}], { refundAddress: ADDRESS_A })).body;
    await pay(created.payment.address, 300_000n);
    await post(refundRoute.POST, {}, { orderId: created.id });
    await pay(created.payment.address, 10_000n);

    // Le client voit que ce nouveau versement attend l'équipe (et non un « Remboursée » muet)
    expect((await call(orderRoute.GET, { params: { orderId: created.id } })).body).toMatchObject({
      status: "refunded",
      payment: { underReviewSats: "10000" },
    });

    await as(ADMIN);
    const detail = (await adminOrder(created.id)).body;
    expect(detail.attention).toMatchObject({
      reason: "admin_decision",
      refundCauses: [
        { cause: "overpayment", label: "Excédent de paiement", networkFeePayer: "user" },
        { cause: "admin_other", label: "Autre décision de la boutique", networkFeePayer: "shop" },
      ],
    });
    expect(detail.cancelLineCauses).toEqual([]);
    expectError(await post(boRefundRoute.POST, { reason: "x", cause: "shop_stock" }, { orderId: created.id }), 422, "refund_cause_not_allowed");
    const refunded = await post(boRefundRoute.POST, { reason: "Second versement", cause: "overpayment" }, { orderId: created.id });
    expect(refunded.status).toBe(200);
    expect(refunded.body.refunds.at(-1)).toMatchObject({
      kind: "overpayment", cause: "overpayment", initiatedBy: "admin", createdBy: ADMIN, networkFeePayer: "user",
      amountSats: (10_000n - FEE).toString(),
    });
  });
});

describe("formulaires de l'admin : messages de validation lisibles", () => {
  const issuesOf = (reply: Reply) => (reply.body.error.issues as { path: string; message: string }[]).map((i) => [i.path, i.message]);

  it("remboursement : motif à choisir, explication obligatoire (aucune liste technique de valeurs)", async () => {
    const created = await paidOrder(batchId, { extraSats: 5_000n });
    await as(ADMIN);
    const noCause = await post(boRefundRoute.POST, { reason: "Surplus" }, { orderId: created.id });
    expectError(noCause, 400, "invalid_input");
    expect(issuesOf(noCause)).toEqual([["cause", "Choisissez l'un des motifs proposés"]]);
    const noReason = await post(boRefundRoute.POST, { reason: "  ", cause: "overpayment" }, { orderId: created.id });
    expect(issuesOf(noReason)).toEqual([["reason", "Explication obligatoire"]]);
    const missing = await post(boRefundRoute.POST, { cause: "overpayment" }, { orderId: created.id });
    expect(issuesOf(missing)).toEqual([["reason", "Explication obligatoire"]]);
    const unknown = await post(boRefundRoute.POST, { reason: "x", cause: "nimporte" }, { orderId: created.id });
    expect(issuesOf(unknown)).toEqual([["cause", "Choisissez l'un des motifs proposés"]]);
    expect(JSON.stringify([noCause.body, unknown.body])).not.toMatch(/Option invalide|shop_stock|attendue/);
  });

  it("annulation de machines : au moins une machine cochée, explication obligatoire", async () => {
    const created = await paidOrder(batchId, { lines: 2 });
    await as(ADMIN);
    const none = await post(boCancelLinesRoute.POST, { lineIds: [], reason: "" }, { orderId: created.id });
    expectError(none, 400, "invalid_input");
    expect(issuesOf(none)).toEqual([
      ["lineIds", "Cochez au moins une machine"],
      ["reason", "Explication obligatoire"],
    ]);
    const badCause = await post(boCancelLinesRoute.POST, { reason: "x", cause: "overpayment" }, { orderId: created.id });
    expect(issuesOf(badCause)).toEqual([["cause", "Choisissez l'un des motifs proposés"]]);
    // Renoncement de l'utilisateur : même consigne côté client
    await as(ALICE);
    const renounce = await post(renounceRoute.POST, { lineIds: [] }, { orderId: created.id });
    expect(issuesOf(renounce)).toEqual([["lineIds", "Choisissez au moins une machine"]]);
  });
});

describe("annulation par l'admin à la demande de l'utilisateur (v5g, user_renounce)", () => {
  it("proposée dans cancelLineCauses, permise après la Précommande, frais à la charge de l'utilisateur, admin tracé", async () => {
    const created = await paidOrder(batchId, { lines: 2, extraSats: 1_500n, refundAddress: ADDRESS_A });
    const expected = BigInt(created.payment.expectedSats);
    await moveBatch(batchId, "preorder", "ordering");
    await moveBatch(batchId, "ordering", "awaiting_reception");
    // L'utilisateur ne peut plus renoncer lui-même
    expectError(await post(renounceRoute.POST, {}, { orderId: created.id }), 409, "order_renounce_closed");

    await as(ADMIN);
    const detail = (await adminOrder(created.id)).body;
    expect(detail.cancelLineCauses).toEqual([
      { cause: "shop_stock", label: "Souci de stock (surplus, lot abandonné)", networkFeePayer: "shop" },
      { cause: "shop_defective_machine", label: "Machine défectueuse", networkFeePayer: "shop" },
      { cause: "user_renounce", label: "Renoncement de l'utilisateur", networkFeePayer: "user" },
      { cause: "admin_other", label: "Autre décision de la boutique", networkFeePayer: "shop" },
    ]);
    // L'excédent (1 500 sats) ne couvre pas les frais (2 000) : « Excédent de paiement » (frais à l'utilisateur) n'est pas proposé
    expect(detail.attention.refundCauses.map((c: { cause: string }) => c.cause)).toEqual(["admin_other"]);

    const one = await post(boCancelLinesRoute.POST, { lineIds: [created.lines[0].id], reason: "Demande par e-mail", cause: "user_renounce" }, { orderId: created.id });
    expect(one.status).toBe(200);
    const half = (expected + 1n) / 2n;
    expect(one.body).toMatchObject({ status: "paid" });
    expect(one.body.refunds).toEqual([
      expect.objectContaining({
        kind: "cancellation", cause: "user_renounce", initiatedBy: "admin", createdBy: ADMIN, networkFeePayer: "user",
        networkFeeSats: FEE.toString(), amountSats: (half - FEE).toString(),
      }),
    ]);
    const rest = await post(boCancelLinesRoute.POST, { reason: "Demande par e-mail", cause: "user_renounce" }, { orderId: created.id });
    expect(rest.body).toMatchObject({ status: "refunded", cancelLineCauses: [] });
    expect(rest.body.refunds.map((r: Record<string, string>) => [r.kind, r.cause, r.initiatedBy, r.networkFeeSats, r.amountSats])).toEqual([
      ["cancellation", "user_renounce", "admin", FEE.toString(), (half - FEE).toString()],
      ["cancellation", "user_renounce", "admin", FEE.toString(), (expected - half - FEE).toString()],
      ["overpayment", "user_renounce", "admin", "0", "1500"],
    ]);
  });

  it("refus : prorata qui ne couvre pas les frais (409), facture non payée (409)", async () => {
    const alice = await customer(ALICE);
    const small = await placeOrder({ catalog, batchId, customer: alice, lines: [false, false], expectedSats: 3_000n });
    await payFixture(small);
    const lineId = (await prisma.orderLine.findFirstOrThrow({ where: { order_id: small } })).id;
    await as(ADMIN);
    const below = await post(boCancelLinesRoute.POST, { lineIds: [lineId], reason: "x", cause: "user_renounce" }, { orderId: small });
    expectError(below, 409, "refund_below_network_fee");
    expect(below.body.error.details).toEqual({ refundSats: "1500", networkFeeSats: FEE.toString() });

    const lot = await createBatch(catalog, { quantity: 5 });
    const pending = await placeOrder({ catalog, batchId: lot, customer: alice });
    expect((await adminOrder(pending)).body.cancelLineCauses).toEqual([]);
    expectError(await post(boCancelLinesRoute.POST, { reason: "x", cause: "user_renounce" }, { orderId: pending }), 409, "order_not_paid");
  });
});

describe("envoi des remboursements", () => {
  it("liste à envoyer, envoi avec l'adresse vue, rejeu identique sans effet, puis tout est figé", async () => {
    const created = await paidOrderWithOverpaymentRefund(batchId, { refundAddress: ADDRESS_A });
    const [item] = (await toSend()).body.items;
    expect(item).toMatchObject({
      orderId: created.id, kind: "overpayment", cause: "overpayment", initiatedBy: "admin",
      amountSats: (5_000n - FEE).toString(), destinationAddress: ADDRESS_A, destinationSource: "order",
    });

    expectError(await post(boSendRoute.POST, { reference: "tx-1", destinationAddress: ADDRESS_B }, { refundId: item.refundId }), 409, "refund_destination_changed");
    expectError(await post(boSendRoute.POST, { reference: " ", destinationAddress: ADDRESS_A }, { refundId: item.refundId }), 400, "invalid_input");
    const sent = await post(boSendRoute.POST, { reference: "tx-1", destinationAddress: ADDRESS_A }, { refundId: item.refundId });
    expect(sent.status).toBe(200);
    expect(sent.body.refunds[0]).toMatchObject({ reference: "tx-1", destinationAddress: ADDRESS_A, sentBy: ADMIN, sentAt: expect.any(String) });
    expect(sent.body.actions.canEditRefundAddress).toBe(false);
    expect((await toSend()).body.items).toEqual([]);

    expect((await post(boSendRoute.POST, { reference: "tx-1", destinationAddress: ADDRESS_A }, { refundId: item.refundId })).status).toBe(200);
    expectError(await post(boSendRoute.POST, { reference: "tx-2", destinationAddress: ADDRESS_A }, { refundId: item.refundId }), 409, "refund_already_sent");
    expectError(await post(boSendRoute.POST, { reference: "tx-1", destinationAddress: ADDRESS_A }, { refundId: randomUUID() }), 404, "refund_not_found");
    expectError(await patch(boRefundAddressRoute.PATCH, { refundAddress: ADDRESS_B }, { orderId: created.id }), 409, "refund_address_frozen");
    await as(ALICE);
    expectError(await patch(refundAddressRoute.PATCH, { refundAddress: ADDRESS_B }, { orderId: created.id }), 409, "refund_address_frozen");
  });

  it("sans adresse connue : « à traiter », puis l'admin inscrit celle obtenue par contact", async () => {
    const created = await paidOrderWithOverpaymentRefund(batchId);
    const [item] = (await toSend()).body.items;
    expect(item).toMatchObject({ orderId: created.id, destinationAddress: null, destinationSource: null, addressMissing: true });
    expect((await adminOrder(created.id)).body.attention).toMatchObject({ reason: "refund_address_missing" });
    const sent = await post(boSendRoute.POST, { reference: "tx-contact", destinationAddress: ADDRESS_C }, { refundId: item.refundId });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ attention: null });
  });

  it("concurrence : changement d'adresse validé avant l'envoi, l'envoi vers l'ancienne adresse est refusé", async () => {
    const created = await paidOrderWithOverpaymentRefund(batchId, { refundAddress: ADDRESS_A });
    const refund = await prisma.refund.findFirstOrThrow({ where: { order_id: created.id } });
    let sending: Promise<{ status: number; code: string }> | undefined;
    await prisma.$transaction(async (tx) => {
      await writeRefundAddress(tx, created.id, ADDRESS_B);
      sending = httpErrorOf(sendRefund(refund.id, { reference: "tx-1", destinationAddress: ADDRESS_A }, { authUserId: ADMIN }));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(await sending!).toEqual({ status: 409, code: "refund_destination_changed" });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).sent_at).toBeNull();
  });

  it("concurrence : envoi validé avant le changement d'adresse, le changement est refusé et non journalisé", async () => {
    const created = await paidOrderWithOverpaymentRefund(batchId, { refundAddress: ADDRESS_A });
    const alice = await prisma.user.findUniqueOrThrow({ where: { auth_user_id: BigInt(ALICE) } });
    const refund = await prisma.refund.findFirstOrThrow({ where: { order_id: created.id } });
    let changing: Promise<{ status: number; code: string }> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "Refund" SET "sent_at" = now(), "reference" = 'tx-1', "destination_address" = ${ADDRESS_A}, "sent_by_auth_user_id" = 1
        WHERE "id" = ${refund.id}::uuid`;
      changing = httpErrorOf(setOwnRefundAddress(alice.id, created.id, { refundAddress: ADDRESS_B }));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(await changing!).toEqual({ status: 409, code: "refund_address_frozen" });
    const log = await prisma.orderRefundAddressChange.findMany({ where: { order_id: created.id } });
    expect(log.map((c) => c.new_address)).toEqual([ADDRESS_A]);
  });
});

describe("accepter une commande qui ne tient plus dans le stock", () => {
  it("réservation vivante payée intégralement, plus de place : 409 out_of_stock, rien n'est fait", async () => {
    const lot = await createBatch(catalog, { quantity: 1 });
    const alice = await customer(ALICE);
    const orderId = await placeOrder({ catalog, batchId: lot, customer: alice });
    // Situation que Batch_stock empêche de valider : simulée triggers désactivés (comme orders-v5d)
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.machine.create({ data: { model_id: catalog.modelId, batch_id: lot, logistical_status: "missing" } });
    });
    await receivePayment(prisma, orderId, (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).expected_sats);

    await as(ADMIN);
    expect((await adminOrder(orderId)).body.attention).toMatchObject({
      reason: "awaiting_decision", canAccept: true, label: expect.stringContaining("ne tient plus dans le stock"),
    });
    const refused = await post(boAcceptRoute.POST, {}, { orderId });
    expectError(refused, 409, "out_of_stock");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("pending_payment");
  });
});

describe("accès : un utilisateur n'agit jamais sur la facture d'un autre", () => {
  it("adresse, renoncement, remboursement : 404 ; routes du backoffice : 403 ; non connecté : 401", async () => {
    const created = await paidOrderWithOverpaymentRefund(batchId, { refundAddress: ADDRESS_A });
    const refund = await prisma.refund.findFirstOrThrow({ where: { order_id: created.id } });
    await as(BOB);
    expectError(await patch(refundAddressRoute.PATCH, { refundAddress: ADDRESS_B }, { orderId: created.id }), 404, "order_not_found");
    expectError(await post(renounceRoute.POST, {}, { orderId: created.id }), 404, "order_not_found");
    expectError(await post(refundRoute.POST, {}, { orderId: created.id }), 404, "order_not_found");
    expectError(await patch(boRefundAddressRoute.PATCH, { refundAddress: ADDRESS_B }, { orderId: created.id }), 403, "forbidden");
    expectError(await toSend(), 403, "forbidden");
    expectError(await post(boSendRoute.POST, { reference: "x", destinationAddress: ADDRESS_A }, { refundId: refund.id }), 403, "forbidden");
    await as(null);
    expectError(await post(renounceRoute.POST, {}, { orderId: created.id }), 401, "unauthenticated");
    // Rien n'a changé
    const after = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { refunds: true } });
    expect(after).toMatchObject({ status: "paid", refund_address: ADDRESS_A });
    expect(after.refunds).toHaveLength(1);
    expect(await prisma.orderRefundAddressChange.count({ where: { order_id: created.id } })).toBe(1);
  });

  it("écriture cross-site refusée", async () => {
    const created = await paidOrder(batchId);
    const crossSite = await call(renounceRoute.POST, {
      body: {},
      params: { orderId: created.id },
      headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
    });
    expectError(crossSite, 403, "cross_origin");
  });
});
