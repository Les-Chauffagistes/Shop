import { z } from "zod";
import type { BatchStatus, Prisma } from "../../prisma/generated/client";
import { BATCH_STATUS_LABELS } from "./batch-status";
import { batchNotFound } from "./batches";
import {
  createConfiguration,
  loadBatchOffer,
  publicOptionsDto,
  replaceConfiguration,
  snapshotConfiguration,
} from "./configurations";
import { BATCH_LIMITS } from "./batches";
import { getDb } from "./db";
import { ApiError, WISHLIST_CONVERTED_CANCEL } from "./errors";
import { machines } from "../lib/plural";
import { bigintToJson, intBetween } from "./http";
import { readShopSettings } from "./shop-settings";

/**
 * Manifestation d'intérêt (wishlist) : une ligne = une machine souhaitée sur un lot, sans argent,
 * avec sa configuration complète (une configuration par machine). Utilisateur connecté via
 * auth-service ; chacun ne voit et ne modifie que ses propres wishlists (sinon 404, sans révéler
 * l'existence). Création et modification de la configuration seulement pendant le sondage
 * (décision Hugo 2026-10-07 : configuration figée dès la précommande) ; gardes ici, et triggers
 * Wishlist_batch_survey et Wishlist_configuration_frozen en dernier rempart. Retrait à tout moment,
 * sauf une wishlist convertie en commande payée (trigger Wishlist_guard_converted en dernier rempart).
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | ReturnType<typeof getDb>;

export const wishlistNotFound = () => new ApiError(404, "wishlist_not_found", "Manifestation d'intérêt introuvable.");

// ─── Entrées ───

const choices = z
  .array(z.strictObject({ optionId: z.uuid(), optionValueId: z.uuid() }))
  .max(100)
  .default([]);

/**
 * Borne technique d'une requête (quantité d'un lot au plus). Le plafond métier par utilisateur et par
 * lot (ShopSettings, jamais plus que le lot) est contrôlé ensuite, avec un message qui le cite.
 */
const MAX_PER_REQUEST = BATCH_LIMITS.maxQuantity;

export const wishlistInput = z.strictObject({
  batchId: z.uuid(),
  /** Choix par menu ; un menu non choisi reçoit sa valeur par défaut (0 €) */
  choices,
  /** Nombre de machines souhaitées avec cette configuration (une wishlist par machine) */
  quantity: intBetween(1, MAX_PER_REQUEST, "Nombre entier de machines").default(1),
});

export const wishlistPatch = z.strictObject({ choices });

export const wishlistListQuery = z.object({ batchId: z.uuid().optional() });

// ─── Domaine pur ───

/** Plafond effectif de wishlists actives d'un utilisateur sur un lot : réglage (ShopSettings), et jamais plus que le lot. */
export function wishlistCap(configuredMax: number, batchQuantity: number): number {
  return Math.min(configuredMax, batchQuantity);
}

/** Refus de création : lot hors sondage, ou plafond dépassé. */
export function checkWishlistCreation(
  status: BatchStatus,
  { active, requested, cap }: { active: number; requested: number; cap: number },
): ApiError | null {
  if (status !== "survey") {
    return new ApiError(409, "wishlist_closed", "Les manifestations d'intérêt ne sont ouvertes que pendant le sondage du lot.");
  }
  if (active + requested > cap) {
    const left = Math.max(0, cap - active);
    return new ApiError(
      409,
      "wishlist_limit_reached",
      left === 0
        ? `Vous avez déjà manifesté votre intérêt pour ${machines(active)} de ce lot : c'est le maximum par personne (${cap}).`
        : `Vous en demandez ${requested}, mais il ne vous reste que ${machines(left)} sur ce lot (maximum ${cap} par personne).`,
    );
  }
  return null;
}

/**
 * Configuration d'une wishlist modifiable : seulement pendant le sondage, et wishlist non convertie
 * en commande payée. Retour arrière en brouillon : modification suspendue jusqu'à la republication.
 * Dès la précommande la configuration est figée (la base refuse aussi : Wishlist_configuration_frozen) ;
 * le retrait reste possible.
 */
export function wishlistEditBlocker(status: BatchStatus, converted: boolean): ApiError | null {
  if (converted) {
    return new ApiError(409, "wishlist_converted", "Cette manifestation d'intérêt est devenue une commande : elle ne se modifie plus.");
  }
  switch (status) {
    case "survey":
      return null;
    case "draft":
      return new ApiError(409, "wishlist_not_editable", "Ce lot n'est plus publié : la configuration ne peut pas être modifiée pour l'instant.");
    case "closed":
    case "cancelled":
      return new ApiError(409, "wishlist_not_editable", `Ce lot est ${status === "closed" ? "clôturé" : "annulé"} : la configuration ne se modifie plus.`);
    default:
      return new ApiError(
        409,
        "wishlist_not_editable",
        `Le sondage de ce lot est terminé (statut « ${BATCH_STATUS_LABELS[status]} ») : la configuration de votre manifestation d'intérêt ne se modifie plus. Vous pouvez encore la retirer.`,
      );
  }
}

/**
 * Retrait refusé d'une wishlist convertie en commande payée : on renonce à la machine par
 * le renoncement à la commande (décision Hugo 2026-10-07). Non convertie : retrait permis à tout
 * statut du lot (y compris avec une facture en attente, qui n'est pas une conversion).
 */
export function wishlistCancelBlocker(converted: boolean): ApiError | null {
  if (!converted) return null;
  const { status, code, message } = WISHLIST_CONVERTED_CANCEL;
  return new ApiError(status, code, message);
}

/**
 * Prix de revente actuel du lot (machine nue) à afficher à côté de l'instantané d'une wishlist :
 * seulement tant que la configuration est modifiable (au sondage). Après, la configuration est
 * figée et le prix actuel du lot n'a plus de sens pour elle : `null`.
 */
export function currentResalePrice(editable: boolean, price: bigint | null): string | null {
  return editable && price !== null ? bigintToJson(price) : null;
}

// ─── Lecture ───

/** Ligne qui convertit une wishlist : non remboursée, d'une commande payée (au plus une, garantie en base). */
const convertingLine = { refund_id: null, order: { status: "paid" } } satisfies Prisma.OrderLineWhereInput;

const wishlistInclude = {
  batch: {
    select: { id: true, name: true, status: true, resale_unit_price: true, model: { select: { id: true, name: true } } },
  },
  configuration: {
    include: {
      items: {
        include: {
          option: { select: { title: true, position: true } },
          option_value: { select: { label: true, is_default: true } },
        },
      },
    },
  },
  order_lines: { where: convertingLine, select: { id: true, order_id: true }, take: 1 },
  // Options retirées du lot que la wishlist avait choisies (journal écrit par la base)
  option_withdrawals: {
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    include: {
      withdrawn_value: { select: { label: true, option: { select: { title: true } } } },
      default_value: { select: { label: true } },
    },
  },
} satisfies Prisma.WishlistInclude;

type WishlistRow = Prisma.WishlistGetPayload<{ include: typeof wishlistInclude }>;

/** Règles du lot lues en base : visibilité publique, commandes ouvertes (batch_accepts_orders), fin de la journée de priorité. */
type BatchFlags = { isPublic: boolean; acceptsOrders: boolean; priorityEndsAt: Date | null };

async function loadBatchFlags(db: Db, batchIds: string[]): Promise<Map<string, BatchFlags>> {
  if (batchIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ id: string; is_public: boolean; accepts_orders: boolean; priority_ends_at: Date | null }[]>`
    SELECT b."id", coalesce("batch_is_public"(b."status"), false) AS "is_public",
      coalesce("batch_accepts_orders"(b."status"), false) AS "accepts_orders",
      "batch_priority_ends_at"(b."id") AS "priority_ends_at"
    FROM "Batch" b WHERE b."id" = ANY(${[...new Set(batchIds)]}::uuid[])`;
  return new Map(
    rows.map((r) => [r.id, { isPublic: r.is_public, acceptsOrders: r.accepts_orders, priorityEndsAt: r.priority_ends_at }]),
  );
}

/** Valeurs d'option que chaque lot propose encore (batch_offered_values), pour repérer un choix devenu obsolète. */
async function loadOfferedValueIds(db: Db, batchIds: string[]): Promise<Map<string, Set<string>>> {
  const offered = new Map<string, Set<string>>();
  if (batchIds.length === 0) return offered;
  const rows = await db.$queryRaw<{ batch_id: string; option_value_id: string }[]>`
    SELECT b."id" AS "batch_id", ov."option_value_id"
    FROM "Batch" b CROSS JOIN LATERAL "batch_offered_values"(b."id") ov
    WHERE b."id" = ANY(${[...new Set(batchIds)]}::uuid[])`;
  for (const r of rows) {
    if (!offered.has(r.batch_id)) offered.set(r.batch_id, new Set());
    offered.get(r.batch_id)!.add(r.option_value_id);
  }
  return offered;
}

async function wishlistsDto(db: Db, rows: WishlistRow[]) {
  const batchIds = rows.map((w) => w.batch_id);
  const [flags, offered] = await Promise.all([loadBatchFlags(db, batchIds), loadOfferedValueIds(db, batchIds)]);
  return rows.map((w) => wishlistDto(w, flags.get(w.batch_id)!, offered.get(w.batch_id) ?? new Set()));
}

function wishlistDto(w: WishlistRow, flags: BatchFlags, offered: ReadonlySet<string>) {
  const c = w.configuration;
  const items = [...c.items]
    .sort((a, b) => a.option.position - b.option.position || a.option.title.localeCompare(b.option.title))
    .map((i) => ({
      optionId: i.option_id,
      optionTitle: i.option.title,
      optionValueId: i.option_value_id,
      label: i.option_value.label,
      isDefault: i.option_value.is_default,
      unitPrice: bigintToJson(i.unit_price),
      /** Le lot propose encore cette valeur (batch_offered_values) ; faux : choix obsolète, prix périmé */
      offered: offered.has(i.option_value_id),
    }));
  const converted = w.order_lines.length > 0;
  const editable = wishlistEditBlocker(w.batch.status, converted) === null;
  return {
    id: w.id,
    createdAt: w.created_at.toISOString(),
    /** Dernière modification de la configuration (choix ou prix de base), tenue par la base */
    updatedAt: c.updated_at.toISOString(),
    batch: {
      id: w.batch.id,
      /** Nom du lot, toujours renseigné (nom choisi, sinon « {quantité} {modèle} ») */
      name: w.batch.name,
      status: w.batch.status,
      statusLabel: BATCH_STATUS_LABELS[w.batch.status],
      /** Fiche du lot visible par le public (batch_is_public) */
      isPublic: flags.isPublic,
      /** Le lot accepte des commandes (batch_accepts_orders) : « Commander » reprend les machines souhaitées */
      acceptsOrders: flags.acceptsOrders,
      /**
       * Fin de la journée de priorité (batch_priority_ends_at, null : aucune). Retirer la wishlist
       * avant cette date fait perdre la priorité pour cette machine.
       */
      priorityEndsAt: flags.priorityEndsAt?.toISOString() ?? null,
      model: w.batch.model,
    },
    /** Prix de revente de la machine nue au moment de la configuration, centimes */
    basePrice: bigintToJson(c.base_price),
    /** Un item par menu visible du lot, défaut (« Sans », 0 €) compris ; aucun pour un menu masqué */
    items,
    /** Prix de la machine configurée (indicatif, aucun paiement) */
    amount: bigintToJson(c.items.reduce((sum, i) => sum + i.unit_price, c.base_price)),
    /** Prix de revente actuel du lot (machine nue, centimes), au sondage seulement ; sinon null */
    resaleUnitPrice: currentResalePrice(editable, w.batch.resale_unit_price),
    converted,
    /** Facture payée qui a converti cette machine (lien « Voir la commande »), sinon null */
    orderId: w.order_lines[0]?.order_id ?? null,
    editable,
    /** Au moins un choix n'est plus proposé par le lot : le prix affiché n'est plus d'actualité */
    outdated: items.some((i) => !i.offered),
    /**
     * Options retirées du lot après avoir été choisies (sondage compris) : la configuration est revenue
     * au défaut du menu (0 €), la wishlist et sa priorité restent. À annoncer à l'utilisateur
     */
    optionWithdrawals: w.option_withdrawals.map((o) => ({
      optionId: o.option_id,
      optionTitle: o.withdrawn_value.option.title,
      withdrawnValueId: o.withdrawn_value_id,
      withdrawnValueLabel: o.withdrawn_value.label,
      /** Prix figé de la valeur retirée dans la configuration, centimes */
      withdrawnUnitPrice: bigintToJson(o.withdrawn_unit_price),
      defaultValueId: o.default_value_id,
      defaultValueLabel: o.default_value.label,
      createdAt: o.created_at.toISOString(),
    })),
  };
}

/** Wishlists actives de l'utilisateur (option : d'un lot), de la plus récente à la plus ancienne. */
export async function listWishlists(userId: string, query: z.output<typeof wishlistListQuery>) {
  const db = getDb();
  const rows = await db.wishlist.findMany({
    where: { user_id: userId, cancelled_at: null, ...(query.batchId ? { batch_id: query.batchId } : {}) },
    include: wishlistInclude,
    orderBy: [{ created_at: "desc" }, { id: "asc" }],
  });
  return { items: await wishlistsDto(db, rows) };
}

async function findOwnWishlist(db: Db, userId: string, wishlistId: string) {
  const row = await db.wishlist.findFirst({
    where: { id: wishlistId, user_id: userId, cancelled_at: null },
    include: wishlistInclude,
  });
  if (!row) throw wishlistNotFound();
  return row;
}

/**
 * Une wishlist de l'utilisateur, avec l'offre actuelle du lot pour modifier la configuration :
 * `options` (mêmes champs que la fiche produit publique), `null` si elle n'est pas modifiable (hors
 * sondage). `resaleUnitPrice` (prix actuel, base du total indicatif) est dans l'objet Wishlist.
 */
export async function getWishlist(userId: string, wishlistId: string) {
  const db = getDb();
  const [dto] = await wishlistsDto(db, [await findOwnWishlist(db, userId, wishlistId)]);
  return {
    ...dto,
    options: dto.editable ? publicOptionsDto(await loadBatchOffer(db, dto.batch.id)) : null,
  };
}

// ─── Écriture ───

/**
 * Crée `quantity` wishlists de même configuration (une configuration par machine) sur un lot au
 * sondage. Verrou de l'utilisateur (FOR NO KEY UPDATE) : deux créations simultanées du même
 * utilisateur se suivent et le plafond est compté sur les données validées. Verrou partagé du lot
 * (FOR SHARE) : attend une transition ou un masquage concurrents, puis relit le statut.
 */
export async function createWishlists(userId: string, input: z.output<typeof wishlistInput>) {
  const ids = await getDb().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId}::uuid FOR NO KEY UPDATE`;
    const [batch] = await tx.$queryRaw<{ status: BatchStatus; quantity: number }[]>`
      SELECT "status"::text AS "status", "quantity" FROM "Batch" WHERE "id" = ${input.batchId}::uuid FOR SHARE`;
    // Brouillon : invisible, comme un lot inconnu
    if (!batch || batch.status === "draft") throw batchNotFound();
    const active = await tx.wishlist.count({ where: { user_id: userId, batch_id: input.batchId, cancelled_at: null } });
    const refused = checkWishlistCreation(batch.status, {
      active,
      requested: input.quantity,
      cap: wishlistCap((await readShopSettings(tx)).wishlistMaxPerUserPerBatch, batch.quantity),
    });
    if (refused) throw refused;

    const snapshot = await snapshotConfiguration(tx, input.batchId, input.choices);
    const created: string[] = [];
    for (let i = 0; i < input.quantity; i++) {
      const configurationId = await createConfiguration(tx, input.batchId, snapshot);
      const wishlist = await tx.wishlist.create({
        data: { user_id: userId, batch_id: input.batchId, configuration_id: configurationId },
        select: { id: true },
      });
      created.push(wishlist.id);
    }
    return created;
  });
  const db = getDb();
  const rows = await db.wishlist.findMany({
    where: { id: { in: ids } },
    include: wishlistInclude,
    orderBy: [{ created_at: "desc" }, { id: "asc" }],
  });
  return { items: await wishlistsDto(db, rows) };
}

/**
 * Verrouille la wishlist de l'utilisateur (retirée ou non) ; 404 si elle n'existe pas ou est à un
 * autre utilisateur, avant tout autre contrôle. FOR NO KEY UPDATE (aucune colonne de clé ne change) :
 * sérialise modifications et retraits de la wishlist sans bloquer la clé étrangère d'une ligne de
 * commande (FOR KEY SHARE), ce qui évite un interblocage avec une facture qui tient le verrou du lot.
 */
async function lockOwnWishlist(tx: Tx, userId: string, wishlistId: string) {
  const [row] = await tx.$queryRaw<{ batch_id: string; configuration_id: string; cancelled: boolean }[]>`
    SELECT "batch_id", "configuration_id", "cancelled_at" IS NOT NULL AS "cancelled"
    FROM "Wishlist" WHERE "id" = ${wishlistId}::uuid AND "user_id" = ${userId}::uuid FOR NO KEY UPDATE`;
  if (!row) throw wishlistNotFound();
  return row;
}

async function isConverted(tx: Tx, wishlistId: string) {
  return (await tx.orderLine.count({ where: { wishlist_id: wishlistId, ...convertingLine } })) > 0;
}

/**
 * Nouvelle configuration de la wishlist : nouvel instantané (prix de revente et options relus).
 * Sous verrou de la wishlist ; le statut du lot est relu sous verrou partagé (snapshotConfiguration).
 */
export async function updateWishlist(userId: string, wishlistId: string, patch: z.output<typeof wishlistPatch>) {
  await getDb().$transaction(async (tx) => {
    const row = await lockOwnWishlist(tx, userId, wishlistId);
    if (row.cancelled) throw wishlistNotFound();
    const [batch] = await tx.$queryRaw<{ status: BatchStatus }[]>`
      SELECT "status"::text AS "status" FROM "Batch" WHERE "id" = ${row.batch_id}::uuid FOR KEY SHARE`;
    const blocker = wishlistEditBlocker(batch.status, await isConverted(tx, wishlistId));
    if (blocker) throw blocker;
    await replaceConfiguration(tx, row.configuration_id, row.batch_id, patch.choices);
  });
  return getWishlist(userId, wishlistId);
}

/**
 * Retire la wishlist (cancelled_at), à tout statut du lot. Ordre des contrôles : 404 (inconnue ou
 * d'un autre utilisateur), puis déjà retirée → sans effet (idempotent), puis convertie → 409.
 * Verrous : la wishlist, puis le lot FOR SHARE, en conflit avec le verrou que la conversion prend au
 * COMMIT (Order_check > Batch_lock) : une conversion concurrente est soit vue (409), soit postérieure
 * au retrait. Même verrou et même règle dans le trigger Wishlist_guard_converted.
 */
export async function cancelWishlist(userId: string, wishlistId: string) {
  await getDb().$transaction(async (tx) => {
    const row = await lockOwnWishlist(tx, userId, wishlistId);
    if (row.cancelled) return;
    await tx.$queryRaw`SELECT 1 FROM "Batch" WHERE "id" = ${row.batch_id}::uuid FOR SHARE`;
    const blocker = wishlistCancelBlocker(await isConverted(tx, wishlistId));
    if (blocker) throw blocker;
    await tx.$executeRaw`UPDATE "Wishlist" SET "cancelled_at" = now() WHERE "id" = ${wishlistId}::uuid`;
  });
}
