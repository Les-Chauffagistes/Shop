"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatCents } from "@/lib/decimal";
import { formatShortDateTime } from "@/lib/dates";
import { toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { mailtoHref } from "../orders/ContactEmails";

/** Commande payée en trop annoncée par `409 machine_shortage` (`details.refunds`, docs/api.md « Machines en moins »). */
type Refund = { lineId: string; orderId: string; paidAt: string | null; contactEmail: string | null; amount: string };

/** Envoie l'écriture ; `confirmRefunds` : les lignes annoncées, renvoyées telles quelles après confirmation. */
type Send<T> = (confirmRefunds?: string[]) => Promise<T>;

/** Issue d'une écriture : faite, refusée (erreur affichée), ou en attente de la confirmation des remboursements. */
export type Outcome = "done" | "failed" | "shortage";

type Shortage = { message: string; refunds: Refund[]; retry: (confirmRefunds: string[]) => Promise<Outcome> };

function refundsOf(failure: ApiFailure): Refund[] {
  const refunds = failure.details?.refunds;
  return Array.isArray(refunds) ? (refunds as Refund[]) : [];
}

/** Phrase ajoutée au succès d'un marquage : commandes payées en trop remboursées dans la même transaction (`refunds` de la réponse). */
function refundsSentence(result: unknown): string {
  const refunds = (result as { refunds?: unknown } | null)?.refunds;
  if (!Array.isArray(refunds) || refunds.length === 0) return "";
  const list = (refunds as Refund[])
    .map((r) => `${formatCents(r.amount)} (${r.contactEmail ?? "sans e-mail"})`)
    .join(", ");
  return refunds.length === 1
    ? ` Une commande payée en trop a été remboursée : ${list}.`
    : ` ${refunds.length} commandes payées en trop ont été remboursées : ${list}.`;
}

/**
 * Écritures sur des machines (statuts, contrôle, réception, attribution) : état d'envoi, message de succès, erreur
 * du serveur, rechargement de la page. Une écriture qui laisserait le lot sans assez de machines est refusée
 * (`409 machine_shortage`, attribution et remplacement seulement : le marquage rembourse sans confirmation et affiche
 * les remboursements de la réponse) : le dialogue annonce les commandes qui seraient remboursées, puis renvoie la même
 * requête avec `confirmRefunds`. `machine_shortage_reserved` (factures en attente) s'affiche tel quel.
 */
export function useMachineAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shortage, setShortage] = useState<Shortage | null>(null);

  async function run<T>(send: Send<T>, success: string | ((result: T) => string), confirmRefunds?: string[]): Promise<Outcome> {
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await send(confirmRefunds);
      setShortage(null);
      setNotice(`${typeof success === "function" ? success(result) : success}${refundsSentence(result)}`);
      router.refresh();
      return "done";
    } catch (error) {
      const f = toFailure(error);
      if (f.code === "machine_shortage") {
        setShortage({ message: f.message, refunds: refundsOf(f), retry: (ids) => run(send, success, ids) });
        return "shortage";
      }
      setShortage(null);
      setFailure(f);
      return "failed";
    } finally {
      setPending(false);
    }
  }

  const dialog = (
    <ConfirmDialog
      open={shortage !== null}
      title="Rembourser des commandes ?"
      confirmLabel="Rembourser et continuer"
      confirmTone="danger"
      cancelLabel="Ne rien changer"
      pending={pending}
      onConfirm={() => void shortage?.retry(shortage.refunds.map((r) => r.lineId))}
      onClose={() => setShortage(null)}
    >
      {shortage && (
        <>
          <div className="bo-alert bo-alert-warning">{shortage.message}</div>
          <ul className="bo-shortages">
            {shortage.refunds.map((r) => (
              <li key={r.lineId}>
                <strong className="bo-num">{formatCents(r.amount)}</strong>
                {" · "}
                {r.contactEmail ? <a href={mailtoHref(r.contactEmail)}>{r.contactEmail}</a> : <span className="bo-muted">sans e-mail</span>}
                {r.paidAt && <span className="bo-muted"> · payée le {formatShortDateTime(r.paidAt)}</span>}
                {" · "}
                <Link href={`/backoffice/factures/${r.orderId}`}>Voir la facture</Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </ConfirmDialog>
  );

  return { run, pending, failure, notice, dialog, clearFailure: () => setFailure(null) };
}

export type MachineAction = ReturnType<typeof useMachineAction>;
