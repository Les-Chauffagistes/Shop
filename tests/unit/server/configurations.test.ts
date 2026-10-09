import { describe, expect, it } from "vitest";
import { buildConfigurationItems, type MenuOffer } from "@/server/configurations";

const ventilation: MenuOffer = {
  optionId: "vent",
  defaultValueId: "none",
  prices: new Map([
    ["none", 0n],
    ["silent", 6000n],
  ]),
};
const cleaning: MenuOffer = { optionId: "clean", defaultValueId: "no", prices: new Map([["no", 0n], ["yes", 1500n]]) };
const empty: MenuOffer = { optionId: "empty", defaultValueId: null, prices: new Map() };

describe("buildConfigurationItems", () => {
  it("un item par menu visible : le choix au prix du lot, sinon le défaut à 0", () => {
    expect(buildConfigurationItems([ventilation, cleaning, empty], [{ optionId: "vent", optionValueId: "silent" }])).toEqual([
      { optionId: "vent", optionValueId: "silent", unitPrice: 6000n },
      { optionId: "clean", optionValueId: "no", unitPrice: 0n },
    ]);
  });

  it("choisir explicitement le défaut le laisse gratuit", () => {
    expect(buildConfigurationItems([ventilation], [{ optionId: "vent", optionValueId: "none" }])).toEqual([
      { optionId: "vent", optionValueId: "none", unitPrice: 0n },
    ]);
  });

  it("refuse un menu masqué ou absent, une valeur non proposée, un menu choisi deux fois", () => {
    const refused = (choices: { optionId: string; optionValueId: string }[]) => () =>
      buildConfigurationItems([ventilation, cleaning], choices);
    expect(refused([{ optionId: "hidden", optionValueId: "x" }])).toThrow(expect.objectContaining({ code: "option_not_offered" }));
    expect(refused([{ optionId: "vent", optionValueId: "airflow" }])).toThrow(expect.objectContaining({ code: "option_not_offered" }));
    expect(
      refused([
        { optionId: "vent", optionValueId: "none" },
        { optionId: "vent", optionValueId: "silent" },
      ]),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });
});
