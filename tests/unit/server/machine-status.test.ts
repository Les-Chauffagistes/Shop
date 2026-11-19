import { describe, expect, it } from "vitest";
import {
  MACHINE_TRANSITIONS,
  machineChangeNeedsNote,
  machineTransitionAllowed,
  nextMachineChanges,
} from "@/server/machine-status";

describe("machine-status : transitions et motifs", () => {
  it("le même statut n'est pas une transition interdite (changement fonctionnel seul)", () => {
    expect(machineTransitionAllowed("in_stock", "in_stock")).toBe(true);
    expect(machineTransitionAllowed("expected", "ready")).toBe(false);
    expect(MACHINE_TRANSITIONS.delivered).toEqual([]);
    expect(MACHINE_TRANSITIONS.scrapped).toEqual(["in_stock"]); // rebut réversible (jalon 5 bis)
  });

  it("motif : sortie du flux, retour arrière, correction du contrôle ; pas pour la réception ni le premier contrôle", () => {
    expect(machineChangeNeedsNote("expected", "in_stock", "unknown", "unknown")).toBe(false);
    expect(machineChangeNeedsNote("in_stock", "in_stock", "unknown", "faulty")).toBe(false);
    expect(machineChangeNeedsNote("expected", "missing", "unknown", "unknown")).toBe(true);
    expect(machineChangeNeedsNote("ready", "in_stock", "ok", "ok")).toBe(true);
    expect(machineChangeNeedsNote("in_stock", "in_stock", "ok", "faulty")).toBe(true);
    expect(machineChangeNeedsNote("in_transit", "delivered", "ok", "ok")).toBe(false);
  });
});

describe("nextMachineChanges : actions proposées et conditions connues", () => {
  const facts = { logistical: "in_stock", functional: "ok", batchStatus: "inspection", hasActiveLine: false, mountingConform: true } as const;

  it("machine en stock OK : prête (principale), montage, rebut bloqué tant qu'elle n'est pas défectueuse", () => {
    const changes = nextMachineChanges(facts);
    expect(changes.map((c) => [c.to, c.action, c.allowed, c.noteRequired])).toEqual([
      ["ready", "Marquer prête", true, false],
      ["in_preparation", "Démarrer le montage", true, false],
      ["scrapped", "Mettre au rebut", false, true],
    ]);
    expect(changes[2].blockers).toEqual(["Seule une machine défectueuse se met au rebut : marquez-la défectueuse d'abord."]);
  });

  it("non contrôlée : ni prête ni montage ; défectueuse : rebut permis", () => {
    const unchecked = nextMachineChanges({ ...facts, functional: "unknown" });
    expect(unchecked.find((c) => c.to === "ready")!.blockers).toEqual(["Contrôlez d'abord la machine (OK ou dégradée)."]);
    const faulty = nextMachineChanges({ ...facts, functional: "faulty" });
    expect(faulty.find((c) => c.to === "ready")!.blockers).toEqual(["Une machine défectueuse ne se prépare pas."]);
    expect(faulty.find((c) => c.to === "scrapped")!.allowed).toBe(true);
  });

  it("remise au transporteur : seulement la machine d'une commande payée", () => {
    const ready = { ...facts, logistical: "ready" } as const;
    expect(nextMachineChanges(ready).find((c) => c.to === "in_transit")).toMatchObject({
      allowed: false,
      blockers: ["Attribuez d'abord la machine à une commande payée."],
    });
    expect(nextMachineChanges({ ...ready, hasActiveLine: true }).find((c) => c.to === "in_transit")!.allowed).toBe(true);
  });

  it("remise au transporteur : bloquée pour une machine attribuée au montage non conforme", () => {
    const ready = { ...facts, logistical: "ready", hasActiveLine: true, mountingConform: false } as const;
    const change = nextMachineChanges(ready).find((c) => c.to === "in_transit")!;
    expect(change.allowed).toBe(false);
    expect(change.blockers).toEqual([expect.stringMatching(/montage de cette machine n'est pas celui de sa commande/)]);
    expect(nextMachineChanges(ready).find((c) => c.to === "in_stock")!.allowed).toBe(true);
  });

  it("lot annulé : tout est bloqué", () => {
    expect(nextMachineChanges({ ...facts, batchStatus: "cancelled" }).every((c) => !c.allowed)).toBe(true);
  });

  it("rebut annulé : retour « En stock », motif obligatoire", () => {
    expect(nextMachineChanges({ ...facts, logistical: "scrapped", functional: "faulty" })).toEqual([
      expect.objectContaining({ to: "in_stock", action: "Annuler la mise au rebut", noteRequired: true, allowed: true }),
    ]);
  });

  it("retour en main d'une machine perdue ou retournée : motif obligatoire", () => {
    expect(nextMachineChanges({ ...facts, logistical: "returned" })).toEqual([
      expect.objectContaining({ to: "in_stock", action: "Remettre en stock (à recontrôler)", noteRequired: true }),
    ]);
  });
});
