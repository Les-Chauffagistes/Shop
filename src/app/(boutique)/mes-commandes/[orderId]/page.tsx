import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getOrder, type OrderDto } from "@/server/orders";
import { formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { machines } from "@/lib/plural";
import { OrderStatusBadge } from "@/components/backoffice/OrderStatusBadge";
import { formatSats } from "@/components/money";
import { AddressBlock } from "@/components/shop/AddressBlock";
import { CancelOrder, RefundAddressEditor, RefundDeposit, Renounce } from "@/components/shop/OrderActions";
import { OrderLines, PaymentList, RefundList } from "@/components/shop/OrderParts";
import { ShipmentInfo } from "@/components/shop/ShipmentInfo";
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

/** Facture entièrement payée mais pas encore acceptée (`payment.fullPaymentHold`) : titre et explication */
const HOLD_TITLES: Record<NonNullable<OrderDto["payment"]["fullPaymentHold"]>, string> = {
  settling: "Paiement reçu : validation en cours",
  no_room: "Paiement reçu, mais plus de machine disponible",
  batch_closed: "Paiement reçu, mais le lot est fermé aux commandes",
};
const HOLD_TEXTS: Record<NonNullable<OrderDto["payment"]["fullPaymentHold"]>, string> = {
  settling: "Votre commande est validée automatiquement dans quelques instants ; cette page se met à jour toute seule.",
  no_room:
    "Les machines de ce lot ont été attribuées à d'autres commandes avant l'arrivée de votre paiement. Nous vous rembourserons la totalité de ce que vous avez envoyé, sans déduire les frais du réseau Bitcoin, dès que la réservation est terminée.",
  batch_closed:
    "Le lot a fermé aux commandes pendant votre paiement. Notre équipe décide de la suite (accepter la commande ou vous rembourser) et vous contactera.",
};

/**
 * Qui avait annulé une facture ensuite acceptée ou remboursée, d'après `cancelReason` (posée par la base).
 * L'état du lot nomme seulement son statut (annulé, ou fermé aux commandes). null : jamais annulée.
 */
function cancelCause(reason: Awaited<ReturnType<typeof getOrder>>["cancelReason"], batchCancelled: boolean): string | null {
  switch (reason) {
    case "user":
      return "par vous";
    case "admin":
      return "par notre équipe";
    case "batch_closed":
      return batchCancelled ? "à l'annulation du lot" : "à la fermeture du lot aux commandes";
    default:
      return null;
  }
}

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
  // L'état du lot ne sert qu'à nommer son statut ; qui a annulé la facture se lit dans `cancelReason`
  const batchCancelled = order.batch.status === "cancelled";
  // Facture remboursée : montants donnés par la base (surplus resté, versement arrivé après le remboursement)
  const surplusLeft = payment.surplusLeftSats !== "0";
  const paidAfterRefund = payment.paidAfterRefundSats !== "0";
  const cancelledBy = cancelCause(order.cancelReason, batchCancelled);
  const activeLines = order.lines.filter((l) => !l.refunded).length;
  const received = payment.receivedSats !== "0";
  // Commande sur le lot de stock : machines en main, pas de renoncement en ligne (`actions.canRenounce` reste faux)
  const stock = order.batch.kind === "stock";
  // Vente enregistrée hors chaîne par la boutique : ni adresse de paiement ni adresse de remboursement Bitcoin
  const offchain = payment.method === "offchain";
  // Tout est payé mais la commande n'est pas encore acceptée : rien à payer, on explique pourquoi
  const hold = (pending || order.status === "expired") && payment.fullPaymentHold ? payment.fullPaymentHold : null;

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
          {pending && !payable && !hold && (
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

          {payable && payment.address && !hold && (
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

          {hold && (
            <section className="bo-card" aria-labelledby="paiement-recu">
              <h2 id="paiement-recu">{HOLD_TITLES[hold]}</h2>
              <p className="bo-muted">
                Nous avons reçu la totalité du paiement ({formatSats(payment.receivedSats)}). Il n&apos;y a plus rien à
                payer : n&apos;envoyez rien de plus à l&apos;adresse de cette facture. {HOLD_TEXTS[hold]}
              </p>
              {hold === "settling" && <RefreshStatus auto />}
            </section>
          )}

          {order.status === "expired" && order.awaitingUserDecision && !hold && (
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
                  {actions.awaitingTopUp && payment.address && (
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

          {order.status === "expired" && !order.awaitingUserDecision && !hold && (
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
                Paiement reçu{order.paidAt && <> le {formatDateTime(order.paidAt)}</>}.{" "}
                {stock ? (
                  "Vos machines sont en stock, déjà contrôlées : nous préparons leur expédition."
                ) : (
                  <>
                    Le lot est au statut « {order.batch.statusLabel} » : nous vous tiendrons informé de son avancement
                    jusqu&apos;à l&apos;expédition.
                  </>
                )}
                {activeLines < order.lines.length && <> {machines(activeLines)} reste{activeLines > 1 ? "nt" : ""} commandée{activeLines > 1 ? "s" : ""}.</>}
                {cancelledBy && <> Cette facture avait été annulée {cancelledBy} ; votre versement reçu ensuite a été accepté.</>}
              </p>
            </section>
          )}

          {order.status === "cancelled" && (
            <section className="bo-card" aria-labelledby="annulee">
              <h2 id="annulee">
                {cancelHeading(order.cancelReason, batchCancelled)}
              </h2>
              <p className="bo-muted">
                {cancelMessage(order.cancelReason, batchCancelled, order.batch.statusLabel)}
                {order.cancelledAt && <> Annulée le {formatDateTime(order.cancelledAt)}.</>} N&apos;envoyez rien à
                l&apos;adresse de cette facture
                {underReview ? " : votre versement est traité par notre équipe, qui vous contactera." : "."}
              </p>
            </section>
          )}

          {order.status === "refunded" && (
            <section className="bo-card" aria-labelledby="remboursee">
              <h2 id="remboursee">Commande remboursée</h2>
              <p className="bo-muted">
                {cancelledBy && <>Cette facture avait été annulée {cancelledBy} avant l&apos;arrivée de votre versement. </>}
                {surplusLeft ? "Le prix de la commande vous est remboursé" : "Tout ce que vous aviez envoyé vous est remboursé"}
                {order.refundedAt && <> (décision du {formatDateTime(order.refundedAt)})</>}.
                Le détail des remboursements est ci-dessous.
              </p>
            </section>
          )}

          {underReview && order.status === "paid" && (
            <section className="bo-card bo-attention" aria-labelledby="verification">
              <h2 id="verification">Un versement est en cours de traitement</h2>
              <p className="bo-muted">
                Vous avez envoyé {formatSats(payment.underReviewSats)} de plus que le montant de la commande. Rien n&apos;est
                remboursé automatiquement : notre équipe vous contactera pour décider de ce surplus.
              </p>
            </section>
          )}

          {order.status === "refunded" && (surplusLeft || paidAfterRefund) && (
            <section className="bo-card bo-attention" aria-labelledby="verification">
              <h2 id="verification">
                {surplusLeft && paidAfterRefund ? "Deux versements sont en cours de traitement" : "Un versement est en cours de traitement"}
              </h2>
              {surplusLeft && (
                <p className="bo-muted">
                  Vous aviez envoyé {formatSats(payment.surplusLeftSats)} de plus que le montant de la commande : ce surplus
                  n&apos;est pas compris dans le remboursement ci-dessous. Rien n&apos;est renvoyé automatiquement : notre
                  équipe vous contactera pour décider de son renvoi.
                </p>
              )}
              {paidAfterRefund && (
                <p className="bo-muted">
                  Un paiement de {formatSats(payment.paidAfterRefundSats)} est arrivé après le remboursement de cette commande.
                  Notre équipe vous contactera : n&apos;envoyez rien d&apos;autre à cette adresse.
                </p>
              )}
            </section>
          )}

          {order.dismissal && (
            <section className="bo-card" aria-labelledby="classe">
              <h2 id="classe">Somme classée sans suite</h2>
              <p className="bo-muted">
                {formatSats(order.dismissal.sats)} reçus en trop sur cette facture ne vous seront pas renvoyés : les frais du
                réseau Bitcoin pour les renvoyer ({formatSats(order.dismissal.networkFeeSats)}) auraient été au moins aussi
                élevés que la somme elle-même. Décision de notre équipe du {formatDateTime(order.dismissal.createdAt)}.
              </p>
            </section>
          )}

          {order.status === "paid" && !actions.canRenounce && activeLines > 0 && (
            <section className="bo-card" aria-labelledby="renoncer-ferme">
              <h2 id="renoncer-ferme">Une modification ou une annulation ?</h2>
              <p className="bo-muted">
                {stock
                  ? "Une commande de machines en stock ne s'annule pas en ligne : contactez-nous si vous souhaitez l'annuler."
                  : "Le lot a dépassé la phase de précommande : vous ne pouvez plus renoncer à cette commande depuis cette page. Contactez-nous si vous souhaitez l'annuler."}
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

          {order.shipment && (
            <section className="bo-card" aria-labelledby="expedition">
              <h2 id="expedition">Expédition</h2>
              <ShipmentInfo shipment={order.shipment} />
            </section>
          )}

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
          <section className="bo-card" aria-labelledby="contact">
            <h2 id="contact">E-mail de contact</h2>
            {order.contactEmail ? (
              <p className="shop-break">{order.contactEmail}</p>
            ) : (
              <p className="bo-muted">Aucun e-mail enregistré sur cette facture.</p>
            )}
            <p className="bo-hint">
              Adresse donnée pour cette commande, utilisée par notre équipe pour vous contacter. Elle ne change plus ; pour
              vos prochaines commandes, modifiez celle de <Link href="/profil">votre profil</Link>.
            </p>
          </section>
          {offchain ? (
            <section className="bo-card" aria-labelledby="remboursement-adresse">
              <h2 id="remboursement-adresse">Remboursement</h2>
              <p className="bo-hint">
                Cette commande a été réglée auprès de notre équipe, hors Bitcoin : aucune adresse de remboursement n&apos;est
                nécessaire. Si un remboursement est dû, il vous est rendu par le même moyen.
              </p>
            </section>
          ) : (
            <section className="bo-card" aria-labelledby="remboursement-adresse">
              <h2 id="remboursement-adresse">Adresse de remboursement</h2>
              <p className="bo-hint">Adresse Bitcoin où vous renvoyer des fonds si nous devons vous rembourser.</p>
              <RefundAddressEditor orderId={order.id} current={order.refundAddress} editable={actions.canEditRefundAddress} />
            </section>
          )}
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

function cancelHeading(reason: string | null, batchCancelled: boolean): string {
  if (reason === "batch_closed") return batchCancelled ? "Lot annulé" : "Facture annulée : lot fermé aux commandes";
  return reason === "admin" ? "Facture annulée par la boutique" : "Facture annulée";
}

function cancelMessage(reason: string | null, batchCancelled: boolean, statusLabel: string): ReactNode {
  if (reason === "batch_closed") {
    if (batchCancelled) return "Ce lot a été annulé : votre facture est annulée et les machines sont libérées.";
    return (
      <>
        Ce lot n&apos;accepte plus de commande (statut « {statusLabel} ») : les factures restées sans paiement ont été
        annulées et leurs machines libérées.
      </>
    );
  }
  if (reason === "admin") return "Notre équipe a annulé cette facture et libéré les machines réservées.";
  if (reason === "user") return "Vous avez annulé cette facture : les machines réservées sont libérées.";
  return "Les machines réservées sont libérées.";
}
