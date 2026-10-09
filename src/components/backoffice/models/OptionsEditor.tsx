"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { getModel, OptionDto } from "@/server/catalog";
import { centsToInput, eurosToCents, formatCents } from "@/lib/decimal";
import { api, ApiFailure, toFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Field, MoneyInput, splitFieldFailure } from "../ui";
import { describeParts, PartsPicker, type Part, type PartLink } from "./PartsPicker";

type Model = Awaited<ReturnType<typeof getModel>>;
type OptionValue = OptionDto["values"][number];

const KIND_LABELS = { choice: "Choix entre options", toggle: "Avec / Sans" } as const;

/** Exécute une écriture, puis recharge les données serveur de la page. */
function useMutation() {
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

/** Libellés en double dans une saisie (majuscules et espaces de bord ignorés, comme le serveur) : indices. */
function duplicateIndices(labels: string[]): Set<number> {
  const seen = new Map<string, number[]>();
  labels.forEach((label, i) => {
    const key = label.trim().toLowerCase();
    if (key) seen.set(key, [...(seen.get(key) ?? []), i]);
  });
  return new Set([...seen.values()].filter((idx) => idx.length > 1).flat());
}

/** Place le focus sur le champ qu'un refus du serveur désigne, pour que son erreur soit lue. */
function useFocusOn(ref: React.RefObject<HTMLElement | null>, when: unknown) {
  useEffect(() => {
    if (when) ref.current?.focus();
  }, [ref, when]);
}

function parsePosition(text: string): number | undefined | null {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : null;
}

export function OptionsEditor({ model, parts }: { model: Model; parts: Part[] }) {
  const [creating, setCreating] = useState(false);
  return (
    <section className="bo-card" aria-labelledby="options-title">
      <div className="bo-card-head">
        <div>
          <h2 id="options-title">Menus d&apos;options</h2>
          <p>Options d&apos;achat proposées aux clients pour ce modèle. Chaque menu a toujours une valeur par défaut.</p>
        </div>
        {!creating && (
          <button type="button" className="bo-btn bo-btn-secondary" onClick={() => setCreating(true)}>
            Nouveau menu
          </button>
        )}
      </div>
      {creating && <NewOptionForm modelId={model.id} parts={parts} onDone={() => setCreating(false)} />}
      {model.options.length === 0 && !creating ? (
        <div className="bo-empty" style={{ padding: "32px 16px" }}>
          <p>Aucun menu d&apos;options. Exemple : « Kit de ventilation » avec Sans kit, Air Flow, Silent kit.</p>
          <button type="button" className="bo-btn bo-btn-primary" onClick={() => setCreating(true)}>
            Créer un menu d&apos;options
          </button>
        </div>
      ) : (
        <div style={{ marginTop: creating ? 20 : 0 }}>
          {model.options.map((option) => (
            <OptionCard key={option.id} option={option} parts={parts} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Création d'un menu ───

type DraftValue = { label: string; price: string };

function NewOptionForm({ modelId, parts, onDone }: { modelId: string; parts: Part[]; onDone: () => void }) {
  const id = useId();
  const { pending, failure, setFailure, run } = useMutation();
  const [kind, setKind] = useState<"choice" | "toggle">("choice");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [position, setPosition] = useState("");
  const [values, setValues] = useState<DraftValue[]>([
    { label: "", price: "0" },
    { label: "", price: "" },
  ]);
  const [defaultIndex, setDefaultIndex] = useState(0);
  const [togglePrice, setTogglePrice] = useState("");
  const [toggleParts, setToggleParts] = useState<PartLink[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const titleError = touched && !title.trim() ? "Indiquez le titre du menu, ex. Kit de ventilation." : null;
  // Refus du serveur portant sur un champ : message tel quel sous le titre, ou sous les valeurs
  const titleSplit = splitFieldFailure(failure, "option_title_taken");
  const labelSplit = splitFieldFailure(titleSplit.rest, "option_value_label_taken");
  const titleTaken = titleSplit.fieldError;
  const labelTaken = labelSplit.fieldError;
  const duplicates = labelTaken ? duplicateIndices(values.map((v) => v.label)) : new Set<number>();
  const titleRef = useRef<HTMLInputElement>(null);
  const labelRefs = useRef<(HTMLInputElement | null)[]>([]);
  const firstDuplicate = duplicates.size > 0 ? Math.min(...duplicates) : 0;
  useFocusOn(titleRef, titleTaken);
  useEffect(() => {
    if (labelTaken) labelRefs.current[firstDuplicate]?.focus();
  }, [labelTaken, firstDuplicate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    setFailure(null);
    setTouched(true);
    if (!title.trim()) return; // erreur affichée sous le champ
    const pos = parsePosition(position);
    if (pos === null) return setLocalError("La position doit être un entier positif.");
    const base = { title, description: description.trim() || null, ...(pos === undefined ? {} : { position: pos }) };
    let body: object;
    if (kind === "toggle") {
      const price = eurosToCents(togglePrice);
      if (price === null) return setLocalError("Indiquez le prix de l'option « Avec », ex. 75 ou 75,50.");
      // « Sans » est toujours le défaut : pas de defaultOn à envoyer
      body = { kind, ...base, price, parts: toggleParts };
    } else {
      const unnamed = values.findIndex((v) => v.label.trim() === "" && !["", "0"].includes(v.price.trim()));
      if (unnamed >= 0) return setLocalError(`Valeur ${unnamed + 1} : indiquez un libellé, ou retirez la ligne.`);
      const filled = values.map((v, i) => ({ ...v, i })).filter((v) => v.label.trim() !== "");
      if (filled.length === 0) return setLocalError("Ajoutez au moins une valeur avec un libellé.");
      const converted = filled.map((v) => ({ ...v, cents: eurosToCents(v.price) }));
      const bad = converted.find((v) => v.cents === null);
      if (bad) return setLocalError(`Prix invalide pour « ${bad.label} » : indiquez un montant en euros, ex. 35 ou 35,50.`);
      const defaultFilled = converted.some((v) => v.i === defaultIndex) ? defaultIndex : converted[0].i;
      const defaultValue = converted.find((v) => v.i === defaultFilled)!;
      if (defaultValue.cents !== "0") {
        return setLocalError(
          `La valeur par défaut est toujours gratuite (machine sans option) : mettez le prix de « ${defaultValue.label.trim()} » à 0, ou choisissez une autre valeur par défaut.`,
        );
      }
      body = {
        kind,
        ...base,
        values: converted.map((v, rank) => ({
          label: v.label,
          price: v.cents,
          position: rank,
          isDefault: v.i === defaultFilled,
        })),
      };
    }
    if (await run(() => api("POST", `/api/backoffice/models/${modelId}/options`, body))) onDone();
  }

  return (
    <form className="bo-subform bo-form" onSubmit={submit} aria-labelledby={`${id}-title`} noValidate>
      <h3 id={`${id}-title`}>Nouveau menu d&apos;options</h3>
      <fieldset className="bo-segmented" aria-label="Type de menu">
        {(["choice", "toggle"] as const).map((k) => (
          <label key={k}>
            <input type="radio" name={`${id}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} />
            {KIND_LABELS[k]}
          </label>
        ))}
      </fieldset>
      <p className="bo-hint">
        {kind === "choice"
          ? "Le client choisit une valeur parmi plusieurs (ex. Sans kit, Air Flow, Silent kit)."
          : "Le client coche ou non l'option (ex. Kit silencieux). Les valeurs « Sans » et « Avec » sont créées automatiquement."}
      </p>
      <div className="bo-fields">
        <Field label="Titre" hint="Très court, ex. Kit de ventilation." error={titleError ?? titleTaken}>
          {(p) => (
            <input
              {...p}
              ref={titleRef}
              className="bo-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={120}
              autoFocus
            />
          )}
        </Field>
        <Field label="Position" optional hint="Ordre d'affichage des menus (0 = premier). Par défaut : à la fin.">
          {(p) => (
            <input {...p} className="bo-input bo-num" type="number" min={0} value={position} onChange={(e) => setPosition(e.target.value)} />
          )}
        </Field>
        <Field label="Description" optional wide>
          {(p) => (
            <input {...p} className="bo-input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          )}
        </Field>
      </div>

      {kind === "choice" ? (
        <fieldset style={{ border: 0 }}>
          <legend className="bo-label" style={{ marginBottom: 8 }}>
            Valeurs
          </legend>
          <table className="bo-table">
            <thead>
              <tr>
                <th scope="col">Par défaut</th>
                <th scope="col">Libellé</th>
                <th scope="col">Prix</th>
                <th scope="col">
                  <span className="bo-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {values.map((v, i) => (
                <tr key={i}>
                  <td>
                    <input
                      type="radio"
                      className="bo-default-radio"
                      name={`${id}-default`}
                      checked={defaultIndex === i}
                      onChange={() => setDefaultIndex(i)}
                      aria-label={`Valeur ${i + 1} par défaut`}
                    />
                  </td>
                  <td>
                    <input
                      ref={(el) => {
                        labelRefs.current[i] = el;
                      }}
                      className="bo-input bo-input-sm"
                      value={v.label}
                      aria-label={`Libellé de la valeur ${i + 1}`}
                      aria-invalid={duplicates.has(i) ? true : undefined}
                      aria-describedby={duplicates.has(i) ? `${id}-labels-error` : undefined}
                      onChange={(e) => setValues(values.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                      maxLength={120}
                    />
                  </td>
                  <td style={{ width: 160 }}>
                    <MoneyInput
                      small
                      value={v.price}
                      aria-label={`Prix de la valeur ${i + 1}`}
                      onChange={(price) => setValues(values.map((x, j) => (j === i ? { ...x, price } : x)))}
                    />
                  </td>
                  <td style={{ width: 90 }}>
                    {values.length > 1 && (
                      <button
                        type="button"
                        className="bo-btn bo-btn-ghost bo-btn-sm"
                        aria-label={`Retirer la valeur ${i + 1}`}
                        onClick={() => {
                          setValues(values.filter((_, j) => j !== i));
                          setDefaultIndex(defaultIndex === i ? 0 : defaultIndex > i ? defaultIndex - 1 : defaultIndex);
                        }}
                      >
                        Retirer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className="bo-btn bo-btn-secondary bo-btn-sm"
            style={{ marginTop: 8 }}
            onClick={() => setValues([...values, { label: "", price: "" }])}
          >
            Ajouter une valeur
          </button>
          {labelTaken && (
            <p className="bo-field-error" id={`${id}-labels-error`} style={{ marginTop: 8 }}>
              {labelTaken}
            </p>
          )}
          <p className="bo-hint" style={{ marginTop: 8 }}>
            La valeur par défaut est gratuite (0 €) : c&apos;est la machine sans option. Les produits à monter
            s&apos;associent ensuite, valeur par valeur.
          </p>
        </fieldset>
      ) : (
        <div className="bo-fields">
          <Field label="Prix de l'option « Avec »" hint="« Sans » est toujours la valeur par défaut, gratuite.">
            {(p) => <MoneyInput {...p} value={togglePrice} onChange={setTogglePrice} />}
          </Field>
          <div className="bo-field-wide">
            <PartsPicker idPrefix={`${id}-toggle`} value={toggleParts} parts={parts} onChange={setToggleParts} />
          </div>
        </div>
      )}

      {localError && (
        <div className="bo-alert bo-alert-error" role="alert">
          {localError}
        </div>
      )}
      <ErrorAlert failure={labelSplit.rest} />
      <div className="bo-actions">
        <button type="submit" className="bo-btn bo-btn-primary" disabled={pending}>
          {pending ? "Création…" : "Créer le menu"}
        </button>
        <button type="button" className="bo-btn bo-btn-secondary" onClick={onDone} disabled={pending}>
          Annuler
        </button>
      </div>
    </form>
  );
}

// ─── Un menu existant ───

function OptionCard({ option, parts }: { option: OptionDto; parts: Part[] }) {
  const headingId = useId();
  const { pending, failure, setFailure, run } = useMutation();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(option.title);
  const [description, setDescription] = useState(option.description ?? "");
  const [position, setPosition] = useState(String(option.position));
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<
    { kind: "option" } | { kind: "value"; value: OptionValue } | { kind: "default"; value: OptionValue } | null
  >(null);
  const [titleTouched, setTitleTouched] = useState(false);
  const titleError = titleTouched && !title.trim() ? "Indiquez le titre du menu." : null;
  // Titre déjà pris (en modification du menu) : message du serveur sous le champ « Titre »
  const { fieldError: titleTaken, rest: cardFailure } = splitFieldFailure(editing ? failure : null, "option_title_taken");
  const titleRef = useRef<HTMLInputElement>(null);
  useFocusOn(titleRef, titleTaken);

  async function saveOption(e: React.FormEvent) {
    e.preventDefault();
    setTitleTouched(true);
    if (!title.trim()) return;
    const pos = parsePosition(position);
    if (pos === null || pos === undefined) {
      setFailure(new ApiFailure(0, "local", "La position doit être un entier positif."));
      return;
    }
    const ok = await run(() =>
      api("PATCH", `/api/backoffice/options/${option.id}`, {
        title,
        description: description.trim() || null,
        position: pos,
      }),
    );
    if (ok) setEditing(false);
  }

  /**
   * Le défaut est toujours gratuit : une valeur gratuite devient le défaut en un clic, une valeur
   * payante après confirmation de son passage à 0 € (même requête, docs/api.md).
   */
  async function makeDefault(value: OptionValue) {
    if (value.price !== "0") {
      setFailure(null);
      setConfirm({ kind: "default", value });
      return;
    }
    await run(() => api("PATCH", `/api/backoffice/option-values/${value.id}`, { isDefault: true }));
  }

  async function confirmAction() {
    if (!confirm) return;
    const ok = await run(() =>
      confirm.kind === "option"
        ? api("DELETE", `/api/backoffice/options/${option.id}`)
        : confirm.kind === "default"
          ? api("PATCH", `/api/backoffice/option-values/${confirm.value.id}`, { isDefault: true, price: "0" })
          : api("DELETE", `/api/backoffice/option-values/${confirm.value.id}`),
    );
    if (ok) setConfirm(null);
  }

  return (
    <article className="bo-option" aria-labelledby={headingId}>
      {editing ? (
        <form className="bo-form" onSubmit={saveOption} style={{ marginBottom: 16 }}>
          <div className="bo-fields">
            <Field label="Titre" error={titleError ?? titleTaken}>
              {(p) => (
                <input
                  {...p}
                  ref={titleRef}
                  className="bo-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={120}
                />
              )}
            </Field>
            <Field label="Position" hint="0 = premier menu affiché.">
              {(p) => (
                <input {...p} className="bo-input bo-num" type="number" min={0} value={position} onChange={(e) => setPosition(e.target.value)} />
              )}
            </Field>
            <Field label="Description" optional wide>
              {(p) => <input {...p} className="bo-input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />}
            </Field>
          </div>
          <ErrorAlert failure={cardFailure} />
          <div className="bo-actions">
            <button type="submit" className="bo-btn bo-btn-primary bo-btn-sm" disabled={pending}>
              Enregistrer
            </button>
            <button
              type="button"
              className="bo-btn bo-btn-secondary bo-btn-sm"
              onClick={() => {
                setEditing(false);
                setTitleTouched(false);
                setFailure(null);
              }}
            >
              Annuler
            </button>
          </div>
          <h3 id={headingId} className="bo-visually-hidden">
            {option.title}
          </h3>
        </form>
      ) : (
        <div className="bo-option-head">
          <div>
            <h3 id={headingId}>
              {option.title}
              <span className="bo-kind">
                {KIND_LABELS[option.kind]} · position {option.position}
              </span>
            </h3>
            {option.description && <p>{option.description}</p>}
          </div>
          <div className="bo-actions" style={{ flexWrap: "nowrap" }}>
            <button
              type="button"
              className="bo-btn bo-btn-ghost bo-btn-sm"
              onClick={() => {
                setTitle(option.title);
                setDescription(option.description ?? "");
                setPosition(String(option.position));
                setEditing(true);
              }}
              aria-label={`Modifier le menu ${option.title}`}
            >
              Modifier
            </button>
            <button
              type="button"
              className="bo-btn bo-btn-ghost bo-btn-sm"
              onClick={() => setConfirm({ kind: "option" })}
              aria-label={`Supprimer le menu ${option.title}`}
            >
              Supprimer
            </button>
          </div>
        </div>
      )}

      <div className="bo-table-scroll">
        <table className="bo-table">
          <caption className="bo-visually-hidden">Valeurs du menu {option.title}</caption>
          <thead>
            <tr>
              <th scope="col">Valeur</th>
              <th scope="col">Prix</th>
              <th scope="col">Position</th>
              <th scope="col">Produits</th>
              <th scope="col">Défaut</th>
              <th scope="col">
                <span className="bo-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {option.values.map((value) =>
              editingValue === value.id ? (
                <tr key={value.id}>
                  <td colSpan={6}>
                    <ValueForm
                      option={option}
                      value={value}
                      parts={parts}
                      onDone={() => setEditingValue(null)}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={value.id}>
                  <td>
                    <strong>{value.label}</strong>
                  </td>
                  <td className="bo-num">{formatCents(value.price)}</td>
                  <td className="bo-num">{value.position}</td>
                  <td className="bo-parts-list">{describeParts(value.parts)}</td>
                  <td>
                    {value.isDefault ? (
                      <span className="bo-badge bo-badge-sale">Par défaut</span>
                    ) : option.kind === "toggle" ? (
                      <span className="bo-muted" title="Dans un menu Avec / Sans, « Sans » est toujours le défaut">
                        —
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="bo-btn bo-btn-secondary bo-btn-sm"
                        disabled={pending}
                        onClick={() => makeDefault(value)}
                        aria-label={`Définir « ${value.label} » par défaut`}
                      >
                        Définir par défaut
                      </button>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <button
                      type="button"
                      className="bo-btn bo-btn-ghost bo-btn-sm"
                      onClick={() => setEditingValue(value.id)}
                      aria-label={`Modifier la valeur ${value.label}`}
                    >
                      Modifier
                    </button>
                    {option.kind === "choice" && (
                      <button
                        type="button"
                        className="bo-btn bo-btn-ghost bo-btn-sm"
                        onClick={() => setConfirm({ kind: "value", value })}
                        aria-label={`Supprimer la valeur ${value.label}`}
                      >
                        Supprimer
                      </button>
                    )}
                  </td>
                </tr>
              ),
            )}
            {option.values.length === 0 && (
              <tr>
                <td colSpan={6} className="bo-muted">
                  Aucune valeur : ajoutez-en une, elle deviendra la valeur par défaut.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!confirm && !editing && <ErrorAlert failure={failure} />}

      {option.kind === "choice" &&
        (adding ? (
          <ValueForm option={option} parts={parts} onDone={() => setAdding(false)} />
        ) : (
          <button type="button" className="bo-btn bo-btn-secondary bo-btn-sm" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
            Ajouter une valeur
          </button>
        ))}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "default"
            ? `Faire de « ${confirm.value.label} » la valeur par défaut ?`
            : confirm?.kind === "value"
              ? `Supprimer la valeur « ${confirm.value.label} » ?`
              : `Supprimer le menu « ${option.title} » ?`
        }
        confirmLabel={confirm?.kind === "default" ? "Passer à 0 € et définir par défaut" : "Supprimer"}
        confirmTone={confirm?.kind === "default" ? "primary" : "danger"}
        pending={pending}
        onConfirm={confirmAction}
        onClose={() => {
          setConfirm(null);
          setFailure(null);
        }}
      >
        <p>
          {confirm?.kind === "default"
            ? `La valeur par défaut est toujours gratuite : c'est la machine sans option. Son prix passera de ${formatCents(confirm.value.price)} à 0,00 €.`
            : confirm?.kind === "value"
              ? "Une valeur réglée sur un lot ou choisie par un client ne peut pas être supprimée. Pour supprimer la valeur par défaut, désignez d'abord un autre défaut."
              : "Le menu et ses valeurs seront supprimés. Un menu réglé sur un lot ou choisi par un client ne peut pas être supprimé."}
        </p>
        <ErrorAlert failure={failure} />
      </ConfirmDialog>
    </article>
  );
}

// ─── Création ou modification d'une valeur ───

function ValueForm({
  option,
  value,
  parts,
  onDone,
}: {
  option: OptionDto;
  value?: OptionValue;
  parts: Part[];
  onDone: () => void;
}) {
  const id = useId();
  const { pending, failure, run } = useMutation();
  const [label, setLabel] = useState(value?.label ?? "");
  // Libellé déjà pris dans ce menu : message du serveur sous le champ « Libellé »
  const { fieldError: labelTaken, rest: formFailure } = splitFieldFailure(failure, "option_value_label_taken");
  const labelRef = useRef<HTMLInputElement>(null);
  useFocusOn(labelRef, labelTaken);
  const [price, setPrice] = useState(value ? centsToInput(value.price) : "");
  const [position, setPosition] = useState(value ? String(value.position) : "");
  const [isDefault, setIsDefault] = useState(false);
  const [links, setLinks] = useState<PartLink[]>(value?.parts.map((p) => ({ partId: p.id, qty: p.qty })) ?? []);
  const [touched, setTouched] = useState(false);

  const cents = eurosToCents(price);
  const pos = parsePosition(position);
  // Défaut actuel ou futur : toujours gratuit (la base le garantit, on le dit avant l'envoi)
  const willBeDefault = Boolean(value?.isDefault) || isDefault;
  const labelError = touched && !label.trim() ? "Indiquez le libellé de la valeur, ex. Silent kit." : null;
  const priceError =
    touched && cents === null
      ? "Montant en euros, ex. 35 ou 35,50."
      : touched && willBeDefault && cents !== "0"
        ? "La valeur par défaut est toujours gratuite : prix 0."
        : null;
  const positionError = touched && pos === null ? "Entier positif." : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (cents === null || pos === null || !label.trim() || (willBeDefault && cents !== "0")) return;
    const body = {
      label,
      price: cents,
      parts: links,
      ...(pos === undefined ? {} : { position: pos }),
      ...(isDefault ? { isDefault: true } : {}),
    };
    const ok = await run(() =>
      value
        ? api("PATCH", `/api/backoffice/option-values/${value.id}`, body)
        : api("POST", `/api/backoffice/options/${option.id}/values`, body),
    );
    if (ok) onDone();
  }

  return (
    <form className="bo-subform bo-form" onSubmit={submit} noValidate aria-label={value ? `Modifier ${value.label}` : "Nouvelle valeur"}>
      <div className="bo-fields">
        <Field label="Libellé" error={labelError ?? labelTaken}>
          {(p) => (
            <input
              {...p}
              ref={labelRef}
              className="bo-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              maxLength={120}
              autoFocus
            />
          )}
        </Field>
        <Field
          label="Prix"
          hint={value?.isDefault ? "Valeur par défaut : toujours gratuite." : "S'ajoute au prix de la machine."}
          error={priceError}
        >
          {(p) => <MoneyInput {...p} value={price} onChange={setPrice} />}
        </Field>
        <Field label="Position" optional={!value} hint={value ? undefined : "Par défaut : en dernier."} error={positionError}>
          {(p) => (
            <input {...p} className="bo-input bo-num" type="number" min={0} value={position} onChange={(e) => setPosition(e.target.value)} />
          )}
        </Field>
        {!value?.isDefault && option.kind === "choice" && (
          <div className="bo-field" style={{ justifyContent: "flex-end" }}>
            <label className="bo-check">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Valeur par défaut (gratuite)
            </label>
          </div>
        )}
        <div className="bo-field-wide">
          <PartsPicker idPrefix={id} value={links} parts={parts} onChange={setLinks} />
        </div>
      </div>
      <ErrorAlert failure={formFailure} />
      <div className="bo-actions">
        <button type="submit" className="bo-btn bo-btn-primary bo-btn-sm" disabled={pending}>
          {pending ? "Enregistrement…" : value ? "Enregistrer" : "Ajouter la valeur"}
        </button>
        <button type="button" className="bo-btn bo-btn-secondary bo-btn-sm" onClick={onDone} disabled={pending}>
          Annuler
        </button>
      </div>
    </form>
  );
}
