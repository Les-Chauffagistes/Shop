import { describe, expect, it } from "vitest";
import { groupChange, needsDialog } from "@/components/backoffice/machines/StatusChangeDialog";
import type { Machine } from "@/components/backoffice/machines/types";
import { nextMachineChanges } from "@/server/machine-status";

/** Machine minimale : ses actions viennent de la table du domaine (comme l'API). */
function machine(id: string, logistical: Machine["logisticalStatus"], functional: Machine["functionalStatus"] = "ok", hasActiveLine = false) {
  return {
    id,
    logisticalStatus: logistical,
    functionalStatus: functional,
    nextChanges: nextMachineChanges({ logistical, functional, batchStatus: "inspection", hasActiveLine }),
  } as unknown as Machine;
}

describe("groupChange (actions groupées sur les machines cochées)", () => {
  it("ne retient que les machines qui proposent le changement", () => {
    const change = groupChange([machine("a", "in_stock"), machine("b", "expected"), machine("c", "in_stock", "unknown")], "ready", "Marquer prêtes");
    expect(change?.machines.map((m) => m.id)).toEqual(["a", "c"]);
    expect(change).toMatchObject({ to: "ready", toLabel: "Prête", noteRequired: false });
  });

  it("aucune machine concernée : pas d'action", () => {
    expect(groupChange([machine("a", "expected")], "in_transit", "Remettre au transporteur")).toBeNull();
  });

  it("motif exigé dès qu'une machine l'exige, et la remise au transporteur demande toujours le suivi", () => {
    const back = groupChange([machine("a", "ready"), machine("b", "in_stock")], "in_stock", "Retour en stock")!;
    expect(back.machines.map((m) => m.id)).toEqual(["a"]);
    expect(back.noteRequired).toBe(true);
    expect(needsDialog(back)).toBe(true);
    const ship = groupChange([machine("a", "ready", "ok", true)], "in_transit", "Remettre au transporteur")!;
    expect(ship.noteRequired).toBe(false);
    expect(needsDialog(ship)).toBe(true);
    expect(needsDialog(groupChange([machine("a", "in_stock")], "ready", "Marquer prêtes")!)).toBe(false);
  });
});
