import type {
  BatchStatus,
  HashboardStatusValue,
  MachineFunctionalStatus,
  MachineLogisticalStatus,
} from "../../prisma/generated/enums";

/**
 * Statuts d'une machine : domaine pur (aucun accès base), importable par l'UI.
 *
 * La base est la seule garde (fonctions SQL `machine_transition_allowed` et `machine_change_needs_note`, migration
 * machines) ; ce module en est la copie exacte pour l'affichage (boutons, motif obligatoire), vérifiée par un test
 * d'intégration exhaustif (tests/integration/machine-status-vs-sql.test.ts), comme `TRANSITIONS` des lots.
 * Les statuts d'une machine ne dépendent pas du statut de son lot, sauf lot annulé (machines figées).
 */

export const MACHINE_LOGISTICAL_LABELS: Record<MachineLogisticalStatus, string> = {
  expected: "Attendue",
  in_stock: "En stock",
  in_preparation: "En montage",
  ready: "Prête",
  in_transit: "En transit",
  delivered: "Livrée",
  missing: "Manquante",
  lost: "Perdue",
  returned: "Retournée",
  scrapped: "Au rebut",
};

export const MACHINE_FUNCTIONAL_LABELS: Record<MachineFunctionalStatus, string> = {
  unknown: "Non contrôlée",
  ok: "OK",
  degraded: "Dégradée",
  faulty: "Défectueuse",
};

/** Hashboard contrôlée (`not_checked` n'est jamais écrit : l'absence de saisie vaut « non contrôlée »). */
export const HASHBOARD_LABELS: Record<Exclude<HashboardStatusValue, "not_checked">, string> = {
  ok: "OK",
  degraded: "Dégradée",
  dead: "Morte",
};

/**
 * Transitions logistiques sortantes (revue logistique §5.2, M1 à M15), dans l'ordre d'affichage (action principale
 * d'abord). Identique à `machine_transition_allowed` (le même statut des deux côtés n'est pas une transition : une
 * ligne du journal qui ne change que l'état fonctionnel garde le statut logistique). Terminal : livrée (le rebut se défait avec un motif, tant que la place n'est pas reprise).
 */
export const MACHINE_TRANSITIONS: Record<MachineLogisticalStatus, readonly MachineLogisticalStatus[]> = {
  expected: ["in_stock", "missing"],
  missing: ["in_stock"],
  in_stock: ["ready", "in_preparation", "scrapped"],
  in_preparation: ["ready", "in_stock"],
  ready: ["in_transit", "in_stock"],
  in_transit: ["delivered", "lost", "returned"],
  returned: ["in_stock"],
  lost: ["in_stock"],
  delivered: [],
  scrapped: ["in_stock"],
};

const ACTION_LABELS: Record<string, string> = {
  "expected>in_stock": "Marquer reçue",
  "expected>missing": "Marquer manquante",
  "missing>in_stock": "Retrouvée",
  "in_stock>in_preparation": "Démarrer le montage",
  "in_stock>ready": "Marquer prête",
  "in_stock>scrapped": "Mettre au rebut",
  "in_preparation>ready": "Montage terminé",
  "in_preparation>in_stock": "Interrompre le montage",
  "ready>in_transit": "Remettre au transporteur",
  "ready>in_stock": "Retour en stock",
  "in_transit>delivered": "Marquer livrée",
  "in_transit>lost": "Marquer perdue",
  "in_transit>returned": "Marquer retournée",
  "returned>in_stock": "Remettre en stock (à recontrôler)",
  "lost>in_stock": "Retrouvée (à recontrôler)",
  "scrapped>in_stock": "Annuler la mise au rebut",
};

/** Retours arrière, sorties du flux et réapparitions : motif obligatoire (même liste que machine_change_needs_note). */
const NOTE_REQUIRED_TARGETS: ReadonlySet<MachineLogisticalStatus> = new Set(["missing", "scrapped", "lost", "returned"]);
const NOTE_REQUIRED_MOVES = new Set([
  "missing>in_stock",
  "in_preparation>in_stock",
  "ready>in_stock",
  "returned>in_stock",
  "lost>in_stock",
  "scrapped>in_stock",
]);

export function machineTransitionAllowed(from: MachineLogisticalStatus, to: MachineLogisticalStatus): boolean {
  return from === to || MACHINE_TRANSITIONS[from].includes(to);
}

/**
 * Motif obligatoire (identique à `machine_change_needs_note`) : sortie du flux (manquante, au rebut, perdue,
 * retournée), retour arrière, et correction d'un état fonctionnel déjà saisi (ok ↔ degraded ↔ faulty).
 */
export function machineChangeNeedsNote(
  fromLogistical: MachineLogisticalStatus,
  toLogistical: MachineLogisticalStatus,
  fromFunctional: MachineFunctionalStatus,
  toFunctional: MachineFunctionalStatus,
): boolean {
  const moved =
    fromLogistical !== toLogistical &&
    (NOTE_REQUIRED_TARGETS.has(toLogistical) || NOTE_REQUIRED_MOVES.has(`${fromLogistical}>${toLogistical}`));
  return moved || (fromFunctional !== "unknown" && toFunctional !== fromFunctional);
}

/** Machine dans les mains de la boutique (identique à `machine_in_hand`) : seul état où l'on contrôle et attribue. */
export function isInHand(status: MachineLogisticalStatus): boolean {
  return status === "in_stock" || status === "in_preparation" || status === "ready";
}

/** Ce que l'UI sait d'une machine pour proposer ses actions (le serveur décide). */
export type MachineFacts = {
  logistical: MachineLogisticalStatus;
  functional: MachineFunctionalStatus;
  batchStatus: BatchStatus;
  /** Machine d'une ligne active (facture payée, non remboursée) de son lot */
  hasActiveLine: boolean;
};

export type MachineChange = {
  to: MachineLogisticalStatus;
  toLabel: string;
  /** Libellé du bouton */
  action: string;
  noteRequired: boolean;
  allowed: boolean;
  /** Raisons connues du serveur qui empêchent l'action (vide si `allowed`) */
  blockers: string[];
};

/** Transitions logistiques sortantes d'une machine, faisables ou non, avec leurs conditions connues. */
export function nextMachineChanges(m: MachineFacts): MachineChange[] {
  return MACHINE_TRANSITIONS[m.logistical].map((to) => {
    const blockers: string[] = [];
    if (m.batchStatus === "cancelled") blockers.push("Le lot est annulé : ses machines sont figées.");
    if ((to === "in_preparation" || to === "ready") && m.functional !== "ok" && m.functional !== "degraded") {
      blockers.push(
        m.functional === "faulty" ? "Une machine défectueuse ne se prépare pas." : "Contrôlez d'abord la machine (OK ou dégradée).",
      );
    }
    if (to === "in_transit" && !m.hasActiveLine) blockers.push("Attribuez d'abord la machine à une commande payée.");
    if (to === "scrapped" && m.functional !== "faulty") {
      blockers.push("Seule une machine défectueuse se met au rebut : marquez-la défectueuse d'abord.");
    }
    return {
      to,
      toLabel: MACHINE_LOGISTICAL_LABELS[to],
      action: ACTION_LABELS[`${m.logistical}>${to}`],
      noteRequired: machineChangeNeedsNote(m.logistical, to, m.functional, m.functional),
      allowed: blockers.length === 0,
      blockers,
    };
  });
}
