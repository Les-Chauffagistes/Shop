"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { listModels } from "@/server/catalog";
import { formatHashrate } from "@/lib/decimal";
import { DataGrid } from "../DataGrid";

type ModelSummary = Awaited<ReturnType<typeof listModels>>["items"][number];

const columns: ColDef<ModelSummary>[] = [
  {
    field: "name",
    headerName: "Modèle",
    flex: 2,
    cellRenderer: (p: ICellRendererParams<ModelSummary>) => (
      <Link href={`/backoffice/modeles/${p.data!.id}`}>{p.value}</Link>
    ),
  },
  {
    field: "hashrate",
    headerName: "Hashrate",
    flex: 1,
    valueFormatter: (p) => formatHashrate(p.value),
    comparator: (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
    cellClass: "bo-num",
  },
  { field: "hashboardQtt", headerName: "Hashboards", flex: 1, cellClass: "bo-num" },
  { field: "optionCount", headerName: "Menus d'options", flex: 1, cellClass: "bo-num" },
  { field: "batchCount", headerName: "Lots", flex: 1, cellClass: "bo-num" },
];

export function ModelsGrid({ models }: { models: ModelSummary[] }) {
  const router = useRouter();
  return (
    <DataGrid<ModelSummary>
      label="Liste des modèles"
      rowData={models}
      columnDefs={columns}
      getRowId={(p) => p.data.id}
      onCellKeyDown={(e) => {
        const key = (e.event as KeyboardEvent | null)?.key;
        if (key === "Enter" && e.data) router.push(`/backoffice/modeles/${e.data.id}`);
      }}
    />
  );
}
