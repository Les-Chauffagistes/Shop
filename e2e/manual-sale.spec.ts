import { expect, test } from "@playwright/test";
import { profileEmailOf, signIn, unique } from "./support/auth";
import { blockCustomer } from "./support/db";
import { adminApi, apiAs, createBatch, eur, newCustomerId } from "./support/orders";

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

/**
 * Vente manuelle de bout en bout (refonte R5c) : depuis l'écran « Stock », vente au comptoir à un client sans compte
 * créé à la volée, sur le lot de stock, machine choisie d'office ; facture hors chaîne (euros, encaissement, motif) ;
 * rabais ; remise du remboursement enregistrée par référence seule depuis « Remboursements ».
 */
test("vente manuelle : client sans compte, lot de stock, rabais et remise", async ({ page, baseURL }) => {
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
  await admin.dispose();

  // Depuis l'écran « Stock » : « Vendre » ouvre la vente sur le lot de stock du modèle
  await page.goto("/backoffice/stock");
  await page.getByRole("link", { name: `Vendre une machine de ${batch.name}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Vente manuelle" })).toBeVisible();
  await expect(page.getByLabel("Lot", { exact: true })).toHaveValue(batch.id);

  // Client inconnu : nouveau client sans compte, adresse saisie
  const email = `comptoir-${Date.now().toString(36)}@exemple.fr`;
  await page.getByLabel("E-mail du client").fill(email);
  await expect(page.getByRole("radio", { name: `Nouveau client sans compte : ${email}` })).toBeChecked();
  await page.getByLabel("Nom complet").fill("Henri Comptoir");
  await page.getByLabel("Adresse", { exact: true }).fill("3 quai Saint-Antoine");
  await page.getByLabel("Code postal").fill("69002");
  await page.getByLabel("Ville").fill("Lyon");
  // Espèces par défaut, motif « Vente au comptoir » prérempli
  await expect(page.getByRole("radio", { name: "Espèces" })).toBeChecked();
  await expect(page.getByLabel("Motif de la vente")).toHaveValue("Vente au comptoir");
  await page.getByLabel("Référence").fill("Reçu 12");
  await page.getByRole("button", { name: `Enregistrer la vente · ${eur("520,00")}` }).click();

  // Facture hors chaîne, née payée, machine attribuée d'office
  await expect(page).toHaveURL(/\/backoffice\/factures\/[0-9a-f-]+\?fait=vente$/);
  const orderUrl = page.url().split("?")[0];
  await expect(page.getByRole("status").filter({ hasText: "Vente enregistrée : la facture est payée." })).toBeVisible();
  await expect(page.getByText("Vente manuelle saisie par l'admin n° 1 · motif : Vente au comptoir")).toBeVisible();
  await expect(page.getByText(/^Client sans compte · 1 machine/)).toBeVisible();
  await expect(page.getByRole("link", { name: serial })).toBeVisible();
  const payment = page.getByRole("region", { name: "Paiement hors chaîne" });
  await expect(payment).toContainText(eur("520,00"));
  await expect(payment).toContainText("Espèces · Reçu 12");
  await expect(page.getByText("Adresse de remboursement")).toHaveCount(0);

  // Rabais de 50 € : à rendre au client, « à traiter »
  await page.getByLabel("Montant du rabais").fill("50");
  await page.getByLabel("Explication").first().fill("Rayure sur le capot");
  await page.getByRole("button", { name: "Accorder un rabais…" }).click();
  await page.getByRole("dialog", { name: `Accorder un rabais de ${eur("50,00")} ?` }).getByRole("button", { name: "Accorder le rabais" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Rabais accordé" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "À traiter : Remboursement à rendre" })).toBeVisible();
  await expect(payment).toContainText(eur("50,00"));

  // « À traiter » : la facture y figure, montants en euros
  await page.getByRole("navigation", { name: "Backoffice" }).getByRole("link", { name: "À traiter" }).click();
  const attention = page.getByRole("row").filter({ hasText: batch.name });
  await expect(attention).toContainText("Remboursement à rendre");
  await expect(attention).toContainText(eur("520,00"));

  // « Remboursements » : hors chaîne, en euros, client sans compte ; remise enregistrée par référence seule
  await page.getByRole("navigation", { name: "Backoffice" }).getByRole("link", { name: "Remboursements" }).click();
  const row = page.getByRole("row").filter({ hasText: batch.name });
  await expect(row).toContainText("Hors chaîne");
  await expect(row).toContainText(eur("50,00"));
  await expect(row).toContainText("Client sans compte");
  await row.getByRole("button", { name: `Enregistrer l'envoi de ${eur("50,00")} au client sans compte` }).click();
  const dialog = page.getByRole("dialog", { name: "Enregistrer la remise du remboursement" });
  await expect(dialog.getByLabel("Adresse de destination")).toHaveCount(0);
  await dialog.getByLabel("Référence de la remise").fill("Espèces rendues, reçu 13");
  await dialog.getByRole("button", { name: "Enregistrer la remise" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Remise enregistrée : ${eur("50,00")} pour le client sans compte.` })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: batch.name })).toHaveCount(0);

  // La facture : remboursement rendu, plus rien à traiter
  await page.goto(orderUrl);
  await expect(page.getByRole("heading", { name: "Rien à traiter" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Remboursements" })).toContainText("Rendu le");
  await expect(page.getByRole("region", { name: "Remboursements" })).toContainText("Espèces rendues, reçu 13");
});

/**
 * Client avec compte bloqué sur une palette (abandons) : retrouvé par son e-mail, sa vente est refusée avec la levée
 * automatique ; « Lever le blocage et valider la vente » lève le blocage puis renvoie la même vente (virement).
 */
test("vente manuelle à un client bloqué : levée du blocage en un clic, puis la même vente", async ({ page, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer, "bloque");
  await blockCustomer(batch.id, customer);

  // Depuis la fiche du lot
  await page.goto(`/backoffice/lots/${batch.id}`);
  await page.getByRole("main").getByRole("link", { name: "Vente manuelle" }).click();
  await expect(page.getByLabel("Lot", { exact: true })).toHaveValue(batch.id);
  const email = profileEmailOf(customer);
  await page.getByLabel("E-mail du client").fill(email);
  await expect(page.getByRole("radio", { name: `${email} · Client n° ${customer}` })).toBeChecked();
  await page.getByLabel("Nombre de machines").fill("2");
  await page.getByText("Virement", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Virement" })).toBeChecked();
  await page.getByLabel("Référence").fill("VIR-2026-117");
  await page.getByRole("button", { name: `Enregistrer la vente · ${eur("3 600,00")}` }).click();

  const alert = page.getByRole("form", { name: "Vente manuelle" }).getByRole("alert");
  await expect(alert).toContainText("Ce client est bloqué sur ce lot jusqu'au");
  await alert.getByRole("button", { name: "Lever le blocage et valider la vente" }).click();

  await expect(page).toHaveURL(/\/backoffice\/factures\/[0-9a-f-]+\?fait=vente$/);
  await expect(page.getByText(new RegExp(`^Client n° ${customer} · 2 machines`))).toBeVisible();
  await expect(page.getByRole("region", { name: "Paiement hors chaîne" })).toContainText("Virement · VIR-2026-117");
  // Palette en précommande : les machines s'attribuent au Contrôle
  await expect(page.getByText("Aucune machine attribuée pour l'instant.")).toHaveCount(2);
  await me.dispose();
  await admin.dispose();
});
