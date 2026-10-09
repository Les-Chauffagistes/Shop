import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";

/**
 * Données client créées directement en base pour les parcours du backoffice : les écrans
 * clients (manifestation d'intérêt : e2e/shop.spec.ts ; facture : jalon 4) ne servent pas ici.
 * Les règles de la base (configuration complète, une facture vivante par client et par lot,
 * journée de priorité, prix figés) s'appliquent comme pour l'application.
 */

/** Clients du seed (prisma/seed.ts), avec leur adresse. */
export const SEED_USERS = {
  alice: { id: "5e1d0000-0000-4000-8000-000000000401", addressId: "5e1d0000-0000-4000-8000-000000000501" },
  bob: { id: "5e1d0000-0000-4000-8000-000000000402", addressId: "5e1d0000-0000-4000-8000-000000000502" },
} as const;

export type Choice = { optionId: string; optionValueId: string; unitPrice: string };

/** Montant attendu en sats des factures créées par les parcours (taux sans importance ici). */
const E2E_EXPECTED_SATS = "100000";

/** E-mail de contact des factures créées par les parcours (obligatoire à la création depuis la v5k). */
const E2E_CONTACT_EMAIL = "client-e2e@exemple.fr";

async function withTransaction<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

/** Configuration complète (un choix par menu visible) ; renvoie son id et son total en centimes. */
async function createConfiguration(client: Client, batchId: string, choices: Choice[]) {
  const { rows } = await client.query<{ id: string; model_id: string; base_price: string }>(
    `INSERT INTO "Configuration" (batch_id, model_id, base_price)
     SELECT id, model_id, resale_unit_price FROM "Batch" WHERE id = $1
     RETURNING id, model_id, base_price::text`,
    [batchId],
  );
  const config = rows[0];
  for (const c of choices) {
    await client.query(
      `INSERT INTO "ConfigurationItem" (configuration_id, model_id, option_id, option_value_id, unit_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [config.id, config.model_id, c.optionId, c.optionValueId, c.unitPrice],
    );
  }
  const total = choices.reduce((sum, c) => sum + BigInt(c.unitPrice), BigInt(config.base_price));
  return { id: config.id, total };
}

/** Manifestation d'intérêt d'un client du seed (lot au sondage). */
export async function addWishlist(batchId: string, user: keyof typeof SEED_USERS, choices: Choice[]) {
  await withTransaction(async (client) => {
    const config = await createConfiguration(client, batchId, choices);
    await client.query(`INSERT INTO "Wishlist" (user_id, batch_id, configuration_id) VALUES ($1, $2, $3)`, [
      SEED_USERS[user].id,
      batchId,
      config.id,
    ]);
  });
}

/**
 * Convertit une manifestation d'intérêt en commande payée (lot en précommande ou après) : facture
 * d'une ligne reprenant sa configuration (copiée) et la wishlist, puis payée. Une adresse est créée
 * pour le client (utilisateur quelconque, pas seulement ceux du seed).
 */
export async function convertWishlist(wishlistId: string) {
  await withTransaction(async (client) => {
    const { rows: wishlists } = await client.query<{ user_id: string; batch_id: string; configuration_id: string }>(
      `SELECT user_id, batch_id, configuration_id FROM "Wishlist" WHERE id = $1`,
      [wishlistId],
    );
    const w = wishlists[0];
    const { rows: addresses } = await client.query<{ id: string }>(
      `INSERT INTO "Address" (user_id, full_name, line1, postal_code, city, country)
       VALUES ($1, 'Client e2e', '1 rue du Test', '75001', 'Paris', 'FR') RETURNING id`,
      [w.user_id],
    );
    const { rows: configs } = await client.query<{ id: string; model_id: string; base_price: string }>(
      `INSERT INTO "Configuration" (batch_id, model_id, base_price)
       SELECT batch_id, model_id, base_price FROM "Configuration" WHERE id = $1
       RETURNING id, model_id, base_price::text`,
      [w.configuration_id],
    );
    const config = configs[0];
    await client.query(
      `INSERT INTO "ConfigurationItem" (configuration_id, model_id, option_id, option_value_id, unit_price)
       SELECT $1, model_id, option_id, option_value_id, unit_price FROM "ConfigurationItem" WHERE configuration_id = $2`,
      [config.id, w.configuration_id],
    );
    const { rows: totals } = await client.query<{ total: string }>(
      `SELECT ($1::bigint + COALESCE(SUM(unit_price), 0))::text AS total FROM "ConfigurationItem" WHERE configuration_id = $2`,
      [config.base_price, config.id],
    );
    const total = totals[0].total;
    const address = `bc1qe2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const { rows: orders } = await client.query<{ id: string }>(
      `INSERT INTO "Order" (user_id, batch_id, billing_address_id, shipping_address_id, total_amount, expected_sats, payment_address,
         contact_email)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7) RETURNING id`,
      [w.user_id, w.batch_id, addresses[0].id, total, E2E_EXPECTED_SATS, address, E2E_CONTACT_EMAIL],
    );
    await client.query(
      `INSERT INTO "OrderLine" (order_id, user_id, batch_id, configuration_id, wishlist_id, amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orders[0].id, w.user_id, w.batch_id, config.id, wishlistId, total],
    );
    // Paiement reçu (journal Payment : la base tient received_sats), puis accepté
    await client.query(`INSERT INTO "Payment" (order_id, amount_sats, txid, vout) VALUES ($1, $2, $3, 0)`, [
      orders[0].id,
      E2E_EXPECTED_SATS,
      `e2e-${orders[0].id}`,
    ]);
    await client.query(`UPDATE "Order" SET status = 'paid', paid_at = now() WHERE id = $1`, [orders[0].id]);
  });
}

/** Facture en attente (réserve une machine 30 min) d'un client du seed, une ligne. */
export async function addPendingOrder(batchId: string, user: keyof typeof SEED_USERS, choices: Choice[]) {
  await withTransaction(async (client) => {
    const config = await createConfiguration(client, batchId, choices);
    const { id: userId, addressId } = SEED_USERS[user];
    const address = `bc1qe2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO "Order" (user_id, batch_id, billing_address_id, shipping_address_id, total_amount, expected_sats, payment_address,
         contact_email)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, batchId, addressId, config.total.toString(), E2E_EXPECTED_SATS, address, E2E_CONTACT_EMAIL],
    );
    await client.query(
      `INSERT INTO "OrderLine" (order_id, user_id, batch_id, configuration_id, amount) VALUES ($1, $2, $3, $4, $5)`,
      [rows[0].id, userId, batchId, config.id, config.total.toString()],
    );
  });
}

/** Utilisateur local d'un identifiant auth-service (créé s'il n'existe pas encore). */
async function ensureUser(client: Client, authUserId: string): Promise<string> {
  await client.query(`INSERT INTO "User" (auth_user_id) VALUES ($1) ON CONFLICT (auth_user_id) DO NOTHING`, [authUserId]);
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM "User" WHERE auth_user_id = $1`, [authUserId]);
  return rows[0].id;
}

/**
 * Facture d'une machine déjà expirée (réservation terminée il y a `minutesAgo` minutes), antidatée
 * comme le font les tests d'intégration : le délai de 30 min ne s'attend pas dans un parcours. Lot
 * SANS menu d'options (configuration vide). Renvoie l'id et l'adresse de paiement (pour un versement
 * simulé par `POST /api/internal/payments`).
 */
export async function insertExpiredOrder(
  batchId: string,
  authUserId: string,
  { minutesAgo = 1, expectedSats = "100000" }: { minutesAgo?: number; expectedSats?: string } = {},
) {
  return withTransaction(async (client) => {
    const userId = await ensureUser(client, authUserId);
    const { rows: addresses } = await client.query<{ id: string }>(
      `INSERT INTO "Address" (user_id, full_name, line1, postal_code, city, country)
       VALUES ($1, 'Client e2e', '1 rue du Test', '75001', 'Paris', 'FR') RETURNING id`,
      [userId],
    );
    const config = await createConfiguration(client, batchId, []);
    const address = `bc1qe2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO "Order" (user_id, batch_id, billing_address_id, shipping_address_id, total_amount, expected_sats,
         payment_address, created_at, expires_at, contact_email)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        userId,
        batchId,
        addresses[0].id,
        config.total.toString(),
        expectedSats,
        address,
        new Date(now - (minutesAgo + 30) * 60_000),
        new Date(now - minutesAgo * 60_000),
        E2E_CONTACT_EMAIL,
      ],
    );
    await client.query(
      `INSERT INTO "OrderLine" (order_id, user_id, batch_id, configuration_id, amount) VALUES ($1, $2, $3, $4, $5)`,
      [rows[0].id, userId, batchId, config.id, config.total.toString()],
    );
    return { orderId: rows[0].id, paymentAddress: address };
  });
}

/**
 * Bloque un client sur un lot : trois factures abandonnées (expirées sans paiement) dans les dernières
 * 24 h, espacées de plus que le délai après abandon (Order_abandoned_limit). Lot sans menu d'options.
 */
export async function blockCustomer(batchId: string, authUserId: string) {
  for (const minutesAgo of [180, 120, 60]) await insertExpiredOrder(batchId, authUserId, { minutesAgo });
}

/** Retire une valeur d'option d'un lot publié (comme « Retirer du lot » dans le formulaire, sans passer par l'écran). */
export async function retireOptionValue(batchId: string, optionValueId: string) {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE "BatchOptionValue" SET enabled = false WHERE batch_id = $1 AND option_value_id = $2`,
      [batchId, optionValueId],
    );
    if (rowCount !== 1) throw new Error("retireOptionValue: valeur d'option absente du lot");
  });
}
