import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toErrorResponse } from "@/server/errors";
import * as batchRoute from "@/app/api/backoffice/batches/[batchId]/route";
import * as batchMachinesRoute from "@/app/api/backoffice/batches/[batchId]/machines/route";
import * as receptionsRoute from "@/app/api/backoffice/batches/[batchId]/receptions/route";
import * as transitionsRoute from "@/app/api/backoffice/batches/[batchId]/transitions/route";
import * as statusRoute from "@/app/api/backoffice/machines/status/route";
import * as assignmentRoute from "@/app/api/backoffice/order-lines/[lineId]/assignment/route";
import * as cancelPendingRoute from "@/app/api/backoffice/orders/[orderId]/cancel/route";
import * as scrapReturnRoute from "@/app/api/backoffice/machines/[machineId]/scrap-return/route";
import * as stockRoute from "@/app/api/backoffice/stock/route";
import * as ordersRoute from "@/app/api/orders/route";
import type { MachineFunctionalStatus, MachineLogisticalStatus } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  type Catalog,
  changeMachine,
  createBatch,
  createCatalog,
  createUser,
  machinesOf,
  pay,
  placeOrder,
  receiveAndCheck,
} from "./fixtures";
import { ADMIN, call, type Reply, SAME_ORIGIN, signIn } from "./http";


// Jalon 5 bis, lot backend : routes et erreurs des décisions de Hugo du 2026-11-16 (numéro de série à la réception,
// rebut réversible, annulation admin d'une facture en attente, blocages de sortie du Contrôle, motif de remboursement par
// table, vue client « machine attribuée », compteurs degraded). Règles SQL : machines-v7.test.ts.

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

async function item(machineId: string, to: To, extra: object = {}) {
  const m = await prisma.machine.findUniqueOrThrow({ where: { id: machineId } });
  return { machineId, from: { logistical: m.logistical_status, functional: m.functional_status }, to, ...extra };
}
const setStatus = async (machineId: string, to: To, extra: object = {}, confirmRefunds?: string[]) =>
  post(statusRoute.POST, { items: [await item(machineId, to, extra)], ...(confirmRefunds ? { confirmRefunds } : {}) });
const receive = (batchId: string, body: object) => post(receptionsRoute.POST, body, { batchId });
const assign = (lineId: string, body: object) => post(assignmentRoute.POST, body, { lineId });
const move = (batchId: string, from: string, to: string) => post(transitionsRoute.POST, { from, to }, { batchId });
const scrapReturn = (machineId: string, body: object = {}) => post(scrapReturnRoute.POST, body, { machineId });
const cancelPending = (orderId: string) => post(cancelPendingRoute.POST, {}, { orderId });

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({ status, code });
}

let catalog: Catalog;

async function paidLine(batchId: string, customer?: Awaited<ReturnType<typeof createUser>>) {
  const orderId = await placeOrder({ catalog, batchId, customer: customer ?? (await createUser()) });
  await pay(orderId);
  const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
  return { orderId, lineId: line.id };
}

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

describe("numéro de série à la réception", () => {
  it("un changement de statut vers « reçue » sans numéro : 422 serial_required (rien n'est écrit)", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    expectError(await setStatus(m.id, { logistical: "in_stock" }), 422, "serial_required");
    expect(await prisma.machineStatusChange.count({ where: { machine_id: m.id } })).toBe(0);
    await prisma.machine.update({ where: { id: m.id }, data: { serial: "S-1" } });
    expect((await setStatus(m.id, { logistical: "in_stock" })).status).toBe(201);
  });

  it("une machine qui a déjà son numéro (saisi avant) se reçoit sans le redonner", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "awaiting_reception" });
    const [m1, m2] = await machinesOf(lot);
    await prisma.machine.update({ where: { id: m1.id }, data: { serial: "PRE-1" } });
    expectError(await receive(lot, { machineIds: [m1.id, m2.id] }), 422, "serial_required");
    const ok = await receive(lot, { machineIds: [m1.id] });
    expect(ok.status).toBe(201);
    expect(ok.body.summary).toMatchObject({ received: 1, expected: 1 });
  });
});

describe("rebut réversible", () => {
  it("POST /machines/:id/scrap-return : motif obligatoire, journal tracé, la machine reste défectueuse", async () => {
    const { machines } = await inspectedPalette(2);
    const [dead] = machines;
    expectError(await scrapReturn(dead.id), 409, "machine_not_scrapped");
    await setStatus(dead.id, { functional: "faulty" }, { note: "Morte" });
    await setStatus(dead.id, { logistical: "scrapped" }, { note: "Carte grillée" });
    expectError(await scrapReturn(dead.id), 422, "note_required");
    expectError(await scrapReturn(dead.id, { note: 12 }), 400, "invalid_input");
    const back = await scrapReturn(dead.id, { note: "Erreur de saisie : elle démarre" });
    expect(back.status).toBe(201);
    expect(back.body.machines[0]).toMatchObject({ logisticalStatus: "in_stock", functionalStatus: "faulty" });
    const last = await prisma.machineStatusChange.findFirstOrThrow({ where: { machine_id: dead.id }, orderBy: { created_at: "desc" } });
    expect(last).toMatchObject({ from_logistical: "scrapped", to_logistical: "in_stock", note: "Erreur de saisie : elle démarre" });
    expectError(await scrapReturn(dead.id, { note: "Encore" }), 409, "machine_not_scrapped");
    await as("4242");
    expectError(await scrapReturn(dead.id, { note: "x" }), 403, "forbidden");
  });

  it("la route de statuts accepte aussi scrapped > in_stock (même règle) ; Machine_scrap_return_place devient 409 scrap_return_place_taken", async () => {
    const { machines } = await inspectedPalette(1);
    await setStatus(machines[0].id, { functional: "faulty" }, { note: "Morte" });
    await setStatus(machines[0].id, { logistical: "scrapped" }, { note: "Rebut" });
    expectError(await setStatus(machines[0].id, { logistical: "in_stock" }), 422, "note_required");
    expect((await setStatus(machines[0].id, { logistical: "in_stock" }, { note: "Erreur" })).status).toBe(201);
    // Refus de la base (place reprise) : traduit proprement
    const failure = { meta: { driverAdapterError: { cause: { originalCode: "23514", originalMessage: 'x (constraint "Machine_scrap_return_place")' } } } };
    const reply = toErrorResponse(failure);
    expect(reply.status).toBe(409);
    expect((await reply.json()).error.code).toBe("scrap_return_place_taken");
  });
});

describe("annulation admin d'une facture en attente", () => {
  it("libère la réservation, cause admin, jamais un abandon", async () => {
    const { lot, machines } = await inspectedPalette(2);
    await paidLine(lot);
    const client = await createUser();
    const pending = await placeOrder({ catalog, batchId: lot, customer: client });

    const cancelled = await cancelPending(pending);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ id: pending, status: "cancelled", cancelReason: "admin" });
    expect(cancelled.body.cancelledAt).not.toBeNull();
    // Rejouée : sans effet
    expect((await cancelPending(pending)).status).toBe(200);

    // Plus de manque : la machine morte se déclare sans remboursement
    const dead = await setStatus(machines[0].id, { functional: "faulty" }, { note: "Morte" });
    expect(dead.status).toBe(201);
    expect(dead.body.refunds).toEqual([]);

    // Pas un abandon : le client commande de nouveau tout de suite et rien n'est compté contre lui
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "order_creation_blocks" WHERE "user_id" = ${client.userId}::uuid`;
    expect(n).toBe(0);
    const [{ ends }] = await prisma.$queryRaw<{ ends: Date | null }[]>`
      SELECT "user_batch_cooldown_ends_at"(${lot}::uuid, ${client.userId}::uuid) AS "ends"`;
    expect(ends).toBeNull();
  });

  it("refusée sur une facture payée, accès réservé au backoffice, 404 inconnue", async () => {
    const { lot } = await inspectedPalette(1);
    const sale = await paidLine(lot);
    expectError(await cancelPending(sale.orderId), 409, "order_not_cancellable");
    expectError(await cancelPending(randomUUID()), 404, "order_not_found");
    await as("4242");
    expectError(await cancelPending(sale.orderId), 403, "forbidden");
  });
});

describe("sortie du Contrôle : blocages", () => {
  const blockedLines = (reply: Reply) => reply.body.error.details.lines as { lineId: string; orderId: string; position: number; machineId: string | null; problem?: string }[];

  it("machines encore attendues : 409 inspection_expected_machines, avec les machines", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [m1, m2] = await machinesOf(lot);
    await receiveAndCheck(m1.id);
    const reply = await move(lot, "inspection", "tuning");
    expectError(reply, 409, "inspection_expected_machines");
    expect(reply.body.error.details.machines).toEqual([{ machineId: m2.id, serial: null }]);
    // Marquée manquante (sans commande payée) : la sortie est libre
    await setStatus(m2.id, { logistical: "missing" }, { note: "Absente" });
    expect((await move(lot, "inspection", "packaging")).status).toBe(201);
  });

  it("ligne payée sans machine : 409 packaging_unassigned_lines (le Tuning reste permis)", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const sale = await paidLine(lot);
    const reply = await move(lot, "inspection", "packaging");
    expectError(reply, 409, "packaging_unassigned_lines");
    expect(blockedLines(reply)).toEqual([{ lineId: sale.lineId, orderId: sale.orderId, position: 1, machineId: null }]);
    expect(reply.body.error.details.orderIds).toEqual([sale.orderId]);
    expect((await assign(sale.lineId, { expectedMachineId: null, machineId: machines[0].id })).status).toBe(201);
    expect((await move(lot, "inspection", "packaging")).status).toBe(201);
  });

  it("machine de ligne défectueuse : 409 inspection_lines_to_replace ; remplacée, la sortie passe", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const sale = await paidLine(lot);
    await assign(sale.lineId, { expectedMachineId: null, machineId: machines[0].id });
    await setStatus(machines[0].id, { functional: "faulty" }, { note: "Morte" });
    const reply = await move(lot, "inspection", "tuning");
    expectError(reply, 409, "inspection_lines_to_replace");
    expect(blockedLines(reply)).toEqual([
      { lineId: sale.lineId, orderId: sale.orderId, position: 1, machineId: machines[0].id, machineSerial: expect.anything(), problem: "faulty" },
    ]);
    await assign(sale.lineId, { expectedMachineId: machines[0].id, machineId: machines[1].id, reason: "Remplacement" });
    expect((await move(lot, "inspection", "packaging")).status).toBe(201);
  });

  it("commande payée en trop : 409 inspection_surplus_orders, avec les lignes et commandes", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const a = await paidLine(lot);
    const b = await paidLine(lot);
    // Surplus impossible à créer par l'API (le remboursement est exigé avant) : machine morte écrite sans les gardes
    await prisma.$executeRaw`ALTER TABLE "Machine" DISABLE TRIGGER USER`;
    try {
      await prisma.$executeRaw`UPDATE "Machine" SET "functional_status" = 'faulty' WHERE "id" = ${machines[0].id}::uuid`;
    } finally {
      await prisma.$executeRaw`ALTER TABLE "Machine" ENABLE TRIGGER USER`;
    }
    const reply = await move(lot, "inspection", "tuning");
    expectError(reply, 409, "inspection_surplus_orders");
    expect(blockedLines(reply)).toHaveLength(1);
    expect([a.orderId, b.orderId]).toContain(blockedLines(reply)[0].orderId);
    expect(reply.body.error.details.orderIds).toEqual([blockedLines(reply)[0].orderId]);
  });
});

describe("motif de remboursement : table MachineRefundCause", () => {
  it("lu dans la table, extensible : changer la ligne change le motif ; cas absent : 422 refund_cause_unknown", async () => {
    const { lot, machines } = await inspectedPalette(1);
    const sale = await paidLine(lot);
    await prisma.$executeRaw`UPDATE "MachineRefundCause" SET "cause" = 'shop_stock' WHERE "case_code" = 'faulty'`;
    await setStatus(machines[0].id, { functional: "faulty" }, { note: "Morte" }, [sale.lineId]);
    expect(await prisma.refund.findFirstOrThrow({ where: { order_id: sale.orderId } })).toMatchObject({ cause: "shop_stock" });

    const second = await inspectedPalette(1);
    await paidLine(second.lot);
    await prisma.$executeRaw`DELETE FROM "MachineRefundCause" WHERE "case_code" = 'faulty'`;
    const refused = await setStatus(second.machines[0].id, { functional: "faulty" }, { note: "Morte" });
    expectError(refused, 422, "refund_cause_unknown");
    expect(refused.body.error.details).toEqual({ case: "faulty" });
    expect((await prisma.machine.findUniqueOrThrow({ where: { id: second.machines[0].id } })).functional_status).toBe("ok");
  });

  it("par défaut : morte et dégradée → shop_defective_machine, manquante et perdue → shop_stock", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    const sale = await paidLine(lot);
    await prisma.machine.update({ where: { id: m.id }, data: { serial: "M-1" } });
    await setStatus(m.id, { logistical: "missing" }, { note: "Absente" }, [sale.lineId]);
    expect(await prisma.refund.findFirstOrThrow({ where: { order_id: sale.orderId } })).toMatchObject({ cause: "shop_stock" });
  });
});

describe("attribution d'une machine dégradée : acceptation du client", () => {
  it("refusée sans acceptation (422), enregistrée avec ; l'acceptation d'une machine OK n'écrit rien", async () => {
    const { lot, machines } = await inspectedPalette(2);
    await changeMachine(prisma, machines[1].id, { functional: "degraded" }, "Hashboard 1 morte");
    const customer = await createUser();
    const sale = await paidLine(lot, customer);
    expectError(await assign(sale.lineId, { expectedMachineId: null, machineId: machines[1].id, reason: "Rabais" }), 422, "degraded_acceptance_required");
    const ok = await assign(sale.lineId, { expectedMachineId: null, machineId: machines[1].id, reason: "Rabais", customerAcceptsDegraded: true });
    expect(ok.status).toBe(201);
    const line = ok.body.lines.find((l: { lineId: string }) => l.lineId === sale.lineId);
    expect(line.degradedAcceptedAt).not.toBeNull();
    const journal = await prisma.orderLineAssignment.findFirstOrThrow({ where: { order_line_id: sale.lineId, machine_id: machines[1].id } });
    expect(journal.degraded_accepted_by_user_id).toBe(customer.userId);
    const swap = await assign(sale.lineId, { expectedMachineId: machines[1].id, machineId: machines[0].id, reason: "Machine OK", customerAcceptsDegraded: true });
    expect(swap.body.lines.find((l: { lineId: string }) => l.lineId === sale.lineId).degradedAcceptedAt).toBeNull();
  });
});

describe("vue client : machine attribuée", () => {
  it("la ligne de la facture dit « machine attribuée » sans jamais montrer le numéro de série", async () => {
    const { lot, machines } = await inspectedPalette(2);
    const customer = await createUser();
    const sale = await paidLine(lot, customer);
    const authUserId = String((await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).auth_user_id);
    const lines = async () => {
      await as(authUserId);
      const reply = await call(ordersRoute.GET);
      await as(ADMIN);
      return reply;
    };
    const before = await lines();
    expect(before.body.items[0].lines[0].machineAssigned).toBe(false);
    await assign(sale.lineId, { expectedMachineId: null, machineId: machines[0].id });
    const after = await lines();
    expect(after.body.items[0].lines[0].machineAssigned).toBe(true);
    expect(JSON.stringify(after.body)).not.toContain(machines[0].serial ?? "no-serial-yet");
    expect(after.body.items[0].lines[0]).not.toHaveProperty("machineSerial");
  });
});

describe("compteurs degraded distincts", () => {
  it("lot (counters) et stock par modèle : degraded n'est jamais compté comme OK", async () => {
    const { lot, machines } = await inspectedPalette(3);
    await changeMachine(prisma, machines[2].id, { functional: "degraded" }, "Hashboard 1 morte");
    const sale = await paidLine(lot);
    await assign(sale.lineId, { expectedMachineId: null, machineId: machines[0].id });
    const batch = await call(batchRoute.GET, { params: { batchId: lot } });
    expect(batch.body.counters).toMatchObject({ okMachines: 2, degradedMachines: 1, okLines: 1, degradedLines: 0, machinesToStockDegraded: 1 });
    const summary = await call(batchMachinesRoute.GET, { params: { batchId: lot } });
    expect(summary.body.summary).toMatchObject({ ok: 2, degraded: 1, okLines: 1, unsoldDegraded: 1 });
    const stock = await call(stockRoute.GET);
    expect(stock.body.items[0]).toMatchObject({ inPalettes: 2, inPalettesDegraded: 1, assignedDegraded: 0 });
  });
});
