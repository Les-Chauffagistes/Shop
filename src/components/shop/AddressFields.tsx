"use client";

import { useId } from "react";
import type { ApiFailure } from "@/components/backoffice/api";
import { Field, issueAt } from "@/components/backoffice/ui";
import { addressOneLine, type PostalAddress } from "./AddressBlock";

/** Saisie d'une adresse : champs de l'API (`docs/api.md`, `POST /api/orders`). */
export type AddressDraft = {
  fullName: string;
  company: string;
  line1: string;
  line2: string;
  postalCode: string;
  city: string;
  country: string;
  phone: string;
};

export const EMPTY_ADDRESS: AddressDraft = {
  fullName: "",
  company: "",
  line1: "",
  line2: "",
  postalCode: "",
  city: "",
  country: "FR",
  phone: "",
};

/** Adresse choisie : une adresse enregistrée (`addressId`) ou une nouvelle saisie. */
export type AddressChoice = { savedId: string | null; draft: AddressDraft };

/** Corps de l'API : `{ addressId }` ou les champs saisis (facultatifs vides → null). */
export function addressPayload(choice: AddressChoice) {
  if (choice.savedId) return { addressId: choice.savedId };
  const d = choice.draft;
  const opt = (v: string) => (v.trim() === "" ? null : v);
  return {
    fullName: d.fullName,
    company: opt(d.company),
    line1: d.line1,
    line2: opt(d.line2),
    postalCode: d.postalCode,
    city: d.city,
    country: d.country,
    phone: opt(d.phone),
  };
}

const FIELDS: { key: keyof AddressDraft; label: string; optional?: boolean; autoComplete: string; wide?: boolean }[] = [
  { key: "fullName", label: "Nom complet", autoComplete: "name", wide: true },
  { key: "company", label: "Société", optional: true, autoComplete: "organization", wide: true },
  { key: "line1", label: "Adresse", autoComplete: "address-line1", wide: true },
  { key: "line2", label: "Complément d'adresse", optional: true, autoComplete: "address-line2", wide: true },
  { key: "postalCode", label: "Code postal", autoComplete: "postal-code" },
  { key: "city", label: "Ville", autoComplete: "address-level2" },
  { key: "country", label: "Pays (code à deux lettres)", autoComplete: "country" },
  { key: "phone", label: "Téléphone", optional: true, autoComplete: "tel" },
];

/**
 * Adresse de facturation ou de livraison : une adresse enregistrée (`GET /api/addresses`) ou une
 * nouvelle saisie. Les champs obligatoires ne sont pas contrôlés ici : le serveur répond champ par
 * champ (`issues`), et son message s'affiche sous le champ (`path` = `{prefix}.{champ}`).
 */
export function AddressFields({
  legend,
  prefix,
  saved,
  value,
  onChange,
  failure,
  autoCompleteSection,
}: {
  legend: string;
  /** Chemin de l'API (`billingAddress`, `shippingAddress`) pour rattacher les erreurs */
  prefix: string;
  saved: PostalAddress[];
  value: AddressChoice;
  onChange: (value: AddressChoice) => void;
  failure: ApiFailure | null;
  autoCompleteSection: "billing" | "shipping";
}) {
  const name = useId();
  const setField = (key: keyof AddressDraft, v: string) => onChange({ ...value, draft: { ...value.draft, [key]: v } });
  const savedError = issueAt(failure, `${prefix}.addressId`);

  return (
    <fieldset className="shop-fieldset">
      <legend>{legend}</legend>
      {saved.length > 0 && (
        <div className="shop-choices">
          {saved.map((a) => (
            <label key={a.id} className="shop-choice">
              <input
                type="radio"
                name={name}
                checked={value.savedId === a.id}
                onChange={() => onChange({ ...value, savedId: a.id })}
              />
              <span className="shop-choice-label">{addressOneLine(a)}</span>
            </label>
          ))}
          <label className="shop-choice">
            <input type="radio" name={name} checked={value.savedId === null} onChange={() => onChange({ ...value, savedId: null })} />
            <span className="shop-choice-label">Nouvelle adresse</span>
          </label>
          {savedError && <span className="bo-field-error">{savedError}</span>}
        </div>
      )}
      {value.savedId === null && (
        <div className="bo-fields">
          {FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              optional={f.optional}
              wide={f.wide}
              error={issueAt(failure, `${prefix}.${f.key}`)}
            >
              {(field) => (
                <input
                  {...field}
                  className="bo-input"
                  type={f.key === "phone" ? "tel" : "text"}
                  autoComplete={`section-${autoCompleteSection} ${autoCompleteSection} ${f.autoComplete}`}
                  value={value.draft[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
              )}
            </Field>
          ))}
        </div>
      )}
    </fieldset>
  );
}
