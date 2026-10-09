import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL as baseURL, E2E_PORT as port, e2eAppEnv } from "./e2e/support/env";

// Port dédié : ne réutilise jamais un `next dev` lancé à la main avec une autre configuration.

export default defineConfig({
  testDir: "./e2e",
  // Scénarios d'exploration laissés par les testeurs (journaux sans assertion, attentes de 30 min en temps
  // réel, serveur et configuration propres) : conservés, jamais lancés par `npm run e2e`. Les scénarios
  // stables sont promus dans e2e/*.spec.ts.
  testIgnore: ["**/customer/**", "**/logistician/**"],
  outputDir: "./e2e/.results",
  reporter: [["list"]],
  globalSetup: "./e2e/support/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, grepInvert: /@db-down/ },
    // Coupe la base des parcours : lancé seul, une fois tous les autres terminés
    { name: "db-down", use: { ...devices["Desktop Chrome"] }, grep: /@db-down/, dependencies: ["chromium"] },
  ],
  // Démarre l'app (base `_e2e`, secret JWT et whitelist de test) si E2E_BASE_URL n'est pas fourni
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next dev --port ${port}`,
        url: `${baseURL}/favicon.ico`,
        env: e2eAppEnv,
        reuseExistingServer: false,
        timeout: 180_000,
      },
});
