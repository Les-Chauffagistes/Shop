import { describe, expect, it } from "vitest";
import { MachineFunctionalStatus, MachineLogisticalStatus } from "../../prisma/generated/client";
import { isInHand, machineChangeNeedsNote, machineTransitionAllowed } from "@/server/machine-status";
import { prisma } from "./db";

// Une seule règle des deux côtés : la table des transitions d'une machine et le motif obligatoire de
// src/server/machine-status.ts (affichage) sont identiques aux fonctions SQL machine_transition_allowed,
// machine_change_needs_note et machine_in_hand (seule garde), pour tous les couples.

const LOGISTICAL = Object.values(MachineLogisticalStatus);
const FUNCTIONAL = Object.values(MachineFunctionalStatus);

describe("statuts d'une machine : domaine (TS) identique à la base (SQL)", () => {
  it("machine_transition_allowed : tous les couples logistiques", async () => {
    const rows = await prisma.$queryRaw<{ f: MachineLogisticalStatus; t: MachineLogisticalStatus; allowed: boolean }[]>`
      SELECT f::text AS "f", t::text AS "t", "machine_transition_allowed"(f, t) AS "allowed"
      FROM unnest(enum_range(NULL::"machine_logistical_status")) f, unnest(enum_range(NULL::"machine_logistical_status")) t`;
    expect(rows).toHaveLength(LOGISTICAL.length ** 2);
    for (const r of rows) expect(machineTransitionAllowed(r.f, r.t), `${r.f} > ${r.t}`).toBe(r.allowed);
  });

  it("machine_change_needs_note : toutes les combinaisons logistiques et fonctionnelles", async () => {
    const rows = await prisma.$queryRaw<
      { fl: MachineLogisticalStatus; tl: MachineLogisticalStatus; ff: MachineFunctionalStatus; tf: MachineFunctionalStatus; needs: boolean }[]
    >`
      SELECT fl::text AS "fl", tl::text AS "tl", ff::text AS "ff", tf::text AS "tf", "machine_change_needs_note"(fl, tl, ff, tf) AS "needs"
      FROM unnest(enum_range(NULL::"machine_logistical_status")) fl, unnest(enum_range(NULL::"machine_logistical_status")) tl,
           unnest(enum_range(NULL::"machine_functional_status")) ff, unnest(enum_range(NULL::"machine_functional_status")) tf`;
    expect(rows).toHaveLength(LOGISTICAL.length ** 2 * FUNCTIONAL.length ** 2);
    for (const r of rows) expect(machineChangeNeedsNote(r.fl, r.tl, r.ff, r.tf), `${r.fl}>${r.tl} ${r.ff}>${r.tf}`).toBe(r.needs);
  });

  it("machine_in_hand : chaque statut logistique", async () => {
    const rows = await prisma.$queryRaw<{ s: MachineLogisticalStatus; in_hand: boolean }[]>`
      SELECT s::text AS "s", "machine_in_hand"(s) AS "in_hand" FROM unnest(enum_range(NULL::"machine_logistical_status")) s`;
    expect(rows).toHaveLength(LOGISTICAL.length);
    for (const r of rows) expect(isInHand(r.s), r.s).toBe(r.in_hand);
  });
});
