import type { BatchKind, BatchStatus } from "../../prisma/generated/client";
import { publicStatusLabel } from "./batch-status";
import { batchNotFound } from "./batches";
import { loadBatchOffer, publicOptionsDto } from "./configurations";
import { getDb } from "./db";
import { bigintToJson } from "./http";
import { readShopSettings } from "./shop-settings";
import { wishlistCap } from "./wishlists";

/**
 * Boutique publique (sans connexion) : lots visibles du public, règle de la base `batch_is_public`
 * (sondage, puis Précommande à Packaging, quand le lot accepte des commandes ; lot de stock en vente). N'expose que
 * le nom du lot, son type, le modèle, la quantité disponible, le prix de revente unitaire, les options proposées, et
 * les règles publiques de commande ; jamais le prix d'achat, les compteurs ni les réglages internes.
 * Lot de stock : libellé « En stock », pas de priorité ni de manifestation d'intérêt, disponible = machines
 * vendables non vendues (batch_available_stock, capacité du stock).
 */

type PublicBatchRow = {
  id: string;
  name: string;
  kind: BatchKind;
  status: BatchStatus;
  quantity: number | null;
  resale_unit_price: bigint;
  available_stock: number;
  accepts_orders: boolean;
  priority_ends_at: Date | null;
  model_id: string;
  model_name: string;
  hashrate: bigint;
  model_description: string | null;
};

async function loadPublicBatches(batchId?: string): Promise<PublicBatchRow[]> {
  const db = getDb();
  return db.$queryRaw<PublicBatchRow[]>`
    SELECT b."id", b."name", b."kind"::text AS "kind", b."status"::text AS "status", b."quantity", b."resale_unit_price",
      "batch_available_stock"(b."id") AS "available_stock",
      coalesce("batch_accepts_orders"(b."status"), false) AS "accepts_orders",
      "batch_priority_ends_at"(b."id") AS "priority_ends_at",
      m."id" AS "model_id", m."name" AS "model_name", m."hashrate", m."description" AS "model_description"
    FROM "Batch" b JOIN "Model" m ON m."id" = b."model_id"
    WHERE coalesce("batch_is_public"(b."status"), false)
      AND (${batchId ?? null}::uuid IS NULL OR b."id" = ${batchId ?? null}::uuid)
    ORDER BY b."created_at" DESC, b."id"`;
}

function publicBatchDto(r: PublicBatchRow) {
  return {
    id: r.id,
    /** Nom du lot, toujours renseigné (par défaut « {quantité} {modèle} », fixé par l'admin sinon) */
    name: r.name,
    /** wholesale (palette, cycle sondage → précommande) ou stock (machines en main, commande directe) */
    kind: r.kind,
    status: r.status,
    /** Libellé public : « En stock » pour un lot de stock, le statut sinon */
    statusLabel: publicStatusLabel(r.kind, r.status),
    model: { id: r.model_id, name: r.model_name, hashrate: bigintToJson(r.hashrate), description: r.model_description },
    /** Machines encore disponibles sur le lot (jamais négatif à l'affichage) */
    availableQuantity: Math.max(0, r.available_stock),
    /** Prix de revente unitaire de la machine nue, centimes */
    resaleUnitPrice: bigintToJson(r.resale_unit_price),
    /** Le lot accepte des commandes (palette de la Précommande au Packaging, lot de stock en vente) */
    acceptsOrders: r.accepts_orders,
    /**
     * Fin de la journée de priorité (réservée aux personnes ayant manifesté leur intérêt), null s'il
     * n'y en a pas. Peut être passée : comparer à l'heure courante.
     */
    priorityEndsAt: r.priority_ends_at?.toISOString() ?? null,
  };
}

/** Lots visibles par le public, du plus récent au plus ancien. */
export async function listPublicBatches() {
  return { items: (await loadPublicBatches()).map(publicBatchDto) };
}

/**
 * Offre de stock pour le même modèle : lot de stock public, en vente, avec au moins une machine vendable.
 * Null pour un lot de stock lui-même ou si rien n'est disponible. Sert à renvoyer le visiteur d'un lot épuisé.
 */
async function findStockOffer(modelId: string, kind: BatchKind) {
  if (kind === "stock") return null;
  const [row] = await getDb().$queryRaw<{ id: string; name: string; available: number }[]>`
    SELECT b."id", b."name", "batch_available_stock"(b."id") AS "available"
    FROM "Batch" b
    WHERE b."model_id" = ${modelId}::uuid AND b."kind" = 'stock'
      AND coalesce("batch_is_public"(b."status"), false) AND coalesce("batch_accepts_orders"(b."status"), false)
      AND "batch_available_stock"(b."id") > 0
    ORDER BY b."created_at" DESC, b."id" LIMIT 1`;
  return row ? { batchId: row.id, name: row.name, availableQuantity: row.available } : null;
}

/** Fiche produit d'un lot visible ; 404 batch_not_found pour un lot inconnu ou non public. */
export async function getPublicBatch(batchId: string) {
  const [row] = await loadPublicBatches(batchId);
  if (!row) throw batchNotFound();
  const db = getDb();
  const settings = await readShopSettings(db);
  return {
    ...publicBatchDto(row),
    /** Plafond effectif de wishlists actives par utilisateur sur ce lot (le même pour tous) ; 0 pour un lot de stock */
    wishlistLimit: wishlistCap(settings.wishlistMaxPerUserPerBatch, row.quantity),
    /** Machines au plus par facture (ShopSettings.order_max_lines) */
    maxMachinesPerOrder: settings.orderMaxLines,
    /**
     * Lot de stock vendable du même modèle ({ batchId, name, availableQuantity }), sinon null (toujours null pour un
     * lot de stock) : la fiche d'un lot épuisé y renvoie (« Disponible en stock »).
     */
    stockOffer: await findStockOffer(row.model_id, row.kind),
    options: publicOptionsDto(await loadBatchOffer(db, batchId)),
  };
}
