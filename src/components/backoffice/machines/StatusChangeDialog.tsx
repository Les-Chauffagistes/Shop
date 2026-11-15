"use client";

import { useId, useState } from "react";
import type { MachineLogisticalStatus } from "../../../../prisma/generated/enums";
import { machines as machinesLabel } from "@/lib/plural";
import { api } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Field } from "../ui";
import type { MachineAction } from "./useMachineAction";
import type { Machine } from "./types";

/** Changement de statut logistique demandé pour une ou plusieurs machines (libellés et motif : `nextChanges`). */
export type StatusChange = { machines: Machine[]; to: MachineLogisticalStatus; action: string; toLabel: string; noteRequired: boolean };

type Tracking = { carrier: string; trackingNumber: string; trackingUrl: string };

/** `POST /machines/status` : une ligne par machine, statuts affichés en `from` (le serveur refuse s'ils ont changé). */
export function sendStatusChange(change: StatusChange, note: string | null, tracking: Tracking | null) {
  return (confirmRefunds?: string[]) =>
    api("POST", "/api/backoffice/machines/status", {
      items: change.machines.map((m) => ({
        machineId: m.id,
        from: { logistical: m.logisticalStatus, functional: m.functionalStatus },
        to: { logistical: change.to },
        note,
        ...(tracking ? { tracking } : {}),
      })),
      confirmRefunds,
    });
}

/**
 * Changement groupé vers `to` : seulement les machines dont l'API propose ce changement (`nextChanges`, blocages
 * compris : le serveur tranche) ; motif exigé si l'une d'elles l'exige. `null` si aucune ne le propose.
 */
export function groupChange(selected: Machine[], to: MachineLogisticalStatus, action: string): StatusChange | null {
  const eligible = selected.filter((m) => m.nextChanges.some((c) => c.to === to));
  if (eligible.length === 0) return null;
  const changes = eligible.map((m) => m.nextChanges.find((c) => c.to === to)!);
  return { machines: eligible, to, action, toLabel: changes[0].toLabel, noteRequired: changes.some((c) => c.noteRequired) };
}

/** Message de succès d'un changement de statut. */
export const changeDone = (change: StatusChange) =>
  change.machines.length === 1
    ? `Machine passée à « ${change.toLabel} ».`
    : `${machinesLabel(change.machines.length)} passées à « ${change.toLabel} ».`;

/** Faut-il un dialogue (motif ou suivi du transporteur) ? Sinon le changement part en un clic. */
export const needsDialog = (change: StatusChange) => change.noteRequired || change.to === "in_transit";

/**
 * Dialogue d'un changement de statut qui demande une saisie : motif (obligatoire si `noteRequired`) ou suivi du
 * transporteur (remise au transporteur : transporteur, numéro et lien facultatifs, communs aux machines choisies).
 */
export function StatusChangeDialog({ change, action, onClose }: { change: StatusChange | null; action: MachineAction; onClose: () => void }) {
  const id = useId();
  const [note, setNote] = useState("");
  const [tracking, setTracking] = useState<Tracking>({ carrier: "", trackingNumber: "", trackingUrl: "" });
  const [touched, setTouched] = useState(false);
  const [opened, setOpened] = useState<StatusChange | null>(null);

  // Nouveau changement ouvert : saisies remises à zéro
  if (change !== opened) {
    setOpened(change);
    setNote("");
    setTracking({ carrier: "", trackingNumber: "", trackingUrl: "" });
    setTouched(false);
  }

  const noteError = change?.noteRequired && touched && !note.trim() ? "Indiquez le motif de ce changement." : null;
  const shipping = change?.to === "in_transit";

  async function confirm() {
    if (!change) return;
    setTouched(true);
    if (change.noteRequired && !note.trim()) return;
    const outcome = await action.run(sendStatusChange(change, note.trim() || null, shipping ? tracking : null), changeDone(change));
    if (outcome !== "failed") onClose();
  }

  return (
    <ConfirmDialog
      open={change !== null}
      title={change ? `${change.action} ?` : ""}
      confirmLabel={change?.action ?? "Confirmer"}
      cancelLabel="Ne rien changer"
      pending={action.pending}
      onConfirm={confirm}
      onClose={() => {
        action.clearFailure();
        onClose();
      }}
    >
      {change && (
        <>
          <p>
            {change.machines.length === 1
              ? `La machine ${change.machines[0].serial ?? "sans numéro"} passera à « ${change.toLabel} ».`
              : `${machinesLabel(change.machines.length)} passeront à « ${change.toLabel} ».`}
          </p>
          {shipping && (
            <div className="bo-fields">
              <Field label="Transporteur" optional>
                {(p) => (
                  <input {...p} className="bo-input" value={tracking.carrier} maxLength={100} autoComplete="off"
                    onChange={(e) => setTracking({ ...tracking, carrier: e.target.value })} placeholder="Ex. DHL" />
                )}
              </Field>
              <Field label="Numéro de suivi" optional>
                {(p) => (
                  <input {...p} className="bo-input" value={tracking.trackingNumber} maxLength={100} autoComplete="off"
                    onChange={(e) => setTracking({ ...tracking, trackingNumber: e.target.value })} />
                )}
              </Field>
              <Field label="Lien de suivi" optional wide hint="Adresse complète, commençant par https://">
                {(p) => (
                  <input {...p} className="bo-input" type="url" value={tracking.trackingUrl} maxLength={500} autoComplete="off"
                    onChange={(e) => setTracking({ ...tracking, trackingUrl: e.target.value })} />
                )}
              </Field>
            </div>
          )}
          <div className="bo-field">
            <label className="bo-label" htmlFor={`${id}-note`}>
              {change.noteRequired ? "Motif" : "Note"}
              {!change.noteRequired && <span className="bo-optional"> (facultatif)</span>}
            </label>
            <textarea
              id={`${id}-note`}
              className="bo-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => setTouched(true)}
              maxLength={1000}
              required={change.noteRequired}
              aria-invalid={noteError ? true : undefined}
              aria-describedby={noteError ? `${id}-note-error` : undefined}
            />
            {noteError && (
              <span className="bo-field-error" id={`${id}-note-error`}>
                {noteError}
              </span>
            )}
          </div>
          <ErrorAlert failure={action.failure} />
        </>
      )}
    </ConfirmDialog>
  );
}
