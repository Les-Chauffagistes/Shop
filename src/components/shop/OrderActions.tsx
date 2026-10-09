"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { OrderDto } from "@/server/orders";
import { api, toFailure, type ApiFailure } from "@/components/backoffice/api";
import { ConfirmDialog } from "@/components/backoffice/ConfirmDialog";
import { ErrorAlert, Field, issueAt, Notice } from "@/components/backoffice/ui";

/** Écriture sur une facture de l'utilisateur ; 401 : la page renvoie vers la connexion. */
async function orderWrite(path: string, method: "POST" | "PATCH", body: unknown): Promise<OrderDto> {
  return api<OrderDto>(method, path, body);
}

function useFailure() {
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) ref.current?.focus();
  }, [failure]);
  const alert = (
    <div ref={ref} tabIndex={-1} className="shop-alert-focus">
      <ErrorAlert failure={failure} />
    </div>
  );
  return { failure, setFailure, alert };
}

function handleFailure(error: unknown, setFailure: (f: ApiFailure) => void) {
  const f = toFailure(error);
  if (f.status === 401) {
    window.location.reload();
    return;
  }
  setFailure(f);
}

/** Après une action, la page est relue avec un message de confirmation (`?fait=…`, voir la page). */
function doneHref(orderId: string, what: "annulation" | "remboursement" | "renoncement") {
  return `/mes-commandes/${orderId}?fait=${what}`;
}

/** « Annuler la facture » : facture en attente, rien reçu (`actions.canCancel`). */
export function CancelOrder({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  async function confirm() {
    setPending(true);
    setFailure(null);
    try {
      await orderWrite(`/api/orders/${orderId}/cancel`, "POST", {});
      setOpen(false);
      router.replace(doneHref(orderId, "annulation"));
    } catch (error) {
      handleFailure(error, setFailure);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="bo-btn bo-btn-danger"
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        Annuler la facture
      </button>
      <ConfirmDialog
        open={open}
        title="Annuler cette facture ?"
        confirmLabel="Annuler la facture"
        cancelLabel="Garder la facture"
        confirmTone="danger"
        pending={pending}
        onConfirm={confirm}
        onClose={() => setOpen(false)}
      >
        <p>Les machines réservées sont libérées tout de suite. N&apos;envoyez plus rien à l&apos;adresse de cette facture.</p>
        <p className="bo-hint">
          Après une annulation, il faut patienter quelques minutes avant de créer une nouvelle facture sur ce lot, et des
          annulations répétées suspendent les commandes sur ce lot.
        </p>
        <ErrorAlert failure={failure} />
      </ConfirmDialog>
    </>
  );
}

/**
 * Remboursement du versement partiel (`actions.canRequestRefund`) : frais du réseau à la charge de
 * l'utilisateur. L'adresse saisie est écrite sur la facture ; vide, celle de la facture s'applique.
 */
export function RefundDeposit({
  order,
  primary = false,
}: {
  order: Pick<OrderDto, "id" | "refundAddress">;
  primary?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(order.refundAddress ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  async function confirm() {
    setPending(true);
    setFailure(null);
    try {
      const trimmed = address.trim();
      await orderWrite(`/api/orders/${order.id}/refund`, "POST", trimmed ? { refundAddress: trimmed } : {});
      setOpen(false);
      router.replace(doneHref(order.id, "remboursement"));
    } catch (error) {
      handleFailure(error, setFailure);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`bo-btn ${primary ? "bo-btn-primary" : "bo-btn-secondary"}`}
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        Me faire rembourser mon versement
      </button>
      <ConfirmDialog
        open={open}
        title="Vous faire rembourser ?"
        confirmLabel="Demander le remboursement"
        cancelLabel="Retour"
        pending={pending}
        onConfirm={confirm}
        onClose={() => setOpen(false)}
      >
        <p>
          Nous vous renvoyons les bitcoins reçus sur cette facture et la commande est abandonnée. Les frais du réseau
          Bitcoin de ce remboursement sont à votre charge : ils sont déduits du montant renvoyé.
        </p>
        <Field
          label="Adresse Bitcoin de remboursement"
          optional
          hint="Laissez vide pour utiliser l'adresse déjà enregistrée sur la facture. Sans adresse, nous vous contacterons."
          error={issueAt(failure, "refundAddress")}
        >
          {(field) => (
            <input
              {...field}
              className="bo-input bo-mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          )}
        </Field>
        <ErrorAlert failure={failure} />
      </ConfirmDialog>
    </>
  );
}

/**
 * Renoncer à des machines d'une commande payée (`actions.canRenounce`) : machines choisies ou toute
 * la commande. Frais du réseau à la charge de l'utilisateur ; le montant exact vient du serveur.
 */
export function Renounce({ order }: { order: Pick<OrderDto, "id" | "lines" | "refundAddress"> }) {
  const router = useRouter();
  const active = [...order.lines].filter((l) => !l.refunded).sort((a, b) => a.position - b.position);
  const [scope, setScope] = useState<"all" | "some">("all");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const { setFailure, alert } = useFailure();
  const [dialogFailure, setDialogFailure] = useState<ApiFailure | null>(null);

  function ask(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setDialogFailure(null);
    setOpen(true);
  }

  async function confirm() {
    setPending(true);
    setDialogFailure(null);
    try {
      const body = scope === "all" ? {} : { lineIds: active.filter((l) => chosen.has(l.id)).map((l) => l.id) };
      await orderWrite(`/api/orders/${order.id}/renounce`, "POST", body);
      setOpen(false);
      setChosen(new Set());
      router.replace(doneHref(order.id, "renoncement"));
    } catch (error) {
      handleFailure(error, (f) => {
        setOpen(false);
        setFailure(f);
      });
    } finally {
      setPending(false);
    }
  }

  const count = scope === "all" ? active.length : chosen.size;

  return (
    <>
      <form className="shop-renounce" onSubmit={ask} noValidate aria-labelledby="renoncer">
        <h2 id="renoncer">Renoncer à ma commande</h2>
        <p>
          Tant que le lot est en précommande, vous pouvez renoncer à tout ou partie de votre commande. Vous êtes remboursé
          en bitcoins au prorata de ce que vous avez payé.
        </p>
        <div className="bo-alert bo-alert-warning" role="note">
          Les frais du réseau Bitcoin de ce remboursement sont à votre charge : ils sont déduits du montant renvoyé. Un
          éventuel paiement en trop n&apos;est pas renvoyé d&apos;office : notre équipe vous contactera à son sujet.
          {!order.refundAddress && (
            <> Vous n&apos;avez pas encore donné d&apos;adresse de remboursement : ajoutez-la ci-dessous pour être remboursé sans attendre.</>
          )}
        </div>
        <fieldset className="shop-fieldset">
          <legend>Machines concernées</legend>
          <label className="bo-check">
            <input type="radio" name="renounce-scope" checked={scope === "all"} onChange={() => setScope("all")} />
            Toute la commande
          </label>
          <label className="bo-check">
            <input type="radio" name="renounce-scope" checked={scope === "some"} onChange={() => setScope("some")} />
            Certaines machines
          </label>
          {scope === "some" && (
            <div className="shop-renounce-lines">
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
                  Machine {l.position}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {alert}
        <div className="bo-actions">
          <button type="submit" className="bo-btn bo-btn-danger">
            Renoncer…
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={open}
        title={scope === "all" ? "Renoncer à toute la commande ?" : `Renoncer à ${count} machine${count > 1 ? "s" : ""} ?`}
        confirmLabel="Confirmer le renoncement"
        cancelLabel="Garder ma commande"
        confirmTone="danger"
        pending={pending}
        onConfirm={confirm}
        onClose={() => setOpen(false)}
      >
        <p>
          {scope === "all"
            ? "Toutes vos machines de cette commande sont annulées."
            : `Machines annulées : ${active
                .filter((l) => chosen.has(l.id))
                .map((l) => l.position)
                .join(", ") || "aucune"}.`}{" "}
          Ce renoncement est définitif.
        </p>
        <p>
          Les frais du réseau Bitcoin sont déduits du montant remboursé. Le montant exact vous sera indiqué une fois le
          renoncement enregistré.
        </p>
        <p>
          Si vous avez envoyé plus que le montant de la commande, ce surplus n&apos;est pas renvoyé d&apos;office avec ce
          remboursement : notre équipe vous contactera pour décider de son renvoi.
        </p>
        <ErrorAlert failure={dialogFailure} />
      </ConfirmDialog>
    </>
  );
}

/**
 * Adresse Bitcoin de remboursement de la facture : ajout, modification, effacement. Chaque
 * changement est journalisé. Proposé même si un remboursement est déjà parti : le serveur refuse
 * alors (`409 refund_address_frozen`) et son message s'affiche.
 */
export function RefundAddressEditor({
  orderId,
  current,
  editable,
}: {
  orderId: string;
  current: string | null;
  /** `actions.canEditRefundAddress` : aucun remboursement envoyé */
  editable: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [pending, setPending] = useState(false);
  const { failure, setFailure, alert } = useFailure();
  const [done, setDone] = useState<string | null>(null);

  async function save(next: string | null) {
    setPending(true);
    setFailure(null);
    setDone(null);
    try {
      await orderWrite(`/api/orders/${orderId}/refund-address`, "PATCH", { refundAddress: next });
      setEditing(false);
      setDone(next === null ? "Adresse de remboursement effacée." : "Adresse de remboursement enregistrée.");
      router.refresh();
    } catch (error) {
      handleFailure(error, setFailure);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="bo-stack">
      {!editing && (
        <>
          {current ? (
            <p className="bo-mono shop-break">{current}</p>
          ) : (
            <p className="bo-muted">Aucune adresse pour l&apos;instant. Sans adresse, nous vous contacterons avant tout remboursement.</p>
          )}
          {!editable && (
            <p className="bo-hint">Un remboursement a déjà été envoyé : l&apos;adresse ne se modifie plus. Contactez-nous si besoin.</p>
          )}
          <div className="bo-actions">
            <button
              type="button"
              className="bo-btn bo-btn-secondary bo-btn-sm"
              onClick={() => {
                setValue(current ?? "");
                setFailure(null);
                setEditing(true);
              }}
            >
              {current ? "Modifier l'adresse" : "Ajouter une adresse"}
            </button>
          </div>
        </>
      )}
      {editing && (
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
            hint="Chaque modification est enregistrée dans l'historique de la commande."
            error={issueAt(failure, "refundAddress")}
          >
            {(field) => (
              <input
                {...field}
                className="bo-input bo-mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </Field>
          {alert}
          <div className="bo-actions">
            <button type="submit" className="bo-btn bo-btn-primary bo-btn-sm" disabled={pending}>
              {pending ? "Enregistrement…" : "Enregistrer"}
            </button>
            {current && (
              <button type="button" className="bo-btn bo-btn-danger bo-btn-sm" disabled={pending} onClick={() => void save(null)}>
                Effacer l&apos;adresse
              </button>
            )}
            <button type="button" className="bo-btn bo-btn-ghost bo-btn-sm" disabled={pending} onClick={() => setEditing(false)}>
              Annuler
            </button>
          </div>
        </form>
      )}
      <Notice message={done} />
    </div>
  );
}
