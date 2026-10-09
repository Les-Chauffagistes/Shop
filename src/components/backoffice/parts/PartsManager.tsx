"use client";

import type { CellValueChangedEvent, ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { listParts } from "@/server/catalog";
import type { PartPressure } from "@/server/part-stock";
import { api, toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { DataGrid } from "../DataGrid";
import { PressureBadge } from "../stock/pressure";
import { ErrorAlert, Field, Notice, splitFieldFailure } from "../ui";

/** Produit d'option du catalogue, avec son stock commun et sa pression (null si absent de la vue). */
type Part = Awaited<ReturnType<typeof listParts>>["items"][number] & { stock: PartPressure | null };

const stockOf = (p: { data?: Part }) => p.data?.stock ?? null;

/** Source donnée à la remise de l'ancienne valeur d'une cellule refusée (pas un nouvel enregistrement). */
const REVERT = "revert";

export function PartsManager({ parts }: { parts: Part[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Part | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<ApiFailure | null>(null);
  const [touched, setTouched] = useState(false);
  const nameError = touched && !name.trim() ? "Indiquez le nom du produit, ex. Silent kit." : null;
  // Nom déjà pris à la création : message du serveur sous le champ « Nom »
  const { fieldError: nameTaken, rest: createFailure } = splitFieldFailure(failure, "part_name_taken");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (nameTaken) nameRef.current?.focus();
  }, [nameTaken]);
  // Modification refusée dans la grille : affichée au-dessus de la grille, avec la ligne concernée
  const [gridFailure, setGridFailure] = useState<{ failure: ApiFailure; context: string } | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!name.trim()) return; // erreur affichée sous le champ
    setCreating(true);
    setFailure(null);
    setGridFailure(null);
    setNotice(null);
    try {
      await api("POST", "/api/backoffice/parts", { name, reference: reference || null });
      setNotice(`Produit « ${name.trim()} » ajouté.`);
      setName("");
      setReference("");
      setTouched(false);
      router.refresh();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setCreating(false);
    }
  }

  async function saveCell(event: CellValueChangedEvent<Part>) {
    if (event.source === REVERT || event.newValue === event.oldValue) return;
    const field = event.colDef.field as "name" | "reference";
    setFailure(null);
    setGridFailure(null);
    setNotice(null);
    try {
      await api("PATCH", `/api/backoffice/parts/${event.data.id}`, { [field]: event.newValue ?? null });
      setNotice("Modification enregistrée.");
      router.refresh();
    } catch (error) {
      // Ancienne valeur remise, focus rendu à la cellule pour corriger au clavier
      event.node.setDataValue(field, event.oldValue, REVERT);
      if (event.rowIndex !== null) event.api.setFocusedCell(event.rowIndex, field);
      const previous = String(event.oldValue ?? "");
      setGridFailure({
        failure: toFailure(error),
        context:
          field === "name"
            ? `« ${previous} » garde son nom.`
            : `La référence de « ${event.data.name} » reste ${previous ? `« ${previous} »` : "vide"}.`,
      });
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteFailure(null);
    try {
      await api("DELETE", `/api/backoffice/parts/${toDelete.id}`);
      setNotice(`Produit « ${toDelete.name} » supprimé.`);
      setToDelete(null);
      router.refresh();
    } catch (error) {
      setDeleteFailure(toFailure(error));
    } finally {
      setDeleting(false);
    }
  }

  const columns = useMemo<ColDef<Part>[]>(
    () => [
      { field: "name", headerName: "Nom", editable: true, flex: 2, minWidth: 160, sort: "asc" },
      {
        field: "reference",
        headerName: "Référence",
        editable: true,
        flex: 1,
        minWidth: 110,
        valueFormatter: (p) => p.value || "—",
      },
      {
        colId: "onHand",
        headerName: "En stock",
        width: 110,
        cellClass: "bo-num",
        valueGetter: (p) => stockOf(p)?.onHand ?? null,
      },
      {
        colId: "incoming",
        headerName: "Commandés / en route",
        headerTooltip: "Kits commandés et en route, toutes commandes de lot confondues",
        width: 170,
        cellClass: "bo-num",
        valueGetter: (p) => {
          const s = stockOf(p);
          return s ? `${s.orderingQty} / ${s.awaitingDeliveryQty}` : null;
        },
        sortable: false,
      },
      {
        colId: "firmDemand",
        headerName: "Demande ferme",
        headerTooltip: "Machines payées et factures en attente non expirées, des lots qui n'ont pas encore monté leurs kits",
        width: 140,
        cellClass: "bo-num",
        valueGetter: (p) => stockOf(p)?.firmDemand ?? null,
      },
      {
        colId: "pressure",
        headerName: "Pression",
        headerTooltip: "Demande ferme ÷ stock physique ; alerte au-dessus de 1",
        width: 170,
        // Tri : demande sans stock d'abord, puis pression décroissante
        valueGetter: (p) => {
          const s = stockOf(p);
          if (!s) return null;
          return s.pressure === null ? (s.firmDemand > 0 ? Infinity : 0) : Number(s.pressure);
        },
        cellRenderer: (p: ICellRendererParams<Part>) => (p.data?.stock ? <PressureBadge stock={p.data.stock} /> : "—"),
      },
      {
        colId: "toOrder",
        headerName: "À commander",
        headerTooltip: "Manque une fois comptés les kits commandés et en route",
        width: 130,
        cellClass: "bo-num",
        valueGetter: (p) => stockOf(p)?.toOrder ?? null,
        cellRenderer: (p: ICellRendererParams<Part>) =>
          p.value ? <strong>{p.value}</strong> : <span className="bo-muted">0</span>,
      },
      {
        colId: "potentialDemand",
        headerName: "Demande potentielle",
        headerTooltip: "Manifestations d'intérêt des lots au sondage, hors pression",
        width: 160,
        cellClass: "bo-num",
        valueGetter: (p) => stockOf(p)?.potentialDemand ?? null,
      },
      {
        headerName: "",
        colId: "actions",
        width: 210,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Part>) => (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <Link
              className="bo-btn bo-btn-ghost bo-btn-sm"
              href={`/backoffice/pieces/${p.data?.id}`}
              aria-label={`Stock et journal de ${p.data?.name ?? "ce produit"}`}
            >
              Stock
            </Link>
            <button
            type="button"
            className="bo-btn bo-btn-ghost bo-btn-sm"
            onClick={() => {
              setDeleteFailure(null);
              setToDelete(p.data ?? null);
            }}
            aria-label={`Supprimer ${p.data?.name ?? "le produit"}`}
          >
            Supprimer
          </button>
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="bo-stack">
      <section className="bo-card" aria-labelledby="new-part">
        <h2 id="new-part" style={{ marginBottom: 16 }}>
          Nouveau produit
        </h2>
        <form className="bo-form" onSubmit={create} noValidate>
          <div className="bo-fields">
            <Field label="Nom" error={nameError ?? nameTaken}>
              {(p) => (
                <input
                  {...p}
                  ref={nameRef}
                  className="bo-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={120}
                />
              )}
            </Field>
            <Field label="Référence" optional hint="Référence fournisseur, ex. NF-A12.">
              {(p) => (
                <input {...p} className="bo-input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
              )}
            </Field>
          </div>
          <ErrorAlert failure={createFailure} />
          <div className="bo-actions">
            <button className="bo-btn bo-btn-primary" type="submit" disabled={creating}>
              {creating ? "Ajout…" : "Ajouter le produit"}
            </button>
          </div>
        </form>
      </section>

      <Notice message={notice} />

      {parts.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucun produit d&apos;option</h2>
          <p>Ajoutez les produits achetés pour les options (ex. Silent kit) : leur stock sera suivi ici.</p>
        </div>
      ) : (
        <section aria-labelledby="parts-list">
          <div className="bo-card-head">
            <h2 id="parts-list">
              {parts.length} produit{parts.length > 1 ? "s" : ""}
            </h2>
            <p>Nom et référence : double-cliquez ou appuyez sur Entrée sur la cellule pour la modifier.</p>
          </div>
          {gridFailure && (
            <div style={{ marginBottom: 12 }}>
              <ErrorAlert failure={gridFailure.failure}>
                <p style={{ marginTop: 4 }}>{gridFailure.context}</p>
              </ErrorAlert>
            </div>
          )}
          <DataGrid<Part>
            label="Liste des produits"
            rowData={parts}
            columnDefs={columns}
            getRowId={(p) => p.data.id}
            onCellValueChanged={saveCell}
            stopEditingWhenCellsLoseFocus
          />
        </section>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title="Supprimer le produit ?"
        confirmLabel="Supprimer"
        confirmTone="danger"
        pending={deleting}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      >
        <p>
          « {toDelete?.name} » sera supprimé définitivement. Un produit associé à une option, commandé pour un lot ou
          ayant un historique de stock ne peut pas être supprimé.
        </p>
        <ErrorAlert failure={deleteFailure} />
      </ConfirmDialog>
    </div>
  );
}
