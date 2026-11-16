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
export type StatusChange = {
  machines: Machine[];
  to: MachineLogisticalStatus;
  action: string;
  toLabel: string;
  noteRequired: boolean;
  /** Machines cochées laissées de côté parce que l'API bloque ce changement pour elles (avec la raison) */
  skipped?: { machine: Machine; blockers: string[] }[];
};

type Tracking = { carrier: string; trackingNumber: string; trackingUrl: string };

const EMPTY_TRACKING: Tracking = { carrier: "", trackingNumber: "", trackingUrl: "" };

/** Clé de regroupement par facture (le suivi est unique par facture) ; machines sans facture : groupe vide. */
export const invoiceKey = (m: Machine) => m.line?.orderId ?? "";

/** Machines regroupées par facture, dans l'ordre de première apparition. */
export function groupByInvoice(machines: Machine[]): { key: string; machines: Machine[] }[] {
  const groups = new Map<string, Machine[]>();
  for (const m of machines) groups.set(invoiceKey(m), [...(groups.get(invoiceKey(m)) ?? []), m]);
  return [...groups].map(([key, ms]) => ({ key, machines: ms }));
}

/** Suivi de départ d'une facture : celui déjà enregistré sur son envoi, sinon vide. */
function initialTracking(machines: Machine[]): Tracking {
  const s = machines.find((m) => m.shipment)?.shipment;
  return { carrier: s?.carrier ?? "", trackingNumber: s?.trackingNumber ?? "", trackingUrl: s?.trackingUrl ?? "" };
}

/** Champs de suivi renseignés seulement (un champ vide ne doit pas effacer le suivi existant) ; `undefined` si aucun. */
function filled(t: Tracking | undefined): Partial<Tracking> | undefined {
  if (!t) return undefined;
  const out = Object.fromEntries(Object.entries(t).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `POST /machines/status` : une ligne par machine, statuts affichés en `from` (le serveur refuse s'ils ont changé). `trackings` : suivi par facture (`invoiceKey`). */
export function sendStatusChange(change: StatusChange, note: string | null, trackings: Record<string, Tracking> | null) {
  return (confirmRefunds?: string[]) =>
    api("POST", "/api/backoffice/machines/status", {
      items: change.machines.map((m) => ({
        machineId: m.id,
        from: { logistical: m.logisticalStatus, functional: m.functionalStatus },
        to: { logistical: change.to },
        note,
        ...(filled(trackings?.[invoiceKey(m)]) ? { tracking: filled(trackings?.[invoiceKey(m)]) } : {}),
      })),
      confirmRefunds,
    });
}

/**
 * Changement groupé vers `to` : seulement les machines dont l'API propose ce changement et ne le bloque pas
 * (`nextChanges`, `allowed`) ; les machines bloquées sont écartées et nommées avec leur raison (une seule machine
 * bloquée ferait refuser tout le lot). Motif exigé si l'une d'elles l'exige. `null` si aucune ne peut l'appliquer.
 */
export function groupChange(selected: Machine[], to: MachineLogisticalStatus, action: string): StatusChange | null {
  const offered = selected.flatMap((m) => {
    const c = m.nextChanges.find((n) => n.to === to);
    return c ? [{ machine: m, change: c }] : [];
  });
  const eligible = offered.filter((o) => o.change.allowed);
  if (eligible.length === 0) return null;
  const skipped = offered.filter((o) => !o.change.allowed).map((o) => ({ machine: o.machine, blockers: o.change.blockers }));
  return {
    machines: eligible.map((o) => o.machine),
    to,
    action,
    toLabel: eligible[0].change.toLabel,
    noteRequired: eligible.some((o) => o.change.noteRequired),
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

/** Message de succès d'un changement de statut. */
export const changeDone = (change: StatusChange) =>
  change.machines.length === 1
    ? `Machine passée à « ${change.toLabel} ».`
    : `${machinesLabel(change.machines.length)} passées à « ${change.toLabel} ».`;

/** Faut-il un dialogue (motif ou suivi du transporteur) ? Sinon le changement part en un clic. */
export const needsDialog = (change: StatusChange) => change.noteRequired || change.to === "in_transit" || !!change.skipped?.length;

/**
 * Dialogue d'un changement de statut qui demande une saisie : motif (obligatoire si `noteRequired`) ou suivi du
 * transporteur (remise au transporteur : transporteur, numéro et lien facultatifs, communs aux machines choisies).
 */
export function StatusChangeDialog({ change, action, onClose }: { change: StatusChange | null; action: MachineAction; onClose: () => void }) {
  const id = useId();
  const [note, setNote] = useState("");
  const [trackings, setTrackings] = useState<Record<string, Tracking>>({});
  const [touched, setTouched] = useState(false);
  const [opened, setOpened] = useState<StatusChange | null>(null);

  // Nouveau changement ouvert : saisies remises à zéro
  if (change !== opened) {
    setOpened(change);
    setNote("");
    setTrackings(
      Object.fromEntries(groupByInvoice(change?.machines ?? []).map((g) => [g.key, initialTracking(g.machines)])),
    );
    setTouched(false);
  }

  const noteError = change?.noteRequired && touched && !note.trim() ? "Indiquez le motif de ce changement." : null;
  const shipping = change?.to === "in_transit";

  async function confirm() {
    if (!change) return;
    setTouched(true);
    if (change.noteRequired && !note.trim()) return;
    const outcome = await action.run(sendStatusChange(change, note.trim() || null, shipping ? trackings : null), changeDone(change));
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
          {change.skipped && (
            <div className="bo-alert bo-alert-warning">
              <p>Écartée{change.skipped.length > 1 ? "s" : ""} de ce changement :</p>
              <ul>
                {change.skipped.map((s) => (
                  <li key={s.machine.id}>
                    {s.machine.serial ?? "Machine sans numéro"}
                    {s.blockers.length > 0 && <> : {s.blockers.join(" ")}</>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {shipping && (
            <>
              <p className="bo-hint">
                Toutes les machines d&apos;une facture partent ensemble, et le suivi est saisi une fois par facture
                (commun à ses machines).
              </p>
              {groupByInvoice(change.machines).map((g, i, all) => {
                const t = trackings[g.key] ?? EMPTY_TRACKING;
                const set = (patch: Partial<Tracking>) => setTrackings({ ...trackings, [g.key]: { ...t, ...patch } });
                return (
                  <fieldset key={g.key} className="bo-fields" style={{ border: 0, padding: 0, margin: 0 }}>
                    {all.length > 1 && (
                      <legend>
                        {g.key ? `Facture ${i + 1}` : "Sans facture"} : {machinesLabel(g.machines.length)}
                      </legend>
                    )}
                    <Field label="Transporteur" optional>
                      {(p) => (
                        <input {...p} className="bo-input" value={t.carrier} maxLength={100} autoComplete="off"
                          onChange={(e) => set({ carrier: e.target.value })} placeholder="Ex. DHL" />
                      )}
                    </Field>
                    <Field label="Numéro de suivi" optional>
                      {(p) => (
                        <input {...p} className="bo-input" value={t.trackingNumber} maxLength={100} autoComplete="off"
                          onChange={(e) => set({ trackingNumber: e.target.value })} />
                      )}
                    </Field>
                    <Field label="Lien de suivi" optional wide hint="Adresse complète, commençant par https://">
                      {(p) => (
                        <input {...p} className="bo-input" type="url" value={t.trackingUrl} maxLength={500} autoComplete="off"
                          onChange={(e) => set({ trackingUrl: e.target.value })} />
                      )}
                    </Field>
                  </fieldset>
                );
              })}
            </>
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
          <ErrorAlert failure={action.failure}>
            {action.failure?.code === "shipment_incomplete" && (
              <p>
                Une facture ne part que complète : attribuez d&apos;abord une machine à chaque ligne manquante (fiche de
                la facture), ou retirez de la sélection les machines de cette facture.
              </p>
            )}
          </ErrorAlert>
        </>
      )}
    </ConfirmDialog>
  );
}
