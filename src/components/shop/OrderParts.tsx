import type { ReactNode } from "react";
import type { OrderDto } from "@/server/orders";
import { formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { feePayerLabel, formatSats } from "@/components/money";

/**
 * Machines de la facture, dans l'ordre de création (`position`), avec leur configuration. `extra` : contenu ajouté sous
 * une ligne, par identifiant de ligne (backoffice : machine attribuée).
 */
export function OrderLines({ lines, extra }: { lines: OrderDto["lines"]; extra?: Record<string, ReactNode> }) {
  const sorted = [...lines].sort((a, b) => a.position - b.position);
  return (
    <ol className="shop-machines">
      {sorted.map((line) => (
        <li key={line.id} className="shop-machine" data-refunded={line.refunded ? "true" : undefined}>
          <div className="shop-machine-main">
            <h3>
              Machine {line.position}
              {line.refunded && <span className="bo-badge bo-badge-cancelled">Annulée et remboursée</span>}
              {/* Côté client : « machine attribuée », jamais le numéro de série (le backoffice le montre via `extra`) */}
              {!extra && line.machineAssigned && <span className="bo-badge bo-badge-sale">Machine attribuée</span>}
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
            {extra?.[line.id]}
          </div>
          <div className="shop-machine-side">
            <p className="shop-machine-amount bo-num">{formatCents(line.amount)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

type Payment = OrderDto["payments"][number] & { recordedBy?: string | null };

/**
 * Versements reçus : en Bitcoin, sur l'adresse de la facture (transaction) ; hors chaîne (vente manuelle), les
 * encaissements en euros avec leur moyen et leur référence (`admin` : ajoute l'admin qui l'a enregistré).
 */
export function PaymentList({ payments, admin = false }: { payments: Payment[]; admin?: boolean }) {
  if (payments.length === 0) return <p className="bo-muted">Aucun versement reçu pour l&apos;instant.</p>;
  const offchain = payments.some((p) => p.method === "offchain");
  return (
    <div className="bo-table-scroll">
      <table className="bo-table">
        <thead>
          <tr>
            <th scope="col">Reçu le</th>
            <th scope="col">Montant</th>
            <th scope="col">{offchain ? "Moyen et référence" : "Transaction"}</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) =>
            p.method === "offchain" ? (
              <tr key={p.id}>
                <td>{formatDateTime(p.receivedAt)}</td>
                <td className="bo-num">{formatCents(p.amountCents)}</td>
                <td>
                  {p.offchainMeansLabel}
                  {p.reference && <> · {p.reference}</>}
                  {admin && p.recordedBy && <span className="bo-muted"> · enregistré par l&apos;admin n° {p.recordedBy}</span>}
                </td>
              </tr>
            ) : (
              <tr key={p.id}>
                <td>{formatDateTime(p.receivedAt)}</td>
                <td className="bo-num">{formatSats(p.amountSats)}</td>
                <td className="bo-mono shop-break">
                  {p.txid}:{p.vout}
                </td>
              </tr>
            ),
          )}
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
              <span className="bo-badge bo-badge-done">
                {r.method === "offchain" ? "Rendu" : "Envoyé"} le {formatDateTime(r.sentAt)}
              </span>
            ) : (
              <span className="bo-badge bo-badge-warning">En préparation</span>
            )}
          </div>
          {r.method === "offchain" ? (
            <dl className="shop-refund-facts">
              <div>
                <dt>{r.sentAt ? "Montant rendu" : "Montant à rendre"}</dt>
                <dd className="bo-num">{formatCents(r.amount)}</dd>
              </div>
              {r.reference && (
                <div>
                  <dt>Référence</dt>
                  <dd className="shop-break">{r.reference}</dd>
                </div>
              )}
            </dl>
          ) : (
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
          )}
          <p className="bo-hint">
            Décidé le {formatDateTime(r.createdAt)}
            {admin && (
              <>
                {" "}
                · {r.initiatedBy === "user" ? "par l'utilisateur" : r.initiatedBy === "admin" ? `par l'admin n° ${r.createdBy ?? "?"}` : "automatiquement"}
                {r.sentBy && (
                  <>
                    {" "}
                    · {r.method === "offchain" ? "remise enregistrée" : "envoi enregistré"} par l&apos;admin n° {r.sentBy}
                  </>
                )}
                {r.reason && <> · motif : « {r.reason} »</>}
              </>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}
