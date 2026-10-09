import { describe, expect, it } from "vitest";
import { canAdvancePartOrder, movementInput, partOrderPatch, signedQty } from "@/server/part-stock";

describe("commande de produit : le statut avance seulement", () => {
  it.each([
    ["ordering", "awaiting_delivery", true],
    ["ordering", "delivered", true],
    ["awaiting_delivery", "delivered", true],
    ["awaiting_delivery", "ordering", false],
    ["delivered", "awaiting_delivery", false],
    ["delivered", "ordering", false],
  ] as const)("%s → %s : %s", (from, to, allowed) => {
    expect(canAdvancePartOrder(from, to)).toBe(allowed);
  });

  it("receivedQty et note seulement à la livraison", () => {
    expect(partOrderPatch.safeParse({ status: "delivered", receivedQty: 7 }).success).toBe(true);
    expect(partOrderPatch.safeParse({ receivedQty: 7 }).success).toBe(false);
    expect(partOrderPatch.safeParse({ status: "ordering" }).success).toBe(false);
  });
});

describe("mouvements de stock", () => {
  it("signe la quantité : réception et correction telles quelles, kit monté en sortie", () => {
    expect(signedQty({ kind: "reception", quantity: 10 })).toBe(10);
    expect(signedQty({ kind: "adjustment", quantity: -3 })).toBe(-3);
    expect(signedQty({ kind: "kit_mounted", quantity: 2 })).toBe(-2);
  });

  it("valide selon le type : motif obligatoire et quantité non nulle pour une correction, lot pour un kit monté", () => {
    expect(movementInput.safeParse({ kind: "adjustment", quantity: -2 }).success).toBe(false);
    expect(movementInput.safeParse({ kind: "adjustment", quantity: 0, note: "Inventaire" }).success).toBe(false);
    expect(movementInput.safeParse({ kind: "adjustment", quantity: -2, note: "Inventaire" }).success).toBe(true);
    expect(movementInput.safeParse({ kind: "reception", quantity: -1 }).success).toBe(false);
    expect(movementInput.safeParse({ kind: "kit_mounted", quantity: 1 }).success).toBe(false);
    expect(movementInput.safeParse({ kind: "kit_mounted", quantity: 1, batchId: "5e1d0000-0000-4000-8000-000000000001" }).success).toBe(true);
  });
});
