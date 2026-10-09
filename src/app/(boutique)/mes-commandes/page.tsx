import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { listOrders } from "@/server/orders";
import { formatCents } from "@/lib/decimal";
import { formatDateTime, formatTime } from "@/lib/dates";
import { machines } from "@/lib/plural";
import { OrderStatusBadge } from "@/components/backoffice/OrderStatusBadge";
import { LinkPending } from "@/components/shop/LinkPending";
import { loginUrl, pagePath } from "../../_lib/login";

export const metadata: Metadata = { title: "Mes commandes" };

type Order = Awaited<ReturnType<typeof listOrders>>["items"][number];

/** Ce que la commande attend de l'utilisateur, d'après les drapeaux de l'API. */
function nextStep(o: Order): string | null {
  if (o.awaitingUserDecision) return "Votre choix est attendu : compléter le paiement ou être remboursé.";
  if (o.status === "pending_payment") {
    if (!o.batch.acceptsOrders) return "Ce lot n'accepte plus de commande : n'envoyez rien de plus.";
    return o.actions.awaitingTopUp
      ? `Paiement incomplet : envoyez le reste avant ${formatTime(o.expiresAt)}.`
      : `À payer avant ${formatTime(o.expiresAt)}.`;
  }
  if (o.payment.underReviewSats !== "0") return "Votre versement est traité par notre équipe, qui vous contactera.";
  if (o.refunds.some((r) => r.sentAt === null)) return "Remboursement en préparation.";
  return null;
}

/** Factures de l'utilisateur, de la plus récente à la plus ancienne (toutes, annulées et remboursées comprises). */
export default async function MyOrdersPage({ searchParams }: PageProps<"/mes-commandes">) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(loginUrl(pagePath("/mes-commandes", sp), "/mes-commandes"));
  const { items } = await listOrders(user.id, {});

  return (
    <>
      <div className="shop-page-head">
        <h1>Mes commandes</h1>
        <p>Vos factures, leur paiement et le suivi de vos machines.</p>
      </div>
      {items.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucune commande pour l&apos;instant</h2>
          <p>Quand un lot ouvre ses précommandes, vous pouvez commander depuis sa fiche.</p>
          <Link className="bo-btn bo-btn-primary" href="/">
            Voir les lots disponibles
          </Link>
        </div>
      ) : (
        <ul className="shop-orders">
          {items.map((o) => {
            const step = nextStep(o);
            return (
              <li key={o.id} className="shop-order-card" data-attention={step && o.status !== "paid" ? "true" : undefined}>
                <div className="shop-order-card-main">
                  <p className="shop-eyebrow">
                    <OrderStatusBadge status={o.status} label={o.statusLabel} />
                    <span className="shop-lot-name">
                      {o.kindLabel} du {formatDateTime(o.createdAt)}
                    </span>
                  </p>
                  <h2>
                    <Link href={`/mes-commandes/${o.id}`} className="shop-card-link">
                      {o.batch.name}
                      <LinkPending />
                    </Link>
                  </h2>
                  <p className="bo-muted">
                    {o.batch.model.name} · {machines(o.lines.length)} · lot au statut « {o.batch.statusLabel} »
                  </p>
                  {step && <p className="shop-order-step">{step}</p>}
                </div>
                <p className="shop-machine-amount bo-num">{formatCents(o.totalAmount)}</p>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
