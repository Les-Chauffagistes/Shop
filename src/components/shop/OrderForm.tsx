"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, detailOf, toFailure, type ApiFailure } from "@/components/backoffice/api";
import { ErrorAlert, Field, issueAt } from "@/components/backoffice/ui";
import { formatCents } from "@/lib/decimal";
import { buildLoginUrl, type LoginTarget } from "@/lib/login";
import { machines } from "@/lib/plural";
import type { PostalAddress } from "./AddressBlock";
import { addressPayload, AddressFields, EMPTY_ADDRESS, type AddressChoice } from "./AddressFields";
import { sumCents } from "./format";
import { chosenValues, OptionMenus, type OfferedMenu } from "./OptionMenus";

/** Machine souhaitée pendant le sondage, reprise telle quelle (configuration figée). */
export type WishlistLine = {
  id: string;
  items: { optionId: string; optionTitle: string; optionValueId: string; label: string; isDefault: boolean; unitPrice: string }[];
};

type Line =
  | { key: string; kind: "wishlist"; wishlistId: string }
  | { key: string; kind: "custom"; selected: Record<string, string> };

/**
 * Commande d'un lot : une ligne par machine (reprise d'une machine souhaitée, ou configuration libre),
 * adresses, adresse de remboursement facultative, récapitulatif indicatif, puis création de la facture
 * (`POST /api/orders`). Rien n'est bloqué ici : nombre de machines, priorité, stock, délai et blocage
 * sont tranchés par le serveur, dont le message s'affiche et reçoit le focus.
 */
export function OrderForm({
  batch,
  wishlists,
  addresses,
  profileEmail,
  login,
}: {
  batch: { id: string; resaleUnitPrice: string; options: OfferedMenu[]; maxMachinesPerOrder: number };
  /** Machines souhaitées encore à commander (`eligibility.wishlistIds`), avec leur configuration */
  wishlists: WishlistLine[];
  addresses: PostalAddress[];
  /** E-mail du profil (`eligibility.profileEmail`) pour préremplir le contact ; `null` : à saisir */
  profileEmail: string | null;
  login: LoginTarget;
}) {
  const router = useRouter();
  // Clés stables (rendues dans les noms des boutons radio : identiques côté serveur et navigateur)
  const customSeq = useRef(1);
  const wishlistLine = (id: string): Line => ({ key: `w-${id}`, kind: "wishlist", wishlistId: id });
  const customLine = (): Line => ({ key: `c-${customSeq.current++}`, kind: "custom", selected: {} });
  const [lines, setLines] = useState<Line[]>(() =>
    // Initialiseur pur (appelé deux fois en mode strict) : clé fixe pour la première ligne libre
    wishlists.length > 0 ? wishlists.map((w) => wishlistLine(w.id)) : [{ key: "c-0", kind: "custom", selected: {} }],
  );
  const [billing, setBilling] = useState<AddressChoice>({ savedId: addresses[0]?.id ?? null, draft: EMPTY_ADDRESS });
  const [sameShipping, setSameShipping] = useState(true);
  const [shipping, setShipping] = useState<AddressChoice>({ savedId: addresses[0]?.id ?? null, draft: EMPTY_ADDRESS });
  const [refundAddress, setRefundAddress] = useState("");
  const [contactEmail, setContactEmail] = useState(profileEmail ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  // Refus qui ne porte que sur l'e-mail : dit sous le champ (une seule fois), le focus va au champ
  const emailRefused = failure?.code === "contact_email_required" || failure?.code === "invalid_contact_email";

  useEffect(() => {
    if (emailRefused) emailRef.current?.focus();
    else if (failure) alertRef.current?.focus();
  }, [failure, emailRefused]);

  const byWishlist = new Map(wishlists.map((w) => [w.id, w]));
  const unusedWishlists = wishlists.filter((w) => !lines.some((l) => l.kind === "wishlist" && l.wishlistId === w.id));

  /** Prix indicatif d'une ligne, sur l'offre actuelle du lot (le serveur relit les prix à la création). */
  function lineAmount(line: Line): string {
    if (line.kind === "custom") {
      return sumCents([batch.resaleUnitPrice, ...chosenValues(batch.options, line.selected).map((c) => c.value?.price ?? "0")]);
    }
    const items = byWishlist.get(line.wishlistId)?.items ?? [];
    const offered = new Map(batch.options.flatMap((m) => m.values.map((v) => [v.id, v.price] as const)));
    return sumCents([batch.resaleUnitPrice, ...items.map((i) => offered.get(i.optionValueId) ?? i.unitPrice)]);
  }
  const total = sumCents(lines.map(lineAmount));

  const update = (key: string, change: (line: Line) => Line) => setLines((ls) => ls.map((l) => (l.key === key ? change(l) : l)));
  const remove = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const order = await api<{ id: string }>("POST", "/api/orders", {
        batchId: batch.id,
        lines: lines.map((l) =>
          l.kind === "wishlist"
            ? { wishlistId: l.wishlistId }
            : {
                choices: chosenValues(batch.options, l.selected).flatMap((c) =>
                  c.value ? [{ optionId: c.menu.id, optionValueId: c.value.id }] : [],
                ),
              },
        ),
        billingAddress: addressPayload(billing),
        ...(sameShipping ? {} : { shippingAddress: addressPayload(shipping) }),
        refundAddress: refundAddress.trim() === "" ? null : refundAddress.trim(),
        contactEmail: contactEmail.trim() === "" ? null : contactEmail.trim(),
      });
      router.push(`/mes-commandes/${order.id}?nouvelle=1`);
    } catch (error) {
      const f = toFailure(error);
      if (f.status === 401) {
        window.location.assign(buildLoginUrl(login, `/lots/${batch.id}/commander`));
        return;
      }
      setFailure(f);
      setPending(false);
      // Offre changée entre-temps (option retirée) : recharge la page, les choix périmés reviennent au défaut
      if (f.code === "option_not_offered") router.refresh();
    }
  }

  const pendingOrderId = detailOf(failure, "orderId");
  // Refus du serveur qui portent sur l'e-mail : affichés sous le champ seulement (pas d'alerte en double)
  const emailError = emailRefused ? failure.message : issueAt(failure, "contactEmail");
  const emailChanged = profileEmail !== null && contactEmail.trim() !== "" && contactEmail.trim() !== profileEmail;

  return (
    <form className="shop-order" onSubmit={submit} noValidate aria-label="Commande">
      <section className="shop-config" aria-labelledby="machines">
        <div className="shop-section-head">
          <h2 id="machines">Vos machines</h2>
          <p className="bo-hint">Jusqu&apos;à {machines(batch.maxMachinesPerOrder)} par facture.</p>
        </div>

        {lines.length === 0 && <p className="bo-muted">Aucune machine pour l&apos;instant : ajoutez-en une.</p>}

        <ol className="shop-order-lines">
          {lines.map((line, index) => {
            const title = `Machine ${index + 1}`;
            const wishlist = line.kind === "wishlist" ? byWishlist.get(line.wishlistId) : undefined;
            return (
              <li key={line.key} className="shop-order-line">
                <section aria-label={title}>
                  <div className="shop-order-line-head">
                    <h3>
                      {title}
                      {line.kind === "wishlist" && <span className="bo-badge bo-badge-sale">Machine souhaitée</span>}
                    </h3>
                    <button
                      type="button"
                      className="bo-btn bo-btn-ghost bo-btn-sm"
                      onClick={() => remove(line.key)}
                      aria-label={`Retirer la ${title.toLowerCase()} de la commande`}
                    >
                      Retirer
                    </button>
                  </div>
                  {line.kind === "wishlist" ? (
                    <>
                      <p className="bo-hint">Configuration choisie pendant le sondage, reprise telle quelle.</p>
                      <ul className="shop-config-list">
                        {(wishlist?.items ?? []).map((item) => (
                          <li key={item.optionId} data-default={item.isDefault ? "true" : undefined}>
                            <span>
                              {item.optionTitle} : {item.label}
                            </span>
                          </li>
                        ))}
                        {wishlist && wishlist.items.length === 0 && <li>Machine sans option</li>}
                      </ul>
                    </>
                  ) : (
                    <OptionMenus
                      options={batch.options}
                      selected={line.selected}
                      name={`machine-${line.key}`}
                      onSelect={(menuId, valueId) =>
                        update(line.key, (l) => (l.kind === "custom" ? { ...l, selected: { ...l.selected, [menuId]: valueId } } : l))
                      }
                    />
                  )}
                  <p className="shop-summary-line shop-order-line-amount">
                    <span>Prix indicatif</span>
                    <strong className="bo-num">{formatCents(lineAmount(line))}</strong>
                  </p>
                </section>
              </li>
            );
          })}
        </ol>

        <div className="bo-actions">
          <button
            type="button"
            className="bo-btn bo-btn-secondary"
            onClick={() => setLines((ls) => [...ls, customLine()])}
          >
            Ajouter une machine
          </button>
          {unusedWishlists.length > 0 && (
            <button
              type="button"
              className="bo-btn bo-btn-secondary"
              onClick={() =>
                setLines((ls) => [...ls, ...unusedWishlists.map((w) => wishlistLine(w.id))])
              }
            >
              Reprendre mes machines souhaitées ({unusedWishlists.length})
            </button>
          )}
        </div>
      </section>

      <section className="shop-config" aria-labelledby="adresses">
        <h2 id="adresses">Vos coordonnées</h2>
        <Field
          label="Adresse e-mail"
          hint={
            profileEmail === null
              ? "Notre équipe s'en sert pour vous contacter au sujet de votre commande. Elle sera aussi enregistrée sur votre profil."
              : "Notre équipe s'en sert pour vous contacter au sujet de votre commande."
          }
          warning={
            emailChanged ? (
              <>
                Cette adresse remplacera celle de votre profil ({profileEmail}) pour vos prochaines commandes.
              </>
            ) : undefined
          }
          error={emailError}
        >
          {(field) => (
            <input
              {...field}
              ref={emailRef}
              className="bo-input"
              type="email"
              name="email"
              autoComplete="email"
              spellCheck={false}
              required
              aria-required="true"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          )}
        </Field>
        <AddressFields
          legend="Adresse de facturation"
          prefix="billingAddress"
          saved={addresses}
          value={billing}
          onChange={setBilling}
          failure={failure}
          autoCompleteSection="billing"
        />
        <label className="bo-check">
          <input type="checkbox" checked={sameShipping} onChange={(e) => setSameShipping(e.target.checked)} />
          Livrer à l&apos;adresse de facturation
        </label>
        {!sameShipping && (
          <AddressFields
            legend="Adresse de livraison"
            prefix="shippingAddress"
            saved={addresses}
            value={shipping}
            onChange={setShipping}
            failure={failure}
            autoCompleteSection="shipping"
          />
        )}
        <Field
          label="Adresse Bitcoin de remboursement"
          optional
          hint="Si nous devons vous rembourser (annulation, renoncement, paiement en trop), les bitcoins seront envoyés à cette adresse. Vous pourrez l'ajouter ou la modifier plus tard depuis votre commande."
          error={issueAt(failure, "refundAddress")}
        >
          {(field) => (
            <input
              {...field}
              className="bo-input bo-mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={refundAddress}
              onChange={(e) => setRefundAddress(e.target.value)}
            />
          )}
        </Field>
      </section>

      <section className="shop-config" aria-labelledby="recapitulatif">
        <h2 id="recapitulatif">Récapitulatif</h2>
        <ul className="shop-config-list shop-recap">
          {lines.map((line, index) => (
            <li key={line.key}>
              <span>Machine {index + 1}</span>
              <span className="bo-num">{formatCents(lineAmount(line))}</span>
            </li>
          ))}
        </ul>
        <div className="shop-summary">
          <div className="shop-summary-line" aria-live="polite">
            <span>Total pour {machines(lines.length)}</span>
            <strong className="bo-num">{formatCents(total)}</strong>
          </div>
          <p className="bo-hint">
            Montant indicatif : les prix sont relus à la création de la facture. Le montant à payer en bitcoins est fixé
            à ce moment-là, au cours du jour, et la réservation dure 30 minutes.
          </p>
        </div>

        {failure && !emailRefused && (
          <div ref={alertRef} tabIndex={-1} className="shop-alert-focus">
            <ErrorAlert failure={failure}>
              {failure.code === "option_not_offered" && (
                <p style={{ marginTop: 6 }}>Les options proposées ont été mises à jour : vérifiez vos machines.</p>
              )}
              {failure.code === "order_already_pending" && pendingOrderId && (
                <div className="bo-actions" style={{ marginTop: 8 }}>
                  <Link className="bo-btn bo-btn-secondary bo-btn-sm" href={`/mes-commandes/${pendingOrderId}`}>
                    Voir ma facture en attente
                  </Link>
                </div>
              )}
            </ErrorAlert>
          </div>
        )}

        <button type="submit" className="bo-btn bo-btn-primary shop-cta" disabled={pending}>
          {pending ? "Création de la facture…" : "Créer la facture"}
        </button>
        <p className="bo-hint shop-center">Vous paierez ensuite en bitcoins, à l&apos;adresse propre à votre facture.</p>
      </section>
    </form>
  );
}
