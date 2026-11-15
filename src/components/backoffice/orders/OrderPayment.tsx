import type { getAdminOrder } from "@/server/backoffice-orders";
import { formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { formatSats } from "@/components/money";
import { PaymentList } from "@/components/shop/OrderParts";

type AdminOrder = Awaited<ReturnType<typeof getAdminOrder>>;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bo-stat">
      <dt>{label}</dt>
      <dd className="bo-num">{value}</dd>
    </div>
  );
}

/**
 * Paiement d'une facture au backoffice : en Bitcoin, sats attendus, reçus, non affectés, remboursés et l'adresse de
 * paiement ; hors chaîne (vente manuelle), montants en euros et encaissements (moyen, référence), sans adresse.
 */
export function OrderPayment({ order }: { order: AdminOrder }) {
  const p = order.payment;
  if (order.paymentMethod === "offchain") {
    return (
      <section className="bo-card" aria-labelledby="paiement">
        <h2 id="paiement">Paiement hors chaîne</h2>
        <dl className="bo-stats" style={{ marginTop: 12 }}>
          <Stat label="Total" value={formatCents(order.totalAmount)} />
          <Stat label="Encaissé" value={formatCents(p.receivedCents)} />
          <Stat label="Remboursé (rendu ou à rendre)" value={formatCents(p.refundedCents)} />
        </dl>
        <div style={{ marginTop: 16 }}>
          <PaymentList payments={order.payments} admin />
        </div>
      </section>
    );
  }
  return (
    <section className="bo-card" aria-labelledby="paiement">
      <h2 id="paiement">Paiement</h2>
      <dl className="bo-stats" style={{ marginTop: 12 }}>
        <Stat label="Attendu" value={formatSats(p.expectedSats)} />
        <Stat label="Reçu" value={formatSats(p.receivedSats)} />
        <Stat label="Non affecté" value={formatSats(order.unsettledSats)} />
        <Stat label="Remboursé (frais compris)" value={formatSats(p.refundedSats)} />
        {order.status === "refunded" && (
          <>
            <Stat label="Surplus resté" value={formatSats(p.surplusLeftSats)} />
            <Stat label="Versé après le remboursement" value={formatSats(p.paidAfterRefundSats)} />
          </>
        )}
      </dl>
      <p className="bo-hint" style={{ marginTop: 10 }}>
        Adresse de paiement <span className="bo-mono">{p.address}</span> · réservation jusqu&apos;au {formatDateTime(order.expiresAt)}
        {order.abandonedAt && <> · abandon compté le {formatDateTime(order.abandonedAt)}</>}
      </p>
      <div style={{ marginTop: 16 }}>
        <PaymentList payments={order.payments} />
      </div>
    </section>
  );
}
