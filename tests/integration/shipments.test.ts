import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import { prisma } from "./db";
import {
  assignMachine,
  type Catalog,
  changeMachine,
  createBatch,
  createCatalog,
  createUser,
  type Customer,
  failureOf,
  machinesOf,
  pay,
  placeOrder,
  receiveAndCheck,
} from "./fixtures";

// R6 lot 1 : Shipment, une par facture ; dates posées par la base à partir des changements de statut des machines.

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const shipment = (orderId: string) => prisma.shipment.findUnique({ where: { order_id: orderId } });

let catalog: Catalog;
let alice: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
});

/** Facture payée de `n` lignes ; `assigned` machines attribuées (reçues, contrôlées, prêtes). */
async function setup(n: number, assigned = n) {
  const lot = await createBatch(catalog, { quantity: 3, status: "inspection" });
  const machines = await machinesOf(lot);
  for (const m of machines) await receiveAndCheck(m.id);
  const orderId = await placeOrder({ catalog, batchId: lot, customer: alice, lines: Array(n).fill(false) });
  await pay(orderId);
  const lines = await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { id: "asc" } });
  for (let i = 0; i < assigned; i++) {
    await assignMachine(prisma, lines[i].id, lot, machines[i].id);
    await changeMachine(prisma, machines[i].id, { logistical: "ready" });
  }
  return { lot, orderId, machines, lines };
}

describe("Shipment", () => {
  it("colonnes de suivi retirées de Machine ; une seule ligne par facture", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'Machine' AND column_name IN ('carrier', 'tracking_number', 'tracking_url')`;
    expect(cols).toEqual([]);
    const { orderId } = await setup(1);
    await prisma.shipment.create({ data: { order_id: orderId, carrier: "DHL" } });
    expect(await constraintOf(prisma.shipment.create({ data: { order_id: orderId } }))).toBe("Shipment_order_id_key");
  });

  it("créé pour une facture payée seulement, sans dates ni suppression ; lien http/https ; immuabilité", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "preorder" });
    const pending = await placeOrder({ catalog, batchId: lot, customer: alice });
    expect(await constraintOf(prisma.shipment.create({ data: { order_id: pending } }))).toBe("Shipment_order_paid");
    const { orderId } = await setup(1);
    expect(await constraintOf(prisma.shipment.create({ data: { order_id: orderId, shipped_at: new Date() } }))).toBe("Shipment_new");
    expect(await constraintOf(prisma.shipment.create({ data: { order_id: orderId, tracking_url: "ftp://x" } }))).toBe("Shipment_tracking_url_check");
    const s = await prisma.shipment.create({ data: { order_id: orderId, carrier: "DHL", tracking_number: "JD1", tracking_url: "https://dhl.example/JD1" } });
    expect(s).toMatchObject({ shipped_at: null, delivered_at: null });
    expect(await constraintOf(prisma.shipment.update({ where: { id: s.id }, data: { shipped_at: new Date() } }))).toBe("Shipment_dates_via_change");
    expect(await constraintOf(prisma.shipment.update({ where: { id: s.id }, data: { delivered_at: new Date() } }))).toBe("Shipment_dates_via_change");
    expect(await constraintOf(prisma.shipment.update({ where: { id: s.id }, data: { order_id: pending } }))).toBe("Shipment_immutable");
    const edited = await prisma.shipment.update({ where: { id: s.id }, data: { carrier: "UPS" } });
    expect(edited.carrier).toBe("UPS");
    expect(edited.updated_at.getTime()).toBeGreaterThan(s.updated_at.getTime());
    expect(await constraintOf(prisma.shipment.delete({ where: { id: s.id } }))).toBe("Shipment_no_delete");
  });

  it("un envoi ne part que complet : toutes les lignes actives ont une machine", async () => {
    const { orderId, machines, lines } = await setup(2, 1);
    expect(await constraintOf(changeMachine(prisma, machines[0].id, { logistical: "in_transit" }))).toBe("Shipment_complete");
    expect(await shipment(orderId)).toBeNull();
    await assignMachine(prisma, lines[1].id, lines[1].batch_id, machines[1].id);
    await changeMachine(prisma, machines[1].id, { logistical: "ready" });
    await changeMachine(prisma, machines[0].id, { logistical: "in_transit" });
    expect(await shipment(orderId)).toMatchObject({ delivered_at: null });
  });

  it("shipped_at posée à la première remise (envoi créé au besoin ou saisi d'avance), jamais recalée", async () => {
    const { orderId, machines } = await setup(2);
    const created = await prisma.shipment.create({ data: { order_id: orderId, carrier: "DHL" } });
    await changeMachine(prisma, machines[0].id, { logistical: "in_transit" });
    const first = (await shipment(orderId))!;
    expect(first).toMatchObject({ id: created.id, carrier: "DHL" });
    expect(first.shipped_at).toEqual((await prisma.machine.findUniqueOrThrow({ where: { id: machines[0].id } })).shipped_at);
    await changeMachine(prisma, machines[1].id, { logistical: "in_transit" });
    expect((await shipment(orderId))!.shipped_at).toEqual(first.shipped_at);
    expect(await prisma.shipment.count()).toBe(1);
  });

  it("sans envoi saisi : créé par la base à la première remise", async () => {
    const { orderId, machines } = await setup(1);
    await changeMachine(prisma, machines[0].id, { logistical: "in_transit" });
    expect(await shipment(orderId)).toMatchObject({ carrier: null, tracking_number: null, delivered_at: null });
    expect((await shipment(orderId))!.shipped_at).not.toBeNull();
  });

  it("delivered_at : posée quand plus rien n'est à acheminer ; perte ou retour n'annule pas l'envoi", async () => {
    const { orderId, machines } = await setup(3);
    for (const m of machines) await changeMachine(prisma, m.id, { logistical: "in_transit" });
    const shipped = (await shipment(orderId))!.shipped_at;
    await changeMachine(prisma, machines[0].id, { logistical: "delivered" });
    expect((await shipment(orderId))!.delivered_at).toBeNull();
    await changeMachine(prisma, machines[1].id, { logistical: "lost" }, "Colis perdu");
    expect((await shipment(orderId))!.delivered_at).toBeNull();
    await changeMachine(prisma, machines[2].id, { logistical: "returned" }, "Refusé");
    const done = (await shipment(orderId))!;
    expect(done.shipped_at).toEqual(shipped);
    expect(done.delivered_at).not.toBeNull();
    expect(done.delivered_at!.getTime()).toBeGreaterThanOrEqual(done.shipped_at!.getTime());
    // La machine retrouvée puis relivrée ne déplace pas les dates
    await changeMachine(prisma, machines[1].id, { logistical: "in_stock" }, "Retrouvée");
    expect(await shipment(orderId)).toMatchObject({ shipped_at: shipped, delivered_at: done.delivered_at });
  });

  it("perte ou retour de toutes les machines : jamais livré, l'envoi garde sa date d'expédition", async () => {
    const { orderId, machines } = await setup(1);
    await changeMachine(prisma, machines[0].id, { logistical: "in_transit" });
    await changeMachine(prisma, machines[0].id, { logistical: "lost" }, "Colis perdu");
    expect(await shipment(orderId)).toMatchObject({ delivered_at: null });
    expect((await shipment(orderId))!.shipped_at).not.toBeNull();
  });
});
