import { describe, expect, it } from "vitest";
import { newlyHidden, planHiddenWrites, planSettingWrites, type SettingRow, settingsChanges } from "@/server/batch-settings";

const row = (optionValueId: string, values: Partial<SettingRow> = {}): SettingRow => ({
  optionValueId,
  optionId: "o1",
  enabled: true,
  priceOverride: null,
  maxQty: null,
  ...values,
});

describe("settingsChanges", () => {
  it("distingue disponibilité (retrait, dérogation) et quantités max ; absent = neutre", () => {
    expect(settingsChanges([row("a")], [])).toEqual({ availability: false, maxQty: false });
    expect(settingsChanges([], [row("a", { enabled: false })])).toEqual({ availability: true, maxQty: false });
    expect(settingsChanges([row("a", { priceOverride: 100n })], [row("a", { priceOverride: 100n, maxQty: 2 })])).toEqual({
      availability: false,
      maxQty: true,
    });
  });
});

describe("planSettingWrites", () => {
  it("brouillon : crée, met à jour, supprime ce qui redevient neutre", () => {
    const current = [row("a", { maxQty: 3 }), row("b", { priceOverride: 10n }), row("c", { enabled: false })];
    const next = [row("a", { maxQty: 4 }), row("d", { maxQty: 1 }), row("c", { enabled: false })];
    expect(planSettingWrites(current, next, { draft: true })).toEqual({
      create: [row("d", { maxQty: 1 })],
      update: [row("a", { maxQty: 4 })],
      remove: ["b"],
    });
  });

  it("publié : jamais de suppression, une ligne neutre est mise à jour", () => {
    const current = [row("a", { maxQty: 3 }), row("b")];
    expect(planSettingWrites(current, [], { draft: false })).toEqual({ create: [], update: [row("a")], remove: [] });
  });

  it("publié : régler une valeur sans ligne (non proposée) est refusé", () => {
    expect(() => planSettingWrites([row("a")], [row("z", { maxQty: 2 })], { draft: false })).toThrow(
      expect.objectContaining({ status: 409, code: "option_value_not_offered" }),
    );
    // Neutre sur une valeur non proposée : rien à écrire
    expect(planSettingWrites([row("a")], [row("a"), row("z")], { draft: false })).toEqual({ create: [], update: [], remove: [] });
  });
});

describe("planHiddenWrites", () => {
  const menus = [
    { optionId: "m1", hidden: false, hasRow: false },
    { optionId: "m2", hidden: true, hasRow: true },
    { optionId: "m3", hidden: false, hasRow: true },
  ];

  it("crée une ligne pour masquer, met à jour une ligne existante, ne supprime jamais", () => {
    expect(planHiddenWrites(menus, new Set(["m1", "m3"]))).toEqual({
      create: ["m1"],
      update: [
        { optionId: "m2", hidden: false },
        { optionId: "m3", hidden: true },
      ],
    });
    expect(planHiddenWrites(menus, new Set(["m2"]))).toEqual({ create: [], update: [] });
  });

  it("refuse un menu qui ne s'applique pas au lot", () => {
    expect(() => planHiddenWrites(menus, new Set(["autre"]))).toThrow(expect.objectContaining({ code: "unknown_option" }));
  });

  it("liste les menus qui passent de visible à masqué", () => {
    expect(newlyHidden(menus, new Set(["m1", "m2"]))).toEqual(["m1"]);
  });
});
