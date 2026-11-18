"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { listModelStock } from "@/server/machines";
import { DataGrid } from "../DataGrid";
import { StatusBadge } from "../StatusBadge";

type ModelStock = Awaited<ReturnType<typeof listModelStock>>["items"][number];

/** Compteur cliquable vers les machines du lot de stock (0 : grisé). */
const count = (p: ICellRendererParams<ModelStock>) => {
  if (!p.data?.stockBatch || !p.value) return <span className="bo-muted">{p.value ?? 0}</span>;
  return <Link href={`/backoffice/lots/${p.data.stockBatch.id}?onglet=machines`}>{p.value}</Link>;
};

/** Compteur suivi de sa part dégradée, jamais confondue avec les « ok » : « 3 dont 1 dégradée ». */
const withDegraded = (field: "assignedDegraded" | "inPalettesDegraded", link: (p: ICellRendererParams<ModelStock>) => React.ReactNode) =>
  function WithDegraded(p: ICellRendererParams<ModelStock>) {
    const degraded = p.data?.[field] ?? 0;
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "baseline" }}>
        {link(p)}
        {degraded > 0 && (
          <span className="bo-muted" style={{ fontSize: 12 }} data-testid={`${field}-${p.data?.model.name}`}>
            dont {degraded} dégradée{degraded > 1 ? "s" : ""}
          </span>
        )}
      </span>
    );
  };

const number = (
  field: keyof ModelStock,
  headerName: string,
  headerTooltip: string,
  renderer: (p: ICellRendererParams<ModelStock>) => React.ReactNode = count,
): ColDef<ModelStock> => ({
  field,
  headerName,
  headerTooltip,
  width: renderer === count ? 118 : 150,
  wrapHeaderText: true,
  autoHeaderHeight: true,
  cellClass: "bo-num",
  cellRenderer: renderer,
});

const columns: ColDef<ModelStock>[] = [
  {
    colId: "model",
    headerName: "Modèle",
    pinned: "left",
    minWidth: 150,
    flex: 1,
    valueGetter: (p) => p.data?.model.name,
    cellRenderer: (p: ICellRendererParams<ModelStock>) => <Link href={`/backoffice/modeles/${p.data!.model.id}`}>{p.value}</Link>,
  },
  {
    colId: "stockBatch",
    headerName: "Lot de stock",
    minWidth: 300,
    flex: 1,
    // Statut et disponibles dans la valeur : la cellule (badge, bouton « Vendre ») est redessinée quand ils changent
    valueGetter: (p) => `${p.data?.stockBatch?.name ?? ""} ${p.data?.stockBatch?.status ?? ""} ${p.data?.available ?? 0}`,
    cellRenderer: (p: ICellRendererParams<ModelStock>) =>
      p.data!.stockBatch ? (
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <Link href={`/backoffice/lots/${p.data!.stockBatch.id}`}>{p.data!.stockBatch.name}</Link>
          <StatusBadge status={p.data!.stockBatch.status} label={p.data!.stockBatch.statusLabel} />
          {p.data!.stockBatch.status === "on_sale" && p.data!.available > 0 && (
            <Link
              className="bo-btn bo-btn-secondary bo-btn-sm"
              href={`/backoffice/vente?lot=${p.data!.stockBatch.id}`}
              aria-label={`Vendre une machine de ${p.data!.stockBatch.name}`}
            >
              Vendre
            </Link>
          )}
        </span>
      ) : (
        <Link href={`/backoffice/lots/nouveau?type=stock&modele=${p.data!.model.id}`}>Créer le lot de stock</Link>
      ),
  },
  number("expected", "À recevoir", "Machines attendues (réassorts pas encore reçus)"),
  number("toCheck", "À contrôler", "En main, jamais contrôlées ou à recontrôler depuis leur retour"),
  number("available", "Disponibles", "Vendables, ni vendues ni réservées : ce que voit la boutique"),
  number("reserved", "Réservées", "Vendables retenues par une commande payée sans machine ou une facture en attente"),
  number("assigned", "À expédier", "En main, attribuées à une commande payée (dont dégradées, acceptées par le client)", withDegraded("assignedDegraded", count)),
  number("degraded", "Dégradées", "En main, libres : jamais vendables depuis le stock"),
  number("faulty", "Défectueuses", "En main : à mettre au rebut"),
  {
    field: "inPalettes",
    headerName: "Dans les palettes",
    headerTooltip: "Invendues des palettes en cours du modèle : transférables au stock depuis la palette",
    width: 160,
    wrapHeaderText: true,
    autoHeaderHeight: true,
    cellClass: "bo-num",
    cellRenderer: withDegraded("inPalettesDegraded", (p) =>
      p.value ? <Link href="/backoffice/lots?statut=actifs&type=palettes">{p.value}</Link> : <span className="bo-muted">0</span>,
    ),
  },
];

/** Stock par modèle (vue `model_stock_summary`) : Entrée ouvre le lot de stock. */
export function ModelStockGrid({ items }: Readonly<{ items: ModelStock[] }>) {
  const router = useRouter();
  return (
    <DataGrid<ModelStock>
      label="Stock par modèle"
      rowData={items}
      columnDefs={columns}
      getRowId={(p) => p.data.model.id}
      onCellKeyDown={(e) => {
        const key = (e.event as KeyboardEvent | null)?.key;
        if (key === "Enter" && e.data?.stockBatch) router.push(`/backoffice/lots/${e.data.stockBatch.id}`);
      }}
    />
  );
}
