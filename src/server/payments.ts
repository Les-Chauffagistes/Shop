import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "../../prisma/generated/client";
import { getConfig } from "./config";
import { getDb } from "./db";
import { ApiError } from "./errors";
import { bigintToJson } from "./http";
import { loadBalance, writeWholeCancellation } from "./orders";
import { settlementStep } from "./order-rules";
import { getPaymentService } from "./payment-service";

/**
 * Paiements reçus (point d'entrée interne `POST /api/internal/payments`, appelé par le service de
 * paiement, simulé au jalon 4) et traitement automatique qui suit. Jamais accessible à un client :
 * secret partagé (PAYMENT_WEBHOOK_SECRET), point d'entrée fermé sans secret.
 *
 * Deux transactions :
 * 1. le paiement est enregistré (journal Payment, idempotent sur txid + vout) : il n'est JAMAIS
 *    refusé, et un échec du traitement ne l'efface pas ;
 * 2. traitement (settleOrder) : seulement si la base dit qu'il n'attend aucune décision humaine.
 * Rejouer le même appel est sans danger : le paiement n'est pas compté deux fois et le traitement
 * reprend là où il s'était arrêté.
 */

type Tx = Prisma.TransactionClient;

const sats = z
  .string({ error: 'Montant en satoshis attendu, sous forme de chaîne (ex. "150000")' })
  .regex(/^[1-9][0-9]{0,17}$/, { error: 'Montant en satoshis attendu, sous forme de chaîne (ex. "150000")' })
  .transform(BigInt);

export const paymentInput = z.strictObject({
  /** Adresse de réception (celle d'une facture) */
  address: z.string().trim().min(1).max(200),
  txid: z.string().trim().min(1).max(200),
  vout: z.int().min(0).max(1_000_000),
  amountSats: sats,
});

/** Vérifie le secret du service de paiement (en-tête `Authorization: Bearer …`), en temps constant. */
export function requirePaymentService(request: Request) {
  const secret = getConfig().payment.webhookSecret;
  // Point d'entrée fermé : il n'existe pas pour un client
  if (!secret) throw new ApiError(404, "not_found", "Ressource introuvable.");
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(given), digest(secret))) {
    throw new ApiError(401, "unauthenticated", "Secret du service de paiement invalide.");
  }
}

/** Ce que le traitement automatique a fait. */
export type SettlementAction = "accepted" | "refunded_no_stock";

/**
 * Traitement automatique d'une facture après un paiement (ou à la demande de l'admin) :
 * - paiement complet non accepté, lot ouvert (`awaiting_decision`) : Order_fits_stock (verrouille le
 *   lot) ; s'il reste de la place, la facture passe à payée ; sinon elle est remboursée intégralement
 *   (motif late_payment_no_room : frais à la charge de la boutique) ;
 * - excédent d'une facture payée : jamais remboursé d'office (décision Hugo 2026-10-09), la facture est
 *   « à traiter » (order_payment_balance.overpayment_unrefunded) et l'admin décide ;
 * - jamais si une décision humaine est attendue (needs_admin_decision, awaiting_user_decision).
 * Le contrôle de place précède le passage à payée : sinon un échec au COMMIT (Batch_stock)
 * annulerait aussi le reste de la transaction.
 */
export async function settleOrder(tx: Tx, orderId: string): Promise<SettlementAction[]> {
  const actions: SettlementAction[] = [];
  const fee = await getPaymentService().estimateRefundNetworkFeeSats();
  const b = await loadBalance(tx, orderId, { lock: true });
  if (settlementStep(b) === "decide") {
    const [{ fits }] = await tx.$queryRaw<{ fits: boolean }[]>`SELECT "Order_fits_stock"(${orderId}::uuid) AS "fits"`;
    if (fits) {
      await tx.$executeRaw`
        UPDATE "Order" SET "status" = 'paid', "paid_at" = now(), "updated_at" = now() WHERE "id" = ${orderId}::uuid`;
      actions.push("accepted");
    } else if (b.expiresAt > b.now) {
      // Réservation vivante qui ne tient plus (machines sorties du stock entre-temps) : la base
      // interdit de rembourser un paiement complet sur une réservation vivante (Order_late_payment_refund).
      // Rien d'automatique : la facture reste « paiement complet à traiter » au backoffice.
      return actions;
    } else {
      await writeWholeCancellation(tx, orderId, {
        cause: "late_payment_no_room",
        amount: b.totalAmount,
        grossSats: b.receivedSats - b.refundedSats,
        networkFeeSats: fee,
        initiatedBy: "system",
        reason: "Paiement reçu après l'expiration de la facture : plus de place sur le lot",
      });
      actions.push("refunded_no_stock");
    }
  }
  return actions;
}

/**
 * Enregistre un paiement reçu sur l'adresse d'une facture, puis la traite. Idempotent : la même
 * sortie (txid, vout) rejouée pour la même facture et le même montant répond `duplicate: true` sans
 * rien compter deux fois ; avec une autre facture ou un autre montant, `409 payment_conflict`.
 */
export async function recordPayment(input: z.output<typeof paymentInput>) {
  const db = getDb();
  const order = await db.order.findUnique({ where: { payment_address: input.address }, select: { id: true } });
  if (!order) throw new ApiError(404, "unknown_payment_address", "Aucune facture n'utilise cette adresse de paiement.");

  const inserted = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "Payment" ("order_id", "amount_sats", "txid", "vout")
    VALUES (${order.id}::uuid, ${input.amountSats}, ${input.txid}, ${input.vout})
    ON CONFLICT ("txid", "vout") DO NOTHING
    RETURNING "id"`;
  const payment = await db.payment.findUniqueOrThrow({ where: { txid_vout: { txid: input.txid, vout: input.vout } } });
  const duplicate = inserted.length === 0;
  if (duplicate && (payment.order_id !== order.id || payment.amount_sats !== input.amountSats)) {
    throw new ApiError(
      409,
      "payment_conflict",
      "Cette sortie de transaction est déjà enregistrée pour une autre facture ou un autre montant.",
    );
  }

  const actions = await db.$transaction((tx) => settleOrder(tx, order.id));
  const after = await loadBalance(db, order.id);
  return {
    duplicate,
    payment: {
      id: payment.id,
      orderId: payment.order_id,
      amountSats: bigintToJson(payment.amount_sats),
      txid: payment.txid,
      vout: payment.vout,
      receivedAt: payment.received_at.toISOString(),
    },
    /** Traitement automatique effectué par cet appel */
    actions,
    order: {
      id: order.id,
      status: after.status,
      expectedSats: bigintToJson(after.expectedSats),
      receivedSats: bigintToJson(after.receivedSats),
      outstandingSats: bigintToJson(after.outstandingSats),
      awaitingUserDecision: after.awaitingUserDecision,
      needsAdminAttention: after.needsAdminAttention,
    },
  };
}
