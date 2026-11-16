import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  assignMachine,
  type Catalog,
  changeMachine,
  createBatch,
  createCatalog,
  createStockBatch,
  createUser,
  type Customer,
  failureOf,
  machinesOf,
  moveBatch as moveBatchFixture,
  pay,
  placeOrder,
  receiveAndCheck,
  restock,
  transferMachine,
  writeOrder,
  writeFullRefund,
  writePayment,
} from "./fixtures";

// Jalon 5 bis (décisions de Hugo du 2026-11-16) : numéro de série obligatoire dès la réception, acceptation du client
// pour une machine degraded, rebut réversible, motif de remboursement par cas (table), blocages de sortie du Contrôle,
// distinction degraded / ok dans les compteurs.

type Tx = Prisma.TransactionClient;

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const machine = (id: string) => prisma.machine.findUniqueOrThrow({ where: { id } });

type Row = Record<string, number | string | null>;
async function summary(batchId: string): Promise<Row> {
  const [row] = await prisma.$queryRaw<Row[]>`SELECT * FROM "batch_machine_summary" WHERE "batch_id" = ${batchId}::uuid`;
  return row;
}

/** Transition avec les blocages de sortie du Contrôle actifs (le fixture moveBatch les suspend par défaut). */
const moveBatch = (batchId: string, from: Parameters<typeof moveBatchFixture>[1], to: Parameters<typeof moveBatchFixture>[2]) =>
  moveBatchFixture(batchId, from, to, undefined, { checkExit: true });

let catalog: Catalog;
let alice: Customer;
let bob: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  [alice, bob] = [await createUser(), await createUser()];
});

async function paidLine(batchId: string, customer: Customer, paidAt?: Date) {
  const orderId = await placeOrder({ catalog, batchId, customer });
  await pay(orderId, paidAt);
  const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
  return { orderId, lineId: line.id };
}

/** Réception écrite directement dans le journal, sans le numéro de série que le fixture changeMachine poserait. */
const receiveRaw = (machineId: string, from: "expected" | "missing" = "expected", note?: string) =>
  prisma.machineStatusChange.create({
    data: {
      machine_id: machineId,
      from_logistical: from,
      to_logistical: "in_stock",
      from_functional: "unknown",
      to_functional: "unknown",
      note,
      changed_by_auth_user_id: ADMIN_AUTH_USER_ID,
    },
  });

describe("numéro de série obligatoire dès la réception", () => {
  it("une machine attendue ou manquante n'en a pas ; la réception sans numéro est refusée par la base", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [a, b] = await machinesOf(lot);
    expect(a.serial).toBeNull();
    expect(await constraintOf(receiveRaw(a.id))).toBe("Machine_serial_received_check");
    expect((await machine(a.id)).logistical_status).toBe("expected");

    // Manquante : jamais reçue, donc sans numéro ; retrouvée, elle en exige un comme à la réception
    await changeMachine(prisma, b.id, { logistical: "missing" }, "Pas dans le colis");
    expect(await constraintOf(receiveRaw(b.id, "missing", "Retrouvée"))).toBe("Machine_serial_received_check");
    await prisma.machine.update({ where: { id: b.id }, data: { serial: "SN-B" } });
    await receiveRaw(b.id, "missing", "Retrouvée");
    expect(await machine(b.id)).toMatchObject({ logistical_status: "in_stock", serial: "SN-B" });
  });

  it("avec un numéro posé d'avance la réception passe, le début du contrôle des hashboards aussi ; le numéro ne s'efface plus", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const [m] = await machinesOf(lot);
    // Pas de hashboard à contrôler sur une machine pas encore reçue
    expect(
      await constraintOf(prisma.hashboardStatus.create({ data: { machine_id: m.id, index: 0, status: "ok", checked_by_auth_user_id: ADMIN_AUTH_USER_ID } })),
    ).toBe("HashboardStatus_machine_in_hand");
    await prisma.machine.update({ where: { id: m.id }, data: { serial: "SN-1" } });
    await receiveRaw(m.id);
    await prisma.hashboardStatus.create({ data: { machine_id: m.id, index: 0, status: "ok", checked_by_auth_user_id: ADMIN_AUTH_USER_ID } });
    expect(await constraintOf(prisma.machine.update({ where: { id: m.id }, data: { serial: null } }))).toBe("Machine_serial_received_check");
    expect((await machine(m.id)).serial).toBe("SN-1");
  });

  it("machine d'un lot de stock (réassort) : même règle", async () => {
    const stock = await createStockBatch(catalog);
    const { machines } = await restock(catalog, stock, 1);
    expect(await constraintOf(receiveRaw(machines[0].id))).toBe("Machine_serial_received_check");
  });

  it("aucune machine reçue sans numéro ne peut exister (CHECK), quel que soit le chemin", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const [m] = await machinesOf(lot);
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'Machine_serial_received_check' AND conrelid = '"Machine"'::regclass`;
    expect(n).toBe(1);
    expect(m.serial).toBeNull();
  });
});

describe("acceptation du client pour une machine degraded", () => {
  async function degradedSetup() {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [degraded, ok] = await machinesOf(lot);
    await receiveAndCheck(degraded.id, "degraded");
    await receiveAndCheck(ok.id);
    const { lineId } = await paidLine(lot, alice);
    const reason = "Hashboard 2 morte : rabais proposé au client";
    return { lot, degraded, ok, lineId, reason };
  }

  it("refusée sans acceptation (qui et quand), même avec un motif", async () => {
    const { lot, degraded, lineId, reason } = await degradedSetup();
    expect(await constraintOf(assignMachine(prisma, lineId, lot, degraded.id, reason, "none"))).toBe("OrderLineAssignment_degraded_acceptance");
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).machine_id).toBeNull();
  });

  it("le motif reste obligatoire ; l'acceptation est celle du client de la ligne, donnée au plus tard maintenant", async () => {
    const { lot, degraded, lineId, reason } = await degradedSetup();
    const accepted = { userId: alice.userId, at: new Date(Date.now() - 3_600_000) };
    expect(await constraintOf(assignMachine(prisma, lineId, lot, degraded.id, undefined, accepted))).toBe("OrderLineAssignment_degraded_reason");
    expect(await constraintOf(assignMachine(prisma, lineId, lot, degraded.id, reason, { userId: bob.userId, at: accepted.at }))).toBe(
      "OrderLineAssignment_degraded_acceptance",
    );
    expect(await constraintOf(assignMachine(prisma, lineId, lot, degraded.id, reason, { userId: alice.userId, at: new Date(Date.now() + 3_600_000) }))).toBe(
      "OrderLineAssignment_degraded_acceptance",
    );
    await assignMachine(prisma, lineId, lot, degraded.id, reason, accepted);
    const row = await prisma.orderLineAssignment.findFirstOrThrow({ where: { order_line_id: lineId } });
    expect(row).toMatchObject({ machine_id: degraded.id, reason, degraded_accepted_by_user_id: alice.userId });
    expect(row.degraded_accepted_at?.getTime()).toBe(accepted.at.getTime());
  });

  it("qui et quand vont ensemble (trigger avant CHECK) ; aucune acceptation sur une machine ok", async () => {
    const { lot, ok, lineId } = await degradedSetup();
    expect(
      await constraintOf(prisma.orderLineAssignment.create({
        data: { order_line_id: lineId, batch_id: lot, machine_id: ok.id, degraded_accepted_by_user_id: alice.userId },
      })),
    ).toBe("OrderLineAssignment_degraded_acceptance");
    expect(await constraintOf(assignMachine(prisma, lineId, lot, ok.id, undefined, { userId: alice.userId, at: new Date() }))).toBe(
      "OrderLineAssignment_degraded_acceptance",
    );
    await assignMachine(prisma, lineId, lot, ok.id);
  });

  it("remplacement par une machine degraded : mêmes conditions", async () => {
    const { lot, degraded, ok, lineId, reason } = await degradedSetup();
    await assignMachine(prisma, lineId, lot, ok.id);
    expect(await constraintOf(assignMachine(prisma, lineId, lot, degraded.id, reason, "none"))).toBe("OrderLineAssignment_degraded_acceptance");
    await assignMachine(prisma, lineId, lot, degraded.id, reason);
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).machine_id).toBe(degraded.id);
  });
});

describe("mise au rebut réversible", () => {
  async function scrapped(quantity = 3) {
    const lot = await createBatch(catalog, { quantity, status: "inspection" });
    const machines = await machinesOf(lot);
    for (const m of machines) await receiveAndCheck(m.id);
    const dead = machines[0];
    await changeMachine(prisma, dead.id, { functional: "faulty" }, "Ne démarre plus");
    await changeMachine(prisma, dead.id, { logistical: "scrapped" }, "Carte de contrôle grillée");
    return { lot, machines, dead };
  }

  it("retour « En stock » avec motif obligatoire, tracé au journal ; à recontrôler depuis ce retour", async () => {
    const { dead } = await scrapped();
    const before = await machine(dead.id);
    expect(await constraintOf(changeMachine(prisma, dead.id, { logistical: "in_stock" }))).toBe("MachineStatusChange_note_required_check");
    await changeMachine(prisma, dead.id, { logistical: "in_stock" }, "Erreur de saisie : la machine démarre");
    const after = await machine(dead.id);
    expect(after).toMatchObject({ logistical_status: "in_stock", functional_status: "faulty" });
    expect(after.in_hand_since!.getTime()).toBeGreaterThan(before.in_hand_since!.getTime());
    const last = await prisma.machineStatusChange.findFirstOrThrow({ where: { machine_id: dead.id }, orderBy: { created_at: "desc" } });
    expect(last).toMatchObject({ from_logistical: "scrapped", to_logistical: "in_stock", note: "Erreur de saisie : la machine démarre" });
    // Et la machine peut de nouveau être mise au rebut
    await changeMachine(prisma, dead.id, { logistical: "scrapped" }, "Finalement morte");
  });

  it("le seul autre statut atteignable depuis scrapped reste interdit", async () => {
    const { dead } = await scrapped();
    for (const to of ["ready", "in_preparation", "missing", "in_transit", "delivered", "lost", "returned"] as const) {
      expect(await constraintOf(changeMachine(prisma, dead.id, { logistical: to }, "Essai")), to).toBe("MachineStatusChange_allowed_check");
    }
  });

  it("refusé si la place a été reprise par une ligne payée ou réservée", async () => {
    const { lot, dead } = await scrapped(3);
    await paidLine(lot, alice);
    await paidLine(lot, bob);
    // Capacité 2 (une machine au rebut), deux lignes : place de la machine libre, retour accepté en lecture
    await prisma.$transaction(async (tx: Tx) => {
      // Une troisième commande payée dans la même transaction reprend la place de la machine au rebut
      // (le COMMIT la refuserait : Batch_stock) ; le retour est refusé tout de suite, avec son propre code
      const third = await createUser();
      const orderId = await writeOrder(tx, { catalog, batchId: lot, customer: third });
      await writePayment(tx, orderId);
      expect(await constraintOf(changeMachine(tx, dead.id, { logistical: "in_stock" }, "Erreur de saisie"))).toBe("Machine_scrap_return_place");
      throw new Error("rollback");
    }).catch((e) => expect((e as Error).message).toBe("rollback"));
    expect((await machine(dead.id)).logistical_status).toBe("scrapped");
    await changeMachine(prisma, dead.id, { logistical: "in_stock" }, "Erreur de saisie");
  });
});

describe("motif de remboursement par cas (table extensible)", () => {
  const causeOf = async (code: string) => {
    const [row] = await prisma.$queryRaw<{ c: string | null }[]>`SELECT "machine_refund_cause"(${code}::text)::text AS c`;
    return row.c;
  };

  it("morte → machine défectueuse ; manquante ou perdue → stock ; lisible par la fonction et par la table", async () => {
    expect(await causeOf("faulty")).toBe("shop_defective_machine");
    expect(await causeOf("missing")).toBe("shop_stock");
    expect(await causeOf("lost")).toBe("shop_stock");
    expect(await causeOf("degraded")).toBe("shop_defective_machine");
    expect(await causeOf("inconnu")).toBeNull();
    const rows = await prisma.machineRefundCause.findMany({ orderBy: { case_code: "asc" } });
    expect(rows.map((r) => [r.case_code, r.cause])).toEqual([
      ["degraded", "shop_defective_machine"],
      ["faulty", "shop_defective_machine"],
      ["lost", "shop_stock"],
      ["missing", "shop_stock"],
    ]);
  });

  it("extensible par une ligne (nouveau cas, ou motif changé) ; seulement un motif à la charge de la boutique", async () => {
    await prisma.machineRefundCause.create({ data: { case_code: "returned_by_carrier", cause: "shop_stock" } });
    expect(await causeOf("returned_by_carrier")).toBe("shop_stock");
    await prisma.machineRefundCause.update({ where: { case_code: "lost" }, data: { cause: "admin_other" } });
    expect(await causeOf("lost")).toBe("admin_other");
    expect(await constraintOf(prisma.machineRefundCause.create({ data: { case_code: "x", cause: "user_renounce" } }))).toBe("MachineRefundCause_cause_check");
    expect(await constraintOf(prisma.machineRefundCause.create({ data: { case_code: " ", cause: "shop_stock" } }))).toBe("MachineRefundCause_case_code_check");
  });
});

describe("sortie du Contrôle : tuning et packaging", () => {
  /** Lot au Contrôle de `quantity` machines : toutes reçues et ok (`received`), ou seulement les `received` premières. */
  async function inspection(quantity: number, received = quantity) {
    const lot = await createBatch(catalog, { quantity, status: "inspection" });
    const machines = await machinesOf(lot);
    for (const m of machines.slice(0, received)) await receiveAndCheck(m.id);
    return { lot, machines };
  }

  it("machine encore attendue (ni reçue ni manquante) : Tuning et Packaging bloqués ; manquante ou reçue, plus de blocage", async () => {
    const { lot, machines } = await inspection(2, 1);
    expect(await constraintOf(moveBatch(lot, "inspection", "tuning"))).toBe("BatchStatusTransition_inspection_expected");
    expect(await constraintOf(moveBatch(lot, "inspection", "packaging"))).toBe("BatchStatusTransition_inspection_expected");
    await changeMachine(prisma, machines[1].id, { logistical: "missing" }, "Pas dans le colis");
    await moveBatch(lot, "inspection", "tuning");
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: lot } })).status).toBe("tuning");
  });

  it("ligne payée dont la machine est morte (à remplacer) : bloqué jusqu'au remplacement", async () => {
    const { lot, machines } = await inspection(3);
    const { lineId } = await paidLine(lot, alice);
    await assignMachine(prisma, lineId, lot, machines[0].id);
    await changeMachine(prisma, machines[0].id, { functional: "faulty" }, "Ne démarre plus");
    expect(await constraintOf(moveBatch(lot, "inspection", "tuning"))).toBe("BatchStatusTransition_inspection_replace");
    expect(await constraintOf(moveBatch(lot, "inspection", "packaging"))).toBe("BatchStatusTransition_inspection_replace");
    await assignMachine(prisma, lineId, lot, machines[1].id, "Machine d'origine morte");
    await moveBatch(lot, "inspection", "tuning");
  });

  it("commande en trop (lot plein, machine morte gardée par sa ligne) : signalée avant les lignes à remplacer, jusqu'au remboursement", async () => {
    const { lot, machines } = await inspection(2);
    const a = await paidLine(lot, alice, new Date(Date.now() - 60_000));
    const b = await paidLine(lot, bob, new Date(Date.now() - 30_000));
    await assignMachine(prisma, a.lineId, lot, machines[0].id);
    await assignMachine(prisma, b.lineId, lot, machines[1].id);
    // Machine 1 morte alors que sa ligne est gardée : le lot reste plein (la machine compte par sa ligne)
    await changeMachine(prisma, machines[1].id, { functional: "faulty" }, "Ne démarre plus");
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "batch_surplus_lines"(${lot}::uuid)`;
    expect(n).toBe(1);
    expect(await constraintOf(moveBatch(lot, "inspection", "tuning"))).toBe("BatchStatusTransition_inspection_surplus");
    await prisma.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${b.orderId}::uuid FOR NO KEY UPDATE`;
      await writeFullRefund(tx, b.orderId, { cause: "shop_defective_machine" });
    });
    await moveBatch(lot, "inspection", "tuning");
  });

  it("Packaging : bloqué tant qu'une ligne payée n'a pas de machine (depuis le Contrôle comme depuis Tuning)", async () => {
    const { lot, machines } = await inspection(2);
    const a = await paidLine(lot, alice);
    // Tuning reste permis : une ligne sans machine bloque seulement Packaging
    await moveBatch(lot, "inspection", "tuning");
    expect(await constraintOf(moveBatch(lot, "tuning", "packaging"))).toBe("BatchStatusTransition_packaging_unassigned");
    await moveBatch(lot, "tuning", "inspection");
    expect(await constraintOf(moveBatch(lot, "inspection", "packaging"))).toBe("BatchStatusTransition_packaging_unassigned");
    await assignMachine(prisma, a.lineId, lot, machines[0].id);
    await moveBatch(lot, "inspection", "packaging");
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: lot } })).status).toBe("packaging");
  });

  it("machines non attribuées (ou invendues) : jamais un blocage, elles partent au stock", async () => {
    const { lot, machines } = await inspection(3);
    const a = await paidLine(lot, alice);
    await assignMachine(prisma, a.lineId, lot, machines[0].id);
    expect((await summary(lot)).free_machines).toBe(2);
    await moveBatch(lot, "inspection", "packaging");
  });

  it("autres transitions inchangées (retour au Contrôle, annulation d'un lot sans machine reçue)", async () => {
    const { lot } = await inspection(2, 1);
    await moveBatch(lot, "inspection", "awaiting_reception");
    await moveBatch(lot, "awaiting_reception", "inspection");
  });
});

describe("annulation admin d'une facture en attente : la cause admin suffit en base", () => {
  it("la facture qui occupait la dernière place est annulée (cause admin) : la machine peut alors mourir", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const machines = await machinesOf(lot);
    for (const m of machines) await receiveAndCheck(m.id);
    await paidLine(lot, alice);
    const pending = await placeOrder({ catalog, batchId: lot, customer: bob });
    expect(await constraintOf(changeMachine(prisma, machines[1].id, { functional: "faulty" }, "Ne démarre plus"))).toBe("Batch_stock");
    await prisma.order.update({ where: { id: pending }, data: { status: "cancelled", cancel_reason: "admin" } });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: pending } })).toMatchObject({ status: "cancelled", cancel_reason: "admin" });
    await changeMachine(prisma, machines[1].id, { functional: "faulty" }, "Ne démarre plus");
    expect((await machine(machines[1].id)).functional_status).toBe("faulty");
  });
});

describe("audit : une machine degraded n'est jamais confondue avec une machine ok", () => {
  it("batch_machine_summary et model_stock_summary distinguent les machines et les lignes degraded", async () => {
    const lot = await createBatch(catalog, { quantity: 5, status: "inspection" });
    const [okLine, degLine, okFree, degFree] = await machinesOf(lot);
    await receiveAndCheck(okLine.id);
    await receiveAndCheck(degLine.id, "degraded");
    await receiveAndCheck(okFree.id);
    await receiveAndCheck(degFree.id, "degraded");
    const a = await paidLine(lot, alice);
    const b = await paidLine(lot, bob);
    await assignMachine(prisma, a.lineId, lot, okLine.id);
    await assignMachine(prisma, b.lineId, lot, degLine.id, "Hashboard 2 morte : rabais");
    expect(await summary(lot)).toMatchObject({
      ok: 2, degraded: 2, assigned_lines: 2, ok_lines: 1, degraded_lines: 1,
      free_machines: 2, free_ok_machines: 1, unsold: 2, unsold_degraded: 1,
    });
  });

  it("lot de stock : une machine degraded n'est ni vendable ni disponible ; ses compteurs sont séparés", async () => {
    const stock = await createStockBatch(catalog);
    const { machines } = await restock(catalog, stock, 3);
    await receiveAndCheck(machines[0].id);
    await receiveAndCheck(machines[1].id, "degraded");
    await receiveAndCheck(machines[2].id);
    const { lineId } = await paidLine(stock, alice);
    expect((await machine(machines[0].id)).functional_status).toBe("ok");
    expect((await summary(stock)).sellable_machines).toBeLessThanOrEqual(2);
    const [row] = await prisma.$queryRaw<Row[]>`SELECT * FROM "model_stock_summary" WHERE "model_id" = ${catalog.modelId}::uuid`;
    expect(row).toMatchObject({ degraded: 1, assigned_degraded: 0, in_palettes_degraded: 0 });
    expect(await constraintOf(assignMachine(prisma, lineId, stock, machines[1].id, "Rabais", "auto"))).toBe("OrderLineAssignment_machine_assignable");
  });

  it("machines invendues d'une palette : le compteur in_palettes_degraded les distingue", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [ok, degraded] = await machinesOf(lot);
    await receiveAndCheck(ok.id);
    await receiveAndCheck(degraded.id, "degraded");
    const [row] = await prisma.$queryRaw<Row[]>`SELECT * FROM "model_stock_summary" WHERE "model_id" = ${catalog.modelId}::uuid`;
    expect(row).toMatchObject({ in_palettes: 2, in_palettes_degraded: 1 });
    void transferMachine;
  });
});
