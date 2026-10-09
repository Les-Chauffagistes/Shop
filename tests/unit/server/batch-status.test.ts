import { describe, expect, it } from "vitest";
import type { BatchStatus } from "../../../prisma/generated/enums";
import {
  availableTransitions,
  BATCH_STATUS_LABELS,
  type BatchFacts,
  EDITABLE_FIELDS,
  evaluateTransition,
  isFieldEditable,
  TRANSITIONS,
} from "@/server/batch-status";

const ALL = Object.keys(BATCH_STATUS_LABELS) as BatchStatus[];

/** Lot « neutre » : rien de vendu, rien de reçu, prix de revente renseigné. */
function facts(status: BatchStatus, overrides: Partial<BatchFacts> = {}): BatchFacts {
  return {
    status,
    hasResalePrice: true,
    menusWithoutChoice: [],
    paidOrders: 0,
    pendingOrders: 0,
    receivedMachines: 0,
    uncheckedMachines: 0,
    checkedMachines: 0,
    assignedLines: 0,
    linesNeedingParts: 0,
    undeliveredPartOrders: 0,
    machinesInPreparation: 0,
    shippedMachines: 0,
    undeliveredLines: 0,
    ...overrides,
  };
}

describe("table des transitions", () => {
  it("suit la revue logistique T1–T18 (avec closed terminal)", () => {
    const pairs = ALL.flatMap((from) => TRANSITIONS[from].map((to) => `${from}>${to}`));
    expect(pairs.sort()).toEqual(
      [
        "draft>survey", "draft>preorder", "draft>ordering", "draft>cancelled",
        "survey>preorder", "survey>draft", "survey>cancelled",
        "preorder>ordering", "preorder>cancelled",
        "ordering>awaiting_reception", "ordering>cancelled",
        "awaiting_reception>inspection", "awaiting_reception>cancelled",
        "inspection>tuning", "inspection>packaging", "inspection>awaiting_reception",
        "tuning>packaging", "tuning>inspection",
        "packaging>in_transit", "packaging>tuning", "packaging>inspection",
        "in_transit>closed",
      ].sort(),
    );
  });

  it("aucun retour vers sondage ou brouillon une fois la précommande ouverte", () => {
    for (const from of ALL.filter((s) => s !== "draft" && s !== "survey")) {
      expect(TRANSITIONS[from]).not.toContain("draft");
      expect(TRANSITIONS[from]).not.toContain("survey");
    }
  });

  it("closed et cancelled sont terminaux ; plus d'annulation après la réception", () => {
    expect(TRANSITIONS.closed).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
    for (const from of ["inspection", "tuning", "packaging", "in_transit"] as const) {
      expect(TRANSITIONS[from]).not.toContain("cancelled");
    }
  });

  it("refuse un couple absent de la table (saut d'étape)", () => {
    expect(evaluateTransition(facts("survey"), "inspection")).toBeNull();
    expect(evaluateTransition(facts("preorder"), "survey")).toBeNull();
    expect(evaluateTransition(facts("closed"), "draft")).toBeNull();
  });
});

type Case = {
  name: string;
  from: BatchStatus;
  to: BatchStatus;
  facts?: Partial<BatchFacts>;
  allowed: boolean;
  blocker?: RegExp;
  warning?: RegExp;
};

const CASES: Case[] = [
  // Publication : prix de revente requis (T1, T2, T3)
  { name: "T1 sans prix de revente", from: "draft", to: "survey", facts: { hasResalePrice: false }, allowed: false, blocker: /prix de revente/ },
  { name: "T1 publication", from: "draft", to: "survey", allowed: true },
  { name: "T2 sondage ignoré", from: "draft", to: "preorder", allowed: true, warning: /aucun utilisateur ne sera prioritaire/ },
  { name: "T2 sans prix", from: "draft", to: "preorder", facts: { hasResalePrice: false }, allowed: false },
  { name: "T3 court-circuit du financement", from: "draft", to: "ordering", allowed: true },
  { name: "T3 sans prix", from: "draft", to: "ordering", facts: { hasResalePrice: false }, allowed: false },
  // M2 : un menu visible (« choix » ou Avec/Sans) propose au moins deux valeurs (publication)
  {
    name: "T1 menu choix sans alternative",
    from: "draft",
    to: "survey",
    facts: { menusWithoutChoice: ["Kit de ventilation"] },
    allowed: false,
    blocker: /^Le menu « Kit de ventilation » propose moins de deux valeurs sur ce lot : .*masquez le menu\.$/,
  },
  {
    name: "T2 plusieurs menus sans alternative",
    from: "draft",
    to: "preorder",
    facts: { menusWithoutChoice: ["A", "B"] },
    allowed: false,
    blocker: /^Les menus « A », « B » proposent moins de deux valeurs/,
  },
  { name: "T3 menu choix sans alternative", from: "draft", to: "ordering", facts: { menusWithoutChoice: ["A"] }, allowed: false },
  {
    name: "T1 menu Avec/Sans dont « Avec » est retiré",
    from: "draft",
    to: "survey",
    facts: { menusWithoutChoice: ["Nettoyage"] },
    allowed: false,
    blocker: /^Le menu « Nettoyage » propose moins de deux valeurs sur ce lot/,
  },
  { name: "T4 non concerné (lot déjà publié)", from: "survey", to: "preorder", facts: { menusWithoutChoice: ["A"] }, allowed: true },
  { name: "T4 ouverture des précommandes", from: "survey", to: "preorder", allowed: true },
  { name: "T5 dépublication", from: "survey", to: "draft", allowed: true, warning: /plus visible/ },
  // T6 : décision manuelle, pas de seuil
  { name: "T6 sans précommande payée", from: "preorder", to: "ordering", allowed: true, warning: /Aucune précommande payée/ },
  { name: "T6 avec précommandes", from: "preorder", to: "ordering", facts: { paidOrders: 3 }, allowed: true },
  { name: "T7", from: "ordering", to: "awaiting_reception", allowed: true },
  // T8 : au moins une machine reçue
  { name: "T8 rien reçu", from: "awaiting_reception", to: "inspection", allowed: false, blocker: /Aucune machine/ },
  { name: "T8 réception partielle", from: "awaiting_reception", to: "inspection", facts: { receivedMachines: 1 }, allowed: true },
  // T9 / T10
  {
    name: "T9 machines non contrôlées",
    from: "inspection",
    to: "tuning",
    facts: { uncheckedMachines: 2, linesNeedingParts: 1 },
    allowed: false,
    blocker: /2 machines reçues ne sont pas contrôlées/,
  },
  { name: "T9 rien à monter", from: "inspection", to: "tuning", allowed: false, blocker: /passez directement en packaging/ },
  {
    name: "T9 pièces non livrées",
    from: "inspection",
    to: "tuning",
    facts: { linesNeedingParts: 1, undeliveredPartOrders: 1 },
    allowed: false,
    blocker: /pièces n'est pas livrée/,
  },
  { name: "T9 ok", from: "inspection", to: "tuning", facts: { linesNeedingParts: 2 }, allowed: true },
  { name: "T10 options à monter", from: "inspection", to: "packaging", facts: { linesNeedingParts: 1 }, allowed: false, blocker: /tuning/ },
  { name: "T10 machine non contrôlée", from: "inspection", to: "packaging", facts: { uncheckedMachines: 1 }, allowed: false },
  { name: "T10 ok", from: "inspection", to: "packaging", allowed: true },
  { name: "T11 montage en cours", from: "tuning", to: "packaging", facts: { machinesInPreparation: 1 }, allowed: false, blocker: /montage/ },
  { name: "T11 ok", from: "tuning", to: "packaging", allowed: true },
  { name: "T12 rien d'expédié", from: "packaging", to: "in_transit", allowed: false, blocker: /transporteur/ },
  { name: "T12 expédition partielle", from: "packaging", to: "in_transit", facts: { shippedMachines: 1 }, allowed: true },
  { name: "T13 machine non livrée", from: "in_transit", to: "closed", facts: { undeliveredLines: 1 }, allowed: false, blocker: /pas livrée/ },
  { name: "T13 ok", from: "in_transit", to: "closed", allowed: true },
  // Annulation (T14, T15) : impossible tant qu'une commande est payée
  { name: "T14 brouillon", from: "draft", to: "cancelled", allowed: true },
  { name: "T14 commande payée", from: "preorder", to: "cancelled", facts: { paidOrders: 2 }, allowed: false, blocker: /2 commandes payées/ },
  {
    name: "T14 factures en attente",
    from: "preorder",
    to: "cancelled",
    facts: { pendingOrders: 1 },
    allowed: true,
    warning: /sera annulée/,
  },
  { name: "T15 commande payée", from: "awaiting_reception", to: "cancelled", facts: { paidOrders: 1 }, allowed: false },
  { name: "T15 sans paiement", from: "ordering", to: "cancelled", allowed: true },
  // Retours arrière (T16 à T18)
  { name: "T16 machines contrôlées", from: "inspection", to: "awaiting_reception", facts: { checkedMachines: 1 }, allowed: false },
  { name: "T16 machines attribuées", from: "inspection", to: "awaiting_reception", facts: { assignedLines: 1 }, allowed: false },
  { name: "T16 ok", from: "inspection", to: "awaiting_reception", facts: { receivedMachines: 3 }, allowed: true },
  { name: "T17", from: "tuning", to: "inspection", allowed: true },
  { name: "T18 déjà expédié", from: "packaging", to: "tuning", facts: { shippedMachines: 1 }, allowed: false },
  { name: "T18 vers contrôle déjà expédié", from: "packaging", to: "inspection", facts: { shippedMachines: 1 }, allowed: false },
  { name: "T18 ok", from: "packaging", to: "inspection", allowed: true },
];

describe("conditions métier", () => {
  it.each(CASES)("$name : $from > $to", ({ from, to, facts: overrides, allowed, blocker, warning }) => {
    const check = evaluateTransition(facts(from, overrides), to);
    expect(check).not.toBeNull();
    expect(check!.allowed).toBe(allowed);
    expect(check!.blockers.length === 0).toBe(allowed);
    if (blocker) expect(check!.blockers.join(" ")).toMatch(blocker);
    if (warning) expect(check!.warnings.join(" ")).toMatch(warning);
  });

  it("couvre chaque couple de la table au moins une fois", () => {
    const covered = new Set(CASES.map((c) => `${c.from}>${c.to}`));
    const pairs = ALL.flatMap((from) => TRANSITIONS[from].map((to) => `${from}>${to}`));
    expect(pairs.filter((p) => !covered.has(p) && !p.endsWith(">cancelled"))).toEqual([]);
  });
});

describe("motif obligatoire", () => {
  it.each([
    ["survey", "draft", true],
    ["inspection", "awaiting_reception", true],
    ["tuning", "inspection", true],
    ["packaging", "tuning", true],
    ["packaging", "inspection", true],
    ["draft", "cancelled", true],
    ["draft", "survey", false],
    ["preorder", "ordering", false],
  ] as const)("%s > %s : %s", (from, to, required) => {
    const check = evaluateTransition(facts(from), to)!;
    expect(check.noteRequired).toBe(required);
    expect(check.kind).toBe(to === "cancelled" ? "cancel" : required ? "backward" : "forward");
  });
});

describe("availableTransitions", () => {
  it("liste les sorties du statut dans l'ordre, avec libellés et état", () => {
    const list = availableTransitions(facts("draft", { hasResalePrice: false }));
    expect(list.map((t) => [t.to, t.allowed])).toEqual([
      ["survey", false],
      ["preorder", false],
      ["ordering", false],
      ["cancelled", true],
    ]);
    expect(list[0]).toMatchObject({ action: "Publier pour sondage", toLabel: "Sondage", kind: "forward" });
    expect(list[3]).toMatchObject({ action: "Annuler le lot", kind: "cancel", noteRequired: true });
  });

  it("aucune action sur un lot terminé", () => {
    expect(availableTransitions(facts("closed"))).toEqual([]);
    expect(availableTransitions(facts("cancelled"))).toEqual([]);
  });
});

describe("champs modifiables par statut", () => {
  it.each([
    ["draft", "modelId", true],
    ["survey", "modelId", false],
    ["survey", "hiddenOptions", true],
    ["preorder", "hiddenOptions", false],
    ["survey", "resaleUnitPrice", true],
    ["preorder", "resaleUnitPrice", false],
    ["survey", "optionAvailability", true],
    ["preorder", "optionAvailability", false],
    ["ordering", "quantity", true],
    ["awaiting_reception", "quantity", false],
    ["ordering", "purchasePrice", true],
    ["awaiting_reception", "purchasePrice", false],
    ["packaging", "optionMaxQty", true],
    ["in_transit", "optionMaxQty", false],
    ["in_transit", "name", true],
    ["closed", "name", false],
    ["cancelled", "name", false],
  ] as const)("%s : %s modifiable = %s", (status, field, editable) => {
    expect(isFieldEditable(status, field)).toBe(editable);
  });

  it("définit chaque statut", () => {
    expect(Object.keys(EDITABLE_FIELDS).sort()).toEqual([...ALL].sort());
  });
});
