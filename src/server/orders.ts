import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ActorKind,
  BatchStatus,
  OrderStatus,
  Prisma,
  RefundCause,
  RefundFeePayer,
  RefundInitiator,
  RefundKind,
} from "../../prisma/generated/client";
import { BATCH_STATUS_LABELS } from "./batch-status";
import { batchNotFound } from "./batches";
import { type Choice, writeConfiguration } from "./configurations";
import { getDb } from "./db";
import { ApiError, pgFailureOf } from "./errors";
import { bigintToJson, label, optionalText } from "./http";
import {
  checkOrderCreation,
  checkUserRenounce,
  displayStatus,
  ORDER_KIND_LABELS,
  ORDER_STATUS_LABELS,
  type OrderingContext,
  orderKind,
  type PaymentBalance,
  planLineCancellation,
  planUserRefund,
  REFUND_CAUSE_LABELS,
} from "./order-rules";
import { getPaymentService } from "./payment-service";

/**
 * Factures de l'utilisateur connecté (précommande, puis commande simple) : création sur un lot
 * ouvert aux commandes, lecture et suivi, annulation d'une facture impayée, remboursement d'un
 * paiement partiel et renoncement à une commande payée (frais réseau à sa charge), adresse de
 * remboursement de la facture (journalisée avec son auteur). Une facture = un utilisateur, un lot, une ligne par machine
 * (configuration complète, prix relus en base), payée en totalité en Bitcoin sur une adresse qui lui
 * est propre. Jamais supprimée (Order_no_delete). Règles : ./order-rules.ts (domaine pur) et la base.
 * Chacun ne voit que ses factures : celle d'un autre répond 404, comme une facture inconnue.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | ReturnType<typeof getDb>;

export const orderNotFound = () => new ApiError(404, "order_not_found", "Facture introuvable.");

// ─── Entrées ───

/** Adresse Bitcoin de l'utilisateur pour un remboursement (formats courants, sans vérification de somme de contrôle). */
export const bitcoinAddress = z
  .string()
  .trim()
  .regex(/^(bc1|tb1|bcrt1|[13mn2])[a-zA-HJ-NP-Z0-9]{25,87}$/, { error: "Adresse Bitcoin attendue" });

const choices = z.array(z.strictObject({ optionId: z.uuid(), optionValueId: z.uuid() })).max(100);

/** Une machine : la configuration d'une manifestation d'intérêt de l'utilisateur, ou des choix libres. */
const orderLineInput = z
  .strictObject({
    /** Manifestation d'intérêt convertie par cette ligne (sa configuration est reprise, prix relus) */
    wishlistId: z.uuid().optional(),
    /** Choix par menu ; un menu non choisi reçoit sa valeur par défaut (0 €) */
    choices: choices.optional(),
  })
  .refine((line) => !(line.wishlistId && line.choices), {
    error: "Une ligne reprend une manifestation d'intérêt ou porte des choix, pas les deux",
  });

const addressFields = z.strictObject({
  fullName: label(120),
  company: optionalText(120).optional(),
  line1: label(200),
  line2: optionalText(200).optional(),
  postalCode: label(20),
  city: label(120),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, { error: "Code pays à deux lettres attendu (ex. FR)" }),
  phone: optionalText(40).optional(),
});

/** Adresse : une adresse déjà enregistrée de l'utilisateur (`addressId`), ou une nouvelle. */
const addressInput = z.union([z.strictObject({ addressId: z.uuid() }), addressFields]);

/** Plafond technique d'une requête ; le plafond métier (ShopSettings.order_max_lines) est vérifié ensuite. */
const MAX_LINES_PER_REQUEST = 1000;

export const orderInput = z
  .strictObject({
    batchId: z.uuid(),
    lines: z.array(orderLineInput).min(1, { error: "Au moins une machine attendue" }).max(MAX_LINES_PER_REQUEST),
    billingAddress: addressInput,
    /** Absente : même adresse que la facturation */
    shippingAddress: addressInput.optional(),
    /** Adresse Bitcoin où rembourser, facultative (modifiable ensuite, tant que rien n'est envoyé) */
    refundAddress: bitcoinAddress.nullable().optional(),
  })
  .refine(
    (input) => {
      const ids = input.lines.flatMap((l) => (l.wishlistId ? [l.wishlistId] : []));
      return new Set(ids).size === ids.length;
    },
    { error: "Une manifestation d'intérêt est commandée deux fois", path: ["lines"] },
  );

export const orderListQuery = z.object({ batchId: z.uuid().optional() });

export const orderingQuery = z.object({ batchId: z.uuid() });

/**
 * Remboursement du versement partiel ; `refundAddress` facultative : écrite sur la facture (comme
 * `PATCH …/refund-address`), sinon celle déjà saisie sur la facture, sinon l'admin contacte l'utilisateur.
 */
export const userRefundInput = z.strictObject({ refundAddress: bitcoinAddress.optional() });

/** Adresse de remboursement de la facture ; `null` l'efface (tant qu'aucun remboursement n'est envoyé). */
export const refundAddressInput = z.strictObject({ refundAddress: bitcoinAddress.nullable() });

/** Renoncement : machines visées (absent : toutes les machines encore actives, donc toute la facture). */
export const renounceInput = z.strictObject({
  lineIds: z
    .array(z.uuid())
    .min(1, { error: "Choisissez au moins une machine" })
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, { error: "Une machine est listée deux fois" })
    .optional(),
});

/** Corps d'une action sans paramètre (`{}`) : JSON exigé comme toute écriture (protection CSRF). */
export const emptyInput = z.strictObject({});

// ─── Lecture ───

const orderInclude = {
  batch: { select: { id: true, name: true, status: true, model: { select: { id: true, name: true } } } },
  user: { select: { auth_user_id: true } },
  // Ordre de la requête : position posée par la base à l'insertion (unique par facture)
  lines: {
    orderBy: { position: "asc" },
    include: {
      configuration: {
        include: {
          items: {
            include: {
              option: { select: { title: true, position: true } },
              option_value: { select: { label: true, is_default: true } },
            },
          },
        },
      },
    },
  },
  payments: { orderBy: [{ received_at: "asc" }, { id: "asc" }] },
  refunds: { orderBy: [{ created_at: "asc" }, { id: "asc" }] },
  billing_address: true,
  shipping_address: true,
} satisfies Prisma.OrderInclude;

export type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

type BalanceRow = {
  order_id: string;
  status: OrderStatus;
  expires_at: Date;
  total_amount: bigint;
  expected_sats: bigint;
  received_sats: bigint;
  refunded_sats: bigint;
  outstanding_sats: bigint;
  refund_due_sats: bigint;
  unsettled_sats: bigint;
  awaiting_decision: boolean;
  awaiting_user_decision: boolean;
  needs_admin_decision: boolean;
  needs_admin_attention: boolean;
  user_refund_allowed: boolean;
  refund_address_missing: boolean;
  overpayment_unrefunded: boolean;
  fits_stock: boolean | null;
  user_renounce_allowed: boolean;
  abandoned_at: Date | null;
  batch_open: boolean;
  batch_public: boolean;
  status_at_creation: BatchStatus | null;
  now: Date;
};

export type OrderBalance = PaymentBalance & {
  outstandingSats: bigint;
  needsAdminAttention: boolean;
  abandonedAt: Date | null;
  batchPublic: boolean;
  statusAtCreation: BatchStatus | null;
};

/**
 * Solde de paiement (vue order_payment_balance) et règles du lot, pour des factures. `lock` :
 * verrouille d'abord les factures (FOR NO KEY UPDATE, comme Payment_apply et Refund_partial_payment_allowed)
 * pour décider sur un solde que personne ne modifie avant le COMMIT.
 */
export async function loadBalances(db: Db, ids: string[], { lock = false } = {}): Promise<Map<string, OrderBalance>> {
  if (ids.length === 0) return new Map();
  if (lock) await db.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR NO KEY UPDATE`;
  const rows = await db.$queryRaw<BalanceRow[]>`
    SELECT pb."order_id", pb."status"::text AS "status", o."expires_at", o."total_amount",
      pb."expected_sats", pb."received_sats", pb."refunded_sats", pb."outstanding_sats", pb."refund_due_sats",
      pb."unsettled_sats", pb."awaiting_decision", pb."awaiting_user_decision", pb."needs_admin_decision",
      pb."needs_admin_attention", pb."user_refund_allowed", pb."refund_address_missing", pb."overpayment_unrefunded",
      pb."fits_stock", pb."user_renounce_allowed", pb."abandoned_at",
      coalesce("batch_accepts_orders"(b."status"), false) AS "batch_open",
      coalesce("batch_is_public"(b."status"), false) AS "batch_public",
      (SELECT t."to_status"::text FROM "BatchStatusTransition" t
        WHERE t."batch_id" = o."batch_id" AND t."created_at" <= o."created_at"
        ORDER BY t."created_at" DESC, t."id" DESC LIMIT 1) AS "status_at_creation",
      now() AS "now"
    FROM "order_payment_balance" pb
    JOIN "Order" o ON o."id" = pb."order_id"
    JOIN "Batch" b ON b."id" = o."batch_id"
    WHERE pb."order_id" = ANY(${ids}::uuid[])`;
  return new Map(
    rows.map((r) => [
      r.order_id,
      {
        status: r.status,
        expiresAt: r.expires_at,
        totalAmount: r.total_amount,
        expectedSats: r.expected_sats,
        receivedSats: r.received_sats,
        refundedSats: r.refunded_sats,
        outstandingSats: r.outstanding_sats,
        refundDueSats: r.refund_due_sats,
        unsettledSats: r.unsettled_sats,
        batchOpen: r.batch_open,
        awaitingDecision: r.awaiting_decision,
        awaitingUserDecision: r.awaiting_user_decision,
        needsAdminDecision: r.needs_admin_decision,
        needsAdminAttention: r.needs_admin_attention,
        userRefundAllowed: r.user_refund_allowed,
        refundAddressMissing: r.refund_address_missing,
        overpaymentUnrefunded: r.overpayment_unrefunded,
        fitsStock: r.fits_stock,
        userRenounceAllowed: r.user_renounce_allowed,
        abandonedAt: r.abandoned_at,
        batchPublic: r.batch_public,
        statusAtCreation: r.status_at_creation,
        now: r.now,
      },
    ]),
  );
}

export async function loadBalance(db: Db, orderId: string, options?: { lock?: boolean }): Promise<OrderBalance> {
  const balance = (await loadBalances(db, [orderId], options)).get(orderId);
  if (!balance) throw orderNotFound();
  return balance;
}

const REFUND_KIND_LABELS: Record<RefundKind, string> = {
  cancellation: "Annulation",
  discount: "Rabais",
  overpayment: "Excédent",
};

function addressDto(a: OrderRow["billing_address"]) {
  return {
    id: a.id,
    fullName: a.full_name,
    company: a.company,
    line1: a.line1,
    line2: a.line2,
    postalCode: a.postal_code,
    city: a.city,
    country: a.country,
    phone: a.phone,
  };
}

/** Facture au format JSON (utilisateur et backoffice). Montants : centimes et sats en chaînes. */
export function orderDto(o: OrderRow, b: OrderBalance) {
  const status = displayStatus(o.status, o.expires_at, b.now);
  const kind = orderKind(b.statusAtCreation);
  return {
    id: o.id,
    status,
    statusLabel: ORDER_STATUS_LABELS[status],
    /** Précommande, ou commande simple (lot en Tuning ou Packaging à la création) */
    kind,
    kindLabel: ORDER_KIND_LABELS[kind],
    createdAt: o.created_at.toISOString(),
    /** Fin de la réservation (30 min après la création) */
    expiresAt: o.expires_at.toISOString(),
    paidAt: o.paid_at?.toISOString() ?? null,
    cancelledAt: o.cancelled_at?.toISOString() ?? null,
    refundedAt: o.refunded_at?.toISOString() ?? null,
    batch: {
      id: o.batch.id,
      name: o.batch.name,
      status: o.batch.status,
      statusLabel: BATCH_STATUS_LABELS[o.batch.status],
      /** Fiche du lot visible par le public (lien « Voir le lot ») */
      isPublic: b.batchPublic,
      /** Le lot accepte encore des commandes (appoint possible) */
      acceptsOrders: b.batchOpen,
      model: o.batch.model,
    },
    /** Total facturé, centimes */
    totalAmount: bigintToJson(o.total_amount),
    payment: {
      method: o.payment_method,
      /** Adresse Bitcoin de cette facture : à payer en une ou plusieurs fois (appoint) */
      address: o.payment_address,
      expectedSats: bigintToJson(o.expected_sats),
      receivedSats: bigintToJson(o.received_sats),
      /** Appoint attendu (facture en attente ou expirée) */
      outstandingSats: bigintToJson(b.outstandingSats),
      /** Sats sortis du solde par les remboursements (frais à la charge de l'utilisateur compris) */
      refundedSats: bigintToJson(b.refundedSats),
      /**
       * Sats reçus que l'équipe doit encore traiter (« à traiter » côté admin) : excédent d'une facture
       * payée, paiement reçu après un remboursement intégral ou une annulation (lot annulé compris), ou sur
       * un lot qui n'accepte plus de commande. "0" : rien. Aucun remboursement automatique : l'équipe contacte l'utilisateur.
       */
      underReviewSats: bigintToJson(b.needsAdminDecision || b.overpaymentUnrefunded ? b.unsettledSats : 0n),
    },
    /** Adresse Bitcoin où rembourser (saisie par l'utilisateur ou l'admin) ; null : pas encore donnée */
    refundAddress: o.refund_address,
    /** Machines dans l'ordre de la requête de création (« Machine 1, 2… ») */
    lines: o.lines.map((l) => ({
      id: l.id,
      position: l.position,
      amount: bigintToJson(l.amount),
      basePrice: bigintToJson(l.configuration.base_price),
      wishlistId: l.wishlist_id,
      refunded: l.refund_id !== null,
      items: [...l.configuration.items]
        .sort((x, y) => x.option.position - y.option.position || x.option.title.localeCompare(y.option.title))
        .map((i) => ({
          optionId: i.option_id,
          optionTitle: i.option.title,
          optionValueId: i.option_value_id,
          label: i.option_value.label,
          isDefault: i.option_value.is_default,
          unitPrice: bigintToJson(i.unit_price),
        })),
    })),
    payments: o.payments.map((p) => ({
      id: p.id,
      amountSats: bigintToJson(p.amount_sats),
      txid: p.txid,
      vout: p.vout,
      receivedAt: p.received_at.toISOString(),
    })),
    refunds: o.refunds.map((r) => ({
      id: r.id,
      kind: r.kind,
      kindLabel: REFUND_KIND_LABELS[r.kind],
      /** Motif : il fixe qui paie les frais réseau */
      cause: r.cause,
      causeLabel: REFUND_CAUSE_LABELS[r.cause],
      /** Qui l'a décidé : l'utilisateur, l'admin ou le traitement automatique */
      initiatedBy: r.initiated_by,
      /** Centimes remboursés (0 pour un excédent) */
      amount: bigintToJson(r.amount),
      /** Sats versés à l'utilisateur */
      amountSats: bigintToJson(r.amount_sats),
      networkFeeSats: bigintToJson(r.network_fee_sats),
      networkFeePayer: r.network_fee_payer as RefundFeePayer,
      /** Adresse choisie pour ce remboursement (par l'admin), ou celle de l'envoi ; null : celle de la facture */
      destinationAddress: r.destination_address,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
      /** Envoyé (transaction `reference`) ; null tant que le remboursement n'est pas parti */
      sentAt: r.sent_at?.toISOString() ?? null,
      reference: r.reference,
    })),
    billingAddress: addressDto(o.billing_address),
    shippingAddress: addressDto(o.shipping_address),
    /**
     * Indications pour l'UI (elle n'empêche rien : l'API tranche) : annulation possible (en attente,
     * rien reçu, réservation vivante) ; remboursement du versement possible (paiement partiel, lot
     * ouvert) ; appoint attendu (un premier versement reçu, incomplet) ; renoncement possible (commande
     * payée, lot au plus en Précommande) ; adresse de remboursement modifiable (aucun remboursement envoyé).
     */
    actions: {
      canCancel: status === "pending_payment" && o.received_sats === 0n,
      canRequestRefund: b.userRefundAllowed,
      awaitingTopUp:
        (status === "pending_payment" || status === "expired") && o.received_sats > 0n && b.outstandingSats > 0n && b.batchOpen,
      canRenounce: b.userRenounceAllowed,
      canEditRefundAddress: o.refunds.every((r) => r.sent_at === null),
    },
    /** Facture expirée partiellement payée : l'utilisateur choisit l'appoint ou le remboursement */
    awaitingUserDecision: b.awaitingUserDecision,
  };
}

export type OrderDto = ReturnType<typeof orderDto>;

/** Factures avec leur solde, au format JSON, dans l'ordre de `rows`. */
export async function ordersDto(db: Db, rows: OrderRow[]) {
  const balances = await loadBalances(db, rows.map((r) => r.id));
  return rows.map((r) => orderDto(r, balances.get(r.id)!));
}

export function findOrders(db: Db, where: Prisma.OrderWhereInput) {
  return db.order.findMany({ where, include: orderInclude, orderBy: [{ created_at: "desc" }, { id: "asc" }] });
}

/** Factures de l'utilisateur (option : d'un lot), de la plus récente à la plus ancienne. */
export async function listOrders(userId: string, query: z.output<typeof orderListQuery>) {
  const db = getDb();
  const rows = await findOrders(db, { user_id: userId, ...(query.batchId ? { batch_id: query.batchId } : {}) });
  return { items: await ordersDto(db, rows) };
}

/** Une facture de l'utilisateur ; 404 si elle est inconnue ou à un autre utilisateur. */
export async function getOrder(userId: string, orderId: string) {
  const db = getDb();
  const [row] = await findOrders(db, { id: orderId, user_id: userId });
  if (!row) throw orderNotFound();
  return (await ordersDto(db, [row]))[0];
}

/** Adresses enregistrées de l'utilisateur (non archivées), de la plus récente à la plus ancienne. */
export async function listAddresses(userId: string) {
  const rows = await getDb().address.findMany({
    where: { user_id: userId, archived_at: null },
    orderBy: [{ created_at: "desc" }, { id: "asc" }],
  });
  return { items: rows.map(addressDto) };
}

// ─── Contexte de commande d'un lot pour l'utilisateur ───

type ContextRow = {
  status: BatchStatus;
  accepts: boolean;
  priority_ends_at: Date | null;
  machines_left: number | null;
  live_order_id: string | null;
  blocked_at: Date | null;
  cooldown_ends_at: Date | null;
  available: number;
  max_lines: number;
  now: Date;
};

/** Contexte de commande (fonctions SQL de la base, source unique des règles) ; null si le lot n'existe pas. */
export async function loadOrderingContext(db: Db, batchId: string, userId: string): Promise<OrderingContext | null> {
  const [r] = await db.$queryRaw<ContextRow[]>`
    SELECT b."status"::text AS "status",
      coalesce("batch_accepts_orders"(b."status"), false) AS "accepts",
      "batch_priority_ends_at"(b."id") AS "priority_ends_at",
      "order_priority_machines_left"(b."id", ${userId}::uuid) AS "machines_left",
      (SELECT o."id" FROM "Order" o
        WHERE o."user_id" = ${userId}::uuid AND o."batch_id" = b."id"
          AND o."status" = 'pending_payment' AND o."expires_at" > now()
        ORDER BY o."created_at" DESC LIMIT 1) AS "live_order_id",
      "user_batch_blocked_at"(b."id", ${userId}::uuid) AS "blocked_at",
      "user_batch_cooldown_ends_at"(b."id", ${userId}::uuid) AS "cooldown_ends_at",
      "batch_available_stock"(b."id") AS "available",
      (SELECT "order_max_lines" FROM "shop_settings"()) AS "max_lines",
      now() AS "now"
    FROM "Batch" b WHERE b."id" = ${batchId}::uuid`;
  if (!r) return null;
  return {
    batchStatus: r.status,
    acceptsOrders: r.accepts,
    priorityEndsAt: r.priority_ends_at,
    machinesLeft: r.machines_left,
    liveOrderId: r.live_order_id,
    blockedAt: r.blocked_at,
    cooldownEndsAt: r.cooldown_ends_at,
    available: r.available,
    maxLines: r.max_lines,
    now: r.now,
  };
}

/**
 * Ce que l'utilisateur peut faire sur un lot maintenant (pour afficher les messages avant l'envoi :
 * priorité, délai, blocage, facture en cours, stock). L'UI n'empêche rien : `POST /api/orders` tranche.
 */
export async function getOrderingStatus(userId: string, batchId: string) {
  const db = getDb();
  const ctx = await loadOrderingContext(db, batchId, userId);
  if (!ctx || ctx.batchStatus === "draft") throw batchNotFound();
  const wishlists = await db.wishlist.findMany({
    where: {
      user_id: userId,
      batch_id: batchId,
      cancelled_at: null,
      order_lines: { none: { refund_id: null, order: { status: "paid" } } },
    },
    select: { id: true },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });
  const refusal = checkOrderCreation(ctx, 1);
  return {
    batchId,
    batchStatus: ctx.batchStatus,
    acceptsOrders: ctx.acceptsOrders,
    /** Fin de la journée de priorité (null : pas de priorité sur ce lot) */
    priorityEndsAt: ctx.priorityEndsAt?.toISOString() ?? null,
    /** Machines encore permises en priorité ; null hors journée de priorité */
    priorityMachinesLeft: ctx.machinesLeft,
    /** Facture en attente encore vivante sur ce lot */
    pendingOrderId: ctx.liveOrderId,
    blockedAt: ctx.blockedAt?.toISOString() ?? null,
    cooldownEndsAt: ctx.cooldownEndsAt?.toISOString() ?? null,
    availableQuantity: Math.max(0, ctx.available),
    maxMachinesPerOrder: ctx.maxLines,
    /** Manifestations d'intérêt actives non converties, à reprendre dans une facture (`lines[].wishlistId`) */
    wishlistIds: wishlists.map((w) => w.id),
    /** Refus qu'aurait une facture d'une machine maintenant (null : rien ne s'y oppose a priori) */
    refusal: refusal ? { code: refusal.code, message: refusal.message, details: refusal.extra.details ?? null } : null,
  };
}

// ─── Création ───

/** Contraintes de création dont le refus mérite d'être réexpliqué avec les dates et les nombres du domaine. */
const EXPLAINED_BY_DOMAIN = new Set([
  "Order_batch_open",
  "Order_priority_window",
  "OrderLine_priority_quota",
  "Order_one_live_per_user_batch",
  "Order_abandoned_limit",
  "Order_abandoned_cooldown",
  "Order_max_lines",
  "Batch_stock",
]);

/** Adresse de l'utilisateur : la sienne (non archivée), ou une nouvelle (une adresse identique existante est reprise). */
async function resolveAddress(tx: Tx, userId: string, input: z.output<typeof addressInput>): Promise<string> {
  if ("addressId" in input) {
    const found = await tx.address.findFirst({ where: { id: input.addressId, user_id: userId, archived_at: null }, select: { id: true } });
    if (!found) throw new ApiError(422, "unknown_address", "Adresse introuvable : saisissez-la de nouveau.");
    return found.id;
  }
  const data = {
    full_name: input.fullName,
    company: input.company ?? null,
    line1: input.line1,
    line2: input.line2 ?? null,
    postal_code: input.postalCode,
    city: input.city,
    country: input.country,
    phone: input.phone ?? null,
  };
  const same = await tx.address.findFirst({ where: { user_id: userId, archived_at: null, ...data }, select: { id: true } });
  if (same) return same.id;
  return (await tx.address.create({ data: { user_id: userId, ...data }, select: { id: true } })).id;
}

/** Choix des manifestations d'intérêt reprises (à l'utilisateur, sur ce lot, actives, non converties). */
async function wishlistChoices(tx: Tx, userId: string, batchId: string, ids: string[]): Promise<Map<string, Choice[]>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.wishlist.findMany({
    where: { id: { in: ids }, user_id: userId, cancelled_at: null },
    select: {
      id: true,
      batch_id: true,
      configuration: { select: { items: { select: { option_id: true, option_value_id: true } } } },
      order_lines: { where: { refund_id: null, order: { status: "paid" } }, select: { id: true }, take: 1 },
    },
  });
  if (rows.length !== ids.length) {
    throw new ApiError(404, "wishlist_not_found", "Une des manifestations d'intérêt indiquées est introuvable ou a été retirée.");
  }
  if (rows.some((w) => w.batch_id !== batchId)) {
    throw new ApiError(422, "wishlist_other_batch", "Une des manifestations d'intérêt indiquées concerne un autre lot.");
  }
  if (rows.some((w) => w.order_lines.length > 0)) {
    throw new ApiError(409, "wishlist_converted", "Une des manifestations d'intérêt indiquées est déjà devenue une commande payée.");
  }
  return new Map(
    rows.map((w) => [w.id, w.configuration.items.map((i) => ({ optionId: i.option_id, optionValueId: i.option_value_id }))]),
  );
}

/**
 * Crée une facture et toutes ses lignes dans une seule transaction (ensuite tout est figé) :
 * - verrou de l'utilisateur d'abord (FOR NO KEY UPDATE, comme Order_guard) : ses créations simultanées
 *   se suivent, et les contrôles du domaine (priorité, facture vivante, délai, blocage) lisent un état
 *   que lui seul pourrait changer ;
 * - une configuration complète par ligne, prix relus en base (writeConfiguration) ; une ligne issue
 *   d'une manifestation d'intérêt reprend ses choix et la référence (`wishlist_id`, ce qui termine la
 *   journée de priorité dès que toutes sont converties) ;
 * - montant attendu en sats et adresse de paiement unique fournis par le service de paiement ;
 * - stock, plafond d'options et cohérence vérifiés par la base au COMMIT (Batch_stock, Order_check).
 */
export async function createOrder(userId: string, input: z.output<typeof orderInput>) {
  const orderId = randomUUID();
  const payments = getPaymentService();
  try {
    await getDb().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId}::uuid FOR NO KEY UPDATE`;
      const ctx = await loadOrderingContext(tx, input.batchId, userId);
      if (!ctx || ctx.batchStatus === "draft") throw batchNotFound();
      const refused = checkOrderCreation(ctx, input.lines.length);
      if (refused) throw refused;

      const wished = await wishlistChoices(
        tx,
        userId,
        input.batchId,
        input.lines.flatMap((l) => (l.wishlistId ? [l.wishlistId] : [])),
      );
      const billingId = await resolveAddress(tx, userId, input.billingAddress);
      const shippingId = input.shippingAddress ? await resolveAddress(tx, userId, input.shippingAddress) : billingId;

      const lines: { configurationId: string; amount: bigint; wishlistId: string | null }[] = [];
      for (const line of input.lines) {
        const lineChoices = line.wishlistId ? wished.get(line.wishlistId)! : (line.choices ?? []);
        const configuration = await writeConfiguration(tx, input.batchId, lineChoices);
        lines.push({ configurationId: configuration.id, amount: configuration.amount, wishlistId: line.wishlistId ?? null });
      }
      const totalAmount = lines.reduce((sum, l) => sum + l.amount, 0n);
      const invoice = await payments.requestInvoice({ orderId, amountCents: totalAmount });

      // Adresse de remboursement saisie : journalisée par la base avec l'acteur déclaré (Order_refund_address_log)
      if (input.refundAddress) await declareUserActor(tx, userId);
      await tx.order.create({
        data: {
          id: orderId,
          user_id: userId,
          batch_id: input.batchId,
          billing_address_id: billingId,
          shipping_address_id: shippingId,
          total_amount: totalAmount,
          expected_sats: invoice.expectedSats,
          payment_address: invoice.address,
          refund_address: input.refundAddress ?? null,
        },
      });
      await tx.orderLine.createMany({
        data: lines.map((l) => ({
          order_id: orderId,
          user_id: userId,
          batch_id: input.batchId,
          configuration_id: l.configurationId,
          wishlist_id: l.wishlistId,
          amount: l.amount,
        })),
      });
    });
  } catch (error) {
    // La base a refusé (course avec une autre transaction) : même refus, expliqué avec l'état validé
    const constraint = pgFailureOf(error)?.constraint;
    if (constraint && EXPLAINED_BY_DOMAIN.has(constraint)) {
      const ctx = await loadOrderingContext(getDb(), input.batchId, userId);
      const refused = ctx && checkOrderCreation(ctx, input.lines.length);
      if (refused) throw refused;
    }
    throw error;
  }
  return getOrder(userId, orderId);
}

// ─── Annulation et remboursement par l'utilisateur ───

/** Verrouille une facture de l'utilisateur (404 si elle est à un autre) et lit son solde. */
async function lockOwnOrder(tx: Tx, userId: string, orderId: string) {
  const [own] = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid AND "user_id" = ${userId}::uuid FOR NO KEY UPDATE`;
  if (!own) throw orderNotFound();
  return loadBalance(tx, orderId);
}

/**
 * Annule une facture en attente impayée : la réservation est libérée tout de suite. Rien reçu et
 * réservation vivante (sinon refus, aussi imposé par la base : Order_cancel_unpaid, Order_cancel_expired).
 * L'annulation compte comme un abandon (délai, plafond). Rejouée sur une facture déjà annulée : sans effet.
 */
export async function cancelOrder(userId: string, orderId: string) {
  await getDb().$transaction(async (tx) => {
    const b = await lockOwnOrder(tx, userId, orderId);
    if (b.status === "cancelled") return;
    const status = displayStatus(b.status, b.expiresAt, b.now);
    if (b.receivedSats > 0n && (status === "pending_payment" || status === "expired")) {
      throw new ApiError(
        409,
        "order_cancel_paid",
        "Un paiement a été reçu sur cette facture : elle ne peut plus être annulée. Demandez plutôt le remboursement de votre versement, ou complétez le paiement.",
      );
    }
    if (status === "expired") {
      throw new ApiError(409, "order_cancel_expired", "Cette facture a déjà expiré : la réservation est terminée, il n'y a plus rien à annuler.");
    }
    if (status !== "pending_payment") {
      throw new ApiError(
        409,
        "order_not_cancellable",
        `Cette facture est ${ORDER_STATUS_LABELS[status].toLowerCase()} : seule une facture en attente de paiement peut être annulée.`,
      );
    }
    // cancelled_at est posé par la base (horloge de la base)
    await tx.order.update({ where: { id: orderId }, data: { status: "cancelled" } });
  });
  return getOrder(userId, orderId);
}

/** Qui paie les frais réseau d'un motif de remboursement (refund_cause_fee_payer : source unique, en base). */
export async function refundFeePayer(tx: Tx, cause: RefundCause): Promise<RefundFeePayer> {
  const [{ payer }] = await tx.$queryRaw<{ payer: RefundFeePayer }[]>`
    SELECT "refund_cause_fee_payer"(${cause}::"refund_cause")::text AS "payer"`;
  return payer;
}

export type RefundWrite = {
  kind: RefundKind;
  /** Motif : fixe qui paie les frais réseau (refund_cause_fee_payer) */
  cause: RefundCause;
  /** Centimes (0 pour un excédent) */
  amount: bigint;
  /** Sats sortis du solde (brut) ; l'utilisateur reçoit brut − frais quand les frais sont à sa charge */
  grossSats: bigint;
  networkFeeSats: bigint;
  /** Qui décide (Refund.initiated_by) ; admin : `createdBy` obligatoire (Refund_admin_traced_check) */
  initiatedBy: RefundInitiator;
  createdBy?: bigint | null;
  reason: string;
  destinationAddress?: string | null;
};

/**
 * Écrit un remboursement : payeur des frais lu en base selon le motif, montant versé = brut (− frais
 * s'ils sont à l'utilisateur). Frais à la charge de l'utilisateur qui absorbent tout le brut :
 * `409 refund_below_network_fee` (la base refuse aussi : Refund_user_net_positive).
 */
export async function writeRefund(tx: Tx, orderId: string, refund: RefundWrite) {
  const payer = await refundFeePayer(tx, refund.cause);
  if (payer === "user" && refund.grossSats <= refund.networkFeeSats) {
    throw new ApiError(
      409,
      "refund_below_network_fee",
      `Le montant à rembourser (${refund.grossSats} sats) ne couvre pas les frais réseau (${refund.networkFeeSats} sats), à la charge de l'utilisateur pour ce motif.`,
      undefined,
      { details: { refundSats: refund.grossSats.toString(), networkFeeSats: refund.networkFeeSats.toString() } },
    );
  }
  const created = await tx.refund.create({
    data: {
      order_id: orderId,
      kind: refund.kind,
      cause: refund.cause,
      amount: refund.amount,
      amount_sats: payer === "user" ? refund.grossSats - refund.networkFeeSats : refund.grossSats,
      network_fee_sats: refund.networkFeeSats,
      network_fee_payer: payer,
      initiated_by: refund.initiatedBy,
      created_by_auth_user_id: refund.createdBy ?? null,
      reason: refund.reason,
      destination_address: refund.destinationAddress ?? null,
    },
    select: { id: true },
  });
  return created.id;
}

/** Écrit un remboursement qui annule toutes les lignes encore actives et passe la facture à remboursée. */
export async function writeWholeCancellation(tx: Tx, orderId: string, refund: Omit<RefundWrite, "kind">) {
  const id = await writeRefund(tx, orderId, { ...refund, kind: "cancellation" });
  await tx.orderLine.updateMany({ where: { order_id: orderId, refund_id: null }, data: { refund_id: id } });
  // refunded_at est posé par la base
  await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
  return id;
}

/**
 * Annule des machines d'une commande payée (utilisateur qui renonce, ou admin) : sats bruts au prorata
 * de ce qui a été payé (refund_prorata_sats, arrondi au sat le plus proche sur le cumul), frais réseau
 * selon le motif. Toutes les machines annulées : la commande passe à remboursée, avec le reliquat
 * d'excédent encore non remboursé (même motif, sans frais : l'annulation les porte). Appelée sous verrou
 * de la facture (loadBalance { lock }).
 */
export async function cancelOrderLines(
  tx: Tx,
  orderId: string,
  b: OrderBalance,
  lineIds: readonly string[] | undefined,
  refund: Omit<RefundWrite, "kind" | "amount" | "grossSats">,
) {
  const active = await tx.orderLine.findMany({ where: { order_id: orderId, refund_id: null }, select: { id: true, amount: true } });
  const plan = planLineCancellation(active, lineIds);
  if (plan instanceof ApiError) throw plan;
  const [{ sats }] = await tx.$queryRaw<{ sats: bigint }[]>`
    SELECT "refund_prorata_sats"(${orderId}::uuid, ${plan.amount}) AS "sats"`;
  const refundId = await writeRefund(tx, orderId, { ...refund, kind: "cancellation", amount: plan.amount, grossSats: sats });
  await tx.orderLine.updateMany({ where: { id: { in: plan.lineIds }, order_id: orderId }, data: { refund_id: refundId } });
  if (!plan.whole) return;
  const left = b.receivedSats - b.refundedSats - sats;
  if (left > 0n) {
    // Reliquat d'excédent : même envoi que l'annulation, qui porte les frais (une seule ligne)
    await writeRefund(tx, orderId, {
      ...refund,
      kind: "overpayment",
      amount: 0n,
      grossSats: left,
      networkFeeSats: 0n,
      reason: `${refund.reason} (excédent de paiement)`,
    });
  }
  // refunded_at est posé par la base
  await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
}

/**
 * Renoncement de l'utilisateur à une commande payée (des machines ou toute la facture), tant que le
 * lot est au plus en Précommande : remboursement au prorata, frais réseau à sa charge (motif
 * user_renounce). Sérialisé avec les transitions du lot par la base (Refund_user_renounce_window, sous
 * verrou du lot) : un passage à Commande en cours validé avant fait échouer le renoncement. Ce n'est pas
 * un abandon (ni délai ni plafond).
 */
export async function renounceOrder(userId: string, orderId: string, input: z.output<typeof renounceInput>) {
  const fee = await getPaymentService().estimateRefundNetworkFeeSats();
  await getDb().$transaction(async (tx) => {
    const b = await lockOwnOrder(tx, userId, orderId);
    const refused = checkUserRenounce(b);
    if (refused) throw refused;
    await cancelOrderLines(tx, orderId, b, input.lineIds, {
      cause: "user_renounce",
      networkFeeSats: fee,
      initiatedBy: "user",
      reason: "Renoncement de l'utilisateur",
    });
  });
  return getOrder(userId, orderId);
}

// ─── Adresse de remboursement ───

/**
 * Déclare l'auteur de la transaction (declare_actor) : obligatoire avant toute écriture de
 * Order.refund_address, que la base journalise (OrderRefundAddressChange). Portée : la transaction.
 */
export async function declareActor(tx: Tx, kind: ActorKind, authUserId: bigint) {
  await tx.$queryRaw`SELECT "declare_actor"(${kind}::"actor_kind", ${authUserId}::bigint)`;
}

/** Déclare l'utilisateur de la boutique `userId` (son identifiant auth-service, lu en base). */
async function declareUserActor(tx: Tx, userId: string) {
  const { auth_user_id } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { auth_user_id: true } });
  await declareActor(tx, "user", auth_user_id);
}

/**
 * Écrit l'adresse de remboursement d'une facture (ou l'efface), avec son auteur. Refusée par la base dès
 * qu'un remboursement de la facture est envoyé (`409 refund_address_frozen`, sous verrou de la facture,
 * comme l'envoi), ou si c'est une adresse de paiement de la boutique (`422 refund_address_ours`).
 */
export async function writeOrderRefundAddress(
  tx: Tx,
  orderId: string,
  address: string | null,
  actor: { kind: "user"; userId: string } | { kind: "admin"; authUserId: bigint },
) {
  if (actor.kind === "user") await declareUserActor(tx, actor.userId);
  else await declareActor(tx, "admin", actor.authUserId);
  await tx.order.update({ where: { id: orderId }, data: { refund_address: address } });
}

/** L'utilisateur donne, change ou efface l'adresse de remboursement d'une de ses factures. */
export async function setOwnRefundAddress(userId: string, orderId: string, input: z.output<typeof refundAddressInput>) {
  await getDb().$transaction(async (tx) => {
    await lockOwnOrder(tx, userId, orderId);
    await writeOrderRefundAddress(tx, orderId, input.refundAddress, { kind: "user", userId });
  });
  return getOrder(userId, orderId);
}

/**
 * Remboursement d'un paiement partiel demandé par l'utilisateur, avant comme après l'expiration,
 * frais réseau à sa charge (estimés par le service de paiement). Une transaction : adresse écrite sur
 * la facture si elle est fournie, remboursement de toutes les lignes (sans adresse propre : celle de
 * la facture s'applique), facture remboursée. C'est un abandon (délai, plafond). Le lot doit accepter
 * encore les commandes (sinon c'est la boutique qui rembourse, frais à sa charge).
 */
export async function requestUserRefund(userId: string, orderId: string, input: z.output<typeof userRefundInput>) {
  const fee = await getPaymentService().estimateRefundNetworkFeeSats();
  await getDb().$transaction(async (tx) => {
    const b = await lockOwnOrder(tx, userId, orderId);
    const plan = planUserRefund(b, fee);
    if (plan instanceof ApiError) throw plan;
    if (input.refundAddress) await writeOrderRefundAddress(tx, orderId, input.refundAddress, { kind: "user", userId });
    await writeWholeCancellation(tx, orderId, {
      cause: "partial_payment",
      amount: b.totalAmount,
      grossSats: plan.amountSats + plan.networkFeeSats,
      networkFeeSats: plan.networkFeeSats,
      initiatedBy: "user",
      reason: "Remboursement du versement demandé par l'utilisateur (frais réseau à sa charge)",
    });
  });
  return getOrder(userId, orderId);
}
