import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, request as playwrightRequest, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { forgeAccessToken, signIn, unique } from "./support/auth";
import { convertWishlist } from "./support/db";
import { AUTH_FRONT_URL } from "./support/env";

/**
 * Boutique publique et manifestations d'intérêt (jalon 3). Les lots sont préparés par l'API du
 * backoffice (admin) ; le client agit dans l'interface, connecté avec un jeton forgé comme celui
 * d'auth-service. Un identifiant client neuf par test : le plafond par personne repart de zéro.
 */

/** Montant tel qu'affiché (« 1 860,00 € » : milliers séparés par U+202F, espace insécable avant l'euro). */
const THIN_NBSP = String.fromCharCode(0x202f);
const NBSP = String.fromCharCode(0xa0);
const eur = (text: string) => `${text.replaceAll(" ", THIN_NBSP)}${NBSP}€`;

const newCustomerId = () => String(100_000 + Math.floor(Math.random() * 1_000_000_000));

async function adminApi(baseURL: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Cookie: `access_token=${await forgeAccessToken("1", "admin-e2e")}` },
  });
}

type Value = { id: string; label: string };

/**
 * Modèle avec deux menus (« Kit de ventilation » : Sans kit, Silent kit à 75 € ; « Nettoyage » : Avec/Sans
 * à 20 €) et un lot de 10 machines à 1 800 €, Silent kit dérogé à 60 €, conduit jusqu'à `path`.
 */
async function createBatch(api: APIRequestContext, path: string[] = ["survey"], extra: { name?: string } = {}) {
  const name = unique("S19 Pro");
  const model = await (
    await api.post("/api/backoffice/models", {
      data: { name, hashrate: "110000000000000", hashboardQtt: 3, description: "Antminer reconditionné" },
    })
  ).json();
  const kit = await (
    await api.post(`/api/backoffice/models/${model.id}/options`, {
      data: {
        kind: "choice",
        title: "Kit de ventilation",
        values: [
          { label: "Sans kit", price: "0" },
          { label: "Silent kit", price: "7500" },
        ],
      },
    })
  ).json();
  const cleaning = await (
    await api.post(`/api/backoffice/models/${model.id}/options`, { data: { kind: "toggle", title: "Nettoyage", price: "2000" } })
  ).json();
  const silent = (kit.values as Value[]).find((v) => v.label === "Silent kit")!;
  const response = await api.post("/api/backoffice/batches", {
    data: {
      modelId: model.id,
      quantity: 10,
      purchasePrice: "1500000",
      resaleUnitPrice: "180000",
      optionValues: [{ optionValueId: silent.id, priceOverride: "6000", maxQty: 3 }],
      ...extra,
    },
  });
  expect(response.status()).toBe(201);
  const batch = await response.json();
  let from = "draft";
  for (const to of path) {
    const note = to === "cancelled" ? "Lot abandonné (parcours)" : undefined;
    expect((await api.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to, from, note } })).status()).toBe(201);
    from = to;
  }
  return { id: batch.id as string, name: batch.name as string, modelName: name, kit, cleaning, silent };
}

/** La page de connexion d'auth-service n'existe pas en test : elle est simulée. */
async function stubLoginPage(page: Page) {
  await page.route(`${AUTH_FRONT_URL}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>Connexion</title><h1>Connexion</h1>" }),
  );
}

const choice = (page: Page, menu: string, value: RegExp) =>
  page.getByRole("group", { name: menu }).getByRole("radio", { name: value });

test("parcours nominal : découvrir un lot, se connecter, manifester son intérêt, modifier puis retirer", async ({
  page,
  context,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const batch = await createBatch(api);
  await stubLoginPage(page);

  // Visiteur : le lot est sur l'accueil, la fiche montre prix, quantité et options
  await page.goto("/");
  await page.getByRole("link", { name: batch.modelName }).click();
  await expect(page.getByRole("heading", { level: 1, name: batch.modelName })).toBeVisible();
  await expect(page.getByText(`10 ${batch.modelName}`, { exact: true })).toBeVisible(); // nom par défaut du lot
  await expect(page.getByText(eur("1 800,00")).first()).toBeVisible();
  await expect(page.getByText("10 machines")).toBeVisible();
  await expect(choice(page, "Kit de ventilation", /^Sans kit/)).toBeChecked();
  await expect(choice(page, "Kit de ventilation", /^Silent kit/)).toHaveAccessibleName(/\+ 60,00\s€/);
  await expect(choice(page, "Nettoyage", /^Sans/)).toBeChecked();

  await choice(page, "Kit de ventilation", /^Silent kit/).check();
  await expect(page.getByText(eur("1 860,00"))).toBeVisible();

  // Non connecté : envoi vers la connexion, retour sur la fiche avec la configuration
  await page.getByLabel("Nombre de machines").fill("2");
  await page.getByRole("button", { name: "Manifester mon intérêt" }).click();
  await page.waitForURL(`${AUTH_FRONT_URL}/**`);
  const back = new URL(new URL(page.url()).searchParams.get("redirect")!);
  expect(back.origin).toBe(new URL(baseURL!).origin);
  expect(back.pathname).toBe(`/lots/${batch.id}`);
  expect(back.searchParams.get("quantite")).toBe("2");

  await signIn(context, baseURL!, newCustomerId(), "client-e2e");
  await page.goto(back.toString());
  await expect(choice(page, "Kit de ventilation", /^Silent kit/)).toBeChecked();
  await expect(page.getByLabel("Nombre de machines")).toHaveValue("2");
  await expect(page.getByText(`Total pour 2 machines`)).toBeVisible();
  await expect(page.getByText(eur("3 720,00"))).toBeVisible();
  await page.getByRole("button", { name: "Manifester mon intérêt" }).click();
  await expect(page.getByRole("status").filter({ hasText: "votre intérêt pour 2 machines est enregistré" })).toBeFocused();
  await expect(page.getByText("Vous suivez déjà 2 machines de ce lot.")).toBeVisible();

  // Mes intérêts : deux machines configurées
  await page.getByRole("link", { name: "Voir mes intérêts" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Mes intérêts" })).toBeVisible();
  const lot = page.getByRole("region", { name: new RegExp(batch.modelName) });
  await expect(lot.getByText("2 machines souhaitées")).toBeVisible();
  await expect(lot.getByText("Kit de ventilation : Silent kit")).toHaveCount(2);

  // Modifier la première : ajouter le nettoyage
  await lot.getByRole("link", { name: `Modifier ${batch.name}, machine n° 1` }).click();
  await expect(choice(page, "Kit de ventilation", /^Silent kit/)).toBeChecked();
  await choice(page, "Nettoyage", /^Avec/).check();
  await expect(page.getByText(eur("1 880,00"))).toBeVisible();
  await page.getByRole("button", { name: "Enregistrer la configuration" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Configuration enregistrée." })).toBeVisible();
  await expect(lot.getByText("Nettoyage : Avec")).toHaveCount(1);
  await expect(lot.getByText(eur("1 880,00"))).toBeVisible();

  // Retirer la seconde, avec confirmation
  await lot.getByRole("button", { name: `Retirer ${batch.name}, machine n° 2` }).click();
  const dialog = page.getByRole("dialog", { name: "Retirer cette machine de vos intérêts ?" });
  await dialog.getByRole("button", { name: "Retirer" }).click();
  await expect(dialog).toBeHidden();
  await expect(lot.getByText("1 machine souhaitée")).toBeVisible();
  await api.dispose();
});

test("un lot non public (brouillon, annulé) n'est pas visible dans la boutique", async ({ page, baseURL }) => {
  const api = await adminApi(baseURL!);
  const draft = await createBatch(api, []);
  const cancelled = await createBatch(api, ["survey", "cancelled"]);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  for (const batch of [draft, cancelled]) {
    await expect(page.getByRole("link", { name: batch.modelName })).toHaveCount(0);
    expect((await page.goto(`/lots/${batch.id}`))?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Ce lot n'est pas disponible" })).toBeVisible();
    await expect(page.getByText(batch.modelName)).toHaveCount(0);
    expect((await page.request.get(`/api/shop/batches/${batch.id}`)).status()).toBe(404);
  }
  // Identifiant invalide ou lot inconnu : vrai 404 (pas de loading.tsx qui figerait le statut à 200)
  for (const path of ["/lots/zzz", "/lots/pas-un-identifiant", `/lots/${crypto.randomUUID()}`]) {
    expect((await page.goto(path))?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Ce lot n'est pas disponible" })).toBeVisible();
  }
  await api.dispose();
});

test("la manifestation d'intérêt d'un autre client est inaccessible", async ({ page, context, baseURL }) => {
  const api = await adminApi(baseURL!);
  const batch = await createBatch(api);
  const owner = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Cookie: `access_token=${await forgeAccessToken(newCustomerId(), "alice")}` },
  });
  const created = await owner.post("/api/wishlists", { data: { batchId: batch.id, choices: [] } });
  expect(created.status()).toBe(201);
  const wishlistId = (await created.json()).items[0].id as string;

  await signIn(context, baseURL!, newCustomerId(), "curieux");
  // Celle d'un autre, inconnue ou mal formée : vrai 404, sans rien révéler
  for (const path of [`/mes-interets/${wishlistId}`, `/mes-interets/${crypto.randomUUID()}`, "/mes-interets/zzz"]) {
    expect((await page.goto(path))?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Cette page n'existe pas" })).toBeVisible();
  }
  await page.goto("/mes-interets");
  await expect(page.getByRole("heading", { name: "Aucun intérêt pour l'instant" })).toBeVisible();

  expect((await page.request.get(`/api/wishlists/${wishlistId}`)).status()).toBe(404);
  expect((await page.request.patch(`/api/wishlists/${wishlistId}`, { data: { choices: [] } })).status()).toBe(404);
  expect((await page.request.delete(`/api/wishlists/${wishlistId}`)).status()).toBe(404);
  // Toujours là pour sa propriétaire
  expect((await owner.get(`/api/wishlists/${wishlistId}`)).status()).toBe(200);
  await owner.dispose();
  await api.dispose();
});

test("plafond par personne atteint : le message du serveur est affiché et reçoit le focus", async ({
  page,
  context,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const batch = await createBatch(api);
  await signIn(context, baseURL!, newCustomerId(), "gourmand");
  await page.goto(`/lots/${batch.id}`);

  const quantity = page.getByLabel("Nombre de machines");
  const submit = page.getByRole("button", { name: "Manifester mon intérêt" });
  await quantity.fill("4");
  await submit.click();
  await expect(page.getByRole("status").filter({ hasText: "votre intérêt pour 4 machines est enregistré" })).toBeVisible();

  // Plafond par défaut : 5 machines par personne et par lot
  await quantity.fill("2");
  await submit.click();
  const alert = page.getByRole("alert").filter({ hasText: "il ne vous reste que" });
  await expect(alert).toContainText("il ne vous reste que 1 machine sur ce lot");
  await expect(alert.locator("..")).toBeFocused();
  await expect(submit).toBeEnabled();

  await quantity.fill("1");
  await submit.click();
  await expect(page.getByRole("status").filter({ hasText: "votre intérêt pour 1 machine est enregistré" })).toBeVisible();
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: "maximum par personne (5)" })).toBeVisible();

  // Saisie mal formée : refusée avant l'envoi, sous le champ (la forme seulement, le plafond vient du serveur)
  await quantity.fill("0");
  await submit.click();
  await expect(page.getByText("Indiquez un nombre entier de machines (1 ou plus).")).toBeVisible();
  await expect(quantity).toBeFocused();
  // Grand nombre bien formé : part au serveur, dont le message cite le vrai plafond (pas une borne technique)
  await quantity.fill("150");
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: "maximum par personne (5)" })).toBeVisible();
  await expect(page.getByText("compris entre 1 et")).toHaveCount(0);
  await expect(page.getByText("Indiquez un nombre entier de machines (1 ou plus).")).toHaveCount(0);
  await api.dispose();
});

test("« Mes intérêts » sans connexion renvoie vers la connexion, avec retour sur la page", async ({ request, baseURL }) => {
  const response = await request.get("/mes-interets", { maxRedirects: 0 });
  expect([303, 307, 308]).toContain(response.status());
  const location = new URL(response.headers()["location"]);
  expect(`${location.origin}${location.pathname}`).toBe(`${AUTH_FRONT_URL}/login`);
  expect(location.searchParams.get("redirect")).toBe(`${baseURL}/mes-interets`);
});

test("nom du lot sur la liste et la fiche, plafond par personne affiché sans borner la saisie", async ({
  page,
  context,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const lotName = unique("Palette d'octobre");
  const batch = await createBatch(api, ["survey"], { name: lotName });
  expect(batch.name).toBe(lotName);

  await page.goto("/");
  const card = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: batch.modelName }) });
  await expect(card.getByText(lotName)).toBeVisible();

  await signIn(context, baseURL!, newCustomerId(), "curieux");
  await page.goto(`/lots/${batch.id}`);
  await expect(page.getByText(lotName)).toBeVisible();
  await expect(page.getByText("Jusqu'à 5 machines").first()).toBeVisible();

  // Information seulement : une quantité au-delà du plafond part au serveur, qui refuse
  await page.getByLabel("Nombre de machines").fill("6");
  await page.getByRole("button", { name: "Manifester mon intérêt" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "il ne vous reste que 5 machines sur ce lot" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manifester mon intérêt" })).toBeEnabled();
  await api.dispose();
});

test("retour après connexion sur une manifestation d'intérêt précise, requête comprise", async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const api = await adminApi(baseURL!);
  const batch = await createBatch(api);
  const customer = newCustomerId();
  const owner = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Cookie: `access_token=${await forgeAccessToken(customer, "retour")}` },
  });
  const created = await owner.post("/api/wishlists", { data: { batchId: batch.id, choices: [] } });
  expect(created.status()).toBe(201);
  const wishlistId = (await created.json()).items[0].id as string;

  // Redirection HTTP (avant le chargement), retour exact avec la requête
  const response = await request.get(`/mes-interets/${wishlistId}?source=courriel`, { maxRedirects: 0 });
  expect([303, 307, 308]).toContain(response.status());
  const location = new URL(response.headers()["location"]);
  expect(location.searchParams.get("redirect")).toBe(`${baseURL}/mes-interets/${wishlistId}?source=courriel`);

  // Connexion faite (auth-service renvoie sur `redirect`) : retour sur la configuration de cette machine
  await signIn(context, baseURL!, customer, "retour");
  await page.goto(location.searchParams.get("redirect")!);
  await expect(page).toHaveURL(`${baseURL}/mes-interets/${wishlistId}?source=courriel`);
  await expect(page.getByRole("heading", { name: "Modifier la configuration" })).toBeVisible();
  await expect(choice(page, "Kit de ventilation", /^Sans kit/)).toBeChecked();
  await owner.dispose();
  await api.dispose();
});

test("un chemin encodé hostile reste un retour sur la boutique", async ({ request, baseURL }) => {
  const response = await request.get("/mes-interets/%2F%2Fevil.example", { maxRedirects: 0 });
  expect([303, 307, 308]).toContain(response.status());
  const back = new URL(new URL(response.headers()["location"]).searchParams.get("redirect")!);
  expect(back.origin).toBe(new URL(baseURL!).origin);
  expect(back.pathname).toBe("/mes-interets/%2F%2Fevil.example");
});

test("configuration figée après le sondage : « Retirer » reste proposé et fonctionne", async ({
  page,
  context,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const batch = await createBatch(api, ["survey"], { name: unique("Palette Bitmain") });
  const customer = newCustomerId();
  await signIn(context, baseURL!, customer, "fige");
  const created = await page.request.post("/api/wishlists", { data: { batchId: batch.id, choices: [], quantity: 2 } });
  expect(created.status()).toBe(201);
  expect(
    (await api.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "survey", to: "preorder" } })).status(),
  ).toBe(201);

  // Liste : le lot est désigné par son nom, le modèle en secondaire
  await page.goto("/mes-interets");
  const lot = page.getByRole("region", { name: new RegExp(batch.name) });
  await expect(lot.getByRole("heading", { level: 2 })).toContainText(batch.name);
  await expect(lot.getByText(`${batch.modelName} · 2 machines souhaitées`)).toBeVisible();

  // Pas de « Modifier » (l'API dit editable: false), mais « Retirer » est là, avec la raison
  await expect(lot.getByText("Sondage terminé (statut « Précommande ») : la configuration est figée.").first()).toBeVisible();
  await expect(lot.getByRole("link", { name: /^Modifier/ })).toHaveCount(0);
  await lot.getByRole("button", { name: `Retirer ${batch.name}, machine n° 2` }).click();
  const dialog = page.getByRole("dialog", { name: "Retirer cette machine de vos intérêts ?" });
  await dialog.getByRole("button", { name: "Retirer" }).click();
  await expect(dialog).toBeHidden();
  await expect(lot.getByText("1 machine souhaitée")).toBeVisible();

  // Fiche de la machine restante : configuration figée, retrait possible, retour à la liste
  const [remaining] = (await (await page.request.get(`/api/wishlists?batchId=${batch.id}`)).json()).items as { id: string }[];
  await page.goto(`/mes-interets/${remaining.id}`);
  await expect(page.getByRole("heading", { level: 1, name: batch.name })).toBeVisible();
  await expect(page.getByText(`Modèle ${batch.modelName}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "La configuration ne se modifie plus" })).toBeVisible();
  await expect(page.getByText("Vous pouvez encore retirer votre intérêt.")).toBeVisible();
  await page.getByRole("button", { name: /^Retirer/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Retirer" }).click();
  await page.waitForURL("**/mes-interets");
  await expect(page.getByRole("heading", { name: "Aucun intérêt pour l'instant" })).toBeVisible();
  await api.dispose();
});

test("machine devenue une commande payée : raison affichée, ni « Retirer » ni « Modifier », lien vers la commande", async ({
  page,
  context,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const batch = await createBatch(api);
  await signIn(context, baseURL!, newCustomerId(), "converti");
  const created = await page.request.post("/api/wishlists", { data: { batchId: batch.id, choices: [] } });
  expect(created.status()).toBe(201);
  const wishlistId = (await created.json()).items[0].id as string;
  expect(
    (await api.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "survey", to: "preorder" } })).status(),
  ).toBe(201);
  await convertWishlist(wishlistId);

  const reason =
    "Commandée et payée : la machine se gère depuis la commande (renoncement tant que le lot est en précommande, sinon contactez-nous).";
  await page.goto("/mes-interets");
  const lot = page.getByRole("region", { name: new RegExp(batch.name) });
  await expect(lot.getByText("Commandée", { exact: true })).toBeVisible();
  await expect(lot.getByText(reason)).toBeVisible();
  await expect(lot.getByRole("link", { name: /^Modifier/ })).toHaveCount(0);
  // Pas de « Retirer » (vocabulaire d'annulation compris) pour une machine déjà commandée : un lien vers la commande
  await expect(lot.getByRole("button", { name: /^Retirer/ })).toHaveCount(0);
  await expect(lot.getByText(/annulation/i)).toHaveCount(0);
  await lot.getByRole("link", { name: `Voir la commande de ${batch.name}, machine n° 1` }).click();
  await expect(page).toHaveURL(/\/mes-commandes\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Commande confirmée" })).toBeVisible();

  // Fiche de la machine : même raison, même lien, pas de « Retirer »
  await page.goto(`/mes-interets/${wishlistId}`);
  await expect(page.getByText(reason)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Retirer/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Voir la commande" })).toBeVisible();
  // Le serveur refuse toujours le retrait d'une machine commandée (garde de l'API, indépendante de l'UI)
  const removal = await page.request.delete(`/api/wishlists/${wishlistId}`);
  expect(removal.status()).toBe(409);
  expect((await removal.json()).error.code).toBe("wishlist_converted");
  await api.dispose();
});

test("prix du lot changé pendant le sondage : avertissement dans « Mes intérêts », instantané conservé", async ({
  page,
  context,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const batch = await createBatch(api);
  await signIn(context, baseURL!, newCustomerId(), "budget");
  expect((await page.request.post("/api/wishlists", { data: { batchId: batch.id, choices: [] } })).status()).toBe(201);

  await page.goto("/mes-interets");
  const lot = page.getByRole("region", { name: new RegExp(batch.modelName) });
  await expect(lot.getByText(eur("1 800,00")).first()).toBeVisible();
  await expect(lot.getByText("Le prix a changé")).toHaveCount(0);

  // L'admin passe le prix de revente de 1 800 € à 1 900 €
  const current = await (await api.get(`/api/backoffice/batches/${batch.id}`)).json();
  const patched = await api.patch(`/api/backoffice/batches/${batch.id}`, {
    data: { expectedUpdatedAt: current.updatedAt, resaleUnitPrice: "190000" },
  });
  expect(patched.status()).toBe(200);

  await page.reload();
  const warning = lot.getByRole("note");
  await expect(warning).toContainText(
    `Le prix a changé depuis votre manifestation d'intérêt : ${eur("1 900,00")} aujourd'hui, ${eur("1 800,00")} lors de votre choix`,
  );
  await expect(lot.getByText(eur("1 800,00")).first()).toBeVisible(); // l'instantané reste affiché

  // Même avertissement sur la page de modification ; enregistrer applique le prix du jour
  await lot.getByRole("link", { name: /^Modifier/ }).click();
  await expect(page.getByRole("note")).toContainText("Le prix a changé");
  await page.getByRole("button", { name: "Enregistrer la configuration" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Configuration enregistrée." })).toBeVisible();
  await expect(lot.getByRole("note")).toHaveCount(0);
  await expect(lot.getByText(eur("1 900,00")).first()).toBeVisible();

  // Configuration figée après le sondage : l'API ne renvoie plus le prix actuel, plus d'avertissement
  const again = await (await api.get(`/api/backoffice/batches/${batch.id}`)).json();
  expect(
    (
      await api.patch(`/api/backoffice/batches/${batch.id}`, {
        data: { expectedUpdatedAt: again.updatedAt, resaleUnitPrice: "200000" },
      })
    ).status(),
  ).toBe(200);
  expect(
    (await api.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "survey", to: "preorder" } })).status(),
  ).toBe(201);
  await page.reload();
  await expect(lot.getByText(eur("1 900,00")).first()).toBeVisible();
  await expect(lot.getByRole("note")).toHaveCount(0);
  await api.dispose();
});

test("aucun loading.tsx dans la boutique ni le backoffice (il ferait répondre 200 aux pages introuvables)", () => {
  const app = join(process.cwd(), "src", "app");
  const found = readdirSync(app, { recursive: true, encoding: "utf8" }).filter((f) => /(^|[\\/])loading\.[jt]sx?$/.test(f));
  expect(found).toEqual([]);
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("liens et boutons de navigation d'au moins 44 × 44 px", async ({ page, context, baseURL }) => {
    const api = await adminApi(baseURL!);
    const batch = await createBatch(api);
    await signIn(context, baseURL!, newCustomerId(), "mobile");
    const nav = page.getByRole("navigation", { name: "Boutique" });

    async function expectBigEnough(...targets: Locator[]) {
      for (const target of targets) {
        const box = await target.boundingBox();
        expect(box, "cible visible").not.toBeNull();
        expect(box!.width, await target.innerText()).toBeGreaterThanOrEqual(44);
        expect(box!.height, await target.innerText()).toBeGreaterThanOrEqual(44);
      }
    }

    await page.goto(`/lots/${batch.id}`);
    await expectBigEnough(
      page.getByRole("link", { name: "Les Chauffagistes" }),
      nav.getByRole("link", { name: "Lots" }),
      nav.getByRole("link", { name: "Mes intérêts" }),
      page.getByRole("navigation", { name: "Fil d'Ariane" }).getByRole("link", { name: "Lots" }),
      page.getByRole("button", { name: "Manifester mon intérêt" }),
    );

    await page.getByLabel("Nombre de machines").fill("1");
    await page.getByRole("button", { name: "Manifester mon intérêt" }).click();
    await expect(page.getByRole("status").filter({ hasText: "est enregistré" })).toBeVisible();
    await page.goto("/mes-interets");
    await expectBigEnough(
      page.getByRole("link", { name: /^Modifier/ }).first(),
      page.getByRole("button", { name: /^Retirer/ }).first(),
      page.getByRole("link", { name: "Voir le lot" }),
    );
    await api.dispose();
  });
});
