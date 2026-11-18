"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, toFailure, type ApiFailure } from "../api";
import { ErrorAlert, Field, issueAt, Notice } from "../ui";
import type { Machine } from "./types";

const TRACKING: Key[] = ["carrier", "trackingNumber", "trackingUrl"];

type Key = "serial" | "psuSerial" | "carrier" | "trackingNumber" | "trackingUrl" | "note";

const FIELDS: readonly { key: Key; label: string; max: number; mono?: boolean }[] = [
  { key: "serial", label: "Numéro de série", max: 100, mono: true },
  { key: "psuSerial", label: "Numéro de l'alimentation", max: 100, mono: true },
  { key: "carrier", label: "Transporteur", max: 100 },
  { key: "trackingNumber", label: "Numéro de suivi", max: 100 },
  { key: "trackingUrl", label: "Lien de suivi", max: 500 },
  { key: "note", label: "Note", max: 1000 },
];

/** Valeur initiale d'un champ : le suivi vient de l'envoi de la facture (partagé par toutes ses machines). */
function initialValue(machine: Machine, key: Key): string {
  if (key === "carrier" || key === "trackingNumber" || key === "trackingUrl") return machine.shipment?.[key] ?? "";
  return machine[key] ?? "";
}

/**
 * Saisie directe d'une machine (numéros de série, suivi, note), `PATCH` avec la version affichée : le serveur refuse
 * si la machine a changé entre-temps. Seuls les champs modifiés sont envoyés ; un champ vidé est effacé.
 */
export function MachineEditForm({ machine }: Readonly<{ machine: Machine }>) {
  const router = useRouter();
  const initial = Object.fromEntries(FIELDS.map((f) => [f.key, initialValue(machine, f.key)])) as Record<Key, string>;
  const [values, setValues] = useState(initial);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Le suivi s'écrit sur la facture payée de la machine : sans facture, le serveur refuse (shipment_no_order)
  const fields = FIELDS.filter((f) => machine.line || !TRACKING.includes(f.key));
  const changed = fields.filter((f) => values[f.key].trim() !== initial[f.key]);

  async function submit(e: React.SubmitEvent) {
    e.preventDefault();
    if (changed.length === 0) return;
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const body: Record<string, string | null> = { expectedUpdatedAt: machine.updatedAt };
      for (const f of changed) body[f.key] = values[f.key].trim() || null;
      await api("PATCH", `/api/backoffice/machines/${machine.id}`, body);
      setNotice("Machine enregistrée.");
      router.refresh();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="bo-form" onSubmit={submit} noValidate>
      <div className="bo-fields">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} optional wide={f.key === "note" || f.key === "trackingUrl"} error={issueAt(failure, f.key)}>
            {(p) => (
              <input
                {...p}
                className={`bo-input${f.mono ? " bo-mono" : ""}`}
                type={f.key === "trackingUrl" ? "url" : "text"}
                value={values[f.key]}
                maxLength={f.max}
                autoComplete="off"
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      {machine.line && (
        <p className="bo-hint">Le suivi (transporteur, numéro, lien) est celui de la facture : il est commun à toutes ses machines.</p>
      )}
      <ErrorAlert failure={failure}>
        {failure?.code === "machine_modified" && (
          <div>
            <button type="button" className="bo-btn bo-btn-secondary bo-btn-sm" onClick={() => router.refresh()}>
              Recharger la machine
            </button>
          </div>
        )}
      </ErrorAlert>
      <Notice message={notice} />
      <div className="bo-actions">
        <button type="submit" className="bo-btn bo-btn-primary" disabled={pending || changed.length === 0}>
          {pending ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
    </form>
  );
}
