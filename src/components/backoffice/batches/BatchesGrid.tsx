"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { nextAction } from "@/server/batch-status";
import type { listBatches } from "@/server/batches";
import { formatCents } from "@/lib/decimal";
import { formatDate, formatShortDateTime } from "@/lib/dates";
import { DataGrid } from "../DataGrid";
import { StatusBadge } from "../StatusBadge";

type BatchSummary = Awaited<ReturnType<typeof listBatches>>["items"][number];

function NextActionCell({ data }: ICellRendererParams<BatchSummary>) {
  if (!data) return null;
  const next = nextAction(data.transitions);
  if (!next) return <span className="bo-muted">Aucune</span>;
  return (
    <Link
      href={`/backoffice/lots/${data.id}`}
      title={next.allowed ? undefined : next.blockers.join(" ")}
      style={next.allowed ? undefined : { color: "var(--muted)", fontWeight: 500 }}
    >
      {next.allowed ? `${next.action} →` : `Bloqué : ${next.action}`}
    </Link>
  );
}

/** Texte comparable sans casse ni accents (« Écran » trouve « ecran »). */
const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const compareCents = (a: string | null, b: string | null) => {
  const x = a === null ? -1n : BigInt(a);
  const y = b === null ? -1n : BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

export function BatchesGrid({ batches, total }: { batches: BatchSummary[]; total: number }) {
  const router = useRouter();
  const searchId = useId();
  const [search, setSearch] = useState("");
  // Lots ayant une action possible d'abord, puis dernière modification (ordre de l'API)
  const sorted = useMemo(
    () =>
      batches
        .map((b, index) => ({ b, index, actionable: b.transitions.some((t) => t.kind === "forward" && t.allowed) }))
        .sort((x, y) => Number(y.actionable) - Number(x.actionable) || x.index - y.index)
        .map(({ b }) => b),
    [batches],
  );
  // Recherche sur le nom du lot et du modèle, dans les lots chargés (page courante)
  const rows = useMemo(() => {
    const terms = fold(search).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return sorted;
    return sorted.filter((b) => {
      const text = fold(`${b.name} ${b.model.name}`);
      return terms.every((term) => text.includes(term));
    });
  }, [sorted, search]);

  const columns = useMemo<ColDef<BatchSummary>[]>(
    () => [
      {
        field: "name",
        headerName: "Lot",
        flex: 2,
        minWidth: 190,
        cellRenderer: (p: ICellRendererParams<BatchSummary>) => (
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
            <Link href={`/backoffice/lots/${p.data!.id}`}>{p.value}</Link>
            <span className="bo-muted" style={{ fontSize: 12.5 }}>
              {p.data!.model.name}
            </span>
          </span>
        ),
      },
      {
        field: "status",
        headerName: "Statut",
        width: 168,
        cellRenderer: (p: ICellRendererParams<BatchSummary>) => <StatusBadge status={p.data!.status} />,
      },
      {
        colId: "next",
        headerName: "Prochaine action",
        flex: 2,
        minWidth: 160,
        sortable: false,
        wrapText: true,
        cellStyle: { lineHeight: "1.35", display: "flex", alignItems: "center" },
        cellRenderer: NextActionCell,
      },
      {
        colId: "stock",
        headerName: "Stock",
        headerTooltip: "Machines encore disponibles / quantité du lot",
        width: 88,
        valueGetter: (p) => p.data?.counters.availableStock,
        valueFormatter: (p) => `${p.value} / ${p.data?.quantity}`,
        cellClass: "bo-num",
      },
      {
        colId: "ordered",
        headerName: "Commandées",
        headerTooltip: "Machines payées (+ réservées par une facture en attente, 30 min)",
        width: 120,
        valueGetter: (p) => p.data?.counters.orderedMachines,
        valueFormatter: (p) =>
          p.data && p.data.counters.pendingMachines > 0
            ? `${p.data.counters.paidMachines} + ${p.data.counters.pendingMachines} rés.`
            : String(p.value),
        cellClass: "bo-num",
      },
      {
        colId: "attention",
        headerName: "À traiter",
        headerTooltip: "Factures du lot qui attendent une décision ; bloqués : utilisateurs bloqués après trop d'abandons",
        width: 120,
        valueGetter: (p) => p.data?.counters.attentionOrders,
        cellRenderer: (p: ICellRendererParams<BatchSummary>) => {
          const c = p.data!.counters;
          if (c.attentionOrders === 0 && c.blockedUsers === 0) return <span className="bo-muted">—</span>;
          return (
            <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
              {c.attentionOrders > 0 && (
                <Link href={`/backoffice/lots/${p.data!.id}#factures`} className="bo-cell-attention">
                  {c.attentionOrders} facture{c.attentionOrders > 1 ? "s" : ""}
                </Link>
              )}
              {c.blockedUsers > 0 && (
                <Link href={`/backoffice/blocages?lot=${p.data!.id}`} style={{ fontSize: 12.5 }}>
                  {c.blockedUsers} bloqué{c.blockedUsers > 1 ? "s" : ""}
                </Link>
              )}
            </span>
          );
        },
      },
      {
        field: "priorityEndsAt",
        headerName: "Priorité jusqu'au",
        headerTooltip: "Fin de la journée de priorité des personnes ayant manifesté leur intérêt",
        width: 140,
        wrapHeaderText: true,
        autoHeaderHeight: true,
        valueFormatter: (p) => (p.value ? formatShortDateTime(p.value) : "—"),
      },
      {
        colId: "interest",
        headerName: "Intéressés",
        headerTooltip: "Utilisateurs ayant manifesté leur intérêt pendant le sondage",
        width: 104,
        valueGetter: (p) => p.data?.counters.interestedUsers,
        cellClass: "bo-num",
      },
      {
        field: "purchasePrice",
        headerName: "Prix d'achat",
        headerTooltip: "Prix d'achat du lot entier",
        width: 120,
        valueFormatter: (p) => formatCents(p.value),
        comparator: compareCents,
        cellClass: "bo-num",
      },
      {
        field: "resaleUnitPrice",
        headerName: "Prix de revente unitaire",
        headerTooltip: "Prix d'une machine pour le client",
        width: 120,
        wrapHeaderText: true,
        autoHeaderHeight: true,
        valueFormatter: (p) => (p.value ? formatCents(p.value) : "À définir"),
        comparator: compareCents,
        cellClass: "bo-num",
      },
      {
        field: "createdAt",
        headerName: "Créé le",
        headerTooltip: "Date de création du lot (la liste est triée par dernière modification)",
        width: 112,
        valueFormatter: (p) => formatDate(p.value),
        tooltipValueGetter: (p) => (p.data ? `Modifié le ${formatShortDateTime(p.data.updatedAt)}` : undefined),
      },
    ],
    [],
  );

  const truncated = total > batches.length;
  return (
    <>
      <div className="bo-toolbar">
        <div className="bo-field bo-search">
          <label className="bo-label bo-visually-hidden" htmlFor={searchId}>
            Rechercher un lot
          </label>
          <input
            id={searchId}
            className="bo-input"
            type="search"
            placeholder="Rechercher un lot ou un modèle"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
          />
        </div>
        <p className="bo-muted" style={{ fontSize: 14 }} role="status">
          {search.trim()
            ? `${rows.length} lot${rows.length > 1 ? "s" : ""} sur ${batches.length}${truncated ? " de cette page" : ""}`
            : `${total} lot${total > 1 ? "s" : ""} · les lots ayant une action possible sont en tête`}
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucun lot ne correspond à « {search.trim()} »</h2>
          <p>La recherche porte sur le nom du lot et celui du modèle{truncated ? ", dans les lots de cette page" : ""}.</p>
          <button type="button" className="bo-btn bo-btn-secondary" onClick={() => setSearch("")}>
            Effacer la recherche
          </button>
        </div>
      ) : (
        <DataGrid<BatchSummary>
          label="Liste des lots"
          rowData={rows}
          columnDefs={columns}
          getRowId={(p) => p.data.id}
          onCellKeyDown={(e) => {
            const key = (e.event as KeyboardEvent | null)?.key;
            if (key === "Enter" && e.data) router.push(`/backoffice/lots/${e.data.id}`);
          }}
        />
      )}
    </>
  );
}
