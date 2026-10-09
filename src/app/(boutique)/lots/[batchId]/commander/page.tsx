import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getOrderingStatus, listAddresses } from "@/server/orders";
import { getPublicBatch } from "@/server/shop";
import { listWishlists } from "@/server/wishlists";
import { formatCents, formatHashrate } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { machines } from "@/lib/plural";
import { StatusBadge } from "@/components/backoffice/StatusBadge";
import { OrderForm } from "@/components/shop/OrderForm";
import { isFuture } from "@/components/shop/format";
import { loadOr404 } from "../../../../_lib/load";
import { loginTarget, loginUrl } from "../../../../_lib/login";

export const metadata: Metadata = { title: "Commander" };

/** Codes de refus qui portent sur la journée de priorité (le message du serveur l'explique déjà). */
const PRIORITY_CODES = new Set(["order_priority_window", "order_priority_quota"]);

/**
 * Commande d'un lot : machines (reprise des machines souhaitées pendant le sondage ou configuration
 * libre), adresses, adresse de remboursement facultative, puis création de la facture. Ce que dit
 * l'éligibilité (`GET /api/orders/eligibility`) est affiché avant l'envoi, sans rien bloquer : le
 * serveur tranche à la création.
 */
export default async function OrderPage({ params }: PageProps<"/lots/[batchId]/commander">) {
  const { batchId } = await params;
  const path = `/lots/${encodeURIComponent(batchId)}/commander`;
  const user = await getCurrentUser();
  if (!user) redirect(loginUrl(path, "/"));
  const batch = await loadOr404(batchId, getPublicBatch);
  const [eligibility, wishlists, addresses] = await Promise.all([
    getOrderingStatus(user.id, batch.id),
    listWishlists(user.id, { batchId: batch.id }),
    listAddresses(user.id),
  ]);
  const toOrder = new Set(eligibility.wishlistIds);
  const wishlistLines = wishlists.items
    .filter((w) => toOrder.has(w.id))
    .map((w) => ({ id: w.id, items: w.items }));
  const refusal = eligibility.refusal;
  const priorityRunning = eligibility.priorityMachinesLeft !== null && isFuture(eligibility.priorityEndsAt);

  return (
    <>
      <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
        <Link href="/">Lots</Link> › <Link href={`/lots/${batch.id}`}>{batch.model.name}</Link>
      </nav>
      <div className="shop-page-head">
        <p className="shop-eyebrow">
          <StatusBadge status={batch.status} />
          <span className="shop-lot-name">{batch.name}</span>
        </p>
        <h1>Commander</h1>
        <p>
          {batch.model.name} · {formatHashrate(batch.model.hashrate)} · {formatCents(batch.resaleUnitPrice)} la machine,
          hors options · {machines(eligibility.availableQuantity)} disponible{eligibility.availableQuantity > 1 ? "s" : ""}
        </p>
      </div>

      <div className="shop-order-notices">
        {refusal && (
          <div className="bo-alert bo-alert-warning" role="note">
            <strong>{refusal.message}</strong>
            {refusal.code === "order_already_pending" && eligibility.pendingOrderId && (
              <div className="bo-actions" style={{ marginTop: 8 }}>
                <Link className="bo-btn bo-btn-secondary bo-btn-sm" href={`/mes-commandes/${eligibility.pendingOrderId}`}>
                  Voir ma facture en attente
                </Link>
              </div>
            )}
            {refusal.code === "batch_not_open" && batch.status === "survey" && (
              <div className="bo-actions" style={{ marginTop: 8 }}>
                <Link className="bo-btn bo-btn-secondary bo-btn-sm" href={`/lots/${batch.id}`}>
                  Manifester mon intérêt
                </Link>
              </div>
            )}
          </div>
        )}
        {priorityRunning && !(refusal && PRIORITY_CODES.has(refusal.code)) && (
          <div className="bo-alert bo-alert-info" role="note">
            Journée de priorité jusqu&apos;au {formatDateTime(eligibility.priorityEndsAt!)} : vous pouvez encore prendre{" "}
            {machines(eligibility.priorityMachinesLeft!)} en priorité sur ce lot, autant que de machines souhaitées pendant
            le sondage.
          </div>
        )}
      </div>

      <OrderForm
        batch={{
          id: batch.id,
          resaleUnitPrice: batch.resaleUnitPrice,
          options: batch.options,
          maxMachinesPerOrder: batch.maxMachinesPerOrder,
        }}
        wishlists={wishlistLines}
        addresses={addresses.items}
        login={loginTarget()}
      />
    </>
  );
}
