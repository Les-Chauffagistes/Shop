import type { OptionKind, Prisma } from "../../prisma/generated/client";
import { batchNotFound } from "./batches";
import { getDb } from "./db";
import { ApiError } from "./errors";
import { bigintToJson } from "./http";

/**
 * Configuration d'une machine (wishlist ou ligne de commande) : instantané complet du choix.
 * Une configuration porte un item pour chaque menu visible du lot (batch_menus non masqué) qui a
 * une valeur par défaut, « Sans » à 0 € compris ; aucun item pour un menu masqué ou non applicable
 * (Configuration_complete, ConfigurationItem_guard). Les prix sont relus en base
 * (batch_offered_values : dérogation du lot, sinon prix catalogue), jamais repris du client.
 * Utilisé par la wishlist (jalon 3) et la commande (jalon 4), dans leur transaction.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | ReturnType<typeof getDb>;

/** Un menu visible du lot : sa valeur par défaut et les valeurs proposées, au prix effectif. */
export type MenuOffer = { optionId: string; defaultValueId: string | null; prices: ReadonlyMap<string, bigint> };

export type Choice = { optionId: string; optionValueId: string };

export type ItemToWrite = { optionId: string; optionValueId: string; unitPrice: bigint };

const NOT_OFFERED_MESSAGE = "Une des options choisies n'est plus proposée sur ce lot.";

/**
 * Choix refusés parce que le lot ne les propose pas (menu masqué, valeur retirée ou absente). Le
 * message générique est précisé par snapshotConfiguration, qui sait nommer le menu et la valeur.
 */
class NotOfferedError extends ApiError {
  constructor(readonly rejected: readonly Choice[]) {
    super(422, "option_not_offered", NOT_OFFERED_MESSAGE);
  }
}

/**
 * Items d'une configuration complète : le choix de l'utilisateur dans un menu visible, sinon la
 * valeur par défaut (0 €). Domaine pur. Refus : menu choisi deux fois (400 invalid_input),
 * menu ou valeur non proposés par le lot (422 option_not_offered).
 */
export function buildConfigurationItems(menus: readonly MenuOffer[], choices: readonly Choice[]): ItemToWrite[] {
  const chosen = new Map<string, string>();
  for (const c of choices) {
    if (chosen.has(c.optionId)) throw new ApiError(400, "invalid_input", "Un menu est choisi deux fois.");
    chosen.set(c.optionId, c.optionValueId);
  }
  const byId = new Map(menus.map((m) => [m.optionId, m]));
  const rejected = [...chosen].filter(([optionId, valueId]) => !byId.get(optionId)?.prices.has(valueId));
  if (rejected.length > 0) throw new NotOfferedError(rejected.map(([optionId, optionValueId]) => ({ optionId, optionValueId })));
  return menus.flatMap((menu): ItemToWrite[] => {
    if (menu.defaultValueId === null) return []; // menu sans valeur : rien à choisir
    const valueId = chosen.get(menu.optionId) ?? menu.defaultValueId;
    const unitPrice = valueId === menu.defaultValueId ? 0n : menu.prices.get(valueId)!;
    return [{ optionId: menu.optionId, optionValueId: valueId, unitPrice }];
  });
}

// ─── Offre d'un lot : menus visibles et valeurs proposées ───

export type OfferedValue = {
  id: string;
  label: string;
  isDefault: boolean;
  position: number;
  /** Prix effectif sur le lot (dérogation, sinon catalogue), centimes ; toujours 0 pour le défaut (garanti en base) */
  price: bigint;
  /** Ventes maximales de cette valeur sur le lot ; null = illimité */
  maxQty: number | null;
};

export type OfferedMenu = {
  id: string;
  kind: OptionKind;
  title: string;
  description: string | null;
  position: number;
  /** Valeurs proposées (batch_offered_values), triées par position puis libellé */
  values: OfferedValue[];
};

type OfferRow = {
  option_id: string;
  kind: OptionKind;
  title: string;
  description: string | null;
  option_position: number;
  value_id: string;
  label: string;
  is_default: boolean;
  value_position: number;
  price: bigint;
  max_qty: number | null;
};

/**
 * Ce que le lot propose au choix : menus visibles (batch_menus non masqué ; catalogue vivant en
 * brouillon, instantané ensuite) et leurs valeurs proposées au prix effectif (batch_offered_values).
 * Seule lecture de l'offre : fiche produit publique et écriture des configurations. Un menu sans
 * valeur proposée n'apparaît pas.
 */
export async function loadBatchOffer(db: Db, batchId: string): Promise<OfferedMenu[]> {
  const rows = await db.$queryRaw<OfferRow[]>`
    SELECT o."id" AS "option_id", o."kind"::text AS "kind", o."title", o."description", o."position" AS "option_position",
      v."id" AS "value_id", v."label", v."is_default", v."position" AS "value_position",
      ov."price", bov."max_qty"
    FROM "batch_offered_values"(${batchId}::uuid) ov
    JOIN "Option" o ON o."id" = ov."option_id"
    JOIN "OptionValue" v ON v."id" = ov."option_value_id"
    LEFT JOIN "BatchOptionValue" bov ON bov."batch_id" = ${batchId}::uuid AND bov."option_value_id" = v."id"
    ORDER BY o."position", o."title", o."id", v."position", v."label", v."id"`;
  const menus = new Map<string, OfferedMenu>();
  for (const r of rows) {
    let menu = menus.get(r.option_id);
    if (!menu) {
      menu = { id: r.option_id, kind: r.kind, title: r.title, description: r.description, position: r.option_position, values: [] };
      menus.set(r.option_id, menu);
    }
    menu.values.push({
      id: r.value_id,
      label: r.label,
      isDefault: r.is_default,
      position: r.value_position,
      price: r.price,
      maxQty: r.max_qty,
    });
  }
  return [...menus.values()];
}

/** Menus proposés par le lot, au format JSON public (fiche produit, modification d'une wishlist). */
export function publicOptionsDto(menus: readonly OfferedMenu[]) {
  return menus.map((m) => ({
    id: m.id,
    kind: m.kind,
    title: m.title,
    description: m.description,
    position: m.position,
    values: m.values.map((v) => ({
      id: v.id,
      label: v.label,
      isDefault: v.isDefault,
      position: v.position,
      price: bigintToJson(v.price),
      maxQty: v.maxQty,
    })),
  }));
}

/** Offre d'un lot au format du domaine pur (buildConfigurationItems). */
export function toMenuOffers(menus: readonly OfferedMenu[]): MenuOffer[] {
  return menus.map((m) => ({
    optionId: m.id,
    defaultValueId: m.values.find((v) => v.isDefault)?.id ?? null,
    prices: new Map(m.values.map((v) => [v.id, v.price])),
  }));
}

// ─── Écriture ───

/**
 * Même refus, avec le nom de ce qui a disparu (« Silent kit : Avec ») pour que le client sache quoi
 * revoir. Libellés du catalogue seulement, jamais de prix ; un identifiant inconnu reste anonyme.
 */
async function namedNotOffered(tx: Tx, error: NotOfferedError): Promise<ApiError> {
  const values = await tx.optionValue.findMany({
    where: { id: { in: error.rejected.map((c) => c.optionValueId) } },
    select: { id: true, label: true, option: { select: { id: true, title: true } } },
  });
  const options = await tx.option.findMany({
    where: { id: { in: error.rejected.map((c) => c.optionId) } },
    select: { id: true, title: true },
  });
  const names = error.rejected.flatMap((c) => {
    const value = values.find((v) => v.id === c.optionValueId && v.option.id === c.optionId);
    const title = value?.option.title ?? options.find((o) => o.id === c.optionId)?.title;
    return title ? [value ? `« ${title} : ${value.label} »` : `« ${title} »`] : [];
  });
  if (names.length === 0) return error;
  return new ApiError(
    422,
    "option_not_offered",
    names.length === 1
      ? `L'option ${names[0]} n'est plus proposée sur ce lot.`
      : `Les options ${names.join(", ")} ne sont plus proposées sur ce lot.`,
  );
}

/** Instantané d'une configuration : prix de revente du lot et items au prix effectif. */
export type ConfigurationSnapshot = { modelId: string; basePrice: bigint; items: ItemToWrite[]; amount: bigint };

/**
 * Instantané complet pour le lot, dans la transaction `tx`. Verrou partagé du lot (FOR KEY SHARE) :
 * attend un masquage de menu ou une transition concurrents (FOR UPDATE) puis relit les menus validés.
 * Montant de la machine = prix de revente + options, en centimes.
 */
export async function snapshotConfiguration(tx: Tx, batchId: string, choices: readonly Choice[]): Promise<ConfigurationSnapshot> {
  const [batch] = await tx.$queryRaw<{ model_id: string; resale_unit_price: bigint | null }[]>`
    SELECT "model_id", "resale_unit_price" FROM "Batch" WHERE "id" = ${batchId}::uuid FOR KEY SHARE`;
  if (!batch) throw batchNotFound();
  if (batch.resale_unit_price === null) {
    throw new ApiError(422, "resale_price_required", "Le prix de revente du lot n'est pas défini.");
  }
  let items: ItemToWrite[];
  try {
    items = buildConfigurationItems(toMenuOffers(await loadBatchOffer(tx, batchId)), choices);
  } catch (error) {
    if (error instanceof NotOfferedError) throw await namedNotOffered(tx, error);
    throw error;
  }
  return {
    modelId: batch.model_id,
    basePrice: batch.resale_unit_price,
    items,
    amount: items.reduce((sum, i) => sum + i.unitPrice, batch.resale_unit_price),
  };
}

const itemData = (i: ItemToWrite) => ({ option_id: i.optionId, option_value_id: i.optionValueId, unit_price: i.unitPrice });

/** Crée une configuration à partir d'un instantané (une par machine : jamais partagée). */
export async function createConfiguration(tx: Tx, batchId: string, snapshot: ConfigurationSnapshot) {
  const configuration = await tx.configuration.create({
    data: {
      batch_id: batchId,
      model_id: snapshot.modelId,
      base_price: snapshot.basePrice,
      items: { create: snapshot.items.map(itemData) },
    },
  });
  return configuration.id;
}

/**
 * Crée une configuration complète pour le lot, dans la transaction `tx`. Renvoie l'identifiant et le
 * montant de la machine (prix de revente + options), en centimes. Utilisée par la facture (une
 * configuration par ligne, choix propres à chaque ligne, src/server/orders.ts) ; la wishlist partage
 * un instantané entre `quantity` configurations (snapshotConfiguration + createConfiguration).
 */
export async function writeConfiguration(tx: Tx, batchId: string, choices: readonly Choice[]) {
  const snapshot = await snapshotConfiguration(tx, batchId, choices);
  return { id: await createConfiguration(tx, batchId, snapshot), amount: snapshot.amount };
}

/**
 * Remplace une configuration ouverte (non verrouillée par une commande) par un nouvel instantané :
 * prix de revente et prix des options relus au moment de la modification. Même transaction ;
 * Configuration_complete est vérifiée au COMMIT. Une configuration verrouillée est refusée par la
 * base (Configuration_locked).
 */
export async function replaceConfiguration(tx: Tx, configurationId: string, batchId: string, choices: readonly Choice[]) {
  const snapshot = await snapshotConfiguration(tx, batchId, choices);
  await tx.configurationItem.deleteMany({ where: { configuration_id: configurationId } });
  await tx.configuration.update({
    where: { id: configurationId },
    data: { base_price: snapshot.basePrice, items: { create: snapshot.items.map(itemData) } },
  });
  return snapshot.amount;
}
