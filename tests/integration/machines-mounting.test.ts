import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { changeBatchStatus, loadFacts } from "@/server/batches";
import { updateOptionValue } from "@/server/catalog";
import { autoAssign, changeMachineStatuses, getBatchMachines } from "@/server/machines";
import { ApiError, describeConstraint, pgFailureOf } from "@/server/errors";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
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
} from "./fixtures";

// Montage : une ligne à kit n'accepte qu'une machine prête montée comme elle, une ligne brute qu'une machine brute ;
// le montage se déclare tant que la machine est en stock ou en montage ; l'envoi revérifie la conformité.

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;

let catalog: Catalog;

beforeEach(async () => {
  catalog = await createCatalog();
  const kit = await prisma.part.create({ data: { name: "Silent kit", reference: "SK-120" } });
  await prisma.optionValuePart.create({ data: { option_value_id: catalog.silentId, part_id: kit.id, qty: 1 } });
});

/** Palette au Contrôle avec deux machines reçues et OK, une ligne à kit (silent) et une ligne brute. */
async function setup() {
  const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
  const [a, b] = await machinesOf(lot);
  await receiveAndCheck(a.id);
  await receiveAndCheck(b.id);
  const customer = await createUser();
  const orderId = await placeOrder({ catalog, batchId: lot, customer, lines: [true, false] });
  await pay(orderId);
  const lines = await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } });
  return { lot, a, b, silentLine: lines[0].id, rawLine: lines[1].id };
}

const mount = (machineId: string) =>
  prisma.machineMounting.create({ data: { machine_id: machineId, option_value_id: catalog.silentId } });

/** Montage terminé : déclaré, démarré puis terminé, comme au backoffice. */
async function mountAndFinish(machineId: string) {
  await mount(machineId);
  await changeMachine(prisma, machineId, { logistical: "in_preparation" });
  await changeMachine(prisma, machineId, { logistical: "ready" });
}

describe("attribution et montage", () => {
  it("refuse une machine brute, même prête, pour une ligne à kit", async () => {
    const { lot, a, silentLine } = await setup();
    await changeMachine(prisma, a.id, { logistical: "ready" });
    expect(await constraintOf(assignMachine(prisma, silentLine, lot, a.id))).toBe("OrderLineAssignment_mounting");
  });

  it("refuse une machine montée mais pas prête, puis accepte la même une fois le montage terminé", async () => {
    const { lot, a, silentLine } = await setup();
    await mount(a.id);
    expect(await constraintOf(assignMachine(prisma, silentLine, lot, a.id))).toBe("OrderLineAssignment_mounting");
    await changeMachine(prisma, a.id, { logistical: "in_preparation" });
    expect(await constraintOf(assignMachine(prisma, silentLine, lot, a.id))).toBe("OrderLineAssignment_mounting");
    await changeMachine(prisma, a.id, { logistical: "ready" });
    await assignMachine(prisma, silentLine, lot, a.id);
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: silentLine } })).machine_id).toBe(a.id);
  });

  it("refuse une machine montée pour une ligne brute, accepte une machine brute", async () => {
    const { lot, a, b, rawLine } = await setup();
    await mountAndFinish(a.id);
    expect(await constraintOf(assignMachine(prisma, rawLine, lot, a.id))).toBe("OrderLineAssignment_mounting");
    await assignMachine(prisma, rawLine, lot, b.id);
  });

  it("l'attribution automatique ne donne que des machines conformes, la première prête n'est pas prise au hasard", async () => {
    const { lot, a, b, silentLine, rawLine } = await setup();
    // a (prête, brute) est la première prête : sans montage, elle ne doit aller que sur la ligne brute
    await changeMachine(prisma, a.id, { logistical: "ready" });
    const first = await autoAssign(lot, { authUserId: ADMIN_AUTH_USER_ID.toString() });
    expect(first.assigned).toBe(1);
    const lines = await prisma.orderLine.findMany({ where: { id: { in: [silentLine, rawLine] } } });
    expect(lines.find((l) => l.id === rawLine)?.machine_id).toBe(a.id);
    expect(lines.find((l) => l.id === silentLine)?.machine_id).toBeNull();
    expect(first.mountingPlan).toMatchObject([{ lines: 1, inPreparation: 0, ready: 0, toBuild: 1 }]);

    await mountAndFinish(b.id);
    const second = await autoAssign(lot, { authUserId: ADMIN_AUTH_USER_ID.toString() });
    expect(second.assigned).toBe(1);
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: silentLine } })).machine_id).toBe(b.id);
  });
});

describe("déclaration du montage", () => {
  it("refuse une valeur sans kit, et une machine prête", async () => {
    const { a } = await setup();
    expect(
      await constraintOf(prisma.machineMounting.create({ data: { machine_id: a.id, option_value_id: catalog.noKitId } })),
    ).toBe("MachineMounting_kit");
    await changeMachine(prisma, a.id, { logistical: "ready" });
    expect(await constraintOf(mount(a.id))).toBe("MachineMounting_machine_status");
  });

  it("le retour en stock efface le montage", async () => {
    const { a } = await setup();
    await mountAndFinish(a.id);
    await changeMachine(prisma, a.id, { logistical: "in_stock" }, "Remontage");
    expect(await prisma.machineMounting.count({ where: { machine_id: a.id } })).toBe(0);
  });
});

describe("machine attribuée qui cesse d'être conforme", () => {
  it("est comptée à remplacer et ne part pas chez le transporteur", async () => {
    const { lot, a, silentLine } = await setup();
    await mountAndFinish(a.id);
    await assignMachine(prisma, silentLine, lot, a.id);
    // Démontée : retour en stock puis prête sans le kit
    await changeMachine(prisma, a.id, { logistical: "in_stock" }, "Kit retiré");
    const [row] = await prisma.$queryRaw<{ lines_to_replace: number }[]>`
      SELECT "lines_to_replace" FROM "batch_machine_summary" WHERE "batch_id" = ${lot}::uuid`;
    expect(row.lines_to_replace).toBe(1);
    await changeMachine(prisma, a.id, { logistical: "ready" });
    expect(await constraintOf(changeMachine(prisma, a.id, { logistical: "in_transit" }))).toBe("MachineStatusChange_mounting");
  });
});

describe("plan de montage et démarrage du montage (API)", () => {
  const actor = { authUserId: ADMIN_AUTH_USER_ID.toString() };

  it("dit quoi monter, enregistre le montage au démarrage, puis la machine prête est attribuable", async () => {
    const { lot, a, silentLine } = await setup();
    const before = await getBatchMachines(lot);
    expect(before.mountingPlan).toMatchObject([{ optionValueIds: [catalog.silentId], lines: 1, inPreparation: 0, ready: 0, toBuild: 1 }]);
    expect(before.lines.find((l) => l.lineId === silentLine)?.fittingMachineIds).toEqual([]);

    const step = (to: "in_preparation" | "ready", mounting?: string[]) =>
      changeMachineStatuses(
        { items: [{ machineId: a.id, from: { logistical: to === "ready" ? "in_preparation" : "in_stock", functional: "ok" }, to: { logistical: to }, mounting }] },
        actor,
      );
    const started = await step("in_preparation", [catalog.silentId]);
    expect(started.machines[0].mounting).toMatchObject([{ optionValueId: catalog.silentId, value: "Silent kit" }]);
    expect((await getBatchMachines(lot)).mountingPlan).toMatchObject([{ inPreparation: 1, toBuild: 0 }]);

    await step("ready");
    const after = await getBatchMachines(lot);
    expect(after.mountingPlan).toMatchObject([{ ready: 1, toBuild: 0 }]);
    expect(after.lines.find((l) => l.lineId === silentLine)?.fittingMachineIds).toEqual([a.id]);
  });

  it("refuse de déclarer un montage ailleurs qu'au démarrage du montage", async () => {
    const { a } = await setup();
    const { statusChangesInput } = await import("@/server/machines");
    const parsed = statusChangesInput.safeParse({
      items: [{ machineId: a.id, from: { logistical: "in_stock", functional: "ok" }, to: { functional: "ok" }, mounting: [catalog.silentId] }],
    });
    expect(parsed.success).toBe(false);
  });
});

/** Machine attribuée à la ligne à kit, puis démontée et remise prête brute : saine mais non conforme. */
async function demountedAssigned() {
  const ctx = await setup();
  await mountAndFinish(ctx.a.id);
  await assignMachine(prisma, ctx.silentLine, ctx.lot, ctx.a.id);
  await changeMachine(prisma, ctx.a.id, { logistical: "in_stock" }, "Kit retiré");
  await changeMachine(prisma, ctx.a.id, { logistical: "ready" });
  return ctx;
}

const apiErrorOf = async (promise: Promise<unknown>) => {
  const error = await failureOf(promise);
  if (error instanceof ApiError) return { status: error.status, code: error.code, message: error.message, details: error.extra.details };
  return describeConstraint(error);
};

describe("kit exigé par des commandes payées", () => {
  it("refuse de retirer tous les produits d'une valeur choisie par une ligne payée, avec le nombre de lignes", async () => {
    await setup();
    expect(await apiErrorOf(updateOptionValue(catalog.silentId, { parts: [] }))).toMatchObject({
      status: 409,
      code: "option_kit_required",
      message: expect.stringMatching(/^1 ligne de commandes payées exige le kit/),
      details: { lines: 1 },
    });
    expect(await prisma.optionValuePart.count({ where: { option_value_id: catalog.silentId } })).toBe(1);
  });

  it("la base refuse aussi (au COMMIT), mais remplacer les produits reste permis", async () => {
    await setup();
    const failure = await failureOf(prisma.optionValuePart.deleteMany({ where: { option_value_id: catalog.silentId } }));
    expect(pgFailureOf(failure)?.constraint).toBe("OptionValuePart_kit_required");
    expect(describeConstraint(failure)).toMatchObject({ status: 409, code: "option_kit_required" });

    const other = await prisma.part.create({ data: { name: "Silent kit v2", reference: "SK-121" } });
    await updateOptionValue(catalog.silentId, { parts: [{ partId: other.id, qty: 1 }] });
    expect(await prisma.optionValuePart.findMany({ where: { option_value_id: catalog.silentId } })).toMatchObject([{ part_id: other.id }]);
  });

  it("sans ligne payée active, le kit se retire", async () => {
    await updateOptionValue(catalog.silentId, { parts: [] });
    expect(await prisma.optionValuePart.count({ where: { option_value_id: catalog.silentId } })).toBe(0);
  });
});

describe("remise au transporteur d'une machine non conforme", () => {
  it("nextChanges bloque in_transit avec la raison, avant la saisie du suivi", async () => {
    const { lot, a, b, rawLine } = await demountedAssigned();
    const view = await getBatchMachines(lot);
    const transit = view.machines.find((m) => m.id === a.id)!.nextChanges.find((c) => c.to === "in_transit")!;
    expect(transit.allowed).toBe(false);
    expect(transit.blockers).toEqual([expect.stringMatching(/montage de cette machine n'est pas celui de sa commande/)]);
    // Machine brute attribuée à la ligne brute : conforme, rien ne bloque ce point
    await changeMachine(prisma, b.id, { logistical: "ready" });
    await assignMachine(prisma, rawLine, lot, b.id);
    const ok = (await getBatchMachines(lot)).machines.find((m) => m.id === b.id)!.nextChanges.find((c) => c.to === "in_transit")!;
    expect(ok.blockers.some((x) => x.includes("montage"))).toBe(false);
  });
});

describe("sortie du Contrôle bloquée par un montage non conforme", () => {
  it("compte la ligne à remonter à part et le dit dans le blocage et l'erreur", async () => {
    const { lot, b, rawLine } = await demountedAssigned();
    await assignMachine(prisma, rawLine, lot, b.id);
    const [row] = await prisma.$queryRaw<{ lines_to_replace: number; lines_to_remount: number }[]>`
      SELECT "lines_to_replace", "lines_to_remount" FROM "batch_machine_summary" WHERE "batch_id" = ${lot}::uuid`;
    expect(row).toEqual({ lines_to_replace: 1, lines_to_remount: 1 });
    const { facts } = (await loadFacts(prisma, [lot])).get(lot)!;
    expect(facts).toMatchObject({ linesToReplace: 1, linesToRemount: 1 });

    const error = await apiErrorOf(changeBatchStatus(lot, { from: "inspection", to: "tuning" }, { authUserId: "1" }));
    expect(error).toMatchObject({ status: 409, code: "inspection_lines_to_replace" });
    expect(error!.message).toMatch(/^1 ligne a une machine au montage non conforme à la commande : remontez-la ou remplacez-la/);
    expect(error!.message).not.toMatch(/défectueuse/);
    // La base bloque aussi (même règle que lines_to_replace)
    expect(await constraintOf(moveBatch(lot, "inspection", "tuning", undefined, { checkExit: true }))).toBe(
      "BatchStatusTransition_inspection_replace",
    );
  });
});

describe("valeur inconnue ou hors du modèle dans le montage déclaré", () => {
  const actor = { authUserId: ADMIN_AUTH_USER_ID.toString() };
  const start = (machineId: string, mounting: string[]) =>
    changeMachineStatuses(
      { items: [{ machineId, from: { logistical: "in_stock", functional: "ok" }, to: { logistical: "in_preparation" }, mounting }] },
      actor,
    );

  it("422 mounting_unknown_value, distinct de mounting_no_kit", async () => {
    const { a } = await setup();
    expect(await apiErrorOf(start(a.id, [randomUUID()]))).toMatchObject({ status: 422, code: "mounting_unknown_value" });
    const other = await createCatalog("S21");
    const kit = await prisma.part.create({ data: { name: "Kit S21", reference: "SK-S21" } });
    await prisma.optionValuePart.create({ data: { option_value_id: other.silentId, part_id: kit.id, qty: 1 } });
    expect(await apiErrorOf(start(a.id, [other.silentId]))).toMatchObject({ status: 422, code: "mounting_unknown_value" });
    expect(await apiErrorOf(start(a.id, [catalog.noKitId]))).toMatchObject({ status: 422, code: "mounting_no_kit" });
  });
});
