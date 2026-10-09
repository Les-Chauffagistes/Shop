import type { BatchStatus } from "../../prisma/generated/enums";
import { plural } from "../lib/plural";

/**
 * Machine à états du lot : domaine pur (aucun accès base), importable par l'UI.
 *
 * Deux niveaux de garde :
 * - la base n'accepte que les couples de `TRANSITIONS` (fonction SQL `batch_transition_allowed`,
 *   migration init ; un test d'intégration vérifie que les deux tables sont identiques) et refuse
 *   l'annulation tant qu'une commande est payée ;
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
};

/** Couples autorisés, identiques à `batch_transition_allowed` (dans l'ordre d'affichage). */
export const TRANSITIONS: Record<BatchStatus, readonly BatchStatus[]> = {
  draft: ["survey", "preorder", "ordering", "cancelled"],
  survey: ["preorder", "draft", "cancelled"],
  preorder: ["ordering", "cancelled"],
  ordering: ["awaiting_reception", "cancelled"],
  awaiting_reception: ["inspection", "cancelled"],
  inspection: ["tuning", "packaging", "awaiting_reception"],
  tuning: ["packaging", "inspection"],
  packaging: ["in_transit", "tuning", "inspection"],
  in_transit: ["closed"],
  closed: [],
  cancelled: [],
};

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
};

/** Données du lot dont dépendent les conditions (calculées par `loadBatchFacts`). */
export type BatchFacts = {
  status: BatchStatus;
  hasResalePrice: boolean;
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
};

export type TransitionKind = "forward" | "backward" | "cancel";

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
};

function isTransitionAllowed(from: BatchStatus, to: BatchStatus): boolean {
  return TRANSITIONS[from].includes(to);
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

  if (to === "cancelled") {
    block(
      facts.paidOrders > 0,
      `${plural(facts.paidOrders, "commande payée", "commandes payées")} : remboursez-les avant d'annuler le lot.`,
    );
    warn(
      facts.pendingOrders > 0,
      `${plural(facts.pendingOrders, "facture est en attente", "factures sont en attente")} de paiement : ${facts.pendingOrders > 1 ? "elles seront annulées" : "elle sera annulée"} avec le lot (réservation libérée), sauf si un versement a déjà été reçu. Un paiement reçu ensuite n'est pas remboursé automatiquement : il reste dans « À traiter ».`,
    );
    return { blockers, warnings };
  }

  switch (`${facts.status}>${to}`) {
    // T1, T2, T3 : publication, précommande sans sondage, court-circuit du financement
    case "draft>survey":
    case "draft>preorder":
    case "draft>ordering":
      block(!facts.hasResalePrice, "Renseignez le prix de revente unitaire.");
      block(facts.menusWithoutChoice.length > 0, menusWithoutChoiceMessage(facts.menusWithoutChoice));
      if (to === "preorder") warn(true, "Sans sondage, aucun utilisateur ne sera prioritaire.");
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

/** Évalue une transition demandée. `null` si le couple n'existe pas dans la table. */
export function evaluateTransition(facts: BatchFacts, to: BatchStatus): TransitionCheck | null {
  if (!isTransitionAllowed(facts.status, to)) return null;
  const key = `${facts.status}>${to}`;
  const kind: TransitionKind = to === "cancelled" ? "cancel" : BACKWARD.has(key) ? "backward" : "forward";
  const { blockers, warnings } = conditions(facts, to);
  return {
    to,
    toLabel: BATCH_STATUS_LABELS[to],
    action: to === "cancelled" ? "Annuler le lot" : ACTION_LABELS[key],
    kind,
    noteRequired: kind !== "forward",
    allowed: blockers.length === 0,
    blockers,
    warnings,
  };
}

/** Toutes les transitions sortantes du statut courant, faisables ou non (pour l'UI). */
export function availableTransitions(facts: BatchFacts): TransitionCheck[] {
  return TRANSITIONS[facts.status].map((to) => evaluateTransition(facts, to)!);
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
 * Règles :
 * - modèle : brouillon uniquement (rien n'est encore publié ni facturé) ;
 * - prix de revente, options retirées, dérogations, menus masqués : jusqu'au sondage (affichés
 *   au public, les wishlists en gardent une copie) ; figés dès que des factures peuvent exister
 *   (la base fige aussi les menus masqués : BatchOption_hidden_locked) ;
 * - quantité et prix d'achat : jusqu'à « Commande en cours » (achat en cours de négociation),
 *   la quantité ne descend jamais sous les machines vendues ou réservées ;
 * - quantités max d'options : tant que des commandes sont possibles (jusqu'au packaging) ;
 * - nom : jusqu'à l'expédition ; rien n'est modifiable sur un lot clôturé ou annulé.
 */
export const EDITABLE_FIELDS: Record<BatchStatus, readonly BatchField[]> = {
  draft: ["name", "modelId", "quantity", "purchasePrice", "resaleUnitPrice", "optionAvailability", "optionMaxQty", "hiddenOptions"],
  survey: ["name", "quantity", "purchasePrice", "resaleUnitPrice", "optionAvailability", "optionMaxQty", "hiddenOptions"],
  preorder: ["name", "quantity", "purchasePrice", "optionMaxQty"],
  ordering: ["name", "quantity", "purchasePrice", "optionMaxQty"],
  awaiting_reception: ["name", "optionMaxQty"],
  inspection: ["name", "optionMaxQty"],
  tuning: ["name", "optionMaxQty"],
  packaging: ["name", "optionMaxQty"],
  in_transit: ["name"],
  closed: [],
  cancelled: [],
};

export function isFieldEditable(status: BatchStatus, field: BatchField): boolean {
  return EDITABLE_FIELDS[status].includes(field);
}
