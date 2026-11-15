import { describe, expect, it } from "vitest";
import { indicativeTotal, saleBody, saleLines } from "@/components/backoffice/sales/sale-request";
import type { OfferedMenu } from "@/components/shop/OptionMenus";

/** Un menu « Kit » : Sans kit (défaut, 0 €), Silent kit (75 €). */
const kit: OfferedMenu = {
  id: "kit",
  kind: "choice",
  title: "Kit de ventilation",
  description: null,
  position: 0,
  values: [
    { id: "none", label: "Sans kit", isDefault: true, position: 0, price: "0", maxQty: null },
    { id: "silent", label: "Silent kit", isDefault: false, position: 1, price: "7500", maxQty: 3 },
  ],
} as OfferedMenu;

const base = {
  userId: "u",
  batchId: "b",
  billing: { addressId: "a" },
  shipping: null,
  means: "cash" as const,
  reference: "",
  reason: "",
};

describe("saleLines (une ligne par machine)", () => {
  it("même configuration pour toutes : celle de la machine 1, défauts compris", () => {
    expect(saleLines([kit], [{ kit: "silent" }], 2, false)).toEqual([
      { choices: [{ optionId: "kit", optionValueId: "silent" }] },
      { choices: [{ optionId: "kit", optionValueId: "silent" }] },
    ]);
    expect(saleLines([kit], [], 1, false)).toEqual([{ choices: [{ optionId: "kit", optionValueId: "none" }] }]);
  });

  it("configuration par machine ; lot sans option : lignes vides", () => {
    expect(saleLines([kit], [{ kit: "silent" }, {}], 2, true).map((l) => l.choices?.[0].optionValueId)).toEqual([
      "silent",
      "none",
    ]);
    expect(saleLines([], [], 3, false)).toEqual([{}, {}, {}]);
  });
});

describe("indicativeTotal (affichage seulement)", () => {
  it("additionne le prix de base et les options de chaque machine", () => {
    expect(indicativeTotal("52000", [kit], [{ kit: "silent" }], 2, false)).toBe("119000");
    expect(indicativeTotal("52000", [kit], [{ kit: "silent" }, {}], 2, true)).toBe("111500");
  });
});

describe("saleBody (corps de POST /api/backoffice/manual-sales)", () => {
  it("omet machines, livraison, référence et motif vides (choix d'office, facturation, motif par défaut)", () => {
    expect(saleBody({ ...base, lines: [{}], machineIds: [null] })).toEqual({
      userId: "u",
      batchId: "b",
      lines: [{}],
      billingAddress: { addressId: "a" },
      means: "cash",
    });
  });

  it("une machine choisie : une entrée par ligne, au même rang ; textes sans espaces de bord", () => {
    expect(
      saleBody({
        ...base,
        lines: [{}, {}],
        machineIds: [null, "m2", "m3"],
        shipping: { addressId: "s" },
        means: "other",
        reference: "  Chèque 12 ",
        reason: " Salon ",
      }),
    ).toMatchObject({
      machineIds: [null, "m2"],
      shippingAddress: { addressId: "s" },
      means: "other",
      reference: "Chèque 12",
      reason: "Salon",
    });
  });
});
