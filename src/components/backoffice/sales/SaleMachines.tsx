"use client";

import { useState } from "react";
import type { getPublicBatch } from "@/server/shop";
import { formatCents } from "@/lib/decimal";
import { plural } from "@/lib/plural";
import { OptionMenus } from "@/components/shop/OptionMenus";
import { api, toFailure, type ApiFailure } from "../api";
import { machineName, type Machine } from "../machines/types";
import { ErrorAlert, Field } from "../ui";
import type { Selection } from "./sale-request";

/** Lot ouvert à la vente, avec ses options (fiche produit, docs/api.md « PublicBatch »). */
export type SaleBatch = Awaited<ReturnType<typeof getPublicBatch>>;

/** Libellé d'un lot dans la liste : nom, statut, disponibles, prix de la machine nue. */
export const batchLabel = (b: SaleBatch) =>
  `${b.name} · ${b.statusLabel} · ${plural(b.availableQuantity, "disponible", "disponibles")} · ${formatCents(b.resaleUnitPrice)}`;

/**
 * Machines vendues : lot, nombre, options (une configuration pour toutes, ou par machine) et, sur un lot de stock,
 * machines choisies à la main (facultatif : sinon le serveur les choisit, prêtes d'abord).
 */
export function SaleMachines({
  batches,
  batch,
  onBatchChange,
  countText,
  onCountChange,
  countError,
  perMachine,
  onPerMachineChange,
  selections,
  onSelect,
  picks,
  onPick,
}: {
  batches: SaleBatch[];
  batch: SaleBatch | null;
  onBatchChange: (batchId: string) => void;
  countText: string;
  onCountChange: (text: string) => void;
  countError: string | null;
  perMachine: boolean;
  onPerMachineChange: (value: boolean) => void;
  selections: Selection[];
  onSelect: (index: number, menuId: string, valueId: string) => void;
  picks: (string | null)[];
  onPick: (index: number, machineId: string | null) => void;
}) {
  const count = Math.max(1, Number.parseInt(countText, 10) || 1);
  const configured = perMachine ? count : 1;
  return (
    <section className="bo-card bo-stack" aria-labelledby="vente-machines">
      <h2 id="vente-machines">Machines</h2>
      <div className="bo-fields">
        <Field label="Lot" wide hint={batch?.kind === "stock" ? "Lot de stock : machines contrôlées, livrables tout de suite." : undefined}>
          {(field) => (
            <select {...field} className="bo-select" value={batch?.id ?? ""} onChange={(e) => onBatchChange(e.target.value)}>
              {!batch && <option value="">Choisissez un lot</option>}
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {batchLabel(b)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Nombre de machines"
          hint={batch ? `${plural(batch.maxMachinesPerOrder, "machine", "machines")} au plus par facture.` : undefined}
          error={countError}
        >
          {(field) => (
            <input
              {...field}
              className="bo-input bo-num shop-qty"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={countText}
              onChange={(e) => onCountChange(e.target.value)}
            />
          )}
        </Field>
      </div>
      {batch && batch.options.length > 0 && (
        <>
          {count > 1 && (
            <label className="bo-check">
              <input type="checkbox" checked={!perMachine} onChange={(e) => onPerMachineChange(!e.target.checked)} />
              Même configuration pour toutes les machines
            </label>
          )}
          {Array.from({ length: configured }, (_, i) => (
            <div key={`${batch.id}-${i}`} className="bo-stack">
              {configured > 1 && <h3>Machine {i + 1}</h3>}
              <OptionMenus
                options={batch.options}
                selected={selections[i] ?? {}}
                onSelect={(menuId, valueId) => onSelect(i, menuId, valueId)}
                name={`vente-${i}`}
              />
            </div>
          ))}
        </>
      )}
      {batch?.kind === "stock" && <StockMachinePicker key={batch.id} batchId={batch.id} count={count} picks={picks} onPick={onPick} />}
    </section>
  );
}

/**
 * Choix des machines d'un lot de stock, replié par défaut : les machines attribuables (vendables, libres) sont lues à
 * l'ouverture. « Choix automatique » laisse le serveur choisir (prêtes d'abord, puis les plus anciennes reçues).
 */
function StockMachinePicker({
  batchId,
  count,
  picks,
  onPick,
}: {
  batchId: string;
  count: number;
  picks: (string | null)[];
  onPick: (index: number, machineId: string | null) => void;
}) {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  async function load() {
    if (machines) return;
    try {
      const { items } = await api<{ items: Machine[] }>("GET", `/api/backoffice/machines?batchId=${batchId}&pageSize=500`);
      setMachines(items.filter((m) => m.assignable));
    } catch (error) {
      setFailure(toFailure(error));
    }
  }

  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary className="bo-label" style={{ cursor: "pointer" }}>
        Choisir les machines (facultatif)
      </summary>
      <p className="bo-hint" style={{ margin: "8px 0 12px" }}>
        Sans choix, les machines sont attribuées d&apos;office : les prêtes d&apos;abord, puis les plus anciennes reçues.
      </p>
      <ErrorAlert failure={failure} />
      {!failure && machines === null && <p className="bo-muted">Chargement des machines…</p>}
      {machines?.length === 0 && <p className="bo-muted">Aucune machine disponible à choisir dans ce lot.</p>}
      {machines && machines.length > 0 && (
        <div className="bo-fields">
          {Array.from({ length: count }, (_, i) => (
            <Field key={i} label={`Machine ${i + 1}`}>
              {(field) => (
                <select
                  {...field}
                  className="bo-select"
                  value={picks[i] ?? ""}
                  onChange={(e) => onPick(i, e.target.value === "" ? null : e.target.value)}
                >
                  <option value="">Choix automatique</option>
                  {machines
                    .filter((m) => m.id === picks[i] || !picks.slice(0, count).includes(m.id))
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {machineName(m)} · {m.logisticalLabel}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          ))}
        </div>
      )}
    </details>
  );
}
