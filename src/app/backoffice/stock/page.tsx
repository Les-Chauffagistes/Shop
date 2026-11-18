import type { Metadata } from "next";
import Link from "next/link";
import { listModelStock } from "@/server/machines";
import { ModelStockGrid } from "@/components/backoffice/stock/ModelStockGrid";
import { backofficeAccess } from "../_lib/access";

export const metadata: Metadata = { title: "Stock" };

const PATH = "/backoffice/stock";

/** Stock de machines par modèle : lot de stock, machines à recevoir, à contrôler, disponibles, à expédier. */
export default async function StockPage() {
  await backofficeAccess(PATH);
  const { items } = await listModelStock();
  return (
    <>
      <div className="bo-page-head">
        <div>
          <h1>Stock</h1>
          <p>Machines en main par modèle, vendues à l&apos;unité depuis le lot de stock de chaque modèle.</p>
        </div>
        <div className="bo-actions">
          <Link className="bo-btn bo-btn-secondary" href="/backoffice/lots/nouveau?type=stock">
            Créer un lot de stock
          </Link>
          <Link className="bo-btn bo-btn-primary" href="/backoffice/vente">
            Vente manuelle
          </Link>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucune machine en stock</h2>
          <p>
            Le stock d&apos;un modèle naît avec son lot de stock : créez-le, puis enregistrez un réassort. Les invendus
            d&apos;une palette y partent aussi à sa clôture.
          </p>
          <Link className="bo-btn bo-btn-primary" href="/backoffice/lots/nouveau?type=stock">
            Créer un lot de stock
          </Link>
        </div>
      ) : (
        <ModelStockGrid items={items} />
      )}
    </>
  );
}
