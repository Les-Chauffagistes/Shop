import { beforeEach, describe, expect, it, vi } from "vitest";
import * as customersRoute from "@/app/api/backoffice/customers/route";
import * as manualSalesRoute from "@/app/api/backoffice/manual-sales/route";
import * as blockReleasesRoute from "@/app/api/backoffice/order-block-releases/route";
import * as replacementRoute from "@/app/api/backoffice/order-lines/[lineId]/replacement/route";
import * as attentionRoute from "@/app/api/backoffice/orders/attention/route";
import * as cancelLinesRoute from "@/app/api/backoffice/orders/[orderId]/cancel-lines/route";
import * as discountRoute from "@/app/api/backoffice/orders/[orderId]/discount/route";
import * as dismissRoute from "@/app/api/backoffice/orders/[orderId]/dismiss-excess/route";
import * as boRefundAddressRoute from "@/app/api/backoffice/orders/[orderId]/refund-address/route";
import * as boRefundRoute from "@/app/api/backoffice/orders/[orderId]/refund/route";
import * as boOrderRoute from "@/app/api/backoffice/orders/[orderId]/route";
import * as sendRoute from "@/app/api/backoffice/refunds/[refundId]/send/route";
import * as toSendRoute from "@/app/api/backoffice/refunds/to-send/route";
import * as renounceRoute from "@/app/api/orders/[orderId]/renounce/route";
import * as orderRoute from "@/app/api/orders/[orderId]/route";
import { pgFailureOf } from "@/server/errors";
import { attentionOf, OFFCHAIN_REFUND_CAUSES } from "@/server/order-rules";
import { loadBalances } from "@/server/orders";
import type { RefundCause, RefundKind } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  authUserIdOf,
  type Catalog,
  cancelOrder,
  changeMachine,
  createCustomerWithEmail,
  createBatch,
  createCatalog,
  createStockBatch,
  createUser,
  type Customer,
  failureOf,
  manualSale,
  pay,
  placeOrder,
  receiveAndCheck,
  REFUND_ADDRESS,
  RESALE,
  restock,
  setShopSettings,
  SILENT_PRICE,
} from "./fixtures";
import { ADMIN, call, type Reply, SAME_ORIGIN, signIn } from "./http";

// Refonte machines / stock, jalon R5b : routes de la vente manuelle (clients, vente payée hors chaîne, machines
// d'office sur le stock, blocage puis levée), remboursement hors chaîne de bout en bout (annulation de machines,
// rabais, envoi avec référence, « À traiter » et « Remboursements »), et visibilité côté boutique.

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

const as = async (authUserId: string | null) => {
  cookieJar.clear();
  if (authUserId) await signIn(cookieJar, authUserId);
};

type Handler = Parameters<typeof call>[0];
const post = (handler: Handler, body: object, params: Record<string, string> = {}) => call(handler, { body, params, headers: SAME_ORIGIN });
const get = (handler: Handler, path = "/", params: Record<string, string> = {}) => call(handler, { path, params });

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({ status, code });
}


let catalog: Catalog;

beforeEach(async () => {
  catalog = await createCatalog();
  await as(ADMIN);
});

/** Lot de stock en vente avec `sellable` machines réassorties, reçues et contrôlées ok, dans cet ordre. */
async function stockWith(sellable: number) {
  const stock = await createStockBatch(catalog);
  const { machines } = await restock(catalog, stock, sellable);
  for (const m of machines) await receiveAndCheck(m.id);
  return { stock, machines };
}

const sale = (body: object) => post(manualSalesRoute.POST, { means: "cash", ...body });

/** Vente manuelle par la route au client `userId`, adresse enregistrée `addressId` ; renvoie la facture. */
async function sold(batchId: string, customer: Customer, body: object = {}) {
  const reply = await sale({ userId: customer.userId, batchId, lines: [{}], billingAddress: { addressId: customer.addressId }, ...body });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body;
}

const linesOf = (orderId: string) => prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } });

describe("clients de la vente manuelle", () => {
  it("recherche par e-mail parmi les comptes existants, e-mail identique d'abord ; aucun compte : liste vide", async () => {
    const alice = await createUser();
    await prisma.user.update({ where: { id: alice.userId }, data: { email: "henri.martin@exemple.fr" } });
    const henri = await createCustomerWithEmail("Henri@Exemple.fr");
    const found = await get(customersRoute.GET, "/?q=HENRI");
    expect(found.status).toBe(200);
    expect(found.body.items.map((c: { id: string }) => c.id).sort()).toEqual([alice.userId, henri.userId].sort());
    expect(found.body.items[0]).toMatchObject({ authUserId: expect.any(String), addresses: [expect.objectContaining({ fullName: "Client Comptoir" })] });
    expect(found.body.items[0]).not.toHaveProperty("hasAccount");
    expect((await get(customersRoute.GET, "/?q=henri@exemple.fr")).body.items[0].id).toBe(henri.userId);
    expect((await get(customersRoute.GET, "/?q=inconnu@exemple.fr")).body.items).toEqual([]);
    expectError(await get(customersRoute.GET, "/?q=he"), 400, "invalid_input");
  });

  it("recherche par pseudo OU e-mail, sous-chaîne sans casse, identique d'abord ; renvoie le pseudo", async () => {
    const a = await createCustomerWithEmail(null);
    const b = await createCustomerWithEmail("zoe-pseudo@exemple.fr");
    const c = await createCustomerWithEmail(null);
    await prisma.user.update({ where: { id: a.userId }, data: { pseudo: "Zoe" } });
    await prisma.user.update({ where: { id: c.userId }, data: { pseudo: "Zoelie" } });
    const found = await get(customersRoute.GET, "/?q=zoe");
    expect(found.status).toBe(200);
    expect(found.body.items.map((i: { id: string }) => i.id)).toEqual([a.userId, c.userId, b.userId]);
    expect(found.body.items[0]).toMatchObject({ pseudo: "Zoe", email: null });
    expect((await get(customersRoute.GET, "/?q=ZOELIE")).body.items.map((i: { id: string }) => i.id)).toEqual([c.userId]);
  });

  it("un compte local neuf (sans e-mail ni adresse enregistrée) se vend avec l'e-mail et l'adresse saisis par l'admin", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const fresh = await prisma.user.create({ data: { auth_user_id: 987654321n, pseudo: "neuf" } });
    const without = await sale({ userId: fresh.id, batchId, lines: [{}], billingAddress: { fullName: "Neuf Client", line1: "1 rue", postalCode: "69001", city: "Lyon", country: "FR" } });
    expectError(without, 422, "contact_email_required");
    const reply = await sale({ userId: fresh.id, batchId, lines: [{}], contactEmail: "neuf@exemple.fr", billingAddress: { fullName: "Neuf Client", line1: "1 rue", postalCode: "69001", city: "Lyon", country: "FR" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.contactEmail).toBe("neuf@exemple.fr");
  });

  it("l'admin ne crée pas de client : plus de POST sur la route", () => {
    expect("POST" in customersRoute).toBe(false);
  });

  it("réservé au backoffice", async () => {
    await as("4001");
    expectError(await get(customersRoute.GET, "/?q=henri"), 403, "forbidden");
    expectError(await sale({}), 403, "forbidden");
  });
});

describe("POST /api/backoffice/manual-sales", () => {
  it("lot de stock, client avec compte : née payée hors chaîne, prix du lot, machines vendables choisies d'office (les plus anciennes)", async () => {
    const stock = await createStockBatch(catalog);
    const { machines } = await restock(catalog, stock, 3);
    for (const i of [2, 0, 1]) await receiveAndCheck(machines[i].id); // m2 reçue la première
    const walkIn = await createCustomerWithEmail();

    const order = await sold(stock, walkIn, {
      lines: [{ choices: [{ optionId: catalog.optionId, optionValueId: catalog.silentId }] }, {}],
      means: "bank_transfer",
      reference: "VIR-2026-117",
    });
    expect(order).toMatchObject({
      status: "paid",
      channel: "manual",
      paymentMethod: "offchain",
      totalAmount: String(2n * RESALE + SILENT_PRICE),
      refundAddress: null,
      contactEmail: "client@exemple.fr", // celui du profil
      payment: {
        method: "offchain",
        address: null,
        expectedSats: null,
        receivedSats: "0",
        receivedCents: String(2n * RESALE + SILENT_PRICE),
        refundedCents: "0",
        underReviewSats: "0",
      },
      payments: [
        {
          method: "offchain",
          amountCents: String(2n * RESALE + SILENT_PRICE),
          offchainMeans: "bank_transfer",
          offchainMeansLabel: "Virement",
          reference: "VIR-2026-117",
          recordedBy: ADMIN,
          amountSats: null,
          txid: null,
          vout: null,
        },
      ],
      user: { id: walkIn.userId, authUserId: expect.any(String) },
      manualSale: { createdBy: ADMIN, reason: "Vente au comptoir" },
      attention: null,
      cancelLineCauses: [
        { cause: "shop_stock", networkFeePayer: "shop" },
        { cause: "shop_defective_machine", networkFeePayer: "shop" },
        { cause: "admin_other", networkFeePayer: "shop" },
      ],
      refundableAmount: String(2n * RESALE + SILENT_PRICE),
      actions: { canCancel: false, canRenounce: false, canEditRefundAddress: false, canRequestRefund: false },
    });
    expect(order.lines.map((l: { amount: string }) => l.amount)).toEqual([String(RESALE + SILENT_PRICE), String(RESALE)]);
    expect((await linesOf(order.id)).map((l) => l.machine_id)).toEqual([machines[2].id, machines[0].id]);
  });

  it("client avec compte sur une palette en précommande : son utilisateur, e-mail fourni, aucune machine ; il voit sa commande", async () => {
    const lot = await createBatch(catalog, { quantity: 2 });
    const alice = await createUser();
    const order = await sold(lot, alice, { contactEmail: "alice@exemple.fr", reason: "Commande par téléphone", means: "other", reference: "Chèque n° 12" });
    expect(order).toMatchObject({
      status: "paid",
      kind: "preorder",
      contactEmail: "alice@exemple.fr",
      manualSale: { reason: "Commande par téléphone" },
      payments: [{ offchainMeans: "other", reference: "Chèque n° 12" }],
    });
    expect((await linesOf(order.id)).map((l) => l.machine_id)).toEqual([null]);
    // Profil inchangé (la vente ne mémorise pas l'e-mail)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } })).email).toBeNull();

    await as((await authUserIdOf(prisma, alice.userId)).toString());
    const own = await get(orderRoute.GET, "/", { orderId: order.id });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ channel: "manual", paymentMethod: "offchain", payment: { address: null } });
    expect(own.body).not.toHaveProperty("manualSale");
    expect(own.body.payments[0]).not.toHaveProperty("recordedBy");
    expectError(await post(renounceRoute.POST, {}, { orderId: order.id }), 409, "order_renounce_closed");
  });

  it("machines données : attribuées dans la même transaction ; machine dégradée ou d'un autre lot refusée, rien n'est écrit", async () => {
    const { stock, machines } = await stockWith(2);
    const { machines: [degraded] } = await restock(catalog, stock, 1);
    await receiveAndCheck(degraded.id, "degraded");
    const walkIn = await createCustomerWithEmail();
    const base = { userId: walkIn.userId, batchId: stock, billingAddress: { addressId: walkIn.addressId } };

    expectError(await sale({ ...base, lines: [{}], machineIds: [degraded.id] }), 409, "machine_not_assignable");
    expectError(await sale({ ...base, lines: [{}, {}], machineIds: [machines[0].id] }), 400, "invalid_input");
    expectError(await sale({ ...base, lines: [{}, {}], machineIds: [machines[0].id, machines[0].id] }), 400, "invalid_input");
    expect(await prisma.order.count()).toBe(0);

    // Sur un lot de stock, un `null` est complété d'office par une machine vendable (R4b, lot 2).
    const order = await sold(stock, walkIn, { lines: [{}, {}], machineIds: [null, machines[1].id] });
    const attributed = (await linesOf(order.id)).map((l) => l.machine_id);
    expect(attributed).toContain(machines[1].id);
    expect(attributed.every((id) => id !== null)).toBe(true);
    expect(new Set(attributed).size).toBe(2);
  });

  it("refus de la boutique, formulés pour l'admin : stock manquant, lot de stock en pause, facture en attente du client", async () => {
    const { stock } = await stockWith(1);
    const walkIn = await createCustomerWithEmail();
    const base = { userId: walkIn.userId, batchId: stock, billingAddress: { addressId: walkIn.addressId } };

    const short = await sale({ ...base, lines: [{}, {}] });
    expectError(short, 409, "out_of_stock");
    expect(short.body.error).toMatchObject({ message: "Il ne reste que 1 machine sur ce lot : la vente en compte 2.", details: { available: 1 } });

    const alice = await createUser();
    await placeOrder({ catalog, batchId: stock, customer: alice });
    expectError(await sale({ ...base, userId: alice.userId, billingAddress: { addressId: alice.addressId }, lines: [{}], contactEmail: "a@exemple.fr" }), 409, "order_already_pending");
    expectError(await sale({ ...base, lines: [{}] }), 409, "out_of_stock"); // la facture en attente réserve la machine

    const paused = await createStockBatch(await createCatalog("S21"), { status: "draft" });
    const reply = await sale({ ...base, batchId: paused, lines: [{}] });
    expectError(reply, 409, "batch_not_open");
    expect(reply.body.error.message).toBe("Ce lot de stock est en pause : remettez-le en vente pour y vendre.");
    expect(await prisma.order.count({ where: { channel: "manual" } })).toBe(0);
  });

  it("client bloqué : l'API donne le blocage, l'admin le lève (tracé) puis la vente passe", async () => {
    await setShopSettings({ abandoned_order_limit: 1, abandoned_order_cooldown_minutes: 0 });
    const { stock } = await stockWith(1);
    const alice = await createUser();
    await cancelOrder(prisma, await placeOrder({ catalog, batchId: stock, customer: alice }));

    const body = { userId: alice.userId, batchId: stock, lines: [{}], billingAddress: { addressId: alice.addressId }, contactEmail: "a@exemple.fr" };
    const blocked = await sale(body);
    expectError(blocked, 409, "order_creation_blocked");
    expect(blocked.body.error.details).toMatchObject({ userId: alice.userId, batchId: stock, blockEndsAt: expect.any(String) });
    expect(blocked.body.error.message).toMatch(/^Ce client est bloqué sur ce lot jusqu'au .* levez le blocage/);

    const { userId, batchId } = blocked.body.error.details;
    const release = await post(blockReleasesRoute.POST, { userId, batchId, reason: "Vente au comptoir" });
    expect(release.status).toBe(201);
    expect((await sale(body)).status).toBe(201);
  });

  it("entrées : jamais de prix du client ; référence obligatoire pour « autre » ; client, lot, adresse inconnus", async () => {
    const { stock } = await stockWith(1);
    const walkIn = await createCustomerWithEmail();
    const base = { userId: walkIn.userId, batchId: stock, lines: [{}], billingAddress: { addressId: walkIn.addressId } };
    expectError(await sale({ ...base, amount: "1" }), 400, "invalid_input");
    expectError(await sale({ ...base, lines: [{ amount: "1" }] }), 400, "invalid_input");
    const other = await sale({ ...base, means: "other" });
    expectError(other, 400, "invalid_input");
    expect(other.body.error.issues).toEqual([{ path: "reference", message: expect.stringContaining("autre") }]);
    expectError(await sale({ ...base, means: "card" }), 400, "invalid_input");
    expectError(await sale({ ...base, userId: crypto.randomUUID() }), 422, "unknown_user");
    expectError(await sale({ ...base, batchId: crypto.randomUUID() }), 404, "batch_not_found");
    const alice = await createUser();
    expectError(await sale({ ...base, billingAddress: { addressId: alice.addressId } }), 422, "unknown_address");
    const silent = await createCustomerWithEmail(null);
    expectError(await sale({ ...base, userId: silent.userId, billingAddress: { addressId: silent.addressId } }), 422, "contact_email_required");
    expect(await prisma.order.count()).toBe(0);
  });
});

describe("remboursement d'une vente hors chaîne, de bout en bout", () => {
  it("annulation d'une machine, rabais, envoi avec référence, « À traiter » et « Remboursements », puis annulation du reste", async () => {
    const { stock } = await stockWith(2);
    const walkIn = await createCustomerWithEmail();
    const order = await sold(stock, walkIn, { lines: [{ choices: [{ optionId: catalog.optionId, optionValueId: catalog.silentId }] }, {}] });
    const [first, second] = await linesOf(order.id);
    const orderId = order.id;
    const cancel = (body: object) => post(cancelLinesRoute.POST, { reason: "Machine reprise", ...body }, { orderId });

    // Motifs et adresse propres à la chaîne refusés
    expectError(await cancel({ lineIds: [first.id], cause: "user_renounce" }), 422, "refund_cause_not_allowed");
    expectError(await cancel({ lineIds: [first.id], destinationAddress: REFUND_ADDRESS }), 422, "refund_address_offchain");

    const cancelled = await cancel({ lineIds: [first.id], cause: "shop_defective_machine" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: "paid",
      payment: { refundedCents: String(RESALE + SILENT_PRICE) },
      refundableAmount: String(RESALE),
      attention: { reason: "offchain_refund_unsent", canAccept: false, canRefund: false, refundCauses: [], canDismiss: false },
      refunds: [
        {
          method: "offchain",
          kind: "cancellation",
          cause: "shop_defective_machine",
          initiatedBy: "admin",
          amount: String(RESALE + SILENT_PRICE),
          amountSats: null,
          networkFeeSats: null,
          networkFeePayer: "shop",
          destinationAddress: null,
          sentAt: null,
          createdBy: ADMIN,
        },
      ],
    });

    // « À traiter » et « Remboursements »
    const attention = await get(attentionRoute.GET);
    expect(attention.body.items).toEqual([
      expect.objectContaining({
        orderId,
        channel: "manual",
        paymentMethod: "offchain",
        user: { id: walkIn.userId, authUserId: expect.any(String) },
        expectedSats: null,
        receivedCents: String(2n * RESALE + SILENT_PRICE),
        refundedCents: String(RESALE + SILENT_PRICE),
        attention: expect.objectContaining({ reason: "offchain_refund_unsent" }),
      }),
    ]);
    const toSend = await get(toSendRoute.GET);
    const refundId = cancelled.body.refunds[0].id;
    expect(toSend.body.items).toEqual([
      expect.objectContaining({
        refundId,
        method: "offchain",
        amount: String(RESALE + SILENT_PRICE),
        amountSats: null,
        networkFeeSats: null,
        destinationAddress: null,
        addressMissing: false,
        user: { id: walkIn.userId, authUserId: expect.any(String) },
      }),
    ]);

    // Ni remboursement Bitcoin, ni adresse, ni classement sans suite
    expectError(await post(boRefundRoute.POST, { reason: "x", cause: "admin_other" }, { orderId }), 409, "order_nothing_to_refund");
    expectError(await call(boRefundAddressRoute.PATCH, { body: { refundAddress: REFUND_ADDRESS }, params: { orderId }, method: "PATCH", headers: SAME_ORIGIN }), 422, "refund_address_offchain");
    expectError(await post(dismissRoute.POST, {}, { orderId }), 409, "nothing_to_dismiss");

    // Envoi : référence obligatoire, pas d'adresse
    const send = (body: object) => post(sendRoute.POST, body, { refundId });
    expectError(await send({ reference: "  " }), 400, "invalid_input");
    expectError(await send({ reference: "Espèces", destinationAddress: REFUND_ADDRESS }), 422, "refund_address_offchain");
    const sent = await send({ reference: "Espèces rendues, reçu 43" });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ attention: null, refunds: [{ reference: "Espèces rendues, reçu 43", sentBy: ADMIN, destinationAddress: null }] });
    expect(sent.body.refunds[0].sentAt).not.toBeNull();
    expect((await send({ reference: "Espèces rendues, reçu 43" })).status).toBe(200); // rejoué à l'identique
    expectError(await send({ reference: "autre" }), 409, "refund_already_sent");
    expect((await get(attentionRoute.GET)).body.items).toEqual([]);
    expect((await get(toSendRoute.GET)).body.items).toEqual([]);

    // Rabais : strictement moins que ce qui reste payé
    const discount = (amount: string) => post(discountRoute.POST, { amount, reason: "Rayure sur le capot" }, { orderId });
    expectError(await discount(String(RESALE)), 422, "discount_too_large");
    expectError(await discount("0"), 400, "invalid_input");
    const discounted = await discount("10000");
    expect(discounted.status).toBe(200);
    expect(discounted.body).toMatchObject({
      status: "paid",
      refundableAmount: String(RESALE - 10_000n),
      attention: { reason: "offchain_refund_unsent" },
    });
    expect(discounted.body.refunds[1]).toMatchObject({ method: "offchain", kind: "discount", cause: "discount", amount: "10000", amountSats: null });

    // Le reste : la commande est remboursée en entier, la dernière annulation rend ce qui reste
    const rest = await cancel({});
    expect(rest.status).toBe(200);
    expect(rest.body).toMatchObject({ status: "refunded", refundableAmount: "0", cancelLineCauses: [], payment: { refundedCents: String(2n * RESALE + SILENT_PRICE) } });
    expect(rest.body.refunds[2]).toMatchObject({ kind: "cancellation", cause: "admin_other", amount: String(RESALE - 10_000n) });
    expect((await linesOf(orderId)).map((l) => [l.id, l.refund_id !== null])).toEqual([[first.id, true], [second.id, true]]);
    expect((await get(toSendRoute.GET)).body.items.map((i: { amount: string }) => i.amount)).toEqual(["10000", String(RESALE - 10_000n)]);
    expectError(await cancel({}), 409, "order_not_paid");
  });

  it("« À traiter » : chaque facture signalée par la base a un motif côté serveur, et inversement", async () => {
    const { stock } = await stockWith(2);
    const walkIn = await createCustomerWithEmail();
    const sentOff = await sold(stock, walkIn);
    const unsent = await sold(stock, walkIn);
    await post(cancelLinesRoute.POST, { reason: "x" }, { orderId: sentOff.id });
    await post(sendRoute.POST, { reference: "Virement 7" }, { refundId: (await prisma.refund.findFirstOrThrow({ where: { order_id: sentOff.id } })).id });
    await post(cancelLinesRoute.POST, { reason: "x" }, { orderId: unsent.id });

    const ids = (await prisma.order.findMany({ select: { id: true } })).map((o) => o.id);
    const balances = await loadBalances(prisma, ids);
    for (const [id, b] of balances) expect(attentionOf(b) !== null, id).toBe(b.needsAdminAttention);
    expect((await get(attentionRoute.GET)).body.items.map((i: { orderId: string }) => i.orderId)).toEqual([unsent.id]);
  });

  it("machine morte sans remplaçante sur un stock plein : la vente manuelle est remboursée en euros (confirmation)", async () => {
    const { stock, machines } = await stockWith(1);
    const walkIn = await createCustomerWithEmail();
    const order = await sold(stock, walkIn);
    const [line] = await linesOf(order.id);
    expect(line.machine_id).toBe(machines[0].id);
    await changeMachine(prisma, machines[0].id, { functional: "faulty" }, "Ne démarre plus");

    const body = { expectedMachineId: machines[0].id, reason: "Machine tombée en panne" };
    const shortage = await post(replacementRoute.POST, body, { lineId: line.id });
    expectError(shortage, 409, "machine_shortage");
    expect(shortage.body.error.details.refunds).toEqual([expect.objectContaining({ lineId: line.id, orderId: order.id, amount: String(RESALE) })]);
    const confirmed = await post(replacementRoute.POST, { ...body, confirmRefunds: [line.id] }, { lineId: line.id });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);

    const refunded = await get(boOrderRoute.GET, "/", { orderId: order.id });
    expect(refunded.body).toMatchObject({
      status: "refunded",
      refunds: [{ method: "offchain", cause: "shop_defective_machine", amount: String(RESALE), amountSats: null, networkFeeSats: null }],
      attention: { reason: "offchain_refund_unsent" },
    });
  });

  it("une facture Bitcoin : envoi sans adresse refusé ; rabais au prorata des sats, frais boutique", async () => {
    const { stock } = await stockWith(1);
    const alice = await createUser();
    const online = await placeOrder({ catalog, batchId: stock, customer: alice });
    await pay(online);
    const discounted = await post(discountRoute.POST, { amount: "5000", reason: "Geste commercial" }, { orderId: online });
    expect(discounted.status).toBe(200);
    expect(discounted.body.refunds).toEqual([
      expect.objectContaining({ method: "bitcoin", kind: "discount", amount: "5000", amountSats: "8000", networkFeePayer: "shop" }),
    ]);
    const refundId = discounted.body.refunds[0].id;
    expectError(await post(sendRoute.POST, { reference: "txid-1" }, { refundId }), 422, "refund_address_missing");
    expect((await post(sendRoute.POST, { reference: "txid-1", destinationAddress: REFUND_ADDRESS }, { refundId })).status).toBe(200);
  });
});

describe("règle partagée TS ↔ SQL", () => {
  it("motifs d'un remboursement hors chaîne : OFFCHAIN_REFUND_CAUSES = ceux qu'accepte Refund_method_check", async () => {
    const { stock } = await stockWith(1);
    const walkIn = await createCustomerWithEmail();
    const orderId = await manualSale({ catalog, batchId: stock, customer: walkIn });
    const [line] = await linesOf(orderId);
    const causes = (await prisma.$queryRaw<{ c: RefundCause }[]>`SELECT unnest(enum_range(NULL::refund_cause))::text AS "c"`).map((r) => r.c);
    const ROLLBACK = new Error("rollback");

    const accepted: RefundCause[] = [];
    for (const cause of causes) {
      const kind: RefundKind = cause === "discount" ? "discount" : cause === "overpayment" ? "overpayment" : "cancellation";
      const attempt = prisma.$transaction(async (tx) => {
        const [{ payer }] = await tx.$queryRaw<{ payer: string }[]>`SELECT "refund_cause_fee_payer"(${cause}::"refund_cause")::text AS "payer"`;
        const refund = await tx.refund.create({
          data: {
            order_id: orderId, kind, cause, amount: { discount: 1_000n, overpayment: 0n, cancellation: RESALE }[kind], initiated_by: "admin",
            created_by_auth_user_id: ADMIN_AUTH_USER_ID, network_fee_payer: payer as "shop" | "user", reason: "x",
          },
        });
        if (kind === "cancellation") await tx.orderLine.update({ where: { id: line.id }, data: { refund_id: refund.id } });
        if (kind === "cancellation") await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        throw ROLLBACK;
      });
      const error = await failureOf(attempt);
      if (error === ROLLBACK) accepted.push(cause);
      else expect(pgFailureOf(error)?.constraint, cause).toBeDefined();
    }
    expect(accepted.sort()).toEqual([...OFFCHAIN_REFUND_CAUSES].sort());
  });
});
