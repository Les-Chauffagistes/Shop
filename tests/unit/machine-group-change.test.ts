import { describe, expect, it } from "vitest";
import { groupByInvoice, groupChange, needsDialog, sendStatusChange } from "@/components/backoffice/machines/StatusChangeDialog";
import type { Machine } from "@/components/backoffice/machines/types";
import { nextMachineChanges } from "@/server/machine-status";

/** Machine minimale : ses actions viennent de la table du domaine (comme l'API). */
function machine(id: string, logistical: Machine["logisticalStatus"], functional: Machine["functionalStatus"] = "ok", hasActiveLine = false) {
  return {
    id,
    logisticalStatus: logistical,
    functionalStatus: functional,
    nextChanges: nextMachineChanges({ logistical, functional, batchStatus: "inspection", hasActiveLine, mountingConform: true }),
  } as unknown as Machine;
}

describe("groupChange (actions groupées sur les machines cochées)", () => {
  it("ne retient que les machines qui proposent le changement", () => {
    const change = groupChange([machine("a", "in_stock"), machine("b", "expected"), machine("c", "in_stock", "unknown")], "ready", "Marquer prêtes");
    // « c » (jamais contrôlée) propose le changement mais l'API le bloque : écartée et nommée, sans bloquer les autres
    expect(change?.machines.map((m) => m.id)).toEqual(["a"]);
    expect(change?.skipped?.map((s) => s.machine.id)).toEqual(["c"]);
    expect(change?.skipped?.[0].blockers.length).toBeGreaterThan(0);
    expect(change).toMatchObject({ to: "ready", toLabel: "Prête", noteRequired: false });
    expect(needsDialog(change!)).toBe(true);
  });

  it("toutes les machines bloquées : pas d'action", () => {
    expect(groupChange([machine("c", "in_stock", "unknown")], "ready", "Marquer prêtes")).toBeNull();
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

describe("expédition regroupée par facture", () => {
  const inv = (id: string, orderId: string | null) => ({ id, logisticalStatus: "ready", functionalStatus: "ok", line: orderId ? { orderId } : null }) as unknown as Machine;

  it("regroupe les machines par facture, sans facture à part", () => {
    const groups = groupByInvoice([inv("a", "o1"), inv("b", "o2"), inv("c", "o1"), inv("d", null)]);
    expect(groups.map((g) => [g.key, g.machines.map((m) => m.id)])).toEqual([["o1", ["a", "c"]], ["o2", ["b"]], ["", ["d"]]]);
  });

  it("envoie le suivi de chaque facture, sans les champs vides", async () => {
    const calls: { items: { machineId: string; tracking?: unknown }[] }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const change = { machines: [inv("a", "o1"), inv("b", "o2"), inv("c", "o3")], to: "in_transit", action: "x", toLabel: "x", noteRequired: false } as never;
      await sendStatusChange(change, null, {
        o1: { carrier: "DHL", trackingNumber: " ", trackingUrl: "" },
        o2: { carrier: "", trackingNumber: "", trackingUrl: "" },
      })();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls[0].items.map((i) => i.tracking)).toEqual([{ carrier: "DHL" }, undefined, undefined]);
  });
});
