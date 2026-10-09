import { expect, test } from "@playwright/test";
import { profileEmailOf, signIn, unique } from "./support/auth";
import { adminApi, apiAs, createBatch, newCustomerId, placeOrder, receivePayment, refundAddress, sats } from "./support/orders";

/**
 * Décisions de Hugo du 2026-10-09 (v5i/v5j/v5k) côté écrans : renoncement sans renvoi de l'excédent,
 * « Classer sans suite » et ses refus, factures annulées annoncées avant une transition qui ferme les
 * commandes, retrait d'une valeur choisie par des manifestations d'intérêt (confirmation, puis avertissement).
 */

test("renoncement complet avec un excédent : il reste à l'équipe, qui le classe sans suite ; le client le voit", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  const order = await placeOrder(me, batch.id, { refund: refundAddress() });
  await receivePayment(baseURL!, order.payment.address, String(BigInt(order.payment.expectedSats) + 1_500n));

  await signIn(context, baseURL!, customer, "renonce-exces");
  await page.goto(`/mes-commandes/${order.id}`);
  const renounce = page.getByRole("form", { name: "Renoncer à ma commande" });
  await expect(renounce.getByRole("note")).toContainText("Un éventuel paiement en trop n'est pas renvoyé d'office");
  await renounce.getByRole("button", { name: "Renoncer…" }).click();
  const dialog = page.getByRole("dialog", { name: "Renoncer à toute la commande ?" });
  await expect(dialog).toContainText("ce surplus n'est pas renvoyé d'office");
  await expect(dialog).toContainText("Les frais du réseau Bitcoin sont déduits");
  await dialog.getByRole("button", { name: "Confirmer le renoncement" }).click();
  await expect(page.getByText("Renoncement enregistré")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Un versement est en cours de traitement" })).toBeVisible();
  await expect(page.getByText(`Vous aviez envoyé ${sats("1 500")} de plus que le montant de la commande`)).toBeVisible();

  // Admin : « À traiter », e-mail du client dans la grille, puis classement sans suite avec motif
  await signIn(context, baseURL!);
  await page.goto("/backoffice/a-traiter");
  const row = page.getByRole("row").filter({ hasText: batch.name });
  await expect(row.getByRole("link", { name: profileEmailOf(customer) })).toHaveAttribute("href", `mailto:${profileEmailOf(customer)}`);
  await page.goto(`/backoffice/factures/${order.id}`);
  const dismiss = page.getByRole("form", { name: "Classer sans suite" });
  await dismiss.getByLabel("Motif").fill("Client prévenu par e-mail");
  await dismiss.getByRole("button", { name: "Classer sans suite…" }).click();
  const confirm = page.getByRole("dialog", { name: "Classer cette somme sans suite ?" });
  await expect(confirm).toContainText(sats("1 500"));
  await confirm.getByRole("button", { name: "Classer sans suite" }).click();
  await expect(page.getByText("Somme classée sans suite (journalisée).")).toBeVisible();
  const trace = page.getByRole("region", { name: "Classé sans suite" });
  await expect(trace).toContainText(`${sats("1 500")} non renvoyés`);
  await expect(trace).toContainText("motif : Client prévenu par e-mail");
  await expect(page.getByRole("form", { name: "Classer sans suite" })).toHaveCount(0);

  await signIn(context, baseURL!, customer, "renonce-exces");
  await page.goto(`/mes-commandes/${order.id}`);
  await expect(page.getByRole("heading", { name: "Somme classée sans suite" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Un versement est en cours de traitement" })).toHaveCount(0);
  await me.dispose();
  await admin.dispose();
});

test("classer sans suite : un versement arrivé entre-temps fait refuser le classement, avec les montants", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const me = await apiAs(baseURL!, newCustomerId());
  const order = await placeOrder(me, batch.id);
  await receivePayment(baseURL!, order.payment.address, String(BigInt(order.payment.expectedSats) + 1_500n));

  await signIn(context, baseURL!);
  await page.goto(`/backoffice/factures/${order.id}`);
  const dismiss = page.getByRole("form", { name: "Classer sans suite" });
  await expect(dismiss).toContainText(`${sats("1 500")} non affectés`);
  // Un nouveau versement porte l'excédent au-delà des frais (2 000 sats) pendant que la page est ouverte
  await receivePayment(baseURL!, order.payment.address, "1000");
  await dismiss.getByRole("button", { name: "Classer sans suite…" }).click();
  await page.getByRole("dialog", { name: "Classer cette somme sans suite ?" }).getByRole("button", { name: "Classer sans suite" }).click();
  const alert = dismiss.getByRole("alert");
  await expect(alert).toContainText(`Non affecté : ${sats("2 500")} ; frais estimés : ${sats("2 000")}`);
  const after = await (await admin.get(`/api/backoffice/orders/${order.id}`)).json();
  expect(after.dismissal).toBeNull();
  await me.dispose();
  await admin.dispose();
});

test("annuler un lot : la confirmation annonce les factures en attente annulées ; le client lit « Lot annulé »", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const first = await placeOrder(await apiAs(baseURL!, customer), batch.id);
  await placeOrder(await apiAs(baseURL!, newCustomerId()), batch.id, { lines: 2 });

  await signIn(context, baseURL!);
  await page.goto(`/backoffice/lots/${batch.id}`);
  await page.getByRole("button", { name: "Annuler le lot" }).click();
  const dialog = page.getByRole("dialog", { name: "Annuler le lot ?" });
  await expect(dialog).toContainText("2 factures en attente de paiement, sans versement, seront annulées");
  await dialog.getByLabel("Motif").fill("Fournisseur défaillant");
  await dialog.getByRole("button", { name: "Annuler le lot" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Statut changé : « Annulé »" })).toBeVisible();

  await signIn(context, baseURL!, customer, "lot-ferme");
  await page.goto(`/mes-commandes/${first.id}`);
  await expect(page.getByRole("heading", { name: "Lot annulé" })).toBeVisible();
  await expect(page.getByText("Annulée", { exact: true })).toBeVisible();
  await admin.dispose();
});

test("retirer une valeur choisie au sondage : confirmation avec le nombre de wishlists, puis le client est prévenu", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await signIn(context, baseURL!);
  const api = page.request;
  const model = await (await api.post("/api/backoffice/models", { data: { name: unique("S21"), hashrate: "200000000000000", hashboardQtt: 3 } })).json();
  const menu = await (
    await api.post(`/api/backoffice/models/${model.id}/options`, {
      data: {
        kind: "choice",
        title: "Kit de ventilation",
        values: [
          { label: "Sans kit", price: "0" },
          { label: "Air Flow", price: "3500" },
          { label: "Silent kit", price: "7500" },
        ],
      },
    })
  ).json();
  const silent = menu.values.find((v: { label: string }) => v.label === "Silent kit");
  const batch = await (await api.post("/api/backoffice/batches", { data: { modelId: model.id, quantity: 10, purchasePrice: "1500000", resaleUnitPrice: "180000" } })).json();
  expect((await api.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "draft", to: "survey" } })).status()).toBe(201);

  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  expect((await me.post("/api/wishlists", { data: { batchId: batch.id, choices: [{ optionId: menu.id, optionValueId: silent.id }] } })).status()).toBe(201);

  await page.goto(`/backoffice/lots/${batch.id}`);
  await page.getByRole("checkbox", { name: "Proposer « Silent kit » (Kit de ventilation) pour ce lot" }).uncheck();
  await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
  const dialog = page.getByRole("dialog", { name: "Retirer cette option ?" });
  await expect(dialog).toContainText("Retirer « Silent kit » du lot ramènera 1 manifestation(s) d'intérêt");
  await expect(dialog).toContainText("1 manifestation d'intérêt concernée");
  await dialog.getByRole("button", { name: "Retirer et ramener au défaut" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: /^Lot enregistré à/ })).toBeVisible();

  const customerContext = await browser.newContext();
  await signIn(customerContext, baseURL!, customer, "retrait-option");
  const customerPage = await customerContext.newPage();
  await customerPage.goto("/mes-interets");
  const lot = customerPage.getByRole("region", { name: new RegExp(batch.name) });
  await expect(lot.getByRole("note").filter({ hasText: "a été retirée de ce lot" })).toContainText(
    "L'option « Kit de ventilation : Silent kit » (75,00",
  );
  await expect(lot.getByText("Kit de ventilation : Sans kit", { exact: true })).toBeVisible();
  await customerContext.close();
  await me.dispose();
});
