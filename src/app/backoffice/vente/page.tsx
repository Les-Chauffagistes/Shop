import type { Metadata } from "next";
import Link from "next/link";
import { DEFAULT_MANUAL_REASON } from "@/server/manual-sales";
import { OFFCHAIN_MEANS_LABELS } from "@/server/order-rules";
import { getPublicBatch, listPublicBatches } from "@/server/shop";
import { ManualSaleForm } from "@/components/backoffice/sales/ManualSaleForm";
import type { Means } from "@/components/backoffice/sales/sale-request";
import type { SaleBatch } from "@/components/backoffice/sales/SaleMachines";
import { backofficeAccess } from "../_lib/access";

export const metadata: Metadata = { title: "Vente manuelle" };

/**
 * Lots où l'on peut vendre maintenant (ils acceptent des commandes : palette de la Précommande au Packaging, lot de
 * stock en vente), lots de stock d'abord, avec leurs options. Un lot fermé entre les deux lectures est ignoré.
 */
async function openBatches(): Promise<SaleBatch[]> {
  const { items } = await listPublicBatches();
  const batches = await Promise.all(items.filter((b) => b.acceptsOrders).map((b) => getPublicBatch(b.id).catch(() => null)));
  return batches
    .filter((b): b is SaleBatch => b !== null && b.acceptsOrders)
    .sort((a, b) => Number(b.kind === "stock") - Number(a.kind === "stock") || a.name.localeCompare(b.name, "fr"));
}

/**
 * Vente manuelle : une vente conclue hors de la boutique (comptoir, téléphone), payée hors chaîne. `?lot=` présélectionne
 * le lot (bouton depuis l'écran Stock ou la fiche d'un lot) ; un seul lot ouvert est choisi d'office.
 */
export default async function ManualSalePage({ searchParams }: PageProps<"/backoffice/vente">) {
  const sp = await searchParams;
  const lot = typeof sp.lot === "string" ? sp.lot : null;
  await backofficeAccess(lot ? `/backoffice/vente?lot=${encodeURIComponent(lot)}` : "/backoffice/vente");
  const batches = await openBatches();
  const asked = lot !== null && batches.some((b) => b.id === lot) ? lot : null;
  const initialBatchId = asked ?? (batches.length === 1 ? batches[0].id : null);
  const means = Object.entries(OFFCHAIN_MEANS_LABELS) as [Means, string][];

  return (
    <>
      <div className="bo-page-head">
        <div>
          <h1>Vente manuelle</h1>
          <p>Vente conclue au comptoir ou par téléphone, payée en espèces, par virement ou autrement. La facture naît payée.</p>
        </div>
      </div>
      {lot !== null && asked === null && batches.length > 0 && (
        <p className="bo-alert bo-alert-warning" role="status" style={{ marginBottom: 20 }}>
          Ce lot n&apos;accepte pas de vente pour le moment : choisissez-en un autre.
        </p>
      )}
      {batches.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucun lot ouvert à la vente</h2>
          <p>
            Une vente se fait sur un lot de stock en vente, ou sur une palette de la Précommande au Packaging. Mettez un lot
            de stock en vente depuis l&apos;écran Stock.
          </p>
          <Link className="bo-btn bo-btn-primary" href="/backoffice/stock">
            Voir le stock
          </Link>
        </div>
      ) : (
        <div style={{ maxWidth: 820 }}>
          <ManualSaleForm batches={batches} initialBatchId={initialBatchId} means={means} defaultReason={DEFAULT_MANUAL_REASON} />
        </div>
      )}
    </>
  );
}
