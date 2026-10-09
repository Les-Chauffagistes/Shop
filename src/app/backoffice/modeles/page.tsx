import type { Metadata } from "next";
import Link from "next/link";
import { listModels } from "@/server/catalog";
import { ModelsGrid } from "@/components/backoffice/models/ModelsGrid";
import { backofficeAccess } from "../_lib/access";

export const metadata: Metadata = { title: "Modèles" };

const PATH = "/backoffice/modeles";

export default async function ModelsPage() {
  await backofficeAccess(PATH);
  const { items } = await listModels();
  return (
    <>
      <div className="bo-page-head">
        <div>
          <h1>Modèles</h1>
          <p>Les modèles de mineurs et leurs menus d&apos;options d&apos;achat.</p>
        </div>
        <Link className="bo-btn bo-btn-primary" href="/backoffice/modeles/nouveau">
          Nouveau modèle
        </Link>
      </div>
      {items.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucun modèle</h2>
          <p>Un modèle de mineur est nécessaire avant de créer un lot.</p>
          <Link className="bo-btn bo-btn-primary" href="/backoffice/modeles/nouveau">
            Créer un modèle
          </Link>
        </div>
      ) : (
        <ModelsGrid models={items} />
      )}
    </>
  );
}
