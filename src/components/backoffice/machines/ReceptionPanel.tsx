"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { machines as machinesLabel } from "@/lib/plural";
import { api } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Field, Notice } from "../ui";
import { useMachineAction, type MachineAction } from "./useMachineAction";

/** Lignes non vides d'un collage (une colonne de numéros de série, une machine par ligne). */
const serialLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** `422 serial_required` : le numéro de série est obligatoire dès la réception (`details.machineIds` : machines sans numéro). */
function SerialRequired({ failure }: Readonly<{ failure: NonNullable<MachineAction["failure"]> }>) {
  const ids = failure.details?.machineIds;
  if (failure.code !== "serial_required") return null;
  return (
    <p style={{ marginTop: 6 }} data-testid="serial-required">
      Saisissez le numéro de série de chaque machine reçue{Array.isArray(ids) && ids.length > 0 ? ` (${ids.length} sans numéro)` : ""} : une ligne par
      machine dans le champ « Numéros de série ».
    </p>
  );
}

/**
 * Réception des machines attendues d'un lot : collage d'une colonne de numéros de série (les machines attendues
 * les plus anciennes les reçoivent dans l'ordre) ; le numéro est obligatoire. « Tout recevoir » ne vaut que pour des
 * machines dont le numéro est déjà saisi. Palette : « Machine en plus »
 * pour une machine livrée au-delà de la quantité (elle part au lot de stock du modèle).
 */
export function ReceptionPanel({ batch, expected, canReceiveExtra }: Readonly<{ batch: { id: string; kind: "wholesale" | "stock" }; expected: number; canReceiveExtra: boolean }>) {
  const id = useId();
  const action = useMachineAction();
  const [serials, setSerials] = useState("");
  const [extraOpen, setExtraOpen] = useState(false);
  const [extraSerials, setExtraSerials] = useState("");
  const [extraNote, setExtraNote] = useState("");
  const [stockBatchId, setStockBatchId] = useState<string | null>(null);

  const lines = serialLines(serials);

  async function receive(body: { serials: string[] } | Record<string, never>, count: number) {
    const outcome = await action.run(
      () => api("POST", `/api/backoffice/batches/${batch.id}/receptions`, body),
      `${machinesLabel(count)} reçue${count > 1 ? "s" : ""} : à contrôler.`,
    );
    if (outcome === "done") setSerials("");
  }

  async function receiveExtra() {
    const list = serialLines(extraSerials);
    const outcome = await action.run(
      () =>
        api<{ stockBatchId: string; machines: unknown[] }>("POST", `/api/backoffice/batches/${batch.id}/extra-machines`, {
          ...(list.length > 0 ? { serials: list } : { count: 1 }),
          note: extraNote.trim() || null,
        }),
      (r) => {
        setStockBatchId(r.stockBatchId);
        return `${machinesLabel(r.machines.length)} en plus enregistrée${r.machines.length > 1 ? "s" : ""} au lot de stock du modèle, à contrôler.`;
      },
    );
    if (outcome === "done") {
      setExtraOpen(false);
      setExtraSerials("");
      setExtraNote("");
    }
  }

  return (
    <section className="bo-card" aria-labelledby={`${id}-title`}>
      <div className="bo-card-head">
        <div>
          <h2 id={`${id}-title`}>Réception</h2>
          <p>{expected > 0 ? `${machinesLabel(expected)} attendue${expected > 1 ? "s" : ""}.` : "Aucune machine attendue."}</p>
        </div>
        {batch.kind === "wholesale" && (
          <button
            type="button"
            className="bo-btn bo-btn-ghost bo-btn-sm"
            disabled={!canReceiveExtra}
            title={canReceiveExtra ? undefined : "Utile seulement quand toutes les machines attendues de la palette sont reçues."}
            onClick={() => setExtraOpen(true)}
          >
            Machine en plus…
          </button>
        )}
      </div>
      <Notice message={action.notice} />
      {stockBatchId && action.notice && (
        <p className="bo-hint">
          <Link href={`/backoffice/lots/${stockBatchId}?onglet=machines`}>Voir le lot de stock</Link>
        </p>
      )}
      {!extraOpen && (
        <ErrorAlert failure={action.failure}>{action.failure && <SerialRequired failure={action.failure} />}</ErrorAlert>
      )}
      {expected > 0 && (
        <form
          className="bo-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (lines.length > 0) void receive({ serials: lines }, lines.length);
          }}
        >
          <Field
            label="Numéros de série (obligatoires)"
            hint="Un numéro par machine reçue. Collez une colonne (une ligne par machine) depuis un tableur ou un lecteur de codes-barres."
          >
            {(p) => (
              <textarea
                {...p}
                className="bo-textarea bo-mono"
                rows={5}
                value={serials}
                onChange={(e) => setSerials(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            )}
          </Field>
          <div className="bo-actions">
            <button type="submit" className="bo-btn bo-btn-primary" disabled={lines.length === 0 || action.pending}>
              {lines.length > 0 ? `Recevoir ${machinesLabel(lines.length)}` : "Recevoir"}
            </button>
            <button type="button" className="bo-btn bo-btn-secondary" disabled={action.pending} onClick={() => receive({}, expected)}>
              Tout recevoir, numéros déjà saisis ({expected})
            </button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={extraOpen}
        title="Machine en plus ?"
        confirmLabel="Enregistrer"
        pending={action.pending}
        onConfirm={receiveExtra}
        onClose={() => {
          action.clearFailure();
          setExtraOpen(false);
        }}
      >
        <p>
          Machine livrée au-delà de la quantité de la palette : elle est créée reçue (à contrôler) dans le lot de stock du
          modèle, créé en pause s&apos;il n&apos;existe pas. Recevez d&apos;abord les machines attendues de la palette.
        </p>
        <Field label="Numéros de série (obligatoires)" hint="Une ligne par machine reçue en plus.">
          {(p) => (
            <textarea {...p} className="bo-textarea bo-mono" rows={3} value={extraSerials} onChange={(e) => setExtraSerials(e.target.value)} spellCheck={false} />
          )}
        </Field>
        <Field label="Note" optional>
          {(p) => (
            <input {...p} className="bo-input" value={extraNote} maxLength={500} onChange={(e) => setExtraNote(e.target.value)} placeholder="Ex. dans le colis, non facturée" />
          )}
        </Field>
        <ErrorAlert failure={action.failure}>{action.failure && <SerialRequired failure={action.failure} />}</ErrorAlert>
      </ConfirmDialog>
    </section>
  );
}
