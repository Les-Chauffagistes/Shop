"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { listRefundsToSend } from "@/server/backoffice-orders";
import { formatShortDateTime } from "@/lib/dates";
import { feePayerLabel, formatBtc, formatSats } from "@/components/money";
import { api, toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { DataGrid } from "../DataGrid";
import { ErrorAlert, Field, issueAt, Notice } from "../ui";

type ToSend = Awaited<ReturnType<typeof listRefundsToSend>>["items"][number];

/**
 * Remboursements à envoyer depuis le portefeuille de la boutique. L'admin voit l'adresse effective,
 * envoie, puis enregistre l'envoi avec la référence de la transaction et l'adresse utilisée (recopiée
 * par lui : le serveur la compare à l'adresse effective). Adresse changée entre-temps
 * (`409 refund_destination_changed`) : la liste est relue et la nouvelle adresse est montrée, à confirmer.
 */
export function RefundsToSend({ items }: { items: ToSend[] }) {
  const router = useRouter();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [destination, setDestination] = useState("");
  /** Adresse affichée quand le dialogue a été ouvert (ou relue après un changement) */
  const [shownAddress, setShownAddress] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const target = items.find((i) => i.refundId === targetId) ?? null;
  // Après relecture (adresse changée), la liste à jour donne la nouvelle adresse effective
  const changed = target !== null && failure?.code === "refund_destination_changed" && target.destinationAddress !== shownAddress;

  function open(item: ToSend) {
    setTargetId(item.refundId);
    setReference("");
    setDestination(item.destinationAddress ?? "");
    setShownAddress(item.destinationAddress);
    setFailure(null);
  }

  async function send() {
    if (!target) return;
    setPending(true);
    setFailure(null);
    try {
      await api("POST", `/api/backoffice/refunds/${target.refundId}/send`, {
        reference: reference.trim(),
        destinationAddress: destination.trim(),
      });
      setNotice(`Envoi enregistré : ${formatSats(target.amountSats)} pour le client n° ${target.user.authUserId}.`);
      setTargetId(null);
      router.refresh();
    } catch (error) {
      const f = toFailure(error);
      setFailure(f);
      // Adresse changée ou envoi déjà fait : relire la liste (le dialogue montre ce qui a changé)
      if (f.code === "refund_destination_changed" || f.code === "refund_already_sent") router.refresh();
    } finally {
      setPending(false);
    }
  }

  const columns = useMemo<ColDef<ToSend>[]>(
    () => [
      {
        colId: "amount",
        headerName: "À envoyer",
        width: 170,
        valueGetter: (p) => p.data?.amountSats,
        cellRenderer: (p: ICellRendererParams<ToSend>) => (
          <span style={{ display: "grid", lineHeight: 1.3 }}>
            <strong className="bo-num">{formatSats(p.data!.amountSats)}</strong>
            <span className="bo-muted bo-num" style={{ fontSize: 12.5 }}>
              {formatBtc(p.data!.amountSats)}
            </span>
          </span>
        ),
      },
      {
        colId: "destination",
        headerName: "Adresse de destination",
        flex: 2,
        minWidth: 240,
        wrapText: true,
        autoHeight: true,
        cellStyle: { lineHeight: "1.35", paddingTop: "8px", paddingBottom: "8px" },
        valueGetter: (p) => p.data?.destinationAddress,
        cellRenderer: (p: ICellRendererParams<ToSend>) =>
          p.data!.addressMissing ? (
            <span className="bo-cell-attention">Adresse manquante : contacter le client</span>
          ) : (
            <span className="bo-mono">{p.data!.destinationAddress}</span>
          ),
      },
      {
        colId: "cause",
        headerName: "Motif",
        flex: 1,
        minWidth: 180,
        wrapText: true,
        autoHeight: true,
        cellStyle: { lineHeight: "1.35", paddingTop: "8px", paddingBottom: "8px" },
        valueGetter: (p) => p.data?.causeLabel,
        cellRenderer: (p: ICellRendererParams<ToSend>) => (
          <span style={{ display: "grid" }}>
            <span>{p.data!.causeLabel}</span>
            <span className="bo-muted" style={{ fontSize: 12.5 }}>
              Frais {formatSats(p.data!.networkFeeSats)}, {feePayerLabel(p.data!.networkFeePayer)}
            </span>
          </span>
        ),
      },
      {
        colId: "order",
        headerName: "Facture",
        width: 170,
        valueGetter: (p) => p.data?.batch.name,
        cellRenderer: (p: ICellRendererParams<ToSend>) => (
          <span style={{ display: "grid", lineHeight: 1.3 }}>
            <Link href={`/backoffice/factures/${p.data!.orderId}`}>{p.data!.batch.name}</Link>
            <span className="bo-muted" style={{ fontSize: 12.5 }}>
              Client n° {p.data!.user.authUserId}
            </span>
          </span>
        ),
      },
      { field: "createdAt", headerName: "Décidé le", width: 130, valueFormatter: (p) => formatShortDateTime(p.value) },
      {
        colId: "action",
        headerName: "Action",
        width: 190,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<ToSend>) => (
          <button
            type="button"
            className="bo-btn bo-btn-primary bo-btn-sm"
            aria-label={`Enregistrer l'envoi de ${formatSats(p.data!.amountSats)} au client n° ${p.data!.user.authUserId}`}
            onClick={() => open(p.data!)}
          >
            Enregistrer l&apos;envoi
          </button>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <Notice message={notice} />
      {items.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucun remboursement à envoyer</h2>
          <p>Les remboursements décidés (renoncements, annulations, excédents) apparaissent ici jusqu&apos;à leur envoi.</p>
        </div>
      ) : (
        <DataGrid<ToSend> label="Remboursements à envoyer" rowData={items} columnDefs={columns} getRowId={(p) => p.data.refundId} />
      )}
      <ConfirmDialog
        open={targetId !== null}
        title="Enregistrer l'envoi du remboursement"
        confirmLabel={changed ? "Confirmer avec la nouvelle adresse" : "Enregistrer l'envoi"}
        pending={pending}
        onConfirm={send}
        onClose={() => setTargetId(null)}
      >
        {target ? (
          <>
            <p>
              Envoyez <strong>{formatBtc(target.amountSats)}</strong> ({formatSats(target.amountSats)}) depuis le portefeuille
              de la boutique, puis indiquez la transaction et l&apos;adresse utilisées.
            </p>
            {changed && (
              <div className="bo-alert bo-alert-warning" role="alert">
                L&apos;adresse de remboursement a changé entre-temps. Nouvelle adresse :{" "}
                <span className="bo-mono">{target.destinationAddress ?? "aucune"}</span>. Vérifiez-la avant de confirmer.
                <div>
                  <button
                    type="button"
                    className="bo-btn bo-btn-secondary bo-btn-sm"
                    onClick={() => {
                      setDestination(target.destinationAddress ?? "");
                      setShownAddress(target.destinationAddress);
                      setFailure(null);
                    }}
                  >
                    Utiliser la nouvelle adresse
                  </button>
                </div>
              </div>
            )}
            {!changed && target.addressMissing && (
              <p className="bo-alert bo-alert-warning">
                Aucune adresse connue : saisissez celle que le client vous a communiquée.
              </p>
            )}
            <Field
              label="Adresse de destination"
              hint="Recopiez l'adresse à laquelle vous avez envoyé les fonds."
              error={issueAt(failure, "destinationAddress")}
            >
              {(field) => (
                <input
                  {...field}
                  className="bo-input bo-mono"
                  autoComplete="off"
                  spellCheck={false}
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
              )}
            </Field>
            <Field label="Référence de la transaction (txid)" error={issueAt(failure, "reference")}>
              {(field) => (
                <input
                  {...field}
                  className="bo-input bo-mono"
                  autoComplete="off"
                  spellCheck={false}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              )}
            </Field>
          </>
        ) : (
          <p>Ce remboursement n&apos;est plus à envoyer (déjà enregistré).</p>
        )}
        {!changed && <ErrorAlert failure={failure} />}
      </ConfirmDialog>
    </>
  );
}
