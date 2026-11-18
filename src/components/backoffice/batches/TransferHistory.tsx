import Link from "next/link";
import type { BatchDetail } from "@/server/batches";
import { formatDateTime } from "@/lib/dates";

/** Motif d'un transfert palette → stock. */
export const TRANSFER_REASONS: Record<BatchDetail["transfers"][number]["reason"], string> = {
  batch_closed: "Clôture de la palette",
  admin: "Transfert manuel",
};

/**
 * Transferts de machines d'un lot : sortants (palette → stock) ou entrants (lot de stock), du plus récent au plus
 * ancien. Rien n'est affiché s'il n'y en a aucun.
 */
export function TransferHistory({ title, transfers }: Readonly<{ title: string; transfers: BatchDetail["transfers"] }>) {
  if (transfers.length === 0) return null;
  return (
    <section className="bo-card" aria-label={title}>
      <h2 style={{ marginBottom: 16 }}>{title}</h2>
      <div className="bo-table-scroll">
        <table className="bo-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Machine</th>
              <th scope="col">De → vers</th>
              <th scope="col">Motif</th>
            </tr>
          </thead>
          <tbody>
            {[...transfers].reverse().map((t) => (
              <tr key={t.id}>
                <td>{formatDateTime(t.createdAt)}</td>
                <td>
                  <Link href={`/backoffice/machines/${t.machineId}`} className="bo-mono">
                    {t.serial ?? "Sans numéro"}
                  </Link>
                </td>
                <td>
                  <Link href={`/backoffice/lots/${t.from.id}`}>{t.from.name}</Link> →{" "}
                  <Link href={`/backoffice/lots/${t.to.id}`}>{t.to.name}</Link>
                </td>
                <td>
                  {TRANSFER_REASONS[t.reason]}
                  {t.note && <q style={{ display: "block" }}>{t.note}</q>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
