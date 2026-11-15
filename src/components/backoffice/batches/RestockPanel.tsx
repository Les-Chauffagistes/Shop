"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BatchDetail } from "@/server/batches";
import { eurosToCents, formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { machines as machinesLabel } from "@/lib/plural";
import { api, ApiFailure, toFailure } from "../api";
import { ErrorAlert, Field, issueAt, MoneyInput, Notice } from "../ui";

/** Borne de l'API (docs/api.md, réassort) : prix total de 0 à 100 000 000,00 €. */
const MAX_PRICE_CENTS = 10_000_000_000n;

/**
 * Réassort d'un lot de stock (quantité, prix d'achat total, note) et son historique. Les machines créées sont
 * attendues : à recevoir puis contrôler dans l'onglet « Machines » avant d'être vendables.
 */
export function RestockPanel({ batchId, restocks }: { batchId: string; restocks: BatchDetail["restocks"] }) {
  const router = useRouter();
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const qty = Number(quantity);
    const cents = eurosToCents(price);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10_000) {
      setFailure(new ApiFailure(0, "local", "Quantité : nombre entier de machines entre 1 et 10 000."));
      return;
    }
    if (cents === null || BigInt(cents) > MAX_PRICE_CENTS) {
      setFailure(new ApiFailure(0, "local", "Prix d'achat total : montant en euros, ex. 2 700 (0 pour une machine reprise ou donnée)."));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await api("POST", `/api/backoffice/batches/${batchId}/restocks`, { quantity: qty, purchasePrice: cents, note: note.trim() || null });
      setNotice(`Réassort enregistré : ${machinesLabel(qty)} attendue${qty > 1 ? "s" : ""}, à recevoir puis contrôler.`);
      setQuantity("");
      setPrice("");
      setNote("");
      router.refresh();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="bo-card" aria-labelledby="reassort">
      <div className="bo-card-head">
        <div>
          <h2 id="reassort">Réassort</h2>
          <p>Machines achetées pour ce lot : elles arrivent attendues, puis deviennent disponibles une fois reçues et contrôlées.</p>
        </div>
      </div>
      <form className="bo-form" onSubmit={submit} noValidate>
        <div className="bo-fields">
          <Field label="Quantité" error={issueAt(failure, "quantity")}>
            {(p) => (
              <input {...p} className="bo-input bo-num" type="number" min={1} max={10_000} step={1} value={quantity}
                onChange={(e) => setQuantity(e.target.value)} required />
            )}
          </Field>
          <Field label="Prix d'achat total" hint="Pour toutes les machines du réassort." error={issueAt(failure, "purchasePrice")}>
            {(p) => <MoneyInput {...p} value={price} onChange={setPrice} required />}
          </Field>
          <Field label="Note" optional wide>
            {(p) => (
              <input {...p} className="bo-input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
                placeholder="Ex. fournisseur, numéro de facture" />
            )}
          </Field>
        </div>
        <ErrorAlert failure={failure} />
        <Notice message={notice} />
        {notice && (
          <p className="bo-hint">
            <Link href={`/backoffice/lots/${batchId}?onglet=machines`}>Recevoir les machines</Link>
          </p>
        )}
        <div className="bo-actions">
          <button type="submit" className="bo-btn bo-btn-primary" disabled={pending}>
            {pending ? "Enregistrement…" : "Enregistrer le réassort"}
          </button>
        </div>
      </form>

      {restocks.length > 0 && (
        <div className="bo-table-scroll" style={{ marginTop: 20 }}>
          <table className="bo-table">
            <caption className="bo-visually-hidden">Réassorts du lot, du plus récent au plus ancien</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Machines</th>
                <th scope="col">Prix total</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {[...restocks].reverse().map((r) => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td className="bo-num">{r.quantity}</td>
                  <td className="bo-num">{formatCents(r.purchasePrice)}</td>
                  <td>{r.note ?? <span className="bo-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
