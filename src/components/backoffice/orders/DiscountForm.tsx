"use client";

import { useState, type SubmitEvent } from "react";
import { eurosToCents, formatCents } from "@/lib/decimal";
import { api, toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { Field, issueAt, MoneyInput } from "../ui";
import { DestinationField, FocusedError, useDone } from "./AdminOrderActions";

/**
 * « Rabais » sur une commande payée (`POST …/discount`) : des euros rendus sans annuler de machine, strictement moins
 * que `refundableAmount` (le serveur tranche, `422 discount_too_large`). Hors chaîne : euros à rendre au client ; en
 * Bitcoin : sats au prorata de ce qui a été payé, vers l'adresse de la facture ou une autre.
 */
export function DiscountForm({
  orderId,
  refundableAmount,
  offchain,
}: Readonly<{
  orderId: string;
  /** Centimes encore remboursables (total − annulations et rabais) */
  refundableAmount: string;
  offchain: boolean;
}>) {
  const done = useDone(orderId);
  const [amountText, setAmountText] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [destination, setDestination] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const amount = eurosToCents(amountText);

  async function confirm() {
    setPending(true);
    try {
      await api("POST", `/api/backoffice/orders/${orderId}/discount`, {
        amount: amount ?? "",
        reason,
        ...(!offchain && destination.trim() ? { destinationAddress: destination.trim() } : {}),
      });
      setOpen(false);
      done("rabais");
    } catch (error) {
      setOpen(false);
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form
        className="bo-stack"
        noValidate
        aria-label="Rabais"
        onSubmit={(e: SubmitEvent) => {
          e.preventDefault();
          setFailure(null);
          if (amount === null || amount === "0") {
            setAmountError("Indiquez un montant en euros, par exemple 50 ou 49,90.");
            return;
          }
          setAmountError(null);
          // Explication manquante : pas de confirmation à donner, le serveur répond par ce qu'il manque
          if (reason.trim() === "") void confirm();
          else setOpen(true);
        }}
      >
        <Field
          label="Montant du rabais"
          hint={`Moins de ${formatCents(refundableAmount)}. Pour tout rendre, annulez les machines.`}
          error={amountError ?? issueAt(failure, "amount")}
        >
          {(field) => <MoneyInput {...field} value={amountText} onChange={setAmountText} />}
        </Field>
        <Field label="Explication" hint="Visible dans l'historique de la facture." error={issueAt(failure, "reason")}>
          {(field) => <textarea {...field} className="bo-input bo-textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {!offchain && <DestinationField value={destination} onChange={setDestination} failure={failure} />}
        <FocusedError failure={failure} />
        <div className="bo-actions">
          <button type="submit" className="bo-btn bo-btn-secondary">
            Accorder un rabais…
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={open}
        title={`Accorder un rabais de ${formatCents(amount)} ?`}
        confirmLabel="Accorder le rabais"
        cancelLabel="Retour"
        pending={pending}
        onConfirm={confirm}
        onClose={() => setOpen(false)}
      >
        <p>
          {offchain
            ? "Le montant sera à rendre au client (espèces, virement…), puis à enregistrer comme rendu."
            : "Le montant est converti en sats au prorata de ce qui a été payé, frais du réseau à la charge de la boutique."}{" "}
          Les machines restent vendues.
        </p>
      </ConfirmDialog>
    </>
  );
}
