"use client";

import Link from "next/link";
import type { listParts } from "@/server/catalog";

export type Part = Awaited<ReturnType<typeof listParts>>["items"][number];
export type PartLink = { partId: string; qty: number };

/** Liste éditable des produits associés à une valeur d'option (produit + quantité). */
export function PartsPicker({
  value,
  parts,
  onChange,
  idPrefix,
}: {
  value: PartLink[];
  parts: Part[];
  onChange: (value: PartLink[]) => void;
  idPrefix: string;
}) {
  if (parts.length === 0) {
    return (
      <p className="bo-hint">
        Aucun produit d&apos;option au catalogue. <Link href="/backoffice/pieces">Ajouter des produits</Link>
      </p>
    );
  }
  const used = new Set(value.map((l) => l.partId));
  const free = parts.filter((p) => !used.has(p.id));
  const update = (index: number, patch: Partial<PartLink>) =>
    onChange(value.map((link, i) => (i === index ? { ...link, ...patch } : link)));

  return (
    <fieldset style={{ border: 0, display: "grid", gap: 8 }}>
      <legend className="bo-label" style={{ marginBottom: 6 }}>
        Produits à monter <span className="bo-optional">(facultatif)</span>
      </legend>
      {value.map((link, index) => (
        <div key={index} className="bo-actions" style={{ flexWrap: "nowrap" }}>
          <label className="bo-visually-hidden" htmlFor={`${idPrefix}-part-${index}`}>
            Produit {index + 1}
          </label>
          <select
            id={`${idPrefix}-part-${index}`}
            className="bo-select bo-input-sm"
            value={link.partId}
            onChange={(e) => update(index, { partId: e.target.value })}
          >
            {parts
              .filter((p) => p.id === link.partId || !used.has(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.reference ? ` (${p.reference})` : ""}
                </option>
              ))}
          </select>
          <label className="bo-visually-hidden" htmlFor={`${idPrefix}-qty-${index}`}>
            Quantité du produit {index + 1}
          </label>
          <input
            id={`${idPrefix}-qty-${index}`}
            className="bo-input bo-input-sm bo-num"
            style={{ width: 80 }}
            type="number"
            min={1}
            max={1000}
            value={link.qty}
            onChange={(e) => update(index, { qty: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
          />
          <button
            type="button"
            className="bo-btn bo-btn-ghost bo-btn-sm"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
            aria-label={`Retirer le produit ${index + 1}`}
          >
            Retirer
          </button>
        </div>
      ))}
      {free.length > 0 && (
        <div>
          <button
            type="button"
            className="bo-btn bo-btn-secondary bo-btn-sm"
            onClick={() => onChange([...value, { partId: free[0].id, qty: 1 }])}
          >
            Ajouter un produit
          </button>
        </div>
      )}
    </fieldset>
  );
}

export function describeParts(parts: { name: string; qty: number }[]): string {
  return parts.length === 0 ? "—" : parts.map((p) => `${p.qty} × ${p.name}`).join(", ");
}
