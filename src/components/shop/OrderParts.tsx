import type { OrderDto } from "@/server/orders";
import { formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { feePayerLabel, formatSats } from "@/components/money";

/** Machines de la facture, dans l'ordre de création (`position`), avec leur configuration. */
export function OrderLines({ lines }: { lines: OrderDto["lines"] }) {
  const sorted = [...lines].sort((a, b) => a.position - b.position);
  return (
    <ol className="shop-machines">
      {sorted.map((line) => (
        <li key={line.id} className="shop-machine" data-refunded={line.refunded ? "true" : undefined}>
          <div className="shop-machine-main">
            <h3>
              Machine {line.position}
              {line.refunded && <span className="bo-badge bo-badge-cancelled">Annulée et remboursée</span>}
            </h3>
            <ul className="shop-config-list">
              <li>
                <span>Machine seule</span>
                <span className="bo-num">{formatCents(line.basePrice)}</span>
              </li>
              {line.items.map((item) => (
                <li key={item.optionId} data-default={item.isDefault ? "true" : undefined}>
                  <span>
                    {item.optionTitle} : {item.label}
                  </span>
                  <span className="bo-num">{item.unitPrice === "0" ? "—" : `+ ${formatCents(item.unitPrice)}`}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="shop-machine-side">
            <p className="shop-machine-amount bo-num">{formatCents(line.amount)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Versements reçus sur l'adresse de la facture. */
export function PaymentList({ payments }: { payments: OrderDto["payments"] }) {
  if (payments.length === 0) return <p className="bo-muted">Aucun versement reçu pour l&apos;instant.</p>;
  return (
    <div className="bo-table-scroll">
      <table className="bo-table">
        <thead>
          <tr>
            <th scope="col">Reçu le</th>
            <th scope="col">Montant</th>
            <th scope="col">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id}>
              <td>{formatDateTime(p.receivedAt)}</td>
              <td className="bo-num">{formatSats(p.amountSats)}</td>
              <td className="bo-mono shop-break">
                {p.txid}:{p.vout}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Refund = OrderDto["refunds"][number] & { createdBy?: string | null; sentBy?: string | null };

/**
 * Remboursements de la facture : motif, montant envoyé, frais du réseau et qui les paie, envoi.
 * `admin` : ajoute la destination prévue, l'initiateur et les auteurs (backoffice).
 */
export function RefundList({
  refunds,
  refundAddress,
  admin = false,
}: {
  refunds: Refund[];
  refundAddress: string | null;
  admin?: boolean;
}) {
  if (refunds.length === 0) return <p className="bo-muted">Aucun remboursement.</p>;
  return (
    <ul className="shop-refunds">
      {refunds.map((r) => (
        <li key={r.id} className="shop-refund">
          <div className="shop-refund-head">
            <strong>{r.causeLabel}</strong>
            {r.sentAt ? (
              <span className="bo-badge bo-badge-done">Envoyé le {formatDateTime(r.sentAt)}</span>
            ) : (
              <span className="bo-badge bo-badge-warning">En préparation</span>
            )}
          </div>
          <dl className="shop-refund-facts">
            <div>
              <dt>{r.sentAt ? "Montant envoyé" : "Montant à recevoir"}</dt>
              <dd className="bo-num">{formatSats(r.amountSats)}</dd>
            </div>
            <div>
              <dt>Frais du réseau</dt>
              <dd>
                <span className="bo-num">{formatSats(r.networkFeeSats)}</span>, {feePayerLabel(r.networkFeePayer)}
                {r.networkFeePayer === "user" && r.networkFeeSats !== "0" && " (déduits)"}
              </dd>
            </div>
            {r.amount !== "0" && (
              <div>
                <dt>Valeur remboursée</dt>
                <dd className="bo-num">{formatCents(r.amount)}</dd>
              </div>
            )}
            <div>
              <dt>Destination</dt>
              <dd className="bo-mono shop-break">
                {r.destinationAddress ?? refundAddress ?? <span className="bo-muted">adresse à fournir</span>}
              </dd>
            </div>
            {r.reference && (
              <div>
                <dt>Transaction</dt>
                <dd className="bo-mono shop-break">{r.reference}</dd>
              </div>
            )}
          </dl>
          <p className="bo-hint">
            Décidé le {formatDateTime(r.createdAt)}
            {admin && (
              <>
                {" "}
                · {r.initiatedBy === "user" ? "par l'utilisateur" : r.initiatedBy === "admin" ? `par l'admin n° ${r.createdBy ?? "?"}` : "automatiquement"}
                {r.sentBy && <> · envoi enregistré par l&apos;admin n° {r.sentBy}</>}
                {r.reason && <> · motif : « {r.reason} »</>}
              </>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}
