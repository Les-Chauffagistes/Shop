import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as autoAssignRoute from "@/app/api/backoffice/batches/[batchId]/assignments/auto/route";
import * as extraMachinesRoute from "@/app/api/backoffice/batches/[batchId]/extra-machines/route";
import * as batchMachinesRoute from "@/app/api/backoffice/batches/[batchId]/machines/route";
import * as receptionsRoute from "@/app/api/backoffice/batches/[batchId]/receptions/route";
import * as restocksRoute from "@/app/api/backoffice/batches/[batchId]/restocks/route";
import * as transitionsRoute from "@/app/api/backoffice/batches/[batchId]/transitions/route";
import * as hashboardsRoute from "@/app/api/backoffice/machines/[machineId]/hashboards/route";
import * as machineRoute from "@/app/api/backoffice/machines/[machineId]/route";
import * as checkOkRoute from "@/app/api/backoffice/machines/check-ok/route";
import * as machinesRoute from "@/app/api/backoffice/machines/route";
import * as statusRoute from "@/app/api/backoffice/machines/status/route";
import * as assignmentRoute from "@/app/api/backoffice/order-lines/[lineId]/assignment/route";
import * as replacementRoute from "@/app/api/backoffice/order-lines/[lineId]/replacement/route";
import * as cancelLinesRoute from "@/app/api/backoffice/orders/[orderId]/cancel-lines/route";
import * as stockRoute from "@/app/api/backoffice/stock/route";
import * as paymentsRoute from "@/app/api/internal/payments/route";
import * as ordersRoute from "@/app/api/orders/route";
import type { MachineFunctionalStatus, MachineLogisticalStatus } from "../../prisma/generated/client";
import { prisma } from "./db";
import { TEST_PAYMENT_SECRET } from "./env";
import {
  type Catalog,
  changeMachine,
  CONTACT_EMAIL,
  createBatch,
  createCatalog,
  createStockBatch,
  createUser,
  machinesOf,
  moveBatch,
  pay,
  placeOrder,
  receiveAndCheck,
  REFUND_ADDRESS,
  restock,
  RESALE,
} from "./fixtures";
import { ADMIN, call, type Reply, SAME_ORIGIN, signIn } from "./http";

// Jalon 5 / refonte R3a : routes machines du backoffice (réception, contrôle, statuts jusqu'à la livraison,
// attribution manuelle, automatique et remplacement, machines en moins remboursées, machine reçue en plus d'une
// palette, lectures) et parcours complets palette et stock. Les règles SQL elles-mêmes : machines-v6.test.ts,
// stock-pool.test.ts ; l'égalité des tables TS et SQL : machine-status-vs-sql.test.ts.

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

type Handler = Parameters<typeof call>[0];
type To = { logistical?: MachineLogisticalStatus; functional?: MachineFunctionalStatus };

const as = async (authUserId: string) => {
  cookieJar.clear();
  await signIn(cookieJar, authUserId);
};
const post = (handler: Handler, body: object, params: Record<string, string> = {}) =>
  call(handler, { body, params, headers: SAME_ORIGIN });

/** Élément de changement de statut, `from` lu en base (l'état affiché). */
async function item(machineId: string, to: To, extra: object = {}) {
  const m = await prisma.machine.findUniqueOrThrow({ where: { id: machineId } });
  return { machineId, from: { logistical: m.logistical_status, functional: m.functional_status }, to, ...extra };
}
const setStatus = async (machineId: string, to: To, extra: object = {}, confirmRefunds?: string[]) =>
  post(statusRoute.POST, { items: [await item(machineId, to, extra)], ...(confirmRefunds ? { confirmRefunds } : {}) });
const machinesView = (batchId: string) => call(batchMachinesRoute.GET, { params: { batchId } });
const machine = (machineId: string) => call(machineRoute.GET, { params: { machineId } });
const receive = (batchId: string, body: object) => post(receptionsRoute.POST, body, { batchId });
const checkOk = (machineIds: string[], note?: string) => post(checkOkRoute.POST, { machineIds, ...(note ? { note } : {}) });
const assign = (lineId: string, body: object) => post(assignmentRoute.POST, body, { lineId });
const replace = (lineId: string, body: object) => post(replacementRoute.POST, body, { lineId });
const autoAssign = (batchId: string) => post(autoAssignRoute.POST, {}, { batchId });
const move = (batchId: string, from: string, to: string, note?: string) => post(transitionsRoute.POST, { from, to, note }, { batchId });

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({ status, code });
}

let catalog: Catalog;

/** Commande payée d'une machine (client nouveau), `paidAt` pour ordonner les paiements. */
async function paidLine(batchId: string, paidAt?: Date) {
  const orderId = await placeOrder({ catalog, batchId, customer: await createUser() });
  await pay(orderId, paidAt);
  const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
  return { orderId, lineId: line.id };
}

/** Palette au Contrôle, `n` machines reçues et OK. */
async function inspectedPalette(n: number) {
  const lot = await createBatch(catalog, { quantity: n, status: "inspection" });
  const machines = await machinesOf(lot);
  for (const m of machines) await receiveAndCheck(m.id);
  return { lot, machines };
}

beforeEach(async () => {
  catalog = await createCatalog();
  await as(ADMIN);
});

describe("accès", () => {
  it("whitelist sur les lectures et les écritures", async () => {
    await as("4242");
    expectError(await call(machinesRoute.GET), 403, "forbidden");
    expectError(await post(checkOkRoute.POST, { machineIds: [randomUUID()] }), 403, "forbidden");
    expectError(await call(stockRoute.GET), 403, "forbidden");
  });
});

describe("réception", () => {
  it("en bloc avec numéros collés : plus anciennes attendues d'abord, numéros dans l'ordre ; plus que prévu refusé", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "awaiting_reception" });
    const [m1, m2, m3] = await machinesOf(lot);
    const first = await receive(lot, { serials: [" S19-A1 ", "", "S19-A2"] });
    expect(first.status).toBe(201);
    expect(first.body.machines.map((m: { id: string; serial: string | null; logisticalStatus: string }) => [m.id, m.serial, m.logisticalStatus])).toEqual([
      [m1.id, "S19-A1", "in_stock"],
      [m2.id, "S19-A2", "in_stock"],
      [m3.id, null, "expected"],
    ]);
    expect(first.body.summary).toMatchObject({ expected: 1, received: 2, unchecked: 2 });
    expect(first.body.machines[0]).toMatchObject({ inHand: true, toRecheck: false, assignable: false, functionalLabel: "Non contrôlée" });

    const tooMany = await receive(lot, { serials: ["S19-A3", "S19-A4"] });
    expectError(tooMany, 409, "reception_exceeds_expected");
    expect(tooMany.body.error.details).toEqual({ expected: 1 });
    const taken = await receive(lot, { serials: ["S19-A1"] });
    expectError(taken, 409, "serial_taken");
    expect(taken.body.error.details).toEqual({ serials: ["S19-A1"] });
    expectError(await receive(lot, { serials: ["X", "X"] }), 400, "invalid_input");

    // Numéro de série obligatoire dès la réception : refusé sans numéro (rien n'est reçu), reçue avec
    const noSerial = await receive(lot, { count: 1 });
    expectError(noSerial, 422, "serial_required");
    expect(noSerial.body.error.details.machineIds).toHaveLength(1);
    expect((await machinesView(lot)).body.summary).toMatchObject({ expected: 1, received: 2 });
    expect((await receive(lot, { serials: ["S19-A3"] })).body.summary).toMatchObject({ expected: 0, received: 3 });
    expectError(await receive(lot, {}), 409, "reception_exceeds_expected");
    const log = await prisma.machineStatusChange.findFirstOrThrow({ where: { machine_id: m1.id } });
    expect(log).toMatchObject({ from_logistical: "expected", to_logistical: "in_stock", changed_by_auth_user_id: 1n });
  });

  it("machines choisies : seulement des machines attendues du lot ; lot annulé : figées", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "awaiting_reception" });
    const [m1, m2] = await machinesOf(lot);
    expect((await receive(lot, { machineIds: [m2.id], serials: ["B-2"] })).body.machines[1]).toMatchObject({ serial: "B-2", logisticalStatus: "in_stock" });
    expectError(await receive(lot, { machineIds: [m2.id] }), 409, "machine_not_expected");
    const other = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    expectError(await receive(other, { machineIds: [m1.id] }), 409, "machine_not_expected");

    await moveBatch(other, "awaiting_reception", "cancelled");
    expectError(await receive(other, { serials: ["Z-1"] }), 409, "machine_batch_frozen");
  });

  it("lot de stock : les machines d'un réassort se reçoivent pareil, à contrôler ensuite", async () => {
    const stock = await createStockBatch(catalog);
    await restock(catalog, stock, 2);
    const reply = await receive(stock, { serials: ["R-1", "R-2"] });
    expect(reply.body.summary).toMatchObject({ kind: "stock", expected: 0, unchecked: 2, sellableMachines: 0, capacity: 0 });
  });
});

describe("contrôle", () => {
  it("« Tout OK » en bloc : hashboards et état ; tout ou rien", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "awaiting_reception" });
    const [m1, m2, m3] = await machinesOf(lot);
    await receive(lot, { serials: ["T-1", "T-2"] });
    const reply = await checkOk([m1.id, m2.id]);
    expect(reply.status).toBe(201);
    for (const m of reply.body.machines) {
      expect(m).toMatchObject({ functionalStatus: "ok", functionalLabel: "OK", assignable: true });
      expect(m.hashboards.map((h: { status: string; current: boolean; checkedBy: string }) => [h.status, h.current, h.checkedBy])).toEqual([
        ["ok", true, ADMIN],
        ["ok", true, ADMIN],
        ["ok", true, ADMIN],
      ]);
    }
    // Une machine pas encore reçue : refus, rien n'est écrit pour l'autre
    await receive(lot, { serials: ["T-3"] });
    await setStatus(m3.id, { functional: "faulty" });
    expectError(await checkOk([m3.id]), 422, "note_required");
    const fixed = await checkOk([m3.id], "Erreur de saisie");
    expect(fixed.body.machines[0].functionalStatus).toBe("ok");
    const lot2 = await createBatch(catalog, { quantity: 2, status: "awaiting_reception" });
    const [n1, n2] = await machinesOf(lot2);
    await receive(lot2, { machineIds: [n1.id] });
    expectError(await checkOk([n1.id, n2.id]), 409, "machine_check_not_allowed");
    expect((await prisma.machine.findUniqueOrThrow({ where: { id: n1.id } })).functional_status).toBe("unknown");
  });

  it("hashboards une par une, cohérence avec l'état, correction avec motif", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    // Réception et contrôle dégradée d'un coup (hashboard morte) : sans numéro de série, refusé
    expectError(await setStatus(m.id, { logistical: "in_stock", functional: "degraded" }, { hashboards: [{ index: 1, status: "dead" }] }), 422, "serial_required");
    await prisma.machine.update({ where: { id: m.id }, data: { serial: "H-1" } });
    const degraded = await setStatus(m.id, { logistical: "in_stock", functional: "degraded" }, { hashboards: [{ index: 1, status: "dead" }] });
    expect(degraded.status).toBe(201);
    expect(degraded.body.machines[0]).toMatchObject({ logisticalStatus: "in_stock", functionalStatus: "degraded", functionalLabel: "Dégradée" });
    expect(degraded.body.machines[0].hashboards.map((h: { status: string | null }) => h.status)).toEqual([null, "dead", null]);

    expectError(await setStatus(m.id, { functional: "ok" }), 422, "note_required");
    expectError(await setStatus(m.id, { functional: "ok" }, { note: "Réparée", hashboards: [{ index: 0, status: "dead" }] }), 422, "hashboards_inconsistent");
    const board = await call(hashboardsRoute.PUT, { params: { machineId: m.id }, body: { hashboards: [{ index: 1, status: "ok" }] }, method: "PUT", headers: SAME_ORIGIN });
    expect(board.body.hashboards.map((h: { status: string | null }) => h.status)).toEqual([null, "ok", null]);
    const index = await call(hashboardsRoute.PUT, { params: { machineId: m.id }, body: { hashboards: [{ index: 5, status: "ok" }] }, method: "PUT", headers: SAME_ORIGIN });
    expectError(index, 422, "hashboard_index_out_of_range");
    const ok = await setStatus(m.id, { functional: "ok" }, { note: "Hashboard remplacée" });
    expect(ok.body.machines[0]).toMatchObject({ functionalStatus: "ok", sellable: true });
    expectError(await setStatus(m.id, { functional: "ok" }), 422, "machine_unchanged");
  });

  it("recontrôle d'une machine retournée (lot de stock) : vendable seulement après « Tout OK »", async () => {
    const stock = await createStockBatch(catalog);
    const [m] = (await restock(catalog, stock, 1)).machines;
    await receiveAndCheck(m.id);
    const sale = await paidLine(stock);
    expect((await assign(sale.lineId, { expectedMachineId: null, machineId: m.id })).status).toBe(201);
    for (const to of ["ready", "in_transit"] as const) expect((await setStatus(m.id, { logistical: to })).status).toBe(201);
    expect((await setStatus(m.id, { logistical: "returned" }, { note: "Refusée par le client" })).status).toBe(201);
    expectError(await setStatus(m.id, { logistical: "in_stock" }), 422, "note_required");
    expect((await setStatus(m.id, { logistical: "in_stock" }, { note: "Retour reçu" })).body.machines[0]).toMatchObject({
      logisticalStatus: "in_stock",
      functionalStatus: "ok",
      sellable: false,
      toRecheck: true,
    });
    // La commande est remboursée (retour) : la machine est à recontrôler avant d'être revendue
    const refunded = await post(cancelLinesRoute.POST, { reason: "Retour du client", cause: "shop_defective_machine" }, { orderId: sale.orderId });
    expect(refunded.status).toBe(200);
    expect((await machinesView(stock)).body.summary).toMatchObject({ sellableMachines: 0, toRecheck: 1, capacity: 0 });
    const rechecked = await checkOk([m.id]);
    expect(rechecked.body.machines[0]).toMatchObject({ sellable: true, toRecheck: false, assignable: true });
    expect((await machinesView(stock)).body.summary).toMatchObject({ sellableMachines: 1, toRecheck: 0, capacity: 1 });
  });
});

describe("statuts logistiques", () => {
  it("statut affiché périmé : refus ; plusieurs machines : tout ou rien ; remise au transporteur sans commande refusée", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const stale = { machineId: machines[0].id, from: { logistical: "expected", functional: "unknown" }, to: { logistical: "in_stock" } };
    expectError(await post(statusRoute.POST, { items: [stale] }), 409, "machine_status_changed");
    const both = [await item(machines[0].id, { logistical: "ready" }), await item(machines[1].id, { logistical: "in_transit" })];
    expectError(await post(statusRoute.POST, { items: both }), 409, "machine_transition_not_allowed");
    expect((await prisma.machine.findUniqueOrThrow({ where: { id: machines[0].id } })).logistical_status).toBe("in_stock");
    // Remise au transporteur d'une machine sans commande : refusée
    await setStatus(machines[0].id, { logistical: "ready" });
    expectError(await setStatus(machines[0].id, { logistical: "in_transit" }), 409, "machine_shipped_unassigned");
    const view = await machinesView(lot);
    const ready = view.body.machines.find((m: { id: string }) => m.id === machines[0].id);
    expect(ready.nextChanges.find((c: { to: string }) => c.to === "in_transit")).toMatchObject({
      action: "Remettre au transporteur",
      allowed: false,
    });
  });

  it("envoi de la facture : suivi à la remise (upsert Shipment), PATCH du suivi, facture incomplète refusée, DTO machine", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const orderId = await placeOrder({ catalog, batchId: lot, customer: await createUser(), lines: [false, false] });
    await pay(orderId);
    const lines = await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { id: "asc" } });
    await assign(lines[0].id, { machineId: machines[0].id, expectedMachineId: null });
    await setStatus(machines[0].id, { logistical: "ready" });
    // Suivi sur une machine sans commande payée, ou hors remise : refusé
    expectError(await setStatus(machines[1].id, { logistical: "ready" }, { tracking: { carrier: "DHL" } }), 400, "invalid_input");
    // Facture incomplète (ligne 2 sans machine) : 409 shipment_incomplete, rien d'écrit
    expectError(await setStatus(machines[0].id, { logistical: "in_transit" }, { tracking: { carrier: "DHL" } }), 409, "shipment_incomplete");
    expect(await prisma.shipment.count({ where: { order_id: orderId } })).toBe(0);
    await assign(lines[1].id, { machineId: machines[1].id, expectedMachineId: null });
    await setStatus(machines[1].id, { logistical: "ready" });
    const sent = await setStatus(machines[0].id, { logistical: "in_transit" }, {
      tracking: { carrier: "DHL", trackingNumber: "JD1", trackingUrl: "https://dhl.example/JD1" },
    });
    expect(sent.status).toBe(201);
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { order_id: orderId } });
    expect(shipment).toMatchObject({ carrier: "DHL", tracking_number: "JD1" });
    expect(shipment.shipped_at).not.toBeNull();
    const view = (await machine(machines[1].id)).body;
    expect(view).not.toHaveProperty("carrier");
    expect(view.shipment).toMatchObject({ carrier: "DHL", trackingNumber: "JD1", trackingUrl: "https://dhl.example/JD1", deliveredAt: null });
    expect(view.shipment.shippedAt).toBe(shipment.shipped_at!.toISOString());
    // PATCH du suivi : une seule ligne Shipment par facture ; lien invalide refusé
    const patch = async (body: object) =>
      call(machineRoute.PATCH, {
        params: { machineId: machines[1].id },
        body: { expectedUpdatedAt: (await machine(machines[1].id)).body.updatedAt, ...body },
        method: "PATCH",
        headers: SAME_ORIGIN,
      });
    expect((await patch({ carrier: "UPS", trackingNumber: null })).body.shipment).toMatchObject({ carrier: "UPS", trackingNumber: null });
    expectError(await patch({ trackingUrl: "ftp://x" }), 400, "invalid_input");
    expect(await prisma.shipment.count({ where: { order_id: orderId } })).toBe(1);
    // Machine sans commande payée : suivi refusé
    const free = await inspectedPalette(1);
    const noOrder = await call(machineRoute.PATCH, {
      params: { machineId: free.machines[0].id },
      body: { expectedUpdatedAt: (await machine(free.machines[0].id)).body.updatedAt, carrier: "DHL" },
      method: "PATCH",
      headers: SAME_ORIGIN,
    });
    expectError(noOrder, 409, "shipment_no_order");
    expect((await machine(free.machines[0].id)).body.shipment).toBeNull();
  });

  it("machine perdue en transit : ligne à remplacer, remplacée par une machine libre ; retrouvée, à recontrôler", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const sale = await paidLine(lot);
    await assign(sale.lineId, { expectedMachineId: null, machineId: machines[0].id });
    await setStatus(machines[0].id, { logistical: "ready" });
    const shipped = await setStatus(machines[0].id, { logistical: "in_transit" });
    expect(shipped.body.machines[0].shippedAt).not.toBeNull();
    expectError(await setStatus(machines[0].id, { logistical: "lost" }), 422, "note_required");
    // Remise au transporteur : la machine ne se remplace plus
    expectError(await replace(sale.lineId, { expectedMachineId: machines[0].id, reason: "Erreur" }), 409, "machine_shipped");
    await setStatus(machines[0].id, { logistical: "lost" }, { note: "Colis perdu" });

    const view = await machinesView(lot);
    expect(view.body.lines[0]).toMatchObject({ problem: "lost", machineId: machines[0].id });
    expect(view.body.summary).toMatchObject({ linesToReplace: 1, lost: 1 });
    const replaced = await replace(sale.lineId, { expectedMachineId: machines[0].id, reason: "Colis perdu" });
    expect(replaced.body.lines[0]).toMatchObject({ machineId: machines[1].id, problem: null });
    await setStatus(machines[0].id, { logistical: "in_stock" }, { note: "Retrouvée au dépôt" });
    expect((await machine(machines[0].id)).body).toMatchObject({ logisticalStatus: "in_stock", toRecheck: true, line: null });
  });
});

describe("machines en moins : la commande payée la plus récente est remboursée", () => {
  it("palette pleine, machine non attribuée qui meurt : 409 sans rien écrire, puis confirmation exacte", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const alice = await paidLine(lot, new Date(Date.now() - 60_000));
    const bob = await paidLine(lot, new Date(Date.now() - 30_000));
    const dying = { functional: "faulty" } as const;

    const refused = await setStatus(machines[0].id, dying, { note: "Ne démarre plus" });
    expectError(refused, 409, "machine_shortage");
    expect(refused.body.error.message).toBe(
      "Il n'y a plus assez de machines pour toutes les commandes payées du lot : la commande payée la plus récente sera remboursée pour une machine (frais à la charge de la boutique). Confirmez pour continuer.",
    );
    expect(refused.body.error.details.refunds).toEqual([
      { lineId: bob.lineId, orderId: bob.orderId, batchId: lot, paidAt: expect.any(String), contactEmail: CONTACT_EMAIL, amount: RESALE.toString() },
    ]);
    expect((await prisma.machine.findUniqueOrThrow({ where: { id: machines[0].id } })).functional_status).toBe("ok");

    expectError(await setStatus(machines[0].id, dying, { note: "Ne démarre plus" }, [alice.lineId]), 409, "machine_shortage");
    const done = await setStatus(machines[0].id, dying, { note: "Ne démarre plus" }, [bob.lineId]);
    expect(done.status).toBe(201);
    expect(done.body.refunds.map((r: { lineId: string }) => r.lineId)).toEqual([bob.lineId]);
    expect(done.body.machines[0]).toMatchObject({ functionalStatus: "faulty" });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: bob.orderId } })).toMatchObject({ status: "refunded" });
    expect(await prisma.refund.findFirstOrThrow({ where: { order_id: bob.orderId } })).toMatchObject({
      kind: "cancellation",
      cause: "shop_defective_machine",
      network_fee_payer: "shop",
      initiated_by: "admin",
      created_by_auth_user_id: 1n,
      amount: RESALE,
    });
    expect((await machinesView(lot)).body.summary).toMatchObject({ paidLines: 1, faulty: 1, writtenOff: 1, surplusLines: 0 });
  });

  it("concurrence : deux machines libres qui meurent en même temps sur un lot presque plein : la seconde demande le remboursement", async () => {
    const { lot, machines } = await inspectedPalette(3);
    await paidLine(lot, new Date(Date.now() - 60_000));
    const bob = await paidLine(lot, new Date(Date.now() - 30_000));
    const changes = await Promise.all([
      setStatus(machines[0].id, { functional: "faulty" }, { note: "Morte" }),
      setStatus(machines[1].id, { functional: "faulty" }, { note: "Morte" }),
    ]);
    expect(changes.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = changes.find((r) => r.status === 409)!;
    expect(refused.body.error.code).toBe("machine_shortage");
    expect(refused.body.error.details.refunds.map((r: { lineId: string }) => r.lineId)).toEqual([bob.lineId]);
    expect(await prisma.machine.count({ where: { batch_id: lot, functional_status: "faulty" } })).toBe(1);
  });

  it("machine jamais reçue (manquante) : remboursement pour souci de stock", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    const sale = await paidLine(lot);
    const refused = await setStatus(m.id, { logistical: "missing" }, { note: "Absente de la palette" });
    expectError(refused, 409, "machine_shortage");
    await setStatus(m.id, { logistical: "missing" }, { note: "Absente de la palette" }, [sale.lineId]);
    expect(await prisma.refund.findFirstOrThrow({ where: { order_id: sale.orderId } })).toMatchObject({ cause: "shop_stock", network_fee_payer: "shop" });
  });

  it("factures en attente qui occupent la dernière place : 409 machine_shortage_reserved", async () => {
    const { lot, machines } = await inspectedPalette(2);
    await paidLine(lot);
    await placeOrder({ catalog, batchId: lot, customer: await createUser() });
    const refused = await setStatus(machines[0].id, { functional: "faulty" }, { note: "Morte" });
    expectError(refused, 409, "machine_shortage_reserved");
    expect(refused.body.error.details).toEqual({ pendingOrders: 1, refunds: [] });
  });

  it("lot de stock : une machine vendable qui se dégrade alors qu'une commande payée l'attend fait rembourser la commande", async () => {
    const stock = await createStockBatch(catalog);
    const [m] = (await restock(catalog, stock, 1)).machines;
    await receiveAndCheck(m.id);
    const sale = await paidLine(stock);
    const change = { note: "Hashboard morte", hashboards: [{ index: 2, status: "dead" }] };
    const refused = await setStatus(m.id, { functional: "degraded" }, change);
    expectError(refused, 409, "machine_shortage");
    const done = await setStatus(m.id, { functional: "degraded" }, change, [sale.lineId]);
    expect(done.status).toBe(201);
    expect(await prisma.refund.findFirstOrThrow({ where: { order_id: sale.orderId } })).toMatchObject({ cause: "shop_defective_machine" });
    expect((await machinesView(stock)).body.summary).toMatchObject({ capacity: 0, paidLines: 0, degraded: 1 });
  });

  it("lot de stock : la ligne remboursée est la commande sans machine, jamais la vente plus récente déjà livrée (R4b, B1)", async () => {
    const stock = await createStockBatch(catalog);
    const [x, y] = (await restock(catalog, stock, 2)).machines;
    for (const m of [x, y]) await receiveAndCheck(m.id);
    const online = await paidLine(stock, new Date(Date.now() - 60_000));
    const counter = await paidLine(stock, new Date(Date.now() - 30_000));
    await assign(counter.lineId, { expectedMachineId: null, machineId: y.id });
    for (const logistical of ["ready", "in_transit", "delivered"] as const) await changeMachine(prisma, y.id, { logistical });
    const dying = { functional: "faulty" } as const;

    const refused = await setStatus(x.id, dying, { note: "Ne démarre plus" });
    expectError(refused, 409, "machine_shortage");
    expect(refused.body.error.details.refunds.map((r: { lineId: string }) => r.lineId)).toEqual([online.lineId]);
    // Confirmer la vente livrée n'est pas la liste annoncée : nouveau 409 machine_shortage, jamais « retry » en boucle
    expectError(await setStatus(x.id, dying, { note: "Ne démarre plus" }, [counter.lineId]), 409, "machine_shortage");
    const done = await setStatus(x.id, dying, { note: "Ne démarre plus" }, [online.lineId]);
    expect(done.status).toBe(201);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: online.orderId } })).toMatchObject({ status: "refunded" });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: counter.orderId } })).toMatchObject({ status: "paid" });
    expect((await machinesView(stock)).body.summary).toMatchObject({ capacity: 1, paidLines: 1, surplusLines: 0 });
  });
});

describe("attribution", () => {
  it("manuelle : machine affichée vérifiée, motif pour un remplacement ou une machine dégradée, palette au Contrôle", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "awaiting_reception" });
    const [m1, m2, m3] = await machinesOf(lot);
    for (const m of [m1, m2]) await receiveAndCheck(m.id);
    await receiveAndCheck(m3.id, "degraded");
    const a = await paidLine(lot);
    const b = await paidLine(lot);
    expectError(await assign(a.lineId, { expectedMachineId: null, machineId: m1.id }), 409, "assignment_batch_status");
    await moveBatch(lot, "awaiting_reception", "inspection");

    const first = await assign(a.lineId, { expectedMachineId: null, machineId: m1.id });
    expect(first.status).toBe(201);
    expect(first.body.lines.find((l: { lineId: string }) => l.lineId === a.lineId)).toMatchObject({
      machineId: m1.id,
      customer: { contactEmail: CONTACT_EMAIL },
      configuration: [{ option: "Kit de ventilation", value: "Sans kit" }],
      problem: null,
      surplusRank: null,
    });
    expect(first.body.refunds).toEqual([]);
    expectError(await assign(a.lineId, { expectedMachineId: null, machineId: m2.id }), 409, "assignment_changed");
    expectError(await assign(a.lineId, { expectedMachineId: m1.id, machineId: m2.id }), 422, "reason_required");
    expectError(await assign(b.lineId, { expectedMachineId: null, machineId: m1.id }), 409, "machine_already_assigned");
    expectError(await assign(b.lineId, { expectedMachineId: null, machineId: m3.id }), 422, "reason_required");
    // Machine dégradée : motif ET acceptation explicite du client (enregistrée : qui, quand)
    expectError(await assign(b.lineId, { expectedMachineId: null, machineId: m3.id, reason: "Rabais" }), 422, "degraded_acceptance_required");
    expectError(await assign(b.lineId, { expectedMachineId: null, machineId: m3.id, reason: "Rabais", customerAcceptsDegraded: false }), 422, "degraded_acceptance_required");
    const before = Date.now();
    const degraded = await assign(b.lineId, { expectedMachineId: null, machineId: m3.id, reason: "Client d'accord, rabais", customerAcceptsDegraded: true });
    expect(degraded.status).toBe(201);
    const degradedLine = degraded.body.lines.find((l: { lineId: string }) => l.lineId === b.lineId);
    expect(degradedLine).toMatchObject({ machineId: m3.id, problem: "degraded" });
    expect(new Date(degradedLine.degradedAcceptedAt).getTime()).toBeGreaterThan(before - 5000);
    const journal = await prisma.orderLineAssignment.findFirstOrThrow({ where: { order_line_id: b.lineId, machine_id: m3.id } });
    const lineRow = await prisma.orderLine.findUniqueOrThrow({ where: { id: b.lineId } });
    expect(journal.degraded_accepted_by_user_id).toBe(lineRow.user_id);
    // Une machine OK ignore l'acceptation (rien n'est enregistré)
    expect(first.body.lines.find((l: { lineId: string }) => l.lineId === a.lineId).degradedAcceptedAt).toBeNull();
    expect((await assign(a.lineId, { expectedMachineId: m1.id, machineId: m2.id, reason: "Erreur d'étiquette" })).status).toBe(201);

    const other = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const [foreign] = await machinesOf(other);
    await receiveAndCheck(foreign.id);
    expectError(await assign(a.lineId, { expectedMachineId: m2.id, machineId: foreign.id, reason: "Test" }), 409, "machine_not_assignable");
    expectError(await assign(randomUUID(), { expectedMachineId: null, machineId: m1.id }), 404, "line_not_found");

    const detail = await machine(m1.id);
    expect(detail.body.assignments.map((x: { machineId: string | null; reason: string | null }) => [x.machineId, x.reason])).toEqual([
      [m1.id, null],
      [m2.id, "Erreur d'étiquette"],
    ]);
  });

  it("automatique : premier payé d'abord, machines prêtes d'abord ; jamais une dégradée ni une non contrôlée", async () => {
    const lot = await createBatch(catalog, { quantity: 4, status: "inspection" });
    const [inStock, ready, degraded, unchecked] = await machinesOf(lot);
    await receiveAndCheck(inStock.id);
    await receiveAndCheck(ready.id);
    await setStatus(ready.id, { logistical: "ready" });
    await receiveAndCheck(degraded.id, "degraded");
    await setStatus(unchecked.id, { logistical: "in_stock" });
    const t = Date.now();
    const late = await paidLine(lot, new Date(t - 10_000));
    const first = await paidLine(lot, new Date(t - 90_000));
    const second = await paidLine(lot, new Date(t - 50_000));

    const reply = await autoAssign(lot);
    expect(reply.status).toBe(201);
    expect(reply.body.assigned).toBe(2);
    expect(reply.body.lines.map((l: { lineId: string; machineId: string | null }) => [l.lineId, l.machineId])).toEqual([
      [first.lineId, ready.id],
      [second.lineId, inStock.id],
      [late.lineId, null],
    ]);
    expect((await autoAssign(lot)).body.assigned).toBe(0);
    const ordering = await createBatch(catalog, { quantity: 1, status: "ordering" });
    expectError(await autoAssign(ordering), 409, "assignment_batch_status");
  });

  it("concurrence : deux attributions automatiques simultanées n'attribuent chaque machine qu'une fois", async () => {
    const { lot, machines } = await inspectedPalette(3);
    for (let i = 0; i < 3; i++) await paidLine(lot, new Date(Date.now() - (10 - i) * 1_000));
    const replies = await Promise.all([autoAssign(lot), autoAssign(lot)]);
    expect(replies.map((r) => r.status)).toEqual([201, 201]);
    expect(replies[0].body.assigned + replies[1].body.assigned).toBe(3);
    const lines = await prisma.orderLine.findMany({ where: { batch_id: lot } });
    expect(new Set(lines.map((l) => l.machine_id))).toEqual(new Set(machines.map((m) => m.id)));
    expect(await prisma.orderLineAssignment.count({ where: { batch_id: lot } })).toBe(3);
  });

  it("concurrence : la même machine attribuée à deux lignes en même temps : une seule attribution passe", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const a = await paidLine(lot);
    const b = await paidLine(lot);
    const replies = await Promise.all([
      assign(a.lineId, { expectedMachineId: null, machineId: machines[0].id }),
      assign(b.lineId, { expectedMachineId: null, machineId: machines[0].id }),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(replies.find((r) => r.status === 409)!.body.error.code).toBe("machine_already_assigned");
    expect(await prisma.orderLine.count({ where: { batch_id: lot, machine_id: machines[0].id } })).toBe(1);
  });

  it("remplacement en un clic : machine libre OK choisie par le serveur ; la machine morte part ensuite au rebut", async () => {
    const { lot, machines } = await inspectedPalette(3);
    const a = await paidLine(lot);
    const b = await paidLine(lot);
    await assign(a.lineId, { expectedMachineId: null, machineId: machines[0].id });
    await assign(b.lineId, { expectedMachineId: null, machineId: machines[1].id });
    // Machine attribuée qui meurt : elle compte par sa ligne, aucun remboursement
    const dead = await setStatus(machines[0].id, { functional: "faulty" }, { note: "Alimentation morte" });
    expect(dead.status).toBe(201);
    expect((await machinesView(lot)).body.lines[0]).toMatchObject({ lineId: a.lineId, problem: "faulty" });
    expectError(await replace(a.lineId, { expectedMachineId: machines[1].id, reason: "Morte" }), 409, "assignment_changed");
    const replaced = await replace(a.lineId, { expectedMachineId: machines[0].id, reason: "Machine morte" });
    expect(replaced.status).toBe(201);
    expect(replaced.body.lines[0]).toMatchObject({ lineId: a.lineId, machineId: machines[2].id, problem: null });
    expect((await setStatus(machines[0].id, { logistical: "scrapped" }, { note: "Alimentation morte" })).status).toBe(201);
    expect((await machinesView(lot)).body.summary).toMatchObject({ scrapped: 1, linesToReplace: 0, surplusLines: 0, paidLines: 2 });
  });

  it("remplacement sans machine libre : la commande la plus récente est remboursée et sa machine donnée à cette ligne", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const alice = await paidLine(lot, new Date(Date.now() - 60_000));
    const bob = await paidLine(lot, new Date(Date.now() - 30_000));
    await assign(alice.lineId, { expectedMachineId: null, machineId: machines[0].id });
    await assign(bob.lineId, { expectedMachineId: null, machineId: machines[1].id });
    await setStatus(machines[0].id, { functional: "faulty" }, { note: "Morte" });
    expect((await machinesView(lot)).body.lines.map((l: { surplusRank: number | null }) => l.surplusRank)).toEqual([null, 2]);

    const body = { expectedMachineId: machines[0].id, reason: "Machine morte" };
    const refused = await replace(alice.lineId, body);
    expectError(refused, 409, "machine_shortage");
    expect(refused.body.error.details.refunds.map((r: { lineId: string }) => r.lineId)).toEqual([bob.lineId]);
    const done = await replace(alice.lineId, { ...body, confirmRefunds: [bob.lineId] });
    expect(done.status).toBe(201);
    expect(done.body.lines).toEqual([expect.objectContaining({ lineId: alice.lineId, machineId: machines[1].id })]);
    expect(done.body.refunds.map((r: { orderId: string }) => r.orderId)).toEqual([bob.orderId]);
    expect(await prisma.refund.findFirstOrThrow({ where: { order_id: bob.orderId } })).toMatchObject({ cause: "shop_defective_machine" });
  });

  it("remplacement d'une ligne elle-même en trop : elle est simplement remboursée", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const alice = await paidLine(lot, new Date(Date.now() - 60_000));
    const bob = await paidLine(lot, new Date(Date.now() - 30_000));
    await assign(alice.lineId, { expectedMachineId: null, machineId: machines[0].id });
    await assign(bob.lineId, { expectedMachineId: null, machineId: machines[1].id });
    await setStatus(machines[1].id, { functional: "faulty" }, { note: "Morte" });
    const body = { expectedMachineId: machines[1].id, reason: "Machine morte" };
    const refused = await replace(bob.lineId, body);
    expect(refused.body.error.details.refunds.map((r: { lineId: string }) => r.lineId)).toEqual([bob.lineId]);
    const done = await replace(bob.lineId, { ...body, confirmRefunds: [bob.lineId] });
    expect(done.body.lines).toEqual([expect.objectContaining({ lineId: alice.lineId, machineId: machines[0].id })]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: bob.orderId } })).toMatchObject({ status: "refunded" });
  });
});

describe("machine reçue en plus d'une palette", () => {
  it("créée reçue au lot de stock du modèle (créé en pause), origine la palette ; seulement palette pleine et toute reçue", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const extra = (body: object) => post(extraMachinesRoute.POST, body, { batchId: lot });
    const pending = await extra({});
    expectError(pending, 409, "palette_has_expected");
    expect(pending.body.error.details).toEqual({ expected: 1 });
    await receive(lot, { serials: ["P-1"] });
    expectError(await extra({ serials: ["P-1"] }), 409, "serial_taken");

    const reply = await extra({ serials: ["P-2", "P-3"], note: "Deux de plus dans le colis" });
    expect(reply.status).toBe(201);
    const stock = await prisma.batch.findFirstOrThrow({ where: { model_id: catalog.modelId, kind: "stock" } });
    expect(stock).toMatchObject({ status: "draft", name: "Stock S19" });
    expect(reply.body.stockBatchId).toBe(stock.id);
    expect(reply.body.machines.map((m: { serial: string; batchId: string; originBatchId: string; logisticalStatus: string; note: string }) => [m.serial, m.batchId, m.originBatchId, m.logisticalStatus, m.note])).toEqual([
      ["P-2", stock.id, lot, "in_stock", "Deux de plus dans le colis"],
      ["P-3", stock.id, lot, "in_stock", "Deux de plus dans le colis"],
    ]);
    expect((await machinesView(lot)).body.summary).toMatchObject({ machines: 1, capacity: 1 });
    expect((await machinesView(stock.id)).body.summary).toMatchObject({ machines: 2, unchecked: 2 });

    expectError(await post(extraMachinesRoute.POST, {}, { batchId: stock.id }), 409, "not_palette");
    const ordering = await createBatch(catalog, { quantity: 1, status: "ordering" });
    expectError(await post(extraMachinesRoute.POST, {}, { batchId: ordering }), 409, "machine_origin");
  });
});

describe("lectures", () => {
  it("liste filtrée (lot, statuts, recherche par numéro), fiche (journal, origine, transferts), stock par modèle", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "awaiting_reception" });
    const [m1, m2] = await machinesOf(lot);
    await receive(lot, { serials: ["ABC-001", "abc-002"] });
    await checkOk([m1.id]);
    const stock = await createStockBatch(catalog);
    await restock(catalog, stock, 1);

    const list = (query: string) => call(machinesRoute.GET, { path: `/api/backoffice/machines?${query}` });
    expect((await list(`batchId=${lot}`)).body).toMatchObject({ total: 3, page: 1, pageSize: 100 });
    expect((await list(`batchId=${lot}&logistical=in_stock`)).body.total).toBe(2);
    expect((await list(`logistical=expected`)).body.total).toBe(2);
    expect((await list(`functional=ok`)).body.items.map((m: { id: string }) => m.id)).toEqual([m1.id]);
    expect((await list(`q=abc-00`)).body.items.map((m: { serial: string }) => m.serial)).toEqual(["ABC-001", "abc-002"]);
    expect((await list(`q=%25`)).body.total).toBe(0);
    expect((await list(`batchId=${lot}&pageSize=1&page=2`)).body.items.map((m: { id: string }) => m.id)).toEqual([m2.id]);
    expectError(await list(`logistical=nowhere`), 400, "invalid_input");

    const detail = await machine(m1.id);
    expect(detail.body).toMatchObject({
      batch: { id: lot, kind: "wholesale", statusLabel: "Attente de réception" },
      originBatch: { id: lot },
      restockId: null,
      logisticalLabel: "En stock",
      assignments: [],
      transfers: [],
    });
    expect(detail.body.statusChanges.map((c: { toLogistical: string; toFunctional: string }) => [c.toLogistical, c.toFunctional])).toEqual([
      ["in_stock", "unknown"],
      ["in_stock", "ok"],
    ]);
    expectError(await machine(randomUUID()), 404, "machine_not_found");
    expectError(await machine("pas-un-uuid"), 404, "machine_not_found");

    const view = await call(stockRoute.GET);
    expect(view.body.items).toEqual([
      {
        model: { id: catalog.modelId, name: "S19" },
        stockBatch: { id: stock, name: "Stock S19", status: "on_sale", statusLabel: "En vente" },
        expected: 1,
        toCheck: 0,
        sellable: 0,
        available: 0,
        reserved: 0,
        assigned: 0,
        assignedDegraded: 0,
        degraded: 0,
        faulty: 0,
        inPalettes: 2,
        inPalettesDegraded: 0,
      },
    ]);
  });

  it("PATCH : numéros de série et note ; état affiché périmé refusé ; numéro déjà pris refusé", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "awaiting_reception" });
    const [m1, m2] = await machinesOf(lot);
    const patch = async (machineId: string, body: object) =>
      call(machineRoute.PATCH, {
        params: { machineId },
        body: { expectedUpdatedAt: (await machine(machineId)).body.updatedAt, ...body },
        method: "PATCH",
        headers: SAME_ORIGIN,
      });
    const done = await patch(m1.id, { serial: "M-1", psuSerial: "APW-1", note: "Rayure" });
    expect(done.body).toMatchObject({ serial: "M-1", psuSerial: "APW-1", note: "Rayure" });
    expectError(await patch(m2.id, { serial: "M-1" }), 409, "serial_taken");
    const stale = await call(machineRoute.PATCH, {
      params: { machineId: m1.id },
      body: { expectedUpdatedAt: "2020-01-01T00:00:00.000000Z", note: null },
      method: "PATCH",
      headers: SAME_ORIGIN,
    });
    expectError(stale, 409, "machine_modified");
  });
});

describe("parcours complets", () => {
  it("palette : réception → contrôle → attribution → expédition → livraison → clôture (invendu au stock)", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "preorder" });
    const sales = [await paidLine(lot, new Date(Date.now() - 60_000)), await paidLine(lot, new Date(Date.now() - 30_000))];
    await moveBatch(lot, "preorder", "ordering");
    expect((await move(lot, "ordering", "awaiting_reception")).status).toBe(201);
    const received = await receive(lot, { serials: ["F-1", "F-2", "F-3"] });
    expect(received.body.summary).toMatchObject({ expected: 0, received: 3, unchecked: 3 });
    expect((await move(lot, "awaiting_reception", "inspection")).status).toBe(201);
    // Lignes payées sans machine : blocage nommé (jalon 5 bis) avant « machines non contrôlées »
    expect((await call(transitionsRoute.POST, { params: { batchId: lot }, body: { from: "inspection", to: "packaging" }, headers: SAME_ORIGIN })).body.error.code).toBe(
      "packaging_unassigned_lines",
    );
    const ids = received.body.machines.map((m: { id: string }) => m.id);
    await checkOk(ids);
    expect((await autoAssign(lot)).body.assigned).toBe(2);
    expect((await move(lot, "inspection", "packaging")).status).toBe(201);

    const view = await machinesView(lot);
    const sold = view.body.lines.map((l: { machineId: string }) => l.machineId);
    expect(view.body.lines.map((l: { lineId: string }) => l.lineId)).toEqual(sales.map((s) => s.lineId));
    const items = async (to: To, extra: object = {}) => Promise.all(sold.map((id: string) => item(id, to, extra)));
    expect((await post(statusRoute.POST, { items: await items({ logistical: "ready" }) })).status).toBe(201);
    const shipped = await post(statusRoute.POST, { items: await items({ logistical: "in_transit" }) });
    expect(shipped.status).toBe(201);
    expect((await move(lot, "packaging", "in_transit")).status).toBe(201);
    expect((await post(statusRoute.POST, { items: await items({ logistical: "delivered" }) })).status).toBe(201);

    const closed = await move(lot, "in_transit", "closed");
    expect(closed.status).toBe(201);
    expect(closed.body.counters.transferredOut).toBe(1);
    const stock = await prisma.batch.findFirstOrThrow({ where: { model_id: catalog.modelId, kind: "stock" } });
    expect((await machinesView(stock.id)).body.machines).toEqual([
      expect.objectContaining({ originBatchId: lot, batchId: stock.id, sellable: true, assignable: true }),
    ]);
  });

  it("stock : réassort → réception → contrôle → vente en ligne → attribution (lot en pause) → expédition → livraison", async () => {
    const stock = await createStockBatch(catalog);
    const restocked = await post(restocksRoute.POST, { quantity: 2, purchasePrice: "180000", note: "Fournisseur" }, { batchId: stock });
    expect(restocked.status).toBe(201);
    const received = await receive(stock, { serials: ["ST-1", "ST-2"] });
    const ids = received.body.machines.map((m: { id: string }) => m.id);
    await checkOk(ids);
    expect((await machinesView(stock)).body.summary).toMatchObject({ sellableMachines: 2, capacity: 2 });

    // Vente en ligne par la boutique, paiement par le service de paiement
    await as("4001");
    const order = await post(ordersRoute.POST, {
      batchId: stock,
      lines: [{}],
      billingAddress: { fullName: "Alice Martin", line1: "1 rue de la Paix", postalCode: "69001", city: "Lyon", country: "FR" },
      contactEmail: "alice@exemple.fr",
      refundAddress: REFUND_ADDRESS,
    });
    expect(order.status).toBe(201);
    const paid = await call(paymentsRoute.POST, {
      body: { address: order.body.payment.address, txid: randomUUID(), vout: 0, amountSats: order.body.payment.expectedSats },
      headers: { authorization: `Bearer ${TEST_PAYMENT_SECRET}` },
    });
    expect(paid.status).toBe(201);
    await as(ADMIN);
    // Encaissement : la machine est attribuée d'office ; le lot mis en pause, l'attribution automatique n'a plus rien à faire
    expect((await move(stock, "on_sale", "draft")).status).toBe(201);
    const assigned = await autoAssign(stock);
    expect(assigned.body.assigned).toBe(0);
    expect(assigned.body.summary).toMatchObject({ sellableMachines: 1, assignedLines: 1, capacity: 2 });
    const line = { machineId: (await prisma.orderLine.findFirstOrThrow({ where: { order_id: order.body.id } })).machine_id! };

    for (const to of ["ready", "in_transit", "delivered"] as const) expect((await setStatus(line.machineId, { logistical: to })).status).toBe(201);
    const delivered = await machine(line.machineId);
    expect(delivered.body).toMatchObject({ logisticalStatus: "delivered", logisticalLabel: "Livrée", nextChanges: [] });
    expect(delivered.body.deliveredAt).not.toBeNull();
    const stockRow = (await call(stockRoute.GET)).body.items[0];
    expect(stockRow).toMatchObject({ sellable: 1, available: 1, reserved: 0, assigned: 0, stockBatch: { statusLabel: "En pause" } });
  });
});
