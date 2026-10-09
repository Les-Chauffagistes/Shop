import { describe, expect, it } from "vitest";
import { reconcileAfterSave } from "@/components/backoffice/batches/BatchForm";
import { EDITABLE_FIELDS } from "@/server/batch-status";
import type { BatchDetail } from "@/server/batches";

/** Lot minimal au sondage : un menu « Kit » (Sans kit par défaut, Silent). */
function batch(over: { quantity?: number; name?: string; hidden?: boolean; silentMax?: number | null; status?: "survey" | "ordering" }) {
  const status = over.status ?? "survey";
  return {
    id: "b",
    status,
    updatedAt: "2026-10-07T10:00:00.000001Z",
    editableFields: EDITABLE_FIELDS[status],
    model: { id: "m", name: "S21" },
    quantity: over.quantity ?? 10,
    name: over.name ?? `${over.quantity ?? 10} S21`,
    purchasePrice: "1500000",
    resaleUnitPrice: "180000",
    options: [
      {
        id: "kit",
        title: "Kit",
        hidden: over.hidden ?? false,
        wishlistChoices: 0,
        values: [
          { id: "sans", label: "Sans kit", isDefault: true, price: "0", enabled: true, priceOverride: null, maxQty: null, availability: "offered" },
          {
            id: "silent",
            label: "Silent",
            isDefault: false,
            price: "5000",
            enabled: true,
            priceOverride: null,
            maxQty: over.silentMax ?? null,
            availability: "offered",
          },
        ],
      },
    ],
  } as unknown as BatchDetail;
}

const values = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
function base() {
  return {
    modelId: "m",
    quantity: "10",
    purchasePrice: "15000,00",
    resalePrice: "1800,00",
    name: "",
    settings: {
      sans: { enabled: true, priceOverride: "", maxQty: "" },
      silent: { enabled: true, priceOverride: "", maxQty: "" },
    },
    hidden: [] as string[],
  };
}

describe("reconcileAfterSave", () => {
  it("prend les valeurs enregistrées (mises en forme par le serveur) des champs non retouchés depuis l'envoi", () => {
    const sent = values({ quantity: "12", purchasePrice: "15000", hidden: ["kit"] });
    const next = reconcileAfterSave(sent, sent, batch({ quantity: 12, hidden: true }));
    expect(next).toMatchObject({ quantity: "12", purchasePrice: "15000,00", hidden: ["kit"] });
  });

  it("garde une saisie faite pendant l'envoi, champ par champ", () => {
    const sent = values({ hidden: ["kit"] });
    const current = values({ hidden: [], name: "Palette" });
    const next = reconcileAfterSave(current, sent, batch({ hidden: true }));
    expect(next.hidden).toEqual([]);
    expect(next.name).toBe("Palette");
    expect(next.quantity).toBe("10");
  });

  it("garde un réglage d'option modifié pendant l'envoi, et reprend les autres", () => {
    const sent = values();
    const current = values({
      settings: { ...base().settings, silent: { enabled: true, priceOverride: "", maxQty: "3" } },
    });
    const next = reconcileAfterSave(current, sent, batch({ silentMax: 2 }));
    expect(next.settings.silent.maxQty).toBe("3");
    expect(next.settings.sans).toEqual({ enabled: true, priceOverride: "", maxQty: "" });
  });

  it("un champ devenu non modifiable prend la valeur du serveur", () => {
    const sent = values();
    const current = values({ resalePrice: "2000", hidden: ["kit"] });
    const next = reconcileAfterSave(current, sent, batch({ status: "ordering" }));
    expect(next.resalePrice).toBe("1800,00");
    expect(next.hidden).toEqual([]);
  });
});
