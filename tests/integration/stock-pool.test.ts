import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  assignMachine,
  barrier,
  type Catalog,
  changeMachine,
  checkHashboards,
  createBatch,
  createCatalog,
  createStockBatch,
  createUser,
  type Customer,
  failureOf,
  machinesOf,
  moveBatch,
  pay,
  placeOrder,
  receiveAndCheck,
  restock,
  transferMachine,
  writeFullRefund,
  writeOrder,
} from "./fixtures";

// Refonte machines / stock, jalon R2a : lot de stock (un par modèle, draft ↔ on_sale), capacité commune aux deux
// types de lot (batch_capacity), vendabilité d'une machine (machine_sellable), réassorts (StockRestock), transferts
// palette → stock (MachineTransfer), machines reçues en plus d'une palette. La clôture d'une palette vers le stock :
// batch-transition-effects.test.ts (§6).

type Tx = Prisma.TransactionClient;

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const machine = (id: string) => prisma.machine.findUniqueOrThrow({ where: { id } });

async function capacity(batchId: string) {
  const [row] = await prisma.$queryRaw<{ capacity: number; available: number }[]>`
    SELECT "batch_capacity"(${batchId}::uuid) AS "capacity", "batch_available_stock"(${batchId}::uuid) AS "available"`;
  return row;
}

async function summary(batchId: string) {
  const [row] = await prisma.$queryRaw<Record<string, number | string | null>[]>`
    SELECT * FROM "batch_machine_summary" WHERE "batch_id" = ${batchId}::uuid`;
  return row;
}

let catalog: Catalog;
let alice: Customer;
let bob: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  [alice, bob] = [await createUser(), await createUser()];
});

/** Lot de stock en vente avec `sellable` machines réassorties, reçues et contrôlées ok. */
async function stockWith(sellable: number) {
  const stock = await createStockBatch(catalog);
  const { machines } = await restock(catalog, stock, sellable);
  for (const m of machines) await receiveAndCheck(m.id);
  return { stock, machines };
}

/** Commande payée d'une machine sur un lot ; renvoie la facture et sa ligne. */
async function paidLine(batchId: string, customer: Customer) {
  const orderId = await placeOrder({ catalog, batchId, customer });
  await pay(orderId);
  const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
  return { orderId, lineId: line.id };
}

describe("lot de stock : type, statut, unicité", () => {
  it("ni quantité ni prix d'achat pour le stock ; obligatoires pour une palette (Batch_kind_check)", async () => {
    const base = { name: "Lot", model_id: catalog.modelId };
    expect(await constraintOf(prisma.batch.create({ data: { ...base, kind: "stock", quantity: 3 } }))).toBe("Batch_kind_check");
    expect(await constraintOf(prisma.batch.create({ data: { ...base, kind: "stock", purchase_price: 1n } }))).toBe("Batch_kind_check");
    expect(await constraintOf(prisma.batch.create({ data: { ...base, quantity: 3 } }))).toBe("Batch_kind_check");
    const stock = await prisma.batch.create({ data: { ...base, kind: "stock" } });
    expect(stock).toMatchObject({ kind: "stock", status: "draft", quantity: null, purchase_price: null });
  });

  it("un seul lot de stock par modèle ; plusieurs palettes par modèle", async () => {
    await createStockBatch(catalog);
    const second = prisma.batch.create({ data: { name: "Stock bis", model_id: catalog.modelId, kind: "stock" } });
    expect(await constraintOf(second)).toBe("Batch_one_stock_per_model");
    await createBatch(catalog, { quantity: 2 });
    await createBatch(catalog, { quantity: 3 });
    const other = await createCatalog("S21");
    await createStockBatch(other);
    expect(await prisma.batch.count({ where: { kind: "stock" } })).toBe(2);
  });

  it("le type d'un lot est immuable", async () => {
    const stock = await createStockBatch(catalog, { status: "draft" });
    const lot = await createBatch(catalog, { quantity: 1, status: "draft" });
    expect(await constraintOf(prisma.batch.update({ where: { id: stock }, data: { kind: "wholesale", quantity: 1, purchase_price: 0n } }))).toBe(
      "Batch_kind_immutable",
    );
    expect(await constraintOf(prisma.batch.update({ where: { id: lot }, data: { kind: "stock", quantity: null, purchase_price: null } }))).toBe(
      "Batch_kind_immutable",
    );
  });

  it("en pause (brouillon) : pas de commande ; en vente : commandes acceptées", async () => {
    const { stock } = await stockWith(1);
    await moveBatch(stock, "on_sale", "draft");
    expect(await constraintOf(placeOrder({ catalog, batchId: stock, customer: alice }))).toBe("Order_batch_open");
    await moveBatch(stock, "draft", "on_sale");
    await paidLine(stock, alice);
  });
});

describe("capacité du lot de stock : machines vendables", () => {
  it("seules les machines en main, ok et contrôlées comptent : attendue, non contrôlée, degraded ou faulty exclues", async () => {
    const stock = await createStockBatch(catalog);
    const { machines } = await restock(catalog, stock, 5);
    const [ok, degraded, faulty, unchecked] = machines;
    expect(await capacity(stock)).toEqual({ capacity: 0, available: 0 });
    await receiveAndCheck(ok.id);
    await receiveAndCheck(degraded.id, "degraded");
    await receiveAndCheck(faulty.id, "faulty");
    // Hashboards toutes ok mais état fonctionnel pas encore saisi : contrôle incomplet
    await prisma.$transaction(async (tx: Tx) => {
      await changeMachine(tx, unchecked.id, { logistical: "in_stock" });
      await checkHashboards(tx, unchecked.id, ["ok", "ok", "ok"]);
    });
    expect(await capacity(stock)).toEqual({ capacity: 1, available: 1 });
    expect(await summary(stock)).toMatchObject({ kind: "stock", quantity: null, capacity: 1, sellable_machines: 1, to_recheck: 0 });

    await paidLine(stock, alice);
    expect(await capacity(stock)).toEqual({ capacity: 1, available: 0 });
    expect(await constraintOf(placeOrder({ catalog, batchId: stock, customer: bob }))).toBe("Batch_stock");
  });

  it("machine retournée puis remise en stock : à recontrôler (hashboards ressaisies) avant d'être de nouveau vendable", async () => {
    const { stock, machines } = await stockWith(1);
    const [m] = machines;
    const { orderId, lineId } = await paidLine(stock, alice);
    await assignMachine(prisma, lineId, stock, m.id);
    await changeMachine(prisma, m.id, { logistical: "ready" });
    await changeMachine(prisma, m.id, { logistical: "in_transit" });
    // Expédiée : comptée par sa ligne
    expect(await capacity(stock)).toEqual({ capacity: 1, available: 0 });
    await prisma.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId}::uuid FOR NO KEY UPDATE`;
      await writeFullRefund(tx, orderId);
      await changeMachine(tx, m.id, { logistical: "returned" }, "Rétractation");
    });
    expect(await capacity(stock)).toEqual({ capacity: 0, available: 0 });
    await changeMachine(prisma, m.id, { logistical: "in_stock" }, "Retour au stock");
    expect((await machine(m.id)).functional_status).toBe("ok");
    expect(await capacity(stock)).toEqual({ capacity: 0, available: 0 });
    expect(await summary(stock)).toMatchObject({ sellable_machines: 0, to_recheck: 1 });
    expect(await constraintOf(placeOrder({ catalog, batchId: stock, customer: bob }))).toBe("Batch_stock");
    // Recontrôle : toutes les hashboards ressaisies depuis la remise en stock
    await checkHashboards(prisma, m.id, ["ok", "ok", "ok"]);
    expect(await capacity(stock)).toEqual({ capacity: 1, available: 1 });
    expect(await summary(stock)).toMatchObject({ sellable_machines: 1, to_recheck: 0 });
    const bobLine = await paidLine(stock, bob);
    await assignMachine(prisma, bobLine.lineId, stock, m.id);
  });

  it("une machine vendable qui devient degraded sur un lot plein : refus au COMMIT, sauf remboursement dans la même transaction", async () => {
    const { stock, machines } = await stockWith(2);
    const a = await paidLine(stock, alice);
    const b = await paidLine(stock, bob);
    await assignMachine(prisma, a.lineId, stock, machines[0].id);
    const degrade = (tx: Tx) =>
      checkHashboards(tx, machines[1].id, ["ok", "dead", "ok"]).then(() =>
        changeMachine(tx, machines[1].id, { functional: "degraded" }, "Hashboard morte"),
      );
    expect(await constraintOf(prisma.$transaction(degrade))).toBe("Batch_stock");
    // Lot de stock : la machine libre ne remplit plus la capacité, la commande la plus récente est en trop
    const [surplus] = await prisma.$queryRaw<{ order_id: string }[]>`SELECT "order_id" FROM "batch_surplus_lines"(${stock}::uuid, 1)`;
    expect(surplus.order_id).toBe(b.orderId);
    await prisma.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${b.orderId}::uuid FOR NO KEY UPDATE`;
      await writeFullRefund(tx, b.orderId, { cause: "shop_defective_machine" });
      await degrade(tx);
    });
    expect(await summary(stock)).toMatchObject({ capacity: 1, paid_lines: 1, surplus_lines: 0, degraded: 1 });
  });

  it("machine attribuée qui meurt : comptée par sa ligne jusqu'au remplacement ; surplus si aucune machine vendable", async () => {
    const { stock, machines } = await stockWith(1);
    const a = await paidLine(stock, alice);
    await assignMachine(prisma, a.lineId, stock, machines[0].id);
    await changeMachine(prisma, machines[0].id, { functional: "faulty" }, "Ne démarre plus");
    expect(await capacity(stock)).toEqual({ capacity: 1, available: 0 });
    expect(await summary(stock)).toMatchObject({ lines_to_replace: 1, surplus_lines: 1 });
    const { machines: more } = await restock(catalog, stock, 1);
    await receiveAndCheck(more[0].id);
    expect(await summary(stock)).toMatchObject({ surplus_lines: 0, sellable_machines: 1 });
    await assignMachine(prisma, a.lineId, stock, more[0].id, "Remplacement");
    expect(await capacity(stock)).toEqual({ capacity: 1, available: 0 });
  });
});

describe("pas de survente du stock en concurrence", () => {
  it("4 clients pour 2 machines vendables : 2 passent", async () => {
    const { stock } = await stockWith(2);
    const customers = [alice, bob, await createUser(), await createUser()];
    const sync = barrier(customers.length);
    const results = await Promise.allSettled(
      customers.map((customer) =>
        prisma.$transaction(async (tx) => {
          await writeOrder(tx, { catalog, batchId: stock, customer });
          await sync.wait();
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results.filter((x) => x.status === "rejected")) expect(pgFailureOf(r.reason)?.constraint).toBe("Batch_stock");
    expect(await capacity(stock)).toEqual({ capacity: 2, available: 0 });
  });

  it("commande contre machine qui devient invendable en même temps : une seule passe", async () => {
    const { stock, machines } = await stockWith(1);
    const sync = barrier(2);
    const results = await Promise.allSettled([
      prisma.$transaction(async (tx) => {
        await writeOrder(tx, { catalog, batchId: stock, customer: alice });
        await sync.wait();
      }),
      prisma.$transaction(async (tx) => {
        await checkHashboards(tx, machines[0].id, ["ok", "dead", "ok"]);
        await changeMachine(tx, machines[0].id, { functional: "degraded" }, "Hashboard morte");
        await sync.wait();
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(pgFailureOf(rejected?.reason)?.constraint).toBe("Batch_stock");
    expect((await capacity(stock)).available).toBe(0);
  });
});

describe("réassort", () => {
  it("crée les machines attendues dans le lot de stock (origine : le réassort), vendables après réception et contrôle", async () => {
    const stock = await createStockBatch(catalog);
    const { restockId, machines } = await restock(catalog, stock, 3);
    expect(machines).toHaveLength(3);
    expect(
      machines.every((m) => m.batch_id === stock && m.restock_id === restockId && m.origin_batch_id === null && m.logistical_status === "expected"),
    ).toBe(true);
    expect((await capacity(stock)).capacity).toBe(0);
    await receiveAndCheck(machines[0].id);
    expect((await capacity(stock)).capacity).toBe(1);
    const r = await prisma.stockRestock.findUniqueOrThrow({ where: { id: restockId } });
    expect(r.created_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("seulement sur un lot de stock ; journal en ajout seul ; machines du réassort bornées par sa quantité", async () => {
    const stock = await createStockBatch(catalog);
    const lot = await createBatch(catalog, { quantity: 1 });
    const onPalette = prisma.stockRestock.create({
      data: { model_id: catalog.modelId, batch_id: lot, quantity: 1, purchase_price: 0n, created_by_auth_user_id: ADMIN_AUTH_USER_ID },
    });
    expect(await constraintOf(onPalette)).toBe("StockRestock_stock_batch");
    const { restockId } = await restock(catalog, stock, 1);
    expect(await constraintOf(prisma.stockRestock.update({ where: { id: restockId }, data: { quantity: 2 } }))).toBe(
      "StockRestock_append_only",
    );
    expect(await constraintOf(prisma.stockRestock.delete({ where: { id: restockId } }))).toBe("StockRestock_append_only");
    const extra = prisma.machine.create({ data: { model_id: catalog.modelId, batch_id: stock, restock_id: restockId } });
    expect(await constraintOf(extra)).toBe("Machine_restock_quantity");
    const elsewhere = prisma.machine.create({ data: { model_id: catalog.modelId, batch_id: lot, restock_id: restockId } });
    expect(await constraintOf(elsewhere)).toBe("Machine_origin");
  });

  it("une machine a exactement une origine (palette ou réassort)", async () => {
    const stock = await createStockBatch(catalog);
    const lot = await createBatch(catalog, { quantity: 1, status: "ordering" });
    const { restockId } = await restock(catalog, stock, 1);
    expect(await constraintOf(prisma.machine.create({ data: { model_id: catalog.modelId, batch_id: stock } }))).toBe(
      "Machine_origin_check",
    );
    const both = prisma.machine.create({ data: { model_id: catalog.modelId, batch_id: lot, origin_batch_id: lot, restock_id: restockId } });
    expect(await constraintOf(both)).toBe("Machine_origin_check");
    const stockAsOrigin = prisma.machine.create({ data: { model_id: catalog.modelId, batch_id: stock, origin_batch_id: stock } });
    expect(await constraintOf(stockAsOrigin)).toBe("Machine_origin");
  });
});

describe("machine reçue en plus d'une palette", () => {
  it("créée directement au lot de stock (origine : la palette), une fois la palette pleine ; ne compte pas dans la palette", async () => {
    const stock = await createStockBatch(catalog);
    const early = await createBatch(catalog, { quantity: 2, status: "ordering" });
    const tooEarly = prisma.machine.create({ data: { model_id: catalog.modelId, batch_id: stock, origin_batch_id: early } });
    expect(await constraintOf(tooEarly)).toBe("Machine_origin");

    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const extra = await prisma.machine.create({ data: { model_id: catalog.modelId, batch_id: stock, origin_batch_id: lot } });
    expect(extra).toMatchObject({ batch_id: stock, origin_batch_id: lot, restock_id: null, logistical_status: "expected" });
    // La palette garde sa quantité et sa capacité ; l'extra ne libère pas de place de génération
    expect(await machinesOf(lot)).toHaveLength(2);
    expect((await capacity(lot)).capacity).toBe(2);
    await moveBatch(lot, "inspection", "awaiting_reception");
    expect(await machinesOf(lot)).toHaveLength(2);
    expect(await constraintOf(prisma.machine.create({ data: { model_id: catalog.modelId, batch_id: lot, origin_batch_id: lot } }))).toBe(
      "Machine_batch_quantity",
    );
    // Vendable au stock une fois reçue et contrôlée
    await receiveAndCheck(extra.id);
    expect((await capacity(stock)).capacity).toBe(1);
  });

  it("refusée vers le lot de stock d'un autre modèle", async () => {
    const other = await createCatalog("S21");
    const otherStock = await createStockBatch(other);
    const lot = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const crossModel = prisma.machine.create({ data: { model_id: catalog.modelId, batch_id: otherStock, origin_batch_id: lot } });
    expect(await constraintOf(crossModel)).toBe("Machine_origin");
  });
});

describe("transfert d'une palette vers le lot de stock", () => {
  /** Palette au Contrôle, machines reçues et ok ; lot de stock du modèle en vente. */
  async function paletteAndStock(quantity: number) {
    const stock = await createStockBatch(catalog);
    const lot = await createBatch(catalog, { quantity, status: "inspection" });
    const machines = await machinesOf(lot);
    for (const m of machines) await receiveAndCheck(m.id);
    return { stock, lot, machines };
  }

  it("avant la clôture : un invendu passe au stock, sans recréation ; capacités mises à jour ; journal en ajout seul", async () => {
    const { stock, lot, machines } = await paletteAndStock(3);
    await paidLine(lot, alice);
    const t = await transferMachine(prisma, machines[2].id, lot, stock, "admin", "Palette plus que vendue");
    expect(await machine(machines[2].id)).toMatchObject({ batch_id: stock, origin_batch_id: lot });
    expect(await capacity(lot)).toEqual({ capacity: 2, available: 1 });
    expect(await capacity(stock)).toEqual({ capacity: 1, available: 1 });
    expect(await summary(lot)).toMatchObject({ transferred_out: 1, machines: 2 });
    expect(await constraintOf(prisma.machineTransfer.update({ where: { id: t.id }, data: { note: "x" } }))).toBe(
      "MachineTransfer_append_only",
    );
    // Machine née dans la palette même après son transfert : la génération ne la recrée pas
    await moveBatch(lot, "inspection", "awaiting_reception");
    expect(await prisma.machine.count({ where: { origin_batch_id: lot } })).toBe(3);
  });

  it("refusé tant que la machine est celle d'une ligne active ; permis une fois la ligne remboursée", async () => {
    const { stock, lot, machines } = await paletteAndStock(2);
    const { orderId, lineId } = await paidLine(lot, alice);
    await assignMachine(prisma, lineId, lot, machines[0].id);
    expect(await constraintOf(transferMachine(prisma, machines[0].id, lot, stock))).toBe("MachineTransfer_assigned");
    await prisma.$transaction((tx: Tx) => writeFullRefund(tx, orderId));
    await transferMachine(prisma, machines[0].id, lot, stock);
    expect((await machine(machines[0].id)).batch_id).toBe(stock);
  });

  it("la palette garde de quoi servir ses commandes : refus au COMMIT sinon", async () => {
    const { stock, lot, machines } = await paletteAndStock(2);
    await paidLine(lot, alice);
    await paidLine(lot, bob);
    expect(await constraintOf(transferMachine(prisma, machines[1].id, lot, stock))).toBe("Batch_stock");
    expect((await machine(machines[1].id)).batch_id).toBe(lot);
  });

  it("sens unique palette → stock du même modèle ; appartenance courante ; machine en main ou retournée ; motif de clôture réservé", async () => {
    const { stock, lot, machines } = await paletteAndStock(2);
    const otherLot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [expected] = await machinesOf(otherLot);
    const other = await createCatalog("S21");
    const otherStock = await createStockBatch(other);

    expect(await constraintOf(transferMachine(prisma, machines[0].id, lot, otherLot))).toBe("MachineTransfer_direction");
    expect(await constraintOf(transferMachine(prisma, machines[0].id, lot, otherStock))).toBe("MachineTransfer_direction");
    expect(await constraintOf(transferMachine(prisma, machines[0].id, otherLot, stock))).toBe("MachineTransfer_current");
    expect(await constraintOf(transferMachine(prisma, expected.id, otherLot, stock))).toBe("MachineTransfer_machine_in_hand");
    expect(await constraintOf(transferMachine(prisma, machines[0].id, lot, stock, "batch_closed"))).toBe("MachineTransfer_reason");

    await transferMachine(prisma, machines[0].id, lot, stock);
    // Retour vers une palette : refusé (sens unique)
    expect(await constraintOf(transferMachine(prisma, machines[0].id, stock, lot))).toBe("MachineTransfer_direction");
  });

  it("palette annulée : ses machines sont figées, aucun transfert", async () => {
    const stock = await createStockBatch(catalog);
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    await changeMachine(prisma, m.id, { logistical: "in_stock" });
    await moveBatch(lot, "awaiting_reception", "cancelled");
    expect(await constraintOf(transferMachine(prisma, m.id, lot, stock))).toBe("Machine_batch_frozen");
  });
});

describe("attribution sur le lot de stock", () => {
  it("seulement une machine vendable du lot (jamais degraded) ; permise aussi lot en pause", async () => {
    const stock = await createStockBatch(catalog);
    const { machines } = await restock(catalog, stock, 2);
    const [ok, degraded] = machines;
    await receiveAndCheck(ok.id);
    await receiveAndCheck(degraded.id, "degraded");
    const { lineId } = await paidLine(stock, alice);
    expect(await constraintOf(assignMachine(prisma, lineId, stock, degraded.id, "Client d'accord"))).toBe(
      "OrderLineAssignment_machine_assignable",
    );
    await moveBatch(stock, "on_sale", "draft");
    await assignMachine(prisma, lineId, stock, ok.id);
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).machine_id).toBe(ok.id);
  });
});

describe("commandes en trop : la ligne remboursée libère vraiment une place (R4b, B1)", () => {
  type SurplusRow = { line_id: string; rank: number; frees_place: boolean };
  const surplusOf = (batchId: string, extra = 0) =>
    prisma.$queryRaw<SurplusRow[]>`
      SELECT "line_id", "rank", "frees_place" FROM "batch_surplus_lines"(${batchId}::uuid, ${extra}::int)`;
  const deliver = async (machineId: string) => {
    for (const logistical of ["ready", "in_transit", "delivered"] as const) await changeMachine(prisma, machineId, { logistical });
  };
  const refundAnd = (orderId: string, write: (tx: Tx) => Promise<unknown>) =>
    prisma.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId}::uuid FOR NO KEY UPDATE`;
      await writeFullRefund(tx, orderId, { cause: "shop_defective_machine" });
      await write(tx);
    });

  it("lot de stock : machine libre qui meurt, commande en ligne sans machine et vente plus récente déjà livrée : la ligne sans machine", async () => {
    const { stock, machines } = await stockWith(2);
    const [x, y] = machines;
    const online = await paidLine(stock, alice);
    const counter = await paidLine(stock, bob);
    await assignMachine(prisma, counter.lineId, stock, y.id);
    await deliver(y.id);
    const dies = (tx: Tx) => changeMachine(tx, x.id, { functional: "faulty" }, "Ne démarre plus");
    expect(await constraintOf(prisma.$transaction(dies))).toBe("Batch_stock");

    expect(await surplusOf(stock, 1)).toEqual([{ line_id: online.lineId, rank: 2, frees_place: true }]);
    // Rembourser la vente livrée ne libère rien (sa machine n'est plus en main) : refus au COMMIT
    expect(await constraintOf(refundAnd(counter.orderId, dies))).toBe("Batch_stock");
    await refundAnd(online.orderId, dies);
    expect(await summary(stock)).toMatchObject({ capacity: 1, paid_lines: 1, surplus_lines: 0, delivered: 1, faulty: 1 });
  });

  it("palette : une ligne dont la machine est en transit ou livrée passe après toutes les autres, même payée plus tard", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "inspection" });
    const machines = await machinesOf(lot);
    for (const m of machines) await receiveAndCheck(m.id);
    const carol = await createUser();
    const first = await paidLine(lot, alice);
    const second = await paidLine(lot, bob);
    const served = await paidLine(lot, carol);
    await assignMachine(prisma, first.lineId, lot, machines[0].id);
    await assignMachine(prisma, served.lineId, lot, machines[2].id);
    await changeMachine(prisma, machines[2].id, { logistical: "ready" });
    await changeMachine(prisma, machines[2].id, { logistical: "in_transit" });
    // Les plus récentes d'abord parmi les lignes non servies (sans machine ou machine en main), puis la ligne servie
    expect((await surplusOf(lot, 2)).map((s) => s.line_id)).toEqual([second.lineId, first.lineId]);
    expect((await surplusOf(lot, 3)).map((s) => [s.line_id, s.rank])).toEqual([
      [second.lineId, 3],
      [first.lineId, 2],
      [served.lineId, 1],
    ]);
  });

  it("ligne dont la machine est morte : en trop par ordre de paiement, mais son remboursement ne libère pas de place (frees_place)", async () => {
    const { stock, machines } = await stockWith(2);
    const [x, z] = machines;
    const a = await paidLine(stock, alice);
    await assignMachine(prisma, a.lineId, stock, x.id);
    await changeMachine(prisma, x.id, { functional: "faulty" }, "Ne démarre plus");
    // Une machine vendable libre la remplace : rien en trop
    expect(await surplusOf(stock)).toEqual([]);
    await placeOrder({ catalog, batchId: stock, customer: bob });
    // Z, réservée par la facture en attente, s'apprête à mourir : la ligne morte est en trop, mais la rembourser ne
    // rend pas de place au lot (la machine morte comptait déjà par sa ligne) ; le manque vient de la réservation
    expect(await surplusOf(stock, 1)).toEqual([{ line_id: a.lineId, rank: 1, frees_place: false }]);
    const zDies = (tx: Tx) => changeMachine(tx, z.id, { functional: "faulty" }, "Ne démarre plus");
    expect(await constraintOf(refundAnd(a.orderId, zDies))).toBe("Batch_stock");
  });
});
