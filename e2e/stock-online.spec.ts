import { expect, test } from "@playwright/test";
import { signIn, unique } from "./support/auth";
import { adminApi, apiAs, newCustomerId, receivePayment, refundAddress, type OrderJson } from "./support/orders";

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

/**
 * Achat en ligne d'une machine du lot de stock par un client (refonte R4b) : fiche « En stock », commande, facture à
 * payer, paiement complet, commande confirmée, machine attribuée d'office (« Automatique » au journal de la machine),
 * lot épuisé sans bouton « Commander », lien « Mes commandes » sur la page de commande.
 */
test("achat en ligne sur le stock : paiement, attribution automatique, lot épuisé", async ({ page, browser, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const modelName = unique("S9");
  const model = await (
    await admin.post("/api/backoffice/models", { data: { name: modelName, hashrate: "14000000000000", hashboardQtt: 3 } })
  ).json();
  const created = await admin.post("/api/backoffice/batches", { data: { kind: "stock", modelId: model.id, resaleUnitPrice: "52000" } });
  expect(created.status()).toBe(201);
  const batch = await created.json();
  const serial = unique("SN").replace(" ", "-");
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/restocks`, { data: { quantity: 1, purchasePrice: "45000" } })).status()).toBe(201);
  const received = await (await admin.post(`/api/backoffice/batches/${batch.id}/receptions`, { data: { serials: [serial] } })).json();
  const machineIds = (received.machines as { id: string }[]).map((m) => m.id);
  expect((await admin.post("/api/backoffice/machines/check-ok", { data: { machineIds } })).status()).toBe(201);
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "draft", to: "on_sale" } })).status()).toBe(201);

  const customerId = newCustomerId();
  const customer = await apiAs(baseURL!, customerId, "acheteur-stock");
  const shopContext = await browser.newContext();
  await signIn(shopContext, baseURL!, customerId, "acheteur-stock");
  const shop = await shopContext.newPage();

  // Fiche du lot de stock : « En stock », commande directe
  await shop.goto(`/lots/${batch.id}`);
  await expect(shop.getByRole("heading", { name: "En stock, commandez" })).toBeVisible();
  await expect(shop.getByRole("link", { name: "Commander" })).toHaveAttribute("href", `/lots/${batch.id}/commander`);
  await shop.goto(`/lots/${batch.id}/commander`);
  await expect(shop.getByRole("heading", { level: 1, name: "Commander" })).toBeVisible({ timeout: 45_000 });

  // Facture : adresses et remboursement, puis création
  await shop.getByLabel("Nom complet").fill("Alice Martin");
  await shop.getByLabel("Adresse", { exact: true }).fill("1 rue de la Paix");
  await shop.getByLabel("Code postal").fill("69001");
  await shop.getByLabel("Ville").fill("Lyon");
  await shop.getByLabel("Adresse Bitcoin de remboursement").fill(refundAddress());
  await shop.getByRole("button", { name: "Créer la facture" }).click();
  await shop.waitForURL(/\/mes-commandes\/[0-9a-f-]+\?nouvelle=1$/);
  await expect(shop.getByRole("heading", { name: "Payer en bitcoins" })).toBeVisible();
  const orderId = new URL(shop.url()).pathname.split("/").pop()!;
  const order: OrderJson = await (await customer.get(`/api/orders/${orderId}`)).json();

  // Machine réservée : plus de bouton « Commander » sur la fiche, la page de commande renvoie vers la facture
  await shop.goto(`/lots/${batch.id}`);
  await expect(shop.getByRole("heading", { name: "Plus de machine en stock" })).toBeVisible();
  await expect(shop.getByRole("link", { name: "Commander" })).toHaveCount(0);
  await shop.goto(`/lots/${batch.id}/commander`);
  await expect(shop.getByRole("note").filter({ hasText: "Vos factures sur ce lot" }).getByRole("link", { name: "Toutes mes commandes" })).toBeVisible();

  // Paiement complet : commande confirmée, sans « Payer 0 BTC »
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);
  await shop.goto(`/mes-commandes/${orderId}`);
  await expect(shop.getByRole("heading", { name: "Commande confirmée" })).toBeVisible();
  await expect(shop.getByText("Une commande de machines en stock ne s'annule pas en ligne")).toBeVisible();
  await expect(shop.getByText("lot au statut")).toHaveCount(0);

  // Attribution automatique : la machine est déjà servie, journal « Automatique »
  await page.goto(`/backoffice/lots/${batch.id}?onglet=machines`);
  await expect(page.getByRole("region", { name: "Commandes payées du lot" })).toContainText(serial);
  await expect(page.getByRole("button", { name: "Attribuer automatiquement" })).toBeVisible();
  await page.goto(`/backoffice/machines?q=${encodeURIComponent(serial)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(serial);
  await expect(page.getByText("Attribuée à la").locator("..")).toContainText("Automatique");

  await shopContext.close();
  await customer.dispose();
  await admin.dispose();
});
