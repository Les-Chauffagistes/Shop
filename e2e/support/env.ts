// Environnement des parcours Playwright (importé par playwright.config.ts, sans effet de bord).

/** Base dédiée aux parcours, sur le conteneur jetable `db-test` (docker-compose.yml). */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5441/shop_e2e";

if (!/\/[^/?]*_e2e(\?|$)/.test(E2E_DATABASE_URL)) {
  throw new Error("E2E_DATABASE_URL must point to a database whose name ends with _e2e");
}

/** Secret de test : l'app lancée pour les parcours vérifie les jetons forgés avec. */
export const E2E_JWT_SECRET = "e2e-test-secret-not-for-production";

/** Identifiants auth-service : un admin de la whitelist, un utilisateur connecté hors whitelist. */
export const ADMIN_AUTH_USER_ID = "1";
export const OUTSIDER_AUTH_USER_ID = "2";

export const AUTH_FRONT_URL = "http://login.test";

/** Port et URL de l'application pendant les parcours (playwright.config.ts). */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;

/** Secret du point d'entrée interne de paiement simulé (POST /api/internal/payments) pendant les parcours. */
export const E2E_PAYMENT_SECRET = "e2e-payment-secret-not-for-production";

/** Variables vues par l'application (src/server/config.ts) pendant les parcours. */
export const e2eAppEnv = {
  PAYMENT_WEBHOOK_SECRET: E2E_PAYMENT_SECRET,
  DATABASE_URL: E2E_DATABASE_URL,
  JWT_SECRET: E2E_JWT_SECRET,
  BACKOFFICE_USER_IDS: ADMIN_AUTH_USER_ID,
  AUTH_API_URL: "http://auth.test",
  AUTH_FRONT_URL,
  PUBLIC_URL: E2E_BASE_URL,
};
