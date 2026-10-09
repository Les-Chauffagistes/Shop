"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BatchField } from "@/server/batch-status";
import { BATCH_STATUS_LABELS, EDITABLE_FIELDS } from "@/server/batch-status";
import type { BatchDetail } from "@/server/batches";
import type { getModel, listModels } from "@/server/catalog";
import { centsToInput, eurosToCents, formatCents } from "@/lib/decimal";
import { api, ApiFailure, toFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Field, MoneyInput, splitFieldFailure } from "../ui";
import { UnsavedWarning, useUnsavedChanges } from "./UnsavedChanges";
import { plural } from "@/lib/plural";

type ModelSummary = Awaited<ReturnType<typeof listModels>>["items"][number];
type ModelDetail = Awaited<ReturnType<typeof getModel>>;

type Availability = BatchDetail["options"][number]["values"][number]["availability"];

/** Menus d'options vus par le formulaire (catalogue, plus l'état sur le lot quand il existe). */
type OptionValueRow = {
  id: string;
  label: string;
  isDefault: boolean;
  price: string;
  used?: number;
  availability?: Availability;
  canOffer?: boolean;
};
type OptionRow = {
  id: string;
  title: string;
  hidden?: boolean;
  wishlistChoices?: number;
  values: OptionValueRow[];
};
type Setting = { enabled: boolean; priceOverride: string; maxQty: string };

/**
 * Saisies non enregistrées d'un formulaire de lot (valeurs brutes des champs), conservées
 * quand l'enregistrement est refusé parce que le lot a changé entre-temps (409 batch_modified).
 */
export type BatchDraft = {
  modelId?: string;
  quantity?: string;
  purchasePrice?: string;
  resalePrice?: string;
  name?: string;
  /** Réglages modifiés, par valeur d'option */
  settings?: Record<string, Setting>;
  /** Menus masqués (liste complète), s'ils ont changé */
  hidden?: string[];
};

/** Bornes de l'API (docs/api.md, « Bornes de saisie »), pour prévenir avant l'envoi. */
const MAX_QUANTITY = 10_000;
const MAX_PURCHASE_CENTS = 10_000_000_000n;
const MAX_RESALE_CENTS = 100_000_000n;

/** Statuts où la palette est déjà commandée au fournisseur (confirmation sur quantité et prix d'achat). */
const ORDERED_STATUSES: ReadonlySet<BatchDetail["status"]> = new Set([
  "ordering",
  "awaiting_reception",
  "inspection",
  "tuning",
  "packaging",
  "in_transit",
  "closed",
]);

/** Création : un lot naît en brouillon, ses champs modifiables sont ceux du brouillon. */
const CREATE_FIELDS = EDITABLE_FIELDS.draft;

function optionsFromModel(model: ModelDetail): OptionRow[] {
  return model.options.map((o) => ({
    id: o.id,
    title: o.title,
    values: o.values.map((v) => ({ id: v.id, label: v.label, isDefault: v.isDefault, price: v.price })),
  }));
}

function settingsFromBatch(batch: BatchDetail): Record<string, Setting> {
  const out: Record<string, Setting> = {};
  for (const o of batch.options) {
    for (const v of o.values) {
      if (v.availability === "not_offered") continue; // pas de réglage : à proposer d'abord
      out[v.id] = {
        enabled: v.enabled,
        priceOverride: v.priceOverride === null ? "" : centsToInput(v.priceOverride),
        maxQty: v.maxQty === null ? "" : String(v.maxQty),
      };
    }
  }
  return out;
}

const hiddenFromBatch = (batch: BatchDetail) => batch.options.filter((o) => o.hidden).map((o) => o.id);

const EMPTY_SETTING: Setting = { enabled: true, priceOverride: "", maxQty: "" };

/** Valeurs des champs telles que le serveur les a renvoyées (référence pour détecter les saisies). */
function baseline(batch: BatchDetail) {
  const nameIsDefault = batch.name === `${batch.quantity} ${batch.model.name}`;
  return {
    modelId: batch.model.id,
    quantity: String(batch.quantity),
    purchasePrice: centsToInput(batch.purchasePrice),
    resalePrice: centsToInput(batch.resaleUnitPrice),
    name: nameIsDefault ? "" : batch.name,
    settings: settingsFromBatch(batch),
    hidden: hiddenFromBatch(batch),
  };
}

const sameSetting = (a: Setting, b: Setting) =>
  a.enabled === b.enabled && a.priceOverride.trim() === b.priceOverride.trim() && a.maxQty.trim() === b.maxQty.trim();

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * Saisies d'un brouillon reprises sur une version plus récente du lot : seuls les champs encore
 * modifiables à son statut sont repris (le serveur reste seul juge à l'enregistrement).
 */
export function applicableDraft(draft: BatchDraft, batch: BatchDetail): BatchDraft {
  const can = new Set<BatchField>(batch.editableFields);
  const out: BatchDraft = {};
  if (draft.quantity !== undefined && can.has("quantity")) out.quantity = draft.quantity;
  if (draft.purchasePrice !== undefined && can.has("purchasePrice")) out.purchasePrice = draft.purchasePrice;
  if (draft.resalePrice !== undefined && can.has("resaleUnitPrice")) out.resalePrice = draft.resalePrice;
  if (draft.name !== undefined && can.has("name")) out.name = draft.name;
  if (draft.settings && (can.has("optionAvailability") || can.has("optionMaxQty"))) {
    const current = settingsFromBatch(batch);
    const settings: Record<string, Setting> = {};
    for (const [id, s] of Object.entries(draft.settings)) {
      const now = current[id];
      if (!now) continue; // valeur d'un autre modèle, ou plus proposée : plus applicable
      settings[id] = {
        enabled: can.has("optionAvailability") ? s.enabled : now.enabled,
        priceOverride: can.has("optionAvailability") ? s.priceOverride : now.priceOverride,
        maxQty: can.has("optionMaxQty") ? s.maxQty : now.maxQty,
      };
    }
    if (Object.keys(settings).length > 0) out.settings = settings;
  }
  if (draft.hidden && can.has("hiddenOptions")) {
    const menus = new Set(batch.options.map((o) => o.id));
    out.hidden = draft.hidden.filter((id) => menus.has(id));
  }
  return out;
}

/** Description lisible d'un brouillon (« Quantité : 18 »), pour que l'admin sache ce qui n'est pas enregistré. */
export function describeDraft(draft: BatchDraft, batch: BatchDetail, models: { id: string; name: string }[]): string[] {
  const lines: string[] = [];
  const money = (v: string) => (v.trim() === "" ? "vide" : `${v.trim()} €`);
  if (draft.modelId !== undefined) {
    lines.push(`Modèle : ${models.find((m) => m.id === draft.modelId)?.name ?? "autre modèle"} (à choisir de nouveau)`);
  }
  if (draft.quantity !== undefined) lines.push(`Quantité : ${draft.quantity.trim() || "vide"}`);
  if (draft.purchasePrice !== undefined) lines.push(`Prix d'achat du lot : ${money(draft.purchasePrice)}`);
  if (draft.resalePrice !== undefined) lines.push(`Prix de revente unitaire : ${money(draft.resalePrice)}`);
  if (draft.name !== undefined) lines.push(`Nom du lot : ${draft.name.trim() ? `« ${draft.name.trim()} »` : "nom par défaut"}`);
  const labels = new Map(batch.options.flatMap((o) => o.values.map((v) => [v.id, v.label] as const)));
  for (const [id, s] of Object.entries(draft.settings ?? {})) {
    const parts = [
      s.enabled ? "proposée" : "retirée",
      s.enabled ? `prix ${s.priceOverride.trim() ? `${s.priceOverride.trim()} €` : "du catalogue"}` : null,
      s.enabled ? `quantité max. ${s.maxQty.trim() || "illimitée"}` : null,
    ].filter(Boolean);
    lines.push(`Option « ${labels.get(id) ?? "?"} » : ${parts.join(", ")}`);
  }
  if (draft.hidden !== undefined) {
    const titles = new Map(batch.options.map((o) => [o.id, o.title]));
    const names = draft.hidden.map((id) => `« ${titles.get(id) ?? "?"} »`);
    lines.push(`Menus masqués : ${names.length > 0 ? names.join(", ") : "aucun"}`);
  }
  return lines;
}

/** Valeurs des champs du formulaire (saisies brutes). */
type FormValues = ReturnType<typeof baseline>;

/**
 * Nouvel état du formulaire quand le serveur renvoie la version `saved` de son enregistrement :
 * un champ que l'admin n'a pas retouché depuis l'envoi (`sent`) prend la valeur enregistrée (mise
 * en forme par le serveur) ; un champ modifié pendant l'envoi garde la saisie, qui reste « non
 * enregistrée ». Un champ devenu non modifiable prend toujours la valeur du serveur.
 */
export function reconcileAfterSave(
  current: FormValues,
  sent: FormValues,
  saved: BatchDetail,
): FormValues {
  const next = baseline(saved);
  const can = new Set<BatchField>(saved.editableFields);
  const pick = (field: BatchField, key: "quantity" | "purchasePrice" | "resalePrice" | "name") =>
    can.has(field) && current[key] !== sent[key] ? current[key] : next[key];
  const modelKept = can.has("modelId") && current.modelId !== sent.modelId;
  const out: FormValues = {
    modelId: modelKept ? current.modelId : next.modelId,
    quantity: pick("quantity", "quantity"),
    purchasePrice: pick("purchasePrice", "purchasePrice"),
    resalePrice: pick("resaleUnitPrice", "resalePrice"),
    name: pick("name", "name"),
    settings: next.settings,
    hidden: next.hidden,
  };
  if (modelKept) {
    // Autre modèle choisi pendant l'envoi : ses menus et réglages restent ceux de la saisie
    out.settings = current.settings;
    out.hidden = current.hidden;
    return out;
  }
  if (can.has("optionAvailability") || can.has("optionMaxQty")) {
    const settings: Record<string, Setting> = { ...next.settings };
    for (const id of new Set([...Object.keys(current.settings), ...Object.keys(sent.settings)])) {
      const now = current.settings[id] ?? EMPTY_SETTING;
      if (sameSetting(now, sent.settings[id] ?? EMPTY_SETTING) || !next.settings[id]) continue;
      const server = next.settings[id];
      settings[id] = {
        enabled: can.has("optionAvailability") ? now.enabled : server.enabled,
        priceOverride: can.has("optionAvailability") ? now.priceOverride : server.priceOverride,
        maxQty: can.has("optionMaxQty") ? now.maxQty : server.maxQty,
      };
    }
    out.settings = settings;
  }
  if (can.has("hiddenOptions") && !sameSet(current.hidden, sent.hidden)) {
    const menus = new Set(saved.options.map((o) => o.id));
    out.hidden = current.hidden.filter((id) => menus.has(id));
  }
  return out;
}

/** Confirmation demandée avant d'envoyer l'enregistrement (`sent` : valeurs des champs à l'envoi). */
type Pending =
  | { kind: "ordered"; body: Record<string, unknown>; sent: FormValues }
  | { kind: "hidden_choices"; message: string; body: Record<string, unknown>; sent: FormValues };

/**
 * Création d'un lot (sans `batch`) ou modification de ses réglages (avec `batch`) :
 * seuls les champs de `batch.editableFields` sont actifs ; le serveur reste seul juge.
 */
export function BatchForm({
  models,
  batch,
  initialModel,
  draft,
  onSubmitStart,
  onSaved,
  onConflict,
}: {
  models: ModelSummary[];
  batch?: BatchDetail;
  initialModel?: ModelDetail | null;
  /** Saisies reprises par-dessus les valeurs du lot (après un conflit) */
  draft?: BatchDraft;
  onSubmitStart?: () => void;
  /**
   * Lot enregistré (le lot renvoyé par l'API), avec un message de confirmation éventuel.
   * `adopted` : le formulaire a déjà repris cette version en place (sans être recréé), en gardant
   * les champs modifiés pendant l'envoi ; sinon l'appelant doit le recréer sur `saved`.
   */
  onSaved?: (saved: BatchDetail, message?: string, adopted?: boolean) => void;
  /** Lot modifié entre-temps (409 batch_modified) : la saisie est remise à l'appelant */
  onConflict?: (message: string, draft: BatchDraft) => void;
}) {
  const router = useRouter();
  const editable = new Set<BatchField>(batch ? batch.editableFields : CREATE_FIELDS);
  const can = (field: BatchField) => editable.has(field);
  const lockHint = (field: BatchField) =>
    batch && !can(field) ? `Non modifiable au statut « ${BATCH_STATUS_LABELS[batch.status]} ».` : undefined;

  // Valeurs du serveur au chargement : `expectedUpdatedAt` et détection des saisies non enregistrées
  // (mises à jour en place par la réponse d'un enregistrement, voir reconcileAfterSave)
  const [initial, setInitial] = useState(() => (batch ? baseline(batch) : null));
  const [modelId, setModelId] = useState(batch?.model.id ?? initialModel?.id ?? "");
  const [quantity, setQuantity] = useState(draft?.quantity ?? initial?.quantity ?? "");
  const [purchasePrice, setPurchasePrice] = useState(draft?.purchasePrice ?? initial?.purchasePrice ?? "");
  const [resalePrice, setResalePrice] = useState(draft?.resalePrice ?? initial?.resalePrice ?? "");
  const [name, setName] = useState(draft?.name ?? initial?.name ?? "");
  const [options, setOptions] = useState<OptionRow[] | null>(
    batch ? batch.options : initialModel ? optionsFromModel(initialModel) : null,
  );
  const [settings, setSettings] = useState<Record<string, Setting>>(() =>
    initial ? { ...initial.settings, ...draft?.settings } : {},
  );
  const [hidden, setHidden] = useState<string[]>(draft?.hidden ?? initial?.hidden ?? []);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsFailure, setOptionsFailure] = useState<ApiFailure | null>(null);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [offering, setOffering] = useState<{ value: OptionValueRow; menu: string } | null>(null);

  // Menus d'options du modèle choisi (création, ou changement de modèle en brouillon)
  const request = useRef(0);
  async function selectModel(id: string) {
    setModelId(id);
    setOptionsFailure(null);
    const ticket = ++request.current;
    if (!id) {
      setOptions(null);
      setHidden([]);
      return;
    }
    if (batch && id === batch.model.id) {
      setOptions(batch.options);
      setSettings(settingsFromBatch(batch));
      setHidden(hiddenFromBatch(batch));
      return;
    }
    setOptionsLoading(true);
    try {
      const model = await api<ModelDetail>("GET", `/api/backoffice/models/${id}`);
      if (ticket !== request.current) return; // réponse périmée : un autre modèle a été choisi
      setOptions(optionsFromModel(model));
      setSettings({});
      setHidden([]);
    } catch (error) {
      if (ticket === request.current) setOptionsFailure(toFailure(error));
    } finally {
      if (ticket === request.current) setOptionsLoading(false);
    }
  }

  const model = models.find((m) => m.id === modelId);
  const qty = Number(quantity);
  const qtyValid = quantity.trim() !== "" && Number.isInteger(qty) && qty >= 1 && qty <= MAX_QUANTITY;
  const purchaseCents = eurosToCents(purchasePrice);
  const purchaseValid = purchaseCents !== null && BigInt(purchaseCents) >= 1n && BigInt(purchaseCents) <= MAX_PURCHASE_CENTS;
  const resaleCents = resalePrice.trim() === "" ? null : eurosToCents(resalePrice);
  const resaleValid =
    resalePrice.trim() === "" || (resaleCents !== null && BigInt(resaleCents) >= 1n && BigInt(resaleCents) <= MAX_RESALE_CENTS);
  const defaultName = model && qtyValid ? `${qty} ${model.name}` : "{quantité} {modèle}";

  const errors = {
    model: touched && !modelId ? "Choisissez un modèle." : null,
    quantity: touched && !qtyValid ? "Nombre entier de machines compris entre 1 et 10 000." : null,
    purchase: touched && !purchaseValid ? "Montant en euros compris entre 0,01 et 100 000 000,00, ex. 15 000." : null,
    resale: touched && !resaleValid ? "Montant en euros compris entre 0,01 et 1 000 000,00, ex. 1 800." : null,
  };

  const setting = (valueId: string) => settings[valueId] ?? EMPTY_SETTING;
  const updateSetting = (valueId: string, patch: Partial<Setting>) =>
    setSettings((s) => ({ ...s, [valueId]: { ...(s[valueId] ?? EMPTY_SETTING), ...patch } }));
  const toggleHidden = (optionId: string, hide: boolean) =>
    setHidden((h) => (hide ? [...h.filter((id) => id !== optionId), optionId] : h.filter((id) => id !== optionId)));

  function buildOptionValues(): { ok: true; value: object[] } | { ok: false; message: string } {
    const out: object[] = [];
    for (const o of options ?? []) {
      for (const v of o.values) {
        if (v.availability === "not_offered") continue; // à proposer d'abord (« Proposer sur ce lot »)
        const s = setting(v.id);
        const override = s.priceOverride.trim() === "" ? null : eurosToCents(s.priceOverride);
        if (s.priceOverride.trim() !== "" && override === null) {
          return { ok: false, message: `Prix pour ce lot invalide pour « ${v.label} » : montant en euros attendu.` };
        }
        if (v.isDefault && override !== null && override !== "0") {
          return {
            ok: false,
            message: `« ${v.label} » est la valeur par défaut du menu « ${o.title} » : elle reste gratuite, son prix pour ce lot ne peut être que 0.`,
          };
        }
        const maxQty = s.maxQty.trim() === "" ? null : Number(s.maxQty);
        if (maxQty !== null && !(Number.isInteger(maxQty) && maxQty >= 0)) {
          return { ok: false, message: `Quantité maximale invalide pour « ${v.label} » : entier positif ou vide.` };
        }
        if (s.enabled && override === null && maxQty === null) continue;
        out.push({ optionValueId: v.id, enabled: s.enabled, priceOverride: override, maxQty });
      }
    }
    return { ok: true, value: out };
  }

  /** Champs dont la valeur diffère de celle chargée du serveur. */
  function currentDraft(): BatchDraft {
    if (!initial) return {};
    const out: BatchDraft = {};
    if (modelId !== initial.modelId) out.modelId = modelId;
    if (quantity.trim() !== initial.quantity) out.quantity = quantity;
    if (purchasePrice.trim() !== initial.purchasePrice) out.purchasePrice = purchasePrice;
    if (resalePrice.trim() !== initial.resalePrice) out.resalePrice = resalePrice;
    if (name.trim() !== initial.name) out.name = name;
    if (modelId === initial.modelId) {
      const changed = Object.entries(settings).filter(([id, s]) => !sameSetting(s, initial.settings[id] ?? EMPTY_SETTING));
      if (changed.length > 0) out.settings = Object.fromEntries(changed);
      if (!sameSet(hidden, initial.hidden)) out.hidden = hidden;
    }
    return out;
  }

  // Saisies non enregistrées : signalées aux actions qui rechargent le lot (transitions, propositions)
  const dirty = batch ? Object.keys(currentDraft()).length > 0 : false;
  const { setDirty } = useUnsavedChanges();
  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  /** Valeurs actuelles des champs, lues au moment de l'envoi et à la réponse du serveur. */
  const values = useRef<FormValues | null>(null);
  useLayoutEffect(() => {
    values.current = { modelId, quantity, purchasePrice, resalePrice, name, settings, hidden };
  });

  async function send(body: Record<string, unknown>, sent: FormValues) {
    setPending(true);
    setFailure(null);
    try {
      if (batch) {
        const saved = await api<BatchDetail>("PATCH", `/api/backoffice/batches/${batch.id}`, body);
        setConfirm(null);
        // Le formulaire reprend la version enregistrée sans être recréé : une saisie faite pendant
        // l'envoi n'est pas écrasée, ni par cette réponse ni par le rafraîchissement de la page
        const next = reconcileAfterSave(values.current ?? sent, sent, saved);
        setInitial(baseline(saved));
        if (next.modelId === saved.model.id) setOptions(saved.options);
        setModelId(next.modelId);
        setQuantity(next.quantity);
        setPurchasePrice(next.purchasePrice);
        setResalePrice(next.resalePrice);
        setName(next.name);
        setSettings(next.settings);
        setHidden(next.hidden);
        onSaved?.(saved, undefined, true);
        router.refresh();
      } else {
        const created = await api<BatchDetail>("POST", "/api/backoffice/batches", body);
        router.push(`/backoffice/lots/${created.id}`);
      }
    } catch (error) {
      const f = toFailure(error);
      if (f.code === "hidden_menu_has_choices") {
        // Masquer ramène des choix de clients au défaut : l'admin confirme, puis on renvoie la même requête
        setConfirm({ kind: "hidden_choices", message: f.message, body, sent });
      } else if (f.code === "batch_modified" && onConflict) {
        setConfirm(null);
        onConflict(f.message, currentDraft());
      } else {
        setConfirm(null);
        setFailure(f);
      }
    } finally {
      setPending(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setFailure(null);
    onSubmitStart?.();
    if (!modelId || !qtyValid || !purchaseValid || !resaleValid) return; // erreurs affichées (touched)
    const optionValues = buildOptionValues();
    if (!optionValues.ok) {
      setFailure(new ApiFailure(0, "local", optionValues.message));
      return;
    }
    const body: Record<string, unknown> = {};
    if (can("modelId")) body.modelId = modelId;
    if (can("quantity")) body.quantity = qty;
    if (can("purchasePrice")) body.purchasePrice = purchaseCents;
    if (can("resaleUnitPrice")) {
      if (!batch || resaleCents !== null || batch.status === "draft") body.resaleUnitPrice = resaleCents;
    }
    if (can("name")) body.name = name.trim() || null;
    if (can("optionAvailability") || can("optionMaxQty")) body.optionValues = optionValues.value;
    if (can("hiddenOptions")) {
      const menus = new Set((options ?? []).map((o) => o.id));
      body.hiddenOptions = hidden.filter((id) => menus.has(id));
    }
    if (!batch && body.resaleUnitPrice === null) delete body.resaleUnitPrice;
    // Version lue au chargement : le serveur refuse (409 batch_modified) si le lot a changé depuis
    if (batch) body.expectedUpdatedAt = batch.updatedAt;

    const sent: FormValues = { modelId, quantity, purchasePrice, resalePrice, name, settings, hidden };
    if (orderedChange) {
      setConfirm({ kind: "ordered", body, sent });
      return;
    }
    await send(body, sent);
  }

  // Palette déjà commandée au fournisseur : quantité ou prix d'achat modifiés seulement après confirmation
  const orderedChange =
    batch &&
    ORDERED_STATUSES.has(batch.status) &&
    initial &&
    (quantity.trim() !== initial.quantity || purchasePrice.trim() !== initial.purchasePrice);

  const anyEditable = editable.size > 0;
  const unitCost = purchaseValid && qtyValid ? (BigInt(purchaseCents!) / BigInt(qty)).toString() : null;
  // Alerte de marge, non bloquante : revente unitaire × quantité < prix d'achat du lot entier
  // (comparaison exacte en centimes, sans arrondir le coût par machine)
  const belowCost =
    unitCost !== null && resaleValid && resaleCents !== null && BigInt(resaleCents) * BigInt(qty) < BigInt(purchaseCents!);
  const marginWarning = belowCost
    ? `Prix de revente inférieur au coût d'achat d'une machine (${formatCents(unitCost)}) : le lot serait vendu à perte. Vous pouvez tout de même enregistrer.`
    : null;
  // Menu « choix » réduit à moins de deux valeurs sur un lot publié : refus affiché avec les options
  const { fieldError: menuWithoutChoice, rest: formFailure } = splitFieldFailure(failure, "menu_without_choice");

  return (
    <>
      <form className="bo-form" onSubmit={submit} noValidate>
        <div className="bo-fields">
          <Field
            label="Modèle de mineur"
            error={errors.model}
            hint={
              lockHint("modelId") ??
              (batch ? undefined : (
                <>
                  Absent de la liste ? <Link href="/backoffice/modeles/nouveau?retour=lot">Créer un modèle</Link>
                </>
              ))
            }
          >
            {(p) => (
              <select
                {...p}
                className="bo-select"
                value={modelId}
                onChange={(e) => selectModel(e.target.value)}
                disabled={!can("modelId")}
                required
              >
                <option value="">Choisir un modèle…</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Quantité de machines" error={errors.quantity} hint={lockHint("quantity") ?? "Entre 1 et 10 000."}>
            {(p) => (
              <input
                {...p}
                className="bo-input bo-num"
                type="number"
                min={1}
                max={MAX_QUANTITY}
                step={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={!can("quantity")}
                required
              />
            )}
          </Field>
          <Field
            label="Prix d'achat du lot"
            error={errors.purchase}
            hint={
              lockHint("purchasePrice") ??
              (unitCost ? `Prix du lot entier, soit ${formatCents(unitCost)} par machine (indicatif).` : "Prix du lot entier.")
            }
          >
            {(p) => <MoneyInput {...p} value={purchasePrice} onChange={setPurchasePrice} disabled={!can("purchasePrice")} required />}
          </Field>
          <Field
            label="Prix de revente unitaire"
            optional={!batch || batch.status === "draft"}
            error={errors.resale}
            hint={lockHint("resaleUnitPrice") ?? "Prix d'une machine pour le client. Requis pour publier le lot."}
            warning={marginWarning}
          >
            {(p) => <MoneyInput {...p} value={resalePrice} onChange={setResalePrice} disabled={!can("resaleUnitPrice")} />}
          </Field>
          <Field
            label="Nom du lot"
            optional
            wide
            hint={lockHint("name") ?? `Laissé vide, le lot s'appelle « ${defaultName} » et suit la quantité.`}
          >
            {(p) => (
              <input
                {...p}
                className="bo-input"
                value={name}
                placeholder={defaultName}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                disabled={!can("name")}
              />
            )}
          </Field>
        </div>
        {orderedChange && (
          <div className="bo-alert bo-alert-warning" role="note">
            Ce lot est déjà commandé au fournisseur (statut « {BATCH_STATUS_LABELS[batch.status]} »). Ne modifiez la
            quantité ou le prix d&apos;achat que pour corriger une erreur de saisie ou refléter ce qui a réellement été
            acheté : une confirmation vous sera demandée.
          </div>
        )}

        <fieldset style={{ border: 0 }}>
          <legend className="bo-label" style={{ fontSize: 16, marginBottom: 4 }}>
            Options d&apos;achat pour ce lot
          </legend>
          <p className="bo-hint" style={{ marginBottom: 12 }}>
            Décochez une valeur pour la retirer de ce lot. Un prix vide reprend le prix du catalogue ; une quantité vide est
            illimitée. La valeur par défaut d&apos;un menu est toujours proposée et gratuite. Un menu masqué n&apos;est pas
            présenté au client : sa valeur par défaut s&apos;applique d&apos;office.
          </p>
          {menuWithoutChoice && <OptionsRefusal message={menuWithoutChoice} />}
          <OptionSettings
            options={options}
            loading={optionsLoading}
            failure={optionsFailure}
            hasModel={Boolean(modelId)}
            setting={setting}
            update={updateSetting}
            hidden={hidden}
            toggleHidden={toggleHidden}
            initialHidden={initial?.hidden ?? []}
            canAvailability={can("optionAvailability")}
            canMaxQty={can("optionMaxQty")}
            canHide={can("hiddenOptions")}
            showUsage={Boolean(batch)}
            statusLabel={batch ? BATCH_STATUS_LABELS[batch.status] : ""}
            onOffer={(value, menu) => setOffering({ value, menu })}
          />
        </fieldset>

        <ErrorAlert failure={formFailure} />
        {menuWithoutChoice && (
          <p className="bo-field-error" style={{ marginTop: -8 }}>
            Rien n&apos;a été enregistré : corrigez les options du lot ci-dessus.
          </p>
        )}
        {anyEditable ? (
          <div className="bo-actions">
            <button type="submit" className="bo-btn bo-btn-primary" disabled={pending}>
              {pending ? "Enregistrement…" : batch ? "Enregistrer les modifications" : "Créer le lot en brouillon"}
            </button>
            {!batch && <span className="bo-hint">Le lot reste invisible des clients tant qu&apos;il n&apos;est pas publié.</span>}
          </div>
        ) : (
          <p className="bo-hint">Ce lot est terminé : plus rien n&apos;est modifiable.</p>
        )}
      </form>

      {/* Hors du formulaire : un formulaire de dialogue imbriqué soumettrait aussi celui du lot */}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "hidden_choices" ? "Masquer ce menu ?" : "Modifier un lot déjà commandé ?"}
        confirmLabel={confirm?.kind === "hidden_choices" ? "Masquer et ramener au défaut" : "Enregistrer quand même"}
        cancelLabel="Ne rien enregistrer"
        pending={pending}
        onConfirm={() => {
          if (!confirm) return;
          void send(
            confirm.kind === "hidden_choices" ? { ...confirm.body, confirmResetChoices: true } : confirm.body,
            confirm.sent,
          );
        }}
        onClose={() => setConfirm(null)}
      >
        {confirm?.kind === "hidden_choices" ? (
          <>
            <div className="bo-alert bo-alert-warning">{confirm.message}</div>
            <p>
              Les clients concernés garderont leur manifestation d&apos;intérêt, avec la valeur par défaut (gratuite) dans
              ce menu.
            </p>
          </>
        ) : (
          batch &&
          initial && (
            <>
              <p>
                Ce lot est déjà commandé au fournisseur (statut « {BATCH_STATUS_LABELS[batch.status]} »). Vérifiez que ce
                changement reflète ce qui a réellement été acheté :
              </p>
              <ul style={{ marginLeft: 18 }}>
                {quantity.trim() !== initial.quantity && (
                  <li>
                    Quantité : {initial.quantity} → <strong>{quantity.trim()}</strong>
                  </li>
                )}
                {purchasePrice.trim() !== initial.purchasePrice && purchaseCents && (
                  <li>
                    Prix d&apos;achat du lot : {formatCents(batch.purchasePrice)} → <strong>{formatCents(purchaseCents)}</strong>
                  </li>
                )}
              </ul>
            </>
          )
        )}
      </ConfirmDialog>

      {batch && (
        <OfferDialog
          batch={batch}
          offering={offering}
          onClose={() => setOffering(null)}
          onOffered={(saved, label) => {
            setOffering(null);
            onSaved?.(saved, `« ${label} » est maintenant proposée sur ce lot.`);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

/** Refus du serveur sur les options du lot, affiché au-dessus des menus et amené à l'écran. */
function OptionsRefusal({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "center" });
  }, [message]);
  return (
    <div ref={ref} className="bo-alert bo-alert-error" role="alert" style={{ marginBottom: 12 }}>
      {message}
    </div>
  );
}

// ─── « Proposer sur ce lot » une valeur ajoutée au catalogue après la publication ───

function OfferDialog({
  batch,
  offering,
  onClose,
  onOffered,
}: {
  batch: BatchDetail;
  offering: { value: OptionValueRow; menu: string } | null;
  onClose: () => void;
  onOffered: (saved: BatchDetail, label: string) => void;
}) {
  const [price, setPrice] = useState("");
  const [maxQty, setMaxQty] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  // Nouvelle valeur ouverte : champs remis à zéro
  if (offering && opened !== offering.value.id) {
    setOpened(offering.value.id);
    setPrice("");
    setMaxQty("");
    setFailure(null);
  }

  async function offer() {
    if (!offering) return;
    const override = price.trim() === "" ? null : eurosToCents(price);
    if (price.trim() !== "" && override === null) {
      setFailure(new ApiFailure(0, "local", "Prix pour ce lot : montant en euros attendu, ex. 30 ou 30,50 (vide = prix du catalogue)."));
      return;
    }
    const max = maxQty.trim() === "" ? null : Number(maxQty);
    if (max !== null && !(Number.isInteger(max) && max >= 0)) {
      setFailure(new ApiFailure(0, "local", "Quantité maximale : entier positif, ou vide pour illimitée."));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const saved = await api<BatchDetail>("POST", `/api/backoffice/batches/${batch.id}/offered-values`, {
        optionValueId: offering.value.id,
        priceOverride: override,
        maxQty: max,
      });
      setOpened(null);
      onOffered(saved, offering.value.label);
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <ConfirmDialog
      open={offering !== null}
      title={offering ? `Proposer « ${offering.value.label} » sur ce lot ?` : ""}
      confirmLabel="Proposer sur ce lot"
      pending={pending}
      onConfirm={offer}
      onClose={() => {
        setOpened(null);
        onClose();
      }}
    >
      {offering && (
        <>
          <p>
            Cette valeur du menu « {offering.menu} » a été ajoutée au catalogue après la publication du lot. Une fois
            proposée, les clients pourront la choisir.
          </p>
          <UnsavedWarning action="proposer cette valeur" />
          <div className="bo-fields">
            <Field label="Prix pour ce lot" optional hint={`Vide : prix du catalogue (${formatCents(offering.value.price)}).`}>
              {(p) => <MoneyInput {...p} value={price} onChange={setPrice} placeholder={centsToInput(offering.value.price)} />}
            </Field>
            <Field label="Quantité maximale" optional hint="Vide : illimitée.">
              {(p) => (
                <input
                  {...p}
                  className="bo-input bo-num"
                  type="number"
                  min={0}
                  step={1}
                  value={maxQty}
                  onChange={(e) => setMaxQty(e.target.value)}
                />
              )}
            </Field>
          </div>
          <ErrorAlert failure={failure} />
        </>
      )}
    </ConfirmDialog>
  );
}

// ─── Réglages par menu ───

function OptionSettings({
  options,
  loading,
  failure,
  hasModel,
  setting,
  update,
  hidden,
  toggleHidden,
  initialHidden,
  canAvailability,
  canMaxQty,
  canHide,
  showUsage,
  statusLabel,
  onOffer,
}: {
  options: OptionRow[] | null;
  loading: boolean;
  failure: ApiFailure | null;
  hasModel: boolean;
  setting: (valueId: string) => Setting;
  update: (valueId: string, patch: Partial<Setting>) => void;
  hidden: string[];
  toggleHidden: (optionId: string, hide: boolean) => void;
  initialHidden: string[];
  canAvailability: boolean;
  canMaxQty: boolean;
  canHide: boolean;
  showUsage: boolean;
  statusLabel: string;
  onOffer: (value: OptionValueRow, menu: string) => void;
}) {
  if (!hasModel) return <p className="bo-muted">Choisissez d&apos;abord un modèle.</p>;
  if (loading) return <p className="bo-muted" role="status">Chargement des options du modèle…</p>;
  if (failure) return <ErrorAlert failure={failure} />;
  if (!options || options.length === 0) return <p className="bo-muted">Ce modèle n&apos;a aucun menu d&apos;options.</p>;

  return (
    <div className="bo-stack">
      {!canAvailability && statusLabel && (
        <p className="bo-locked">
          Au statut « {statusLabel} », les retraits, prix dérogatoires et menus masqués sont figés
          {canMaxQty ? " ; seules les quantités maximales restent modifiables." : "."}
        </p>
      )}
      {options.map((o) => {
        const isHidden = hidden.includes(o.id);
        const defaultValue = o.values.find((v) => v.isDefault);
        const choices = o.wishlistChoices ?? 0;
        // Choix de clients ramenés au défaut si l'on masque le menu (annoncé avant l'enregistrement)
        const resetWarning = isHidden && !initialHidden.includes(o.id) && choices > 0;
        const heading = (
          <div className="bo-menu-head">
            <h3 className="bo-menu-title">
              {o.title}
              {isHidden && <span className="bo-badge bo-badge-neutral">Masqué</span>}
            </h3>
            {canHide && (
              <button
                type="button"
                className="bo-btn bo-btn-ghost bo-btn-sm"
                onClick={() => toggleHidden(o.id, !isHidden)}
                aria-label={`${isHidden ? "Afficher" : "Masquer"} le menu « ${o.title} »`}
              >
                {isHidden ? "Afficher ce menu" : "Masquer ce menu"}
              </button>
            )}
          </div>
        );
        if (isHidden) {
          return (
            <section key={o.id} className="bo-menu-hidden" aria-label={`Menu ${o.title}`}>
              {heading}
              <p className="bo-hint">
                Le client ne voit pas ce menu :{" "}
                {defaultValue ? <>la valeur par défaut « {defaultValue.label} » (gratuite) s&apos;applique d&apos;office.</> : "aucune valeur ne s'applique."}
              </p>
              {resetWarning && (
                <p className="bo-alert bo-alert-warning" role="note" style={{ marginTop: 8 }}>
                  {plural(choices, "client a fait un choix", "choix de clients ont été faits")} dans ce menu : à
                  l&apos;enregistrement, {choices > 1 ? "ils seront ramenés" : "il sera ramené"} à la valeur par défaut.
                </p>
              )}
            </section>
          );
        }
        return (
          <section key={o.id} aria-label={`Menu ${o.title}`}>
            {heading}
            <div className="bo-table-scroll">
              <table className="bo-table">
                <caption className="bo-visually-hidden">Valeurs du menu {o.title}</caption>
                <thead>
                  <tr>
                    <th scope="col">Proposée</th>
                    <th scope="col">Valeur</th>
                    <th scope="col">Prix catalogue</th>
                    <th scope="col">Prix pour ce lot</th>
                    <th scope="col">Quantité max.</th>
                    {showUsage && <th scope="col" title="Machines payées ou réservées avec cette valeur">Utilisées</th>}
                  </tr>
                </thead>
                <tbody>
                  {o.values.map((v) => {
                    if (v.availability === "not_offered") {
                      return (
                        <tr key={v.id}>
                          <td>
                            <span className="bo-muted" style={{ fontSize: 12.5 }}>
                              Non
                            </span>
                          </td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {v.label}
                            <span className="bo-kind">ajoutée après la publication</span>
                          </td>
                          <td className="bo-num">{formatCents(v.price)}</td>
                          <td colSpan={showUsage ? 3 : 2}>
                            {v.canOffer ? (
                              <button
                                type="button"
                                className="bo-btn bo-btn-secondary bo-btn-sm"
                                onClick={() => onOffer(v, o.title)}
                                aria-label={`Proposer « ${v.label} » sur ce lot`}
                              >
                                Proposer sur ce lot
                              </button>
                            ) : (
                              <span className="bo-muted">Ne peut plus être proposée sur ce lot terminé.</span>
                            )}
                          </td>
                        </tr>
                      );
                    }
                    const s = setting(v.id);
                    return (
                      <tr key={v.id}>
                        <td style={{ width: 90 }}>
                          <input
                            type="checkbox"
                            className="bo-default-radio"
                            checked={s.enabled}
                            disabled={!canAvailability || v.isDefault}
                            onChange={(e) => update(v.id, { enabled: e.target.checked })}
                            aria-label={`Proposer « ${v.label} » (${o.title}) pour ce lot`}
                            title={v.isDefault ? "Valeur par défaut : toujours proposée" : undefined}
                          />
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {v.label}
                          {v.isDefault && <span className="bo-kind">par défaut, gratuite</span>}
                        </td>
                        <td className="bo-num">{formatCents(v.price)}</td>
                        <td style={{ width: 170 }}>
                          {v.isDefault ? (
                            <span className="bo-muted">Gratuite</span>
                          ) : (
                            <MoneyInput
                              small
                              value={s.priceOverride}
                              placeholder={centsToInput(v.price)}
                              onChange={(priceOverride) => update(v.id, { priceOverride })}
                              disabled={!canAvailability || !s.enabled}
                              aria-label={`Prix dérogatoire de « ${v.label} »`}
                            />
                          )}
                        </td>
                        <td style={{ width: 130 }}>
                          <input
                            className="bo-input bo-input-sm bo-num"
                            type="number"
                            min={v.used ?? 0}
                            step={1}
                            value={s.maxQty}
                            placeholder="Illimitée"
                            onChange={(e) => update(v.id, { maxQty: e.target.value })}
                            disabled={!canMaxQty || !s.enabled}
                            aria-label={`Quantité maximale de « ${v.label} »`}
                          />
                        </td>
                        {showUsage && <td className="bo-num">{v.used ?? 0}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
