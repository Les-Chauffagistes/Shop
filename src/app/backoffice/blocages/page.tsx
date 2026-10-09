import type { Metadata } from "next";
import Link from "next/link";
import { listOrderBlocks } from "@/server/backoffice-orders";
import { isUuid } from "@/app/_lib/load";
import { BlocksGrid } from "@/components/backoffice/orders/BlocksGrid";
import { backofficeAccess } from "../_lib/access";

export const metadata: Metadata = { title: "Blocages" };

/** Utilisateurs bloqués sur un lot après trop de factures abandonnées (`?lot=` : un seul lot). */
export default async function BlocksPage({ searchParams }: PageProps<"/backoffice/blocages">) {
  const { lot } = await searchParams;
  const batchId = typeof lot === "string" && isUuid(lot) ? lot : undefined;
  await backofficeAccess(batchId ? `/backoffice/blocages?lot=${batchId}` : "/backoffice/blocages");
  const { items } = await listOrderBlocks({ batchId });
  return (
    <>
      <div className="bo-page-head">
        <div>
          <h1>Blocages</h1>
          <p>
            Après plusieurs factures abandonnées sur un lot, un utilisateur ne peut plus y commander. Contactez-le, puis levez
            le blocage si besoin.
          </p>
        </div>
      </div>
      {batchId && (
        <p style={{ marginBottom: 12 }}>
          Lot filtré · <Link href="/backoffice/blocages">Voir tous les lots</Link>
        </p>
      )}
      <BlocksGrid items={items} />
    </>
  );
}
