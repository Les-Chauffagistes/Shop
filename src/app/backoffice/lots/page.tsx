import type { Metadata } from "next";
import Link from "next/link";
import type { BatchKind, BatchStatus } from "../../../../prisma/generated/enums";
import { BATCH_STATUS_LABELS } from "@/server/batch-status";
import { listBatches } from "@/server/batches";
import { listModels } from "@/server/catalog";
import { BatchesGrid } from "@/components/backoffice/batches/BatchesGrid";
import { backofficeAccess } from "../_lib/access";

export const metadata: Metadata = { title: "Lots" };

const PAGE_SIZE = 200;
const DONE: BatchStatus[] = ["closed", "cancelled"];
const ALL = Object.keys(BATCH_STATUS_LABELS) as BatchStatus[];
const ACTIVE = ALL.filter((s) => !DONE.includes(s));

/** Filtres proposés : groupes puis statuts un par un. */
const FILTERS: { key: string; label: string; statuses: BatchStatus[] }[] = [
  { key: "actifs", label: "En cours", statuses: ACTIVE },
  ...ACTIVE.map((s) => ({ key: s, label: BATCH_STATUS_LABELS[s], statuses: [s] })),
  { key: "termines", label: "Terminés", statuses: DONE },
  { key: "tous", label: "Tous", statuses: [] },
];

/** Filtre par type de lot (palette ou lot de stock). */
const KINDS: { key: string; label: string; kind?: BatchKind }[] = [
  { key: "tous", label: "Tous les types" },
  { key: "palettes", label: "Palettes", kind: "wholesale" },
  { key: "stock", label: "Stock", kind: "stock" },
];

export default async function BatchesPage({ searchParams }: PageProps<"/backoffice/lots">) {
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.statut) ?? FILTERS[0];
  const type = KINDS.find((k) => k.key === sp.type) ?? KINDS[0];
  const page = Math.max(1, Math.trunc(Number(sp.page)) || 1);
  /** Adresse de la liste avec ces filtres (le type n'apparaît que s'il est choisi) */
  const href = (statut: string, typeKey: string, n?: number) =>
    `/backoffice/lots?statut=${statut}${typeKey === "tous" ? "" : `&type=${typeKey}`}${n ? `&page=${n}` : ""}`;
  const path = href(filter.key, type.key);
  await backofficeAccess(path);

  // statusCounts : lots par statut, sans le filtre de statut (compteurs des filtres, une seule requête)
  const [{ items, total, statusCounts: counts }, models] = await Promise.all([
    listBatches({ status: filter.statuses, kind: type.kind, page, pageSize: PAGE_SIZE }),
    listModels(),
  ]);
  const countOf = (statuses: BatchStatus[]) =>
    (statuses.length === 0 ? ALL : statuses).reduce((sum, s) => sum + counts[s], 0);
  // Statuts un par un : seulement ceux qui ont des lots (et le filtre courant), pour garder la barre courte
  const visibleFilters = FILTERS.filter(
    (f) => f.statuses.length !== 1 || f.key === filter.key || countOf(f.statuses) > 0,
  );
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasModels = models.items.length > 0;

  return (
    <>
      <div className="bo-page-head">
        <div>
          <h1>Lots</h1>
          <p>Palettes achetées en gros et revendues à l&apos;unité, et lots de stock des machines en main.</p>
        </div>
        <div className="bo-actions">
          {hasModels && (
            <Link className="bo-btn bo-btn-secondary" href="/backoffice/lots/nouveau?type=stock">
              Créer le lot de stock
            </Link>
          )}
          <Link className="bo-btn bo-btn-primary" href={hasModels ? "/backoffice/lots/nouveau" : "/backoffice/modeles/nouveau?retour=lot"}>
            Nouveau lot
          </Link>
        </div>
      </div>

      <nav className="bo-chips" aria-label="Filtrer par type" style={{ marginBottom: 10 }}>
        {KINDS.map((k) => (
          <Link key={k.key} className="bo-chip" href={href(filter.key, k.key)} aria-current={k.key === type.key ? "true" : undefined}>
            {k.label}
          </Link>
        ))}
      </nav>

      <nav className="bo-chips" aria-label="Filtrer par statut">
        {visibleFilters.map((f) => (
          <Link
            key={f.key}
            className="bo-chip"
            href={href(f.key, type.key)}
            aria-current={f.key === filter.key ? "true" : undefined}
          >
            {f.label} <span className="bo-count">{countOf(f.statuses)}</span>
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <div className="bo-card bo-empty">
          {(filter.key === "tous" || filter.key === "actifs") && type.key === "tous" ? (
            <>
              <h2>{filter.key === "tous" ? "Aucun lot pour l’instant" : "Aucun lot en cours"}</h2>
              <p>
                {hasModels
                  ? "Créez un lot en brouillon : il restera invisible des clients jusqu'à sa publication."
                  : "Commencez par enregistrer un modèle de mineur, puis créez votre premier lot."}
              </p>
              <Link
                className="bo-btn bo-btn-primary"
                href={hasModels ? "/backoffice/lots/nouveau" : "/backoffice/modeles/nouveau?retour=lot"}
              >
                {hasModels ? "Créer un lot" : "Créer un modèle"}
              </Link>
            </>
          ) : (
            <>
              <h2>Aucun lot « {type.key === "tous" ? filter.label : `${type.label} · ${filter.label}`} »</h2>
              <p>Aucun lot ne correspond à ce filtre.</p>
              <Link className="bo-btn bo-btn-secondary" href={href("tous", "tous")}>
                Voir tous les lots
              </Link>
            </>
          )}
        </div>
      ) : (
        <>
          <BatchesGrid batches={items} total={total} />
          {pages > 1 && (
            <nav className="bo-actions" aria-label="Pages" style={{ marginTop: 16 }}>
              {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                <Link
                  key={n}
                  className="bo-chip"
                  href={href(filter.key, type.key, n)}
                  aria-current={n === page ? "true" : undefined}
                >
                  {n}
                </Link>
              ))}
            </nav>
          )}
        </>
      )}
    </>
  );
}
