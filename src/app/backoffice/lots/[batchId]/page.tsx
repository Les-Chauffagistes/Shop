import type { Metadata } from "next";
import Link from "next/link";
import type { BatchStatus } from "../../../../../prisma/generated/enums";
import { BATCH_STATUS_LABELS } from "@/server/batch-status";
import { getBatch, type BatchDetail } from "@/server/batches";
import { listBatchOrders } from "@/server/backoffice-orders";
import { listModels, listParts } from "@/server/catalog";
import { getBatchMachines } from "@/server/machines";
import { getBatchPartNeeds } from "@/server/part-stock";
import { getPublicBatch } from "@/server/shop";
import { BatchOrdersGrid } from "@/components/backoffice/orders/OrderGrids";
import { BatchCounters } from "@/components/backoffice/batches/BatchCounters";
import { BatchSettings } from "@/components/backoffice/batches/BatchSettings";
import { RestockPanel } from "@/components/backoffice/batches/RestockPanel";
import { StatusHistory } from "@/components/backoffice/batches/StatusHistory";
import { TransferHistory } from "@/components/backoffice/batches/TransferHistory";
import { TransitionPanel } from "@/components/backoffice/batches/TransitionPanel";
import { UnsavedChangesProvider } from "@/components/backoffice/batches/UnsavedChanges";
import { BatchMachinesPanel } from "@/components/backoffice/machines/BatchMachinesPanel";
import { BatchPartsPanel } from "@/components/backoffice/stock/BatchPartsPanel";
import { StatusBadge } from "@/components/backoffice/StatusBadge";
import { formatDateTime } from "@/lib/dates";
import { plural } from "@/lib/plural";
import { backofficeAccess } from "../../_lib/access";
import { loadOr404 } from "@/app/_lib/load";

export const metadata: Metadata = { title: "Lot" };

/** Chaîne principale des statuts d'une palette, pour la barre de progression. */
const CHAIN: BatchStatus[] = [
  "draft",
  "survey",
  "preorder",
  "ordering",
  "awaiting_reception",
  "inspection",
  "tuning",
  "packaging",
  "in_transit",
  "closed",
];

function Progress({ batch }: { batch: BatchDetail }) {
  if (batch.kind === "stock") return null;
  const last = batch.history.at(-1);
  if (batch.status === "cancelled") {
    return (
      <div className="bo-alert bo-alert-error" style={{ marginBottom: 24 }}>
        Ce lot est annulé{last?.note ? <> : « {last.note} »</> : "."}
      </div>
    );
  }
  const current = CHAIN.indexOf(batch.status);
  return (
    <ol className="bo-steps" aria-label="Progression du lot" style={{ marginBottom: 28 }}>
      {CHAIN.map((s, i) => (
        <li key={s} data-state={stepState(i, current)} aria-current={i === current ? "step" : undefined}>
          {BATCH_STATUS_LABELS[s]}
        </li>
      ))}
    </ol>
  );
}

/** Onglet « Lot » : compteurs, réassort (lot de stock), transferts, réglages, produits d'options, factures, journal. */
async function LotTab({ batch }: { batch: BatchDetail }) {
  const [{ items: models }, { items: parts }, needs, { items: orders }] = await Promise.all([
    listModels(),
    listParts(),
    getBatchPartNeeds(batch.id),
    listBatchOrders(batch.id),
  ]);
  const stock = batch.kind === "stock";
  return (
    <div className="bo-stack">
      <BatchCounters batch={batch} />
      {stock && <RestockPanel batchId={batch.id} restocks={batch.restocks} />}
      <TransferHistory
        title={stock ? "Machines reçues des palettes" : "Machines transférées au stock"}
        transfers={batch.transfers.filter((t) => (stock ? t.to.id : t.from.id) === batch.id)}
      />
      <section className="bo-card" aria-labelledby="settings">
        <div className="bo-card-head">
          <h2 id="settings">Réglages du lot</h2>
        </div>
        <BatchSettings batch={batch} models={models} />
      </section>
      <BatchPartsPanel
        batchId={batch.id}
        finished={batch.status === "closed" || batch.status === "cancelled"}
        survey={batch.status === "survey"}
        needs={needs}
        parts={parts}
      />
      <section aria-labelledby="factures-titre" id="factures">
        <h2 id="factures-titre" style={{ marginBottom: 12 }}>
          Factures du lot
        </h2>
        {orders.length === 0 ? (
          <div className="bo-card bo-empty">
            <p>Aucune facture sur ce lot pour l&apos;instant.</p>
          </div>
        ) : (
          <BatchOrdersGrid items={orders} />
        )}
      </section>
      <StatusHistory batch={batch} />
    </div>
  );
}

export default async function BatchPage({ params, searchParams }: PageProps<"/backoffice/lots/[batchId]">) {
  const { batchId } = await params;
  const sp = await searchParams;
  const tab = sp.onglet === "machines" ? "machines" : "lot";
  const base = `/backoffice/lots/${encodeURIComponent(batchId)}`;
  await backofficeAccess(tab === "machines" ? `${base}?onglet=machines` : base);
  const batch = await loadOr404(batchId, (id) => getBatch(id));
  const [machines, sellable] = await Promise.all([
    tab === "machines" ? getBatchMachines(batch.id) : null,
    // Vente manuelle proposée quand le lot accepte des commandes (règle de la base, lue par la fiche publique)
    getPublicBatch(batch.id).then(
      (b) => b.acceptsOrders,
      () => false,
    ),
  ]);
  const last = batch.history.at(-1);

  return (
    <>
      <div className="bo-page-head">
        <div>
          <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
            <Link href="/backoffice/lots">Lots</Link>
            {batch.kind === "stock" && (
              <>
                {" › "}
                <Link href="/backoffice/stock">Stock</Link>
              </>
            )}
          </nav>
          <h1 style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            {batch.name} <StatusBadge status={batch.status} label={batch.statusLabel} />
          </h1>
          <p>
            {batch.kindLabel} · <Link href={`/backoffice/modeles/${batch.model.id}`}>{batch.model.name}</Link>
            {batch.quantity !== null && <> · {plural(batch.quantity, "machine", "machines")}</>}
            {last && <> · dernier changement le {formatDateTime(last.createdAt)}</>}
          </p>
        </div>
        {sellable && (
          <Link className="bo-btn bo-btn-secondary" href={`/backoffice/vente?lot=${batch.id}`}>
            Vente manuelle
          </Link>
        )}
      </div>
      {sp.existant === "1" && (
        <p className="bo-alert bo-alert-info" role="status" style={{ marginBottom: 20 }}>
          Ce modèle a déjà son lot de stock (un seul par modèle) : le voici.
        </p>
      )}

      <Progress batch={batch} />

      <nav className="bo-chips" aria-label="Onglets du lot" style={{ marginBottom: 20 }}>
        <Link className="bo-chip" href={base} aria-current={tab === "lot" ? "page" : undefined}>
          Lot
        </Link>
        <Link className="bo-chip" href={`${base}?onglet=machines`} aria-current={tab === "machines" ? "page" : undefined}>
          Machines
          {(batch.counters.expectedMachines > 0 || batch.counters.toCheckMachines > 0) && (
            <span className="bo-count">
              {batch.counters.expectedMachines + batch.counters.toCheckMachines} à traiter
            </span>
          )}
        </Link>
      </nav>

      <UnsavedChangesProvider>
        <div className="bo-grid-2">
          {machines ? (
            <BatchMachinesPanel batch={{ id: batch.id, kind: batch.kind, toCheck: batch.counters.toCheckMachines }} data={machines} />
          ) : (
            <LotTab batch={batch} />
          )}
          <aside style={{ position: "sticky", top: 72 }} aria-label="Actions du lot">
            <TransitionPanel key={`${batch.status}-${batch.updatedAt}`} batch={batch} />
          </aside>
        </div>
      </UnsavedChangesProvider>
    </>
  );
}

function stepState(i: number, current: number): "done" | "current" | "todo" {
  if (i < current) return "done";
  return i === current ? "current" : "todo";
}
