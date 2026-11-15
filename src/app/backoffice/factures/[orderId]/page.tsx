import type { Metadata } from "next";
import Link from "next/link";
import { getAdminOrder } from "@/server/backoffice-orders";
import { getBatchMachines } from "@/server/machines";
import { formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { machines } from "@/lib/plural";
import { loadOr404 } from "@/app/_lib/load";
import { OrderStatusBadge } from "@/components/backoffice/OrderStatusBadge";
import { ContactEmails } from "@/components/backoffice/orders/ContactEmails";
import { StatusBadge } from "@/components/backoffice/StatusBadge";
import {
  AcceptOrder,
  AdminRefund,
  AdminRefundAddress,
  CancelLines,
  DismissExcess,
} from "@/components/backoffice/orders/AdminOrderActions";
import { DiscountForm } from "@/components/backoffice/orders/DiscountForm";
import { ATTENTION_REASONS, CANCEL_REASONS, customerTitle } from "@/components/backoffice/orders/labels";
import { OffchainRefundSend } from "@/components/backoffice/orders/OffchainRefundSend";
import { OrderPayment } from "@/components/backoffice/orders/OrderPayment";
import { formatSats } from "@/components/money";
import { AddressBlock } from "@/components/shop/AddressBlock";
import { OrderLines, RefundList } from "@/components/shop/OrderParts";
import { backofficeAccess } from "../../_lib/access";

export const metadata: Metadata = { title: "Facture" };

const DONE: Record<string, string> = {
  acceptee: "Commande acceptée.",
  remboursee: "Remboursement créé : il est dans la liste des remboursements à envoyer.",
  annulees: "Machines annulées : le remboursement est dans la liste des remboursements à envoyer.",
  adresse: "Adresse de remboursement enregistrée (changement journalisé).",
  classee: "Somme classée sans suite (journalisée).",
  vente: "Vente enregistrée : la facture est payée.",
  rabais: "Rabais accordé : le remboursement est dans la liste des remboursements à envoyer.",
  rendu: "Remise enregistrée : le remboursement est rendu au client.",
};

/** Machine attribuée à chaque ligne payée de la facture (lien vers sa fiche), par identifiant de ligne. */
async function assignedMachines(order: { id: string; status: string; batch: { id: string } }) {
  if (order.status !== "paid") return {};
  const { lines } = await getBatchMachines(order.batch.id);
  return Object.fromEntries(
    lines
      .filter((l) => l.orderId === order.id)
      .map((l) => [
        l.lineId,
        <p key={l.lineId} className="bo-hint" style={{ marginTop: 8 }}>
          {l.machineId ? (
            <>
              Machine attribuée : <Link href={`/backoffice/machines/${l.machineId}`}>{l.machineSerial ?? "sans numéro"}</Link>
            </>
          ) : (
            "Aucune machine attribuée pour l'instant."
          )}
        </p>,
      ]),
  );
}

/**
 * Facture au backoffice : raison « à traiter » et décisions (accepter, rembourser avec motif,
 * annuler des machines au prorata), adresse de remboursement et son journal, paiements, remboursements.
 * Les actions proposées suivent les drapeaux de l'API (`attention`, `cancelLineCauses`).
 */
export default async function AdminOrderPage({ params, searchParams }: PageProps<"/backoffice/factures/[orderId]">) {
  const { orderId } = await params;
  const sp = await searchParams;
  await backofficeAccess(`/backoffice/factures/${encodeURIComponent(orderId)}`);
  const order = await loadOr404(orderId, getAdminOrder);
  const done = typeof sp.fait === "string" ? (DONE[sp.fait] ?? null) : null;
  const attention = order.attention;
  const p = order.payment;
  const offchain = order.paymentMethod === "offchain";
  const machinesOfLines = await assignedMachines(order);
  const unsentOffchain = order.refunds.filter((r) => r.method === "offchain" && r.sentAt === null);
  // Ordre des actions (décision de Hugo 2026-10-13) : aucune n'est masquée, l'API décide
  const dismissFirst =
    attention !== null && attention.canDismiss && BigInt(order.unsettledSats) <= BigInt(attention.networkFeeSats);
  const dismiss = attention?.canDismiss ? (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ marginBottom: 10 }}>Classer sans suite</h3>
      <DismissExcess
        orderId={order.id}
        unsettledSats={order.unsettledSats}
        networkFeeSats={attention.networkFeeSats}
        primary={dismissFirst}
      />
    </div>
  ) : null;

  return (
    <>
      <div className="bo-page-head">
        <div>
          <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
            <Link href="/backoffice/a-traiter">À traiter</Link> ·{" "}
            <Link href={`/backoffice/lots/${order.batch.id}`}>{order.batch.name}</Link>
          </nav>
          <h1 style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            {order.kindLabel} du {formatDateTime(order.createdAt)} <OrderStatusBadge status={order.status} label={order.statusLabel} />
          </h1>
          <p>
            {customerTitle(order.user.authUserId)} · {machines(order.lines.length)} · {formatCents(order.totalAmount)} · lot{" "}
            <StatusBadge status={order.batch.status} label={order.batch.statusLabel} />
          </p>
          {order.manualSale && (
            <p className="bo-hint" style={{ marginTop: 6 }}>
              Vente manuelle saisie par l&apos;admin n° {order.manualSale.createdBy ?? "?"} · motif : {order.manualSale.reason}
            </p>
          )}
          {order.cancelReason && (
            <p className="bo-hint" style={{ marginTop: 6 }}>
              {CANCEL_REASONS[order.cancelReason] ?? order.cancelReason}
              {order.cancelledAt && <> le {formatDateTime(order.cancelledAt)}</>}
              {order.status !== "cancelled" && ", versement reçu ensuite"}
            </p>
          )}
        </div>
      </div>

      <div role="status" aria-live="polite">
        {done && (
          <div className="bo-alert bo-alert-success" style={{ marginBottom: 20 }}>
            {done}
            {sp.fait === "vente" && (
              <>
                {" "}
                <Link href={`/backoffice/vente?lot=${order.batch.id}`}>Nouvelle vente sur ce lot</Link>
              </>
            )}
          </div>
        )}
      </div>

      <div className="bo-grid-2">
        <div className="bo-stack">
          {attention ? (
            <section className="bo-card bo-attention" aria-labelledby="a-traiter">
              <h2 id="a-traiter">À traiter : {ATTENTION_REASONS[attention.reason] ?? attention.reason}</h2>
              <p style={{ marginTop: 8 }}>{attention.label}</p>
              {attention.canAccept && (
                <div style={{ marginTop: 16 }}>
                  <AcceptOrder orderId={order.id} />
                </div>
              )}
              {/* Excédent au plus égal aux frais : le rembourser coûterait autant ou plus que la somme, classer passe en premier */}
              {dismissFirst && dismiss}
              {attention.canRefund && (
                <div style={{ marginTop: 20 }}>
                  <h3 style={{ marginBottom: 10 }}>Rembourser</h3>
                  <AdminRefund orderId={order.id} causes={attention.refundCauses} primary={!dismissFirst} />
                </div>
              )}
              {!dismissFirst && dismiss}
              {attention.reason === "offchain_refund_unsent" &&
                unsentOffchain.map((refund) => (
                  <div key={refund.id} style={{ marginTop: 16 }}>
                    <OffchainRefundSend orderId={order.id} refund={refund} />
                  </div>
                ))}
              {!attention.canAccept && !attention.canRefund && !attention.canDismiss && attention.reason !== "offchain_refund_unsent" && (
                <p className="bo-hint" style={{ marginTop: 8 }}>
                  Aucune action ici : contactez le client, puis renseignez l&apos;adresse de remboursement ci-contre.
                </p>
              )}
            </section>
          ) : (
            <section className="bo-card" aria-labelledby="a-traiter">
              <h2 id="a-traiter">Rien à traiter</h2>
              <p className="bo-muted" style={{ marginTop: 6 }}>
                {order.actions.awaitingTopUp ? (
                  <>
                    Paiement partiel : {formatSats(p.receivedSats)} reçus sur {formatSats(p.expectedSats)}. L&apos;utilisateur
                    peut compléter son paiement ou demander le remboursement de son versement jusqu&apos;au{" "}
                    {formatDateTime(order.expiresAt)} ; au-delà, la facture apparaîtra dans « À traiter ».
                  </>
                ) : (
                  "Cette facture suit son cours."
                )}
              </p>
            </section>
          )}

          <OrderPayment order={order} />

          {order.dismissal && (
            <section className="bo-card" aria-labelledby="classement">
              <h2 id="classement">Classé sans suite</h2>
              <p style={{ marginTop: 8 }}>
                {formatSats(order.dismissal.sats)} non renvoyés (frais estimés d&apos;un renvoi :{" "}
                {formatSats(order.dismissal.networkFeeSats)}).
              </p>
              <p className="bo-hint" style={{ marginTop: 6 }}>
                Le {formatDateTime(order.dismissal.createdAt)} par l&apos;admin n° {order.dismissal.dismissedBy}
                {order.dismissal.reason ? <> · motif : {order.dismissal.reason}</> : " · sans motif"}
              </p>
            </section>
          )}

          {order.status === "paid" && (
            <section className="bo-card" aria-labelledby="rabais">
              <h2 id="rabais" style={{ marginBottom: 12 }}>
                Rabais
              </h2>
              <DiscountForm orderId={order.id} refundableAmount={order.refundableAmount} offchain={offchain} />
            </section>
          )}

          {order.cancelLineCauses.length > 0 && (
            <section className="bo-card" aria-labelledby="annuler">
              <h2 id="annuler" style={{ marginBottom: 12 }}>
                Annuler des machines
              </h2>
              <CancelLines order={order} />
            </section>
          )}

          <section className="bo-card" aria-labelledby="machines">
            <h2 id="machines">Machines</h2>
            <OrderLines lines={order.lines} extra={machinesOfLines} />
          </section>

          <section className="bo-card" aria-labelledby="remboursements">
            <h2 id="remboursements" style={{ marginBottom: 12 }}>
              Remboursements
            </h2>
            <RefundList refunds={order.refunds} refundAddress={order.refundAddress} admin />
          </section>
        </div>

        <aside className="bo-stack" aria-label="Coordonnées">
          <section className="bo-card" aria-labelledby="contact">
            <h2 id="contact" style={{ marginBottom: 8 }}>
              Contact
            </h2>
            <ContactEmails contactEmail={order.contactEmail} profileEmail={order.profileEmail} />
          </section>
          {!offchain && (
            <section className="bo-card" aria-labelledby="adresse-remboursement">
              <h2 id="adresse-remboursement" style={{ marginBottom: 12 }}>
                Adresse de remboursement
              </h2>
              <AdminRefundAddress
                key={order.refundAddress ?? ""}
                orderId={order.id}
                current={order.refundAddress}
                editable={order.actions.canEditRefundAddress}
              />
              <h3 style={{ margin: "18px 0 8px" }}>Historique</h3>
              {order.refundAddressChanges.length === 0 ? (
                <p className="bo-muted">Aucun changement.</p>
              ) : (
                <ol className="bo-history">
                  {order.refundAddressChanges.map((c) => (
                    <li key={c.id}>
                      <span className="bo-mono">{c.newAddress ?? "Adresse effacée"}</span>
                      {c.oldAddress && (
                        <span className="bo-muted">
                          au lieu de <span className="bo-mono">{c.oldAddress}</span>
                        </span>
                      )}
                      <span className="bo-by">
                        <time dateTime={c.createdAt}>{formatDateTime(c.createdAt)}</time> ·{" "}
                        {c.actor === "admin" ? `admin n° ${c.actorAuthUserId}` : "le client"}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          <section className="bo-card" aria-labelledby="facturation">
            <h2 id="facturation" style={{ marginBottom: 8 }}>
              Facturation
            </h2>
            <AddressBlock address={order.billingAddress} />
          </section>
          <section className="bo-card" aria-labelledby="livraison">
            <h2 id="livraison" style={{ marginBottom: 8 }}>
              Livraison
            </h2>
            <AddressBlock address={order.shippingAddress} />
          </section>
        </aside>
      </div>
    </>
  );
}
