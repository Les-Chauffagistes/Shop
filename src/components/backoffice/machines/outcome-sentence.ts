import { formatCents } from "@/lib/decimal";

/** Commande payée en trop annoncée par `409 machine_shortage` (`details.refunds`, docs/api.md « Machines en moins »). */
export type Refund = { lineId: string; orderId: string; paidAt: string | null; contactEmail: string | null; amount: string };

/** Facture en attente annulée pour libérer une place (`cancelledOrders` de la réponse, cause `admin`). */
export type CancelledOrder = { orderId: string; cause: string };

/**
 * Phrase ajoutée au succès d'un marquage : commandes payées en trop remboursées (`refunds`) et factures en attente
 * annulées (`cancelledOrders`) dans la même transaction.
 */
export function outcomeSentence(result: unknown): string {
  const { refunds, cancelledOrders } = (result ?? {}) as { refunds?: unknown; cancelledOrders?: unknown };
  let sentence = "";
  if (Array.isArray(refunds) && refunds.length > 0) {
    const list = (refunds as Refund[]).map((r) => `${formatCents(r.amount)} (${r.contactEmail ?? "sans e-mail"})`).join(", ");
    sentence +=
      refunds.length === 1
        ? ` Une commande payée en trop a été remboursée : ${list}.`
        : ` ${refunds.length} commandes payées en trop ont été remboursées : ${list}.`;
  }
  if (Array.isArray(cancelledOrders) && cancelledOrders.length > 0) {
    sentence +=
      cancelledOrders.length === 1
        ? " Une facture en attente a été annulée pour libérer sa place."
        : ` ${cancelledOrders.length} factures en attente ont été annulées pour libérer des places.`;
  }
  return sentence;
}
