import { z } from "zod";
import type { BatchStatus, OrderStatus, Prisma, RefundCause, RefundFeePayer, RefundInitiator, RefundKind } from "../../prisma/generated/client";
import { authUserIdToDb } from "./auth";
import { BATCH_STATUS_LABELS } from "./batch-status";
import { type Actor, batchNotFound } from "./batches";
import { getDb } from "./db";
import { ApiError } from "./errors";
import { bigintToJson, optionalText } from "./http";
import {
  ADMIN_CANCELLATION_CAUSES,
  type Attention,
  attentionOf,
  checkRefundCause,
  displayStatus,
  ORDER_STATUS_LABELS,
  planAdminRefund,
  REFUND_CAUSE_LABELS,
} from "./order-rules";
import {
  bitcoinAddress,
  cancelOrderLines,
  findOrders,
  loadBalance,
  loadBalances,
  orderDto,
  orderNotFound,
  refundAddressInput,
  writeOrderRefundAddress,
  writeRefund,
  writeWholeCancellation,
} from "./orders";
import { settleOrder } from "./payments";
import { getPaymentService } from "./payment-service";

/**
 * Factures côté backoffice (whitelist) : liste « à traiter », commandes d'un lot, détail d'une
 * facture (adresses et journal des adresses de remboursement compris), décisions de l'admin (accepter,
 * rembourser avec un motif choisi parmi ceux permis, annuler des machines d'une commande payée, changer
 * l'adresse de remboursement), envoi des remboursements, blocages après abandons et levée. Qui paie les
 * frais réseau découle toujours du motif (refund_cause_fee_payer, en base), jamais d'un choix libre.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | ReturnType<typeof getDb>;

// ─── Entrées ───

/** Explication libre de la décision (historique de la facture), à ne pas confondre avec le motif (`cause`). */
const reason = z
  .string({ error: "Explication obligatoire" })
  .trim()
  .min(1, { error: "Explication obligatoire" })
  .max(500, { error: "500 caractères au plus" });

const CAUSE_CHOICE_ERROR = "Choisissez l'un des motifs proposés";

const refundCause = z.enum(
  [
    "shop_stock",
    "shop_defective_machine",
    "user_renounce",
    "partial_payment",
    "late_payment_no_room",
    "overpayment",
    "discount",
    "admin_other",
  ] as const satisfies readonly RefundCause[],
  { error: CAUSE_CHOICE_ERROR },
);

export const adminRefundInput = z.strictObject({
  reason,
  /** Motif choisi par l'admin parmi `attention.refundCauses` (il fixe qui paie les frais réseau) */
  cause: refundCause,
  /** Adresse où envoyer CE remboursement, si l'admin en choisit une autre que celle de la facture */
  destinationAddress: bitcoinAddress.nullable().optional(),
});

/** Motifs d'une annulation de machines par l'admin (le payeur des frais en découle) ; absent : admin_other */
const adminCancellationCause = z.enum(ADMIN_CANCELLATION_CAUSES, { error: CAUSE_CHOICE_ERROR });

export const cancelLinesInput = z.strictObject({
  /** Machines à annuler ; absent : toutes les machines encore actives */
  lineIds: z
    .array(z.uuid())
    .min(1, { error: "Cochez au moins une machine" })
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, { error: "Une machine est listée deux fois" })
    .optional(),
  reason,
  /**
   * Motif : souci de stock (surplus, lot abandonné), machine défectueuse, demande de l'utilisateur
   * (`user_renounce`, à toute étape, frais à sa charge), ou autre (défaut)
   */
  cause: adminCancellationCause.optional(),
  destinationAddress: bitcoinAddress.nullable().optional(),
});

export const sendRefundInput = z.strictObject({
  /** Référence de l'envoi (txid de la transaction de remboursement) */
  reference: z.string().trim().min(1, { error: "Référence de la transaction obligatoire" }).max(200, { error: "200 caractères au plus" }),
  /** Adresse vue par l'admin (`refunds-to-send.destinationAddress`), recopiée telle quelle par lui : jamais par le serveur */
  destinationAddress: bitcoinAddress,
});

export const blockReleaseInput = z.strictObject({
  userId: z.uuid(),
  batchId: z.uuid(),
  reason: optionalText(500).optional(),
});

// ─── Lecture ───

/** Motif proposé à l'admin : libellé, et qui paie les frais réseau (refund_cause_fee_payer, lu en base). */
export type RefundCauseOption = { cause: RefundCause; label: string; networkFeePayer: RefundFeePayer };

async function causeOptions(db: Db, causes: readonly RefundCause[]): Promise<RefundCauseOption[]> {
  if (causes.length === 0) return [];
  const rows = await db.$queryRaw<{ cause: RefundCause; payer: RefundFeePayer }[]>`
    SELECT c::text AS "cause", "refund_cause_fee_payer"(c)::text AS "payer"
    FROM unnest(${causes as RefundCause[]}::"refund_cause"[]) AS c`;
  const payers = new Map(rows.map((r) => [r.cause, r.payer]));
  return causes.map((cause) => ({ cause, label: REFUND_CAUSE_LABELS[cause], networkFeePayer: payers.get(cause)! }));
}

/**
 * « À traiter » au format JSON : motifs de remboursement permis avec leur libellé et le payeur des frais.
 * Un motif dont les frais sont à la charge de l'utilisateur n'est pas proposé quand la somme à rembourser
 * (`unsettledSats`) ne les couvre pas : le serveur le refuserait (`refund_below_network_fee`).
 */
async function attentionDto(db: Db, attention: Attention | null, unsettledSats: bigint, feeSats: bigint) {
  if (!attention) return null;
  const options = (await causeOptions(db, attention.refundCauses)).filter(
    (o) => o.networkFeePayer === "shop" || unsettledSats > feeSats,
  );
  return { ...attention, canRefund: options.length > 0, refundCauses: options };
}

/**
 * Facture vue du backoffice : celle de l'utilisateur, plus l'utilisateur, les drapeaux « à traiter »
 * (motifs de remboursement permis), les motifs d'annulation de machines, les auteurs des remboursements
 * et le journal des adresses de remboursement (lecture seule).
 */
async function adminOrdersDto(rows: Awaited<ReturnType<typeof findOrders>>) {
  const db = getDb();
  const ids = rows.map((r) => r.id);
  const [balances, changes, cancelCauses, fee] = await Promise.all([
    loadBalances(db, ids),
    db.orderRefundAddressChange.findMany({ where: { order_id: { in: ids } }, orderBy: [{ created_at: "asc" }, { id: "asc" }] }),
    causeOptions(db, ADMIN_CANCELLATION_CAUSES),
    getPaymentService().estimateRefundNetworkFeeSats(),
  ]);
  return Promise.all(
    rows.map(async (r) => {
      const b = balances.get(r.id)!;
      const dto = orderDto(r, b);
      return {
        ...dto,
        refunds: dto.refunds.map((refund, i) => ({
          ...refund,
          /** Admin qui l'a décidé (auth-service), null sinon */
          createdBy: r.refunds[i].created_by_auth_user_id?.toString() ?? null,
          /** Admin qui a enregistré l'envoi ; null : pas envoyé, ou envoyé par le service de paiement */
          sentBy: r.refunds[i].sent_by_auth_user_id?.toString() ?? null,
        })),
        user: { id: r.user_id, authUserId: r.user.auth_user_id.toString() },
        unsettledSats: bigintToJson(b.unsettledSats),
        refundDueSats: bigintToJson(b.refundDueSats),
        abandonedAt: b.abandonedAt?.toISOString() ?? null,
        attention: await attentionDto(db, attentionOf(b), b.unsettledSats, fee),
        /** Motifs de « cancel-lines » (commande payée avec des machines actives), sinon vide */
        cancelLineCauses: r.status === "paid" ? cancelCauses : [],
        /** Journal des changements d'adresse de remboursement (append-only), du plus ancien au plus récent */
        refundAddressChanges: changes
          .filter((c) => c.order_id === r.id)
          .map((c) => ({
            id: c.id,
            oldAddress: c.old_address,
            newAddress: c.new_address,
            actor: c.actor,
            actorAuthUserId: c.actor_auth_user_id.toString(),
            createdAt: c.created_at.toISOString(),
          })),
      };
    }),
  );
}

/** Une facture (adresses, paiements, remboursements). */
export async function getAdminOrder(orderId: string) {
  const [row] = await findOrders(getDb(), { id: orderId });
  if (!row) throw orderNotFound();
  return (await adminOrdersDto([row]))[0];
}

/** Factures d'un lot, de la plus récente à la plus ancienne. */
export async function listBatchOrders(batchId: string) {
  const db = getDb();
  if (!(await db.batch.findUnique({ where: { id: batchId }, select: { id: true } }))) throw batchNotFound();
  return { items: await adminOrdersDto(await findOrders(db, { batch_id: batchId })) };
}

type AttentionRow = {
  order_id: string;
  batch_id: string;
  batch_name: string;
  batch_status: BatchStatus;
  user_id: string;
  auth_user_id: bigint;
  status: OrderStatus;
  created_at: Date;
  expires_at: Date;
  total_amount: bigint;
  lines: number;
};

/**
 * « À traiter » (vue order_payment_balance, needs_admin_attention) : décisions de l'admin, factures
 * expirées partiellement payées dont l'utilisateur doit choisir (l'admin le contacte), paiements complets
 * restés sans traitement automatique, excédents non remboursés, remboursements sans adresse. Les plus
 * anciennes d'abord.
 */
export async function listAttentionOrders() {
  const db = getDb();
  const rows = await db.$queryRaw<AttentionRow[]>`
    SELECT pb."order_id", o."batch_id", b."name" AS "batch_name", b."status"::text AS "batch_status",
      o."user_id", u."auth_user_id", o."status"::text AS "status", o."created_at", o."expires_at", o."total_amount",
      (SELECT count(*) FROM "OrderLine" l WHERE l."order_id" = o."id")::int AS "lines"
    FROM "order_payment_balance" pb
    JOIN "Order" o ON o."id" = pb."order_id"
    JOIN "Batch" b ON b."id" = o."batch_id"
    JOIN "User" u ON u."id" = o."user_id"
    WHERE pb."needs_admin_attention"
    ORDER BY o."created_at", o."id"`;
  const [balances, fee] = await Promise.all([
    loadBalances(db, rows.map((r) => r.order_id)),
    getPaymentService().estimateRefundNetworkFeeSats(),
  ]);
  return {
    items: await Promise.all(rows.map(async (r) => {
      const b = balances.get(r.order_id)!;
      const status = displayStatus(r.status, r.expires_at, b.now);
      return {
        orderId: r.order_id,
        batch: { id: r.batch_id, name: r.batch_name, status: r.batch_status, statusLabel: BATCH_STATUS_LABELS[r.batch_status] },
        user: { id: r.user_id, authUserId: r.auth_user_id.toString() },
        status,
        statusLabel: ORDER_STATUS_LABELS[status],
        createdAt: r.created_at.toISOString(),
        machines: r.lines,
        totalAmount: bigintToJson(r.total_amount),
        expectedSats: bigintToJson(b.expectedSats),
        receivedSats: bigintToJson(b.receivedSats),
        refundedSats: bigintToJson(b.refundedSats),
        unsettledSats: bigintToJson(b.unsettledSats),
        outstandingSats: bigintToJson(b.outstandingSats),
        attention: (await attentionDto(db, attentionOf(b), b.unsettledSats, fee))!,
      };
    })),
  };
}

// ─── Décisions de l'admin ───

/**
 * Accepter une facture « à traiter » :
 * - annulée puis payée intégralement (needs_admin_decision) : payée s'il reste de la place
 *   (Order_fits_stock, sous verrou du lot), sinon `409 out_of_stock` (la rembourser) ;
 * - paiement complet resté sans traitement (awaiting_decision) : traitement automatique
 *   (payée s'il reste de la place, sinon remboursée après la fin de la réservation) ; réservation
 *   encore vivante qui ne tient plus dans le stock : `409 out_of_stock` (rien n'est fait).
 * Un excédent éventuel reste « à traiter » (aucun remboursement d'excédent automatique).
 */
export async function acceptOrder(orderId: string) {
  await getDb().$transaction(async (tx) => {
    const b = await loadBalance(tx, orderId, { lock: true });
    const attention = attentionOf(b);
    if (!attention?.canAccept) {
      throw new ApiError(
        409,
        "order_not_acceptable",
        b.status === "paid"
          ? "Cette facture est déjà payée."
          : "Cette facture ne peut pas être acceptée : seul un paiement complet reçu (après une annulation, ou resté sans traitement) sur un lot qui accepte les commandes peut l'être.",
      );
    }
    if (b.status === "cancelled") {
      const [{ fits }] = await tx.$queryRaw<{ fits: boolean }[]>`SELECT "Order_fits_stock"(${orderId}::uuid) AS "fits"`;
      if (!fits) {
        throw new ApiError(409, "out_of_stock", "Il ne reste plus de place sur le lot pour cette commande : remboursez-la.");
      }
      await tx.$executeRaw`
        UPDATE "Order" SET "status" = 'paid', "paid_at" = now(), "updated_at" = now() WHERE "id" = ${orderId}::uuid`;
    }
    const actions = await settleOrder(tx, orderId);
    if (b.status !== "cancelled" && !actions.includes("accepted") && !actions.includes("refunded_no_stock")) {
      throw new ApiError(
        409,
        "out_of_stock",
        "Cette commande ne tient plus dans le stock du lot : elle pourra être remboursée à la fin de sa réservation.",
        undefined,
        { details: { expiresAt: b.expiresAt.toISOString() } },
      );
    }
  });
  return getAdminOrder(orderId);
}

/**
 * Rembourser une facture « à traiter » : tout ce qui a été reçu et n'est pas affecté, avec le motif
 * choisi par l'admin parmi ceux permis pour le cas (planAdminRefund) ; le payeur des frais découle du
 * motif. Facture annulée, impayée d'un lot fermé, ou expirée partiellement payée sans réponse de
 * l'utilisateur : annulation de toutes les lignes, facture remboursée. Facture payée ou déjà
 * remboursée : remboursement de l'excédent.
 */
export async function refundAttentionOrder(orderId: string, input: z.output<typeof adminRefundInput>, actor: Actor) {
  const createdBy = authUserIdToDb(actor.authUserId);
  const fee = await getPaymentService().estimateRefundNetworkFeeSats();
  await getDb().$transaction(async (tx) => {
    const b = await loadBalance(tx, orderId, { lock: true });
    const plan = planAdminRefund(b);
    if (plan instanceof ApiError) throw plan;
    const refused = checkRefundCause(plan.causes, input.cause);
    if (refused) throw refused;
    const refund = {
      cause: input.cause,
      grossSats: plan.amountSats,
      networkFeeSats: fee,
      initiatedBy: "admin" as const,
      createdBy,
      reason: input.reason,
      destinationAddress: input.destinationAddress,
    };
    if (plan.kind === "overpayment") await writeRefund(tx, orderId, { ...refund, kind: "overpayment", amount: 0n });
    else await writeWholeCancellation(tx, orderId, { ...refund, amount: b.totalAmount });
  });
  return getAdminOrder(orderId);
}

/**
 * Annuler des machines d'une commande payée (souci de stock, machine défectueuse, demande de
 * l'utilisateur, autre décision), remboursées par le même moyen (Bitcoin) au prorata de ce qui a été
 * payé ; frais à la charge de la boutique, sauf `user_renounce` (à la charge de l'utilisateur :
 * `409 refund_below_network_fee` si le prorata ne les couvre pas). Toutes les machines annulées : la
 * commande est remboursée, avec l'excédent éventuel encore non remboursé (sans frais).
 */
export async function cancelPaidLines(orderId: string, input: z.output<typeof cancelLinesInput>, actor: Actor) {
  const createdBy = authUserIdToDb(actor.authUserId);
  const fee = await getPaymentService().estimateRefundNetworkFeeSats();
  await getDb().$transaction(async (tx) => {
    const b = await loadBalance(tx, orderId, { lock: true });
    if (b.status !== "paid") {
      throw new ApiError(409, "order_not_paid", "Seules les machines d'une commande payée s'annulent ainsi.");
    }
    await cancelOrderLines(tx, orderId, b, input.lineIds, {
      cause: input.cause ?? "admin_other",
      networkFeeSats: fee,
      initiatedBy: "admin",
      createdBy,
      reason: input.reason,
      destinationAddress: input.destinationAddress,
    });
  });
  return getAdminOrder(orderId);
}

/** L'admin donne, change ou efface l'adresse de remboursement d'une facture (journalisé avec son identifiant). */
export async function setAdminRefundAddress(orderId: string, input: z.output<typeof refundAddressInput>, actor: Actor) {
  const authUserId = authUserIdToDb(actor.authUserId);
  await getDb().$transaction(async (tx) => {
    const [found] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR NO KEY UPDATE`;
    if (!found) throw orderNotFound();
    await writeOrderRefundAddress(tx, orderId, input.refundAddress, { kind: "admin", authUserId });
  });
  return getAdminOrder(orderId);
}

// ─── Envoi des remboursements ───

export const refundNotFound = () => new ApiError(404, "refund_not_found", "Remboursement introuvable.");

type ToSendRow = {
  refund_id: string;
  order_id: string;
  batch_id: string;
  batch_name: string | null;
  user_id: string;
  auth_user_id: bigint;
  kind: RefundKind;
  cause: RefundCause;
  initiated_by: RefundInitiator;
  amount_sats: bigint;
  network_fee_sats: bigint | null;
  network_fee_payer: RefundFeePayer;
  destination_address: string | null;
  destination_source: "refund" | "order" | null;
  address_missing: boolean;
  reason: string;
  created_at: Date;
};

/**
 * Remboursements à envoyer (vue refunds_to_send), les plus anciens d'abord, avec l'adresse effective :
 * celle choisie pour ce remboursement (`destinationSource: "refund"`), sinon celle de la facture
 * (`"order"`), sinon aucune (`addressMissing` : contacter l'utilisateur).
 */
export async function listRefundsToSend() {
  const rows = await getDb().$queryRaw<ToSendRow[]>`
    SELECT ts."refund_id", ts."order_id", ts."batch_id", b."name" AS "batch_name", ts."user_id", u."auth_user_id",
      ts."kind"::text AS "kind", ts."cause"::text AS "cause", ts."initiated_by"::text AS "initiated_by",
      ts."amount_sats", ts."network_fee_sats", ts."network_fee_payer"::text AS "network_fee_payer",
      ts."destination_address", ts."destination_source", ts."address_missing", r."reason", ts."created_at"
    FROM "refunds_to_send" ts
    JOIN "Refund" r ON r."id" = ts."refund_id"
    JOIN "Batch" b ON b."id" = ts."batch_id"
    JOIN "User" u ON u."id" = ts."user_id"
    ORDER BY ts."created_at", ts."refund_id"`;
  return {
    items: rows.map((r) => ({
      refundId: r.refund_id,
      orderId: r.order_id,
      batch: { id: r.batch_id, name: r.batch_name },
      user: { id: r.user_id, authUserId: r.auth_user_id.toString() },
      kind: r.kind,
      cause: r.cause,
      causeLabel: REFUND_CAUSE_LABELS[r.cause],
      initiatedBy: r.initiated_by,
      /** Sats à envoyer à l'utilisateur */
      amountSats: bigintToJson(r.amount_sats),
      networkFeeSats: bigintToJson(r.network_fee_sats),
      networkFeePayer: r.network_fee_payer,
      /** Adresse effective, à recopier telle quelle dans `POST …/send` */
      destinationAddress: r.destination_address,
      destinationSource: r.destination_source,
      addressMissing: r.address_missing,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

/**
 * Enregistre l'envoi d'un remboursement par l'admin : référence de la transaction et adresse à laquelle
 * il a envoyé (celle qu'il a vue ; le serveur ne la recopie jamais). `WHERE sent_at IS NULL` : un seul
 * envoi. La base compare l'adresse à l'adresse effective lue sous verrou de la facture : un changement
 * d'adresse validé entre-temps fait échouer l'envoi (`409 refund_destination_changed`) ; sans adresse
 * connue, celle que l'admin a obtenue par contact est inscrite. Rejoué à l'identique : `200` sans effet ;
 * avec une autre référence ou adresse : `409 refund_already_sent`.
 */
export async function sendRefund(refundId: string, input: z.output<typeof sendRefundInput>, actor: Actor) {
  const sentBy = authUserIdToDb(actor.authUserId);
  const db = getDb();
  const sent = await db.$queryRaw<{ order_id: string }[]>`
    UPDATE "Refund"
    SET "sent_at" = now(), "reference" = ${input.reference}, "destination_address" = ${input.destinationAddress},
        "sent_by_auth_user_id" = ${sentBy}
    WHERE "id" = ${refundId}::uuid AND "sent_at" IS NULL
    RETURNING "order_id"`;
  if (sent.length > 0) return getAdminOrder(sent[0].order_id);
  const existing = await db.refund.findUnique({
    where: { id: refundId },
    select: { order_id: true, reference: true, destination_address: true },
  });
  if (!existing) throw refundNotFound();
  if (existing.reference !== input.reference || existing.destination_address !== input.destinationAddress) {
    throw new ApiError(409, "refund_already_sent", "Ce remboursement est déjà envoyé (autre transaction ou autre adresse).");
  }
  return getAdminOrder(existing.order_id);
}

// ─── Blocages après abandons ───

type BlockRow = {
  user_id: string;
  auth_user_id: bigint;
  batch_id: string;
  batch_name: string;
  batch_status: BatchStatus;
  blocked_at: Date;
  abandoned_orders: number;
  last_released_at: Date | null;
};

/** Utilisateurs bloqués sur un lot ouvert aux commandes (vue order_creation_blocks), les plus récents d'abord. */
export async function listOrderBlocks(query: { batchId?: string } = {}) {
  const rows = await getDb().$queryRaw<BlockRow[]>`
    SELECT ocb."user_id", u."auth_user_id", ocb."batch_id", b."name" AS "batch_name", b."status"::text AS "batch_status",
      ocb."blocked_at", ocb."abandoned_orders", ocb."last_released_at"
    FROM "order_creation_blocks" ocb
    JOIN "User" u ON u."id" = ocb."user_id"
    JOIN "Batch" b ON b."id" = ocb."batch_id"
    WHERE (${query.batchId ?? null}::uuid IS NULL OR ocb."batch_id" = ${query.batchId ?? null}::uuid)
    ORDER BY ocb."blocked_at" DESC, ocb."user_id"`;
  return {
    items: rows.map((r) => ({
      user: { id: r.user_id, authUserId: r.auth_user_id.toString() },
      batch: { id: r.batch_id, name: r.batch_name, status: r.batch_status, statusLabel: BATCH_STATUS_LABELS[r.batch_status] },
      blockedAt: r.blocked_at.toISOString(),
      abandonedOrders: r.abandoned_orders,
      lastReleasedAt: r.last_released_at?.toISOString() ?? null,
    })),
  };
}

export const blockListQuery = z.object({ batchId: z.uuid().optional() });

/**
 * « Lever le blocage » : les abandons antérieurs de l'utilisateur sur ce lot ne comptent plus (ni
 * plafond ni délai). Journal append-only ; une levée sur un utilisateur non bloqué efface aussi ses
 * abandons passés (accepté par la base, sans effet visible).
 */
export async function releaseOrderBlock(input: z.output<typeof blockReleaseInput>, actor: Actor) {
  const db = getDb();
  const [user, batch] = await Promise.all([
    db.user.findUnique({ where: { id: input.userId }, select: { id: true } }),
    db.batch.findUnique({ where: { id: input.batchId }, select: { id: true } }),
  ]);
  if (!batch) throw batchNotFound();
  if (!user) throw new ApiError(422, "unknown_user", "Utilisateur introuvable.");
  const release = await db.orderBlockRelease.create({
    data: {
      user_id: input.userId,
      batch_id: input.batchId,
      released_by_auth_user_id: authUserIdToDb(actor.authUserId),
      reason: input.reason ?? null,
    },
  });
  return {
    id: release.id,
    userId: release.user_id,
    batchId: release.batch_id,
    releasedBy: release.released_by_auth_user_id.toString(),
    reason: release.reason,
    createdAt: release.created_at.toISOString(),
  };
}
