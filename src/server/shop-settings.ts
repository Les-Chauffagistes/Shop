import type { Prisma } from "../../prisma/generated/client";
import type { getDb } from "./db";

/**
 * Réglages de la boutique (table ShopSettings, une ligne, imposés par la base) : plafond de
 * wishlists, machines par facture, délai et blocage après abandon. Pas d'écran ni de variable
 * d'environnement (décision du jalon 4) : la base est la source unique, relue à chaque usage.
 */

type Db = Prisma.TransactionClient | ReturnType<typeof getDb>;

export type ShopSettings = {
  wishlistMaxPerUserPerBatch: number;
  orderMaxLines: number;
  abandonedOrderCooldownMinutes: number;
  abandonedOrderLimit: number;
  abandonedOrderWindowHours: number;
};

/** Lit les réglages via `shop_settings()` (erreur ShopSettings_required si la ligne manque). */
export async function readShopSettings(db: Db): Promise<ShopSettings> {
  const [s] = await db.$queryRaw<
    {
      wishlist_max_per_user_per_batch: number;
      order_max_lines: number;
      abandoned_order_cooldown_minutes: number;
      abandoned_order_limit: number;
      abandoned_order_window_hours: number;
    }[]
  >`SELECT "wishlist_max_per_user_per_batch", "order_max_lines", "abandoned_order_cooldown_minutes",
           "abandoned_order_limit", "abandoned_order_window_hours"
    FROM "shop_settings"()`;
  return {
    wishlistMaxPerUserPerBatch: s.wishlist_max_per_user_per_batch,
    orderMaxLines: s.order_max_lines,
    abandonedOrderCooldownMinutes: s.abandoned_order_cooldown_minutes,
    abandonedOrderLimit: s.abandoned_order_limit,
    abandonedOrderWindowHours: s.abandoned_order_window_hours,
  };
}
