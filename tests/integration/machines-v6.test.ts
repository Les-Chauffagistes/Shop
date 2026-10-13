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
    expect(await constraintOf(prisma.machine.create({ data: { batch_id: lot, model_id: catalog.modelId } }))).toBe(
      "Machine_batch_quantity",
    );
    expect(await constraintOf(prisma.model.update({ where: { id: catalog.modelId }, data: { hashboard_qtt: 4 } }))).toBe(
      "Model_hashboard_qtt_frozen",
    );
  });

  it("une machine naît attendue, dans un lot qui attend ses machines ; jamais supprimée", async () => {
    const early = await createBatch(catalog, { quantity: 2, status: "preorder" });
    expect(await constraintOf(prisma.machine.create({ data: { batch_id: early, model_id: catalog.modelId } }))).toBe(
      "Machine_batch_status",
    );
    const lot = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const received = prisma.machine.create({
      data: { batch_id: lot, model_id: catalog.modelId, logistical_status: "in_stock", received_at: new Date() },
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
        machine_id: m.id, batch_id: lot, from_logistical: "expected", to_logistical: "in_stock",
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

  it("lot annulé ou clos : machines figées", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    await moveBatch(lot, "awaiting_reception", "cancelled");
    expect(await constraintOf(changeMachine(prisma, m.id, { logistical: "in_stock" }))).toBe("MachineStatusChange_batch_status");
    expect(await constraintOf(prisma.machine.update({ where: { id: m.id }, data: { serial: "SN-X" } }))).toBe(
      "Machine_batch_frozen",
    );
  });
});

describe("contrôle : état fonctionnel et hashboards", () => {
  it("seulement sur une machine reçue et en main, lot au Contrôle ou après", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "awaiting_reception" });
    const [m, expected] = await machinesOf(lot);
    await changeMachine(prisma, m.id, { logistical: "in_stock" });
    expect(await constraintOf(changeMachine(prisma, m.id, { functional: "faulty" }))).toBe("MachineStatusChange_functional");
    await moveBatch(lot, "awaiting_reception", "inspection");
    expect(await constraintOf(changeMachine(prisma, expected.id, { functional: "faulty" }))).toBe("MachineStatusChange_functional");
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
              machine_id: m.id, batch_id: lot, from_logistical: current.logistical_status, to_logistical: "in_stock",
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
      // La transition verrouille le lot (BatchStatusTransition_apply) jusqu'au COMMIT
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
