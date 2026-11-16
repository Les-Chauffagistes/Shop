import { expect, test } from "@playwright/test";
import { signIn, unique } from "./support/auth";
import { adminApi, apiAs, newCustomerId, placeOrder, receivePayment } from "./support/orders";

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

/**
 * Expédition d'une facture de deux machines (R6 lot 3) : le suivi se saisit à la remise de la première machine, il est
 * commun à la facture (fiche de la seconde machine, facture admin) et le client le voit dans « Mes commandes ».
 */
test("expédition d'une facture : suivi unique, partagé, visible du client", async ({ page, browser, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const model = await (
    await admin.post("/api/backoffice/models", { data: { name: unique("S19"), hashrate: "14000000000000", hashboardQtt: 3 } })
  ).json();
  const batch = await (await admin.post("/api/backoffice/batches", { data: { kind: "stock", modelId: model.id, resaleUnitPrice: "52000" } })).json();
  const serials = [unique("SN-A").replace(" ", "-"), unique("SN-B").replace(" ", "-")];
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/restocks`, { data: { quantity: 2, purchasePrice: "45000" } })).status()).toBe(201);
  const received = await (await admin.post(`/api/backoffice/batches/${batch.id}/receptions`, { data: { serials } })).json();
  const ids = (received.machines as { id: string }[]).map((m) => m.id);
  expect((await admin.post("/api/backoffice/machines/check-ok", { data: { machineIds: ids } })).status()).toBe(201);
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "draft", to: "on_sale" } })).status()).toBe(201);

  // Facture de deux machines payée : attribution automatique
  const customerId = newCustomerId();
  const customer = await apiAs(baseURL!, customerId, "acheteur-envoi");
  const order = await placeOrder(customer, batch.id, { lines: 2 });
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);
  await expect
    .poll(async () => (await (await customer.get(`/api/orders/${order.id}`)).json()).status, { timeout: 30_000 })
    .toBe("paid");

  // Les deux machines prêtes (API), puis remise de la première au transporteur depuis sa fiche
  const ready = await admin.post("/api/backoffice/machines/status", {
    data: { items: ids.map((machineId) => ({ machineId, from: { logistical: "in_stock", functional: "ok" }, to: { logistical: "ready" } })) },
  });
  expect(ready.status(), await ready.text()).toBeLessThan(300);

  await page.goto(`/backoffice/machines/${ids[0]}`);
  await expect(page.getByRole("heading", { name: "Envoi de la facture" })).toBeVisible();
  await expect(page.getByText("Pas encore expédiée")).toBeVisible();
  await page.getByRole("button", { name: "Remettre au transporteur" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("commun à ses machines");
  await dialog.getByLabel("Transporteur").fill("DHL");
  await dialog.getByLabel("Numéro de suivi").fill("JD0146000123");
  await dialog.getByLabel("Lien de suivi").fill("https://tracking.example.com/JD0146000123");
  await dialog.getByRole("button", { name: "Remettre au transporteur" }).click();
  const shipment = page.getByTestId("shipment");
  await expect(shipment).toContainText("DHL", { timeout: 20_000 });
  await expect(shipment).toContainText("JD0146000123");
  await expect(shipment.getByRole("link", { name: "Suivre le colis" })).toHaveAttribute("href", "https://tracking.example.com/JD0146000123");
  await expect(shipment).not.toContainText("Pas encore remise");

  // Suivi partagé : la seconde machine, encore prête, affiche le même envoi
  await page.goto(`/backoffice/machines/${ids[1]}`);
  await expect(page.getByTestId("shipment")).toContainText("JD0146000123");
  // Facture admin
  await page.goto(`/backoffice/factures/${order.id}`);
  await expect(page.getByRole("heading", { name: "Expédition" })).toBeVisible();
  await expect(page.getByTestId("shipment")).toContainText("DHL");

  // Côté client : transporteur, numéro, lien sûr
  const shopContext = await browser.newContext();
  await signIn(shopContext, baseURL!, customerId, "acheteur-envoi");
  const shop = await shopContext.newPage();
  await shop.goto(`/mes-commandes/${order.id}`);
  await expect(shop.getByRole("heading", { name: "Expédition" })).toBeVisible();
  const mine = shop.getByTestId("shipment");
  await expect(mine).toContainText("DHL");
  await expect(mine).toContainText("JD0146000123");
  const link = mine.getByRole("link", { name: "Suivre le colis" });
  await expect(link).toHaveAttribute("href", "https://tracking.example.com/JD0146000123");
  await expect(link).toHaveAttribute("rel", /noopener/);

  // Liste « Mes commandes » : résumé du suivi sur la carte de la commande
  await shop.goto("/mes-commandes");
  const summary = shop.getByTestId("shipment-summary");
  await expect(summary).toContainText("Expédiée le");
  await expect(summary).toContainText("DHL");
  await expect(summary).toContainText("JD0146000123");
  await expect(summary.getByRole("link", { name: "Suivre le colis" })).toHaveAttribute("href", "https://tracking.example.com/JD0146000123");

  await shopContext.close();
  await customer.dispose();
  await admin.dispose();
});
