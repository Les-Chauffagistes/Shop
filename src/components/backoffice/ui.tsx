"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import type { ApiBlocker, ApiFailure } from "./api";

/** Champ de formulaire : libellé, aide et erreur reliés au contrôle (aria-describedby). */
export function Field({
  label,
  optional,
  hint,
  error,
  warning,
  wide,
  children,
}: {
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  /** Avertissement non bloquant (la saisie reste valide), annoncé avec le champ */
  warning?: ReactNode;
  wide?: boolean;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const warningId = warning ? `${id}-warning` : undefined;
  const describedBy = [hintId, errorId, warningId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`bo-field${wide ? " bo-field-wide" : ""}`}>
      <label className="bo-label" htmlFor={id}>
        {label}
        {optional && <span className="bo-optional"> (facultatif)</span>}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && (
        <span className="bo-hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="bo-field-error" id={errorId}>
          {error}
        </span>
      )}
      {warning && (
        <span className="bo-field-warning" id={warningId}>
          {warning}
        </span>
      )}
    </div>
  );
}

/** Saisie d'un montant en euros (texte libre « 1 500,00 », converti en centimes par l'appelant). */
export function MoneyInput({
  value,
  onChange,
  small,
  suffix = "€",
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  small?: boolean;
  suffix?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <div className="bo-input-affix">
      <input
        {...rest}
        className={`bo-input bo-num${small ? " bo-input-sm" : ""}`}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span aria-hidden="true">{suffix}</span>
    </div>
  );
}

/** Libellés des champs de l'API, pour rendre lisibles les `issues` d'une erreur 400. */
const FIELD_LABELS: Record<string, string> = {
  name: "Nom",
  hashrate: "Hashrate",
  hashboardQtt: "Nombre de hashboards",
  description: "Description",
  title: "Titre",
  label: "Libellé",
  price: "Prix",
  position: "Position",
  parts: "Produits",
  reference: "Référence",
  modelId: "Modèle",
  quantity: "Quantité",
  purchasePrice: "Prix d'achat",
  resaleUnitPrice: "Prix de revente",
  optionValues: "Options du lot",
  optionValueId: "Valeur d'option",
  hiddenOptions: "Menus masqués",
  expectedUpdatedAt: "Version du lot",
  defaultOn: "Valeur par défaut",
  isDefault: "Valeur par défaut",
  qty: "Quantité",
  receivedQty: "Quantité reçue",
  partId: "Produit",
  batchId: "Lot",
  kind: "Type",
  priceOverride: "Prix dérogatoire",
  maxQty: "Quantité maximale",
  values: "Valeurs",
  note: "Motif",
  lines: "Machines",
  choices: "Options",
  wishlistId: "Machine souhaitée",
  billingAddress: "Adresse de facturation",
  shippingAddress: "Adresse de livraison",
  addressId: "Adresse enregistrée",
  fullName: "Nom complet",
  company: "Société",
  line1: "Adresse",
  line2: "Complément d'adresse",
  postalCode: "Code postal",
  city: "Ville",
  country: "Pays",
  phone: "Téléphone",
  refundAddress: "Adresse de remboursement",
  destinationAddress: "Adresse de destination",
  reason: "Explication",
  cause: "Motif",
  lineIds: "Machines",
  userId: "Utilisateur",
};

/**
 * Messages des `issues` d'une erreur 400 qui portent exactement sur `path` (ex. `billingAddress.city`),
 * pour les afficher sous le champ concerné. Le message vient du serveur, tel quel.
 */
export function issueAt(failure: ApiFailure | null, path: string): string | null {
  const messages = failure?.issues.filter((issue) => issue.path === path).map((issue) => issue.message) ?? [];
  return messages.length > 0 ? messages.join(" ") : null;
}

function describePath(path: string): string {
  const names = path
    .split(".")
    .filter((part) => !/^\d+$/.test(part))
    .map((part) => FIELD_LABELS[part] ?? part);
  return names.length > 0 ? names.join(" › ") : "Formulaire";
}

const BLOCKER_KINDS: Record<ApiBlocker["kind"], string> = {
  batch: "Lot",
  option_value: "Valeur d'option",
  part_order: "Commande de produit",
  stock_movement: "Historique de stock",
};

/** Ce qui bloque une suppression : un lot est cliquable, les autres éléments sont nommés. */
function BlockerList({ blockers }: { blockers: ApiBlocker[] }) {
  return (
    <>
      <p style={{ marginTop: 6 }}>Ce qui l&apos;empêche :</p>
      <ul>
        {blockers.map((b) => (
          <li key={`${b.kind}-${b.id}`}>
            {BLOCKER_KINDS[b.kind]} :{" "}
            {b.kind === "batch" ? <Link href={`/backoffice/lots/${b.id}`}>{b.label}</Link> : b.label}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Refus du serveur qui porte sur un champ précis (ex. `model_name_taken`) : son message, tel quel,
 * va sous le champ (`fieldError`) ; toute autre erreur reste dans l'alerte du formulaire (`rest`).
 */
export function splitFieldFailure(
  failure: ApiFailure | null,
  code: string,
): { fieldError: string | null; rest: ApiFailure | null } {
  if (failure?.code === code) return { fieldError: failure.message, rest: null };
  return { fieldError: null, rest: failure };
}

/** Message d'erreur de l'API, avec le détail des champs refusés et de ce qui bloque. */
export function ErrorAlert({ failure, children }: { failure: ApiFailure | null; children?: ReactNode }) {
  if (!failure) return null;
  return (
    <div className="bo-alert bo-alert-error" role="alert">
      <strong>{failure.message}</strong>
      {failure.issues.length > 0 && (
        <ul>
          {failure.issues.map((issue, i) => (
            <li key={i}>
              {describePath(issue.path)} : {issue.message}
            </li>
          ))}
        </ul>
      )}
      {failure.blockers.length > 0 && <BlockerList blockers={failure.blockers} />}
      {children}
    </div>
  );
}

/** Message de succès éphémère, annoncé aux lecteurs d'écran. */
export function Notice({ message }: { message: string | null }) {
  return (
    <div aria-live="polite" role="status">
      {message && <div className="bo-alert bo-alert-success">{message}</div>}
    </div>
  );
}
