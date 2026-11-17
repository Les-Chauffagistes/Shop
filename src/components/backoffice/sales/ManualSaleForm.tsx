"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { formatCents } from "@/lib/decimal";
import { addressPayload } from "@/components/shop/AddressFields";
import { api, detailOf, toFailure, type ApiFailure } from "../api";
import { ErrorAlert, Field, issueAt } from "../ui";
import { CustomerSection, defaultAddresses, useCustomerSearch, type SaleAddresses } from "./CustomerSection";
import { SaleMachines, type SaleBatch } from "./SaleMachines";
import { indicativeTotal, saleBody, saleLines, type Means, type SaleBody, type Selection } from "./sale-request";

/**
 * Vente manuelle (backoffice) : client retrouvé par pseudo ou e-mail parmi les comptes locaux, lot et machines, encaissement hors
 * chaîne. La facture naît payée (`POST /api/backoffice/manual-sales`) ; l'écran s'ouvre ensuite sur elle. Toutes les
 * règles (prix, stock, priorité, blocage) sont tranchées par le serveur, dont les refus s'affichent tels quels ; un
 * client bloqué se débloque en un clic, puis la même vente est renvoyée.
 */
export function ManualSaleForm({
  batches,
  initialBatchId,
  means: meansOptions,
  defaultReason,
}: {
  batches: SaleBatch[];
  initialBatchId: string | null;
  /** Moyens d'encaissement et leurs libellés (serveur) */
  means: [Means, string][];
  defaultReason: string;
}) {
  const router = useRouter();
  const id = useId();
  // Client
  const [query, setQuery] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const search = useCustomerSearch(query);
  const customers = search.items;
  const typed = query.trim().toLowerCase();
  const exact = customers.find((c) => c.email?.toLowerCase() === typed || c.pseudo?.toLowerCase() === typed);
  // Un pseudo ou e-mail identique trouvé est repris d'office
  const selectedKey = customers.some((c) => c.id === picked) ? picked : (exact?.id ?? null);
  const customer = customers.find((c) => c.id === selectedKey) ?? null;
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [addressState, setAddresses] = useState<SaleAddresses>(() => defaultAddresses("none", null));
  const addressKey = selectedKey ?? "none";
  const addresses = addressState.forKey === addressKey ? addressState : defaultAddresses(addressKey, customer);
  // Machines
  const [batchId, setBatchId] = useState(initialBatchId ?? "");
  const batch = batches.find((b) => b.id === batchId) ?? null;
  const [countText, setCountText] = useState("1");
  const [countError, setCountError] = useState<string | null>(null);
  const [perMachine, setPerMachine] = useState(false);
  const [selections, setSelections] = useState<Selection[]>([]);
  const [picks, setPicks] = useState<(string | null)[]>([]);
  // Encaissement
  const [means, setMeans] = useState<Means>(meansOptions[0][0]);
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState(defaultReason);
  // Envoi
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<ApiFailure | null>(null);
  const lastSale = useRef<SaleBody | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failed) alertRef.current?.focus();
  }, [failed]);

  const count = Number(countText.trim());
  const countValid = /^\d+$/.test(countText.trim()) && count >= 1;
  const lines = batch && countValid ? saleLines(batch.options, selections, count, perMachine) : [];
  // Prix indicatif (le serveur relit les prix du lot)
  const total = batch && countValid ? indicativeTotal(batch.resaleUnitPrice, batch.options, selections, count, perMachine) : null;
  const failure = failed;
  const saleFailure = failed;

  async function sendSale(body: SaleBody) {
    lastSale.current = body;
    const order = await api<{ id: string }>("POST", "/api/backoffice/manual-sales", body);
    router.push(`/backoffice/factures/${order.id}?fait=vente`);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (selectedKey === null) {
      setCustomerError("Retrouvez le client par son pseudo ou son e-mail : il doit s'être connecté une fois à la boutique.");
      return;
    }
    if (!countValid) {
      setCountError("Indiquez un nombre entier de machines (1 ou plus).");
      return;
    }
    setCountError(null);
    setFailed(null);
    setPending(true);
    try {
      await sendSale(
        saleBody({
          userId: customer!.id,
          contactEmail,
          batchId,
          lines,
          machineIds: batch?.kind === "stock" ? picks : [],
          billing: addressPayload(addresses.billing),
          shipping: addresses.sameShipping ? null : addressPayload(addresses.shipping),
          means,
          reference,
          reason,
        }),
      );
    } catch (error) {
      setFailed(toFailure(error));
      setPending(false);
    }
  }

  /** « Lever le blocage » du client sur ce lot, puis renvoyer la même vente. */
  async function releaseAndRetry() {
    const body = lastSale.current;
    if (!body || pending) return;
    setPending(true);
    try {
      await api("POST", "/api/backoffice/order-block-releases", {
        userId: detailOf(failure, "userId") ?? body.userId,
        batchId: detailOf(failure, "batchId") ?? body.batchId,
        reason: "Levé pour une vente manuelle",
      });
      setFailed(null);
      await sendSale(body);
    } catch (error) {
      setFailed(toFailure(error));
      setPending(false);
    }
  }

  // Le message du serveur donne déjà la date de levée automatique
  const blocked = failure?.code === "order_creation_blocked";
  const pendingOrderId = failure?.code === "order_already_pending" ? detailOf(failure, "orderId") : null;

  return (
    <form className="bo-stack" onSubmit={submit} noValidate aria-label="Vente manuelle">
      <CustomerSection
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setContactEmail("");
          setPicked(null);
          setCustomerError(null);
        }}
        contactEmail={contactEmail}
        onContactEmailChange={setContactEmail}
        customerError={customerError}
        customers={customers}
        selectedKey={selectedKey}
        onSelect={(key) => {
          setPicked(key);
          setCustomerError(null);
        }}
        searching={search.searching}
        searchFailure={search.failure}
        addresses={addresses}
        onAddressesChange={setAddresses}
        failure={failure}
        addressPrefix="billingAddress"
      />
      <SaleMachines
        batches={batches}
        batch={batch}
        onBatchChange={(next) => {
          setBatchId(next);
          setSelections([]);
          setPicks([]);
        }}
        countText={countText}
        onCountChange={(text) => {
          setCountText(text);
          setCountError(null);
        }}
        countError={countError ?? issueAt(saleFailure, "lines")}
        perMachine={perMachine}
        onPerMachineChange={setPerMachine}
        selections={selections}
        onSelect={(i, menuId, valueId) =>
          setSelections((cur) => {
            const next = [...cur];
            next[i] = { ...next[i], [menuId]: valueId };
            return next;
          })
        }
        picks={picks}
        onPick={(i, machineId) =>
          setPicks((cur) => {
            const next = [...cur];
            next[i] = machineId;
            return next;
          })
        }
      />
      <section className="bo-card bo-stack" aria-labelledby="vente-encaissement">
        <h2 id="vente-encaissement">Encaissement</h2>
        <fieldset className="bo-segmented" aria-label="Moyen d'encaissement">
          {meansOptions.map(([value, label]) => (
            <label key={value}>
              <input type="radio" name={`${id}-means`} value={value} checked={means === value} onChange={() => setMeans(value)} />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="bo-fields">
          <Field
            label="Référence"
            optional={means !== "other"}
            hint="N° de virement, reçu, chèque…"
            error={issueAt(saleFailure, "reference")}
          >
            {(field) => <input {...field} className="bo-input" autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />}
          </Field>
          <Field label="Motif de la vente" hint="Tracé sur la facture." error={issueAt(saleFailure, "reason")}>
            {(field) => <input {...field} className="bo-input" autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
      </section>

      {failure && (
        <div ref={alertRef} tabIndex={-1} className="shop-alert-focus">
          <ErrorAlert failure={failure}>
            {blocked && (
              <div className="bo-actions" style={{ marginTop: 8 }}>
                <button type="button" className="bo-btn bo-btn-primary bo-btn-sm" disabled={pending} onClick={releaseAndRetry}>
                  {pending ? "En cours…" : "Lever le blocage et valider la vente"}
                </button>
              </div>
            )}
            {pendingOrderId && (
              <p style={{ marginTop: 6 }}>
                <Link href={`/backoffice/factures/${pendingOrderId}`}>Ouvrir la facture en attente</Link>
              </p>
            )}
          </ErrorAlert>
        </div>
      )}

      <div className="bo-actions">
        <button type="submit" className="bo-btn bo-btn-primary" disabled={pending || !batch}>
          {pending ? "Enregistrement…" : total ? `Enregistrer la vente · ${formatCents(total)}` : "Enregistrer la vente"}
        </button>
        <span className="bo-hint">La facture naît payée. Prix du lot, relu par le serveur.</span>
      </div>
    </form>
  );
}
