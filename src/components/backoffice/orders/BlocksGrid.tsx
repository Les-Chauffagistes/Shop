"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { listOrderBlocks } from "@/server/backoffice-orders";
import { formatShortDateTime } from "@/lib/dates";
import { api, toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { DataGrid } from "../DataGrid";
import { ErrorAlert, Field, Notice } from "../ui";
import { ContactEmails } from "./ContactEmails";

type Block = Awaited<ReturnType<typeof listOrderBlocks>>["items"][number];

/** Utilisateurs bloqués après trop d'abandons, avec « Lever le blocage » (motif facultatif). */
export function BlocksGrid({ items }: { items: Block[] }) {
  const router = useRouter();
  const [target, setTarget] = useState<Block | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const columns = useMemo<ColDef<Block>[]>(
    () => [
      {
        colId: "user",
        headerName: "Client",
        width: 240,
        wrapText: true,
        autoHeight: true,
        cellStyle: { lineHeight: "1.35", paddingTop: "8px", paddingBottom: "8px" },
        valueGetter: (p) => `n° ${p.data?.user.authUserId} ${p.data?.contactEmail ?? p.data?.profileEmail ?? ""}`,
        cellRenderer: (p: ICellRendererParams<Block>) => (
          <span style={{ display: "grid", gap: 2, lineHeight: 1.35 }}>
            <span>n° {p.data!.user.authUserId}</span>
            <ContactEmails contactEmail={p.data!.contactEmail} profileEmail={p.data!.profileEmail} compact />
          </span>
        ),
      },
      {
        colId: "batch",
        headerName: "Lot",
        flex: 1,
        minWidth: 160,
        valueGetter: (p) => p.data?.batch.name,
        cellRenderer: (p: ICellRendererParams<Block>) => <Link href={`/backoffice/lots/${p.data!.batch.id}`}>{p.value}</Link>,
      },
      { field: "abandonedOrders", headerName: "Abandons", width: 110, cellClass: "bo-num" },
      { field: "blockedAt", headerName: "Bloqué le", width: 150, valueFormatter: (p) => formatShortDateTime(p.value) },
      {
        field: "lastReleasedAt",
        headerName: "Dernière levée",
        width: 150,
        valueFormatter: (p) => (p.value ? formatShortDateTime(p.value) : "Jamais"),
      },
      {
        colId: "action",
        headerName: "Action",
        width: 180,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Block>) => (
          <button
            type="button"
            className="bo-btn bo-btn-secondary bo-btn-sm"
            aria-label={`Lever le blocage du client n° ${p.data!.user.authUserId} sur ${p.data!.batch.name}`}
            onClick={() => {
              setReason("");
              setFailure(null);
              setTarget(p.data!);
            }}
          >
            Lever le blocage
          </button>
        ),
      },
    ],
    [],
  );

  async function release() {
    if (!target) return;
    setPending(true);
    setFailure(null);
    try {
      await api("POST", "/api/backoffice/order-block-releases", {
        userId: target.user.id,
        batchId: target.batch.id,
        reason: reason.trim() === "" ? null : reason.trim(),
      });
      setNotice(`Blocage levé pour le client n° ${target.user.authUserId} sur ${target.batch.name}.`);
      setTarget(null);
      router.refresh();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Notice message={notice} />
      {items.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucun utilisateur bloqué</h2>
          <p>Un utilisateur est bloqué sur un lot après plusieurs factures abandonnées (annulées ou expirées sans paiement complet).</p>
        </div>
      ) : (
        <DataGrid<Block>
          label="Utilisateurs bloqués"
          rowData={items}
          columnDefs={columns}
          getRowId={(p) => `${p.data.user.id}-${p.data.batch.id}`}
        />
      )}
      <ConfirmDialog
        open={target !== null}
        title="Lever le blocage ?"
        confirmLabel="Lever le blocage"
        pending={pending}
        onConfirm={release}
        onClose={() => setTarget(null)}
      >
        {target && (
          <p>
            Client n° {target.user.authUserId} sur {target.batch.name} : ses abandons passés sur ce lot ne comptent plus, il peut
            de nouveau créer une facture.
          </p>
        )}
        <Field label="Explication" optional>
          {(field) => <input {...field} className="bo-input" value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <ErrorAlert failure={failure} />
      </ConfirmDialog>
    </>
  );
}
