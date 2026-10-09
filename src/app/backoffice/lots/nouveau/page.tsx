import type { Metadata } from "next";
import Link from "next/link";
import { getModel, listModels } from "@/server/catalog";
import { ApiError } from "@/server/errors";
import { BatchForm } from "@/components/backoffice/batches/BatchForm";
import { backofficeAccess } from "../../_lib/access";
import { isUuid } from "@/app/_lib/load";

export const metadata: Metadata = { title: "Nouveau lot" };

export default async function NewBatchPage({ searchParams }: PageProps<"/backoffice/lots/nouveau">) {
  const modele = (await searchParams).modele;
  const preselected = typeof modele === "string" && isUuid(modele) ? modele : undefined;
  const path = `/backoffice/lots/nouveau${preselected ? `?modele=${preselected}` : ""}`;
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
          <h1>Nouveau lot</h1>
          <p>Le lot est créé en brouillon : vous pourrez le relire avant de le publier.</p>
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
          <BatchForm models={models} initialModel={initialModel} />
        </section>
      )}
    </>
  );
}
