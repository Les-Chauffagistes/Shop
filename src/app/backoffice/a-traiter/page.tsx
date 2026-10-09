import type { Metadata } from "next";
import Link from "next/link";
import { listAttentionOrders } from "@/server/backoffice-orders";
import { AttentionGrid } from "@/components/backoffice/orders/OrderGrids";
import { backofficeAccess } from "../_lib/access";

export const metadata: Metadata = { title: "À traiter" };

/** Factures qui attendent une décision de l'admin, les plus anciennes d'abord. */
export default async function AttentionPage() {
  await backofficeAccess("/backoffice/a-traiter");
  const { items } = await listAttentionOrders();
  return (
    <>
      <div className="bo-page-head">
        <div>
          <h1>À traiter</h1>
          <p>Paiements arrivés hors du parcours normal, choix attendus et remboursements sans adresse, les plus anciens d&apos;abord.</p>
        </div>
        <Link className="bo-btn bo-btn-secondary" href="/backoffice/remboursements">
          Remboursements à envoyer
        </Link>
      </div>
      {items.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Rien à traiter</h2>
          <p>Toutes les factures suivent leur cours. Les cas qui demandent une décision apparaîtront ici.</p>
        </div>
      ) : (
        <>
          <p className="bo-muted" style={{ marginBottom: 12 }} role="status">
            {items.length} facture{items.length > 1 ? "s" : ""} à traiter · Entrée ou clic pour ouvrir
          </p>
          <AttentionGrid items={items} />
        </>
      )}
    </>
  );
}
