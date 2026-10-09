"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { BatchDetail } from "@/server/batches";
import { formatTime } from "@/lib/dates";
import { Notice } from "../ui";
import { applicableDraft, BatchForm, describeDraft, type BatchDraft } from "./BatchForm";

type Models = Parameters<typeof BatchForm>[0]["models"];

/** Saisie refusée parce que le lot a changé entre-temps, en attendant que l'admin décide quoi en faire. */
type Conflict = { message: string; draft: BatchDraft; staleUpdatedAt: string };

/**
 * Dernière version du lot renvoyée par une action du formulaire, avec la clé du formulaire qui
 * l'affiche : celle du formulaire en place s'il l'a reprise lui-même (enregistrement), une
 * nouvelle sinon (le formulaire est recréé sur cette version).
 */
type Latest = { batch: BatchDetail; key: string };

/** `updatedAt` est en ISO 8601 UTC à format fixe (microsecondes) : l'ordre des chaînes est chronologique. */
const isNewer = (a: BatchDetail, b: BatchDetail) => a.updatedAt > b.updatedAt;

/**
 * Réglages d'un lot existant. Ce composant n'est pas remonté au rafraîchissement : il porte la
 * confirmation d'enregistrement, les saisies refusées pour cause de modification concurrente, et
 * décide quand recréer le formulaire. Une version venue d'ailleurs (changement de statut, autre
 * administrateur, rechargement après conflit) le recrée ; la version produite par son propre
 * enregistrement, déjà reprise en place, ne le recrée pas, même quand le rafraîchissement de la
 * page arrive après une nouvelle saisie (il l'écraserait sinon).
 */
export function BatchSettings({ batch: fromServer, models }: { batch: BatchDetail; models: Models }) {
  const router = useRouter();
  const [reloading, startReload] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  /** Saisies reprises sur la version `updatedAt` du lot */
  const [applied, setApplied] = useState<{ draft: BatchDraft; updatedAt: string; n: number } | null>(null);
  const [latest, setLatest] = useState<Latest | null>(null);

  // Version affichée : la plus récente entre la page (rafraîchie) et la dernière réponse d'une action.
  // Un rafraîchissement plus ancien que cette réponse (lancé avant elle) est ignoré.
  const ownVersion = latest !== null && !isNewer(fromServer, latest.batch);
  const batch = ownVersion ? latest.batch : fromServer;

  // La version affichée est-elle plus récente que celle sur laquelle la saisie a été refusée ?
  const reloaded = conflict !== null && batch.updatedAt !== conflict.staleUpdatedAt;
  const draft = applied && applied.updatedAt === batch.updatedAt ? applied.draft : undefined;
  const formKey = ownVersion ? latest.key : `${batch.updatedAt}:${draft ? applied?.n : 0}`;

  function reload() {
    startReload(() => router.refresh());
  }

  function reapply() {
    if (!conflict) return;
    setApplied({ draft: applicableDraft(conflict.draft, batch), updatedAt: batch.updatedAt, n: (applied?.n ?? 0) + 1 });
    setConflict(null);
    setNotice(null);
  }

  const lines = conflict ? describeDraft(conflict.draft, batch, models) : [];
  const kept = conflict ? describeDraft(applicableDraft(conflict.draft, batch), batch, models) : [];
  const lost = lines.filter((line) => !kept.includes(line));

  return (
    <>
      {draft && (
        <p className="bo-alert bo-alert-info" style={{ marginBottom: 16 }}>
          Vos saisies sont reportées sur la version actuelle du lot. Vérifiez-les, puis enregistrez.
        </p>
      )}
      <BatchForm
        key={formKey}
        batch={batch}
        models={models}
        draft={draft}
        onSubmitStart={() => setNotice(null)}
        onSaved={(saved, message, adopted) => {
          setLatest({ batch: saved, key: adopted ? formKey : `${saved.updatedAt}:0` });
          setConflict(null);
          setApplied(null);
          setNotice(message ?? `Lot enregistré à ${formatTime(saved.updatedAt)}.`);
        }}
        onConflict={(message, refused) => {
          setConflict({ message, draft: refused, staleUpdatedAt: batch.updatedAt });
        }}
      />
      {conflict && !reloaded && (
        <div className="bo-alert bo-alert-warning" role="alert" style={{ marginTop: 16 }}>
          <strong>{conflict.message}</strong>
          <p style={{ marginTop: 4 }}>
            Vos saisies restent affichées dans le formulaire. Rechargez le lot pour voir sa version actuelle : vous
            pourrez ensuite les reprendre.
          </p>
          <button type="button" className="bo-btn bo-btn-secondary bo-btn-sm" onClick={reload} disabled={reloading}>
            {reloading ? "Rechargement…" : "Recharger le lot"}
          </button>
        </div>
      )}
      {conflict && reloaded && lines.length > 0 && (
        <section className="bo-alert bo-alert-info" aria-labelledby="unsaved-title" style={{ marginTop: 16 }}>
          <strong id="unsaved-title">Vos saisies non enregistrées</strong>
          <p style={{ marginTop: 4 }}>
            Le formulaire affiche maintenant la version actuelle du lot. Vos saisies refusées :
          </p>
          <ul>
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {lost.length > 0 && (
            <p style={{ marginTop: 6 }}>
              Certaines ne peuvent plus être reprises telles quelles (champ désormais figé ou modèle changé) : reportez-les
              à la main si besoin.
            </p>
          )}
          <div className="bo-actions">
            <button type="button" className="bo-btn bo-btn-primary bo-btn-sm" onClick={reapply}>
              Reprendre mes saisies
            </button>
            <button type="button" className="bo-btn bo-btn-ghost bo-btn-sm" onClick={() => setConflict(null)}>
              Les abandonner
            </button>
          </div>
        </section>
      )}
      <div style={{ marginTop: 12 }}>
        <Notice message={notice} />
      </div>
    </>
  );
}
