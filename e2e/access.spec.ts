import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { signIn } from "./support/auth";
import { AUTH_FRONT_URL, E2E_DATABASE_URL, OUTSIDER_AUTH_USER_ID } from "./support/env";

/**
 * Coupe la base des parcours pour l'application (connexions refusées, connexions ouvertes
 * fermées), le temps de `work`. Réservé au projet Playwright `db-down`, lancé seul après
 * tous les autres (playwright.config.ts) : les autres parcours ne voient jamais la coupure.
 */
async function withDatabaseDown(work: () => Promise<void>) {
  const database = new URL(E2E_DATABASE_URL).pathname.slice(1).replace(/"/g, "");
  const adminUrl = new URL(E2E_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`ALTER DATABASE "${database}" WITH ALLOW_CONNECTIONS false`);
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [
      database,
    ]);
    await work();
  } finally {
    await admin.query(`ALTER DATABASE "${database}" WITH ALLOW_CONNECTIONS true`);
    await admin.end();
  }
}

test.describe("Accès au backoffice", () => {
  test("un visiteur non connecté est envoyé vers la connexion, avec retour sur la page demandée", async ({ request, baseURL }) => {
    // auth-service front n'existe pas en test : on vérifie la redirection elle-même
    const response = await request.get("/backoffice/modeles", { maxRedirects: 0 });
    expect([303, 307, 308]).toContain(response.status());
    const location = new URL(response.headers()["location"]);
    expect(`${location.origin}${location.pathname}`).toBe(`${AUTH_FRONT_URL}/login`);
    expect(location.searchParams.get("redirect")).toBe(`${baseURL}/backoffice/modeles`);
  });

  test("l'adresse de retour ne se laisse pas détourner par un en-tête Host falsifié", async ({ request, baseURL }) => {
    const forged: Record<string, string>[] = [
      { "X-Forwarded-Host": "evil.test" },
      { "X-Forwarded-Host": "evil.test", "X-Forwarded-Proto": "https" },
    ];
    for (const headers of forged) {
      const response = await request.get("/backoffice/lots", { maxRedirects: 0, headers });
      const location = new URL(response.headers()["location"]);
      expect(location.searchParams.get("redirect")).toBe(`${baseURL}/backoffice/lots?statut=actifs`);
    }
  });

  test("un utilisateur connecté hors whitelist voit un refus d'accès, sans données ni navigation", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL!, OUTSIDER_AUTH_USER_ID, "curieux");
    const denied = await page.goto("/backoffice/lots");
    expect(denied?.status()).toBe(403); // vrai statut HTTP, pas une page d'erreur servie en 200
    await expect(page.getByRole("heading", { name: "Accès réservé" })).toBeVisible();
    await expect(page.getByText("Le compte « curieux » n'a pas accès au backoffice")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Backoffice" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Liste des lots" })).toHaveCount(0);

    // Les écritures sont refusées par l'API, indépendamment de l'interface
    const response = await page.request.post("/api/backoffice/parts", { data: { name: "Intrus" } });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  test(
    "base injoignable : page d'erreur en français avec « Réessayer », sans détail technique",
    { tag: "@db-down" },
    async ({ page, context, baseURL }) => {
      await signIn(context, baseURL!);
      await withDatabaseDown(async () => {
        await page.goto("/backoffice/lots");
        const heading = page.getByRole("heading", { level: 1, name: "Impossible d'afficher cette page" });
        await expect(heading).toBeVisible();
        await expect(page.getByText("Le serveur ou la base de données ne répond pas pour le moment.")).toBeVisible();
        const text = await page.locator(".bo").innerText();
        expect(text).not.toMatch(/prisma|postgres|ECONN|shop_e2e|stack|at \w+ \(|DriverAdapterError|database ".*"/i);
      });
      // Base revenue : « Réessayer » recharge la page demandée
      await page.getByRole("button", { name: "Réessayer" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Lots" })).toBeVisible();
    },
  );
});

