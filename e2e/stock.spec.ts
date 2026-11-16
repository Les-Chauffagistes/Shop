import { expect, test } from "@playwright/test";
import { signIn, unique } from "./support/auth";
import { adminApi, apiAs, newCustomerId, placeOrder, receivePayment } from "./support/orders";

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

/**
 * Lot de stock de bout en bout : création, réassort, réception par collage des numéros de série, « Tout OK », mise
 * en vente, commande payée d'un client (boutique « En stock », pas de renoncement), attribution automatique, écran
 * « Stock » et recherche d'une machine par numéro de série.
 */
test("lot de stock : réassort, réception, contrôle, vente et attribution", async ({ page, browser, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const modelName = unique("S9");
  const created = await admin.post("/api/backoffice/models", { data: { name: modelName, hashrate: "14000000000000", hashboardQtt: 3 } });
  expect(created.status()).toBe(201);
  const serials = [unique("SN").replace(" ", "-"), unique("SN").replace(" ", "-")];

  // Création : modèle et prix de revente, ni quantité ni prix d'achat
  await page.goto("/backoffice/lots");
  await page.getByRole("link", { name: "Créer le lot de stock" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Nouveau lot de stock" })).toBeVisible();
  await expect(page.getByLabel("Quantité de machines")).toHaveCount(0);
  await page.getByLabel("Modèle de mineur").selectOption({ label: modelName });
  await page.getByLabel("Prix de revente unitaire").fill("520");
  await page.getByRole("button", { name: "Créer le lot de stock" }).click();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toContainText(`Stock ${modelName}`);
  await expect(heading.locator(".bo-badge")).toHaveText("En pause");
  const batchId = page.url().split("/").pop()!;

  // Un second lot de stock du même modèle : on retombe sur le lot existant
  await page.goto("/backoffice/lots/nouveau?type=stock");
  await page.getByLabel("Modèle de mineur").selectOption({ label: modelName });
  await page.getByRole("button", { name: "Créer le lot de stock" }).click();
  await expect(page.getByText("Ce modèle a déjà son lot de stock")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/backoffice/lots/${batchId}\\?existant=1$`));

  // Réassort de 2 machines
  await page.getByLabel("Quantité", { exact: true }).fill("2");
  await page.getByLabel("Prix d'achat total").fill("900");
  await page.getByLabel("Note").first().fill("Fournisseur e2e");
  await page.getByRole("button", { name: "Enregistrer le réassort" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Réassort enregistré : 2 machines attendues" })).toBeVisible();
  await expect(page.locator(".bo-stat").filter({ hasText: "À recevoir" })).toContainText("2");
  await expect(page.getByRole("cell", { name: "Fournisseur e2e" })).toBeVisible();

  // Réception par collage, puis « Tout OK » sur les machines cochées
  await page.getByRole("navigation", { name: "Onglets du lot" }).getByRole("link", { name: /Machines/ }).click();
  await page.getByLabel("Numéros de série", { exact: true }).fill(serials.join("\n"));
  await page.getByRole("button", { name: "Recevoir 2 machines" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 machines reçues : à contrôler." })).toBeVisible();
  for (const serial of serials) {
    await page.getByRole("row").filter({ hasText: serial }).getByRole("checkbox").check();
  }
  await page.getByRole("button", { name: "Tout OK (2)" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 machines contrôlées OK." })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: serials[0] })).toContainText("Disponible");

  // Mise en vente (la pause est l'action secondaire, sans motif)
  const panel = page.getByRole("complementary", { name: "Actions du lot" });
  await panel.getByRole("button", { name: "Mettre en vente" }).click();
  const dialog = page.getByRole("dialog", { name: "Mettre en vente ?" });
  await dialog.getByRole("button", { name: "Confirmer" }).click();
  await expect(heading.locator(".bo-badge")).toHaveText("En vente");
  await expect(panel.getByRole("button", { name: "Mettre en pause" })).toBeVisible();

  // Commande payée d'un client
  const customerId = newCustomerId();
  const customer = await apiAs(baseURL!, customerId, "client-stock");
  const order = await placeOrder(customer, batchId);
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);

  // Boutique : « En stock », sans sondage ni précommande, pas de renoncement en ligne
  const customerContext = await browser.newContext();
  await signIn(customerContext, baseURL!, customerId, "client-stock");
  const shop = await customerContext.newPage();
  await shop.goto("/");
  await expect(shop.getByRole("region", { name: "En stock, commandez" }).getByText(modelName).first()).toBeVisible();
  await shop.goto(`/lots/${batchId}`);
  await expect(shop.locator(".shop-eyebrow .bo-badge")).toHaveText("En stock");
  await expect(shop.getByRole("heading", { name: "En stock, commandez" })).toBeVisible();
  await expect(shop.getByText("Les machines sont en stock et déjà contrôlées")).toBeVisible();
  await shop.goto(`/mes-commandes/${order.id}`);
  await expect(shop.getByText(/^Commande du /)).toBeVisible();
  await expect(shop.getByRole("heading", { name: "Commande confirmée" })).toBeVisible();
  await expect(shop.getByText("Une commande de machines en stock ne s'annule pas en ligne")).toBeVisible();
  await expect(shop.getByRole("heading", { name: "Renoncer à ma commande" })).toHaveCount(0);
  await customerContext.close();

  // Attribution automatique à l'encaissement : la commande a déjà sa machine, rien à attribuer
  await page.reload();
  await expect(page.getByRole("region", { name: "Commandes payées du lot" })).toContainText(serials[0]);
  await expect(page.getByRole("button", { name: "Attribuer automatiquement" })).toBeVisible();

  // Écran « Stock » : la machine attribuée est à expédier, l'autre disponible
  await page.getByRole("navigation", { name: "Backoffice" }).getByRole("link", { name: "Stock" }).click();
  const row = page.getByRole("row").filter({ hasText: modelName });
  await expect(row.locator('[col-id="assigned"]')).toHaveText("1");
  await expect(row.locator('[col-id="available"]')).toHaveText("1");

  // Recherche par numéro de série depuis l'en-tête : un seul résultat ouvre la fiche
  await page.getByLabel("Rechercher une machine par numéro de série").fill(serials[1]);
  await page.getByLabel("Rechercher une machine par numéro de série").press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(serials[1]);
  await expect(page.getByRole("heading", { name: "Journal des statuts" })).toBeVisible();

  await customer.dispose();
  await admin.dispose();
});
