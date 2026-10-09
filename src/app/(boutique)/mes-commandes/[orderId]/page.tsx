import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getOrder } from "@/server/orders";
import { formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { machines } from "@/lib/plural";
import { OrderStatusBadge } from "@/components/backoffice/OrderStatusBadge";
import { formatSats } from "@/components/money";
import { AddressBlock } from "@/components/shop/AddressBlock";
import { CancelOrder, RefundAddressEditor, RefundDeposit, Renounce } from "@/components/shop/OrderActions";
import { OrderLines, PaymentList, RefundList } from "@/components/shop/OrderParts";
import { PaymentInstructions, RefreshStatus } from "@/components/shop/PaymentPanel";
import { loadOr404 } from "../../../_lib/load";
import { loginUrl, pagePath } from "../../../_lib/login";

export const metadata: Metadata = { title: "Ma commande" };

/** Confirmations après une action (`?fait=…`, posé par les composants d'action). */
const DONE: Record<string, string> = {
  annulation: "Facture annulée : les machines réservées sont libérées.",
  remboursement: "Remboursement demandé : il apparaît ci-dessous, avec le montant que vous recevrez.",
  renoncement: "Renoncement enregistré : le remboursement apparaît ci-dessous, avec le montant que vous recevrez.",
};

/**
 * Facture de l'utilisateur : paiement (adresse, montant, réservation), état, choix entre appoint et
 * remboursement, annulation, renoncement, adresse de remboursement, machines, versements et
 * remboursements. Celle d'un autre, inconnue ou mal formée : page 404 (rien n'est révélé).
 * Les actions proposées suivent les drapeaux de l'API (`actions`, `awaitingUserDecision`).
 */
export default async function OrderPage({ params, searchParams }: PageProps<"/mes-commandes/[orderId]">) {
  const { orderId } = await params;
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(loginUrl(pagePath(`/mes-commandes/${encodeURIComponent(orderId)}`, sp), "/mes-commandes"));
  const order = await loadOr404(orderId, (id) => getOrder(user.id, id));
  const { actions, payment } = order;
  const done = typeof sp.fait === "string" ? (DONE[sp.fait] ?? null) : null;
  const created = sp.nouvelle === "1" && order.status === "pending_payment";
  const pending = order.status === "pending_payment";
  // Facture en attente d'un lot qui n'accepte plus de commande (annulé, expédié…) : plus de paiement à faire
  const payable = pending && order.batch.acceptsOrders;
  const underReview = payment.underReviewSats !== "0";
  const batchCancelled = order.batch.status === "cancelled";
  const activeLines = order.lines.filter((l) => !l.refunded).length;
  const received = payment.receivedSats !== "0";

  return (
    <>
      <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
        <Link href="/mes-commandes">Mes commandes</Link>
      </nav>
      <div className="shop-page-head">
        <p className="shop-eyebrow">
          <OrderStatusBadge status={order.status} label={order.statusLabel} />
          <span className="shop-lot-name">
            {order.kindLabel} du {formatDateTime(order.createdAt)}
          </span>
        </p>
        <h1>{order.batch.name}</h1>
        <p>
          {order.batch.model.name} · {machines(order.lines.length)} · {formatCents(order.totalAmount)}
          {order.batch.isPublic && (
            <>
              {" "}
              · <Link href={`/lots/${order.batch.id}`}>Voir le lot</Link>
            </>
          )}
        </p>
      </div>

      <div className="shop-order-detail">
        <div className="bo-stack">
          <div role="status" aria-live="polite">
            {created && (
              <div className="bo-alert bo-alert-success">
                Facture créée : vos machines sont réservées jusqu&apos;à l&apos;heure indiquée. Payez le montant ci-dessous pour
                confirmer votre commande.
              </div>
            )}
            {done && <div className="bo-alert bo-alert-success">{done}</div>}
          </div>

          {/* Action principale selon l'état donné par le serveur */}
          {pending && !payable && (
            <section className="bo-card" aria-labelledby="lot-ferme">
              <h2 id="lot-ferme">{batchCancelled ? "Lot annulé" : "Ce lot n'accepte plus de commande"}</h2>
              <p className="bo-muted">
                {batchCancelled ? "Ce lot a été annulé. " : `Le lot est au statut « ${order.batch.statusLabel} ». `}
                {received
                  ? `N'envoyez rien de plus à l'adresse de cette facture : votre versement (${formatSats(payment.receivedSats)}) est traité par notre équipe, qui vous contactera.`
                  : "N'envoyez rien à l'adresse de cette facture."}
              </p>
            </section>
          )}

          {payable && (
            <section className="shop-config" aria-labelledby="paiement">
              <h2 id="paiement">{actions.awaitingTopUp ? "Paiement incomplet : complétez-le" : "Payer en bitcoins"}</h2>
              {actions.awaitingTopUp ? (
                <p>
                  Nous avons reçu {formatSats(payment.receivedSats)} sur {formatSats(payment.expectedSats)}. Envoyez le reste
                  à la même adresse avant la fin de la réservation.
                </p>
              ) : (
                <p>
                  Envoyez exactement ce montant à l&apos;adresse ci-dessous, en une ou plusieurs fois. Le paiement est
                  détecté automatiquement ; votre commande est confirmée dès réception du montant complet.
                </p>
              )}
              <PaymentInstructions
                address={payment.address}
                toSendSats={payment.outstandingSats}
                expiresAt={order.expiresAt}
                showCountdown
              />
              <p className="bo-hint">
                Total de la facture : {formatCents(order.totalAmount)}, soit {formatSats(payment.expectedSats)} au cours
                fixé à la création de la facture.
              </p>
              <RefreshStatus auto />
              {(actions.canCancel || actions.canRequestRefund) && (
                <div className="bo-actions">
                  {actions.canRequestRefund && <RefundDeposit order={order} />}
                  {actions.canCancel && <CancelOrder orderId={order.id} />}
                </div>
              )}
            </section>
          )}

          {order.status === "expired" && order.awaitingUserDecision && (
            <section className="shop-config" aria-labelledby="choix">
              <h2 id="choix">Votre choix est attendu</h2>
              <p>
                La réservation est terminée alors que le paiement est incomplet : nous avons reçu{" "}
                {formatSats(payment.receivedSats)} sur {formatSats(payment.expectedSats)}. Deux possibilités :
              </p>
              <div className="shop-decision">
                <div className="shop-decision-option">
                  <h3>Compléter le paiement</h3>
                  <p className="bo-hint">
                    Envoyez le reste à la même adresse. La commande est acceptée s&apos;il reste de la place sur le lot ;
                    sinon, tout ce que vous avez envoyé vous est remboursé.
                  </p>
                  {actions.awaitingTopUp && (
                    <PaymentInstructions
                      address={payment.address}
                      toSendSats={payment.outstandingSats}
                      expiresAt={order.expiresAt}
                      showCountdown={false}
                    />
                  )}
                </div>
                <div className="shop-decision-option">
                  <h3>Être remboursé</h3>
                  <p className="bo-hint">
                    Nous vous renvoyons ce que vous avez envoyé. Les frais du réseau Bitcoin de ce remboursement sont à votre
                    charge : ils sont déduits du montant renvoyé.
                  </p>
                  {actions.canRequestRefund && <RefundDeposit order={order} primary />}
                </div>
              </div>
              <RefreshStatus auto={false} />
            </section>
          )}

          {order.status === "expired" && !order.awaitingUserDecision && (
            <section className="bo-card" aria-labelledby="expiree">
              <h2 id="expiree">Réservation expirée</h2>
              <p className="bo-muted">
                {batchCancelled && "Ce lot a été annulé. "}
                {received
                  ? "La réservation est terminée. Nous traitons votre versement et vous tiendrons informé."
                  : "Aucun paiement n'a été reçu dans les 30 minutes : les machines ont été libérées. N'envoyez rien à l'adresse de cette facture."}
              </p>
              {order.batch.acceptsOrders && (
                <div className="bo-actions" style={{ marginTop: 12 }}>
                  <Link className="bo-btn bo-btn-primary" href={`/lots/${order.batch.id}/commander`}>
                    Commander à nouveau
                  </Link>
                </div>
              )}
            </section>
          )}

          {order.status === "paid" && (
            <section className="bo-card" aria-labelledby="payee">
              <h2 id="payee">Commande confirmée</h2>
              <p className="bo-muted">
                Paiement reçu{order.paidAt && <> le {formatDateTime(order.paidAt)}</>}. Le lot est au statut «{" "}
                {order.batch.statusLabel} » : nous vous tiendrons informé de son avancement jusqu&apos;à l&apos;expédition.
                {activeLines < order.lines.length && <> {machines(activeLines)} reste{activeLines > 1 ? "nt" : ""} commandée{activeLines > 1 ? "s" : ""}.</>}
              </p>
            </section>
          )}

          {order.status === "cancelled" && (
            <section className="bo-card" aria-labelledby="annulee">
              <h2 id="annulee">{batchCancelled ? "Lot annulé" : "Facture annulée"}</h2>
              <p className="bo-muted">
                {batchCancelled ? (
                  "Ce lot a été annulé : votre facture est annulée et les machines sont libérées."
                ) : (
                  <>Annulée{order.cancelledAt && <> le {formatDateTime(order.cancelledAt)}</>}.</>
                )}{" "}
                N&apos;envoyez rien à l&apos;adresse de cette facture
                {underReview ? " : votre versement est traité par notre équipe, qui vous contactera." : "."}
              </p>
            </section>
          )}

          {order.status === "refunded" && (
            <section className="bo-card" aria-labelledby="remboursee">
              <h2 id="remboursee">Commande remboursée</h2>
              <p className="bo-muted">
                Tout ce que vous avez envoyé vous est remboursé{order.refundedAt && <> (décision du {formatDateTime(order.refundedAt)})</>}.
                Le détail des remboursements est ci-dessous.
              </p>
            </section>
          )}

          {underReview && (order.status === "paid" || order.status === "refunded") && (
            <section className="bo-card bo-attention" aria-labelledby="verification">
              <h2 id="verification">Un versement est en cours de traitement</h2>
              <p className="bo-muted">
                {order.status === "paid"
                  ? `Vous avez envoyé ${formatSats(payment.underReviewSats)} de plus que le montant de la commande. Rien n'est remboursé automatiquement : notre équipe vous contactera pour décider de ce surplus.`
                  : order.status === "refunded"
                    ? `Un paiement de ${formatSats(payment.underReviewSats)} est arrivé après le remboursement de cette commande. Notre équipe vous contactera : n'envoyez rien d'autre à cette adresse.`
                    : `Un paiement de ${formatSats(payment.underReviewSats)} est arrivé sur cette facture. Notre équipe l'examine et vous contactera.`}
              </p>
            </section>
          )}

          {order.status === "paid" && !actions.canRenounce && activeLines > 0 && (
            <section className="bo-card" aria-labelledby="renoncer-ferme">
              <h2 id="renoncer-ferme">Une modification ou une annulation ?</h2>
              <p className="bo-muted">
                Le lot a dépassé la phase de précommande : vous ne pouvez plus renoncer à cette commande depuis cette page.
                Contactez-nous si vous souhaitez l&apos;annuler.
              </p>
            </section>
          )}

          {actions.canRenounce && (
            <section className="bo-card">
              <Renounce order={order} />
            </section>
          )}

          <section className="bo-card" aria-labelledby="machines">
            <h2 id="machines">Machines</h2>
            <OrderLines lines={order.lines} />
            <p className="shop-summary-line shop-order-total">
              <span>Total</span>
              <strong className="bo-num">{formatCents(order.totalAmount)}</strong>
            </p>
          </section>

          <section className="bo-card" aria-labelledby="remboursements">
            <h2 id="remboursements">Remboursements</h2>
            <RefundList refunds={order.refunds} refundAddress={order.refundAddress} />
          </section>

          <section className="bo-card" aria-labelledby="versements">
            <h2 id="versements">Versements reçus</h2>
            <PaymentList payments={order.payments} />
          </section>
        </div>

        <aside className="bo-stack" aria-label="Coordonnées">
          <section className="bo-card" aria-labelledby="remboursement-adresse">
            <h2 id="remboursement-adresse">Adresse de remboursement</h2>
            <p className="bo-hint">Adresse Bitcoin où vous renvoyer des fonds si nous devons vous rembourser.</p>
            <RefundAddressEditor orderId={order.id} current={order.refundAddress} editable={actions.canEditRefundAddress} />
          </section>
          <section className="bo-card" aria-labelledby="facturation">
            <h2 id="facturation">Facturation</h2>
            <AddressBlock address={order.billingAddress} />
          </section>
          <section className="bo-card" aria-labelledby="livraison">
            <h2 id="livraison">Livraison</h2>
            <AddressBlock address={order.shippingAddress} />
          </section>
        </aside>
      </div>
    </>
  );
}
