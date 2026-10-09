"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { getBatchPartNeeds } from "@/server/part-stock";
import { formatDate } from "@/lib/dates";
import { api, ApiFailure, toFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Field, Notice } from "../ui";
import { isShort, PressureBadge, shortfallSentence } from "./pressure";

type Needs = Awaited<ReturnType<typeof getBatchPartNeeds>>;
type Need = Needs["parts"][number];
type PartOrder = Needs["orders"][number];
type PartOption = { id: string; name: string; reference: string | null };

/** Quantité de kits saisie : entier de 1 à 100 000 (bornes de l'API), sinon null. */
function parseKits(text: string): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : null;
}

const KITS_ERROR = "Nombre entier de kits compris entre 1 et 100 000.";

/** Écriture puis rechargement des données serveur de la page. */
function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setPending(true);
    setFailure(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (error) {
      setFailure(toFailure(error));
      return false;
    } finally {
      setPending(false);
    }
  }
  return { pending, failure, setFailure, run };
}

/**
 * Fiche lot : besoin du lot en produits d'options (kits), face au stock commun à tous les lots,
 * et commandes de produits du lot. Les quantités et la pression viennent du serveur.
 */
export function BatchPartsPanel({
  batchId,
  finished,
  survey,
  needs,
  parts,
}: {
  batchId: string;
  /** Lot clôturé ou annulé : plus de commande possible */
  finished: boolean;
  /** Lot au sondage : la demande potentielle (manifestations d'intérêt) est pertinente */
  survey: boolean;
  needs: Needs;
  parts: PartOption[];
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [mounting, setMounting] = useState<Need | null>(null);
  const [delivering, setDelivering] = useState<PartOrder | null>(null);
  const advance = useAction();

  const short = needs.parts.filter((p) => isShort(p.stock) && p.remainingQty > 0);
  const ordered = new Set(needs.orders.map((o) => o.partId));
  // Kits manquants par produit : commandés moins reçus, sur les commandes livrées (une seule réception par commande)
  const missing = new Map<string, number>();
  for (const o of needs.orders) {
    if (o.receivedQty !== null && o.receivedQty < o.qty) {
      missing.set(o.partId, (missing.get(o.partId) ?? 0) + o.qty - o.receivedQty);
    }
  }

  async function markShipped(order: PartOrder) {
    setNotice(null);
    const ok = await advance.run(() => api("PATCH", `/api/backoffice/part-orders/${order.id}`, { status: "awaiting_delivery" }));
    if (ok) setNotice(`Commande de « ${order.partName} » en attente de livraison.`);
  }

  return (
    <section className="bo-card" aria-labelledby="part-needs">
      <div className="bo-card-head">
        <div>
          <h2 id="part-needs">Produits d&apos;options</h2>
          <p>Kits à prévoir pour les machines de ce lot, face au stock commun à tous les lots.</p>
        </div>
        <Link className="bo-btn bo-btn-ghost bo-btn-sm" href="/backoffice/pieces">
          Tout le stock
        </Link>
      </div>

      {short.length > 0 && (
        <div className="bo-alert bo-alert-warning bo-shortages" role="note">
          <strong>Stock insuffisant (tous lots confondus)</strong>
          <ul>
            {short.map((p) => (
              <li key={p.partId}>
                <Link href={`/backoffice/pieces/${p.partId}`}>{p.name}</Link> : {shortfallSentence(p.stock)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {needs.parts.length === 0 ? (
        <p className="bo-muted">
          Aucun kit à prévoir : aucune machine de ce lot n&apos;a d&apos;option avec un produit à monter
          {survey ? ", et aucune manifestation d'intérêt n'en demande" : ""}.
        </p>
      ) : (
        <div className="bo-table-scroll">
          <table className="bo-table">
            <caption className="bo-visually-hidden">Besoin du lot par produit</caption>
            <thead>
              <tr>
                <th scope="col">Produit</th>
                <th scope="col" title="Machines payées et factures en attente non expirées">
                  Demande ferme
                </th>
                {survey && (
                  <th scope="col" title="Manifestations d'intérêt, hors pression">
                    Potentielle
                  </th>
                )}
                <th scope="col">Montés</th>
                <th scope="col" title="Demande ferme restant à prélever sur le stock commun">
                  Reste à prélever
                </th>
                <th scope="col">Commandés pour ce lot</th>
                <th scope="col">Stock commun</th>
                <th scope="col" title="Demande ferme de tous les lots ÷ stock physique">
                  Pression (tous lots)
                </th>
                <th scope="col">
                  <span className="bo-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {needs.parts.map((p) => (
                <tr key={p.partId}>
                  <td>
                    <Link href={`/backoffice/pieces/${p.partId}`}>{p.name}</Link>
                    {p.reference && <span className="bo-kind">{p.reference}</span>}
                  </td>
                  <td className="bo-num">{p.firmQty}</td>
                  {survey && <td className="bo-num">{p.potentialQty}</td>}
                  <td className="bo-num">{p.mountedQty}</td>
                  <td className="bo-num bo-strong">{p.remainingQty}</td>
                  <td className="bo-num">
                    {p.orderedQty + p.deliveredQty === 0 ? (
                      <span className="bo-muted">—</span>
                    ) : (
                      <>
                        {p.orderedQty > 0 && <>{p.orderedQty} en cours</>}
                        {p.orderedQty > 0 && p.deliveredQty > 0 && " · "}
                        {p.deliveredQty > 0 && <>{p.deliveredQty} reçu{p.deliveredQty > 1 ? "s" : ""}</>}
                        {missing.get(p.partId) ? (
                          <span className="bo-kind" role="note">
                            {missing.get(p.partId)} manquant{missing.get(p.partId)! > 1 ? "s" : ""} à la livraison
                          </span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="bo-num">{p.stock.onHand}</td>
                  <td>
                    <PressureBadge stock={p.stock} />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="bo-btn bo-btn-ghost bo-btn-sm"
                      onClick={() => setMounting(p)}
                      aria-label={`Enregistrer des kits « ${p.name} » montés`}
                    >
                      Kits montés…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ margin: "24px 0 8px" }}>Commandes de produits du lot</h3>
      {needs.orders.length === 0 ? (
        <p className="bo-muted">Aucune commande de produit pour ce lot.</p>
      ) : (
        <div className="bo-table-scroll">
          <table className="bo-table">
            <caption className="bo-visually-hidden">Commandes de produits du lot</caption>
            <thead>
              <tr>
                <th scope="col">Produit</th>
                <th scope="col">Quantité</th>
                <th scope="col">Statut</th>
                <th scope="col">Commandée le</th>
                <th scope="col">
                  <span className="bo-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {needs.orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.partName}</td>
                  <td className="bo-num">
                    {o.qty}
                    {o.receivedQty !== null && o.receivedQty !== o.qty && (
                      <span className="bo-kind">{o.receivedQty} reçus</span>
                    )}
                  </td>
                  <td>
                    <span className={`bo-badge ${o.status === "delivered" ? "bo-badge-done" : "bo-badge-logistics"}`}>
                      {o.statusLabel}
                    </span>
                    {o.deliveredAt && <span className="bo-kind">le {formatDate(o.deliveredAt)}</span>}
                  </td>
                  <td>{formatDate(o.orderedAt)}</td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    {o.status === "ordering" && (
                      <button
                        type="button"
                        className="bo-btn bo-btn-secondary bo-btn-sm"
                        disabled={advance.pending}
                        onClick={() => markShipped(o)}
                      >
                        Marquer en route
                      </button>
                    )}{" "}
                    {o.status !== "delivered" && (
                      <button
                        type="button"
                        className="bo-btn bo-btn-primary bo-btn-sm"
                        onClick={() => setDelivering(o)}
                        aria-label={`Réceptionner la commande de « ${o.partName} »`}
                      >
                        Réceptionner…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorAlert failure={advance.failure} />
      <Notice message={notice} />

      {finished ? (
        <p className="bo-hint" style={{ marginTop: 12 }}>
          Lot terminé : plus de commande de produit possible.
        </p>
      ) : (
        <NewPartOrder
          batchId={batchId}
          parts={parts}
          needs={needs.parts}
          ordered={ordered}
          onCreated={(label) => setNotice(label)}
        />
      )}

      <MountDialog batchId={batchId} need={mounting} onClose={() => setMounting(null)} onDone={setNotice} />
      <DeliverDialog order={delivering} onClose={() => setDelivering(null)} onDone={setNotice} />
    </section>
  );
}

// ─── Nouvelle commande de produit ───

function NewPartOrder({
  batchId,
  parts,
  needs,
  ordered,
  onCreated,
}: {
  batchId: string;
  parts: PartOption[];
  needs: Need[];
  ordered: Set<string>;
  onCreated: (message: string) => void;
}) {
  const id = useId();
  const { pending, failure, run } = useAction();
  // Produits du besoin d'abord, puis les autres ; une seule commande par produit et par lot
  const needed = new Map(needs.map((n) => [n.partId, n]));
  const choices = parts
    .filter((p) => !ordered.has(p.id))
    .sort((a, b) => Number(needed.has(b.id)) - Number(needed.has(a.id)) || a.name.localeCompare(b.name, "fr"));
  const [partId, setPartId] = useState("");
  const [qty, setQty] = useState("");
  const [touched, setTouched] = useState(false);

  if (choices.length === 0) {
    return (
      <p className="bo-hint" style={{ marginTop: 12 }}>
        {parts.length === 0 ? (
          <>
            Aucun produit d&apos;option au catalogue. <Link href="/backoffice/pieces">Ajouter un produit</Link>
          </>
        ) : (
          "Chaque produit a déjà sa commande pour ce lot."
        )}
      </p>
    );
  }

  const selected = needed.get(partId);
  const kits = parseKits(qty);
  const partError = touched && !partId ? "Choisissez le produit à commander." : null;
  const qtyError = touched && kits === null ? KITS_ERROR : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!partId || kits === null) return;
    const name = parts.find((p) => p.id === partId)?.name ?? "";
    const ok = await run(() => api("POST", `/api/backoffice/batches/${batchId}/part-orders`, { partId, qty: kits }));
    if (ok) {
      onCreated(`Commande de ${kits} « ${name} » enregistrée.`);
      setPartId("");
      setQty("");
      setTouched(false);
    }
  }

  return (
    <form className="bo-subform bo-form" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} style={{ fontSize: 15 }}>
        Commander un produit pour ce lot
      </h3>
      <div className="bo-fields">
        <Field label="Produit" error={partError}>
          {(p) => (
            <select
              {...p}
              className="bo-select"
              value={partId}
              onChange={(e) => {
                setPartId(e.target.value);
                // Préremplit avec le manque à commander ; reste modifiable (la décision est manuelle)
                const toOrder = needed.get(e.target.value)?.stock.toOrder ?? 0;
                if (toOrder > 0) setQty(String(Math.min(toOrder, 100_000)));
              }}
            >
              <option value="">Choisir un produit…</option>
              {choices.map((part) => (
                <option key={part.id} value={part.id}>
                  {part.name}
                  {part.reference ? ` (${part.reference})` : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Quantité de kits"
          error={qtyError}
          hint={
            selected
              ? `Reste à prélever pour ce lot : ${selected.remainingQty}. Tous lots confondus, à commander : ${selected.stock.toOrder}.`
              : "La décision de commander reste la vôtre."
          }
        >
          {(p) => (
            <input
              {...p}
              className="bo-input bo-num"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          )}
        </Field>
      </div>
      <ErrorAlert failure={failure} />
      <div className="bo-actions">
        <button type="submit" className="bo-btn bo-btn-secondary" disabled={pending}>
          {pending ? "Enregistrement…" : "Enregistrer la commande"}
        </button>
      </div>
    </form>
  );
}

// ─── Kits montés sur des machines du lot (sortie du stock commun) ───

function MountDialog({
  batchId,
  need,
  onClose,
  onDone,
}: {
  batchId: string;
  need: Need | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { pending, failure, setFailure, run } = useAction();
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  if (need && opened !== need.partId) {
    setOpened(need.partId);
    setQty("1");
    setNote("");
    setFailure(null);
  }

  async function confirm() {
    if (!need) return;
    const kits = parseKits(qty);
    if (kits === null) return setFailure(new ApiFailure(0, "local", KITS_ERROR));
    const ok = await run(() =>
      api("POST", `/api/backoffice/parts/${need.partId}/movements`, {
        kind: "kit_mounted",
        quantity: kits,
        batchId,
        note: note.trim() || null,
      }),
    );
    if (ok) {
      onDone(`${kits} kit${kits > 1 ? "s" : ""} « ${need.name} » sorti${kits > 1 ? "s" : ""} du stock.`);
      setOpened(null);
      onClose();
    }
  }

  return (
    <ConfirmDialog
      open={need !== null}
      title={need ? `Kits « ${need.name} » montés` : ""}
      confirmLabel="Sortir du stock"
      pending={pending}
      onConfirm={confirm}
      onClose={() => {
        setOpened(null);
        onClose();
      }}
    >
      {need && (
        <>
          <p>
            Les kits montés sur des machines de ce lot sortent du stock commun ({need.stock.onHand} en stock). Reste à
            prélever pour ce lot : {need.remainingQty}.
          </p>
          <Field label="Nombre de kits montés">
            {(p) => (
              <input
                {...p}
                className="bo-input bo-num"
                type="number"
                min={1}
                step={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            )}
          </Field>
          <Field label="Note" optional>
            {(p) => <input {...p} className="bo-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
          </Field>
          <ErrorAlert failure={failure} />
        </>
      )}
    </ConfirmDialog>
  );
}

// ─── Réception d'une commande (entrée au stock commun) ───

function DeliverDialog({
  order,
  onClose,
  onDone,
}: {
  order: PartOrder | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { pending, failure, setFailure, run } = useAction();
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  if (order && opened !== order.id) {
    setOpened(order.id);
    setQty(String(order.qty));
    setNote("");
    setFailure(null);
  }

  async function confirm() {
    if (!order) return;
    const kits = parseKits(qty);
    if (kits === null) return setFailure(new ApiFailure(0, "local", KITS_ERROR));
    const ok = await run(() =>
      api("PATCH", `/api/backoffice/part-orders/${order.id}`, {
        status: "delivered",
        receivedQty: kits,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    );
    if (ok) {
      onDone(
        `${kits} « ${order.partName} » reçu${kits > 1 ? "s" : ""} et ajouté${kits > 1 ? "s" : ""} au stock` +
          (kits < order.qty ? ` (${order.qty - kits} manquant${order.qty - kits > 1 ? "s" : ""} sur ${order.qty} commandés).` : "."),
      );
      setOpened(null);
      onClose();
    }
  }

  return (
    <ConfirmDialog
      open={order !== null}
      title={order ? `Réceptionner « ${order.partName} » ?` : ""}
      confirmLabel="Réceptionner"
      pending={pending}
      onConfirm={confirm}
      onClose={() => {
        setOpened(null);
        onClose();
      }}
    >
      {order && (
        <>
          <p>
            Une seule réception par commande : les kits reçus entrent au stock commun et la commande passe à
            « Livré ». Commandés : {order.qty}.
          </p>
          <Field label="Kits reçus">
            {(p) => (
              <input
                {...p}
                className="bo-input bo-num"
                type="number"
                min={1}
                step={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            )}
          </Field>
          {parseKits(qty) !== null && parseKits(qty)! < order.qty && (
            <p className="bo-hint" role="status">
              Attention : {parseKits(qty)} reçu{parseKits(qty)! > 1 ? "s" : ""} sur {order.qty} commandés. La commande
              passera à « Livré » et ne se rouvrira pas : les {order.qty - parseKits(qty)!} manquants se rattrapent par
              une réception de réassort sur la fiche du produit.
            </p>
          )}
          <Field label="Note" optional hint="Ex. carton abîmé, 1 kit manquant.">
            {(p) => <input {...p} className="bo-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
          </Field>
          <ErrorAlert failure={failure} />
        </>
      )}
    </ConfirmDialog>
  );
}
