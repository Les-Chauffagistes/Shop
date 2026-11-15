import type { Metadata } from "next";
import Link from "next/link";
import { getModel, listModels } from "@/server/catalog";
import { ApiError } from "@/server/errors";
import { BatchForm } from "@/components/backoffice/batches/BatchForm";
import { backofficeAccess } from "../../_lib/access";
import { isUuid } from "@/app/_lib/load";

export const metadata: Metadata = { title: "Nouveau lot" };

/** `?type=stock` : lot de stock du modèle (un par modèle) ; sinon une palette. `?modele=` présélectionne le modèle. */
export default async function NewBatchPage({ searchParams }: PageProps<"/backoffice/lots/nouveau">) {
  const sp = await searchParams;
  const stock = sp.type === "stock";
  const preselected = typeof sp.modele === "string" && isUuid(sp.modele) ? sp.modele : undefined;
  const query = new URLSearchParams({ ...(stock ? { type: "stock" } : {}), ...(preselected ? { modele: preselected } : {}) }).toString();
  const path = `/backoffice/lots/nouveau${query ? `?${query}` : ""}`;
  await backofficeAccess(path);

  const { items: models } = await listModels();
  // Modèle inconnu : formulaire sans présélection ; toute autre erreur (base injoignable) n'est pas avalée
  const initialModel = preselected
    ? await getModel(preselected).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      })
    : null;

  return (
    <>
      <div className="bo-page-head">
        <div>
          <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
            <Link href="/backoffice/lots">Lots</Link>
          </nav>
          <h1>{stock ? "Nouveau lot de stock" : "Nouveau lot"}</h1>
          <p>
            {stock
              ? "Un seul lot de stock par modèle : il vend les machines en main et contrôlées, alimenté par des réassorts et les invendus des palettes."
              : "Le lot est créé en brouillon : vous pourrez le relire avant de le publier."}
          </p>
        </div>
      </div>
      {models.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucun modèle de mineur</h2>
          <p>Un lot porte sur un modèle : enregistrez-le d&apos;abord.</p>
          <Link className="bo-btn bo-btn-primary" href="/backoffice/modeles/nouveau?retour=lot">
            Créer un modèle
          </Link>
        </div>
      ) : (
        <section className="bo-card" aria-label="Informations du lot">
          <BatchForm models={models} initialModel={initialModel} kind={stock ? "stock" : "wholesale"} />
        </section>
      )}
    </>
  );
}
