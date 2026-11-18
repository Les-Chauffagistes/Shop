"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { batchStatusLabel, nextAction } from "@/server/batch-status";
import type { BatchDetail } from "@/server/batches";
import { api, toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Notice } from "../ui";
import { UnsavedWarning } from "./UnsavedChanges";

type Transition = BatchDetail["transitions"][number];

/**
 * Où lever un blocage qui se règle sur un autre écran : sans cette indication, l'admin cherche une action qui
 * n'existe pas ici.
 */
function unblockHint(t: Transition): string | null {
  if (t.allowed) return null;
  if (t.kind === "cancel") {
    return "Pour annuler un lot qui a des commandes payées, annulez d'abord ces commandes depuis leurs factures (« Annuler des machines », section Factures du lot).";
  }
  return null;
}

type Detail = { orderId?: string; position?: number; machineId?: string; serial?: string | null; machineSerial?: string | null; problem?: string; lineId?: string };

const BLOCK_TITLES: Record<string, { machines?: string; lines?: string }> = {
  inspection_expected_machines: { machines: "Machines encore attendues : marquez-les reçues ou manquantes (onglet Machines) :" },
  inspection_surplus_orders: { lines: "Commandes payées en trop : remboursez-les ou rendez des machines utilisables :" },
  inspection_lines_to_replace: { lines: "Lignes dont la machine est défectueuse ou perdue : remplacez-la ou remboursez :" },
  packaging_unassigned_lines: { lines: "Lignes payées sans machine : attribuez-leur une machine :" },
};

/** Machines ou lignes qui bloquent la sortie du Contrôle (`details.machines` / `details.lines`), sur le modèle de `missing-lines`. */
function ExitBlockers({ failure, batchId }: { failure: ApiFailure; batchId: string }) {
  const title = BLOCK_TITLES[failure.code];
  if (!title) return null;
  const list = (key: "machines" | "lines"): Detail[] => (Array.isArray(failure.details?.[key]) ? (failure.details![key] as Detail[]) : []);
  const machines = title.machines ? list("machines") : [];
  const lines = title.lines ? list("lines") : [];
  return (
    <div data-testid="exit-blockers">
      <p style={{ marginTop: 6 }}>{title.machines ?? title.lines}</p>
      <ul>
        {machines.map((m) => (
          <li key={m.machineId}>
            <Link href={`/backoffice/machines/${m.machineId}`}>{m.serial ?? "Machine sans numéro"}</Link>
          </li>
        ))}
        {lines.map((l) => (
          <li key={l.lineId ?? `${l.orderId}-${l.position}`}>
            <Link href={`/backoffice/factures/${l.orderId}`}>Facture · machine {l.position}</Link>
            {l.machineSerial && <> (machine {l.machineSerial})</>}
            {l.problem && <> : {l.problem === "lost" ? "perdue" : "défectueuse"}</>}
          </li>
        ))}
      </ul>
      <p>
        <Link href={`/backoffice/lots/${batchId}?onglet=machines`}>Ouvrir les machines du lot</Link>
      </p>
    </div>
  );
}

/**
 * Boutons de changement de statut, tels que fournis par l'API (`transitions`) : l'UI n'invente
 * aucune règle, elle affiche les bloquants, fait confirmer les avertissements et exige le motif.
 */
export function TransitionPanel({ batch }: Readonly<{ batch: Pick<BatchDetail, "id" | "kind" | "status" | "statusLabel" | "transitions"> }>) {
  const router = useRouter();
  const id = useId();
  const [selected, setSelected] = useState<Transition | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [stale, setStale] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noteTouched, setNoteTouched] = useState(false);
  /** Alertes de la transition faite (ex. clôture d'une palette qui attendait encore des machines) */
  const [warnings, setWarnings] = useState<string[]>([]);

  const primary = nextAction(batch.transitions);
  // `toLabel` nomme le statut technique (« Brouillon ») : un lot de stock hors vente se dit « En pause »
  const targetLabel = (t: Transition) => batchStatusLabel(batch.kind, t.to);

  function open(t: Transition) {
    setSelected(t);
    setNote("");
    setNoteTouched(false);
    setFailure(null);
    setNotice(null);
    setWarnings([]);
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
      const done = await api<{ warnings?: { message: string }[] }>("POST", `/api/backoffice/batches/${batch.id}/transitions`, {
        to: selected.to,
        from: batch.status,
        note: note.trim() || null,
      });
      setWarnings((done?.warnings ?? []).map((w) => w.message));
      setNotice(`Statut changé : « ${targetLabel(selected)} ».`);
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
      {warnings.length > 0 && (
        <div className="bo-alert bo-alert-warning" role="alert" style={{ marginBottom: 14 }}>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {batch.transitions.map((t) => {
        const blockersId = `${id}-${t.to}-blockers`;
        const upcoming = unblockHint(t);
        const upcomingId = `${id}-${t.to}-upcoming`;
        const describedBy = [t.blockers.length > 0 ? blockersId : null, upcoming ? upcomingId : null]
          .filter(Boolean)
          .join(" ");
        let tone = "bo-btn-secondary";
        if (t.kind === "cancel") tone = "bo-btn-danger";
        else if (t === primary) tone = "bo-btn-primary";
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
            {!t.allowed && t === primary && batch.status !== "draft" && (
              <Link className="bo-upcoming" href={`/backoffice/lots/${batch.id}?onglet=machines`}>
                Machines du lot : réception, contrôle, attribution →
              </Link>
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
              Le lot passera du statut « {batch.statusLabel} » à « {targetLabel(selected)} ».
              {selected.kind === "backward" && " Ce retour arrière sera inscrit au journal."}
            </p>
            <UnsavedWarning action="changer de statut" />
            {/* Factures annulées par la transition : annoncées par `warnings` (le serveur donne aussi le compte, `cancelsPendingOrders`) */}
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
            {selected.kind !== "pause" && (
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
            )}
            <ErrorAlert failure={failure}>{failure && <ExitBlockers failure={failure} batchId={batch.id} />}</ErrorAlert>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
