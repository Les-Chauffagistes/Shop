import type { BatchKind, BatchStatus } from "../../prisma/generated/enums";
import { plural } from "../lib/plural";

/**
 * Machine à états du lot : domaine pur (aucun accès base), importable par l'UI.
 *
 * Deux types de lot (`Batch.kind`, immuable) : la palette (`wholesale`, cycle de vie complet) et le lot de stock
 * (`stock`, un par modèle : `draft` = en pause, `on_sale` = en vente). Deux niveaux de garde :
 * - la base n'accepte que les couples de `TRANSITIONS[kind]` (fonction SQL `batch_transition_allowed(kind, from, to)`,
 *   migration batches ; un test d'intégration vérifie que les deux tables sont identiques, pour chaque type) et
 *   refuse l'annulation tant qu'une commande est payée ;
 * - ce module ajoute les conditions métier qui dépendent des données du lot (revue logistique
 *   §5.1, T1 à T18, et décisions de docs/roadmap.md) : `evaluateTransition`.
 * Le changement effectif passe par `changeBatchStatus` (src/server/batches.ts).
 */

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  draft: "Brouillon",
  survey: "Sondage",
  preorder: "Précommande",
  ordering: "Commande en cours",
  awaiting_reception: "Attente de réception",
  inspection: "Contrôle",
  tuning: "Tuning",
  packaging: "Packaging",
  in_transit: "En transit",
  closed: "Clôturé",
  cancelled: "Annulé",
  on_sale: "En vente",
};

export const BATCH_KIND_LABELS: Record<BatchKind, string> = { wholesale: "Palette", stock: "Stock" };

/**
 * Libellé d'un statut au backoffice : celui du statut, sauf le lot de stock hors vente (`draft`), « En pause » (il
 * n'a ni sondage ni publication : il est en vente ou ne l'est pas).
 */
export function batchStatusLabel(kind: BatchKind, status: BatchStatus): string {
  return kind === "stock" && status === "draft" ? "En pause" : BATCH_STATUS_LABELS[status];
}

/** Libellé public d'un lot visible : « En stock » pour le lot de stock (machines en main), le statut sinon. */
export function publicStatusLabel(kind: BatchKind, status: BatchStatus): string {
  return kind === "stock" ? "En stock" : BATCH_STATUS_LABELS[status];
}

const ALL_STATUSES = Object.keys(BATCH_STATUS_LABELS) as BatchStatus[];

/** Table vide : un statut sans sortie (ou hors du type) n'a aucune entrée. */
function only<T>(entries: Partial<Record<BatchStatus, readonly T[]>>): Record<BatchStatus, readonly T[]> {
  return Object.fromEntries(ALL_STATUSES.map((s) => [s, entries[s] ?? []])) as Record<BatchStatus, readonly T[]>;
}

/**
 * Couples autorisés par type de lot, identiques à `batch_transition_allowed(kind, …)` (dans l'ordre d'affichage) :
 * - palette : revue logistique T1 à T18 ; `on_sale` n'existe pas ;
 * - lot de stock : mise en vente et pause, sans fin (`draft` ↔ `on_sale`, décision Hugo 2026-11-10).
 */
export const TRANSITIONS: Record<BatchKind, Record<BatchStatus, readonly BatchStatus[]>> = {
  wholesale: only({
    draft: ["survey", "preorder", "ordering", "cancelled"],
    survey: ["preorder", "draft", "cancelled"],
    preorder: ["ordering", "cancelled"],
    ordering: ["awaiting_reception", "cancelled"],
    awaiting_reception: ["inspection", "cancelled"],
    inspection: ["tuning", "packaging", "awaiting_reception"],
    tuning: ["packaging", "inspection"],
    packaging: ["in_transit", "tuning", "inspection"],
    in_transit: ["closed"],
  }),
  stock: only({ draft: ["on_sale"], on_sale: ["draft"] }),
};

/**
 * Statuts où le lot accepte des commandes : palette de la Précommande au Packaging inclus, lot de stock en vente
 * (`on_sale`, statut propre au stock : Batch_kind_status_check). La règle se lit donc sur le statut seul, pour les
 * deux types. Identique à la fonction SQL `batch_accepts_orders` (source de la règle en base ; un test d'intégration
 * vérifie l'égalité pour chaque type et chacun de ses statuts). Une
 * transition vers un autre statut annule les factures en attente sans versement (v5h, v5i).
 */
export const ACCEPTS_ORDERS: ReadonlySet<BatchStatus> = new Set<BatchStatus>([
  "preorder",
  "ordering",
  "awaiting_reception",
  "inspection",
  "tuning",
  "packaging",
  "on_sale",
]);

/** Mise en pause d'un lot de stock : ni retour arrière ni annulation, sans motif obligatoire. */
const PAUSE = new Set(["on_sale>draft"]);

/** Retours arrière (correction d'erreur) : motif obligatoire, comme pour l'annulation. */
const BACKWARD = new Set([
  "survey>draft",
  "inspection>awaiting_reception",
  "tuning>inspection",
  "packaging>tuning",
  "packaging>inspection",
]);

const ACTION_LABELS: Record<string, string> = {
  "draft>survey": "Publier pour sondage",
  "draft>preorder": "Ouvrir les précommandes (sans sondage)",
  "draft>ordering": "Commander sur fonds propres",
  "survey>preorder": "Ouvrir les précommandes",
  "survey>draft": "Dépublier (retour en brouillon)",
  "preorder>ordering": "Confirmer la commande du lot",
  "ordering>awaiting_reception": "Confirmer l'attente de réception",
  "awaiting_reception>inspection": "Confirmer la réception",
  "inspection>tuning": "Passer en tuning",
  "inspection>packaging": "Passer en packaging",
  "inspection>awaiting_reception": "Revenir à l'attente de réception",
  "tuning>packaging": "Passer en packaging",
  "tuning>inspection": "Revenir au contrôle",
  "packaging>in_transit": "Confirmer la remise au transporteur",
  "packaging>tuning": "Revenir au tuning",
  "packaging>inspection": "Revenir au contrôle",
  "in_transit>closed": "Clôturer le lot",
  "draft>on_sale": "Mettre en vente",
  "on_sale>draft": "Mettre en pause",
};

/**
 * Données du lot dont dépendent les conditions (lues par `loadFacts`, src/server/batches.ts ; compteurs de machines et
 * de lignes payées : vue batch_machine_summary, source unique).
 */
export type BatchFacts = {
  kind: BatchKind;
  status: BatchStatus;
  hasResalePrice: boolean;
  /** batch_available_stock : capacité − machines payées et réservées */
  availableStock: number;
  /**
   * Palette : machines qui partiraient au lot de stock à la clôture (fonction SQL machine_unsold, partagée par la vue
   * batch_machine_summary et le trigger BatchStatusTransition_close_to_stock)
   */
  machinesToStock: number;
  /**
   * Titres des menus visibles sur le lot qui proposent moins de deux valeurs : menu « choix » sans
   * alternative (revue qualité M2) ou menu Avec/Sans dont « Avec » est retiré du lot ; une seule
   * valeur offerte n'a pas de sens pour l'acheteur. Un menu masqué n'est pas concerné. Vide si tout va bien.
   */
  menusWithoutChoice: readonly string[];
  /** Commandes payées (au moins une ligne active) */
  paidOrders: number;
  /** Factures en attente dont la réservation de 30 min court encore */
  pendingOrders: number;
  /**
   * Parmi elles, celles sans aucun versement : une transition qui ferme les commandes les annule
   * (trigger BatchStatusTransition_cancel_orders, même condition)
   */
  unpaidPendingOrders: number;
  /** Machines reçues (ni expected ni missing) */
  receivedMachines: number;
  /** Machines reçues dont l'état fonctionnel n'est pas encore saisi */
  uncheckedMachines: number;
  /** Machines dont l'état fonctionnel est saisi */
  checkedMachines: number;
  /** Lignes payées actives ayant une machine attribuée */
  assignedLines: number;
  /** Lignes payées actives dont une option comporte des pièces à monter */
  linesNeedingParts: number;
  /** Commandes de matériel d'options non livrées */
  undeliveredPartOrders: number;
  /** Machines en cours de montage */
  machinesInPreparation: number;
  /** Machines remises au transporteur ou livrées */
  shippedMachines: number;
  /** Lignes payées actives dont la machine n'est pas livrée (ou pas encore attribuée) */
  undeliveredLines: number;
  /** Machines encore attendues (ni reçues ni manquantes) */
  expectedMachines: number;
  /** Lignes payées en trop (batch_surplus_lines) */
  surplusLines: number;
  /**
   * Lignes payées dont la machine est défectueuse ou perdue, ou dont le montage n'est pas celui de la ligne
   * (machine_fits_configuration) : à remplacer ou à remonter
   */
  linesToReplace: number;
  /** Parmi `linesToReplace`, machine saine mais au montage non conforme : à remonter (lines_to_remount) */
  linesToRemount: number;
  /** Lignes payées sans machine attribuée */
  unassignedLines: number;
};

/**
 * Blocage de sortie du Contrôle d'une palette (jalon 5 bis), même ordre que le trigger
 * BatchStatusTransition_1b_inspection_exit : nom de la contrainte que la base lèverait, `null` si rien ne bloque.
 * Seule la base fait foi ; ces faits (lus dans batch_machine_summary) servent à nommer le blocage et à l'afficher.
 */
export function inspectionExitBlock(facts: BatchFacts, to: BatchStatus): string | null {
  if (facts.status === "inspection" && (to === "tuning" || to === "packaging")) {
    if (facts.expectedMachines > 0) return "BatchStatusTransition_inspection_expected";
    if (facts.surplusLines > 0) return "BatchStatusTransition_inspection_surplus";
    if (facts.linesToReplace > 0) return "BatchStatusTransition_inspection_replace";
  }
  if (to === "packaging" && facts.unassignedLines > 0) return "BatchStatusTransition_packaging_unassigned";
  return null;
}

/** `pause` : mise en pause d'un lot de stock (ni retour arrière, ni annulation, ni action principale). */
export type TransitionKind = "forward" | "backward" | "cancel" | "pause";

export type TransitionCheck = {
  to: BatchStatus;
  toLabel: string;
  /** Libellé du bouton */
  action: string;
  kind: TransitionKind;
  /** Motif (note) obligatoire */
  noteRequired: boolean;
  /** Faisable maintenant : aucune condition bloquante */
  allowed: boolean;
  /** Conditions non remplies, en français (vide si allowed) */
  blockers: string[];
  /** Points d'attention non bloquants, à confirmer par l'admin */
  warnings: string[];
  /**
   * Factures en attente sans versement que la transition annulera (lot qui ferme les commandes : En
   * transit, Clôturé, Annulé), à annoncer dans la confirmation ; 0 sinon. Compte lu à l'affichage : un
   * paiement reçu entre-temps exclut sa facture
   */
  cancelsPendingOrders: number;
};

function isTransitionAllowed(kind: BatchKind, from: BatchStatus, to: BatchStatus): boolean {
  return TRANSITIONS[kind][from].includes(to);
}

/**
 * Message de la règle « un menu visible (choix ou Avec/Sans) propose au moins deux valeurs » : condition de
 * publication, et refus d'une modification qui l'enfreindrait sur un lot publié (batches.ts).
 */
export function menusWithoutChoiceMessage(titles: readonly string[]): string {
  const names = titles.map((t) => `« ${t} »`).join(", ");
  const subject = titles.length > 1 ? `Les menus ${names} proposent` : `Le menu ${names} propose`;
  return `${subject} moins de deux valeurs sur ce lot : ajoutez une valeur au catalogue, rétablissez une valeur retirée ou masquez le menu.`;
}

/** Conditions métier de `from > to` ; suppose le couple autorisé. */
function conditions(facts: BatchFacts, to: BatchStatus): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const block = (when: boolean, message: string) => {
    if (when) blockers.push(message);
  };
  const warn = (when: boolean, message: string) => {
    if (when) warnings.push(message);
  };

  // Lot qui ferme les commandes (annulé, en transit, clôturé) : ses factures en attente sans versement sont annulées
  const cancelled = cancelsPendingOrders(facts, to);
  warn(
    cancelled > 0,
    `${plural(cancelled, "facture en attente de paiement, sans versement, sera annulée", "factures en attente de paiement, sans versement, seront annulées")} (réservation libérée ; elles ne sont jamais supprimées). Un paiement reçu ensuite n'est pas remboursé automatiquement : il reste dans « À traiter ».`,
  );
  if (to === "cancelled") {
    block(
      facts.paidOrders > 0,
      `${plural(facts.paidOrders, "commande payée", "commandes payées")} : remboursez-les avant d'annuler le lot.`,
    );
    return { blockers, warnings };
  }

  // Sortie du Contrôle (jalon 5 bis) : machines attendues, commandes en trop, lignes à remplacer ou sans machine
  const exitBlock = facts.kind === "wholesale" ? inspectionExitBlock(facts, to) : null;
  block(
    exitBlock === "BatchStatusTransition_inspection_expected",
    `${plural(facts.expectedMachines, "machine est encore attendue", "machines sont encore attendues")} : marquez-les reçues ou manquantes.`,
  );
  block(
    exitBlock === "BatchStatusTransition_inspection_surplus",
    `${plural(facts.surplusLines, "commande payée dépasse", "commandes payées dépassent")} les machines utilisables : remboursez-les.`,
  );
  if (exitBlock === "BatchStatusTransition_inspection_replace") {
    const broken = facts.linesToReplace - facts.linesToRemount;
    block(broken > 0, `${plural(broken, "ligne a", "lignes ont")} une machine défectueuse ou perdue : remplacez-la.`);
    block(
      facts.linesToRemount > 0,
      `${plural(facts.linesToRemount, "ligne a", "lignes ont")} une machine au montage non conforme à la commande : remontez-la avec les kits de la commande, ou remplacez-la.`,
    );
  }
  block(
    exitBlock === "BatchStatusTransition_packaging_unassigned",
    `${plural(facts.unassignedLines, "ligne payée n'a", "lignes payées n'ont")} pas de machine : attribuez-les.`,
  );

  switch (`${facts.status}>${to}`) {
    // T1, T2, T3 : publication, précommande sans sondage, court-circuit du financement
    case "draft>survey":
    case "draft>preorder":
    case "draft>ordering":
    case "draft>on_sale":
      block(!facts.hasResalePrice, "Renseignez le prix de revente unitaire.");
      block(facts.menusWithoutChoice.length > 0, menusWithoutChoiceMessage(facts.menusWithoutChoice));
      if (to === "preorder") warn(true, "Sans sondage, aucun utilisateur ne sera prioritaire.");
      if (to === "on_sale") {
        warn(
          facts.availableStock <= 0,
          "Aucune machine n'est disponible pour l'instant : le lot sera affiché épuisé tant qu'aucune machine n'est reçue et contrôlée (toutes ses hashboards ok).",
        );
      }
      break;
    // Lot de stock : pause (plus visible ni commandable ; les commandes payées se servent quand même)
    case "on_sale>draft":
      warn(true, "Le lot ne sera plus visible ni commandable. Les commandes payées restent à servir.");
      break;
    // T6 : décision manuelle de l'admin, pas de seuil imposé (question ouverte)
    case "preorder>ordering":
      warn(facts.paidOrders === 0, "Aucune précommande payée : l'achat du lot ne sera pas financé par les précommandes.");
      break;
    // T8 : réception partielle autorisée
    case "awaiting_reception>inspection":
      block(facts.receivedMachines === 0, "Aucune machine n'est enregistrée comme reçue.");
      break;
    // T9 : contrôle terminé, quelque chose à monter, pièces livrées
    case "inspection>tuning":
      block(
        facts.uncheckedMachines > 0,
        `${plural(facts.uncheckedMachines, "machine reçue n'est pas contrôlée", "machines reçues ne sont pas contrôlées")}.`,
      );
      block(facts.linesNeedingParts === 0, "Aucune machine commandée n'a d'option à monter : passez directement en packaging.");
      block(
        facts.undeliveredPartOrders > 0,
        `${plural(facts.undeliveredPartOrders, "commande de pièces n'est pas livrée", "commandes de pièces ne sont pas livrées")}.`,
      );
      break;
    // T10 : saut du tuning quand rien n'est à monter
    case "inspection>packaging":
      block(
        facts.uncheckedMachines > 0,
        `${plural(facts.uncheckedMachines, "machine reçue n'est pas contrôlée", "machines reçues ne sont pas contrôlées")}.`,
      );
      block(
        facts.linesNeedingParts > 0,
        `${plural(facts.linesNeedingParts, "machine commandée a", "machines commandées ont")} des options à monter : passez par le tuning.`,
      );
      break;
    // T11
    case "tuning>packaging":
      block(
        facts.machinesInPreparation > 0,
        `${plural(facts.machinesInPreparation, "machine est", "machines sont")} encore en montage.`,
      );
      break;
    // T12 : au moins une machine partie (expédition partielle possible)
    case "packaging>in_transit":
      block(facts.shippedMachines === 0, "Aucune machine n'a été remise au transporteur.");
      break;
    // T13 : chaque machine vendue est livrée (une machine perdue doit être remplacée ou remboursée)
    case "in_transit>closed":
      block(
        facts.undeliveredLines > 0,
        `${plural(facts.undeliveredLines, "machine vendue n'est pas livrée", "machines vendues ne sont pas livrées")} (ou pas attribuée).`,
      );
      warn(
        facts.machinesToStock > 0,
        `${plural(facts.machinesToStock, "machine invendue partira", "machines invendues partiront")} au lot de stock du modèle (créé en pause s'il n'existe pas).`,
      );
      break;
    // T5 : dépublication
    case "survey>draft":
      warn(true, "Le lot ne sera plus visible ; les manifestations d'intérêt sont conservées.");
      break;
    // T16 : retour possible tant que rien n'est contrôlé ni attribué
    case "inspection>awaiting_reception":
      block(
        facts.checkedMachines > 0,
        `${plural(facts.checkedMachines, "machine est déjà contrôlée", "machines sont déjà contrôlées")}.`,
      );
      block(
        facts.assignedLines > 0,
        `${plural(facts.assignedLines, "machine est déjà attribuée", "machines sont déjà attribuées")}.`,
      );
      break;
    // T18 : rien n'est encore parti
    case "packaging>tuning":
    case "packaging>inspection":
      block(
        facts.shippedMachines > 0,
        `${plural(facts.shippedMachines, "machine est déjà remise", "machines sont déjà remises")} au transporteur.`,
      );
      break;
  }
  return { blockers, warnings };
}

/** Factures en attente sans versement annulées par la transition vers `to` (statut qui n'accepte pas de commande). */
function cancelsPendingOrders(facts: BatchFacts, to: BatchStatus): number {
  return ACCEPTS_ORDERS.has(to) ? 0 : facts.unpaidPendingOrders;
}

/** Évalue une transition demandée. `null` si le couple n'existe pas dans la table. */
export function evaluateTransition(facts: BatchFacts, to: BatchStatus): TransitionCheck | null {
  if (!isTransitionAllowed(facts.kind, facts.status, to)) return null;
  const key = `${facts.status}>${to}`;
  let kind: TransitionKind = "forward";
  if (to === "cancelled") kind = "cancel";
  else if (BACKWARD.has(key)) kind = "backward";
  else if (PAUSE.has(key)) kind = "pause";
  const { blockers, warnings } = conditions(facts, to);
  return {
    to,
    toLabel: BATCH_STATUS_LABELS[to],
    action: to === "cancelled" ? "Annuler le lot" : ACTION_LABELS[key],
    kind,
    noteRequired: kind === "backward" || kind === "cancel",
    allowed: blockers.length === 0,
    blockers,
    warnings,
    cancelsPendingOrders: cancelsPendingOrders(facts, to),
  };
}

/** Toutes les transitions sortantes du statut courant, faisables ou non (pour l'UI). */
export function availableTransitions(facts: BatchFacts): TransitionCheck[] {
  return TRANSITIONS[facts.kind][facts.status].map((to) => evaluateTransition(facts, to)!);
}

/** Prochaine action : la première transition vers l'avant faisable, sinon la première vers l'avant. */
export function nextAction<T extends Pick<TransitionCheck, "kind" | "allowed">>(transitions: readonly T[]): T | undefined {
  return transitions.find((t) => t.kind === "forward" && t.allowed) ?? transitions.find((t) => t.kind === "forward");
}

// ─── Champs modifiables selon le statut ───

export type BatchField =
  | "name"
  | "modelId"
  | "quantity"
  | "purchasePrice"
  | "resaleUnitPrice"
  /** Retrait d'une valeur d'option (enabled) et dérogation de prix */
  | "optionAvailability"
  /** Quantité maximale d'une valeur d'option */
  | "optionMaxQty"
  /** Menus masqués (la valeur par défaut s'applique d'office) */
  | "hiddenOptions";

export const BATCH_FIELD_LABELS: Record<BatchField, string> = {
  name: "Nom",
  modelId: "Modèle",
  quantity: "Quantité",
  purchasePrice: "Prix d'achat",
  resaleUnitPrice: "Prix de revente",
  optionAvailability: "Options retirées et dérogations de prix",
  optionMaxQty: "Quantités maximales des options",
  hiddenOptions: "Menus masqués",
};

/**
 * Règles d'une palette :
 * - modèle : brouillon uniquement (rien n'est encore publié ni facturé) ;
 * - prix de revente, options retirées, dérogations, menus masqués : jusqu'au sondage (affichés
 *   au public, les wishlists en gardent une copie) ; figés dès que des factures peuvent exister
 *   (la base fige aussi les menus masqués : BatchOption_hidden_locked) ;
 * - quantité et prix d'achat : jusqu'à « Commande en cours » (achat en cours de négociation),
 *   la quantité ne descend jamais sous les machines vendues ou réservées ;
 * - quantités max d'options : tant que des commandes sont possibles (jusqu'au packaging) ;
 * - nom : jusqu'à l'expédition ; rien n'est modifiable sur un lot clôturé ou annulé.
 * Lot de stock (vivant, sans fin) : ni modèle (le lot de stock du modèle), ni quantité ni prix d'achat (portés par
 * les réassorts). Nom, prix de revente, options retirées, dérogations et quantités max : à tout moment (les factures
 * gardent leur instantané ; en vente, les prix catalogue des valeurs proposées sont figés par la base, d'où les
 * dérogations). Menus masqués : en pause seulement (la base fige `hidden` hors brouillon et sondage,
 * BatchOption_hidden_locked) et tant qu'aucune commande n'a de choix dans le menu (BatchOption_hidden_chosen).
 */
export const EDITABLE_FIELDS: Record<BatchKind, Record<BatchStatus, readonly BatchField[]>> = {
  wholesale: only({
    draft: ["name", "modelId", "quantity", "purchasePrice", "resaleUnitPrice", "optionAvailability", "optionMaxQty", "hiddenOptions"],
    survey: ["name", "quantity", "purchasePrice", "resaleUnitPrice", "optionAvailability", "optionMaxQty", "hiddenOptions"],
    preorder: ["name", "quantity", "purchasePrice", "optionMaxQty"],
    ordering: ["name", "quantity", "purchasePrice", "optionMaxQty"],
    awaiting_reception: ["name", "optionMaxQty"],
    inspection: ["name", "optionMaxQty"],
    tuning: ["name", "optionMaxQty"],
    packaging: ["name", "optionMaxQty"],
    in_transit: ["name"],
  }),
  stock: only({
    draft: ["name", "resaleUnitPrice", "optionAvailability", "optionMaxQty", "hiddenOptions"],
    on_sale: ["name", "resaleUnitPrice", "optionAvailability", "optionMaxQty"],
  }),
};

export function isFieldEditable(kind: BatchKind, status: BatchStatus, field: BatchField): boolean {
  return EDITABLE_FIELDS[kind][status].includes(field);
}
