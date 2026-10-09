// Environnement des tests d'intégration (sans effet de bord : importé par vitest.config.ts).
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgresql://postgres:postgres@localhost:5441/shop_test";

// Garde-fou : on ne vide jamais autre chose qu'une base dont le nom finit par _test.
if (!/\/[^/?]*_test(\?|$)/.test(TEST_DATABASE_URL)) {
  throw new Error("DATABASE_URL_TEST must point to a database whose name ends with _test");
}

/** Secret de test (les jetons des tests sont signés avec). */
export const TEST_JWT_SECRET = "integration-test-secret-not-for-production";

/** Secret du point d'entrée interne de paiement pendant les tests (POST /api/internal/payments). */
export const TEST_PAYMENT_SECRET = "integration-payment-secret";

/** Variables vues par l'application (src/server/config.ts) pendant les tests d'intégration. */
export const integrationEnv = {
  PAYMENT_WEBHOOK_SECRET: TEST_PAYMENT_SECRET,
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: TEST_JWT_SECRET,
  BACKOFFICE_USER_IDS: "1",
  AUTH_API_URL: "http://auth.test",
  AUTH_FRONT_URL: "http://login.test",
};
