import type { getBatchMachines, getMachine, MachineDto } from "@/server/machines";

/** Machine telle que l'API la renvoie (docs/api.md, objet `Machine`). */
export type Machine = MachineDto;

/** Fiche d'une machine : la machine, plus ses journaux. */
export type MachineDetail = Awaited<ReturnType<typeof getMachine>>;

/** Machines et commandes payées d'un lot (`GET /batches/{id}/machines`). */
export type BatchMachines = Awaited<ReturnType<typeof getBatchMachines>>;

/** Ligne payée active d'un lot (`MachineLine`). */
export type MachineLine = BatchMachines["lines"][number];

/** Compteurs de `batch_machine_summary` (camelCase) : 0 pour une colonne absente. */
export function summaryCount(summary: BatchMachines["summary"], key: string): number {
  return Number(summary[key] ?? 0);
}

/** Couleur du badge de l'état fonctionnel. */
export const FUNCTIONAL_TONE: Record<Machine["functionalStatus"], string> = {
  unknown: "neutral",
  ok: "sale",
  degraded: "warning",
  faulty: "cancelled",
};

/** Libellé court d'une machine dans une liste : son numéro de série, sinon « Sans numéro ». */
export const machineName = (m: { serial: string | null }) => m.serial ?? "Sans numéro";
