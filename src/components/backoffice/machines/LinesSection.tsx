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
type Ask = { kind: "assign" | "replace" | "remove" | "cancel-line" | "cancel-order"; line: MachineLine };

const TITLES: Record<Ask["kind"], string> = {
  assign: "Attribuer une machine",
  replace: "Remplacer la machine",
  remove: "Retirer la machine",
  "cancel-line": "Annuler la ligne",
  "cancel-order": "Annuler la facture",
};

/** Motif proposé quand une machine morte ou perdue n'a pas de remplaçante. */
const NO_REPLACEMENT = "Aucune machine de remplacement disponible";

/** Ligne dont la machine est morte ou perdue, sans machine libre pour la remplacer : « à remplacer » n'a plus de sens. */
const unreplaceable = (line: MachineLine, available: boolean) => !available && (line.problem === "faulty" || line.problem === "lost");

/** Machine à remplacer ou attribuée dégradée (`problem`), et ligne payée en trop (`surplusRank`). */
const PROBLEMS: Record<NonNullable<MachineLine["problem"]>, { label: string; tone: string }> = {
  faulty: { label: "Défectueuse", tone: "cancelled" },
  lost: { label: "Perdue", tone: "cancelled" },
  degraded: { label: "Dégradée", tone: "warning" },
};

type Cell = ICellRendererParams<MachineLine, unknown, { open: (ask: Ask) => void; replacementAvailable: boolean }>;

function MachineCell({ data: line, context }: Readonly<Cell>) {
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
      {line.problem === "degraded" && (
        <span className="bo-muted" style={{ fontSize: 12.5 }} data-testid="degraded-accepted">
          {line.degradedAcceptedAt ? `acceptée par le client le ${formatShortDateTime(line.degradedAcceptedAt)}` : "acceptation du client non enregistrée"}
        </span>
      )}
      {unreplaceable(line, context.replacementAvailable) && (
        <span className="bo-muted" style={{ fontSize: 12.5 }} data-testid="no-replacement">
          {NO_REPLACEMENT}
        </span>
      )}
      {line.surplusRank !== null && (
        <span className="bo-badge bo-badge-warning" title="Commande payée au-delà des machines utilisables : remboursée en premier si une machine manque">
          En trop
        </span>
      )}
    </span>
  );
}

function ActionsCell({ data: line, context }: Readonly<Cell>) {
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
  const cancel = (kind: "cancel-line" | "cancel-order", label: string) => (
    <button type="button" className="bo-btn bo-btn-danger bo-btn-sm" onClick={() => context.open({ kind, line })}>
      {label}
    </button>
  );
  return (
    <span className="bo-row-actions">
      {unreplaceable(line, context.replacementAvailable) && (
        <>
          {cancel("cancel-line", "Annuler la ligne")}
          {cancel("cancel-order", "Annuler la facture")}
        </>
      )}
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
export function LinesSection({
  batchId,
  lines,
  machines,
  replacementAvailable,
}: Readonly<{
  batchId: string;
  lines: MachineLine[];
  machines: Machine[];
  replacementAvailable: boolean;
}>) {
  const id = useId();
  const action = useMachineAction();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [machineId, setMachineId] = useState("");
  const [reason, setReason] = useState("");
  const [accepted, setAccepted] = useState(false);

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
      replacementAvailable,
      open: (next: Ask) => {
        setAsk(next);
        setReason(next.kind === "cancel-line" || next.kind === "cancel-order" ? NO_REPLACEMENT : "");
        setAccepted(false);
        setMachineId(firstChoice.current);
      },
    }),
    [replacementAvailable],
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
        valueGetter: (p) => `${p.data?.machineSerial ?? ""} ${p.data?.machineId ?? ""} ${p.data?.problem ?? ""} ${p.data?.degradedAcceptedAt ?? ""} ${p.data?.surplusRank !== null ? "en trop" : ""}`.trim(),
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
  const stuck = lines.filter((l) => unreplaceable(l, replacementAvailable));

  async function autoAssign() {
    await action.run(
      () => api<{ assigned: number }>("POST", `/api/backoffice/batches/${batchId}/assignments/auto`, {}),
      (r) => (r.assigned === 0 ? "Aucune machine libre et contrôlée OK à attribuer." : `${plural(r.assigned, "machine attribuée", "machines attribuées")}.`),
    );
  }

  const chosenMachine = ask?.kind === "assign" ? assignable.find((m) => m.id === machineId) : undefined;
  const degraded = chosenMachine?.functionalStatus === "degraded";

  async function confirm() {
    if (!ask) return;
    const { line } = ask;
    const why = reason.trim() || null;
    if (ask.kind === "cancel-line" || ask.kind === "cancel-order") {
      // Motif de remboursement du cas de la machine (table MachineRefundCause, lu par la vue du lot) ; frais à la boutique
      const outcome = await action.run(
        () =>
          api("POST", `/api/backoffice/orders/${line.orderId}/cancel-lines`, {
            reason: why ?? NO_REPLACEMENT,
            cause: line.refundCause ?? "admin_other",
            ...(ask.kind === "cancel-line" ? { lineIds: [line.lineId] } : {}),
          }),
        ask.kind === "cancel-line" ? "Ligne annulée et remboursée." : "Facture annulée et remboursée.",
      );
      if (outcome !== "failed") setAsk(null);
      return;
    }
    const outcome = await action.run(
      (confirmRefunds) =>
        ask.kind === "replace"
          ? api("POST", `/api/backoffice/order-lines/${line.lineId}/replacement`, { expectedMachineId: line.machineId, reason: why ?? "", confirmRefunds })
          : api("POST", `/api/backoffice/order-lines/${line.lineId}/assignment`, {
              expectedMachineId: line.machineId,
              machineId: ask.kind === "remove" ? null : machineId || null,
              reason: why,
              ...(degraded && accepted ? { customerAcceptsDegraded: true } : {}),
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
      {stuck.length > 0 && (
        <div className="bo-alert bo-alert-warning" data-testid="no-replacement-alert">
          <p>
            <strong>Aucune machine de remplacement disponible</strong> pour {plural(stuck.length, "ligne dont la machine", "lignes dont la machine")} est
            défectueuse ou perdue. Annulez la ligne ou toute la facture : le client est remboursé, frais à la charge de la boutique, sans abandon ni pénalité.
          </p>
        </div>
      )}
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
        confirmTone={ask && ["remove", "cancel-line", "cancel-order"].includes(ask.kind) ? "danger" : "primary"}
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
            {(ask.kind === "cancel-line" || ask.kind === "cancel-order") && (
              <p>
                {ask.kind === "cancel-line"
                  ? "Cette ligne est remboursée ; les autres machines de la facture restent."
                  : "Toutes les machines encore actives de la facture sont remboursées."}{" "}
                Remboursement par le même moyen que le paiement, frais à la charge de la boutique, sans abandon ni pénalité pour le client.
              </p>
            )}
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
            {degraded && (
              <div className="bo-alert bo-alert-warning" data-testid="degraded-notice">
                <p>
                  Cette machine est <strong>dégradée</strong> (hashboard défectueuse) : elle n&apos;est pas une machine 100 %
                  opérationnelle. Le client doit l&apos;accepter explicitement ; indiquez le motif, et accordez le rabais par la
                  facture (« Rabais »).
                </p>
                <label className="bo-check" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8 }}>
                  <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                  <span>Le client a accepté explicitement la machine dégradée</span>
                </label>
              </div>
            )}
            <div className="bo-field">
              <label className="bo-label" htmlFor={`${id}-reason`}>
                Motif
                {ask.kind === "assign" && !ask.line.machineId && !degraded && <span className="bo-optional"> (facultatif)</span>}
              </label>
              <textarea
                id={`${id}-reason`}
                className="bo-textarea"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder={ask.kind === "assign" ? (degraded ? "Motif de l'attribution (obligatoire)" : "Obligatoire pour une machine dégradée") : "Ex. machine morte au contrôle"}
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
