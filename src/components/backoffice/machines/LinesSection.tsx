"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatCents } from "@/lib/decimal";
import { formatShortDateTime } from "@/lib/dates";
import { plural } from "@/lib/plural";
import { api } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { DataGrid } from "../DataGrid";
import { mailtoHref } from "../orders/ContactEmails";
import { customerName } from "../orders/labels";
import { ErrorAlert, Notice } from "../ui";
import { useMachineAction } from "./useMachineAction";
import { machineName, type Machine, type MachineLine } from "./types";

/** Changement demandé sur la machine d'une ligne payée. */
type Ask = { kind: "assign" | "replace" | "remove"; line: MachineLine };

const TITLES: Record<Ask["kind"], string> = {
  assign: "Attribuer une machine",
  replace: "Remplacer la machine",
  remove: "Retirer la machine",
};

/** Machine à remplacer ou attribuée dégradée (`problem`), et ligne payée en trop (`surplusRank`). */
const PROBLEMS: Record<NonNullable<MachineLine["problem"]>, { label: string; tone: string }> = {
  faulty: { label: "Défectueuse", tone: "cancelled" },
  lost: { label: "Perdue", tone: "cancelled" },
  degraded: { label: "Dégradée", tone: "warning" },
};

type Cell = ICellRendererParams<MachineLine, unknown, { open: (ask: Ask) => void }>;

function MachineCell({ data: line }: Cell) {
  if (!line) return null;
  return (
    <span style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {line.machineId ? (
        <Link href={`/backoffice/machines/${line.machineId}`} className="bo-mono">
          {machineName({ serial: line.machineSerial })}
        </Link>
      ) : (
        <span className="bo-muted">Sans machine</span>
      )}
      {line.problem && <span className={`bo-badge bo-badge-${PROBLEMS[line.problem].tone}`}>{PROBLEMS[line.problem].label}</span>}
      {line.surplusRank !== null && (
        <span className="bo-badge bo-badge-warning" title="Commande payée au-delà des machines utilisables : remboursée en premier si une machine manque">
          En trop
        </span>
      )}
    </span>
  );
}

function ActionsCell({ data: line, context }: Cell) {
  if (!line) return null;
  // L'API tranche toujours : on grise seulement l'action qu'elle refuserait (`can*`), avec la raison en infobulle
  const button = (kind: Ask["kind"], label: string, can: boolean, why: string) => (
    <button
      type="button"
      className="bo-btn bo-btn-ghost bo-btn-sm"
      disabled={!can}
      title={can ? undefined : why}
      onClick={() => context.open({ kind, line })}
    >
      {label}
    </button>
  );
  const shipped = "La machine est déjà remise au transporteur ou livrée, ou le lot est annulé.";
  return (
    <span className="bo-row-actions">
      {line.machineId ? (
        <>
          {button("replace", "Remplacer", line.canReplace, shipped)}
          {button("assign", "Changer", line.canReplace, shipped)}
          {button("remove", "Retirer", line.canRemove, shipped)}
        </>
      ) : (
        button("assign", "Attribuer", line.canAssign, "Attribution possible du Contrôle à En transit pour une palette, et sur un lot de stock ; pas sur un lot annulé.")
      )}
    </span>
  );
}

const wrapped = { wrapText: true, autoHeight: true, cellStyle: { lineHeight: "1.35", paddingTop: "8px", paddingBottom: "8px" } };

/**
 * Commandes payées d'un lot (premier payé d'abord) et leur machine : attribution automatique en un clic, puis
 * correction ligne par ligne (attribuer, remplacer, retirer, avec motif).
 */
export function LinesSection({ batchId, lines, machines }: { batchId: string; lines: MachineLine[]; machines: Machine[] }) {
  const id = useId();
  const action = useMachineAction();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [machineId, setMachineId] = useState("");
  const [reason, setReason] = useState("");

  const assignable = machines.filter((m) => m.assignable);
  const unassigned = lines.filter((l) => l.machineId === null).length;
  // Machine proposée d'office : la première libre contrôlée OK (lue au clic, contexte de la grille stable)
  const firstChoice = useRef("");
  const proposed = assignable.find((m) => m.functionalStatus === "ok")?.id ?? assignable[0]?.id ?? "";
  useLayoutEffect(() => {
    firstChoice.current = proposed;
  });
  const context = useMemo(
    () => ({
      open: (next: Ask) => {
        setAsk(next);
        setReason("");
        setMachineId(firstChoice.current);
      },
    }),
    [],
  );

  const columns = useMemo<ColDef<MachineLine>[]>(
    () => [
      {
        colId: "customer",
        headerName: "Client",
        minWidth: 210,
        flex: 1,
        valueGetter: (p) => p.data?.customer.contactEmail ?? "",
        cellRenderer: (p: Cell) => (
          <span style={{ display: "grid", lineHeight: 1.35 }}>
            {p.data!.customer.contactEmail ? (
              <a href={mailtoHref(p.data!.customer.contactEmail)}>{p.data!.customer.contactEmail}</a>
            ) : (
              <span>{customerName(p.data!.customer.authUserId)}</span>
            )}
            <Link href={`/backoffice/factures/${p.data!.orderId}`} style={{ fontSize: 12.5 }}>
              Facture · machine {p.data!.position}
            </Link>
          </span>
        ),
        ...wrapped,
      },
      {
        field: "paidAt",
        headerName: "Payée le",
        width: 130,
        valueFormatter: (p) => (p.value ? formatShortDateTime(p.value) : "—"),
      },
      {
        colId: "configuration",
        headerName: "Options",
        minWidth: 180,
        flex: 1,
        valueGetter: (p) => p.data?.configuration.map((c) => `${c.option} : ${c.value}`).join(" · ") || "—",
        ...wrapped,
      },
      { field: "amount", headerName: "Montant", width: 120, valueFormatter: (p) => formatCents(p.value), cellClass: "bo-num" },
      // La valeur couvre tout ce que la cellule affiche (machine, badges) : Ag Grid redessine la cellule quand elle change
      {
        colId: "machine",
        headerName: "Machine",
        minWidth: 190,
        flex: 1,
        valueGetter: (p) => `${p.data?.machineSerial ?? ""} ${p.data?.machineId ?? ""} ${p.data?.problem ?? ""} ${p.data?.surplusRank !== null ? "en trop" : ""}`.trim(),
        cellRenderer: MachineCell,
        ...wrapped,
      },
      {
        colId: "actions",
        headerName: "Actions",
        minWidth: 220,
        sortable: false,
        valueGetter: (p) => [p.data?.machineId, p.data?.canAssign, p.data?.canReplace, p.data?.canRemove].join("|"),
        cellRenderer: ActionsCell,
        ...wrapped,
      },
    ],
    [],
  );

  async function autoAssign() {
    await action.run(
      () => api<{ assigned: number }>("POST", `/api/backoffice/batches/${batchId}/assignments/auto`, {}),
      (r) => (r.assigned === 0 ? "Aucune machine libre et contrôlée OK à attribuer." : `${plural(r.assigned, "machine attribuée", "machines attribuées")}.`),
    );
  }

  async function confirm() {
    if (!ask) return;
    const { line } = ask;
    const why = reason.trim() || null;
    const outcome = await action.run(
      (confirmRefunds) =>
        ask.kind === "replace"
          ? api("POST", `/api/backoffice/order-lines/${line.lineId}/replacement`, { expectedMachineId: line.machineId, reason: why ?? "", confirmRefunds })
          : api("POST", `/api/backoffice/order-lines/${line.lineId}/assignment`, {
              expectedMachineId: line.machineId,
              machineId: ask.kind === "remove" ? null : machineId || null,
              reason: why,
              confirmRefunds,
            }),
      ask.kind === "remove" ? "Machine retirée de la commande." : ask.kind === "replace" ? "Machine remplacée." : "Machine attribuée.",
    );
    if (outcome !== "failed") setAsk(null);
  }

  return (
    <section aria-labelledby={`${id}-title`} className="bo-stack">
      <div className="bo-toolbar">
        <h2 id={`${id}-title`}>Commandes payées</h2>
        <button type="button" className={`bo-btn bo-btn-sm ${unassigned > 0 ? "bo-btn-primary" : "bo-btn-secondary"}`} onClick={autoAssign} disabled={action.pending}>
          Attribuer automatiquement{unassigned > 0 && ` (${unassigned} sans machine)`}
        </button>
      </div>
      <p className="bo-hint">Premier payé, premier servi, machines prêtes d&apos;abord ; jamais une machine dégradée ou non contrôlée.</p>
      <Notice message={action.notice} />
      {!ask && <ErrorAlert failure={action.failure} />}
      {lines.length === 0 ? (
        <div className="bo-card bo-empty">
          <p>Aucune commande payée sur ce lot pour l&apos;instant.</p>
        </div>
      ) : (
        <DataGrid<MachineLine> label="Commandes payées du lot" rowData={lines} columnDefs={columns} context={context} getRowId={(p) => p.data.lineId} />
      )}

      <ConfirmDialog
        open={ask !== null}
        title={ask ? `${TITLES[ask.kind]} ?` : ""}
        confirmLabel={ask ? TITLES[ask.kind] : "Confirmer"}
        confirmTone={ask?.kind === "remove" ? "danger" : "primary"}
        cancelLabel="Ne rien changer"
        pending={action.pending}
        onConfirm={confirm}
        onClose={() => {
          action.clearFailure();
          setAsk(null);
        }}
      >
        {ask && (
          <>
            <p>
              Machine {ask.line.position} de la commande de {ask.line.customer.contactEmail ?? customerName(ask.line.customer.authUserId)}
              {ask.line.machineId && <> (machine actuelle : {machineName({ serial: ask.line.machineSerial })})</>}.
              {ask.kind === "replace" && " La meilleure machine libre contrôlée OK du lot la remplace ; s'il n'y en a pas, la commande reste sans machine."}
            </p>
            {ask.kind === "assign" && (
              <div className="bo-field">
                <label className="bo-label" htmlFor={`${id}-machine`}>
                  Machine
                </label>
                {assignable.length === 0 ? (
                  <p className="bo-muted" id={`${id}-machine`}>
                    Aucune machine libre attribuable : recevez et contrôlez des machines d&apos;abord.
                  </p>
                ) : (
                  <select id={`${id}-machine`} className="bo-select" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                    {assignable.map((m) => (
                      <option key={m.id} value={m.id}>
                        {machineName(m)} · {m.functionalLabel} · {m.logisticalLabel}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            <div className="bo-field">
              <label className="bo-label" htmlFor={`${id}-reason`}>
                Motif
                {ask.kind === "assign" && !ask.line.machineId && <span className="bo-optional"> (facultatif)</span>}
              </label>
              <textarea
                id={`${id}-reason`}
                className="bo-textarea"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder={ask.kind === "assign" ? "Obligatoire pour une machine dégradée" : "Ex. machine morte au contrôle"}
              />
            </div>
            <ErrorAlert failure={action.failure} />
          </>
        )}
      </ConfirmDialog>
      {action.dialog}
    </section>
  );
}
