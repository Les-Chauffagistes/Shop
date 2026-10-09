"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import type { OrderStatus } from "../../../../prisma/generated/enums";
import type { listAttentionOrders, listBatchOrders } from "@/server/backoffice-orders";
import { formatCents } from "@/lib/decimal";
import { formatShortDateTime } from "@/lib/dates";
import { formatSats } from "@/components/money";
import { DataGrid } from "../DataGrid";
import { OrderStatusBadge } from "../OrderStatusBadge";
import { ATTENTION_REASONS } from "./labels";

type AttentionItem = Awaited<ReturnType<typeof listAttentionOrders>>["items"][number];
type BatchOrder = Awaited<ReturnType<typeof listBatchOrders>>["items"][number];

const statusCell = (p: ICellRendererParams<{ status: OrderStatus; statusLabel: string }>) =>
  p.data ? <OrderStatusBadge status={p.data.status} label={p.data.statusLabel} /> : null;

/** File « à traiter » : la plus ancienne d'abord (ordre de l'API) ; Entrée ouvre la facture. */
export function AttentionGrid({ items }: { items: AttentionItem[] }) {
  const router = useRouter();
  const columns = useMemo<ColDef<AttentionItem>[]>(
    () => [
      {
        colId: "reason",
        headerName: "À faire",
        flex: 3,
        minWidth: 280,
        wrapText: true,
        autoHeight: true,
        cellStyle: { lineHeight: "1.35", paddingTop: "8px", paddingBottom: "8px" },
        valueGetter: (p) => p.data?.attention.label,
        cellRenderer: (p: ICellRendererParams<AttentionItem>) => (
          <span style={{ display: "grid", gap: 2 }}>
            <Link href={`/backoffice/factures/${p.data!.orderId}`}>{ATTENTION_REASONS[p.data!.attention.reason] ?? p.data!.attention.reason}</Link>
            <span className="bo-muted" style={{ fontSize: 13 }}>
              {p.data!.attention.label}
            </span>
          </span>
        ),
      },
      {
        colId: "batch",
        headerName: "Lot",
        flex: 1,
        minWidth: 140,
        valueGetter: (p) => p.data?.batch.name,
        cellRenderer: (p: ICellRendererParams<AttentionItem>) => <Link href={`/backoffice/lots/${p.data!.batch.id}`}>{p.value}</Link>,
      },
      { field: "status", headerName: "Facture", width: 170, cellRenderer: statusCell },
      { colId: "user", headerName: "Client", width: 100, valueGetter: (p) => `n° ${p.data?.user.authUserId}` },
      {
        colId: "received",
        headerName: "Reçu / attendu",
        width: 210,
        valueGetter: (p) => `${formatSats(p.data?.receivedSats)} / ${formatSats(p.data?.expectedSats)}`,
        cellClass: "bo-num",
      },
      {
        field: "unsettledSats",
        headerName: "Non affecté",
        headerTooltip: "Sats reçus ni acceptés pour la marchandise, ni remboursés",
        width: 140,
        valueFormatter: (p) => formatSats(p.value),
        cellClass: "bo-num",
      },
      { field: "createdAt", headerName: "Créée le", width: 140, valueFormatter: (p) => formatShortDateTime(p.value) },
    ],
    [],
  );
  return (
    <DataGrid<AttentionItem>
      label="Factures à traiter"
      rowData={items}
      columnDefs={columns}
      getRowId={(p) => p.data.orderId}
      onCellKeyDown={(e) => {
        if ((e.event as KeyboardEvent | null)?.key === "Enter" && e.data) router.push(`/backoffice/factures/${e.data.orderId}`);
      }}
    />
  );
}

/** Factures d'un lot (fiche du lot), la plus récente d'abord. */
export function BatchOrdersGrid({ items }: { items: BatchOrder[] }) {
  const router = useRouter();
  const columns = useMemo<ColDef<BatchOrder>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Facture",
        width: 150,
        valueFormatter: (p) => formatShortDateTime(p.value),
        cellRenderer: (p: ICellRendererParams<BatchOrder>) => (
          <Link href={`/backoffice/factures/${p.data!.id}`}>{formatShortDateTime(p.data!.createdAt)}</Link>
        ),
      },
      { field: "status", headerName: "Statut", width: 190, cellRenderer: statusCell },
      {
        colId: "attention",
        headerName: "À traiter",
        flex: 1,
        minWidth: 160,
        headerTooltip: "Décision attendue de l'équipe ; « Paiement partiel » : l'utilisateur a encore la main (appoint ou remboursement)",
        valueGetter: (p) => {
          if (!p.data) return "";
          if (p.data.attention) return ATTENTION_REASONS[p.data.attention.reason] ?? p.data.attention.reason;
          return p.data.actions.awaitingTopUp ? "Paiement partiel : appoint attendu" : "";
        },
        cellClass: (p) => (p.data?.attention ? "bo-cell-attention" : undefined),
      },
      { colId: "user", headerName: "Client", width: 100, valueGetter: (p) => `n° ${p.data?.user.authUserId}` },
      { colId: "machines", headerName: "Machines", width: 105, valueGetter: (p) => p.data?.lines.filter((l) => !l.refunded).length, cellClass: "bo-num" },
      { field: "totalAmount", headerName: "Montant", width: 130, valueFormatter: (p) => formatCents(p.value), cellClass: "bo-num" },
      {
        colId: "received",
        headerName: "Reçu",
        width: 150,
        valueGetter: (p) => p.data?.payment.receivedSats,
        valueFormatter: (p) => formatSats(p.value),
        cellClass: "bo-num",
      },
    ],
    [],
  );
  return (
    <DataGrid<BatchOrder>
      label="Factures du lot"
      rowData={items}
      columnDefs={columns}
      getRowId={(p) => p.data.id}
      onCellKeyDown={(e) => {
        if ((e.event as KeyboardEvent | null)?.key === "Enter" && e.data) router.push(`/backoffice/factures/${e.data.id}`);
      }}
    />
  );
}
