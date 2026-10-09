import type { BatchStatus } from "../../../prisma/generated/enums";
import { BATCH_STATUS_LABELS } from "@/server/batch-status";

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
};

export function StatusBadge({ status }: { status: BatchStatus }) {
  return <span className={`bo-badge bo-badge-${TONE[status]}`}>{BATCH_STATUS_LABELS[status]}</span>;
}
