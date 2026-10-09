import type { Metadata } from "next";
import Link from "next/link";
import { listBatches } from "@/server/batches";
import { getModel, listParts } from "@/server/catalog";
import { ModelForm } from "@/components/backoffice/models/ModelForm";
import { OptionsEditor } from "@/components/backoffice/models/OptionsEditor";
import { formatHashrate } from "@/lib/decimal";
import { backofficeAccess } from "../../_lib/access";
import { loadOr404 } from "@/app/_lib/load";

export const metadata: Metadata = { title: "Modèle" };

export default async function ModelPage({ params, searchParams }: PageProps<"/backoffice/modeles/[modelId]">) {
  const { modelId } = await params;
  const fromBatch = (await searchParams).retour === "lot";
  const path = `/backoffice/modeles/${encodeURIComponent(modelId)}`;
  await backofficeAccess(path);
  const [model, { items: parts }] = await Promise.all([loadOr404(modelId, (id) => getModel(id)), listParts()]);
  // Lots qui bloquent la suppression, pour les nommer dans la confirmation
  const used =
    model.batchCount > 0 ? await listBatches({ status: [], modelId: model.id, page: 1, pageSize: 10 }) : null;
  const usage = used ? { batches: used.items.map((b) => ({ id: b.id, name: b.name })), total: used.total } : undefined;

  return (
    <>
      <div className="bo-page-head">
        <div>
          <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
            <Link href="/backoffice/modeles">Modèles</Link>
          </nav>
          <h1>{model.name}</h1>
          <p>
            {formatHashrate(model.hashrate)} · {model.hashboardQtt} hashboard{model.hashboardQtt > 1 ? "s" : ""} ·{" "}
            {model.batchCount} lot{model.batchCount > 1 ? "s" : ""}
          </p>
        </div>
        <Link className="bo-btn bo-btn-secondary" href={`/backoffice/lots/nouveau?modele=${model.id}`}>
          Créer un lot de ce modèle
        </Link>
      </div>
      {fromBatch && (
        <div className="bo-alert bo-alert-success" role="status" style={{ marginBottom: 20 }}>
          Modèle créé. Ajoutez ses menus d&apos;options si besoin, puis{" "}
          <Link href={`/backoffice/lots/nouveau?modele=${model.id}`}>reprenez la création du lot</Link>.
        </div>
      )}
      <div className="bo-stack">
        <section className="bo-card" aria-labelledby="model-title">
          <h2 id="model-title" style={{ marginBottom: 16 }}>
            Caractéristiques
          </h2>
          <ModelForm key={`${model.name}-${model.hashrate}-${model.hashboardQtt}-${model.description}`} model={model} usage={usage} />
        </section>
        <OptionsEditor model={model} parts={parts} />
      </div>
    </>
  );
}
