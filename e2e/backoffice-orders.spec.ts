import { expect, test } from "@playwright/test";
import { profileEmailOf, signIn } from "./support/auth";
import { blockCustomer } from "./support/db";
import { adminApi, apiAs, createBatch, newCustomerId, placeOrder, receivePayment, refundAddress } from "./support/orders";

/**
 * Factures au backoffice (jalon 4) : file « à traiter », remboursement avec choix du motif, envoi
 * (adresse changée entre-temps), blocages et levée. L'admin agit dans l'interface ; le client et le
 * service de paiement passent par l'API.
 */

test("à traiter : paiement après annulation, remboursement avec motif, puis envoi", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const me = await apiAs(baseURL!, newCustomerId());
  const order = await placeOrder(me, batch.id);
  expect((await me.post(`/api/orders/${order.id}/cancel`, { data: {} })).status()).toBe(200);
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);
  const first = refundAddress();
  expect((await me.patch(`/api/orders/${order.id}/refund-address`, { data: { refundAddress: first } })).status()).toBe(200);

  await signIn(context, baseURL!);
  await page.goto("/backoffice/a-traiter");
  const row = page.getByRole("row").filter({ hasText: batch.name });
  await row.getByRole("link", { name: "Décision de la boutique" }).click();
  await expect(page.getByRole("heading", { name: "À traiter : Décision de la boutique" })).toBeVisible();

  // Motif : le payeur des frais est affiché pour chacun
  const refund = page.getByRole("form", { name: "Rembourser" });
  const stock = refund.getByRole("radio", { name: /Souci de stock/ });
  await expect(refund.getByText("Souci de stock (surplus, lot abandonné)").locator("..")).toContainText("à la charge de la boutique");
  await stock.check();
  await refund.getByLabel("Explication").fill("Lot complet, paiement arrivé après annulation");
  await refund.getByRole("button", { name: "Rembourser…" }).click();
  const dialog = page.getByRole("dialog", { name: "Rembourser cette facture ?" });
  await expect(dialog).toContainText("Frais du réseau à la charge de la boutique");
  await dialog.getByRole("button", { name: "Rembourser" }).click();
  await expect(page.getByText("Remboursement créé")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rien à traiter" })).toBeVisible();

  // À envoyer : l'adresse change entre l'ouverture et l'enregistrement de l'envoi
  await page.getByRole("navigation", { name: "Backoffice" }).getByRole("link", { name: "Remboursements" }).click();
  const toSend = page.getByRole("row").filter({ hasText: batch.name });
  await expect(toSend.getByText(first)).toBeVisible();
  await toSend.getByRole("button", { name: /^Enregistrer l'envoi/ }).click();
  const send = page.getByRole("dialog", { name: "Enregistrer l'envoi du remboursement" });
  await expect(send.getByLabel("Adresse de destination")).toHaveValue(first);
  const second = refundAddress();
  expect((await me.patch(`/api/orders/${order.id}/refund-address`, { data: { refundAddress: second } })).status()).toBe(200);
  await send.getByLabel("Référence de la transaction (txid)").fill("txid-e2e-envoi");
  await send.getByRole("button", { name: "Enregistrer l'envoi" }).click();
  await expect(send.getByRole("alert")).toContainText("L'adresse de remboursement a changé entre-temps");
  await expect(send.getByRole("alert")).toContainText(second);
  await send.getByRole("button", { name: "Utiliser la nouvelle adresse" }).click();
  await expect(send.getByLabel("Adresse de destination")).toHaveValue(second);
  await send.getByRole("button", { name: "Enregistrer l'envoi" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Envoi enregistré" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: batch.name })).toHaveCount(0);

  // Le client voit le remboursement envoyé
  const after = await (await me.get(`/api/orders/${order.id}`)).json();
  expect(after.refunds[0]).toMatchObject({ cause: "shop_stock", reference: "txid-e2e-envoi", destinationAddress: second });
  await me.dispose();
  await admin.dispose();
});

test("blocage après trois abandons : visible du client, levé par l'admin", async ({ page, context, browser, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  await blockCustomer(batch.id, customer);

  // Le client voit le message du serveur sur la page de commande
  const customerContext = await browser.newContext();
  await signIn(customerContext, baseURL!, customer, "bloque");
  const customerPage = await customerContext.newPage();
  await customerPage.goto(`/lots/${batch.id}/commander`);
  await expect(customerPage.getByRole("note").filter({ hasText: "les commandes sont suspendues pour vous sur ce lot" })).toBeVisible();

  // Liste des lots : compteur de bloqués, lien vers les blocages du lot
  await signIn(context, baseURL!);
  await page.goto("/backoffice/lots?statut=tous");
  await page.getByRole("row").filter({ hasText: batch.name }).getByRole("link", { name: "1 bloqué" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Blocages" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: batch.name });
  await expect(row).toContainText(`n° ${customer}`);
  // E-mail de la dernière facture du lot et e-mail actuel du profil (différents ici), en liens mailto
  await expect(row.getByRole("link", { name: "client-e2e@exemple.fr" })).toHaveAttribute("href", "mailto:client-e2e@exemple.fr");
  await expect(row.getByRole("link", { name: profileEmailOf(customer) })).toHaveAttribute("href", `mailto:${profileEmailOf(customer)}`);
  await row.getByRole("button", { name: /^Lever le blocage/ }).click();
  const dialog = page.getByRole("dialog", { name: "Lever le blocage ?" });
  await dialog.getByLabel("Explication").fill("Client contacté, bonne foi");
  await dialog.getByRole("button", { name: "Lever le blocage" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Blocage levé" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Aucun utilisateur bloqué" })).toBeVisible();

  await customerPage.reload();
  await expect(customerPage.getByRole("heading", { level: 1, name: "Commander" })).toBeVisible();
  await expect(customerPage.getByText("les commandes sont suspendues pour vous sur ce lot")).toHaveCount(0);
  await customerContext.close();
  await admin.dispose();
});
