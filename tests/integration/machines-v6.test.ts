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
  createUser,
  type Customer,
  failureOf,
  machinesOf,
  moveBatch,
  pay,
  placeOrder,
  receiveAndCheck,
  untilAnotherSessionWaitsOnLock,
  writeFullRefund,
} from "./fixtures";

// Migration v6 (jalon 5) : génération des machines, statuts par le journal MachineStatusChange, contrôle et
// hashboards, machine morte retirée du stock, attribution, surplus de commandes payées.
// Refonte R1 : la machine est décloisonnée du lot (origine immuable, clés étrangères simples, appartenance vérifiée
// par trigger, statuts indépendants du statut du lot sauf annulation et fenêtre d'attribution grossiste).

type Tx = Prisma.TransactionClient;

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const machine = (id: string) => prisma.machine.findUniqueOrThrow({ where: { id } });

type Summary = Record<string, number | string>;
async function summary(batchId: string): Promise<Summary> {
  const [row] = await prisma.$queryRaw<Summary[]>`
    SELECT * FROM "batch_machine_summary" WHERE "batch_id" = ${batchId}::uuid`;
  return row;
}

async function surplus(batchId: string, extra = 0) {
  return prisma.$queryRaw<{ line_id: string; order_id: string; rank: number }[]>`
    SELECT "line_id", "order_id", "rank" FROM "batch_surplus_lines"(${batchId}::uuid, ${extra}::int)`;
}

let catalog: Catalog;
let alice: Customer;
let bob: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  [alice, bob] = [await createUser(), await createUser()];
});

/** Commande payée d'une machine ; renvoie la facture et sa ligne. */
async function paidLine(batchId: string, customer: Customer, paidAt?: Date) {
  const orderId = await placeOrder({ catalog, batchId, customer });
  await pay(orderId, paidAt);
  const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
  return { orderId, lineId: line.id };
}

describe("génération des machines", () => {
  it("à l'entrée en Attente de réception : une machine attendue par place, rien de plus après un retour arrière", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "ordering" });
    expect(await machinesOf(lot)).toHaveLength(0);
    await moveBatch(lot, "ordering", "awaiting_reception");
    const machines = await machinesOf(lot);
    expect(machines).toHaveLength(3);
    expect(machines.every((m) => m.logistical_status === "expected" && m.functional_status === "unknown")).toBe(true);
    expect(machines.every((m) => m.model_id === catalog.modelId && m.received_at === null)).toBe(true);

    await moveBatch(lot, "awaiting_reception", "inspection");
    await moveBatch(lot, "inspection", "awaiting_reception");
    expect(await machinesOf(lot)).toHaveLength(3);
  });

  it("quantité figée dès que les machines existent ; jamais plus de machines que la quantité", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "ordering" });
    await prisma.batch.update({ where: { id: lot }, data: { quantity: 3 } });
    await moveBatch(lot, "ordering", "awaiting_reception");
    expect(await machinesOf(lot)).toHaveLength(3);
    expect(await constraintOf(prisma.batch.update({ where: { id: lot }, data: { quantity: 4 } }))).toBe("Batch_quantity_frozen");
    expect(
      await constraintOf(prisma.machine.create({ data: { batch_id: lot, origin_batch_id: lot, model_id: catalog.modelId } })),
    ).toBe("Machine_batch_quantity");
    expect(await constraintOf(prisma.model.update({ where: { id: catalog.modelId }, data: { hashboard_qtt: 4 } }))).toBe(
      "Model_hashboard_qtt_frozen",
    );
  });

  it("une machine naît attendue, dans son lot d'origine, quel que soit le statut du lot sauf annulé ; jamais supprimée", async () => {
    // Le statut du lot ne borne plus l'insertion : la génération reste le fait de l'entrée en Attente de réception,
    // qui ne crée que les places qui manquent (machines nées dans le lot).
    const early = await createBatch(catalog, { quantity: 2, status: "ordering" });
    const born = await prisma.machine.create({ data: { batch_id: early, origin_batch_id: early, model_id: catalog.modelId } });
    expect(born).toMatchObject({ batch_id: early, origin_batch_id: early, logistical_status: "expected", in_hand_since: null });
    await moveBatch(early, "ordering", "awaiting_reception");
    expect(await machinesOf(early)).toHaveLength(2);

    const other = await createBatch(catalog, { quantity: 1, status: "ordering" });
    const elsewhere = prisma.machine.create({ data: { batch_id: other, origin_batch_id: early, model_id: catalog.modelId } });
    expect(await constraintOf(elsewhere)).toBe("Machine_origin");
    await moveBatch(other, "ordering", "cancelled");
    const inCancelled = prisma.machine.create({ data: { batch_id: other, origin_batch_id: other, model_id: catalog.modelId } });
    expect(await constraintOf(inCancelled)).toBe("Machine_batch_frozen");

    const lot = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const received = prisma.machine.create({
      data: { batch_id: lot, origin_batch_id: lot, model_id: catalog.modelId, logistical_status: "in_stock", received_at: new Date() },
    });
    expect(await constraintOf(received)).toBe("Machine_new");
    const [m] = await machinesOf(lot);
    expect(await constraintOf(prisma.machine.delete({ where: { id: m.id } }))).toBe("Machine_no_delete");
  });
});

describe("statuts : seulement par le journal MachineStatusChange", () => {
  it("écriture directe refusée ; numéro de série modifiable, updated_at posé par la base", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    const direct = prisma.machine.update({ where: { id: m.id }, data: { logistical_status: "in_stock", received_at: new Date() } });
    expect(await constraintOf(direct)).toBe("Machine_status_via_change");
    const updated = await prisma.machine.update({ where: { id: m.id }, data: { serial: "SN-001", psu_serial: "PSU-1" } });
    expect(updated.updated_at.getTime()).toBeGreaterThan(m.updated_at.getTime());
    expect(await constraintOf(prisma.machine.update({ where: { id: m.id }, data: { batch_id: lot, created_at: new Date(0) } }))).toBe(
      "Machine_immutable",
    );
  });

  it("réception : date posée par la base, auteur et état précédent au journal ; état attendu vérifié", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "awaiting_reception" });
    const [m, other] = await machinesOf(lot);
    const before = new Date();
    const change = await changeMachine(prisma, m.id, { logistical: "in_stock" });
    expect(change).toMatchObject({
      from_logistical: "expected", to_logistical: "in_stock", from_functional: "unknown", to_functional: "unknown",
      changed_by_auth_user_id: ADMIN_AUTH_USER_ID, note: null,
    });
    const received = await machine(m.id);
    expect(received.logistical_status).toBe("in_stock");
    expect(received.received_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);

    // État courant différent de from_* (autre onglet, autre technicien)
    const stale = prisma.machineStatusChange.create({
      data: {
        machine_id: m.id, from_logistical: "expected", to_logistical: "in_stock",
        from_functional: "unknown", to_functional: "unknown", changed_by_auth_user_id: ADMIN_AUTH_USER_ID,
      },
    });
    expect(await constraintOf(stale)).toBe("MachineStatusChange_current");
    // Couple non autorisé : attendue → prête
    expect(await constraintOf(changeMachine(prisma, other.id, { logistical: "ready" }))).toBe("MachineStatusChange_allowed_check");
    // Aucun changement
    expect(await constraintOf(changeMachine(prisma, other.id, {}))).toBe("MachineStatusChange_changed_check");
    // Journal append-only
    expect(await constraintOf(prisma.machineStatusChange.delete({ where: { id: change.id } }))).toBe(
      "MachineStatusChange_append_only",
    );
  });

  it("machine manquante : motif obligatoire, sortie du stock ; retrouvée : motif", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    expect(await constraintOf(changeMachine(prisma, m.id, { logistical: "missing" }))).toBe(
      "MachineStatusChange_note_required_check",
    );
    await changeMachine(prisma, m.id, { logistical: "missing" }, "Absente de la palette");
    const [{ stock }] = await prisma.$queryRaw<{ stock: number }[]>`SELECT "batch_available_stock"(${lot}::uuid) AS "stock"`;
    expect(stock).toBe(1);
    expect(await constraintOf(changeMachine(prisma, m.id, { logistical: "in_stock" }))).toBe(
      "MachineStatusChange_note_required_check",
    );
    await changeMachine(prisma, m.id, { logistical: "in_stock" }, "Retrouvée dans un second colis");
    expect((await machine(m.id)).received_at).not.toBeNull();
  });

  it("lot annulé : machines figées", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    await moveBatch(lot, "awaiting_reception", "cancelled");
    expect(await constraintOf(changeMachine(prisma, m.id, { logistical: "in_stock" }))).toBe("MachineStatusChange_batch_status");
    expect(await constraintOf(prisma.machine.update({ where: { id: m.id }, data: { serial: "SN-X" } }))).toBe(
      "Machine_batch_frozen",
    );
  });

  it("lot clos : la machine n'est plus figée (retour après la clôture, nouvelle entrée en main, recontrôle)", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const [m] = await machinesOf(lot);
    await receiveAndCheck(m.id);
    const { lineId } = await paidLine(lot, alice);
    await assignMachine(prisma, lineId, lot, m.id);
    await moveBatch(lot, "inspection", "packaging");
    await changeMachine(prisma, m.id, { logistical: "ready" });
    await changeMachine(prisma, m.id, { logistical: "in_transit" });
    await moveBatch(lot, "packaging", "in_transit");
    await moveBatch(lot, "in_transit", "closed");
    const shipped = await machine(m.id);

    await changeMachine(prisma, m.id, { logistical: "returned" }, "Colis refusé par le client");
    await changeMachine(prisma, m.id, { logistical: "in_stock" }, "Colis revenu à l'atelier");
    const back = await machine(m.id);
    expect(back.received_at).toEqual(shipped.received_at);
    expect(back.in_hand_since!.getTime()).toBeGreaterThan(shipped.in_hand_since!.getTime());
    await prisma.machine.update({ where: { id: m.id }, data: { note: "Carton abîmé au retour" } });
    await prisma.$transaction(async (tx) => {
      await checkHashboards(tx, m.id, ["ok", "dead", "ok"]);
      await changeMachine(tx, m.id, { functional: "degraded" }, "Hashboard 2 morte au retour");
    });
    expect((await machine(m.id)).functional_status).toBe("degraded");
  });
});

describe("contrôle : état fonctionnel et hashboards", () => {
  it("seulement sur une machine reçue et en main, quel que soit le statut du lot (dès l'Attente de réception)", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "awaiting_reception" });
    const [m, expected] = await machinesOf(lot);
    expect(await constraintOf(changeMachine(prisma, expected.id, { functional: "faulty" }))).toBe("MachineStatusChange_functional");
    expect(await constraintOf(checkHashboards(prisma, expected.id, ["ok"]))).toBe("HashboardStatus_machine_in_hand");
    // Lot encore en Attente de réception : la machine reçue se contrôle tout de suite
    await receiveAndCheck(m.id);
    expect(await machine(m.id)).toMatchObject({ logistical_status: "in_stock", functional_status: "ok" });
    // Réception et contrôle dans la même écriture : permis
    await changeMachine(prisma, expected.id, { logistical: "in_stock", functional: "faulty" });
    expect(await constraintOf(checkHashboards(prisma, m.id, ["ok", "ok", "ok", "ok"]))).toBe("HashboardStatus_index_range");
  });

  it("ok = toutes les hashboards contrôlées ok ; une hashboard morte = degraded ou faulty", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const [m] = await machinesOf(lot);
    await changeMachine(prisma, m.id, { logistical: "in_stock" });
    expect(await constraintOf(changeMachine(prisma, m.id, { functional: "ok" }))).toBe("Machine_hashboards");
    const deadBoard = prisma.$transaction(async (tx) => {
      await checkHashboards(tx, m.id, ["ok", "dead", "ok"]);
      await changeMachine(tx, m.id, { functional: "ok" });
    });
    expect(await constraintOf(deadBoard)).toBe("Machine_hashboards");
    await receiveAndCheck(m.id, "degraded");
    const hashboards = await prisma.hashboardStatus.findMany({ where: { machine_id: m.id }, orderBy: { index: "asc" } });
    expect(hashboards.map((h) => [h.status, h.checked_by_auth_user_id])).toEqual([
      ["ok", ADMIN_AUTH_USER_ID], ["dead", ADMIN_AUTH_USER_ID], ["ok", ADMIN_AUTH_USER_ID],
    ]);
    // Correction : motif obligatoire, hashboards cohérentes ; jamais de retour à « non contrôlée »
    expect(await constraintOf(changeMachine(prisma, m.id, { functional: "unknown" }, "Erreur"))).toBe(
      "MachineStatusChange_functional",
    );
    const fixed = prisma.$transaction(async (tx) => {
      await checkHashboards(tx, m.id, ["ok", "ok", "ok"]);
      await changeMachine(tx, m.id, { functional: "ok" });
    });
    expect(await constraintOf(fixed)).toBe("MachineStatusChange_note_required_check");
    await prisma.$transaction(async (tx) => {
      await checkHashboards(tx, m.id, ["ok", "ok", "ok"]);
      await changeMachine(tx, m.id, { functional: "ok" }, "Nappe rebranchée, hashboard 2 fonctionnelle");
    });
    expect((await machine(m.id)).functional_status).toBe("ok");
    expect(await constraintOf(checkHashboards(prisma, m.id, ["not_checked"]))).toBe("HashboardStatus_checked_check");
    const board = await prisma.hashboardStatus.findFirstOrThrow({ where: { machine_id: m.id } });
    expect(await constraintOf(prisma.hashboardStatus.delete({ where: { id: board.id } }))).toBe("HashboardStatus_no_delete");
  });

  it("machine morte : mise au rebut seulement si faulty, état terminal", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [ok, dead] = await machinesOf(lot);
    await receiveAndCheck(ok.id);
    expect(await constraintOf(changeMachine(prisma, ok.id, { logistical: "scrapped" }, "Erreur"))).toBe(
      "Machine_scrapped_faulty_check",
    );
    await receiveAndCheck(dead.id, "faulty");
    await changeMachine(prisma, dead.id, { logistical: "scrapped" }, "Ne démarre pas");
    expect(await constraintOf(changeMachine(prisma, dead.id, { logistical: "in_stock" }, "Réparée"))).toBe(
      "MachineStatusChange_allowed_check",
    );
  });
});

describe("attribution", () => {
  it("seulement une machine reçue, contrôlée et fonctionnelle ; degraded avec motif", async () => {
    const lot = await createBatch(catalog, { quantity: 5, status: "inspection" });
    const [unchecked, expected, faulty, ok, degraded] = await machinesOf(lot);
    await changeMachine(prisma, unchecked.id, { logistical: "in_stock" });
    await receiveAndCheck(faulty.id, "faulty");
    await receiveAndCheck(ok.id);
    await receiveAndCheck(degraded.id, "degraded");
    const { lineId } = await paidLine(lot, alice);
    const { lineId: bobLine } = await paidLine(lot, bob);

    for (const m of [unchecked, expected, faulty]) {
      expect(await constraintOf(assignMachine(prisma, lineId, lot, m.id)), m.id).toBe("OrderLineAssignment_machine_assignable");
    }
    expect(await constraintOf(assignMachine(prisma, bobLine, lot, degraded.id))).toBe("OrderLineAssignment_degraded_reason");
    await assignMachine(prisma, bobLine, lot, degraded.id, "Hashboard 2 morte : rabais accepté par le client");
    await assignMachine(prisma, lineId, lot, ok.id);
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).machine_id).toBe(ok.id);
    // Une machine n'est la machine que d'une ligne active ; une réattribution identique est refusée
    expect(await constraintOf(assignMachine(prisma, bobLine, lot, ok.id, "Échange"))).toBe("OrderLine_machine_id_active_key");
    expect(await constraintOf(assignMachine(prisma, lineId, lot, ok.id, "Rien"))).toBe("OrderLineAssignment_changed");
  });

  it("lot au Contrôle ou après ; ligne active d'une facture payée", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    const { lineId } = await paidLine(lot, alice);
    expect(await constraintOf(assignMachine(prisma, lineId, lot, m.id))).toBe("OrderLineAssignment_batch_status");
    await moveBatch(lot, "awaiting_reception", "inspection");
    await receiveAndCheck(m.id);
    const pending = await placeOrder({ catalog, batchId: lot, customer: bob });
    const pendingLine = await prisma.orderLine.findFirstOrThrow({ where: { order_id: pending } });
    expect(await constraintOf(assignMachine(prisma, pendingLine.id, lot, m.id))).toBe("OrderLineAssignment_active_line");
  });

  it("remplacement ou retrait : motif ; jamais pour une machine remise au transporteur", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "inspection" });
    const [first, second, third] = await machinesOf(lot);
    for (const m of [first, second, third]) await receiveAndCheck(m.id);
    const { lineId } = await paidLine(lot, alice);
    await assignMachine(prisma, lineId, lot, first.id);
    expect(await constraintOf(assignMachine(prisma, lineId, lot, second.id))).toBe("OrderLineAssignment_reason");
    await assignMachine(prisma, lineId, lot, second.id, "Erreur d'étiquette");
    expect(await constraintOf(assignMachine(prisma, lineId, lot, null))).toBe("OrderLineAssignment_reason");

    await moveBatch(lot, "inspection", "packaging");
    await changeMachine(prisma, second.id, { logistical: "ready" });
    await changeMachine(prisma, second.id, { logistical: "in_transit" });
    expect((await machine(second.id)).shipped_at).not.toBeNull();
    expect(await constraintOf(assignMachine(prisma, lineId, lot, third.id, "Remplacement"))).toBe("OrderLineAssignment_shipped");
    const log = await prisma.orderLineAssignment.findMany({ where: { order_line_id: lineId }, orderBy: { created_at: "asc" } });
    expect(log.map((a) => [a.machine_id, a.reason])).toEqual([[first.id, null], [second.id, "Erreur d'étiquette"]]);
  });
});

describe("machine morte et commandes en trop", () => {
  /** Lot au Contrôle, `n` machines reçues et ok, une commande payée par client (Alice d'abord, puis Bob). */
  async function lotWithPaidOrders(quantity: number) {
    const lot = await createBatch(catalog, { quantity, status: "inspection" });
    const machines = await machinesOf(lot);
    for (const m of machines) await receiveAndCheck(m.id);
    const a = await paidLine(lot, alice, new Date(Date.now() - 60_000));
    const b = await paidLine(lot, bob, new Date(Date.now() - 30_000));
    return { lot, machines, a, b };
  }

  it("machine morte sur un lot plein : refus au COMMIT tant que la commande payée la plus récente n'est pas remboursée", async () => {
    const { lot, machines, a, b } = await lotWithPaidOrders(2);
    await assignMachine(prisma, a.lineId, lot, machines[0].id);
    const dying = machines[1];
    expect(await constraintOf(changeMachine(prisma, dying.id, { functional: "faulty" }, "Ne démarre plus"))).toBe("Batch_stock");
    // Ordre du remboursement : la plus récente d'abord (fonction de la base)
    expect((await surplus(lot, 1)).map((s) => s.order_id)).toEqual([b.orderId]);

    await prisma.$transaction(async (tx: Tx) => {
      // Verrous : facture, puis machine, puis lot
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${b.orderId}::uuid FOR NO KEY UPDATE`;
      await writeFullRefund(tx, b.orderId, { cause: "shop_defective_machine" });
      await changeMachine(tx, dying.id, { functional: "faulty" }, "Ne démarre plus");
    });
    const refund = await prisma.refund.findFirstOrThrow({ where: { order_id: b.orderId } });
    expect(refund).toMatchObject({ cause: "shop_defective_machine", network_fee_payer: "shop" });
    expect(await summary(lot)).toMatchObject({ faulty: 1, written_off: 1, paid_lines: 1, surplus_lines: 0 });
  });

  it("machine attribuée qui meurt : remplacée par une machine libre, puis mise au rebut", async () => {
    const { lot, machines, a, b } = await lotWithPaidOrders(3);
    await assignMachine(prisma, a.lineId, lot, machines[0].id);
    await assignMachine(prisma, b.lineId, lot, machines[1].id);
    await changeMachine(prisma, machines[0].id, { functional: "faulty" }, "Panne d'alimentation");
    expect(await summary(lot)).toMatchObject({ lines_to_replace: 1, free_machines: 1, surplus_lines: 0, written_off: 0 });

    await assignMachine(prisma, a.lineId, lot, machines[2].id, "Remplacement : machine d'origine morte");
    await changeMachine(prisma, machines[0].id, { logistical: "scrapped" }, "Panne d'alimentation");
    expect(await summary(lot)).toMatchObject({
      quantity: 3, machines: 3, received: 3, ok: 2, faulty: 1, scrapped: 1, written_off: 1, unusable: 1,
      paid_lines: 2, assigned_lines: 2, unassigned_lines: 0, lines_to_replace: 0, free_machines: 0, surplus_lines: 0,
    });
  });

  it("machine attribuée qui meurt sans machine libre : la commande la plus récente est remboursée, sa machine réattribuée", async () => {
    const { lot, machines, a, b } = await lotWithPaidOrders(2);
    await assignMachine(prisma, a.lineId, lot, machines[0].id);
    await assignMachine(prisma, b.lineId, lot, machines[1].id);
    await changeMachine(prisma, machines[0].id, { functional: "faulty" }, "Hashboards hors service");
    expect(await summary(lot)).toMatchObject({ lines_to_replace: 1, free_machines: 0, surplus_lines: 1 });
    expect((await surplus(lot)).map((s) => s.line_id)).toEqual([b.lineId]);

    // Réattribuer avant de rembourser : la machine est encore celle d'une ligne active
    const tooEarly = prisma.$transaction((tx) => assignMachine(tx, a.lineId, lot, machines[1].id, "Remplacement"));
    expect(await constraintOf(tooEarly)).toBe("OrderLine_machine_id_active_key");
    await prisma.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${b.orderId}::uuid FOR NO KEY UPDATE`;
      await writeFullRefund(tx, b.orderId, { cause: "shop_defective_machine" });
      await assignMachine(tx, a.lineId, lot, machines[1].id, "Remplacement : machine d'origine morte");
    });
    expect(await summary(lot)).toMatchObject({ paid_lines: 1, assigned_lines: 1, lines_to_replace: 0, surplus_lines: 0, written_off: 1 });
  });

  it("batch_surplus_lines : dernières payées d'abord (date de paiement, puis facture, puis rang)", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "inspection" });
    const carol = await createUser();
    const t = Date.now();
    const first = await paidLine(lot, carol, new Date(t - 90_000));
    const last = await paidLine(lot, alice, new Date(t - 10_000));
    const middle = await paidLine(lot, bob, new Date(t - 50_000));
    expect(await surplus(lot)).toEqual([]);
    expect((await surplus(lot, 2)).map((s) => [s.order_id, s.rank])).toEqual([[last.orderId, 3], [middle.orderId, 2]]);
    expect((await surplus(lot, 3)).at(-1)?.order_id).toBe(first.orderId);
  });
});

describe("machine décloisonnée du lot (R1)", () => {
  /** Deux lots du même modèle au Contrôle, une machine reçue et ok dans chacun, une commande payée sur le premier. */
  async function twoLots() {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const otherLot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [mine] = await machinesOf(lot);
    const [foreign] = await machinesOf(otherLot);
    await receiveAndCheck(mine.id);
    await receiveAndCheck(foreign.id);
    const { lineId } = await paidLine(lot, alice);
    return { lot, otherLot, mine, foreign, lineId };
  }

  it("origine immuable ; appartenance au lot non modifiable hors du journal des transferts", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const otherLot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    expect(m).toMatchObject({ batch_id: lot, origin_batch_id: lot });
    const move = (data: { batch_id?: string; origin_batch_id?: string }) => prisma.machine.update({ where: { id: m.id }, data });
    expect(await constraintOf(move({ origin_batch_id: otherLot }))).toBe("Machine_immutable");
    expect(await constraintOf(move({ batch_id: otherLot }))).toBe("Machine_immutable");
    expect(await constraintOf(move({ batch_id: otherLot, origin_batch_id: otherLot }))).toBe("Machine_immutable");
    expect(await machine(m.id)).toMatchObject({ batch_id: lot, origin_batch_id: lot });
  });

  it("in_hand_since : posé par la base à chaque entrée en main, jamais écrit directement", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [m, lost] = await machinesOf(lot);
    await receiveAndCheck(m.id);
    const received = await machine(m.id);
    expect(received.in_hand_since).toEqual(received.received_at);
    // Mouvements à l'atelier (préparation, retour en stock) : pas une nouvelle entrée en main
    await changeMachine(prisma, m.id, { logistical: "in_preparation" });
    await changeMachine(prisma, m.id, { logistical: "in_stock" }, "Montage reporté");
    expect((await machine(m.id)).in_hand_since).toEqual(received.in_hand_since);
    const direct = prisma.machine.update({ where: { id: m.id }, data: { in_hand_since: new Date() } });
    expect(await constraintOf(direct)).toBe("Machine_status_via_change");
    // Manquante puis retrouvée : première réception et entrée en main au même instant
    await changeMachine(prisma, lost.id, { logistical: "missing" }, "Absente de la palette");
    await changeMachine(prisma, lost.id, { logistical: "in_stock" }, "Retrouvée");
    const found = await machine(lost.id);
    expect(found.in_hand_since).not.toBeNull();
    expect(found.in_hand_since).toEqual(found.received_at);
  });

  it("attribution : la machine appartient au lot de la ligne (clé étrangère simple + trigger)", async () => {
    const { lot, mine, foreign, lineId } = await twoLots();
    expect(await constraintOf(assignMachine(prisma, lineId, lot, foreign.id))).toBe("OrderLineAssignment_machine_in_batch");
    await assignMachine(prisma, lineId, lot, mine.id);
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).machine_id).toBe(mine.id);
  });

  it("au COMMIT : la machine d'une ligne active reste dans le lot de la ligne, même si son lot changeait", async () => {
    const { lot, otherLot, mine, lineId } = await twoLots();
    await assignMachine(prisma, lineId, lot, mine.id);
    // Chemin hors du journal des transferts (qui refuse déjà : MachineTransfer_assigned) : simulé en levant la garde de
    // la machine le temps de la transaction ; le contrôle différé du stock refuse quand même le COMMIT.
    const moved = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "Machine" DISABLE TRIGGER "Machine_guard"');
      await tx.$executeRaw`UPDATE "Machine" SET "batch_id" = ${otherLot}::uuid WHERE "id" = ${mine.id}::uuid`;
    });
    expect(await constraintOf(moved)).toBe("OrderLine_machine_in_batch");
    expect((await machine(mine.id)).batch_id).toBe(lot);
  });

  it("kit monté : la machine donnée appartient au lot du mouvement", async () => {
    const { lot, mine, foreign } = await twoLots();
    const kit = await prisma.part.create({ data: { name: "Silent kit", reference: "SK-120" } });
    await prisma.optionValuePart.create({ data: { option_value_id: catalog.silentId, part_id: kit.id, qty: 1 } });
    await prisma.partStockMovement.create({
      data: { part_id: kit.id, kind: "reception", qty: 2, created_by_auth_user_id: ADMIN_AUTH_USER_ID },
    });
    const mount = (machineId: string) =>
      prisma.partStockMovement.create({
        data: { part_id: kit.id, kind: "kit_mounted", qty: -1, batch_id: lot, machine_id: machineId, created_by_auth_user_id: ADMIN_AUTH_USER_ID },
      });
    expect(await constraintOf(mount(foreign.id))).toBe("PartStockMovement_machine_in_batch");
    expect((await mount(mine.id)).machine_id).toBe(mine.id);
  });

  it("remise au transporteur : machine d'une ligne active de son lot, quel que soit le statut du lot", async () => {
    const { lot, mine, foreign, lineId } = await twoLots();
    // Lot encore au Contrôle : l'expédition se fait par commande, plus « à partir du Packaging »
    await changeMachine(prisma, foreign.id, { logistical: "ready" });
    expect(await constraintOf(changeMachine(prisma, foreign.id, { logistical: "in_transit" }))).toBe("Machine_shipped_assigned");
    await assignMachine(prisma, lineId, lot, mine.id);
    await changeMachine(prisma, mine.id, { logistical: "ready" });
    await changeMachine(prisma, mine.id, { logistical: "in_transit" });
    expect(await machine(mine.id)).toMatchObject({ logistical_status: "in_transit", batch_id: lot });
    expect((await machine(mine.id)).shipped_at).not.toBeNull();
  });

  it("le journal des statuts ne porte plus le lot : il suit la machine", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    const change = await changeMachine(prisma, m.id, { logistical: "in_stock" });
    expect(change).not.toHaveProperty("batch_id");
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'MachineStatusChange' AND column_name = 'batch_id'`;
    expect(n).toBe(0);
  });
});

describe("concurrence", () => {
  it("deux réceptions simultanées de la même machine : une seule passe", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    const sync = barrier(2);
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        prisma.$transaction(async (tx) => {
          const current = await tx.machine.findUniqueOrThrow({ where: { id: m.id } });
          await sync.wait();
          await tx.machineStatusChange.create({
            data: {
              machine_id: m.id, from_logistical: current.logistical_status, to_logistical: "in_stock",
              from_functional: current.functional_status, to_functional: current.functional_status,
              changed_by_auth_user_id: ADMIN_AUTH_USER_ID,
            },
          });
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(pgFailureOf(rejected?.reason)?.constraint).toBe("MachineStatusChange_current");
    expect(await prisma.machineStatusChange.count({ where: { machine_id: m.id } })).toBe(1);
  });

  it("la même machine attribuée à deux lignes en même temps : une seule attribution passe", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [m] = await machinesOf(lot);
    await receiveAndCheck(m.id);
    const lines = [(await paidLine(lot, alice)).lineId, (await paidLine(lot, bob)).lineId];
    const sync = barrier(2);
    const results = await Promise.allSettled(
      lines.map((lineId) =>
        prisma.$transaction(async (tx) => {
          await sync.wait();
          await assignMachine(tx, lineId, lot, m.id);
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.orderLine.count({ where: { machine_id: m.id } })).toBe(1);
  });

  it("changement de statut d'une machine pendant une transition du lot : il attend le verrou du lot, sans interblocage", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const [m] = await machinesOf(lot);
    await receiveAndCheck(m.id);
    let changing: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      // La transition verrouille le lot (BatchStatusTransition_1_check) jusqu'au COMMIT
      await tx.batchStatusTransition.create({
        data: { batch_id: lot, from_status: "inspection", to_status: "packaging", changed_by_auth_user_id: ADMIN_AUTH_USER_ID },
      });
      changing = changeMachine(prisma, m.id, { logistical: "ready" });
      await untilAnotherSessionWaitsOnLock();
    });
    await changing;
    expect((await machine(m.id)).logistical_status).toBe("ready");
  });
});
