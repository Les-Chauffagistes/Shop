import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  barrier,
  type Catalog,
  changeMachine,
  createBatch,
  createCatalog,
  createUser,
  failureOf,
  machinesOf,
  moveBatch,
  pay,
  placeOrder,
  SILENT_PRICE,
  wish,
} from "./fixtures";

// Stock commun des produits d'options (migration v4, décisions Hugo 2026-10-07) : journal
// PartStockMovement, commandes de lot BatchPartOrder, vues batch_part_needs et part_stock_pressure.

type Tx = Prisma.TransactionClient;

let catalog: Catalog;
/** Produit « Silent kit », monté par la valeur Silent kit du modèle (1 par machine). */
let kitId: string;

beforeEach(async () => {
  catalog = await createCatalog();
  kitId = (await prisma.part.create({ data: { name: "Silent kit", reference: "SK-120" } })).id;
  await prisma.optionValuePart.create({ data: { option_value_id: catalog.silentId, part_id: kitId, qty: 1 } });
});

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;

type Movement = Omit<Prisma.PartStockMovementUncheckedCreateInput, "created_by_auth_user_id" | "part_id"> & { part_id?: string };
const move = (data: Movement, db: Tx | typeof prisma = prisma) =>
  db.partStockMovement.create({ data: { part_id: kitId, created_by_auth_user_id: ADMIN_AUTH_USER_ID, ...data } });

async function pressure() {
  const [row] = await prisma.$queryRaw<
    {
      on_hand: number; ordering_qty: number; awaiting_delivery_qty: number; firm_demand: number;
      potential_demand: number; pressure: Prisma.Decimal | null; over_pressure: boolean; shortfall: number; to_order: number;
    }[]
  >`SELECT * FROM "part_stock_pressure" WHERE "part_id" = ${kitId}::uuid`;
  return { ...row, pressure: row.pressure === null ? null : Number(row.pressure) };
}

async function needs(batchId: string) {
  const rows = await prisma.$queryRaw<
    { firm_qty: number; potential_qty: number; mounted_qty: number; remaining_qty: number; ordered_qty: number; delivered_qty: number }[]
  >`SELECT "firm_qty", "potential_qty", "mounted_qty", "remaining_qty", "ordered_qty", "delivered_qty"
    FROM "batch_part_needs" WHERE "batch_id" = ${batchId}::uuid AND "part_id" = ${kitId}::uuid`;
  return rows[0] ?? null;
}

describe("journal de stock", () => {
  it("par type : réception > 0, correction motivée, kit monté < 0 sur un lot ; append-only", async () => {
    expect(await constraintOf(move({ kind: "reception", qty: -1 }))).toBe("PartStockMovement_kind_check");
    expect(await constraintOf(move({ kind: "adjustment", qty: 2 }))).toBe("PartStockMovement_kind_check");
    expect(await constraintOf(move({ kind: "adjustment", qty: 2, note: "  " }))).toBe("PartStockMovement_kind_check");
    expect(await constraintOf(move({ kind: "kit_mounted", qty: -1 }))).toBe("PartStockMovement_kind_check");

    const reception = await move({ kind: "reception", qty: 10, note: "Achat hors lot" });
    await move({ kind: "adjustment", qty: -1, note: "Kit abîmé" });
    expect(await constraintOf(prisma.partStockMovement.update({ where: { id: reception.id }, data: { qty: 12 } }))).toBe(
      "PartStockMovement_append_only",
    );
    expect(await constraintOf(prisma.partStockMovement.delete({ where: { id: reception.id } }))).toBe(
      "PartStockMovement_append_only",
    );
    expect((await pressure()).on_hand).toBe(9);
  });

  it("stock physique jamais négatif ; kit monté seulement sur un lot dont le modèle utilise ce produit", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "inspection" });
    expect(await constraintOf(move({ kind: "kit_mounted", qty: -1, batch_id: batchId }))).toBe("Part_stock_non_negative");

    const other = await createCatalog("S21");
    const otherBatch = await createBatch(other, { quantity: 1, status: "inspection" });
    await move({ kind: "reception", qty: 1 });
    expect(await constraintOf(move({ kind: "kit_mounted", qty: -1, batch_id: otherBatch }))).toBe("PartStockMovement_kit_model");

    // Machines générées par la base à l'Attente de réception (v6) : on en reçoit une
    const [machine] = await machinesOf(batchId);
    await changeMachine(prisma, machine.id, { logistical: "in_stock" });
    await move({ kind: "kit_mounted", qty: -1, batch_id: batchId, machine_id: machine.id });
    // Machine d'un autre lot : clé étrangère composite (machine_id, batch_id)
    await move({ kind: "reception", qty: 1 });
    expect(await failureOf(move({ kind: "kit_mounted", qty: -1, batch_id: otherBatch, machine_id: machine.id }))).toBeTruthy();
  });

  it("concurrence : deux sorties pour le dernier kit, une seule passe", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "inspection" });
    await move({ kind: "reception", qty: 1 });
    const sync = barrier(2);
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        prisma.$transaction(async (tx) => {
          await move({ kind: "kit_mounted", qty: -1, batch_id: batchId }, tx);
          await sync.wait();
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(pgFailureOf(rejected?.reason)?.constraint).toBe("Part_stock_non_negative");
  });
});

describe("commande de produit d'option pour un lot (BatchPartOrder)", () => {
  it("statut qui avance ; livrée ⇔ réception rattachée, même produit, une seule", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "ordering" });
    const order = await prisma.batchPartOrder.create({ data: { batch_id: batchId, part_id: kitId, qty: 3 } });
    const setStatus = (status: "ordering" | "awaiting_delivery" | "delivered", db: Tx | typeof prisma = prisma) =>
      db.batchPartOrder.update({
        where: { id: order.id },
        data: { status, delivered_at: status === "delivered" ? new Date() : null },
      });

    await setStatus("awaiting_delivery");
    expect(await constraintOf(setStatus("ordering"))).toBe("BatchPartOrder_status_transition");
    expect(await constraintOf(prisma.$transaction((tx) => setStatus("delivered", tx)))).toBe("BatchPartOrder_reception");
    expect(await constraintOf(move({ kind: "reception", qty: 3, batch_part_order_id: order.id }))).toBe("BatchPartOrder_reception");

    // Autre produit que celui de la commande : clé étrangère composite (batch_part_order_id, part_id)
    const fans = await prisma.part.create({ data: { name: "Ventilateurs" } });
    expect(await failureOf(move({ kind: "reception", qty: 3, batch_part_order_id: order.id, part_id: fans.id }))).toBeTruthy();

    await prisma.$transaction(async (tx) => {
      await setStatus("delivered", tx);
      await move({ kind: "reception", qty: 3, batch_part_order_id: order.id }, tx);
    });
    expect(await failureOf(move({ kind: "reception", qty: 1, batch_part_order_id: order.id }))).toBeTruthy(); // unique
    expect(await constraintOf(prisma.batchPartOrder.update({ where: { id: order.id }, data: { qty: 4 } }))).toBe(
      "BatchPartOrder_immutable",
    );
    expect(await constraintOf(setStatus("awaiting_delivery"))).toBe("BatchPartOrder_status_transition");
    expect((await pressure()).on_hand).toBe(3);
  });

  it("delivered_qty du besoin = kits reçus (3 sur 6 commandés → 3), réassort hors commande exclu", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "ordering" });
    const order = await prisma.batchPartOrder.create({ data: { batch_id: batchId, part_id: kitId, qty: 6 } });
    expect(await needs(batchId)).toMatchObject({ ordered_qty: 6, delivered_qty: 0 });
    await prisma.$transaction(async (tx) => {
      await tx.batchPartOrder.update({ where: { id: order.id }, data: { status: "delivered", delivered_at: new Date() } });
      await move({ kind: "reception", qty: 3, batch_part_order_id: order.id }, tx);
    });
    await move({ kind: "reception", qty: 10, note: "Réassort" });
    expect(await needs(batchId)).toMatchObject({ ordered_qty: 0, delivered_qty: 3 });
    expect((await pressure()).on_hand).toBe(13);
  });
});

describe("besoin par lot et pression (calculés à la lecture)", () => {
  it("exemple de la décision : 10 kits, deux lots qui en demandent 8 → 16/10", async () => {
    await move({ kind: "reception", qty: 10 });
    const lots = [];
    for (let i = 0; i < 2; i++) {
      const batchId = await createBatch(catalog, { quantity: 8 });
      const customer = await createUser();
      await pay(await placeOrder({ catalog, batchId, customer, lines: [true, true, true, true, true] }));
      await placeOrder({ catalog, batchId, customer, lines: [true, true, true] }); // réservation vivante : demande ferme
      lots.push(batchId);
    }
    expect(await needs(lots[0])).toMatchObject({ firm_qty: 8, remaining_qty: 8, mounted_qty: 0 });
    expect(await pressure()).toMatchObject({
      on_hand: 10, firm_demand: 16, pressure: 1.6, over_pressure: true, shortfall: 6, to_order: 6,
    });

    // Commande en route pour le premier lot : le manque à commander baisse, la pression non
    await prisma.batchPartOrder.create({ data: { batch_id: lots[0], part_id: kitId, qty: 4, status: "awaiting_delivery" } });
    expect(await pressure()).toMatchObject({ awaiting_delivery_qty: 4, shortfall: 6, to_order: 2 });
    expect(await needs(lots[0])).toMatchObject({ ordered_qty: 4, delivered_qty: 0 });
  });

  it("réservation expirée et ligne remboursée ne comptent pas ; kits montés sortent de la demande ; wishlists à part", async () => {
    await move({ kind: "reception", qty: 5 });
    const batchId = await createBatch(catalog, { quantity: 6, status: "inspection" });
    const [alice, bob] = [await createUser(), await createUser()];
    await pay(await placeOrder({ catalog, batchId, customer: alice, lines: [true, true, false] }));
    await placeOrder({ catalog, batchId, customer: bob, lines: [true], expiredMinutesAgo: 1 });
    expect(await needs(batchId)).toMatchObject({ firm_qty: 2, remaining_qty: 2 });

    await move({ kind: "kit_mounted", qty: -1, batch_id: batchId });
    expect(await needs(batchId)).toMatchObject({ firm_qty: 2, mounted_qty: 1, remaining_qty: 1 });
    expect(await pressure()).toMatchObject({ on_hand: 4, firm_demand: 1, pressure: 0.25, over_pressure: false });

    // Demande potentielle : wishlists non retirées d'un lot au sondage, hors pression
    const survey = await createBatch(catalog, { quantity: 3, status: "survey" });
    const silent = { optionId: catalog.optionId, valueId: catalog.silentId, price: SILENT_PRICE };
    await wish(catalog, survey, alice, [silent]);
    const retracted = await wish(catalog, survey, bob, [silent]);
    await prisma.wishlist.update({ where: { id: retracted.id }, data: { cancelled_at: new Date() } });
    expect(await needs(survey)).toMatchObject({ firm_qty: 0, potential_qty: 1 });
    expect(await pressure()).toMatchObject({ firm_demand: 1, potential_demand: 1 });

    // Le lot quitte le sondage : sa demande potentielle n'est plus affichée
    await moveBatch(survey, "survey", "preorder");
    expect(await needs(survey)).toBeNull();
  });

  it("demande sans stock : pression NULL (infinie) et avertissement ; sans demande : 0", async () => {
    expect(await pressure()).toMatchObject({ on_hand: 0, firm_demand: 0, pressure: 0, over_pressure: false });
    const batchId = await createBatch(catalog, { quantity: 2 });
    await placeOrder({ catalog, batchId, customer: await createUser(), lines: [true] });
    expect(await pressure()).toMatchObject({ firm_demand: 1, pressure: null, over_pressure: true, shortfall: 1 });
  });
});
