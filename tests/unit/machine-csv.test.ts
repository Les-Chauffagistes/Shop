import { describe, expect, it } from "vitest";
import { parseMachineCsv } from "@/lib/machine-csv";

const HEADER3 = "name,serial,board1_statut,board2_statut,board3_statut";

describe("parseMachineCsv", () => {
  it("lit les lignes d'un modèle à 3 hashboards", () => {
    const { rows, issues } = parseMachineCsv(`${HEADER3}\nM1,SN1,ok,degraded,dead\nM2,SN2,ok,,ok\n`, 3);
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      { line: 2, name: "M1", serial: "SN1", boards: ["ok", "degraded", "dead"] },
      { line: 3, name: "M2", serial: "SN2", boards: ["ok", null, "ok"] },
    ]);
  });

  it("refuse le fichier entier quand le nombre de hashboards diffère du modèle", () => {
    for (const [csv, qtt] of [[`${HEADER3}\nM1,SN1,ok,ok,ok`, 4], [`${HEADER3}\nM1,SN1,ok,ok,ok`, 2]] as const) {
      const { rows, issues } = parseMachineCsv(csv, qtt);
      expect(rows).toEqual([]);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain(`${qtt} hashboard`);
    }
  });

  it("accepte le point-virgule, le BOM, les guillemets et les statuts français", () => {
    const { rows, issues } = parseMachineCsv("﻿name;serial;board1_statut\r\n\"A;1\";SN1;Dégradée\r\n", 1);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({ name: "A;1", serial: "SN1", boards: ["degraded"] });
  });

  it("rapporte chaque ligne fautive", () => {
    const { issues } = parseMachineCsv(`${HEADER3}\nM1,SN1,ok,bof,ok\nM2,,ok,ok,ok\nM3,SN1,ok,ok,ok\nM4,SN4,ok\n`, 3);
    expect(issues.map((i) => i.line)).toEqual([2, 3, 4, 5]);
  });

  it("refuse un fichier vide ou sans machine", () => {
    expect(parseMachineCsv("", 3).issues).toHaveLength(1);
    expect(parseMachineCsv(HEADER3, 3).issues).toHaveLength(1);
  });
});
