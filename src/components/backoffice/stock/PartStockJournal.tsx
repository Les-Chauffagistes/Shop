"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import type { listMovements } from "@/server/part-stock";
import { formatShortDateTime } from "@/lib/dates";
import { api, toFailure, type ApiFailure } from "../api";
import { DataGrid } from "../DataGrid";
import { ErrorAlert, Field, Notice } from "../ui";

type Movement = Awaited<ReturnType<typeof listMovements>>["items"][number];

const MAX_KITS = 100_000;

/**
 * Saisie d'un mouvement de stock hors commande de lot (réassort, correction d'inventaire) et
 * journal du produit. Les kits montés se saisissent depuis la fiche du lot, les réceptions de
 * commandes de lot depuis la commande.
 */
export function PartStockJournal({
  partId,
  partName,
  onHand,
  movements,
}: {
  partId: string;
  partName: string;
  onHand: number;
  movements: Movement[];
}) {
  const router = useRouter();
  const id = useId();
  const [kind, setKind] = useState<"reception" | "adjustment">("reception");
  const [direction, setDirection] = useState<"add" | "remove">("remove");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const n = Number(qty);
  const qtyValid = qty.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_KITS;
  const qtyError = touched && !qtyValid ? "Nombre entier de kits compris entre 1 et 100 000." : null;
  const noteError = touched && kind === "adjustment" && !note.trim() ? "Indiquez le motif de la correction, ex. kit abîmé." : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setNotice(null);
    setFailure(null);
    if (!qtyValid || (kind === "adjustment" && !note.trim())) return;
    const quantity = kind === "adjustment" && direction === "remove" ? -n : n;
    setPending(true);
    try {
      await api("POST", `/api/backoffice/parts/${partId}/movements`, {
        kind,
        quantity,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNotice(
        quantity > 0
          ? `${quantity} « ${partName} » ajouté${quantity > 1 ? "s" : ""} au stock.`
          : `${-quantity} « ${partName} » retiré${-quantity > 1 ? "s" : ""} du stock.`,
      );
      setQty("");
      setNote("");
      setTouched(false);
      router.refresh();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }

  const columns = useMemo<ColDef<Movement>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Date",
        width: 150,
        valueFormatter: (p) => formatShortDateTime(p.value),
        sort: "desc",
      },
      { field: "kindLabel", headerName: "Mouvement", width: 190 },
      {
        field: "qty",
        headerName: "Quantité",
        width: 110,
        cellClass: "bo-num",
        valueFormatter: (p) => (p.value > 0 ? `+${p.value}` : `−${-p.value}`),
      },
      {
        colId: "batch",
        headerName: "Lot",
        flex: 1,
        minWidth: 140,
        valueGetter: (p) => p.data?.batch?.name ?? null,
        cellRenderer: (p: ICellRendererParams<Movement>) =>
          p.data?.batch ? <Link href={`/backoffice/lots/${p.data.batch.id}`}>{p.data.batch.name}</Link> : "—",
      },
      { field: "note", headerName: "Note", flex: 2, minWidth: 160, valueFormatter: (p) => p.value || "—" },
      { field: "createdBy", headerName: "Par", width: 110, valueFormatter: (p) => `admin n° ${p.value}` },
    ],
    [],
  );

  return (
    <div className="bo-stack">
      <section className="bo-card" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} style={{ marginBottom: 4 }}>
          Mouvement de stock
        </h2>
        <p className="bo-hint" style={{ marginBottom: 16 }}>
          Réassort hors commande de lot, ou correction après inventaire. Les réceptions de commandes de lot et les kits
          montés se saisissent depuis la fiche du lot.
        </p>
        <form className="bo-form" onSubmit={submit} noValidate>
          <fieldset className="bo-segmented" aria-label="Type de mouvement">
            {(
              [
                ["reception", "Réception (réassort)"],
                ["adjustment", "Correction d'inventaire"],
              ] as const
            ).map(([k, label]) => (
              <label key={k}>
                <input type="radio" name={`${id}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="bo-fields">
            {kind === "adjustment" && (
              <Field label="Sens" hint={`${onHand} en stock actuellement.`}>
                {(p) => (
                  <select
                    {...p}
                    className="bo-select"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as "add" | "remove")}
                  >
                    <option value="remove">Retirer du stock</option>
                    <option value="add">Ajouter au stock</option>
                  </select>
                )}
              </Field>
            )}
            <Field label="Nombre de kits" error={qtyError}>
              {(p) => (
                <input
                  {...p}
                  className="bo-input bo-num"
                  type="number"
                  min={1}
                  max={MAX_KITS}
                  step={1}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
              )}
            </Field>
            <Field label={kind === "adjustment" ? "Motif" : "Note"} optional={kind === "reception"} error={noteError} wide>
              {(p) => (
                <input
                  {...p}
                  className="bo-input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  placeholder={kind === "adjustment" ? "Ex. kit abîmé, écart d'inventaire" : "Ex. fournisseur, bon de livraison"}
                />
              )}
            </Field>
          </div>
          <ErrorAlert failure={failure} />
          <Notice message={notice} />
          <div className="bo-actions">
            <button type="submit" className="bo-btn bo-btn-primary" disabled={pending}>
              {pending ? "Enregistrement…" : "Enregistrer le mouvement"}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby={`${id}-journal`}>
        <div className="bo-card-head">
          <h2 id={`${id}-journal`}>Journal</h2>
          <p>{movements.length >= 200 ? "Les 200 derniers mouvements." : "Du plus récent au plus ancien."}</p>
        </div>
        {movements.length === 0 ? (
          <div className="bo-card bo-empty">
            <h2>Aucun mouvement</h2>
            <p>Le stock de ce produit est vide : enregistrez une réception pour commencer.</p>
          </div>
        ) : (
          <DataGrid<Movement> label="Journal du stock" rowData={movements} columnDefs={columns} getRowId={(p) => p.data.id} />
        )}
      </section>
    </div>
  );
}
