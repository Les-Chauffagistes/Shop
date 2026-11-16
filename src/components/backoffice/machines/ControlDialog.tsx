"use client";

import { useId, useState } from "react";
import type { MachineFunctionalStatus } from "../../../../prisma/generated/enums";
import { HASHBOARD_LABELS, MACHINE_FUNCTIONAL_LABELS, machineChangeNeedsNote } from "@/server/machine-status";
import { api } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Field } from "../ui";
import type { MachineAction } from "./useMachineAction";
import { machineName, type Machine } from "./types";

type Board = keyof typeof HASHBOARD_LABELS;
type State = Exclude<MachineFunctionalStatus, "unknown">;

const STATES: State[] = ["ok", "degraded", "faulty"];
const BOARDS = Object.keys(HASHBOARD_LABELS) as Board[];

/** Choix exclusif au clavier (flèches), en pastilles. */
function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="bo-field" style={{ border: 0 }}>
      <legend className="bo-label">{legend}</legend>
      <div className="bo-segmented">
        {options.map((o) => (
          <label key={o.value}>
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Contrôle d'une machine en main : état fonctionnel et hashboards une par une. Un changement d'état passe par le
 * journal (`POST /machines/status`, hashboards dans le même appel ; « OK » saisit d'office les hashboards non
 * données) ; une correction de hashboards sans changer l'état, par `PUT …/hashboards`. Motif exigé pour corriger
 * un état déjà saisi (machineChangeNeedsNote, même règle que la base). Le serveur vérifie la cohérence.
 */
export function ControlDialog({ machine, action, onClose }: { machine: Machine | null; action: MachineAction; onClose: () => void }) {
  const id = useId();
  const [opened, setOpened] = useState<Machine | null>(null);
  const [state, setState] = useState<State>("ok");
  const [boards, setBoards] = useState<(Board | null)[]>([]);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [serial, setSerial] = useState("");

  if (machine !== opened) {
    setSerial("");
    setOpened(machine);
    setState(machine && machine.functionalStatus !== "unknown" ? machine.functionalStatus : "ok");
    setBoards(machine ? machine.hashboards.map((h) => h.status) : []);
    setNote("");
    setTouched(false);
  }

  const noteRequired = machine
    ? machineChangeNeedsNote(machine.logisticalStatus, machine.logisticalStatus, machine.functionalStatus, state)
    : false;
  const noteError = noteRequired && touched && !note.trim() ? "Indiquez pourquoi vous corrigez l'état de la machine." : null;

  // « OK » avec une hashboard morte ou dégradée : le serveur refuserait, et ne jamais la repasser à OK d'office
  const conflict =
    state === "ok" && boards.some((b) => b === "dead" || b === "degraded")
      ? "Une hashboard est morte ou dégradée : choisissez l'état « Dégradée » ou « Défectueuse », ou corrigez la hashboard."
      : state !== "faulty" && boards.some((b) => b === "dead")
        ? "Une hashboard morte impose l'état « Défectueuse »."
        : null;

  async function confirm() {
    if (!machine) return;
    setTouched(true);
    if (conflict || (noteRequired && !note.trim())) return;
    // Hashboards modifiées, et celles à ressaisir depuis le retour en main (recontrôle)
    const changed = boards.flatMap((status, index) => {
      const saved = machine.hashboards[index];
      return status !== null && (status !== saved.status || !saved.current) ? [{ index, status }] : [];
    });
    // Numéro de série obligatoire : saisi ici pour une machine qui n'en a pas encore, avant le contrôle
    const newSerial = machine.serial ? null : serial.trim();
    if (!machine.serial && !newSerial) return;
    const stateChanged = state !== machine.functionalStatus;
    if (!stateChanged && changed.length === 0 && !newSerial) {
      onClose();
      return;
    }
    const outcome = await action.run(
      async (confirmRefunds) => {
        if (newSerial) await api("PATCH", `/api/backoffice/machines/${machine.id}`, { expectedUpdatedAt: machine.updatedAt, serial: newSerial });
        return stateChanged
          ? api("POST", "/api/backoffice/machines/status", {
              items: [
                {
                  machineId: machine.id,
                  from: { logistical: machine.logisticalStatus, functional: machine.functionalStatus },
                  to: { functional: state },
                  hashboards: changed,
                  note: note.trim() || null,
                },
              ],
              confirmRefunds,
            })
          : api("PUT", `/api/backoffice/machines/${machine.id}/hashboards`, { hashboards: changed });
      },
      stateChanged ? `Machine contrôlée : « ${MACHINE_FUNCTIONAL_LABELS[state]} ».` : "Hashboards enregistrées.",
    );
    if (outcome !== "failed") onClose();
  }

  return (
    <ConfirmDialog
      open={machine !== null}
      title={machine ? `Contrôler la machine ${machineName(machine)}` : ""}
      confirmLabel="Enregistrer le contrôle"
      confirmDisabled={conflict !== null}
      pending={action.pending}
      onConfirm={confirm}
      onClose={() => {
        action.clearFailure();
        onClose();
      }}
    >
      {machine && (
        <>
          {!machine.serial && (
            <Field label="Numéro de série (obligatoire)" error={touched && !serial.trim() ? "Saisissez le numéro de série de la machine." : undefined}>
              {(p) => (
                <input {...p} className="bo-input bo-mono" value={serial} maxLength={100} autoComplete="off" spellCheck={false}
                  onChange={(e) => setSerial(e.target.value)} />
              )}
            </Field>
          )}
          <Segmented
            legend="État de la machine"
            name={`${id}-state`}
            value={state}
            options={STATES.map((s) => ({ value: s, label: MACHINE_FUNCTIONAL_LABELS[s] }))}
            onChange={setState}
          />
          <p className="bo-hint">
            « OK » marque d&apos;office OK les hashboards laissées vides. Une hashboard dégradée ou morte impose l&apos;état
            « Dégradée » ou « Défectueuse ».
          </p>
          {conflict && (
            <div className="bo-alert bo-alert-warning" role="alert">
              {conflict}
            </div>
          )}
          {boards.map((status, index) => (
            <Segmented
              key={index}
              legend={`Hashboard ${index + 1}${machine.hashboards[index].status && !machine.hashboards[index].current ? " (à ressaisir)" : ""}`}
              name={`${id}-board-${index}`}
              value={status}
              options={BOARDS.map((b) => ({ value: b, label: HASHBOARD_LABELS[b] }))}
              onChange={(value) => setBoards(boards.map((s, i) => (i === index ? value : s)))}
            />
          ))}
          <div className="bo-field">
            <label className="bo-label" htmlFor={`${id}-note`}>
              {noteRequired ? "Motif de la correction" : "Note"}
              {!noteRequired && <span className="bo-optional"> (facultatif)</span>}
            </label>
            <textarea
              id={`${id}-note`}
              className="bo-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => setTouched(true)}
              maxLength={1000}
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
