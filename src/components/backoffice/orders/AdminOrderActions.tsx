"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { getAdminOrder } from "@/server/backoffice-orders";
import { formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { feePayerLabel, formatSats } from "@/components/money";
import { api, detailOf, toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Field, issueAt } from "../ui";

export type AdminOrder = Awaited<ReturnType<typeof getAdminOrder>>;
type CauseOption = { cause: string; label: string; networkFeePayer: "shop" | "user" };

/** Confirmation affichée par la page après une décision (`?fait=…`). */
export type AdminDone = "acceptee" | "remboursee" | "annulees" | "adresse" | "classee";

function useDone(orderId: string) {
  const router = useRouter();
  return (what: AdminDone) => router.replace(`/backoffice/factures/${orderId}?fait=${what}`);
}

/** Alerte d'erreur qui reçoit le focus à son apparition. */
function FocusedError({ failure, children }: { failure: ApiFailure | null; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) ref.current?.focus();
  }, [failure]);
  if (!failure) return null;
  return (
    <div ref={ref} tabIndex={-1} className="shop-alert-focus">
      <ErrorAlert failure={failure}>{children}</ErrorAlert>
    </div>
  );
}

/** Choix du motif : le payeur des frais réseau en découle (affiché, jamais choisi à part). */
function CauseChoice({
  causes,
  value,
  onChange,
  legend,
  error,
}: {
  causes: CauseOption[];
  value: string | null;
  onChange: (cause: string) => void;
  legend: string;
  error: string | null;
}) {
  const name = useId();
  return (
    <fieldset className="bo-causes">
      <legend className="bo-label">{legend}</legend>
      {causes.map((c) => (
        <label key={c.cause} className="bo-cause">
          <input type="radio" name={name} checked={value === c.cause} onChange={() => onChange(c.cause)} />
          <span>
            <strong>{c.label}</strong>
            <span className="bo-hint">Frais du réseau {feePayerLabel(c.networkFeePayer)}</span>
          </span>
        </label>
      ))}
      {error && <span className="bo-field-error">{error}</span>}
    </fieldset>
  );
}

/** « Accepter » une facture à traiter (`attention.canAccept`) ; `409 out_of_stock` affiché tel quel. */
export function AcceptOrder({ orderId }: { orderId: string }) {
  const done = useDone(orderId);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const until = detailOf(failure, "expiresAt");

  return (
    <div className="bo-stack">
      <div className="bo-actions">
        <button
          type="button"
          className="bo-btn bo-btn-primary"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setFailure(null);
            try {
              await api("POST", `/api/backoffice/orders/${orderId}/accept`, {});
              done("acceptee");
            } catch (error) {
              setFailure(toFailure(error));
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Acceptation…" : "Accepter la commande"}
        </button>
      </div>
      <FocusedError failure={failure}>
        {until && <p style={{ marginTop: 6 }}>Réservation en cours jusqu&apos;au {formatDateTime(until)}.</p>}
      </FocusedError>
    </div>
  );
}

/** « Rembourser » une facture à traiter, avec le motif choisi parmi `attention.refundCauses`. */
export function AdminRefund({
  orderId,
  causes,
  primary = true,
}: {
  orderId: string;
  causes: CauseOption[];
  /** Bouton principal, sauf quand classer sans suite passe en premier (excédent au plus égal aux frais) */
  primary?: boolean;
}) {
  const done = useDone(orderId);
  const [cause, setCause] = useState<string | null>(causes.length === 1 ? causes[0].cause : null);
  const [reason, setReason] = useState("");
  const [destination, setDestination] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const chosen = causes.find((c) => c.cause === cause);

  async function confirm() {
    setPending(true);
    try {
      await api("POST", `/api/backoffice/orders/${orderId}/refund`, {
        reason,
        ...(cause ? { cause } : {}),
        ...(destination.trim() ? { destinationAddress: destination.trim() } : {}),
      });
      setOpen(false);
      done("remboursee");
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
        aria-label="Rembourser"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setFailure(null);
          // Formulaire incomplet : pas de confirmation à donner, le serveur répond par ce qu'il manque
          if (!cause || reason.trim() === "") void confirm();
          else setOpen(true);
        }}
      >
        <CauseChoice causes={causes} value={cause} onChange={setCause} legend="Motif du remboursement" error={issueAt(failure, "cause")} />
        <Field label="Explication" hint="Visible dans l'historique de la facture." error={issueAt(failure, "reason")}>
          {(field) => <textarea {...field} className="bo-input bo-textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <Field
          label="Envoyer à une autre adresse"
          optional
          hint="Laissez vide pour utiliser l'adresse de remboursement de la facture."
          error={issueAt(failure, "destinationAddress")}
        >
          {(field) => (
            <input
              {...field}
              className="bo-input bo-mono"
              autoComplete="off"
              spellCheck={false}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          )}
        </Field>
        <FocusedError failure={failure} />
        <div className="bo-actions">
          <button type="submit" className={`bo-btn ${primary ? "bo-btn-primary" : "bo-btn-secondary"}`}>
            Rembourser…
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={open}
        title="Rembourser cette facture ?"
        confirmLabel="Rembourser"
        pending={pending}
        onConfirm={confirm}
        onClose={() => setOpen(false)}
      >
        <p>
          Motif : {chosen && <strong>{chosen.label}</strong>}
          {chosen && <>. Frais du réseau {feePayerLabel(chosen.networkFeePayer)}.</>}
        </p>
        <p className="bo-hint">Le remboursement rejoint ensuite la liste des remboursements à envoyer.</p>
      </ConfirmDialog>
    </>
  );
}

/**
 * « Classer sans suite » les sats reçus non affectés (`attention.canDismiss`) : les renvoyer coûterait
 * au moins autant qu'ils valent. Motif facultatif. La somme classée est lue par le serveur sous verrou ;
 * ses refus (`nothing_to_dismiss`, `excess_already_dismissed`, `excess_above_network_fee`) s'affichent tels quels.
 */
export function DismissExcess({
  orderId,
  unsettledSats,
  networkFeeSats,
  primary = false,
}: {
  orderId: string;
  unsettledSats: string;
  networkFeeSats: string;
  /** Bouton principal quand l'excédent ne dépasse pas les frais réseau (rembourser coûterait autant ou plus) */
  primary?: boolean;
}) {
  const done = useDone(orderId);
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const failedUnsettled = detailOf(failure, "unsettledSats");
  const failedFee = detailOf(failure, "networkFeeSats");

  async function confirm() {
    setPending(true);
    try {
      await api("POST", `/api/backoffice/orders/${orderId}/dismiss-excess`, reason.trim() ? { reason: reason.trim() } : {});
      setOpen(false);
      done("classee");
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
        aria-label="Classer sans suite"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setFailure(null);
          setOpen(true);
        }}
      >
        <p className="bo-hint">
          {formatSats(unsettledSats)} non affectés, frais estimés d&apos;un renvoi : {formatSats(networkFeeSats)}. Les
          renvoyer coûterait au moins autant qu&apos;ils valent.
        </p>
        <Field label="Motif" optional hint="Visible sur la facture, avec votre identifiant." error={issueAt(failure, "reason")}>
          {(field) => <textarea {...field} className="bo-input bo-textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <FocusedError failure={failure}>
          {failure?.code === "excess_above_network_fee" && failedUnsettled && failedFee && (
            <p style={{ marginTop: 6 }}>
              Non affecté : {formatSats(failedUnsettled)} ; frais estimés : {formatSats(failedFee)}. Remboursez plutôt.
            </p>
          )}
        </FocusedError>
        <div className="bo-actions">
          <button type="submit" className={`bo-btn ${primary ? "bo-btn-primary" : "bo-btn-secondary"}`}>
            Classer sans suite…
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={open}
        title="Classer cette somme sans suite ?"
        confirmLabel="Classer sans suite"
        cancelLabel="Retour"
        pending={pending}
        onConfirm={confirm}
        onClose={() => setOpen(false)}
      >
        <p>
          {formatSats(unsettledSats)} reçus ne seront pas renvoyés au client et sortent de « À traiter ». Le classement est
          journalisé et ne se fait qu&apos;une fois par facture : un versement reçu ensuite devra être remboursé.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** Annuler des machines d'une commande payée, au prorata (`cancelLineCauses`). */
export function CancelLines({ order }: { order: Pick<AdminOrder, "id" | "lines" | "cancelLineCauses"> }) {
  const done = useDone(order.id);
  const active = [...order.lines].filter((l) => !l.refunded).sort((a, b) => a.position - b.position);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [cause, setCause] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [destination, setDestination] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const all = chosen.size === active.length;
  const picked = active.filter((l) => chosen.has(l.id));

  async function confirm() {
    setPending(true);
    try {
      await api("POST", `/api/backoffice/orders/${order.id}/cancel-lines`, {
        // Toutes les machines : sans liste, la commande passe à « remboursée » ; son excédent éventuel reste à traiter
        ...(all ? {} : { lineIds: picked.map((l) => l.id) }),
        reason,
        ...(cause ? { cause } : {}),
        ...(destination.trim() ? { destinationAddress: destination.trim() } : {}),
      });
      setOpen(false);
      done("annulees");
    } catch (error) {
      setOpen(false);
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }
  const chosenCause = order.cancelLineCauses.find((c) => c.cause === cause);

  return (
    <>
      <form
        className="bo-stack"
        noValidate
        aria-label="Annuler des machines"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setFailure(null);
          // Aucune machine cochée ou pas d'explication : pas de confirmation à donner, le serveur répond par ce qu'il manque
          if (picked.length === 0 || reason.trim() === "") void confirm();
          else setOpen(true);
        }}
      >
        <fieldset className="bo-causes">
          <legend className="bo-label">Machines à annuler</legend>
          {active.map((l) => (
            <label key={l.id} className="bo-check">
              <input
                type="checkbox"
                checked={chosen.has(l.id)}
                onChange={(e) =>
                  setChosen((cur) => {
                    const next = new Set(cur);
                    if (e.target.checked) next.add(l.id);
                    else next.delete(l.id);
                    return next;
                  })
                }
              />
              Machine {l.position} · {formatCents(l.amount)}
            </label>
          ))}
          {active.length === 0 && <p className="bo-muted">Aucune machine active.</p>}
        </fieldset>
        <CauseChoice
          causes={order.cancelLineCauses}
          value={cause}
          onChange={setCause}
          legend="Motif de l'annulation"
          error={issueAt(failure, "cause")}
        />
        <Field label="Explication" hint="Visible dans l'historique de la facture." error={issueAt(failure, "reason")}>
          {(field) => <textarea {...field} className="bo-input bo-textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <Field label="Envoyer à une autre adresse" optional hint="Laissez vide pour utiliser l'adresse de remboursement de la facture." error={issueAt(failure, "destinationAddress")}>
          {(field) => (
            <input
              {...field}
              className="bo-input bo-mono"
              autoComplete="off"
              spellCheck={false}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          )}
        </Field>
        <FocusedError failure={failure} />
        <div className="bo-actions">
          <button type="submit" className="bo-btn bo-btn-danger">
            Annuler les machines…
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={open}
        title={all ? "Annuler toute la commande ?" : `Annuler ${picked.length} machine${picked.length > 1 ? "s" : ""} ?`}
        confirmLabel="Annuler et rembourser"
        cancelLabel="Retour"
        confirmTone="danger"
        pending={pending}
        onConfirm={confirm}
        onClose={() => setOpen(false)}
      >
        <p>
          {all ? "Toutes les machines" : `Machines ${picked.map((l) => l.position).join(", ")}`} remboursées au
          prorata de ce qui a été payé.
          {all && " Un éventuel excédent de paiement ne part pas avec ce remboursement : il restera « à traiter »."}
        </p>
        <p>
          Motif : {chosenCause ? <strong>{chosenCause.label}</strong> : "Autre décision de la boutique (par défaut)"}
          {chosenCause && <>. Frais du réseau {feePayerLabel(chosenCause.networkFeePayer)}.</>}
        </p>
      </ConfirmDialog>
    </>
  );
}

/** Adresse de remboursement de la facture, modifiée par l'admin (journalisé). */
export function AdminRefundAddress({ orderId, current, editable }: { orderId: string; current: string | null; editable: boolean }) {
  const done = useDone(orderId);
  const [value, setValue] = useState(current ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  async function save(next: string | null) {
    setPending(true);
    setFailure(null);
    try {
      await api("PATCH", `/api/backoffice/orders/${orderId}/refund-address`, { refundAddress: next });
      done("adresse");
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="bo-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(value.trim() === "" ? null : value.trim());
      }}
    >
      <Field
        label="Adresse Bitcoin de remboursement"
        hint={editable ? "Chaque changement est journalisé avec votre identifiant." : "Un remboursement est déjà envoyé : le serveur refusera tout changement."}
        error={issueAt(failure, "refundAddress")}
      >
        {(field) => (
          <input
            {...field}
            className="bo-input bo-mono"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      <FocusedError failure={failure} />
      <div className="bo-actions">
        <button type="submit" className="bo-btn bo-btn-secondary bo-btn-sm" disabled={pending}>
          {pending ? "Enregistrement…" : "Enregistrer l'adresse"}
        </button>
        {current && (
          <button type="button" className="bo-btn bo-btn-ghost bo-btn-sm" disabled={pending} onClick={() => void save(null)}>
            Effacer
          </button>
        )}
      </div>
    </form>
  );
}
