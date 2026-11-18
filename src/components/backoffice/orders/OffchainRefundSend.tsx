"use client";

import { useId, useState } from "react";
import { formatCents } from "@/lib/decimal";
import { api, toFailure, type ApiFailure } from "../api";
import { issueAt } from "../ui";
import { FocusedError, useDone } from "./AdminOrderActions";

/**
 * Remboursement hors chaîne à rendre (vente manuelle) : l'admin rend l'argent, puis enregistre la remise avec une
 * référence seule (`POST /api/backoffice/refunds/{refundId}/send`, sans adresse).
 */
export function OffchainRefundSend({
  orderId,
  refund,
}: Readonly<{
  orderId: string;
  refund: { id: string; amount: string; causeLabel: string };
}>) {
  const done = useDone(orderId);
  const id = useId();
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const error = issueAt(failure, "reference");

  async function send() {
    setPending(true);
    setFailure(null);
    try {
      await api("POST", `/api/backoffice/refunds/${refund.id}/send`, { reference: reference.trim() });
      done("rendu");
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="bo-stack"
      noValidate
      aria-label={`Remise de ${formatCents(refund.amount)}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p>
        <strong className="bo-num">{formatCents(refund.amount)}</strong> à rendre au client · {refund.causeLabel}
      </p>
      <div className="bo-field">
        <label className="bo-label" htmlFor={`${id}-ref`}>
          Référence de la remise
        </label>
        <div className="bo-actions">
          <input
            id={`${id}-ref`}
            className="bo-input"
            style={{ flex: "1 1 220px", width: "auto" }}
            autoComplete="off"
            placeholder="Espèces rendues, reçu n° …"
            aria-describedby={error ? `${id}-error` : undefined}
            aria-invalid={error ? true : undefined}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          <button type="submit" className="bo-btn bo-btn-primary" disabled={pending}>
            {pending ? "Enregistrement…" : "Enregistrer la remise"}
          </button>
        </div>
        {error && (
          <span className="bo-field-error" id={`${id}-error`}>
            {error}
          </span>
        )}
      </div>
      <FocusedError failure={error ? null : failure} />
    </form>
  );
}
