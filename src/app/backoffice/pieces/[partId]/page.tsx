import type { Metadata } from "next";
import Link from "next/link";
import { listMovements } from "@/server/part-stock";
import { PartStockJournal } from "@/components/backoffice/stock/PartStockJournal";
import { isShort, PressureBadge, shortfallSentence } from "@/components/backoffice/stock/pressure";
import { backofficeAccess } from "../../_lib/access";
import { loadOr404 } from "@/app/_lib/load";

export const metadata: Metadata = { title: "Stock d'un produit" };

/** Stock commun d'un produit d'option : chiffres, pression, saisie d'un mouvement et journal. */
export default async function PartStockPage({ params }: PageProps<"/backoffice/pieces/[partId]">) {
  const { partId } = await params;
  const path = `/backoffice/pieces/${encodeURIComponent(partId)}`;
  await backofficeAccess(path);
  const { stock, items } = await loadOr404(partId, (id) => listMovements(id));

  return (
    <>
      <div className="bo-page-head">
        <div>
          <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
            <Link href="/backoffice/pieces">Produits d&apos;options</Link>
          </nav>
          <h1>{stock.name}</h1>
          <p>{stock.reference ? `Référence ${stock.reference} · ` : ""}stock commun à tous les lots</p>
        </div>
      </div>

      {isShort(stock) && (
        <div className="bo-alert bo-alert-warning bo-shortages" role="note">
          <strong>Stock insuffisant :</strong> {shortfallSentence(stock)}
        </div>
      )}

      <section aria-labelledby="stock-figures" style={{ marginBottom: 24 }}>
        <h2 id="stock-figures" className="bo-visually-hidden">
          Chiffres du stock
        </h2>
        <dl className="bo-stats">
          <div className="bo-stat">
            <dt>En stock</dt>
            <dd>{stock.onHand}</dd>
          </div>
          <div className="bo-stat">
            <dt>Commandés · en route</dt>
            <dd>
              {stock.orderingQty} <small>· {stock.awaitingDeliveryQty}</small>
            </dd>
          </div>
          <div className="bo-stat">
            <dt>Demande ferme</dt>
            <dd>{stock.firmDemand}</dd>
          </div>
          <div className="bo-stat">
            <dt>Pression</dt>
            <dd style={{ fontSize: 16, paddingTop: 8 }}>
              <PressureBadge stock={stock} />
            </dd>
          </div>
          <div className="bo-stat">
            <dt>À commander</dt>
            <dd>{stock.toOrder}</dd>
          </div>
          <div className="bo-stat">
            <dt>Demande potentielle</dt>
            <dd>
              {stock.potentialDemand} <small>sondages</small>
            </dd>
          </div>
        </dl>
        <p className="bo-hint" style={{ marginTop: 10 }}>
          Demande ferme : machines payées et factures en attente non expirées des lots qui n&apos;ont pas encore monté leurs
          kits. La demande potentielle (manifestations d&apos;intérêt des lots au sondage) est affichée à part, hors pression.
        </p>
      </section>

      <PartStockJournal partId={stock.partId} partName={stock.name} onHand={stock.onHand} movements={items} />
    </>
  );
}
