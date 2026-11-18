"use client";

import type { ColDef, GridApi, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useLayoutEffect, useMemo, useRef } from "react";
import { DataGrid } from "../DataGrid";
import { customerName } from "../orders/labels";
import { FunctionalBadge, hashboardsText } from "./MachineBadges";
import type { StatusChange } from "./StatusChangeDialog";
import type { Machine } from "./types";

/** Actions d'une ligne, passées aux cellules par le `context` de la grille. */
export type MachineRowActions = {
  change: (change: StatusChange) => void;
  control: (machine: Machine) => void;
  rename: (machine: Machine, serial: string | null) => void;
  /** Début d'une saisie de série : l'erreur de la saisie précédente n'a plus lieu d'être */
  editStart: () => void;
};

type Cell = ICellRendererParams<Machine, unknown, MachineRowActions>;

function ActionsCell({ data: m, context }: Readonly<Cell>) {
  if (!m) return null;
  return (
    <span className="bo-row-actions">
      {m.inHand && (
        <button type="button" className="bo-btn bo-btn-secondary bo-btn-sm" onClick={() => context.control(m)}>
          Contrôler
        </button>
      )}
      {m.nextChanges.map((c) => (
        <button
          key={c.to}
          type="button"
          className="bo-btn bo-btn-ghost bo-btn-sm"
          disabled={!c.allowed}
          title={c.blockers.join(" ") || undefined}
          onClick={() => context.change({ machines: [m], to: c.to, action: c.action, toLabel: c.toLabel, noteRequired: c.noteRequired })}
        >
          {c.action}
        </button>
      ))}
      <Link className="bo-btn bo-btn-ghost bo-btn-sm" href={`/backoffice/machines/${m.id}`}>
        Fiche
      </Link>
    </span>
  );
}

/** Texte de la colonne « Commande » : sa valeur doit changer avec ce qu'affiche la cellule, sinon la grille ne la redessine pas. */
function lineText(m: Machine): string {
  if (m.line) return m.line.customer.contactEmail ?? customerName(m.line.customer.authUserId);
  return m.batch.kind === "stock" ? (m.sellable ? "Disponible" : "Non vendable") : "";
}

function LineCell({ data: m }: Readonly<Cell>) {
  if (!m) return null;
  if (m.line) {
    return (
      <span style={{ display: "grid", lineHeight: 1.35 }}>
        <Link href={`/backoffice/factures/${m.line.orderId}`}>Machine {m.line.position} de la facture</Link>
        <span className="bo-muted" style={{ fontSize: 12.5 }}>
          {m.line.customer.contactEmail ?? customerName(m.line.customer.authUserId)}
        </span>
      </span>
    );
  }
  if (m.batch.kind === "stock") return m.sellable ? <span>Disponible</span> : <span className="bo-muted">Non vendable</span>;
  return <span className="bo-muted">—</span>;
}

const wrapped = { wrapText: true, autoHeight: true, cellStyle: { lineHeight: "1.35", paddingTop: "8px", paddingBottom: "8px" } };

/**
 * Machines d'un lot : sélection multiple (actions groupées), numéro de série modifiable au clavier (taper, Entrée :
 * la ligne suivante), statuts, hashboards, commande servie et actions proposées par l'API (`nextChanges`).
 */
export function MachinesGrid({
  machines,
  actions,
  quickFilter,
  onReady,
  onSelection,
}: Readonly<{
  machines: Machine[];
  actions: MachineRowActions;
  /** Filtre rapide (toutes colonnes) */
  quickFilter: string;
  /** API de la grille (désélection après une action groupée) */
  onReady: (api: GridApi<Machine>) => void;
  onSelection: (ids: string[]) => void;
}>) {
  // Contexte stable des cellules, qui délègue aux actions du dernier rendu
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });
  const context = useMemo<MachineRowActions>(
    () => ({
      change: (c) => latest.current.change(c),
      control: (m) => latest.current.control(m),
      rename: (m, serial) => latest.current.rename(m, serial),
      editStart: () => latest.current.editStart(),
    }),
    [],
  );
  const columns = useMemo<ColDef<Machine>[]>(
    () => [
      {
        field: "serial",
        headerName: "N° de série",
        headerTooltip: "Double-cliquez ou tapez pour saisir ; Entrée enregistre et passe à la machine suivante",
        minWidth: 170,
        flex: 1,
        editable: true,
        valueFormatter: (p) => p.value ?? "",
        // La saisie part au serveur ; la grille garde la valeur affichée jusqu'au rechargement des données
        valueSetter: (p) => {
          const next = typeof p.newValue === "string" ? p.newValue.trim() : "";
          if (next !== (p.oldValue ?? "")) context.rename(p.data, next || null);
          return false;
        },
        cellClass: "bo-mono",
      },
      {
        field: "logisticalLabel",
        headerName: "Statut",
        width: 130,
      },
      {
        colId: "functional",
        headerName: "État",
        width: 170,
        // Le badge « À recontrôler » fait partie de la valeur : sans lui la grille ne le redessine pas
        valueGetter: (p) => (p.data ? `${p.data.functionalLabel}${p.data.toRecheck ? " · à recontrôler" : ""}` : ""),
        cellRenderer: (p: Cell) => (p.data ? <FunctionalBadge machine={p.data} /> : null),
        ...wrapped,
      },
      {
        colId: "hashboards",
        headerName: "Hashboards",
        width: 170,
        valueGetter: (p) => (p.data ? hashboardsText(p.data.hashboards) : ""),
        ...wrapped,
      },
      {
        colId: "line",
        headerName: "Commande",
        minWidth: 190,
        flex: 1,
        valueGetter: (p) => (p.data ? lineText(p.data) : ""),
        cellRenderer: LineCell,
        ...wrapped,
      },
      {
        colId: "actions",
        headerName: "Actions",
        minWidth: 300,
        flex: 2,
        sortable: false,
        // Valeur qui change avec la machine : sans elle la grille ne redessine pas les boutons après une écriture
        // Chaque bouton (dont « Remettre au transporteur ») peut s'activer ou se bloquer sans que la machine change
        valueGetter: (p) =>
          p.data ? `${p.data.updatedAt}|${p.data.inHand}|${p.data.nextChanges.map((c) => `${c.to}:${c.allowed}:${c.blockers.join("/")}`).join(",")}` : "",
        cellRenderer: ActionsCell,
        ...wrapped,
      },
    ],
    [context],
  );

  return (
    <DataGrid<Machine>
      label="Machines du lot"
      rowData={machines}
      columnDefs={columns}
      context={context}
      quickFilterText={quickFilter}
      onGridReady={(e) => onReady(e.api)}
      getRowId={(p) => p.data.id}
      rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true, selectAll: "filtered", enableClickSelection: false }}
      onCellEditingStarted={() => context.editStart()}
      onSelectionChanged={(e) => onSelection(e.api.getSelectedRows().map((m) => m.id))}
      enterNavigatesVerticallyAfterEdit
      stopEditingWhenCellsLoseFocus
      pagination={machines.length > 100}
      paginationPageSize={100}
    />
  );
}
