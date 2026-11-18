"use client";

import { plural, pluralS } from "@/lib/plural";
import type { GridApi } from "ag-grid-community";
import { useId, useRef, useState } from "react";
import { machineChangeNeedsNote } from "@/server/machine-status";
import { machines as machinesLabel } from "@/lib/plural";
import { api } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Notice } from "../ui";
import { ControlDialog } from "./ControlDialog";
import { MachinesGrid, type MachineRowActions } from "./MachinesGrid";
import { changeDone, groupBlockedReport, groupChange, needsDialog, sendStatusChange, StatusChangeDialog, type StatusChange } from "./StatusChangeDialog";
import { useMachineAction } from "./useMachineAction";
import type { Machine } from "./types";

/** Action groupée en attente d'une note : « Tout OK » d'une machine déjà saisie, ou transfert au stock. */
type NoteAsk = { kind: "check" | "transfer"; machines: Machine[] };

/**
 * Machines d'un lot : grille, actions par machine, et actions groupées sur la sélection (« Tout OK », « Marquer
 * prêtes », « Remettre au transporteur », « Transférer au stock » pour une palette).
 */
export function MachinesSection({ batch, machines }: Readonly<{ batch: { id: string; kind: "wholesale" | "stock" }; machines: Machine[] }>) {
  const id = useId();
  const action = useMachineAction();
  const grid = useRef<GridApi<Machine> | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [change, setChange] = useState<StatusChange | null>(null);
  const [control, setControl] = useState<Machine | null>(null);
  const [ask, setAsk] = useState<NoteAsk | null>(null);
  const [note, setNote] = useState("");

  const selected = machines.filter((m) => selectedIds.includes(m.id));
  const toCheck = selected.filter((m) => m.inHand);
  const ready = groupChange(selected, "ready", "Marquer prêtes");
  const ship = groupChange(selected, "in_transit", "Remettre au transporteur");

  const blockedReports = [
    { key: "ready", label: "Marquer prêtes", report: ready ? null : groupBlockedReport(selected, "ready") },
    { key: "ship", label: "Remettre au transporteur", report: ship ? null : groupBlockedReport(selected, "in_transit") },
  ].flatMap((b) => (b.report ? [{ ...b, report: b.report }] : []));
  const blockedTitle = (r: ReturnType<typeof groupBlockedReport>) => (r ? r.reasons.map((x) => x.text).join(" ") : undefined);

  const deselect = () => grid.current?.deselectAll();

  async function start(c: StatusChange) {
    if (needsDialog(c)) {
      setChange(c);
      return;
    }
    if ((await action.run(sendStatusChange(c, null, null), changeDone(c))) === "done") deselect();
  }

  function checkOk(list: Machine[], withNote: string | null) {
    return action.run(
      () => api("POST", "/api/backoffice/machines/check-ok", { machineIds: list.map((m) => m.id), note: withNote }),
      `${machinesLabel(list.length)} contrôlée${list.length > 1 ? "s" : ""} OK.`,
    );
  }

  async function allOk() {
    // Corriger une machine déjà saisie dégradée ou défectueuse exige un motif (même règle que la base)
    if (toCheck.some((m) => machineChangeNeedsNote(m.logisticalStatus, m.logisticalStatus, m.functionalStatus, "ok"))) {
      setNote("");
      setAsk({ kind: "check", machines: toCheck });
      return;
    }
    if ((await checkOk(toCheck, null)) === "done") deselect();
  }

  async function confirmAsk() {
    if (!ask) return;
    const outcome =
      ask.kind === "check"
        ? await checkOk(ask.machines, note.trim() || null)
        : await action.run(
            () =>
              api("POST", `/api/backoffice/batches/${batch.id}/transfers`, {
                machineIds: ask.machines.map((m) => m.id),
                note: note.trim() || null,
              }),
            `${machinesLabel(ask.machines.length)} transférée${pluralS(ask.machines.length)} au lot de stock.`,
          );
    if (outcome === "done") {
      setAsk(null);
      deselect();
    }
  }

  const rowActions: MachineRowActions = {
    change: (c) => void start(c),
    control: setControl,
    editStart: action.clearFailure,
    rename: (m, serial) =>
      void action.run(
        () => api("PATCH", `/api/backoffice/machines/${m.id}`, { expectedUpdatedAt: m.updatedAt, serial }),
        serial ? `Numéro de série « ${serial} » enregistré.` : "Numéro de série effacé.",
      ),
  };

  const noteRequired = ask?.kind === "check";

  return (
    <section aria-labelledby={`${id}-title`} className="bo-stack">
      <div className="bo-card-head" style={{ marginBottom: 0 }}>
        <h2 id={`${id}-title`}>Machines</h2>
      </div>
      <div className="bo-toolbar">
        <div className="bo-actions" role="group" aria-label="Actions sur les machines cochées">
          <button type="button" className="bo-btn bo-btn-primary bo-btn-sm" disabled={toCheck.length === 0 || action.pending} onClick={allOk}>
            Tout OK{toCheck.length > 0 && ` (${toCheck.length})`}
          </button>
          <button type="button" className="bo-btn bo-btn-secondary bo-btn-sm" disabled={!ready || action.pending} title={blockedTitle(groupBlockedReport(selected, "ready"))} onClick={() => ready && start(ready)}>
            Marquer prêtes{ready && ` (${ready.machines.length})`}
          </button>
          <button type="button" className="bo-btn bo-btn-secondary bo-btn-sm" disabled={!ship || action.pending} title={blockedTitle(groupBlockedReport(selected, "in_transit"))} onClick={() => ship && start(ship)}>
            Remettre au transporteur{ship && ` (${ship.machines.length})`}
          </button>
          {batch.kind === "wholesale" && (
            <button
              type="button"
              className="bo-btn bo-btn-ghost bo-btn-sm"
              disabled={selected.length === 0 || action.pending}
              onClick={() => {
                setNote("");
                setAsk({ kind: "transfer", machines: selected });
              }}
            >
              Transférer au stock{selected.length > 0 && ` (${selected.length})`}
            </button>
          )}
        </div>
        <div className="bo-field bo-search">
          <label className="bo-label bo-visually-hidden" htmlFor={`${id}-filter`}>
            Filtrer les machines
          </label>
          <input
            id={`${id}-filter`}
            className="bo-input"
            type="search"
            placeholder="Filtrer : n° de série, statut, client…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
      {blockedReports.map((b) => (
        <p key={b.key} className="bo-hint" role="note" data-testid={`group-blocked-${b.key}`}>
          <strong>« {b.label} » est grisé :</strong>{" "}
          {b.report.reasons.map((r) => reasonText(r, b.report.machines.length > 1)).join(" ")}{" "}
          Machine{b.report.machines.length > 1 ? "s" : ""} bloquée{b.report.machines.length > 1 ? "s" : ""} :{" "}
          {b.report.machines.join(", ")}.
        </p>
      ))}
      {blockedReports.length === 0 && <p className="bo-hint">
        Cochez des machines pour les actions groupées. Pour saisir un numéro de série, sélectionnez sa case et tapez : Entrée
        enregistre et passe à la machine suivante.
      </p>}
      <Notice message={action.notice} />
      {!change && !control && !ask && <ErrorAlert failure={action.failure} />}

      {machines.length === 0 ? (
        <div className="bo-card bo-empty">
          <p>
            {batch.kind === "stock"
              ? "Aucune machine dans ce lot de stock : enregistrez un réassort ou transférez des machines depuis une palette."
              : "Les machines de la palette sont créées à son passage en « Attente de réception », une par place."}
          </p>
        </div>
      ) : (
        <MachinesGrid
          machines={machines}
          actions={rowActions}
          quickFilter={filter}
          onReady={(api) => (grid.current = api)}
          onSelection={setSelectedIds}
        />
      )}

      <StatusChangeDialog change={change} action={action} onClose={() => { setChange(null); deselect(); }} />
      <ControlDialog machine={control} action={action} onClose={() => setControl(null)} />
      <ConfirmDialog
        open={ask !== null}
        title={ask?.kind === "check" ? "Tout OK ?" : "Transférer au stock ?"}
        confirmLabel={ask?.kind === "check" ? "Tout OK" : "Transférer au stock"}
        cancelLabel="Ne rien changer"
        pending={action.pending}
        confirmDisabled={noteRequired && !note.trim()}
        onConfirm={confirmAsk}
        onClose={() => {
          action.clearFailure();
          setAsk(null);
        }}
      >
        {ask && (
          <>
            <p>
              {ask.kind === "check"
                ? `${machinesLabel(ask.machines.length)} passeront à « OK », toutes hashboards OK. Certaines avaient un autre état : indiquez pourquoi vous le corrigez.`
                : `${machinesLabel(ask.machines.length)} quitteront la palette pour le lot de stock du modèle (créé en pause s'il n'existe pas). Une machine attribuée à une commande doit d'abord en être retirée.`}
            </p>
            <div className="bo-field">
              <label className="bo-label" htmlFor={`${id}-note`}>
                {noteRequired ? "Motif" : "Note"}
                {!noteRequired && <span className="bo-optional"> (facultatif)</span>}
              </label>
              <textarea
                id={`${id}-note`}
                className="bo-textarea"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={ask.kind === "check" ? 1000 : 500}
                required={noteRequired}
                placeholder={ask.kind === "transfer" ? "Ex. invendus, palette bientôt close" : undefined}
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

function reasonText(reason: { text: string; count: number }, withCount: boolean): string {
  return withCount ? `${reason.text} (${plural(reason.count, "machine", "machines")})` : reason.text;
}
