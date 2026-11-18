import type { BatchStatus } from "../../../prisma/generated/enums";

/** Famille visuelle d'un statut : brouillon, sondage, vente, logistique, terminé, annulé. */
const TONE: Record<BatchStatus, string> = {
  draft: "neutral",
  survey: "survey",
  preorder: "sale",
  ordering: "sale",
  awaiting_reception: "logistics",
  inspection: "logistics",
  tuning: "logistics",
  packaging: "logistics",
  in_transit: "logistics",
  closed: "done",
  cancelled: "cancelled",
  on_sale: "sale",
};

/**
 * Badge du statut d'un lot : couleur selon le statut, texte donné par l'API (`statusLabel`). Un lot de stock
 * s'affiche « En pause » au backoffice et « En stock » en boutique : le libellé ne se déduit jamais ici.
 */
export function StatusBadge({ status, label }: Readonly<{ status: BatchStatus; label: string }>) {
  return <span className={`bo-badge bo-badge-${TONE[status]}`}>{label}</span>;
}
