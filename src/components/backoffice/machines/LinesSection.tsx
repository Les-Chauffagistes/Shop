"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
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

/** Changement demandé sur la machine d'une ligne payée (`line` : la ligne vue par la cellule, peut-être périmée). */
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
      {line.mounting.conform === false && (
        <span className="bo-badge bo-badge-cancelled" data-testid="mounting-mismatch" title="La machine attribuée n'est pas montée (ou pas prête) comme la commande l'exige : elle ne partira pas">
          Montage non conforme
        </span>
      )}
      {line.mounting.required.length > 0 && (
        <span className="bo-muted" style={{ fontSize: 12.5 }}>
          à monter : {line.mounting.required.map((i) => i.value).join(" + ")}
        </span>
      )}
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

  const unassigned = lines.filter((l) => l.machineId === null).length;
  // Lignes qui demandent une action : sans machine, en trop, ou avec un problème (machine à remplacer, dégradée) ou
  // une machine mal montée. S'il y en a, on ne montre qu'elles par défaut ; « Voir toutes » affiche le reste.
  const needsAction = (l: MachineLine) => l.machineId === null || l.surplusRank !== null || l.problem !== null || l.mounting.conform === false;
  // Une ligne que l'admin vient de traiter reste affichée (sinon elle disparaît sous ses yeux)
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const todoLines = lines.filter((l) => needsAction(l) || handled.has(l.lineId));
  const [showAll, setShowAll] = useState(false);
  const visibleLines = showAll || todoLines.length === 0 ? lines : todoLines;
  // Machines que la ligne peut recevoir : celles de son montage (`fittingMachineIds`), la base refuse les autres
  const assignableFor = (line: MachineLine) => machines.filter((m) => line.fittingMachineIds.includes(m.id));
  // Machine proposée d'office : la première conforme contrôlée OK
  const firstChoice = (line: MachineLine) => {
    const fitting = assignableFor(line);
    return fitting.find((m) => m.functionalStatus === "ok")?.id ?? fitting[0]?.id ?? "";
  };
  // Le dialogue lit toujours la ligne à jour : une cellule que la grille n'a pas redessinée (valeur inchangée) passe
  // une ligne périmée (ex. `fittingMachineIds` vide juste après « Marquer prêtes »)
  const line = ask ? (lines.find((l) => l.lineId === ask.line.lineId) ?? ask.line) : null;
  const context = useMemo(
    () => ({
      replacementAvailable,
      open: (next: Ask) => {
        setAsk(next);
        setReason(next.kind === "cancel-line" || next.kind === "cancel-order" ? NO_REPLACEMENT : "");
        setAccepted(false);
        setMachineId("");
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
        valueGetter: (p) => `${p.data?.machineSerial ?? ""} ${p.data?.machineId ?? ""} ${p.data?.problem ?? ""} ${p.data?.degradedAcceptedAt ?? ""} ${p.data?.surplusRank !== null ? "en trop" : ""} ${p.data?.mounting.conform === false ? "non conforme" : ""} ${p.data?.mounting.required.map((i) => i.optionValueId).join(",") ?? ""}`.trim(),
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
      (r) => (r.assigned === 0 ? "Aucune machine libre, contrôlée OK et montée comme les commandes à attribuer." : `${plural(r.assigned, "machine attribuée", "machines attribuées")}.`),
    );
  }

  const assignable = line ? assignableFor(line) : [];
  // Choix de l'admin s'il est encore attribuable, sinon la machine proposée d'office (les machines arrivent après l'ouverture)
  const chosenId = assignable.some((m) => m.id === machineId) ? machineId : line ? firstChoice(line) : "";
  const chosenMachine = ask?.kind === "assign" ? assignable.find((m) => m.id === chosenId) : undefined;
  const degraded = chosenMachine?.functionalStatus === "degraded";
  // Attribuer sans machine ne change rien : on ne propose pas de valider
  const nothingToAssign = ask?.kind === "assign" && !chosenMachine;

  async function confirm() {
    if (!ask || !line || nothingToAssign) return;
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
      if (outcome !== "failed") {
      setHandled((prev) => new Set(prev).add(line.lineId));
      setAsk(null);
    }
      return;
    }
    const outcome = await action.run(
      (confirmRefunds) =>
        ask.kind === "replace"
          ? api("POST", `/api/backoffice/order-lines/${line.lineId}/replacement`, { expectedMachineId: line.machineId, reason: why ?? "", confirmRefunds })
          : api("POST", `/api/backoffice/order-lines/${line.lineId}/assignment`, {
              expectedMachineId: line.machineId,
              machineId: ask.kind === "remove" ? null : chosenId || null,
              reason: why,
              ...(degraded && accepted ? { customerAcceptsDegraded: true } : {}),
              confirmRefunds,
            }),
      lineActionNotice(ask.kind),
    );
    if (outcome !== "failed") {
      setHandled((prev) => new Set(prev).add(line.lineId));
      setAsk(null);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="bo-stack">
      <div className="bo-toolbar">
        <h2 id={`${id}-title`}>Commandes payées</h2>
        <button type="button" className={`bo-btn bo-btn-sm ${unassigned > 0 ? "bo-btn-primary" : "bo-btn-secondary"}`} onClick={autoAssign} disabled={action.pending}>
          Attribuer automatiquement{unassigned > 0 && ` (${unassigned} sans machine)`}
        </button>
      </div>
      {todoLines.length > 0 && todoLines.length < lines.length && (
        <p className="bo-hint">
          {showAll ? `Toutes les commandes (${lines.length}).` : `${plural(todoLines.length, "commande à traiter", "commandes à traiter")} sur ${lines.length}.`}{" "}
          <button type="button" className="bo-btn bo-btn-ghost bo-btn-sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Seulement celles à traiter" : "Voir toutes"}
          </button>
        </p>
      )}
      <p className="bo-hint">Premier payé, premier servi, machines prêtes d&apos;abord ; jamais une machine dégradée ou non contrôlée, ni une machine dont le montage n&apos;est pas celui de la commande.</p>
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
        <DataGrid<MachineLine> label="Commandes payées du lot" rowData={visibleLines} columnDefs={columns} context={context} getRowId={(p) => p.data.lineId} />
      )}

      <ConfirmDialog
        open={ask !== null}
        title={ask ? `${TITLES[ask.kind]} ?` : ""}
        confirmLabel={ask ? TITLES[ask.kind] : "Confirmer"}
        confirmTone={ask && ["remove", "cancel-line", "cancel-order"].includes(ask.kind) ? "danger" : "primary"}
        cancelLabel="Ne rien changer"
        pending={action.pending}
        confirmDisabled={nothingToAssign}
        onConfirm={confirm}
        onClose={() => {
          action.clearFailure();
          setAsk(null);
        }}
      >
        {ask && line && (
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
              Machine {line.position} de la commande de {line.customer.contactEmail ?? customerName(line.customer.authUserId)}
              {line.machineId && <> (machine actuelle : {machineName({ serial: line.machineSerial })})</>}.
              {ask.kind === "replace" && " La meilleure machine libre contrôlée OK du lot, montée comme la commande, la remplace ; s'il n'y en a pas, la commande reste sans machine."}
            </p>
            {ask.kind === "assign" && (
              <div className="bo-field">
                <label className="bo-label" htmlFor={`${id}-machine`}>
                  Machine
                </label>
                {assignable.length === 0 ? (
                  <p className="bo-muted" id={`${id}-machine`}>
                    {line.mounting.required.length > 0
                      ? `Aucune machine prête montée avec ${line.mounting.required.map((i) => i.value).join(" + ")} : suivez le plan de montage (« Démarrer le montage »), puis « Marquer prêtes ».`
                      : "Aucune machine brute libre attribuable : recevez et contrôlez des machines d'abord."}
                  </p>
                ) : (
                  <select id={`${id}-machine`} className="bo-select" value={chosenId} onChange={(e) => setMachineId(e.target.value)}>
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
                {ask.kind === "assign" && !line.machineId && !degraded && <span className="bo-optional"> (facultatif)</span>}
              </label>
              <textarea
                id={`${id}-reason`}
                className="bo-textarea"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder={notePlaceholder(ask.kind, degraded)}
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

function lineActionNotice(kind: "remove" | "replace" | "assign"): string {
  if (kind === "remove") return "Machine retirée de la commande.";
  return kind === "replace" ? "Machine remplacée." : "Machine attribuée.";
}

function notePlaceholder(kind: string, degraded: boolean): string {
  if (kind !== "assign") return "Ex. machine morte au contrôle";
  return degraded ? "Motif de l'attribution (obligatoire)" : "Obligatoire pour une machine dégradée";
}
