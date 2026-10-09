import { z } from "zod";
import type { Prisma } from "../../prisma/generated/client";
import { getDb } from "./db";
import { BATCH_STATUS_LABELS } from "./batch-status";
import { ApiError, type Blocker } from "./errors";
import { bigintToJson, cents, intBetween, label, optionalText, position, positiveBigint } from "./http";

/**
 * Catalogue backoffice : modèles de mineur, menus d'options et leurs valeurs, pièces.
 * Invariants garantis en base (migrations init et v4) et devancés ici pour des messages clairs :
 * une seule valeur par défaut par menu, toujours une dès qu'il y a des valeurs, et gratuite ;
 * menu Avec/Sans : deux valeurs, « Sans » toujours le défaut ; prix catalogue figé tant qu'un
 * lot publié propose la valeur ; défaut inchangeable s'il modifie une wishlist ou une commande.
 * Noms uniques sans casse ni espaces de bord (modèle, menu par modèle, valeur par menu, produit) :
 * garantis par les seuls index de la base, traduits en 409 dédiés par errors.ts.
 * Un menu « choix » à une seule valeur est permis ici (il se remplit valeur par valeur) : la règle
 * « au moins deux valeurs proposées » s'applique à la publication d'un lot (batch-status.ts).
 */

type Tx = Prisma.TransactionClient;

export const modelNotFound = () => new ApiError(404, "model_not_found", "Modèle introuvable.");
export const optionNotFound = () => new ApiError(404, "option_not_found", "Menu d'options introuvable.");
export const optionValueNotFound = () => new ApiError(404, "option_value_not_found", "Valeur d'option introuvable.");
export const partNotFound = () => new ApiError(404, "part_not_found", "Pièce introuvable.");

// ─── Entrées ───

/** Bornes de saisie (docs/api.md, « Bornes ») : refusent les fautes de frappe, pas les cas réels. */
export const MAX_HASHRATE = 10n ** 16n; // 10 PH/s
export const MAX_HASHBOARDS = 20;

export const modelInput = z.strictObject({
  name: label(120),
  /** Hashrate théorique en H/s, 1 H/s à 10 PH/s (les plus gros mineurs actuels font moins de 1 PH/s) */
  hashrate: positiveBigint(
    MAX_HASHRATE,
    'Hashrate en H/s attendu, sous forme de chaîne, entre "1" et "10000000000000000" (10 000 TH/s)',
  ),
  hashboardQtt: intBetween(1, MAX_HASHBOARDS, "Nombre de hashboards"),
  description: optionalText().optional(),
});
export const modelPatch = modelInput.partial();

const partLinks = z
  .array(z.strictObject({ partId: z.uuid(), qty: z.int().min(1).max(1000).default(1) }))
  .max(50)
  .refine((links) => new Set(links.map((l) => l.partId)).size === links.length, {
    error: "Une pièce est listée deux fois",
  });

const valueInput = z.strictObject({
  label: label(120),
  price: cents,
  isDefault: z.boolean().optional(),
  position: position.optional(),
  parts: partLinks.optional(),
});
export const optionValueInput = valueInput;
export const optionValuePatch = valueInput.partial();

const DEFAULT_IS_FREE = "La valeur par défaut d'un menu est gratuite (0 €)";
const DEFAULT_IS_WITHOUT = "Menu Avec/Sans : « Sans » est toujours la valeur par défaut";

const optionFields = {
  title: label(120),
  description: optionalText().optional(),
  position: position.optional(),
};

export const optionInput = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("choice"), ...optionFields, values: z.array(valueInput).max(50).optional() }),
    z.strictObject({
      kind: z.literal("toggle"),
      ...optionFields,
      /** Prix de la valeur « Avec » */
      price: cents,
      /** « Sans » est toujours le défaut : seul `false` est admis (compatibilité) */
      defaultOn: z.literal(false, { error: DEFAULT_IS_WITHOUT }).optional(),
      /** Pièces de la valeur « Avec » */
      parts: partLinks.optional(),
    }),
  ])
  .superRefine((input, ctx) => {
    if (input.kind !== "choice" || !input.values?.length) return;
    const defaults = input.values.filter((v) => v.isDefault).length;
    if (defaults > 1) {
      ctx.addIssue({ code: "custom", path: ["values"], message: "Une seule valeur par défaut par menu" });
      return;
    }
    const index = defaults === 0 ? 0 : input.values.findIndex((v) => v.isDefault);
    if (input.values[index].price !== 0n) {
      ctx.addIssue({ code: "custom", path: ["values", index, "price"], message: DEFAULT_IS_FREE });
    }
  });
export const optionPatch = z.strictObject(optionFields).partial();

export const partInput = z.strictObject({ name: label(120), reference: optionalText(120).optional() });
export const partPatch = partInput.partial();

// ─── Sorties ───

const valueInclude = {
  parts: { include: { part: true }, orderBy: { part: { name: "asc" } } },
} satisfies Prisma.OptionValueInclude;

const optionInclude = {
  values: { include: valueInclude, orderBy: [{ position: "asc" }, { label: "asc" }] },
} satisfies Prisma.OptionInclude;

type OptionRow = Prisma.OptionGetPayload<{ include: typeof optionInclude }>;
type PartRow = Prisma.PartGetPayload<object>;

function partDto(part: PartRow) {
  return { id: part.id, name: part.name, reference: part.reference };
}

function optionDto(option: OptionRow) {
  return {
    id: option.id,
    modelId: option.model_id,
    kind: option.kind,
    title: option.title,
    description: option.description,
    position: option.position,
    values: option.values.map((value) => ({
      id: value.id,
      optionId: value.option_id,
      label: value.label,
      isDefault: value.is_default,
      price: bigintToJson(value.price),
      position: value.position,
      parts: value.parts.map((link) => ({ ...partDto(link.part), qty: link.qty })),
    })),
  };
}

export type OptionDto = ReturnType<typeof optionDto>;

type ModelRow = Prisma.ModelGetPayload<{ include: { _count: { select: { options: true; batches: true } } } }>;

function modelSummaryDto(model: ModelRow) {
  return {
    id: model.id,
    name: model.name,
    hashrate: bigintToJson(model.hashrate),
    hashboardQtt: model.hashboard_qtt,
    description: model.description,
    createdAt: model.created_at.toISOString(),
    optionCount: model._count.options,
    batchCount: model._count.batches,
  };
}

const modelCount = { _count: { select: { options: true, batches: true } } } as const;

// ─── Ce qui bloque une suppression ou une modification ───

type BatchRef = { id: string; name: string; status: keyof typeof BATCH_STATUS_LABELS };

const batchRefSelect = { id: true, name: true, status: true } as const;

const batchBlockers = (batches: BatchRef[]): Blocker[] =>
  batches.map((b) => ({ kind: "batch", id: b.id, label: `${b.name} (${BATCH_STATUS_LABELS[b.status]})` }));

/** « « A (Brouillon) », « B (Sondage) » et 3 autres » : les premiers éléments, nommés. */
function nameList(blockers: Blocker[], max = 5): string {
  const shown = blockers.slice(0, max).map((b) => `« ${b.label} »`);
  const rest = blockers.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} et ${rest} autre(s)` : shown.join(", ");
}

/** Lots qui utilisent un menu ou une valeur : menu réglé (masqué, instantané), valeur réglée, configuration. */
function batchesUsing(tx: Tx, where: { option_id: string } | { option_value_id: string }) {
  return tx.batch.findMany({
    where: {
      OR: [
        ...("option_id" in where ? [{ options: { some: where } }] : []),
        { option_values: { some: where } },
        { configurations: { some: { items: { some: where } } } },
      ],
    },
    select: batchRefSelect,
    orderBy: { created_at: "asc" },
  });
}

// ─── Modèles ───

export async function listModels() {
  const models = await getDb().model.findMany({ include: modelCount, orderBy: { name: "asc" } });
  return { items: models.map(modelSummaryDto) };
}

export async function getModel(modelId: string, db: Tx = getDb()) {
  const model = await db.model.findUnique({
    where: { id: modelId },
    include: { ...modelCount, options: { include: optionInclude, orderBy: [{ position: "asc" }, { title: "asc" }] } },
  });
  if (!model) throw modelNotFound();
  return { ...modelSummaryDto(model), options: model.options.map(optionDto) };
}

export async function createModel(input: z.output<typeof modelInput>) {
  const model = await getDb().model.create({
    data: {
      name: input.name,
      hashrate: input.hashrate,
      hashboard_qtt: input.hashboardQtt,
      description: input.description ?? null,
    },
  });
  return getModel(model.id);
}

export async function updateModel(modelId: string, input: z.output<typeof modelPatch>) {
  const { count } = await getDb().model.updateMany({
    where: { id: modelId },
    data: {
      name: input.name,
      hashrate: input.hashrate,
      hashboard_qtt: input.hashboardQtt,
      description: input.description,
    },
  });
  if (count === 0) throw modelNotFound();
  return getModel(modelId);
}

/** Supprime un modèle jamais mis en lot, avec ses menus et valeurs. */
export async function deleteModel(modelId: string) {
  await getDb().$transaction(async (tx) => {
    const model = await tx.model.findUnique({
      where: { id: modelId },
      select: { batches: { select: batchRefSelect, orderBy: { created_at: "asc" } } },
    });
    if (!model) throw modelNotFound();
    if (model.batches.length > 0) {
      const blockers = batchBlockers(model.batches);
      throw new ApiError(
        409,
        "model_in_use",
        `Ce modèle est utilisé par ${blockers.length} lot(s) : ${nameList(blockers)}. Il ne peut pas être supprimé.`,
        blockers,
      );
    }
    await tx.optionValuePart.deleteMany({ where: { option_value: { option: { model_id: modelId } } } });
    await tx.optionValue.deleteMany({ where: { option: { model_id: modelId } } });
    await tx.option.deleteMany({ where: { model_id: modelId } });
    await tx.model.delete({ where: { id: modelId } });
  });
}

// ─── Menus d'options ───

async function readOption(tx: Tx, optionId: string) {
  const option = await tx.option.findUnique({ where: { id: optionId }, include: optionInclude });
  if (!option) throw optionNotFound();
  return optionDto(option);
}

async function assertPartsExist(tx: Tx, links: { partId: string }[]) {
  if (links.length === 0) return;
  const found = await tx.part.count({ where: { id: { in: links.map((l) => l.partId) } } });
  if (found !== links.length) throw new ApiError(422, "unknown_part", "Une des pièces indiquées n'existe pas.");
}

/** Remplace les pièces associées à une valeur. */
async function setValueParts(tx: Tx, valueId: string, links: { partId: string; qty: number }[]) {
  await assertPartsExist(tx, links);
  await tx.optionValuePart.deleteMany({ where: { option_value_id: valueId } });
  await tx.optionValuePart.createMany({
    data: links.map((l) => ({ option_value_id: valueId, part_id: l.partId, qty: l.qty })),
  });
}

/** Fait de `valueId` la valeur par défaut de son menu (l'ancienne cesse de l'être). */
async function setDefault(tx: Tx, optionId: string, valueId: string) {
  await tx.optionValue.updateMany({
    where: { option_id: optionId, is_default: true, NOT: { id: valueId } },
    data: { is_default: false },
  });
  await tx.optionValue.update({ where: { id: valueId }, data: { is_default: true } });
}

type ValueToCreate = { label: string; price: bigint; isDefault: boolean; position: number; parts?: { partId: string; qty: number }[] };

async function createValues(tx: Tx, optionId: string, values: ValueToCreate[]) {
  for (const value of values) {
    const created = await tx.optionValue.create({
      data: {
        option_id: optionId,
        label: value.label,
        price: value.price,
        is_default: value.isDefault,
        position: value.position,
      },
    });
    if (value.parts) await setValueParts(tx, created.id, value.parts);
  }
}

async function nextOptionPosition(tx: Tx, modelId: string) {
  const { _max } = await tx.option.aggregate({ where: { model_id: modelId }, _max: { position: true } });
  return _max.position === null ? 0 : _max.position + 1;
}

/**
 * Crée un menu et, dans la même transaction, ses valeurs.
 * - choice : `values` facultatif (le menu peut être rempli ensuite) ; sans défaut désigné, la
 *   première valeur devient la valeur par défaut.
 * - toggle : deux valeurs créées par le serveur, « Sans » (0) et « Avec » (`price`).
 */
export async function createOption(modelId: string, input: z.output<typeof optionInput>) {
  return getDb().$transaction(async (tx) => {
    if (!(await tx.model.findUnique({ where: { id: modelId }, select: { id: true } }))) throw modelNotFound();
    const option = await tx.option.create({
      data: {
        model_id: modelId,
        kind: input.kind,
        title: input.title,
        description: input.description ?? null,
        position: input.position ?? (await nextOptionPosition(tx, modelId)),
      },
    });
    if (input.kind === "toggle") {
      await createValues(tx, option.id, [
        { label: "Sans", price: 0n, isDefault: !input.defaultOn, position: 0 },
        { label: "Avec", price: input.price, isDefault: !!input.defaultOn, position: 1, parts: input.parts },
      ]);
    } else {
      const values = input.values ?? [];
      const hasDefault = values.some((v) => v.isDefault);
      await createValues(
        tx,
        option.id,
        values.map((v, i) => ({
          ...v,
          isDefault: hasDefault ? !!v.isDefault : i === 0,
          position: v.position ?? i,
        })),
      );
    }
    return readOption(tx, option.id);
  });
}

export async function updateOption(optionId: string, input: z.output<typeof optionPatch>) {
  const { count } = await getDb().option.updateMany({
    where: { id: optionId },
    data: { title: input.title, description: input.description, position: input.position },
  });
  if (count === 0) throw optionNotFound();
  return readOption(getDb(), optionId);
}

/**
 * Supprime un menu qu'aucun lot n'utilise : ni réglage (menu masqué, instantané de publication,
 * réglage d'une valeur), ni configuration (intérêt, commande ; défauts compris).
 */
export async function deleteOption(optionId: string) {
  await getDb().$transaction(async (tx) => {
    if (!(await tx.option.findUnique({ where: { id: optionId }, select: { id: true } }))) throw optionNotFound();
    const batches = await batchesUsing(tx, { option_id: optionId });
    if (batches.length > 0) {
      const blockers = batchBlockers(batches);
      throw new ApiError(
        409,
        "option_in_use",
        `Ce menu est utilisé par ${blockers.length} lot(s) : ${nameList(blockers)}. Il ne peut pas être supprimé.`,
        blockers,
      );
    }
    await tx.optionValuePart.deleteMany({ where: { option_value: { option_id: optionId } } });
    await tx.optionValue.deleteMany({ where: { option_id: optionId } });
    await tx.option.delete({ where: { id: optionId } });
  });
}

// ─── Valeurs ───

const toggleValuesFixed = () =>
  new ApiError(409, "toggle_values_fixed", "Un menu Avec/Sans a exactement deux valeurs : on ne peut ni en ajouter ni en supprimer.");

const defaultNotFree = (detail: string) =>
  new ApiError(422, "default_value_not_free", `La valeur par défaut d'un menu est gratuite (0 €) : ${detail}`);

/**
 * Ajoute une valeur à un menu « choix ». La première valeur d'un menu vide devient le défaut.
 * Elle n'est pas proposée par les lots déjà publiés (instantané) : « Proposer sur ce lot ».
 */
export async function createOptionValue(optionId: string, input: z.output<typeof optionValueInput>) {
  return getDb().$transaction(async (tx) => {
    const option = await tx.option.findUnique({ where: { id: optionId }, include: { values: true } });
    if (!option) throw optionNotFound();
    if (option.kind === "toggle") throw toggleValuesFixed();
    const isDefault = option.values.length === 0 || !!input.isDefault;
    if (isDefault && input.price !== 0n) {
      throw defaultNotFree(
        option.values.length === 0
          ? "la première valeur d'un menu en devient le défaut, son prix doit être 0."
          : "mettez le prix à 0 ou ne la désignez pas comme défaut.",
      );
    }
    const position = input.position ?? Math.max(-1, ...option.values.map((v) => v.position)) + 1;
    const created = await tx.optionValue.create({
      data: { option_id: optionId, label: input.label, price: input.price, position, is_default: false },
    });
    if (isDefault) await setDefault(tx, optionId, created.id);
    if (input.parts) await setValueParts(tx, created.id, input.parts);
    return readOption(tx, optionId);
  });
}

/**
 * Modifie une valeur. `isDefault: true` en fait le défaut du menu (l'ancien défaut cesse de
 * l'être, dans la même transaction). On ne retire pas le défaut à une valeur : on le donne à une autre.
 * `parts` remplace la liste des pièces associées.
 * Refus : défaut payant (422), « Avec » d'un menu Avec/Sans comme défaut (409 toggle_default_fixed),
 * prix catalogue d'une valeur proposée par un lot publié (409 option_price_frozen, lots nommés),
 * changement de défaut qui modifierait une wishlist ou une commande (409 default_change_locked, en base).
 */
export async function updateOptionValue(valueId: string, input: z.output<typeof optionValuePatch>) {
  return getDb().$transaction(async (tx) => {
    const value = await tx.optionValue.findUnique({ where: { id: valueId }, include: { option: { select: { kind: true } } } });
    if (!value) throw optionValueNotFound();
    if (input.isDefault === false && value.is_default) {
      throw new ApiError(
        409,
        "default_value_required",
        "Chaque menu doit garder une valeur par défaut : désignez-en une autre à la place.",
      );
    }
    const becomesDefault = !!input.isDefault && !value.is_default;
    if (becomesDefault && value.option.kind === "toggle") {
      throw new ApiError(
        409,
        "toggle_default_fixed",
        "Menu Avec/Sans : « Sans » est toujours la valeur par défaut, « Avec » ne peut pas le devenir.",
      );
    }
    const price = input.price ?? value.price;
    if ((value.is_default || becomesDefault) && price !== 0n) {
      throw defaultNotFree(value.is_default ? "son prix ne peut pas changer." : "mettez son prix à 0 dans la même modification.");
    }
    if (price !== value.price) await assertPriceNotFrozen(tx, valueId);
    await tx.optionValue.update({
      where: { id: valueId },
      data: { label: input.label, price: input.price, position: input.position },
    });
    if (input.isDefault && !value.is_default) {
      const withdrawn = await tx.batchOptionValue.count({ where: { option_value_id: valueId, enabled: false } });
      if (withdrawn > 0) {
        throw new ApiError(
          409,
          "default_value_withdrawn",
          `Cette valeur est retirée de ${withdrawn} lot(s) : elle ne peut pas devenir la valeur par défaut.`,
        );
      }
      await setDefault(tx, value.option_id, valueId);
    }
    if (input.parts) await setValueParts(tx, valueId, input.parts);
    return readOption(tx, value.option_id);
  });
}

/**
 * Prix catalogue figé tant qu'un lot publié non terminé (sondage à en transit) propose la valeur
 * (OptionValue_price_frozen) : on passe alors par une dérogation de prix sur le lot.
 */
async function assertPriceNotFrozen(tx: Tx, valueId: string) {
  const batches = await tx.batch.findMany({
    where: { status: { notIn: ["draft", "closed", "cancelled"] }, option_values: { some: { option_value_id: valueId } } },
    select: batchRefSelect,
    orderBy: { created_at: "asc" },
  });
  if (batches.length === 0) return;
  const blockers = batchBlockers(batches);
  throw new ApiError(
    409,
    "option_price_frozen",
    `Le prix catalogue de cette valeur est figé : ${blockers.length} lot(s) publié(s) la proposent (${nameList(blockers)}). Pour changer son prix sur un lot, utilisez une dérogation de prix sur ce lot.`,
    blockers,
  );
}

export async function deleteOptionValue(valueId: string) {
  return getDb().$transaction(async (tx) => {
    const value = await tx.optionValue.findUnique({ where: { id: valueId }, include: { option: { include: { values: true } } } });
    if (!value) throw optionValueNotFound();
    if (value.option.kind === "toggle") throw toggleValuesFixed();
    const batches = await batchesUsing(tx, { option_value_id: valueId });
    if (batches.length > 0) {
      const blockers = batchBlockers(batches);
      throw new ApiError(
        409,
        "option_value_in_use",
        `Cette valeur est utilisée par ${blockers.length} lot(s) : ${nameList(blockers)}. Elle ne peut pas être supprimée.`,
        blockers,
      );
    }
    if (value.is_default && value.option.values.length > 1) {
      throw new ApiError(
        409,
        "default_value_required",
        "Désignez une autre valeur par défaut avant de supprimer celle-ci.",
      );
    }
    await tx.optionValuePart.deleteMany({ where: { option_value_id: valueId } });
    await tx.optionValue.delete({ where: { id: valueId } });
    return readOption(tx, value.option_id);
  });
}

// ─── Pièces ───

export async function listParts() {
  const parts = await getDb().part.findMany({ orderBy: { name: "asc" } });
  return { items: parts.map(partDto) };
}

export async function createPart(input: z.output<typeof partInput>) {
  return partDto(await getDb().part.create({ data: { name: input.name, reference: input.reference ?? null } }));
}

export async function updatePart(partId: string, input: z.output<typeof partPatch>) {
  const { count } = await getDb().part.updateMany({
    where: { id: partId },
    data: { name: input.name, reference: input.reference },
  });
  if (count === 0) throw partNotFound();
  return partDto(await getDb().part.findUniqueOrThrow({ where: { id: partId } }));
}

/**
 * Supprime un produit inutilisé. Refus (409 part_in_use) s'il équipe une valeur d'option, s'il est
 * commandé pour un lot ou s'il a un historique de stock ; `blockers` nomme chaque élément.
 */
export async function deletePart(partId: string) {
  await getDb().$transaction(async (tx) => {
    const part = await tx.part.findUnique({
      where: { id: partId },
      select: {
        option_values: {
          select: { option_value: { select: { id: true, label: true, option: { select: { title: true, model: { select: { name: true } } } } } } },
        },
        batch_orders: { select: { id: true, batch: { select: { name: true } } } },
        _count: { select: { movements: true } },
      },
    });
    if (!part) throw partNotFound();
    const blockers: Blocker[] = [
      ...part.option_values.map(({ option_value: v }): Blocker => ({
        kind: "option_value",
        id: v.id,
        label: `${v.option.model.name} › ${v.option.title} › ${v.label}`,
      })),
      ...part.batch_orders.map((o): Blocker => ({ kind: "part_order", id: o.id, label: `Commande du lot ${o.batch.name}` })),
      ...(part._count.movements > 0
        ? [{ kind: "stock_movement", id: partId, label: `${part._count.movements} mouvement(s) de stock` } satisfies Blocker]
        : []),
    ];
    if (blockers.length > 0) {
      throw new ApiError(
        409,
        "part_in_use",
        `Ce produit est utilisé (${nameList(blockers)}) : il ne peut pas être supprimé.`,
        blockers,
      );
    }
    await tx.part.delete({ where: { id: partId } });
  });
}
