import type { Metadata } from "next";
import Link from "next/link";
import type { BatchStatus } from "../../../../../prisma/generated/enums";
import { BATCH_STATUS_LABELS } from "@/server/batch-status";
import { getBatch } from "@/server/batches";
import { listBatchOrders } from "@/server/backoffice-orders";
import { BatchOrdersGrid } from "@/components/backoffice/orders/OrderGrids";
import { listModels, listParts } from "@/server/catalog";
import { getBatchPartNeeds } from "@/server/part-stock";
import { BatchSettings } from "@/components/backoffice/batches/BatchSettings";
import { TransitionPanel } from "@/components/backoffice/batches/TransitionPanel";
import { UnsavedChangesProvider } from "@/components/backoffice/batches/UnsavedChanges";
import { BatchPartsPanel } from "@/components/backoffice/stock/BatchPartsPanel";
import { StatusBadge } from "@/components/backoffice/StatusBadge";
import { formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { backofficeAccess } from "../../_lib/access";
import { loadOr404 } from "@/app/_lib/load";
import { plural } from "@/lib/plural";

export const metadata: Metadata = { title: "Lot" };

/** Chaîne principale des statuts, pour la barre de progression. */
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

export default async function BatchPage({ params }: PageProps<"/backoffice/lots/[batchId]">) {
  const { batchId } = await params;
  const path = `/backoffice/lots/${encodeURIComponent(batchId)}`;
  await backofficeAccess(path);
  const batch = await loadOr404(batchId, (id) => getBatch(id));
  const [{ items: models }, { items: parts }, needs, { items: orders }] = await Promise.all([
    listModels(),
    listParts(),
    getBatchPartNeeds(batch.id),
    listBatchOrders(batch.id),
  ]);

  const c = batch.counters;
  const current = CHAIN.indexOf(batch.status);
  const last = batch.history.at(-1);

  return (
    <>
      <div className="bo-page-head">
        <div>
          <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
            <Link href="/backoffice/lots">Lots</Link>
          </nav>
          <h1 style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            {batch.name} <StatusBadge status={batch.status} />
          </h1>
          <p>
            <Link href={`/backoffice/modeles/${batch.model.id}`}>{batch.model.name}</Link> ·{" "}
            {plural(batch.quantity, "machine", "machines")}
            {last && <> · dernier changement le {formatDateTime(last.createdAt)}</>}
          </p>
        </div>
      </div>

      {batch.status === "cancelled" ? (
        <div className="bo-alert bo-alert-error" style={{ marginBottom: 24 }}>
          Ce lot est annulé{last?.note ? <> : « {last.note} »</> : "."}
        </div>
      ) : (
        <ol className="bo-steps" aria-label="Progression du lot" style={{ marginBottom: 28 }}>
          {CHAIN.map((s, i) => (
            <li
              key={s}
              data-state={i < current ? "done" : i === current ? "current" : "todo"}
              aria-current={i === current ? "step" : undefined}
            >
              {BATCH_STATUS_LABELS[s]}
            </li>
          ))}
        </ol>
      )}

      <UnsavedChangesProvider>
        <div className="bo-grid-2">
          <div className="bo-stack">
            <section aria-labelledby="counters">
              <h2 id="counters" className="bo-visually-hidden">
                Compteurs
              </h2>
              <dl className="bo-stats">
                <div className="bo-stat">
                  <dt>Stock disponible</dt>
                  <dd>
                    {c.availableStock} <small>/ {batch.quantity}</small>
                  </dd>
                </div>
                <div className="bo-stat">
                  <dt>Machines payées</dt>
                  <dd>
                    {c.paidMachines} <small>{plural(c.paidOrders, "commande", "commandes")}</small>
                  </dd>
                </div>
                <div className="bo-stat">
                  <dt>Réservées (30 min)</dt>
                  <dd>
                    {c.pendingMachines} <small>{plural(c.pendingOrders, "facture", "factures")}</small>
                  </dd>
                </div>
                <div className="bo-stat">
                  <dt>Intéressés</dt>
                  <dd>
                    {c.interestedUsers} <small>{plural(c.interestedMachines, "machine", "machines")}</small>
                  </dd>
                </div>
              </dl>
              {(c.attentionOrders > 0 || c.blockedUsers > 0 || batch.priorityEndsAt) && (
                <p className="bo-alert bo-alert-info" style={{ marginTop: 12 }}>
                  {c.attentionOrders > 0 && (
                    <>
                      <a href="#factures" className="bo-cell-attention">
                        {plural(c.attentionOrders, "facture à traiter", "factures à traiter")}
                      </a>
                      {" · "}
                    </>
                  )}
                  {c.blockedUsers > 0 && (
                    <>
                      <Link href={`/backoffice/blocages?lot=${batch.id}`}>
                        {plural(c.blockedUsers, "utilisateur bloqué", "utilisateurs bloqués")}
                      </Link>
                      {" · "}
                    </>
                  )}
                  {batch.priorityEndsAt
                    ? `Journée de priorité jusqu'au ${formatDateTime(batch.priorityEndsAt)}`
                    : "Pas de journée de priorité"}
                </p>
              )}
              <p className="bo-hint" style={{ marginTop: 10 }}>
                Prix d&apos;achat {formatCents(batch.purchasePrice)} · revente{" "}
                {batch.resaleUnitPrice ? `${formatCents(batch.resaleUnitPrice)} l'unité` : "non définie"}
              </p>
            </section>

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

            <section className="bo-card" aria-labelledby="history">
              <h2 id="history" style={{ marginBottom: 16 }}>
                Historique
              </h2>
              <ol className="bo-history" reversed>
                {[...batch.history].reverse().map((h) => (
                  <li key={h.id}>
                    <span>
                      {h.from ? (
                        <>
                          {BATCH_STATUS_LABELS[h.from]} → <strong>{BATCH_STATUS_LABELS[h.to]}</strong>
                        </>
                      ) : (
                        <>
                          Création en <strong>{BATCH_STATUS_LABELS[h.to]}</strong>
                        </>
                      )}
                    </span>
                    {h.note && <q>{h.note}</q>}
                    <span className="bo-by">
                      <time dateTime={h.createdAt}>{formatDateTime(h.createdAt)}</time> · admin n° {h.changedBy}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <aside style={{ position: "sticky", top: 72 }} aria-label="Actions du lot">
            <TransitionPanel key={`${batch.status}-${batch.updatedAt}`} batch={batch} />
          </aside>
        </div>
      </UnsavedChangesProvider>
    </>
  );
}
