import type { OrderStatus } from "../../../prisma/generated/enums";

/** Famille visuelle d'un statut de facture (libellé : `statusLabel` de l'API). */
const TONE: Record<OrderStatus, string> = {
  pending_payment: "warning",
  paid: "done",
  expired: "neutral",
  refunded: "neutral",
  cancelled: "cancelled",
};

export function OrderStatusBadge({ status, label }: { status: OrderStatus; label: string }) {
  return <span className={`bo-badge bo-badge-${TONE[status]}`}>{label}</span>;
}
