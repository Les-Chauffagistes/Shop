"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, toFailure, type ApiFailure } from "@/components/backoffice/api";
import { ConfirmDialog } from "@/components/backoffice/ConfirmDialog";
import { ErrorAlert } from "@/components/backoffice/ui";
import { formatDateTime } from "@/lib/dates";

/**
 * Retrait d'une manifestation d'intérêt, après confirmation. Le serveur décide, et son refus éventuel
 * est affiché dans le dialogue. Déjà retirée (404) : traité comme un succès. Une machine déjà commandée
 * n'a pas ce bouton (elle se gère depuis la commande) ; le serveur la refuserait de toute façon
 * (409 wishlist_converted).
 */
export function RemoveWishlist({
  wishlistId,
  label,
  surveyOpen,
  priorityEndsAt = null,
  afterRemoveHref,
}: {
  wishlistId: string;
  /** Machine concernée, pour le titre du bouton et le dialogue (« S19, machine n° 2 ») */
  label: string;
  /** Lot encore au sondage : l'intérêt pourra être manifesté de nouveau */
  surveyOpen: boolean;
  /**
   * Fin de la journée de priorité du lot (`batch.priorityEndsAt` de l'API) : retirer la machine
   * avant cette date fait perdre la priorité pour cette machine, ce que le dialogue annonce.
   */
  priorityEndsAt?: string | null;
  /** Page où aller après le retrait (sinon la page courante est rechargée) */
  afterRemoveHref?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  // Lu à l'ouverture du dialogue (heure courante), pas pendant le rendu
  const [priorityRunning, setPriorityRunning] = useState(false);

  function done() {
    setOpen(false);
    if (afterRemoveHref) router.push(afterRemoveHref);
    else router.refresh();
  }

  async function remove() {
    setPending(true);
    setFailure(null);
    try {
      await api("DELETE", `/api/wishlists/${wishlistId}`);
      done();
    } catch (error) {
      const f = toFailure(error);
      if (f.status === 404) {
        done();
      } else if (f.status === 401) {
        window.location.reload(); // la page renvoie vers la connexion
      } else {
        setFailure(f);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="bo-btn bo-btn-danger bo-btn-sm"
        aria-label={`Retirer ${label}`}
        onClick={() => {
          setFailure(null);
          setPriorityRunning(priorityEndsAt !== null && new Date(priorityEndsAt).getTime() > Date.now());
          setOpen(true);
        }}
      >
        Retirer
      </button>
      <ConfirmDialog
        open={open}
        title="Retirer cette machine de vos intérêts ?"
        confirmLabel="Retirer"
        cancelLabel="Garder"
        confirmTone="danger"
        pending={pending}
        onConfirm={remove}
        onClose={() => setOpen(false)}
      >
        <p>
          {label}.{" "}
          {surveyOpen
            ? "Vous pourrez de nouveau manifester votre intérêt tant que le sondage est ouvert."
            : "Le sondage de ce lot est terminé : vous ne pourrez plus manifester votre intérêt pour ce lot."}
        </p>
        {priorityRunning && priorityEndsAt && (
          <p className="bo-alert bo-alert-warning" role="note">
            Vous perdrez la priorité pour cette machine : jusqu&apos;au {formatDateTime(priorityEndsAt)}, seules les
            machines souhaitées pendant le sondage peuvent être commandées en priorité.
          </p>
        )}
        <ErrorAlert failure={failure} />
      </ConfirmDialog>
    </>
  );
}
