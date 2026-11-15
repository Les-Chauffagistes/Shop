import { batchStatusLabel } from "@/server/batch-status";
import type { BatchDetail } from "@/server/batches";
import { formatDateTime } from "@/lib/dates";

/** Journal des statuts d'un lot, du plus récent au plus ancien (« En pause » pour un lot de stock hors vente). */
export function StatusHistory({ batch }: { batch: Pick<BatchDetail, "kind" | "history"> }) {
  const label = (status: BatchDetail["status"]) => batchStatusLabel(batch.kind, status);
  return (
    <section className="bo-card" aria-labelledby="history">
      <h2 id="history" style={{ marginBottom: 16 }}>
        Historique
      </h2>
      <ol className="bo-history" reversed>
        {[...batch.history].reverse().map((h) => (
          <li key={h.id}>
            <span>
              {h.from ? (
                <>
                  {label(h.from)} → <strong>{label(h.to)}</strong>
                </>
              ) : (
                <>
                  Création en <strong>{label(h.to)}</strong>
                </>
              )}
            </span>
            {h.note && <q>{h.note}</q>}
            <span className="bo-by">
              <time dateTime={h.createdAt}>{formatDateTime(h.createdAt)}</time> · admin n° {h.changedBy}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
