import { describe, expect, it } from "vitest";
import {
  centsToInput,
  eurosToCents,
  formatCents,
  formatHashrate,
  hashesToTerahashInput,
  parseScaledDecimal,
  terahashToHashes,
} from "./decimal";

describe("eurosToCents", () => {
  it.each([
    ["35", "3500"],
    ["35,5", "3550"],
    ["35.50", "3550"],
    ["0", "0"],
    ["0,07", "7"],
    [",5", "50"],
    ["12,", "1200"],
    ["1 500,00", "150000"],
    ["1 500,00 €", "150000"],
    ["  15000 €  ", "1500000"],
    ["35,500", "3550"],
  ])("%j → %j", (input, expected) => {
    expect(eurosToCents(input)).toBe(expected);
  });

  it("garde tous les chiffres d'un très grand montant (pas de float)", () => {
    expect(eurosToCents("92233720368547758,07")).toBe("9223372036854775807");
    expect(eurosToCents("0,1")).toBe("10"); // 0.1 n'est pas représentable exactement en float
  });

  it.each(["", "   ", "abc", "-5", "1,2,3", "35,555", "1e3", "€", ",", "12.5.0"])("refuse %j", (input) => {
    expect(eurosToCents(input)).toBeNull();
  });
});

describe("centsToInput / formatCents", () => {
  it("prépare une valeur de saisie", () => {
    expect(centsToInput("3500")).toBe("35,00");
    expect(centsToInput("7")).toBe("0,07");
    expect(centsToInput("0")).toBe("0,00");
    expect(centsToInput(null)).toBe("");
  });

  it("aller-retour exact", () => {
    for (const cents of ["0", "1", "99", "100", "150000", "9223372036854775807"]) {
      expect(eurosToCents(centsToInput(cents))).toBe(cents);
    }
  });

  it("formate avec séparateur de milliers, en euros", () => {
    expect(formatCents("150000")).toBe("1 500,00 €");
    expect(formatCents("5")).toBe("0,05 €");
    expect(formatCents("123456789")).toBe("1 234 567,89 €");
    expect(formatCents(null)).toBe("—");
  });
});

describe("hashrate", () => {
  it("convertit des TH/s en H/s", () => {
    expect(terahashToHashes("95")).toBe("95000000000000");
    expect(terahashToHashes("13,5")).toBe("13500000000000");
    expect(terahashToHashes("0.000000000001")).toBe("1");
    expect(terahashToHashes("110 TH/s")).toBe("110000000000000");
  });

  it("refuse un hashrate nul ou invalide", () => {
    expect(terahashToHashes("0")).toBeNull();
    expect(terahashToHashes("")).toBeNull();
    expect(terahashToHashes("-1")).toBeNull();
  });

  it("formate et préremplit", () => {
    expect(formatHashrate("95000000000000")).toBe("95 TH/s");
    expect(formatHashrate("13500000000000")).toBe("13,5 TH/s");
    expect(formatHashrate("1200000000000000")).toBe("1 200 TH/s");
    expect(hashesToTerahashInput("13500000000000")).toBe("13,5");
    expect(hashesToTerahashInput("95000000000000")).toBe("95");
  });
});

describe("parseScaledDecimal", () => {
  it("respecte l'échelle demandée", () => {
    expect(parseScaledDecimal("3", 0)).toBe("3");
    expect(parseScaledDecimal("3,1", 0)).toBeNull();
    expect(parseScaledDecimal("3,0", 0)).toBe("3");
  });
});
