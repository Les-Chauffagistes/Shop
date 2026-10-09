"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { nextAction } from "@/server/batch-status";
import type { BatchDetail } from "@/server/batches";
import { api, toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Notice } from "../ui";
import { UnsavedWarning } from "./UnsavedChanges";

type Transition = BatchDetail["transitions"][number];

/**
 * Explication des blocages qui ne se lèvent qu'avec un écran pas encore livré : sans elle,
 * l'admin cherche une action qui n'existe pas. À retirer quand l'écran concerné arrive
 * (saisie des machines au jalon 5, remboursements au jalon 4).
 */
function unavailableFeature(status: BatchDetail["status"], t: Transition): string | null {
  if (t.allowed) return null;
  if (status === "awaiting_reception" && t.to === "inspection") {
    return "La saisie des machines reçues n'est pas encore disponible dans le backoffice : elle arrivera dans un prochain jalon. D'ici là, le lot reste à « Attente de réception ».";
  }
  if (t.kind === "cancel") {
    return "Pour annuler un lot qui a des commandes payées, annulez d'abord ces commandes depuis leurs factures (« Annuler des machines », section Factures du lot).";
  }
  return null;
}

/**
 * Boutons de changement de statut, tels que fournis par l'API (`transitions`) : l'UI n'invente
 * aucune règle, elle affiche les bloquants, fait confirmer les avertissements et exige le motif.
 */
export function TransitionPanel({ batch }: { batch: Pick<BatchDetail, "id" | "status" | "statusLabel" | "transitions"> }) {
  const router = useRouter();
  const id = useId();
  const [selected, setSelected] = useState<Transition | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [stale, setStale] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noteTouched, setNoteTouched] = useState(false);

  const primary = nextAction(batch.transitions);

  function open(t: Transition) {
    setSelected(t);
    setNote("");
    setNoteTouched(false);
    setFailure(null);
    setNotice(null);
  }

  async function confirm() {
    if (!selected) return;
    if (selected.noteRequired && !note.trim()) {
      setNoteTouched(true);
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await api("POST", `/api/backoffice/batches/${batch.id}/transitions`, {
        to: selected.to,
        from: batch.status,
        note: note.trim() || null,
      });
      setNotice(`Statut changé : « ${selected.toLabel} ».`);
      setSelected(null);
      router.refresh();
    } catch (error) {
      const f = toFailure(error);
      if (f.code === "batch_status_changed") {
        // Le statut a bougé ailleurs : on ferme et on propose de recharger plutôt que de réessayer à l'aveugle
        setStale(f);
        setSelected(null);
      } else {
        setFailure(f);
      }
    } finally {
      setPending(false);
    }
  }

  function reload() {
    setStale(null);
    router.refresh();
  }

  if (batch.transitions.length === 0) {
    return (
      <div className="bo-next">
        <p className="bo-next-label">Prochaine action</p>
        <p className="bo-muted">Lot terminé : aucune action possible.</p>
      </div>
    );
  }

  const noteId = `${id}-note`;
  const noteError = selected?.noteRequired && noteTouched && !note.trim() ? "Indiquez le motif de ce changement." : null;

  return (
    <div className="bo-next" aria-labelledby={`${id}-label`} role="group">
      <p className="bo-next-label" id={`${id}-label`}>
        Prochaine action
      </p>
      {stale && (
        <div className="bo-alert bo-alert-warning" role="alert" style={{ marginBottom: 14 }}>
          {stale.message}
          <div>
            <button type="button" className="bo-btn bo-btn-secondary bo-btn-sm" onClick={reload}>
              Recharger le lot
            </button>
          </div>
        </div>
      )}
      <Notice message={notice} />
      {batch.transitions.map((t) => {
        const blockersId = `${id}-${t.to}-blockers`;
        const upcoming = unavailableFeature(batch.status, t);
        const upcomingId = `${id}-${t.to}-upcoming`;
        const describedBy = [t.blockers.length > 0 ? blockersId : null, upcoming ? upcomingId : null]
          .filter(Boolean)
          .join(" ");
        const tone =
          t.kind === "cancel" ? "bo-btn-danger" : t === primary ? "bo-btn-primary" : "bo-btn-secondary";
        return (
          <div key={t.to} className="bo-transition">
            <button
              type="button"
              className={`bo-btn ${tone}`}
              disabled={!t.allowed}
              aria-describedby={describedBy || undefined}
              onClick={() => open(t)}
            >
              {t.action}
            </button>
            {t.blockers.length > 0 && (
              <ul className="bo-blockers" id={blockersId}>
                {t.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {upcoming && (
              <p className="bo-upcoming" id={upcomingId}>
                {upcoming}
              </p>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={selected !== null}
        title={selected ? `${selected.action} ?` : ""}
        confirmLabel={selected?.kind === "cancel" ? "Annuler le lot" : "Confirmer"}
        confirmTone={selected?.kind === "cancel" ? "danger" : "primary"}
        cancelLabel="Ne rien changer"
        pending={pending}
        onConfirm={confirm}
        onClose={() => setSelected(null)}
      >
        {selected && (
          <>
            <p>
              Le lot passera du statut « {batch.statusLabel} » à « {selected.toLabel} ».
              {selected.kind === "backward" && " Ce retour arrière sera inscrit au journal."}
            </p>
            <UnsavedWarning action="changer de statut" />
            {selected.cancelsPendingOrders > 0 && (
              <div className="bo-alert bo-alert-warning" role="note">
                <strong>
                  {selected.cancelsPendingOrders === 1
                    ? "1 facture en attente sera annulée."
                    : `${selected.cancelsPendingOrders} factures en attente seront annulées.`}
                </strong>{" "}
                Elles n&apos;ont reçu aucun versement : leur réservation est libérée, elles ne sont pas supprimées. Un
                versement reçu ensuite restera « à traiter ».
              </div>
            )}
            {selected.warnings.length > 0 && (
              <div className="bo-alert bo-alert-warning">
                <strong>À vérifier avant de confirmer :</strong>
                <ul>
                  {selected.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="bo-field">
              <label className="bo-label" htmlFor={noteId}>
                {selected.noteRequired ? "Motif" : "Note"}
                {!selected.noteRequired && <span className="bo-optional"> (facultatif)</span>}
              </label>
              <textarea
                id={noteId}
                className="bo-textarea"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onBlur={() => setNoteTouched(true)}
                maxLength={1000}
                required={selected.noteRequired}
                aria-invalid={noteError ? true : undefined}
                aria-describedby={noteError ? `${noteId}-error` : undefined}
                placeholder={selected.noteRequired ? "Pourquoi ce changement ?" : "Ex. annonce publiée sur Discord"}
              />
              {noteError && (
                <span className="bo-field-error" id={`${noteId}-error`}>
                  {noteError}
                </span>
              )}
            </div>
            <ErrorAlert failure={failure} />
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
