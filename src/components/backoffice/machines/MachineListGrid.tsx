"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DataGrid } from "../DataGrid";
import { FunctionalBadge } from "./MachineBadges";
import { machineName, type Machine } from "./types";

type Cell = ICellRendererParams<Machine>;

const columns: ColDef<Machine>[] = [
  {
    field: "serial",
    headerName: "N° de série",
    minWidth: 180,
    flex: 1,
    cellRenderer: (p: Cell) => (
      <Link href={`/backoffice/machines/${p.data!.id}`} className="bo-mono">
        {machineName(p.data!)}
      </Link>
    ),
  },
  { colId: "model", headerName: "Modèle", width: 130, valueGetter: (p) => p.data?.model.name },
  {
    colId: "batch",
    headerName: "Lot",
    minWidth: 180,
    flex: 1,
    valueGetter: (p) => p.data?.batch.name,
    cellRenderer: (p: Cell) => <Link href={`/backoffice/lots/${p.data!.batch.id}?onglet=machines`}>{p.value as string}</Link>,
  },
  { field: "logisticalLabel", headerName: "Statut", width: 130 },
  {
    colId: "functional",
    headerName: "État",
    width: 180,
    valueGetter: (p) => p.data?.functionalLabel,
    cellRenderer: (p: Cell) => (p.data ? <FunctionalBadge machine={p.data} /> : null),
  },
  {
    colId: "line",
    headerName: "Commande",
    minWidth: 200,
    flex: 1,
    valueGetter: (p) => p.data?.line?.customer.contactEmail ?? "",
    cellRenderer: (p: Cell) =>
      p.data?.line ? (
        <Link href={`/backoffice/factures/${p.data.line.orderId}`}>{p.data.line.customer.contactEmail ?? "Voir la facture"}</Link>
      ) : (
        <span className="bo-muted">—</span>
      ),
  },
];

/** Résultats d'une recherche de machines (tous lots confondus) ; Entrée ouvre la fiche. */
export function MachineListGrid({ machines }: Readonly<{ machines: Machine[] }>) {
  const router = useRouter();
  return (
    <DataGrid<Machine>
      label="Machines trouvées"
      rowData={machines}
      columnDefs={columns}
      getRowId={(p) => p.data.id}
      onCellKeyDown={(e) => {
        const key = (e.event as KeyboardEvent | null)?.key;
        if (key === "Enter" && e.data) router.push(`/backoffice/machines/${e.data.id}`);
      }}
    />
  );
}
