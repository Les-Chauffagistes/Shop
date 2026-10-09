import { beforeEach, describe, expect, it, vi } from "vitest";
import * as partNeedsRoute from "@/app/api/backoffice/batches/[batchId]/part-needs/route";
import * as partOrdersRoute from "@/app/api/backoffice/batches/[batchId]/part-orders/route";
import * as partOrderRoute from "@/app/api/backoffice/part-orders/[orderId]/route";
import * as partStockRoute from "@/app/api/backoffice/part-stock/route";
import * as movementsRoute from "@/app/api/backoffice/parts/[partId]/movements/route";
import { prisma } from "./db";
import { type Catalog, createBatch, createCatalog, createUser, pay, placeOrder, SILENT_PRICE, wish } from "./fixtures";
import { ADMIN, call, type Reply, signIn } from "./http";

// Stock des produits d'options (schéma v4) : journal de mouvements, commandes de produits par
// lot (livraison = statut + réception), besoin par lot et pression par produit (vues SQL).

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

let catalog: Catalog;
let partId: string;

beforeEach(async () => {
  cookieJar.clear();
  await signIn(cookieJar, ADMIN);
  catalog = await createCatalog();
  // Le Silent kit du catalogue est un produit d'option : un kit par machine
  partId = (await prisma.part.create({ data: { name: "Kit silencieux", reference: "SK-01" } })).id;
  await prisma.optionValuePart.create({ data: { option_value_id: catalog.silentId, part_id: partId } });
});

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({ status, code });
}

const movement = (body: object, id = partId) => call(movementsRoute.POST, { params: { partId: id }, body });
const stockOverview = async () => (await call(partStockRoute.GET)).body.items;
const orderPart = (batchId: string, body: object) => call(partOrdersRoute.POST, { params: { batchId }, body });
const patchOrder = (orderId: string, body: object) => call(partOrderRoute.PATCH, { params: { orderId }, body, method: "PATCH" });

describe("journal de stock", () => {
  it("réception, correction motivée, kit monté ; le stock ne devient jamais négatif", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "inspection" });

    const reception = await movement({ kind: "reception", quantity: 10, note: "Réassort" });
    expect(reception.status).toBe(201);
    expect(reception.body).toMatchObject({ movement: { kind: "reception", qty: 10, createdBy: ADMIN }, stock: { onHand: 10 } });

    expectError(await movement({ kind: "adjustment", quantity: -2 }), 400, "invalid_input");
    expect((await movement({ kind: "adjustment", quantity: -2, note: "Casse" })).body.stock.onHand).toBe(8);

    const mounted = await movement({ kind: "kit_mounted", quantity: 3, batchId });
    expect(mounted.body).toMatchObject({ movement: { kind: "kit_mounted", qty: -3, batch: { id: batchId } }, stock: { onHand: 5 } });
    expectError(await movement({ kind: "kit_mounted", quantity: 6, batchId }), 409, "part_stock_insufficient");

    const other = await createCatalog("S21");
    const otherBatch = await createBatch(other, { quantity: 1, status: "draft" });
    expectError(await movement({ kind: "kit_mounted", quantity: 1, batchId: otherBatch }), 422, "part_not_for_model");

    const journal = await call(movementsRoute.GET, { params: { partId } });
    expect(journal.body.items.map((m: { qty: number }) => m.qty)).toEqual([-3, -2, 10]);
    expect(journal.body.stock.onHand).toBe(5);
    expectError(await movement({ kind: "reception", quantity: 1 }, "00000000-0000-4000-8000-000000000000"), 404, "part_not_found");
  });
});

describe("commandes de produits d'un lot", () => {
  it("commande, attente, livraison = statut + réception au stock dans une transaction", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "ordering" });
    const created = await orderPart(batchId, { partId, qty: 8 });
    expect(created).toMatchObject({ status: 201, body: { qty: 8, status: "ordering", statusLabel: "Commande en cours", receivedQty: null } });
    expectError(await orderPart(batchId, { partId, qty: 1 }), 409, "part_order_exists");
    const orderId = created.body.id;

    expect((await patchOrder(orderId, { status: "awaiting_delivery", qty: 9 })).body).toMatchObject({ status: "awaiting_delivery", qty: 9 });
    expect((await stockOverview())[0]).toMatchObject({ onHand: 0, orderingQty: 0, awaitingDeliveryQty: 9 });
    expectError(await patchOrder(orderId, { receivedQty: 3 }), 400, "invalid_input");

    const delivered = await patchOrder(orderId, { status: "delivered", receivedQty: 7, note: "2 kits manquants" });
    expect(delivered.body).toMatchObject({ status: "delivered", qty: 9, receivedQty: 7, deliveredAt: expect.any(String) });
    expect((await stockOverview())[0]).toMatchObject({ onHand: 7, awaitingDeliveryQty: 0 });

    expectError(await patchOrder(orderId, { qty: 10 }), 409, "part_order_frozen");
    expectError(await patchOrder(orderId, { status: "awaiting_delivery" }), 409, "part_order_status_invalid");
    expect(await prisma.partStockMovement.count({ where: { batch_part_order_id: orderId } })).toBe(1);
  });

  it("réception partielle : deliveredQty du besoin = kits reçus, pas la quantité commandée", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "ordering" });
    const orderId = (await orderPart(batchId, { partId, qty: 6 })).body.id;
    const deliveredQty = async () =>
      (await call(partNeedsRoute.GET, { params: { batchId } })).body.parts[0] as { orderedQty: number; deliveredQty: number };
    expect(await deliveredQty()).toMatchObject({ orderedQty: 6, deliveredQty: 0 });
    await patchOrder(orderId, { status: "delivered", receivedQty: 3 });
    expect(await deliveredQty()).toMatchObject({ orderedQty: 0, deliveredQty: 3 });
    // Rejouer la livraison à l'identique ne change rien (une seule réception)
    expect((await patchOrder(orderId, { status: "delivered", receivedQty: 3 })).status).toBe(200);
    expect((await patchOrder(orderId, { status: "delivered" })).status).toBe(200);
    // Avec une autre quantité : refus explicite, la correction passe par l'inventaire
    const other = await patchOrder(orderId, { status: "delivered", receivedQty: 6 });
    expectError(other, 409, "part_order_already_delivered");
    expect(other.body.error.message).toBe(
      "Cette commande est déjà livrée avec 3 kit(s) reçu(s) : la quantité reçue ne change plus. Pour corriger le stock, enregistrez une correction d'inventaire sur le produit.",
    );
    expect(await deliveredQty()).toMatchObject({ deliveredQty: 3 });
    expect(await prisma.partStockMovement.count({ where: { batch_part_order_id: orderId } })).toBe(1);
    expect((await stockOverview())[0].onHand).toBe(3);
  });

  it("deux livraisons simultanées : une seule réception enregistrée", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "ordering" });
    const orderId = (await orderPart(batchId, { partId, qty: 4 })).body.id;
    const replies = await Promise.all([patchOrder(orderId, { status: "delivered" }), patchOrder(orderId, { status: "delivered" })]);
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.partStockMovement.count({ where: { batch_part_order_id: orderId } })).toBe(1);
    expect((await stockOverview())[0].onHand).toBe(4);
  });

  it("refusée pour un lot annulé ou un produit inconnu", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "draft" });
    expectError(await orderPart(batchId, { partId: "00000000-0000-4000-8000-000000000000", qty: 1 }), 422, "unknown_part");
    await prisma.batchStatusTransition.create({
      data: { batch_id: batchId, from_status: "draft", to_status: "cancelled", changed_by_auth_user_id: 1n, note: "x" },
    });
    expectError(await orderPart(batchId, { partId, qty: 1 }), 409, "batch_finished");
  });
});

describe("besoin par lot et pression par produit", () => {
  it("10 kits, deux lots qui en demandent 8 : pression 1,6, manque 6 ; wishlists à part", async () => {
    await movement({ kind: "reception", quantity: 10 });
    const lots: string[] = [];
    for (let i = 0; i < 2; i++) {
      const batchId = await createBatch(catalog, { quantity: 10 });
      await pay(await placeOrder({ catalog, batchId, customer: await createUser(), lines: Array(8).fill(true) }));
      lots.push(batchId);
    }
    const surveyBatch = await createBatch(catalog, { quantity: 3, status: "survey" });
    await wish(catalog, surveyBatch, await createUser(), [{ optionId: catalog.optionId, valueId: catalog.silentId, price: SILENT_PRICE }]);

    expect(await stockOverview()).toEqual([
      {
        partId,
        name: "Kit silencieux",
        reference: "SK-01",
        onHand: 10,
        orderingQty: 0,
        awaitingDeliveryQty: 0,
        firmDemand: 16,
        potentialDemand: 1,
        pressure: "1.600",
        overPressure: true,
        shortfall: 6,
        toOrder: 6,
      },
    ]);

    await orderPart(lots[0], { partId, qty: 4 });
    const needs = await call(partNeedsRoute.GET, { params: { batchId: lots[0] } });
    expect(needs.body.parts).toEqual([
      expect.objectContaining({
        partId,
        name: "Kit silencieux",
        firmQty: 8,
        potentialQty: 0,
        mountedQty: 0,
        remainingQty: 8,
        orderedQty: 4,
        deliveredQty: 0,
        stock: expect.objectContaining({ pressure: "1.600", orderingQty: 4, toOrder: 2 }),
      }),
    ]);
    expect(needs.body.orders).toMatchObject([{ partId, qty: 4, status: "ordering" }]);

    const survey = await call(partNeedsRoute.GET, { params: { batchId: surveyBatch } });
    expect(survey.body.parts).toMatchObject([{ firmQty: 0, potentialQty: 1, remainingQty: 0 }]);
    expectError(await call(partNeedsRoute.GET, { params: { batchId: "00000000-0000-4000-8000-000000000000" } }), 404, "batch_not_found");
  });
});
