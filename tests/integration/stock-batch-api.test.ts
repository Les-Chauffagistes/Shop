import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as restocksRoute from "@/app/api/backoffice/batches/[batchId]/restocks/route";
import * as batchRoute from "@/app/api/backoffice/batches/[batchId]/route";
import * as transitionsRoute from "@/app/api/backoffice/batches/[batchId]/transitions/route";
import * as machineTransfersRoute from "@/app/api/backoffice/batches/[batchId]/transfers/route";
import * as batchesRoute from "@/app/api/backoffice/batches/route";
import * as machineRoute from "@/app/api/backoffice/machines/[machineId]/route";
import * as paymentsRoute from "@/app/api/internal/payments/route";
import * as renounceRoute from "@/app/api/orders/[orderId]/renounce/route";
import * as eligibilityRoute from "@/app/api/orders/eligibility/route";
import * as ordersRoute from "@/app/api/orders/route";
import * as shopBatchRoute from "@/app/api/shop/batches/[batchId]/route";
import * as shopBatchesRoute from "@/app/api/shop/batches/route";
import * as wishlistsRoute from "@/app/api/wishlists/route";
import { pgFailureOf } from "@/server/errors";
import { assignOrderMachines } from "@/server/machines";
import { prisma } from "./db";
import { TEST_PAYMENT_SECRET } from "./env";
import {
  assignMachine,
  type Catalog,
  changeMachine,
  createBatch,
  createCatalog,
  createStockBatch,
  createUser,
  failureOf,
  machinesOf,
  pay,
  placeOrder,
  receiveAndCheck,
  REFUND_ADDRESS,
  restock,
} from "./fixtures";
import { ADMIN, call, type Reply, SAME_ORIGIN, signIn } from "./http";

// Refonte machines / stock, jalon R2b : lot de stock par l'API (création, transitions par type, champs modifiables,
// réassorts, transferts palette → stock, clôture), boutique publique et tunnel de commande sur un lot de stock.
// Les règles SQL elles-mêmes : stock-pool.test.ts et batch-transition-effects.test.ts.

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

const ALICE = "4001";
const ADDRESS = { fullName: "Alice Martin", line1: "1 rue de la Paix", postalCode: "69001", city: "Lyon", country: "FR" };

type Handler = Parameters<typeof call>[0];

const as = async (authUserId: string | null) => {
  cookieJar.clear();
  if (authUserId) await signIn(cookieJar, authUserId);
};
const post = (handler: Handler, body: object, params: Record<string, string> = {}) =>
  call(handler, { body, params, headers: SAME_ORIGIN });
const getBatch = (batchId: string) => call(batchRoute.GET, { params: { batchId } });
const patch = async (batchId: string, body: object) =>
  call(batchRoute.PATCH, {
    params: { batchId },
    body: { expectedUpdatedAt: (await getBatch(batchId)).body.updatedAt, ...body },
    method: "PATCH",
    headers: SAME_ORIGIN,
  });
const move = (batchId: string, from: string, to: string, note?: string) => post(transitionsRoute.POST, { from, to, note }, { batchId });
const transfer = (batchId: string, machineIds: string[], note?: string) =>
  post(machineTransfersRoute.POST, { machineIds, note }, { batchId });

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({ status, code });
}

let catalog: Catalog;

beforeEach(async () => {
  catalog = await createCatalog();
  await as(ADMIN);
});

/** Lot de stock en vente avec `n` machines réassorties, reçues et contrôlées ok (vendables). */
async function stockWith(n: number, status: "draft" | "on_sale" = "on_sale") {
  const stock = await createStockBatch(catalog, { status });
  const { machines } = await restock(catalog, stock, n);
  for (const m of machines) await receiveAndCheck(m.id);
  return { stock, machines };
}

describe("création d'un lot de stock", () => {
  it("un par modèle, en pause, sans quantité ni prix d'achat, avec ses transitions et ses champs modifiables", async () => {
    const created = await post(batchesRoute.POST, { kind: "stock", modelId: catalog.modelId, resaleUnitPrice: "52000" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: "stock",
      kindLabel: "Stock",
      name: "Stock S19",
      status: "draft",
      statusLabel: "En pause",
      quantity: null,
      purchasePrice: null,
      resaleUnitPrice: "52000",
      editableFields: ["name", "resaleUnitPrice", "optionAvailability", "optionMaxQty", "hiddenOptions"],
      restocks: [],
      transfers: [],
      counters: { capacity: 0, availableStock: 0, sellableMachines: 0, expectedMachines: 0, toCheckMachines: 0 },
    });
    expect(created.body.transitions).toEqual([
      expect.objectContaining({
        to: "on_sale",
        toLabel: "En vente",
        action: "Mettre en vente",
        kind: "forward",
        noteRequired: false,
        allowed: true,
        warnings: [expect.stringMatching(/^Aucune machine n'est disponible/)],
      }),
    ]);
    expect(created.body.history).toEqual([expect.objectContaining({ from: null, to: "draft", changedBy: ADMIN })]);

    const again = await post(batchesRoute.POST, { kind: "stock", modelId: catalog.modelId });
    expectError(again, 409, "stock_batch_exists");
    expect(again.body.error.details).toEqual({ batchId: created.body.id });
  });

  it("créations simultanées du lot de stock d'un modèle : une seule passe, l'autre désigne le lot créé", async () => {
    const replies = await Promise.all([0, 1, 2].map(() => post(batchesRoute.POST, { kind: "stock", modelId: catalog.modelId })));
    const ok = replies.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    for (const r of replies.filter((x) => x.status !== 201)) {
      expectError(r, 409, "stock_batch_exists");
      expect(r.body.error.details.batchId).toBe(ok[0].body.id);
    }
  });

  it("palette : quantité et prix d'achat obligatoires ; lot de stock : refusés ; type inconnu refusé", async () => {
    const wholesale = await post(batchesRoute.POST, { modelId: catalog.modelId });
    expectError(wholesale, 400, "invalid_input");
    expect(wholesale.body.error.issues.map((i: { path: string }) => i.path).sort()).toEqual(["purchasePrice", "quantity"]);

    const stock = await post(batchesRoute.POST, { kind: "stock", modelId: catalog.modelId, quantity: 3, purchasePrice: "1" });
    expectError(stock, 400, "invalid_input");
    expect(stock.body.error.issues).toEqual([
      { path: "quantity", message: expect.stringMatching(/^Un lot de stock n'a ni quantité ni prix d'achat/) },
      { path: "purchasePrice", message: expect.stringMatching(/^Un lot de stock n'a ni quantité ni prix d'achat/) },
    ]);
    expectError(await post(batchesRoute.POST, { kind: "bulk", modelId: catalog.modelId, quantity: 1, purchasePrice: "1" }), 400, "invalid_input");
    expect(await prisma.batch.count()).toBe(0);

    const palette = await post(batchesRoute.POST, { modelId: catalog.modelId, quantity: 4, purchasePrice: "100000" });
    expect(palette.body).toMatchObject({ kind: "wholesale", kindLabel: "Palette", name: "4 S19", quantity: 4, statusLabel: "Brouillon" });
  });

  it("liste filtrée par type, compteurs de statuts du même type", async () => {
    const stock = await createStockBatch(catalog);
    await createBatch(catalog, { quantity: 2, status: "draft" });
    const reply = await call(batchesRoute.GET, { path: "/api/backoffice/batches?kind=stock" });
    expect(reply.body.items.map((b: { id: string }) => b.id)).toEqual([stock]);
    expect(reply.body.statusCounts).toMatchObject({ on_sale: 1, draft: 0 });
    expect((await call(batchesRoute.GET)).body.total).toBe(2);
  });
});

describe("transitions d'un lot de stock", () => {
  it("mise en vente puis pause (sans motif) ; un statut de palette est refusé ; la pause n'est pas l'action principale", async () => {
    const stock = await createStockBatch(catalog, { status: "draft" });
    expectError(await move(stock, "draft", "survey"), 409, "transition_not_allowed");
    const onSale = await move(stock, "draft", "on_sale");
    expect(onSale.status).toBe(201);
    expect(onSale.body).toMatchObject({ status: "on_sale", statusLabel: "En vente" });
    expect(onSale.body.transitions).toEqual([
      expect.objectContaining({ to: "draft", toLabel: "Brouillon", action: "Mettre en pause", kind: "pause", noteRequired: false, allowed: true }),
    ]);
    expectError(await move(stock, "on_sale", "cancelled", "Fin"), 409, "transition_not_allowed");

    const paused = await move(stock, "on_sale", "draft");
    expect(paused.body).toMatchObject({ status: "draft", statusLabel: "En pause" });
  });

  it("mise en vente bloquée sans prix de revente", async () => {
    const created = await post(batchesRoute.POST, { kind: "stock", modelId: catalog.modelId });
    expect(created.body.transitions[0]).toMatchObject({ allowed: false, blockers: ["Renseignez le prix de revente unitaire."] });
    expectError(await move(created.body.id, "draft", "on_sale"), 409, "transition_blocked");
  });

  it("la pause annule les factures en attente sans versement et l'annonce", async () => {
    const { stock } = await stockWith(2);
    const pending = await placeOrder({ catalog, batchId: stock, customer: await createUser() });
    const detail = (await getBatch(stock)).body;
    expect(detail.transitions[0]).toMatchObject({ to: "draft", cancelsPendingOrders: 1 });
    await move(stock, "on_sale", "draft");
    expect(await prisma.order.findUniqueOrThrow({ where: { id: pending } })).toMatchObject({ status: "cancelled", cancel_reason: "batch_closed" });
  });
});

describe("champs modifiables d'un lot de stock", () => {
  it("en vente : nom, prix de revente, options et dérogations ; ni modèle, ni quantité, ni prix d'achat, ni menus masqués", async () => {
    const { stock } = await stockWith(1);
    const ok = await patch(stock, {
      name: "Stock S19 reconditionnées",
      resaleUnitPrice: "48000",
      optionValues: [{ optionValueId: catalog.silentId, priceOverride: "6000", maxQty: 2 }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: "Stock S19 reconditionnées", resaleUnitPrice: "48000", editableFields: ["name", "resaleUnitPrice", "optionAvailability", "optionMaxQty"] });
    expect(ok.body.options[0].values[1]).toMatchObject({ effectivePrice: "6000", maxQty: 2 });

    expectError(await patch(stock, { quantity: 3 }), 422, "stock_batch_no_quantity");
    const other = await createCatalog("S21");
    const model = await patch(stock, { modelId: other.modelId });
    expectError(model, 409, "batch_field_locked");
    expect(model.body.error.message).toBe("Sur un lot de stock en vente, ces champs ne sont pas modifiables : « Modèle ».");
    expectError(await patch(stock, { hiddenOptions: [catalog.optionId] }), 409, "batch_field_locked");
    expectError(await patch(stock, { resaleUnitPrice: null }), 422, "resale_price_required");
  });

  it("en pause : un menu se masque tant qu'aucune commande n'y a de choix", async () => {
    const { stock } = await stockWith(1);
    await move(stock, "on_sale", "draft");
    const hidden = await patch(stock, { hiddenOptions: [catalog.optionId] });
    expect(hidden.status).toBe(200);
    expect(hidden.body.options[0].hidden).toBe(true);
    await patch(stock, { hiddenOptions: [] });
    await move(stock, "draft", "on_sale");

    await pay(await placeOrder({ catalog, batchId: stock, customer: await createUser() }));
    await move(stock, "on_sale", "draft");
    const locked = await patch(stock, { hiddenOptions: [catalog.optionId] });
    expectError(locked, 409, "menu_visibility_locked");
    expect(locked.body.error.message).toMatch(/^Des commandes de ce lot ont déjà un choix dans ce menu/);
  });
});

describe("réassort", () => {
  it("crée les machines attendues, journalise auteur, prix et note ; capacité inchangée tant qu'elles ne sont pas contrôlées", async () => {
    const stock = await createStockBatch(catalog);
    const reply = await post(restocksRoute.POST, { quantity: 3, purchasePrice: "270000", note: "Fournisseur Shenzhen, facture 42" }, { batchId: stock });
    expect(reply.status).toBe(201);
    expect(reply.body.restocks).toEqual([
      {
        id: expect.any(String),
        quantity: 3,
        purchasePrice: "270000",
        note: "Fournisseur Shenzhen, facture 42",
        machines: 3,
        createdBy: ADMIN,
        createdAt: expect.any(String),
      },
    ]);
    expect(reply.body.counters).toMatchObject({ expectedMachines: 3, capacity: 0, availableStock: 0, sellableMachines: 0 });

    const [m] = await machinesOf(stock);
    await changeMachine(prisma, m.id, { logistical: "in_stock" });
    expect((await getBatch(stock)).body.counters).toMatchObject({ expectedMachines: 2, toCheckMachines: 1, capacity: 0 });
    await receiveAndCheck(m.id);
    expect((await getBatch(stock)).body.counters).toMatchObject({ toCheckMachines: 0, capacity: 1, availableStock: 1, sellableMachines: 1 });

    const list = await call(restocksRoute.GET, { params: { batchId: stock } });
    expect(list.body.items).toEqual(reply.body.restocks);
  });

  it("refusé sur une palette ; quantité et prix bornés ; lot inconnu", async () => {
    const palette = await createBatch(catalog, { quantity: 2, status: "draft" });
    expectError(await post(restocksRoute.POST, { quantity: 1, purchasePrice: "0" }, { batchId: palette }), 409, "not_stock_batch");
    const stock = await createStockBatch(catalog);
    expectError(await post(restocksRoute.POST, { quantity: 0, purchasePrice: "1" }, { batchId: stock }), 400, "invalid_input");
    expectError(await post(restocksRoute.POST, { quantity: 1, purchasePrice: 10 }, { batchId: stock }), 400, "invalid_input");
    expectError(await post(restocksRoute.POST, { quantity: 1, purchasePrice: "1" }, { batchId: randomUUID() }), 404, "batch_not_found");
    expect(await prisma.stockRestock.count()).toBe(0);
  });

  it("change updatedAt du lot (un formulaire ouvert avant devient périmé)", async () => {
    const stock = await createStockBatch(catalog);
    const before = (await getBatch(stock)).body.updatedAt;
    await post(restocksRoute.POST, { quantity: 1, purchasePrice: "1" }, { batchId: stock });
    const stale = await call(batchRoute.PATCH, {
      params: { batchId: stock },
      body: { expectedUpdatedAt: before, name: "Autre" },
      method: "PATCH",
      headers: SAME_ORIGIN,
    });
    expectError(stale, 409, "batch_modified");
  });
});

describe("transfert palette → stock", () => {
  /** Palette au Contrôle, ses machines reçues et contrôlées ok ; `sold` commandes payées. */
  async function palette(quantity: number, sold = 0) {
    const lot = await createBatch(catalog, { quantity, status: "inspection" });
    const machines = await machinesOf(lot);
    for (const m of machines) await receiveAndCheck(m.id);
    const lines: string[] = [];
    for (let i = 0; i < sold; i++) {
      const orderId = await placeOrder({ catalog, batchId: lot, customer: await createUser() });
      await pay(orderId);
      lines.push((await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } })).id);
    }
    return { lot, machines, lines };
  }

  it("avant la clôture : invendus au lot de stock (créé en pause s'il n'existe pas), journal et compteurs des deux lots", async () => {
    const { lot, machines } = await palette(3, 1);
    const reply = await transfer(lot, [machines[2].id, machines[1].id], "Invendus, palette bientôt close");
    expect(reply.status).toBe(201);
    const stock = await prisma.batch.findFirstOrThrow({ where: { kind: "stock", model_id: catalog.modelId } });
    expect(stock).toMatchObject({ status: "draft", name: "Stock S19" });
    expect(reply.body.counters).toMatchObject({ transferredOut: 2, capacity: 1, availableStock: 0 });
    expect(reply.body.transfers).toHaveLength(2);
    expect(reply.body.transfers[0]).toMatchObject({
      from: { id: lot, name: "3 S19" },
      to: { id: stock.id, name: "Stock S19" },
      reason: "admin",
      note: "Invendus, palette bientôt close",
      changedBy: ADMIN,
    });
    const stockDetail = (await getBatch(stock.id)).body;
    expect(stockDetail.counters).toMatchObject({ capacity: 2, sellableMachines: 2 });
    expect(stockDetail.transfers.map((t: { machineId: string }) => t.machineId).sort()).toEqual([machines[1].id, machines[2].id].sort());
    expect(stockDetail.history[0]).toMatchObject({ from: null, to: "draft", note: "Créé par un transfert depuis le lot 3 S19" });
  });

  it("refusé s'il laisse la palette sans de quoi servir ses commandes", async () => {
    const { lot, machines } = await palette(2, 1);
    const reply = await transfer(lot, machines.map((m) => m.id));
    expectError(reply, 409, "transfer_exceeds_capacity");
    expect(reply.body.error.details).toEqual({ orderedMachines: 1, capacity: 2 });
    expect(await prisma.machineTransfer.count()).toBe(0);
    expect(await prisma.batch.count({ where: { kind: "stock" } })).toBe(0);
  });

  it("machine d'une commande, machine attendue, machine d'un autre lot, lot de stock : refusés, rien n'est écrit", async () => {
    const { lot, machines, lines } = await palette(3, 1);
    await assignMachine(prisma, lines[0], lot, machines[0].id);
    expectError(await transfer(lot, [machines[0].id]), 409, "machine_assigned");

    const waiting = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [expected] = await machinesOf(waiting);
    expectError(await transfer(waiting, [expected.id]), 409, "machine_not_in_hand");
    expectError(await transfer(lot, [expected.id]), 409, "machine_not_in_batch");
    expectError(await transfer(lot, [randomUUID()]), 409, "machine_not_in_batch");

    const { stock, machines: inStock } = await stockWith(1);
    expectError(await transfer(stock, [inStock[0].id]), 409, "transfer_from_stock");
    expectError(await transfer(lot, []), 400, "invalid_input");
    expectError(await transfer(lot, [machines[1].id, machines[1].id]), 400, "invalid_input");
    expect(await prisma.machineTransfer.count()).toBe(0);
  });
});

describe("clôture d'une palette", () => {
  it("annonce les invendus qui partiront au stock, puis les y transfère (motif batch_closed)", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [sold, unsold] = await machinesOf(lot);
    for (const m of [sold, unsold]) await receiveAndCheck(m.id);
    const orderId = await placeOrder({ catalog, batchId: lot, customer: await createUser() });
    await pay(orderId);
    const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
    await assignMachine(prisma, line.id, lot, sold.id);
    await move(lot, "inspection", "packaging");
    await changeMachine(prisma, sold.id, { logistical: "ready" });
    await changeMachine(prisma, sold.id, { logistical: "in_transit" });
    await move(lot, "packaging", "in_transit");
    await changeMachine(prisma, sold.id, { logistical: "delivered" });

    const close = (await getBatch(lot)).body.transitions.find((t: { to: string }) => t.to === "closed");
    expect(close).toMatchObject({ allowed: true, warnings: ["1 machine invendue partira au lot de stock du modèle (créé en pause s'il n'existe pas)."] });
    const closed = await move(lot, "in_transit", "closed");
    expect(closed.status).toBe(201);
    expect(closed.body.transfers).toEqual([expect.objectContaining({ machineId: unsold.id, reason: "batch_closed", changedBy: ADMIN })]);
    expect(closed.body.counters.transferredOut).toBe(1);
  });
});

describe("boutique et tunnel de commande sur un lot de stock", () => {
  const payOnChain = (address: string, amountSats: string) =>
    call(paymentsRoute.POST, {
      body: { address, txid: randomUUID(), vout: 0, amountSats },
      headers: { authorization: `Bearer ${TEST_PAYMENT_SECRET}` },
    });
  const order = (batchId: string, lines: object[] = [{}]) =>
    post(ordersRoute.POST, { batchId, lines, billingAddress: ADDRESS, contactEmail: "alice@exemple.fr", refundAddress: REFUND_ADDRESS });

  it("fiche publique « En stock » : disponible = machines vendables, ni priorité ni manifestation d'intérêt", async () => {
    const { stock, machines } = await stockWith(2);
    await receiveAndCheck((await restock(catalog, stock, 1)).machines[0].id, "degraded");
    await changeMachine(prisma, machines[1].id, { logistical: "ready" }); // en main : toujours vendable
    await as(null);
    const list = await call(shopBatchesRoute.GET);
    expect(list.body.items).toEqual([
      expect.objectContaining({ id: stock, kind: "stock", status: "on_sale", statusLabel: "En stock", availableQuantity: 2, acceptsOrders: true, priorityEndsAt: null }),
    ]);
    const page = await call(shopBatchRoute.GET, { params: { batchId: stock } });
    expect(page.body).toMatchObject({ kind: "stock", statusLabel: "En stock", wishlistLimit: 0, maxMachinesPerOrder: 10 });

    await as(ALICE);
    const wish = await post(wishlistsRoute.POST, { batchId: stock });
    expectError(wish, 409, "wishlist_closed");
    expect(wish.body.error.message).toBe("Ce lot est en stock : il se commande directement, sans manifestation d'intérêt.");
  });

  it("commande, paiement, attribution d'une machine vendable ; stock épuisé ensuite ; pas de renoncement en ligne", async () => {
    const { stock, machines } = await stockWith(1);
    await as(ALICE);
    const eligibility = await call(eligibilityRoute.GET, { path: `/api/orders/eligibility?batchId=${stock}` });
    expect(eligibility.body).toMatchObject({ batchKind: "stock", acceptsOrders: true, availableQuantity: 1, priorityEndsAt: null, refusal: null });

    const tooMany = await order(stock, [{}, {}]);
    expectError(tooMany, 409, "out_of_stock");
    expect(tooMany.body.error.message).toBe("Il ne reste que 1 machine en stock : vous en demandez 2.");

    const created = await order(stock, [{ choices: [{ optionId: catalog.optionId, optionValueId: catalog.silentId }] }]);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: "order",
      kindLabel: "Commande",
      status: "pending_payment",
      totalAmount: "57500",
      batch: { id: stock, kind: "stock", status: "on_sale", statusLabel: "En vente", acceptsOrders: true },
    });
    const paid = await payOnChain(created.body.payment.address, created.body.payment.expectedSats);
    expect(paid.status).toBe(201);
    const orderRow = await prisma.order.findUniqueOrThrow({ where: { id: created.body.id }, include: { lines: true } });
    expect(orderRow.status).toBe("paid");

    // Encaissement : la machine vendable libre est attribuée d'office, journal sans auteur (NULL = système)
    expect(orderRow.lines[0].machine_id).toBe(machines[0].id);
    const journal = await prisma.orderLineAssignment.findMany({ where: { order_line_id: orderRow.lines[0].id } });
    expect(journal).toEqual([expect.objectContaining({ machine_id: machines[0].id, changed_by_auth_user_id: null })]);
    await as(ADMIN);
    const detail = await call(machineRoute.GET, { params: { machineId: machines[0].id } });
    expect(detail.body.assignments).toEqual([expect.objectContaining({ machineId: machines[0].id, changedBy: null })]);
    const bob = await createUser();
    expect(pgFailureOf(await failureOf(placeOrder({ catalog, batchId: stock, customer: bob })))?.constraint).toBe("Batch_stock");
    expect((await getBatchAs(stock)).counters).toMatchObject({ capacity: 1, paidMachines: 1, availableStock: 0, sellableMachines: 0 });

    await as(ALICE);
    const renounce = await post(renounceRoute.POST, {}, { orderId: created.body.id });
    expectError(renounce, 409, "order_renounce_closed");
    expect(renounce.body.error.message).toBe("Une commande de machines en stock ne s'annule pas en ligne : contactez-nous.");
  });

  it("palette : le paiement n'attribue aucune machine (attribution au Contrôle)", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    await as(ALICE);
    const created = await order(batchId);
    expect(created.status).toBe(201);
    expect((await payOnChain(created.body.payment.address, created.body.payment.expectedSats)).status).toBe(201);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: created.body.id }, include: { lines: true } });
    expect(row.status).toBe("paid");
    expect(row.lines[0].machine_id).toBeNull();
    expect(await prisma.orderLineAssignment.count({ where: { order_line_id: row.lines[0].id } })).toBe(0);
  });

  it("attribution automatique rejouée : rien à attribuer, aucune erreur, journal inchangé ; aucune machine libre n'est possible sous Batch_stock", async () => {
    const { stock, machines } = await stockWith(1);
    await as(ALICE);
    const created = await order(stock);
    expect((await payOnChain(created.body.payment.address, created.body.payment.expectedSats)).status).toBe(201);
    const line = (await prisma.order.findUniqueOrThrow({ where: { id: created.body.id }, include: { lines: true } })).lines[0];
    expect(line.machine_id).toBe(machines[0].id);
    expect(await prisma.$transaction((tx) => assignOrderMachines(tx, created.body.id, null))).toBe(0);
    expect(await prisma.orderLineAssignment.count({ where: { order_line_id: line.id } })).toBe(1);
    // Une ligne payée sans machine libre dépasserait la capacité du lot : Batch_stock l'interdit
    await expect(assignMachine(prisma, line.id, stock, null, "test").then(() => changeMachine(prisma, machines[0].id, { functional: "degraded" }, "test"))).rejects.toBeDefined();
  });

  it("renoncement de l'utilisateur refusé sur un lot de stock, en vente comme en pause (API et base) ; palette inchangée", async () => {
    // Règle unique en base : palette au plus en Précommande, jamais un lot de stock
    const statuses = ["draft", "survey", "preorder", "ordering", "on_sale", "closed"];
    const window = await prisma.$queryRaw<{ kind: string; st: string }[]>`
      SELECT k::text AS "kind", st::text AS "st"
      FROM unnest(${["wholesale", "stock"]}::batch_kind[]) k, unnest(${statuses}::batch_status[]) st
      WHERE "batch_allows_user_renunciation"(k, st) ORDER BY 1, 2`;
    expect(window).toEqual([
      { kind: "wholesale", st: "draft" },
      { kind: "wholesale", st: "preorder" },
      { kind: "wholesale", st: "survey" },
    ]);

    const { stock } = await stockWith(2);
    await as(ALICE);
    const created = await order(stock);
    await payOnChain(created.body.payment.address, created.body.payment.expectedSats);
    const orderId: string = created.body.id;
    for (const paused of [false, true]) {
      if (paused) {
        await as(ADMIN);
        await move(stock, "on_sale", "draft");
        await as(ALICE);
      }
      expect(await renounceAllowed(orderId)).toBe(false);
      const reply = await post(renounceRoute.POST, {}, { orderId });
      expectError(reply, 409, "order_renounce_closed");
      expect(reply.body.error.message).toBe("Une commande de machines en stock ne s'annule pas en ligne : contactez-nous.");
      // La base refuse aussi, sans passer par le domaine
      expect(pgFailureOf(await failureOf(writeUserRenounce(orderId)))?.constraint).toBe("Refund_user_renounce_window");
    }
    expect(await prisma.refund.count()).toBe(0);

    // Palette en Précommande : l'utilisateur renonce lui-même, comme avant
    const palette = await createBatch(catalog, { quantity: 2 });
    const paletteOrder = await placeOrder({ catalog, batchId: palette, customer: await createUser(), lines: [false, false] });
    await pay(paletteOrder);
    expect(await renounceAllowed(paletteOrder)).toBe(true);
    await writeUserRenounce(paletteOrder);
    expect(await prisma.refund.count({ where: { order_id: paletteOrder, cause: "user_renounce", initiated_by: "user" } })).toBe(1);
  });

  it("lot de stock en pause : plus de fiche ni de commande", async () => {
    const { stock } = await stockWith(1, "draft");
    await as(null);
    expectError(await call(shopBatchRoute.GET, { params: { batchId: stock } }), 404, "batch_not_found");
    await as(ALICE);
    expectError(await order(stock), 404, "batch_not_found");
  });
});

/** La vue de solde autorise-t-elle l'utilisateur à renoncer à cette facture ? */
async function renounceAllowed(orderId: string) {
  const [row] = await prisma.$queryRaw<{ allowed: boolean }[]>`
    SELECT "user_renounce_allowed" AS "allowed" FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row.allowed;
}

/** Renoncement écrit directement en base au nom de l'utilisateur (première ligne, au prorata, frais boutique). */
function writeUserRenounce(orderId: string) {
  return prisma.$transaction(async (tx) => {
    const line = await tx.orderLine.findFirstOrThrow({ where: { order_id: orderId }, orderBy: { position: "asc" } });
    const [{ sats }] = await tx.$queryRaw<{ sats: bigint }[]>`SELECT "refund_prorata_sats"(${orderId}::uuid, ${line.amount}) AS "sats"`;
    const refund = await tx.refund.create({
      data: {
        order_id: orderId,
        kind: "cancellation",
        cause: "user_renounce",
        initiated_by: "user",
        network_fee_payer: "shop",
        network_fee_sats: 300n,
        amount: line.amount,
        amount_sats: sats,
        reason: "Renoncement",
      },
    });
    await tx.orderLine.update({ where: { id: line.id }, data: { refund_id: refund.id } });
  });
}

/** Détail backoffice d'un lot, quel que soit l'utilisateur courant (repasse en admin). */
async function getBatchAs(batchId: string) {
  await as(ADMIN);
  return (await getBatch(batchId)).body;
}
