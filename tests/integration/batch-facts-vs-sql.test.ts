import { beforeEach, describe, expect, it } from "vitest";
import { changeBatchStatus, loadFacts } from "@/server/batches";
import { pgFailureOf } from "@/server/errors";
import { prisma } from "./db";
import {
  assignMachine,
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
  receiveAndCheck,
  receivePayment,
  cancelOrder,
} from "./fixtures";

// Les compteurs de machines de BatchFacts (src/server/batches.ts, loadFacts) sont lus dans la vue SQL
// batch_machine_summary (source unique, refonte R3). Ce fichier vérifie la lecture sur une base peuplée de machines à
// tous les statuts, et l'égalité entre l'annonce de la clôture (machinesToStock = colonne unsold, machine_unsold) et
// les machines effectivement transférées par le trigger de clôture. Il fige aussi l'égalité de la clause
// d'annulation des factures sans versement entre loadFacts (unpaidPendingOrders) et le trigger
// BatchStatusTransition_2_cancel_orders.

let catalog: Catalog;
beforeEach(async () => {
  catalog = await createCatalog();
});

type Summary = Record<string, number | string>;
async function summary(batchId: string): Promise<Summary> {
  const [row] = await prisma.$queryRaw<Summary[]>`SELECT * FROM "batch_machine_summary" WHERE "batch_id" = ${batchId}::uuid`;
  return row;
}
const factsOf = async (batchId: string) => (await loadFacts(prisma, [batchId])).get(batchId)!.facts;

/**
 * Lot de 14 machines à tous les statuts logistiques et fonctionnels :
 * expected, missing, in_stock (non contrôlée / ok / degraded / faulty), scrapped, in_preparation, ready,
 * in_transit, delivered, lost, returned, + une machine in_stock non contrôlée et une attribuée.
 * Cinq lignes payées, chacune attribuée à une machine (ok, puis expédiée, livrée, perdue, retournée).
 */
async function populatedBatch() {
  const lot = await createBatch(catalog, { quantity: 14, status: "inspection" });
  const m = await machinesOf(lot);
  const [expected, missing, unchecked, ok, degraded, faulty, scrapped, prep, ready, transit, delivered, lost, returned, assigned] = m;

  await changeMachine(prisma, missing.id, { logistical: "missing" }, "Absente");
  await changeMachine(prisma, unchecked.id, { logistical: "in_stock" });
  for (const x of [ok, assigned, prep, ready, transit, delivered, lost, returned, scrapped, faulty, degraded]) {
    await receiveAndCheck(x.id, x === degraded ? "degraded" : x === scrapped || x === faulty ? "faulty" : "ok");
  }
  await changeMachine(prisma, scrapped.id, { logistical: "scrapped" }, "Ne démarre pas");
  await changeMachine(prisma, prep.id, { logistical: "in_preparation" });

  // Lignes payées : une par machine qui sera expédiée (Machine_shipped_assigned), plus la machine attribuée
  const lineOf = new Map<string, string>();
  for (const target of [assigned, transit, delivered, lost, returned]) {
    const orderId = await placeOrder({ catalog, batchId: lot, customer: await createUser() });
    await pay(orderId);
    const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
    await assignMachine(prisma, line.id, lot, target.id);
    lineOf.set(target.id, line.id);
  }

  // Expédition : lot en Packaging
  await moveBatch(lot, "inspection", "packaging");
  await changeMachine(prisma, ready.id, { logistical: "ready" });
  for (const x of [transit, delivered, lost, returned]) {
    await changeMachine(prisma, x.id, { logistical: "ready" });
    await changeMachine(prisma, x.id, { logistical: "in_transit" });
  }
  await changeMachine(prisma, delivered.id, { logistical: "delivered" });
  await changeMachine(prisma, lost.id, { logistical: "lost" }, "Perdue par le transporteur");
  await changeMachine(prisma, returned.id, { logistical: "returned" }, "Refusée au transporteur");
  return { lot, machines: { expected, missing, unchecked, ok, degraded, faulty, scrapped, prep, ready, transit, delivered, lost, returned, assigned } };
}

describe("compteurs machine : BatchFacts lus dans la vue batch_machine_summary", () => {
  it("reçues, contrôlées, expédiées, attribuées, en montage, non livrées : valeurs de la vue sur un lot à tous les statuts", async () => {
    const { lot } = await populatedBatch();
    const f = await factsOf(lot);
    const v = await summary(lot);
    // Sanity : la population couvre bien tous les statuts (le test échoue si la fixture se dégrade)
    const bySt = await prisma.machine.groupBy({ by: ["logistical_status"], where: { batch_id: lot }, _count: true });
    expect(bySt.map((g) => g.logistical_status).sort()).toEqual(
      ["delivered", "expected", "in_preparation", "in_stock", "in_transit", "lost", "missing", "ready", "returned", "scrapped"],
    );
    expect(v).toMatchObject({ received: 12, unchecked: 1, in_preparation: 1, in_transit: 1, delivered: 1, assigned_lines: 5, undelivered_lines: 4 });
    expect(f).toMatchObject({
      receivedMachines: v.received,
      uncheckedMachines: v.unchecked,
      checkedMachines: (v.ok as number) + (v.degraded as number) + (v.faulty as number),
      shippedMachines: (v.in_transit as number) + (v.delivered as number),
      assignedLines: v.assigned_lines,
      machinesInPreparation: v.in_preparation,
      undeliveredLines: v.undelivered_lines,
    });
  });

  it("une machine non contrôlée ne quitte pas la main : « reçues non contrôlées » = « en main non contrôlées »", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const [m] = await machinesOf(lot);
    await changeMachine(prisma, m.id, { logistical: "in_stock" });
    await moveBatch(lot, "inspection", "packaging");
    for (const to of ["in_preparation", "ready"] as const) {
      const failure = pgFailureOf(await failureOf(changeMachine(prisma, m.id, { logistical: to })));
      expect(failure?.constraint, to).toBe("Machine_functional_before_prepare_check");
    }
    expect((await factsOf(lot)).uncheckedMachines).toBe(1);
  });

  it("lot sans machine : tout à zéro", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "ordering" });
    const f = await factsOf(lot);
    expect([f.receivedMachines, f.uncheckedMachines, f.checkedMachines, f.assignedLines, f.shippedMachines, f.machinesInPreparation]).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
  });

  it("machinesToStock (unsold) = machines transférées par la clôture (même fonction machine_unsold)", async () => {
    const lot = await createBatch(catalog, { quantity: 4, status: "inspection" });
    const [sold, unsoldOk, unsoldUnchecked, missing] = await machinesOf(lot);
    for (const m of [sold, unsoldOk]) await receiveAndCheck(m.id);
    await changeMachine(prisma, unsoldUnchecked.id, { logistical: "in_stock" });
    await changeMachine(prisma, missing.id, { logistical: "missing" }, "Absente");
    const orderId = await placeOrder({ catalog, batchId: lot, customer: await createUser() });
    await pay(orderId);
    const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
    await assignMachine(prisma, line.id, lot, sold.id);
    await moveBatch(lot, "inspection", "packaging");
    for (const to of ["ready", "in_transit"] as const) await changeMachine(prisma, sold.id, { logistical: to });
    await moveBatch(lot, "packaging", "in_transit");
    await changeMachine(prisma, sold.id, { logistical: "delivered" });
    const announced = (await factsOf(lot)).machinesToStock;
    expect(announced).toBe(2);
    await changeBatchStatus(lot, { from: "in_transit", to: "closed" }, { authUserId: "1" });
    expect(await prisma.machineTransfer.count({ where: { from_batch_id: lot, reason: "batch_closed" } })).toBe(announced);
  });
});

describe("clause d'annulation des factures sans versement : loadFacts contre BatchStatusTransition_cancel_orders", () => {
  /** Une facture de chaque sorte sur un lot ouvert ; renvoie le lot. */
  async function lotWithOrders() {
    const lot = await createBatch(catalog, { quantity: 8, status: "preorder" });
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await createUser());
    await placeOrder({ catalog, batchId: lot, customer: users[0] }); // sans versement : annulée
    await placeOrder({ catalog, batchId: lot, customer: users[1], lines: [false, true] }); // idem, 2 lignes : une seule facture
    const partial = await placeOrder({ catalog, batchId: lot, customer: users[2] });
    await receivePayment(prisma, partial, 1_000n); // versement partiel : reste en attente
    await placeOrder({ catalog, batchId: lot, customer: users[3], expiredMinutesAgo: 5 }); // expirée : reste
    await pay(await placeOrder({ catalog, batchId: lot, customer: users[4] })); // payée : reste
    await cancelOrder(prisma, await placeOrder({ catalog, batchId: lot, customer: users[5] })); // annulée par le client
    return lot;
  }
  const closedByBatch = (batchId: string) =>
    prisma.order.count({ where: { batch_id: batchId, status: "cancelled", cancel_reason: "batch_closed" } });

  it("loadFacts.unpaidPendingOrders = nombre de factures annulées par la transition qui ferme les commandes (en transit)", async () => {
    const lot = await lotWithOrders();
    for (const [from, to] of [["preorder", "ordering"], ["ordering", "awaiting_reception"], ["awaiting_reception", "inspection"], ["inspection", "packaging"]] as const) {
      await moveBatch(lot, from, to);
    }
    const announced = (await factsOf(lot)).unpaidPendingOrders;
    expect(announced).toBe(2);
    expect(await closedByBatch(lot)).toBe(0);
    await moveBatch(lot, "packaging", "in_transit");
    expect(await closedByBatch(lot)).toBe(announced);
  });

  it("même égalité pour une annulation du lot (changeBatchStatus, chemin applicatif)", async () => {
    const lot = await createBatch(catalog, { quantity: 4, status: "preorder" });
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    await placeOrder({ catalog, batchId: lot, customer: a });
    await placeOrder({ catalog, batchId: lot, customer: b, expiredMinutesAgo: 5 });
    await receivePayment(prisma, await placeOrder({ catalog, batchId: lot, customer: c }), 500n);
    const announced = (await factsOf(lot)).unpaidPendingOrders;
    expect(announced).toBe(1);
    await changeBatchStatus(lot, { from: "preorder", to: "cancelled", note: "Test" }, { authUserId: "1" });
    expect(await closedByBatch(lot)).toBe(announced);
  });

  it("transition qui garde les commandes ouvertes : le compteur n'est pas appliqué", async () => {
    const lot = await lotWithOrders();
    await moveBatch(lot, "preorder", "ordering");
    expect(await closedByBatch(lot)).toBe(0);
  });
});
