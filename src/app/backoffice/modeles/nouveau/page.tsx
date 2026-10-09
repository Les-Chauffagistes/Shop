import type { Metadata } from "next";
import Link from "next/link";
import { ModelForm } from "@/components/backoffice/models/ModelForm";
import { backofficeAccess } from "../../_lib/access";

export const metadata: Metadata = { title: "Nouveau modèle" };

export default async function NewModelPage({ searchParams }: PageProps<"/backoffice/modeles/nouveau">) {
  const fromBatch = (await searchParams).retour === "lot";
  const path = `/backoffice/modeles/nouveau${fromBatch ? "?retour=lot" : ""}`;
  await backofficeAccess(path);
  return (
    <>
      <div className="bo-page-head">
        <div>
          <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
            {fromBatch ? <Link href="/backoffice/lots/nouveau">Nouveau lot</Link> : <Link href="/backoffice/modeles">Modèles</Link>}
          </nav>
          <h1>Nouveau modèle</h1>
          <p>Les menus d&apos;options se configurent à l&apos;étape suivante.</p>
        </div>
      </div>
      <section className="bo-card" aria-label="Caractéristiques du modèle">
        <ModelForm returnTo={fromBatch ? "lot" : undefined} />
      </section>
    </>
  );
}
