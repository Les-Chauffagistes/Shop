import type { BatchKind, BatchStatus, OffchainMeans, OrderStatus, PaymentMethod, RefundCause } from "../../prisma/generated/enums";
import { machines } from "../lib/plural";
import { BATCH_STATUS_LABELS } from "./batch-status";
import {
  ApiError,
  apiErrorOf,
  CONTACT_EMAIL_REQUIRED,
  EXCESS_ALREADY_DISMISSED,
  NOTHING_TO_DISMISS,
  REFUND_ADDRESS_OFFCHAIN,
} from "./errors";

/**
 * Règles des factures (précommande, commande, paiement, remboursement) : domaine pur, sans accès
 * base. Les mêmes règles sont imposées par la base (triggers Order_guard, OrderLine_guard,
 * Refund_*, vue order_payment_balance) ; ici on les vérifie avant d'écrire pour donner un message
 * clair, daté et chiffré. La base reste le dernier rempart (src/server/errors.ts).
 */

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: "En attente de paiement",
  paid: "Payée",
  expired: "Expirée",
  refunded: "Remboursée",
  cancelled: "Annulée",
};

/**
 * Statut affiché : une facture en attente dont la réservation de 30 min est passée est expirée,
 * même si la base ne l'a pas encore écrit (l'expiration se lit sur l'horloge, sans job).
 */
export function displayStatus(status: OrderStatus, expiresAt: Date, now: Date): OrderStatus {
  return status === "pending_payment" && expiresAt <= now ? "expired" : status;
}

/** Précommande, ou commande simple : machines reçues et triées (palette en Tuning, Packaging) ou en stock. */
export type OrderKind = "preorder" | "order";

export const ORDER_KIND_LABELS: Record<OrderKind, string> = { preorder: "Précommande", order: "Commande" };

/** Motif d'un remboursement (Refund.cause) : il fixe qui paie les frais réseau (refund_cause_fee_payer, en base). */
export const REFUND_CAUSE_LABELS: Record<RefundCause, string> = {
  shop_stock: "Souci de stock (surplus, lot abandonné)",
  shop_defective_machine: "Machine défectueuse",
  user_renounce: "Renoncement de l'utilisateur",
  partial_payment: "Remboursement d'un paiement partiel",
  late_payment_no_room: "Paiement tardif sans place",
  overpayment: "Excédent de paiement",
  discount: "Rabais",
  admin_other: "Autre décision de la boutique",
};

/**
 * Motifs d'une annulation de machines d'une commande payée par l'admin. `user_renounce` : annulation à la
 * demande de l'utilisateur, à toute étape (la fenêtre de la Précommande ne vaut que quand il renonce
 * lui-même), frais à la charge de la boutique comme les autres motifs (l1), compte pour le blocage
 * (v5g, Refund_cause_check, Refund_check_renounce).
 */
export const ADMIN_CANCELLATION_CAUSES = [
  "shop_stock",
  "shop_defective_machine",
  "user_renounce",
  "admin_other",
] as const satisfies readonly RefundCause[];

/**
 * Motifs d'un remboursement d'une vente payée hors chaîne (décision Hugo 2026-11-11), décidé par l'admin, en euros,
 * sans frais réseau : jamais les motifs propres à la chaîne (paiement partiel, paiement tardif, excédent) ni le
 * renoncement (rétractation hors périmètre). Même liste en base (Refund_method_check) : test d'égalité
 * tests/integration/manual-sales-api.test.ts.
 */
export const OFFCHAIN_REFUND_CAUSES = [
  "shop_stock",
  "shop_defective_machine",
  "discount",
  "admin_other",
] as const satisfies readonly RefundCause[];

/** Motifs proposés pour annuler des machines d'une commande payée, selon son moyen de paiement. */
export function cancellationCauses(method: PaymentMethod): readonly RefundCause[] {
  return method === "offchain"
    ? ADMIN_CANCELLATION_CAUSES.filter((c) => (OFFCHAIN_REFUND_CAUSES as readonly RefundCause[]).includes(c))
    : ADMIN_CANCELLATION_CAUSES;
}

/** Moyen d'un encaissement hors chaîne (Payment.offchain_means). */
export const OFFCHAIN_MEANS_LABELS: Record<OffchainMeans, string> = {
  cash: "Espèces",
  bank_transfer: "Virement",
  other: "Autre",
};

/**
 * Nature d'une facture d'après le statut du lot à sa création (roadmap, « Stock et précommandes ») : commande pour
 * une palette en Tuning ou Packaging et pour un lot de stock en vente (machines en main), précommande sinon.
 */
export function orderKind(batchStatusAtCreation: BatchStatus | null): OrderKind {
  return batchStatusAtCreation === "tuning" || batchStatusAtCreation === "packaging" || batchStatusAtCreation === "on_sale"
    ? "order"
    : "preorder";
}

const dayTime = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});
const timeOnly = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });

/** « 8 octobre à 14:35 » (heure de Paris). */
export function formatDayTime(at: Date): string {
  const parts = dayTime.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} à ${get("hour")}:${get("minute")}`;
}

/** « 14:35 » (heure de Paris). */
export function formatTime(at: Date): string {
  return timeOnly.format(at);
}

// ─── Création d'une facture ───

/** Ce que la base sait du lot et de l'utilisateur au moment de créer une facture (orders.ts). */
export type OrderingContext = {
  batchKind: BatchKind;
  batchStatus: BatchStatus;
  /** batch_accepts_orders : palette de la Précommande au Packaging, lot de stock en vente */
  acceptsOrders: boolean;
  /** batch_priority_ends_at : fin de la journée de priorité (passée ou non), null s'il n'y en a pas */
  priorityEndsAt: Date | null;
  /** order_priority_machines_left : machines encore permises en priorité ; null hors journée de priorité */
  machinesLeft: number | null;
  /** Facture en attente encore vivante de l'utilisateur sur le lot */
  liveOrderId: string | null;
  /** user_batch_block : début du blocage en cours après trop d'abandons et de renoncements */
  blockedAt: Date | null;
  /** user_batch_block : levée automatique du blocage en cours (l'admin peut le lever avant) */
  blockEndsAt: Date | null;
  /** user_batch_cooldown_ends_at : fin du délai après le dernier abandon */
  cooldownEndsAt: Date | null;
  /** batch_available_stock (peut être négatif) */
  available: number;
  /** ShopSettings.order_max_lines */
  maxLines: number;
  /** Horloge de la base */
  now: Date;
};

/**
 * Refus de création d'une facture de `requested` machines, dans l'ordre des contrôles de la base :
 * lot ouvert, priorité, facture vivante, blocage, délai, puis lignes (plafond par facture, quota de
 * priorité) et stock. `null` : la création peut être tentée (la base tranche au COMMIT).
 */
export function checkOrderCreation(ctx: OrderingContext, requested: number): ApiError | null {
  return checkOrderOpening(ctx) ?? checkOrderLines(ctx, requested);
}

/** Message du refus « lot fermé aux commandes ». */
function batchNotOpenMessage(ctx: OrderingContext): string {
  if (ctx.batchKind === "stock") return "Ce lot n'est pas en vente pour le moment.";
  if (ctx.batchStatus === "survey") {
    return "Les précommandes de ce lot ne sont pas encore ouvertes : vous pouvez manifester votre intérêt en attendant.";
  }
  return `Ce lot n'accepte plus de commande (statut « ${BATCH_STATUS_LABELS[ctx.batchStatus]} »).`;
}

/** Contrôles propres au lot et au client (ouverture, priorité, facture vivante, blocage, délai). */
function checkOrderOpening(ctx: OrderingContext): ApiError | null {
  if (!ctx.acceptsOrders) {
    return new ApiError(
      409,
      "batch_not_open",
      batchNotOpenMessage(ctx),
      undefined,
      { details: { batchStatus: ctx.batchStatus } },
    );
  }
  const priorityEndsAt = ctx.priorityEndsAt?.toISOString() ?? null;
  if (ctx.machinesLeft !== null && ctx.machinesLeft <= 0) {
    const until = ctx.priorityEndsAt ? `jusqu'au ${formatDayTime(ctx.priorityEndsAt)}` : "pour l'instant";
    return new ApiError(
      409,
      "order_priority_window",
      `Les précommandes de ce lot sont réservées ${until} aux personnes qui avaient manifesté leur intérêt pendant le sondage, dans la limite des machines qu'elles avaient souhaitées. Vous pourrez commander ensuite, s'il reste du stock.`,
      undefined,
      { details: { priorityEndsAt, machinesLeft: 0 } },
    );
  }
  if (ctx.liveOrderId) {
    return new ApiError(
      409,
      "order_already_pending",
      "Vous avez déjà une facture en attente de paiement sur ce lot : payez-la ou annulez-la avant d'en créer une autre.",
      undefined,
      { details: { orderId: ctx.liveOrderId } },
    );
  }
  if (ctx.blockedAt && ctx.blockEndsAt) {
    return new ApiError(
      409,
      "order_creation_blocked",
      `Plusieurs de vos factures sur ce lot ont été abandonnées (annulées, expirées ou remboursées avant paiement complet) ou ont fait l'objet d'un renoncement : les commandes sont suspendues pour vous sur ce lot jusqu'au ${formatDayTime(ctx.blockEndsAt)}.`,
      undefined,
      { details: { blockedAt: ctx.blockedAt.toISOString(), blockEndsAt: ctx.blockEndsAt.toISOString() } },
    );
  }
  if (ctx.cooldownEndsAt) {
    return new ApiError(
      429,
      "order_cooldown",
      `Vous venez d'abandonner une facture sur ce lot : vous pourrez en créer une nouvelle à ${formatTime(ctx.cooldownEndsAt)}.`,
      undefined,
      {
        details: { cooldownEndsAt: ctx.cooldownEndsAt.toISOString() },
        retryAfterSeconds: (ctx.cooldownEndsAt.getTime() - ctx.now.getTime()) / 1000,
      },
    );
  }
  return null;
}

/** Contrôles sur les lignes demandées (plafond par facture, quota de priorité, stock). */
function checkOrderLines(ctx: OrderingContext, requested: number): ApiError | null {
  const priorityEndsAt = ctx.priorityEndsAt?.toISOString() ?? null;
  if (requested > ctx.maxLines) {
    return new ApiError(
      422,
      "order_too_many_lines",
      `Une facture compte au plus ${machines(ctx.maxLines)} : vous en demandez ${requested}.`,
      undefined,
      { details: { maxLines: ctx.maxLines } },
    );
  }
  if (ctx.machinesLeft !== null && requested > ctx.machinesLeft) {
    const until = ctx.priorityEndsAt ? `Jusqu'au ${formatDayTime(ctx.priorityEndsAt)}` : "Pendant la journée de priorité";
    return new ApiError(
      409,
      "order_priority_quota",
      `${until}, vous pouvez encore prendre ${machines(ctx.machinesLeft)} en priorité sur ce lot (autant que de machines souhaitées pendant le sondage) : vous en demandez ${requested}.`,
      undefined,
      { details: { priorityEndsAt, machinesLeft: ctx.machinesLeft } },
    );
  }
  if (requested > ctx.available) {
    const left = Math.max(0, ctx.available);
    return new ApiError(
      409,
      "out_of_stock",
      left === 0
        ? ctx.batchKind === "stock"
          ? "Plus aucune machine en stock pour le moment."
          : "Le stock du lot est épuisé."
        : `Il ne reste que ${machines(left)} ${ctx.batchKind === "stock" ? "en stock" : "sur ce lot"} : vous en demandez ${requested}.`,
      undefined,
      { details: { available: left } },
    );
  }
  return null;
}

// ─── Solde de paiement (vue order_payment_balance) ───

export type PaymentBalance = {
  status: OrderStatus;
  expiresAt: Date;
  totalAmount: bigint;
  /** Moyen de la facture : bitcoin (boutique en ligne) ou offchain (vente manuelle, montants en centimes) */
  paymentMethod: PaymentMethod;
  /** Montant attendu en sats ; null pour une vente hors chaîne */
  expectedSats: bigint | null;
  receivedSats: bigint;
  /** Sats sortis du solde par les remboursements (versés + frais à la charge de l'utilisateur) */
  refundedSats: bigint;
  /** Excédent d'une facture payée (jamais remboursé d'office : l'admin décide) */
  refundDueSats: bigint;
  /** Sats reçus non affectés (ni acceptés, ni remboursés, ni classés sans suite) */
  unsettledSats: bigint;
  /** Sats classés sans suite (OrderExcessDismissal, une fois par facture) ; 0 : aucun classement */
  dismissedSats: bigint;
  batchOpen: boolean;
  awaitingDecision: boolean;
  awaitingUserDecision: boolean;
  needsAdminDecision: boolean;
  userRefundAllowed: boolean;
  /** Un remboursement non envoyé n'a pas d'adresse (ni sur le remboursement ni sur la facture) */
  refundAddressMissing: boolean;
  /**
   * Facture payée dont l'excédent n'est pas (entièrement) remboursé : aucun remboursement automatique
   * d'excédent, quel qu'en soit le montant, l'admin décide (décision Hugo 2026-10-09)
   */
  overpaymentUnrefunded: boolean;
  /**
   * Paiement complet non encore accepté (`awaitingDecision`) : tiendrait-il dans le stock s'il était
   * accepté maintenant (sans verrou ; la décision reste Order_fits_stock) ? null hors de ce cas
   */
  fitsStock: boolean | null;
  /** Facture payée d'un lot au plus en Précommande : l'utilisateur peut y renoncer lui-même */
  userRenounceAllowed: boolean;
  /** Vente hors chaîne : un remboursement en euros est décidé mais pas encore rendu au client */
  offchainRefundUnsent: boolean;
  /** Horloge de la base */
  now: Date;
};

/** Paiement Bitcoin complet reçu (reçu >= attendu) ; toujours faux pour une vente hors chaîne. */
export function bitcoinPaidInFull(b: Pick<PaymentBalance, "expectedSats" | "receivedSats">): boolean {
  return b.expectedSats !== null && b.receivedSats >= b.expectedSats;
}

/**
 * Traitement automatique après un paiement (point d'entrée interne), jamais quand une décision
 * humaine est attendue (needs_admin_decision, awaiting_user_decision) :
 * - `decide` : paiement complet d'une facture non acceptée, lot ouvert : accepter s'il reste de la
 *   place (Order_fits_stock), sinon rembourser intégralement (frais à la charge de la boutique) ;
 * - `none` : rien d'automatique (appoint attendu, décision de l'utilisateur ou de l'admin). Un excédent
 *   n'est jamais remboursé d'office, quel que soit son montant : la facture payée reste « à traiter »
 *   (`overpaymentUnrefunded`) jusqu'à la décision de l'admin (Hugo, 2026-10-09).
 */
export function settlementStep(b: PaymentBalance): "decide" | "none" {
  if (b.needsAdminDecision || b.awaitingUserDecision) return "none";
  return b.awaitingDecision ? "decide" : "none";
}

/**
 * Remboursement demandé par l'utilisateur d'un paiement partiel (avant ou après l'expiration), frais
 * réseau à sa charge (décision Hugo 2026-10-07). Renvoie ce qu'il reçoit (reçu − frais) ou le refus.
 */
export function planUserRefund(b: PaymentBalance, networkFeeSats: bigint): { amountSats: bigint; networkFeeSats: bigint } | ApiError {
  if (b.status === "refunded") {
    return new ApiError(409, "order_already_refunded", "Cette facture est déjà remboursée.");
  }
  if (b.status === "paid") {
    return new ApiError(
      409,
      "refund_not_allowed",
      "Cette commande est payée : pour y renoncer, utilisez le renoncement (remboursement au prorata de ce que vous avez payé, frais réseau à notre charge) tant que le lot est en Précommande, ou contactez-nous ensuite.",
    );
  }
  if (b.status === "cancelled") {
    return new ApiError(
      409,
      "refund_not_allowed",
      "Cette facture est annulée : un paiement reçu ensuite est traité par nos soins, contactez-nous si besoin.",
    );
  }
  if (b.receivedSats === 0n) {
    return new ApiError(
      409,
      "order_nothing_received",
      "Aucun paiement n'a été reçu sur cette facture : il n'y a rien à rembourser. Vous pouvez simplement l'annuler tant qu'elle n'a pas expiré.",
    );
  }
  if (bitcoinPaidInFull(b)) {
    return new ApiError(
      409,
      "refund_not_allowed",
      "Votre paiement est complet : il est accepté s'il reste de la place sur le lot, sinon remboursé automatiquement.",
    );
  }
  if (!b.batchOpen || !b.userRefundAllowed) {
    return new ApiError(
      409,
      "refund_not_allowed",
      "Ce lot n'accepte plus de commande : votre versement vous sera remboursé par nos soins, frais à notre charge. Contactez-nous si besoin.",
    );
  }
  if (b.receivedSats <= networkFeeSats) {
    return new ApiError(
      409,
      "refund_below_network_fee",
      `Votre versement (${b.receivedSats} sats) ne couvre pas les frais réseau d'un remboursement (${networkFeeSats} sats) : complétez plutôt le paiement de la facture.`,
      undefined,
      { details: { receivedSats: b.receivedSats.toString(), networkFeeSats: networkFeeSats.toString() } },
    );
  }
  return { amountSats: b.receivedSats - networkFeeSats, networkFeeSats };
}

// ─── Backoffice « à traiter » ───

export type AttentionReason =
  | "admin_decision"
  | "user_decision"
  | "awaiting_decision"
  | "overpayment_decision"
  | "refund_address_missing"
  | "offchain_refund_unsent";

export type Attention = {
  reason: AttentionReason;
  /** Explication et prochaine action, pour l'admin */
  label: string;
  /** « Accepter » : passer la facture à payée (s'il reste de la place) */
  canAccept: boolean;
  /** « Rembourser » : `refundCauses` n'est pas vide */
  canRefund: boolean;
  /** Motifs que l'admin peut choisir pour « Rembourser » (le payeur des frais en découle) */
  refundCauses: RefundCause[];
};

type AttentionCore = Pick<Attention, "reason" | "label" | "canAccept">;

/** Libellé d'une facture annulée sur laquelle un paiement est arrivé. */
function cancelledPaymentLabel(b: PaymentBalance): string {
  if (b.dismissedSats > 0n) {
    return "Nouveau versement reçu sur une facture annulée dont des sats ont déjà été classés sans suite : rembourser (elle ne peut plus être acceptée).";
  }
  if (!b.batchOpen) {
    return "Paiement reçu sur une facture annulée d'un lot qui n'accepte plus de commande : rembourser.";
  }
  if (bitcoinPaidInFull(b)) {
    return "Paiement complet reçu après l'annulation : accepter la commande s'il reste de la place, sinon rembourser.";
  }
  return "Paiement reçu après l'annulation : rembourser (ou attendre l'appoint puis accepter).";
}

/** Facture nécessitant la décision de l'admin (paiement reçu alors qu'elle n'est plus acceptable). */
function adminDecisionAttention(b: PaymentBalance): AttentionCore {
  if (b.status === "cancelled") {
    return {
      reason: "admin_decision",
      label: cancelledPaymentLabel(b),
      // Une facture annulée dont des sats sont classés sans suite n'est plus acceptée (Order_dismissed_final)
      canAccept: bitcoinPaidInFull(b) && b.batchOpen && b.dismissedSats === 0n,
    };
  }
  if (b.status === "refunded") {
    return {
      reason: "admin_decision",
      label:
        "Sats reçus restés sur une facture remboursée (excédent laissé par l'annulation de toute la commande, ou versement arrivé ensuite) : contacter le client, puis rembourser ou, s'ils ne dépassent pas les frais réseau, classer sans suite.",
      canAccept: false,
    };
  }
  return {
    reason: "admin_decision",
    label: "Paiement reçu alors que le lot n'accepte plus de commande : rembourser.",
    canAccept: false,
  };
}

/** Paiement complet en attente de décision : accepter (ou rembourser faute de place). */
function awaitingDecisionAttention(b: PaymentBalance): AttentionCore {
  if (b.fitsStock === false && b.expiresAt > b.now) {
    return {
      reason: "awaiting_decision",
      label: `Paiement complet, mais la commande ne tient plus dans le stock du lot : à la fin de la réservation (${formatDayTime(b.expiresAt)}), « Accepter » la remboursera intégralement.`,
      canAccept: true,
    };
  }
  const label =
    b.fitsStock === false
      ? "Paiement complet, plus de place sur le lot : « Accepter » la rembourse intégralement (frais à la charge de la boutique)."
      : "Paiement complet pas encore traité : accepter (s'il reste de la place, sinon la facture est remboursée).";
  return { reason: "awaiting_decision", label, canAccept: true };
}

function attentionCore(b: PaymentBalance): AttentionCore | null {
  if (b.needsAdminDecision) return adminDecisionAttention(b);
  if (b.awaitingUserDecision) {
    return {
      reason: "user_decision",
      label:
        "Facture expirée partiellement payée : contacter l'utilisateur, qui choisit l'appoint ou le remboursement de son versement (frais réseau à sa charge). Sans réponse, la rembourser.",
      canAccept: false,
    };
  }
  if (b.awaitingDecision) return awaitingDecisionAttention(b);
  if (b.overpaymentUnrefunded) {
    return {
      reason: "overpayment_decision",
      label: `Excédent de ${b.unsettledSats} sats : aucun excédent n'est remboursé automatiquement. Contacter le client puis décider (rembourser aux frais de la boutique ou, si l'excédent les couvre, de l'utilisateur ; s'il ne dépasse pas les frais réseau, le classer sans suite).`,
      canAccept: false,
    };
  }
  if (b.refundAddressMissing) {
    return {
      reason: "refund_address_missing",
      label: "Remboursement à envoyer sans adresse Bitcoin : contacter l'utilisateur pour l'obtenir.",
      canAccept: false,
    };
  }
  if (b.offchainRefundUnsent) {
    return {
      reason: "offchain_refund_unsent",
      label:
        "Remboursement en euros à rendre au client (vente réglée hors chaîne) : rendre l'argent, puis enregistrer l'envoi avec sa référence dans « Remboursements ».",
      canAccept: false,
    };
  }
  return null;
}

/** Pourquoi une facture est « à traiter », et quelles actions de l'admin s'y appliquent. `null` : rien à traiter. */
export function attentionOf(b: PaymentBalance): Attention | null {
  const core = attentionCore(b);
  if (!core) return null;
  const plan = planAdminRefund(b);
  const refundCauses = plan instanceof ApiError ? [] : plan.causes;
  return { ...core, canRefund: refundCauses.length > 0, refundCauses };
}

// ─── Classer sans suite ───

/**
 * Classer sans suite les sats reçus non affectés d'une facture (décision Hugo 2026-10-09) : facture
 * payée, remboursée ou annulée (jamais en attente ou expirée : l'appoint reste possible ou l'utilisateur
 * choisit), somme non nulle et au plus égale aux frais réseau estimés d'un remboursement, une seule fois
 * par facture (un versement arrivé ensuite se rembourse). Mêmes règles en base (OrderExcessDismissal_*).
 * Renvoie la somme à classer (tout le non-affecté) ou le refus.
 */
export function planDismissal(b: PaymentBalance, networkFeeSats: bigint): { sats: bigint } | ApiError {
  if (b.status !== "paid" && b.status !== "refunded" && b.status !== "cancelled") {
    return apiErrorOf(
      NOTHING_TO_DISMISS,
      "Facture en attente ou expirée : rien ne se classe sans suite (l'appoint reste possible, ou l'utilisateur choisit le remboursement de son versement).",
    );
  }
  if (b.dismissedSats > 0n) return apiErrorOf(EXCESS_ALREADY_DISMISSED);
  if (b.unsettledSats <= 0n) return apiErrorOf(NOTHING_TO_DISMISS, "Aucune somme reçue n'est en attente de décision sur cette facture.");
  if (b.unsettledSats > networkFeeSats) {
    return new ApiError(
      409,
      "excess_above_network_fee",
      `Ces ${b.unsettledSats} sats dépassent les frais réseau d'un remboursement (${networkFeeSats} sats) : ils ne se classent pas sans suite, remboursez-les.`,
      undefined,
      { details: { unsettledSats: b.unsettledSats.toString(), networkFeeSats: networkFeeSats.toString() } },
    );
  }
  return { sats: b.unsettledSats };
}

// ─── E-mail de contact d'une facture ───

/**
 * E-mail de contact d'une nouvelle facture : celui saisi, sinon celui du profil ; aucun des deux :
 * `422 contact_email_required` (la base l'impose aussi : Order_contact_email_required). Un e-mail saisi
 * qui diffère du profil y est mémorisé (`remember`), dans la même transaction que la facture.
 */
export function resolveContactEmail(given: string | null, profileEmail: string | null): { email: string; remember: boolean } | ApiError {
  const email = given ?? profileEmail;
  if (!email) return apiErrorOf(CONTACT_EMAIL_REQUIRED);
  return { email, remember: given !== null && given !== profileEmail };
}

/** Remboursement par l'admin : nature, sats bruts sortis du solde, motifs permis (le premier n'est pas un défaut : l'admin choisit). */
export type AdminRefundPlan = { kind: "overpayment" | "cancellation"; amountSats: bigint; causes: RefundCause[] };

/**
 * Remboursement par l'admin d'une facture « à traiter » : tout ce qui a été reçu et n'est pas affecté.
 * Motifs permis selon le cas (la base impose les mêmes : Refund_cause_check, Refund_partial_payment_*,
 * Refund_late_payment_full) :
 * - facture expirée partiellement payée, sans réponse de l'utilisateur : annulation de toutes les lignes,
 *   `partial_payment` (frais à sa charge) ou `admin_other` ;
 * - excédent d'une facture payée resté sans remboursement : `admin_other` ou `overpayment` ;
 * - facture annulée ou impayée d'un lot fermé : annulation de toutes les lignes, `admin_other`,
 *   `shop_stock` (lot abandonné compris), et `late_payment_no_room` si le paiement est complet.
 * - facture remboursée avec un reste (excédent laissé par l'annulation de toute une commande payée, qui
 *   ne part jamais d'office, ou versement arrivé ensuite) : excédent, `overpayment` ou `admin_other`.
 * `user_renounce` n'y figure jamais : il annule des machines d'une commande payée (« cancel-lines ») ;
 * l'excédent restant après une annulation complète se décide ensuite ici, comme tout excédent.
 */
export function planAdminRefund(b: PaymentBalance): AdminRefundPlan | ApiError {
  if (b.awaitingDecision) {
    return new ApiError(
      409,
      "payment_must_be_accepted",
      "Paiement complet sur un lot ouvert : acceptez la facture (elle est remboursée automatiquement s'il ne reste plus de place).",
    );
  }
  if (b.awaitingUserDecision && b.unsettledSats > 0n) {
    return { kind: "cancellation", amountSats: b.unsettledSats, causes: ["partial_payment", "admin_other"] };
  }
  if (b.userRefundAllowed && b.expiresAt > b.now) {
    return new ApiError(
      409,
      "order_reservation_running",
      `La réservation de cette facture court jusqu'au ${formatDayTime(b.expiresAt)} : d'ici là, seul l'utilisateur choisit entre l'appoint et le remboursement de son versement.`,
      undefined,
      { details: { expiresAt: b.expiresAt.toISOString() } },
    );
  }
  if (b.status === "paid" && b.overpaymentUnrefunded && b.unsettledSats > 0n) {
    return { kind: "overpayment", amountSats: b.unsettledSats, causes: ["admin_other", "overpayment"] };
  }
  if (!b.needsAdminDecision || b.unsettledSats <= 0n) {
    return new ApiError(409, "order_nothing_to_refund", "Aucune somme reçue n'attend de décision sur cette facture.");
  }
  if (b.status === "refunded") {
    return { kind: "overpayment", amountSats: b.unsettledSats, causes: ["overpayment", "admin_other"] };
  }
  const causes: RefundCause[] = ["admin_other", "shop_stock"];
  if (bitcoinPaidInFull(b)) causes.push("late_payment_no_room");
  return { kind: "cancellation", amountSats: b.unsettledSats, causes };
}

/** Le motif choisi par l'admin doit être permis pour ce cas (`422 refund_cause_not_allowed` sinon). */
export function checkRefundCause(allowed: readonly RefundCause[], cause: RefundCause): ApiError | null {
  if (allowed.includes(cause)) return null;
  return new ApiError(
    422,
    "refund_cause_not_allowed",
    `Motif « ${REFUND_CAUSE_LABELS[cause]} » impossible ici. Motifs possibles : ${allowed.map((c) => `« ${REFUND_CAUSE_LABELS[c]} »`).join(", ")}.`,
    undefined,
    { details: { allowedCauses: allowed.join(",") } },
  );
}

// ─── Renoncement de l'utilisateur ───

/**
 * L'utilisateur renonce à une commande payée (palette au plus en Précommande ; après, seul l'admin annule). Lot de
 * stock : jamais par l'utilisateur (rétractation sur le stock hors périmètre, en attente du juriste).
 */
export function checkUserRenounce(b: PaymentBalance, batchKind: BatchKind): ApiError | null {
  if (b.status !== "paid") {
    return new ApiError(
      409,
      "order_not_paid",
      b.status === "refunded"
        ? "Cette commande est déjà remboursée."
        : "Seule une commande payée peut faire l'objet d'un renoncement : une facture en attente s'annule, un versement partiel se rembourse.",
    );
  }
  if (!b.userRenounceAllowed) {
    return new ApiError(
      409,
      "order_renounce_closed",
      b.paymentMethod === "offchain"
        ? "Cette commande a été conclue avec notre équipe : elle ne s'annule pas en ligne, contactez-nous."
        : batchKind === "stock"
        ? "Une commande de machines en stock ne s'annule pas en ligne : contactez-nous."
        : "Le lot a dépassé la phase de Précommande : vous ne pouvez plus renoncer vous-même à cette commande. Contactez-nous.",
    );
  }
  return null;
}

/**
 * Annulation par l'admin de machines d'une commande payée : lignes visées (toutes les lignes
 * actives si `lineIds` est absent). Renvoie le montant en centimes et si la commande devient
 * entièrement remboursée. Le montant est celui des lignes, au plus ce qui reste à rembourser
 * (`refundableCents` = total − annulations et rabais déjà faits) : après un rabais, l'annulation des
 * dernières machines rend le reste, pas plus que ce qui a été payé (Order_refunds).
 */
export function planLineCancellation(
  activeLines: readonly { id: string; amount: bigint }[],
  lineIds: readonly string[] | undefined,
  refundableCents: bigint,
): { lineIds: string[]; amount: bigint; whole: boolean } | ApiError {
  const active = new Map(activeLines.map((l) => [l.id, l.amount]));
  const ids = lineIds ? [...lineIds] : [...active.keys()];
  if (ids.length === 0) return new ApiError(409, "order_nothing_to_refund", "Cette commande n'a plus de machine à annuler.");
  const unknown = ids.filter((id) => !active.has(id));
  if (unknown.length > 0) {
    return new ApiError(422, "unknown_order_line", "Une des machines indiquées n'appartient pas à cette commande ou est déjà remboursée.");
  }
  const lines = ids.reduce((sum, id) => sum + active.get(id)!, 0n);
  const amount = lines < refundableCents ? lines : refundableCents;
  if (amount <= 0n) return new ApiError(409, "order_nothing_to_refund", "Tout ce qui a été payé est déjà remboursé.");
  return { lineIds: ids, amount, whole: ids.length === active.size };
}

/**
 * Rabais (remboursement partiel sans annuler de machine) sur une commande payée : `amount` centimes, strictement
 * moins que ce qui reste à rembourser (`refundableCents`) ; pour tout rendre, on annule les machines.
 */
export function checkDiscount(status: OrderStatus, amount: bigint, refundableCents: bigint): ApiError | null {
  if (status !== "paid") {
    return new ApiError(409, "order_not_paid", "Un rabais s'accorde seulement sur une commande payée.");
  }
  if (amount >= refundableCents) {
    return new ApiError(
      422,
      "discount_too_large",
      `Un rabais reste inférieur à ce qui a été payé et pas encore remboursé (${formatEuros(refundableCents)}) : pour tout rendre, annulez les machines.`,
      undefined,
      { details: { refundableAmount: refundableCents.toString() } },
    );
  }
  return null;
}

/** « 1 234,50 € » (montant en centimes). */
function formatEuros(cents: bigint): string {
  return `${(cents / 100n).toLocaleString("fr-FR")},${(cents % 100n).toString().padStart(2, "0")} €`;
}

/**
 * Remboursement d'une vente hors chaîne : motif permis (OFFCHAIN_REFUND_CAUSES) et jamais d'adresse Bitcoin (l'argent
 * se rend en espèces, par virement…). `null` : rien ne s'y oppose (la base tranche : Refund_method_check).
 */
export function checkOffchainRefund(cause: RefundCause, destinationAddress: string | null | undefined): ApiError | null {
  const refused = checkRefundCause(OFFCHAIN_REFUND_CAUSES, cause);
  if (refused) return refused;
  if (destinationAddress) return apiErrorOf(REFUND_ADDRESS_OFFCHAIN);
  return null;
}

// ─── Vente manuelle (backoffice) ───

/**
 * Refus d'une vente manuelle de `requested` machines : les règles de la boutique, sans exception de canal
 * (checkOrderCreation), formulées pour l'admin. Client bloqué : `details` porte `userId` et `batchId` pour lever le
 * blocage (`POST /api/backoffice/order-block-releases`) puis réessayer.
 */
export function checkManualSale(ctx: OrderingContext, requested: number, ids: { userId: string; batchId: string }): ApiError | null {
  const refused = checkOrderCreation(ctx, requested);
  if (!refused) return null;
  const details = refused.extra.details ?? {};
  const reword = (message: string, extra: Record<string, string> = {}) =>
    new ApiError(refused.status, refused.code, message, undefined, { ...refused.extra, details: { ...details, ...extra } });
  switch (refused.code) {
    case "batch_not_open":
      return reword(
        ctx.batchKind === "stock"
          ? "Ce lot de stock est en pause : remettez-le en vente pour y vendre."
          : `Ce lot n'accepte pas de commande au statut « ${BATCH_STATUS_LABELS[ctx.batchStatus]} » (de la Précommande au Packaging).`,
      );
    case "order_priority_window":
    case "order_priority_quota":
      return reword(
        `Journée de priorité en cours${ctx.priorityEndsAt ? ` jusqu'au ${formatDayTime(ctx.priorityEndsAt)}` : ""} : ce client peut encore prendre ${machines(ctx.machinesLeft ?? 0)} en priorité (ses manifestations d'intérêt).`,
      );
    case "order_already_pending":
      return reword("Ce client a une facture en attente de paiement sur ce lot : elle doit être payée, annulée ou expirée avant une vente manuelle.");
    case "order_creation_blocked":
      return reword(
        `Ce client est bloqué sur ce lot jusqu'au ${formatDayTime(ctx.blockEndsAt!)} (trop d'abandons ou de renoncements) : levez le blocage, puis validez de nouveau la vente.`,
        ids,
      );
    case "order_cooldown":
      return reword(`Ce client vient d'abandonner une facture sur ce lot : vente possible à ${formatTime(ctx.cooldownEndsAt!)}.`);
    case "order_too_many_lines":
      return reword(`Une facture compte au plus ${machines(ctx.maxLines)} : faites plusieurs ventes.`);
    case "out_of_stock": {
      const left = Math.max(0, ctx.available);
      return reword(
        left === 0
          ? "Plus aucune machine disponible sur ce lot (payées ou réservées par des factures en attente)."
          : `Il ne reste que ${machines(left)} sur ce lot : la vente en compte ${requested}.`,
      );
    }
    default:
      return refused;
  }
}
