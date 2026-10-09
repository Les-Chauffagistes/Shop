"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Dialogue modal natif (<dialog>) : focus piégé et Échap gérés par le navigateur,
 * le focus revient sur l'élément déclencheur à la fermeture. Entrée dans un champ confirme.
 *
 * À rendre HORS de tout <form> : le dialogue contient son propre <form>, et un <form> imbriqué est
 * invalide en HTML (le rendu serveur supprime la balise intérieure, et la confirmation soumettrait
 * alors le formulaire extérieur, en GET). Tous les écrans existants placent le dialogue après la
 * balise fermante du formulaire (vérifié à la revue du jalon 4, voir docs/reviews/qualite-2026-10-09-jalon4.md).
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Annuler",
  confirmTone = "primary",
  pending,
  confirmDisabled,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  /** Libellé du bouton de fermeture (« Annuler » par défaut) */
  cancelLabel?: string;
  confirmTone?: "primary" | "danger";
  pending?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="bo-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        if (pending) e.preventDefault();
      }}
    >
      <form
        className="bo-dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="bo-dialog-actions">
          <button type="button" className="bo-btn bo-btn-secondary" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            type="submit"
            className={`bo-btn ${confirmTone === "danger" ? "bo-btn-danger" : "bo-btn-primary"}`}
            disabled={pending || confirmDisabled}
          >
            {pending ? "En cours…" : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
