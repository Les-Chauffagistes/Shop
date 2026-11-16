"use client";

import { useEffect, useId, useState } from "react";
import type { searchCustomers } from "@/server/manual-sales";
import { addressOneLine } from "@/components/shop/AddressBlock";
import { AddressFields, EMPTY_ADDRESS, type AddressChoice } from "@/components/shop/AddressFields";
import { api, toFailure, type ApiFailure } from "../api";
import { Field, issueAt } from "../ui";
import { customerTitle } from "../orders/labels";

/** Client tel que l'API le renvoie (`Customer`, docs/api.md). */
export type Customer = Awaited<ReturnType<typeof searchCustomers>>["items"][number];

/** Saisie des adresses de la vente, pour un client donné (`forKey` : client pour lequel elles ont été saisies). */
export type SaleAddresses = { forKey: string; billing: AddressChoice; sameShipping: boolean; shipping: AddressChoice };

const SEARCH_DELAY_MS = 250;
const MIN_SEARCH = 3;

/**
 * Recherche des clients par e-mail (`GET /api/backoffice/customers?email=`), au fil de la frappe : la dernière
 * réponse arrivée pour la saisie en cours l'emporte (une réponse plus ancienne est ignorée).
 */
export function useCustomerSearch(email: string) {
  const query = email.trim();
  const [state, setState] = useState<{ query: string; items: Customer[]; failure: ApiFailure | null }>({
    query: "",
    items: [],
    failure: null,
  });
  useEffect(() => {
    if (query.length < MIN_SEARCH) return;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const { items } = await api<{ items: Customer[] }>("GET", `/api/backoffice/customers?email=${encodeURIComponent(query)}`);
        if (current) setState({ query, items, failure: null });
      } catch (error) {
        if (current) setState({ query, items: [], failure: toFailure(error) });
      }
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);
  const ready = query.length >= MIN_SEARCH && state.query === query;
  return { items: ready ? state.items : [], failure: ready ? state.failure : null, searching: query.length >= MIN_SEARCH && !ready };
}

/** Adresses par défaut d'un client : sa plus récente, sinon une nouvelle saisie ; livraison à la même adresse. */
export function defaultAddresses(key: string, customer: Customer | null): SaleAddresses {
  const savedId = customer?.addresses[0]?.id ?? null;
  return { forKey: key, billing: { savedId, draft: EMPTY_ADDRESS }, sameShipping: true, shipping: { savedId, draft: EMPTY_ADDRESS } };
}

/**
 * Client de la vente : e-mail (recherche), reprise d'un compte trouvé (le client doit déjà avoir un compte, créé
 * par lui), puis adresses de facturation et de livraison. Un e-mail identique trouvé est repris d'office.
 */
export function CustomerSection({
  email,
  onEmailChange,
  customers,
  selectedKey,
  onSelect,
  searching,
  searchFailure,
  addresses,
  onAddressesChange,
  failure,
  addressPrefix,
  customerError,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  customers: Customer[];
  /** Identifiant du client retenu, ou `null` (aucun) */
  selectedKey: string | null;
  onSelect: (key: string) => void;
  searching: boolean;
  searchFailure: ApiFailure | null;
  addresses: SaleAddresses;
  onAddressesChange: (next: SaleAddresses) => void;
  failure: ApiFailure | null;
  /** Chemin des erreurs d'adresse (`billingAddress`) */
  addressPrefix: string;
  /** Aucun client retenu à l'envoi */
  customerError: string | null;
}) {
  const name = useId();
  const customer = customers.find((c) => c.id === selectedKey) ?? null;
  const saved = customer?.addresses ?? [];
  const typed = email.trim();

  return (
    <section className="bo-card bo-stack" aria-labelledby="vente-client">
      <h2 id="vente-client">Client</h2>
      <Field
        label="E-mail du client"
        hint={typed.length < MIN_SEARCH ? "Tapez au moins 3 caractères pour retrouver un client." : searching ? "Recherche…" : undefined}
        error={customerError ?? searchFailure?.message ?? issueAt(failure, "email")}
      >
        {(field) => (
          <input
            {...field}
            className="bo-input"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
          />
        )}
      </Field>
      {typed.length >= MIN_SEARCH && !searching && (
        <fieldset className="shop-fieldset">
          <legend className="bo-label">Client retenu</legend>
          <div className="shop-choices">
            {customers.map((c) => (
              <label key={c.id} className="shop-choice">
                <input type="radio" name={name} checked={selectedKey === c.id} onChange={() => onSelect(c.id)} />
                <span className="shop-choice-label">
                  {c.email} · {customerTitle(c.authUserId)}
                </span>
                {c.addresses[0] && (
                  <span className="bo-hint" style={{ gridColumn: "1 / -1" }}>
                    {addressOneLine(c.addresses[0])}
                  </span>
                )}
              </label>
            ))}
            {customers.length === 0 && <p className="bo-muted">Aucun compte trouvé. Cette personne doit d&apos;abord créer un compte sur la boutique.</p>}
          </div>
        </fieldset>
      )}
      {selectedKey !== null && (
        <>
          <AddressFields
            legend="Adresse de facturation"
            prefix={addressPrefix}
            saved={saved}
            value={addresses.billing}
            onChange={(billing) => onAddressesChange({ ...addresses, billing })}
            failure={failure}
            autoCompleteSection="billing"
          />
          <label className="bo-check">
            <input
              type="checkbox"
              checked={addresses.sameShipping}
              onChange={(e) => onAddressesChange({ ...addresses, sameShipping: e.target.checked })}
            />
            Livraison à l&apos;adresse de facturation
          </label>
          {!addresses.sameShipping && (
            <AddressFields
              legend="Adresse de livraison"
              prefix="shippingAddress"
              saved={saved}
              value={addresses.shipping}
              onChange={(shipping) => onAddressesChange({ ...addresses, shipping })}
              failure={failure}
              autoCompleteSection="shipping"
            />
          )}
        </>
      )}
    </section>
  );
}
