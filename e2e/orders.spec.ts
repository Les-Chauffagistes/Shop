import { expect, test } from "@playwright/test";
import { signIn } from "./support/auth";
import { insertExpiredOrder } from "./support/db";
import {
  adminApi,
  apiAs,
  createBatch,
  eur,
  newCustomerId,
  placeOrder,
  receivePayment,
  refundAddress,
  sats,
  type OrderJson,
} from "./support/orders";

/**
 * Factures côté client (jalon 4) : commande, paiement simulé (point d'entrée interne du service de
 * paiement), annulation, renoncement, choix entre appoint et remboursement, accès. Le client agit dans
 * l'interface ; les lots et les versements sont préparés par l'API.
 */

test("parcours nominal : commander deux machines, payer, commande confirmée", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin);
  const customer = newCustomerId();
  await signIn(context, baseURL!, customer, "acheteur");

  // Fiche du lot ouvert aux commandes : l'action principale est « Commander »
  await page.goto("/");
  await page.getByRole("link", { name: batch.modelName }).click();
  await expect(page.getByRole("heading", { name: "Précommandes ouvertes" })).toBeVisible();
  await page.getByRole("link", { name: "Commander" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Commander" })).toBeVisible();

  // Machine 1 avec Silent kit, machine 2 par défaut
  const first = page.getByRole("region", { name: "Machine 1" });
  await first.getByRole("group", { name: "Kit de ventilation" }).getByRole("radio", { name: /^Silent kit/ }).check();
  await page.getByRole("button", { name: "Ajouter une machine" }).click();
  await expect(page.getByRole("region", { name: "Machine 2" })).toBeVisible();
  await expect(page.getByText(eur("3 675,00"))).toBeVisible();

  // Adresse incomplète : le serveur répond champ par champ, l'erreur reçoit le focus
  await page.getByLabel("Nom complet").fill("Alice Martin");
  await page.getByRole("button", { name: "Créer la facture" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Certaines données envoyées sont invalides." });
  await expect(alert.locator("..")).toBeFocused();

  await page.getByLabel("Adresse", { exact: true }).fill("1 rue de la Paix");
  await page.getByLabel("Code postal").fill("69001");
  await page.getByLabel("Ville").fill("Lyon");
  await page.getByRole("button", { name: "Créer la facture" }).click();

  // Facture : adresse de paiement, montant, réservation
  await page.waitForURL(/\/mes-commandes\/[0-9a-f-]+\?nouvelle=1$/);
  await expect(page.getByRole("heading", { name: "Payer en bitcoins" })).toBeVisible();
  await expect(page.getByText("Facture créée")).toBeVisible();
  await expect(page.getByText("Machines réservées jusqu'à")).toBeVisible();
  const orderId = new URL(page.url()).pathname.split("/").pop()!;
  const me = await apiAs(baseURL!, customer);
  const order: OrderJson = await (await me.get(`/api/orders/${orderId}`)).json();
  await expect(page.getByText(order.payment.address)).toBeVisible();
  await expect(page.getByText(sats("4 083 334")).first()).toBeVisible(); // 3 675 € à 90 000 €, arrondi au sat supérieur

  // Paiement complet reçu : « Actualiser » montre la commande confirmée
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);
  await page.getByRole("button", { name: "Actualiser" }).click();
  await expect(page.getByRole("heading", { name: "Commande confirmée" })).toBeVisible();
  await expect(page.getByText("Payée", { exact: true })).toBeVisible();

  // Mes commandes
  await page.getByRole("navigation", { name: "Boutique" }).getByRole("link", { name: "Mes commandes" }).click();
  await expect(page.getByRole("link", { name: batch.name })).toBeVisible();
  await me.dispose();
  await admin.dispose();
});

test("annuler une facture impayée", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin);
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  const order = await placeOrder(me, batch.id);
  await signIn(context, baseURL!, customer, "hesitant");

  await page.goto(`/mes-commandes/${order.id}`);
  await page.getByRole("button", { name: "Annuler la facture" }).click();
  const dialog = page.getByRole("dialog", { name: "Annuler cette facture ?" });
  await dialog.getByRole("button", { name: "Annuler la facture" }).click();
  await expect(page.getByRole("heading", { name: "Facture annulée" })).toBeVisible();
  await expect(page.getByText("Facture annulée : les machines réservées sont libérées.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Annuler la facture" })).toHaveCount(0);

  // Juste après un abandon, la page de commande affiche le délai donné par le serveur
  await page.goto(`/lots/${batch.id}/commander`);
  await expect(page.getByRole("note").filter({ hasText: "vous pourrez en créer une nouvelle à" })).toBeVisible();
  await me.dispose();
  await admin.dispose();
});

test("renoncer à une machine d'une commande payée : frais à la charge du client", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin);
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  const order = await placeOrder(me, batch.id, { lines: 2, refund: refundAddress() });
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);
  await signIn(context, baseURL!, customer, "renonce");

  await page.goto(`/mes-commandes/${order.id}`);
  const renounce = page.getByRole("form", { name: "Renoncer à ma commande" });
  await expect(renounce.getByRole("note")).toContainText("Les frais du réseau Bitcoin de ce remboursement sont à votre charge");
  await renounce.getByLabel("Certaines machines").check();
  await renounce.getByLabel("Machine 1").check();
  await renounce.getByRole("button", { name: "Renoncer…" }).click();
  const dialog = page.getByRole("dialog", { name: "Renoncer à 1 machine ?" });
  await dialog.getByRole("button", { name: "Confirmer le renoncement" }).click();

  await expect(page.getByText("Renoncement enregistré")).toBeVisible();
  const refunds = page.getByRole("region", { name: "Remboursements" });
  await expect(refunds.getByText("Renoncement de l'utilisateur")).toBeVisible();
  await expect(refunds.getByText("à la charge de l'utilisateur")).toBeVisible();
  // 4 000 000 sats pour deux machines : moitié moins 2 000 sats de frais
  await expect(refunds.getByText(sats("1 998 000"))).toBeVisible();
  await expect(page.getByText("Annulée et remboursée")).toHaveCount(1);
  await me.dispose();
  await admin.dispose();
});

test("paiement partiel expiré : le client choisit le remboursement de son versement", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const { orderId, paymentAddress } = await insertExpiredOrder(batch.id, customer);
  await receivePayment(baseURL!, paymentAddress, "40000");
  await signIn(context, baseURL!, customer, "partiel");

  await page.goto(`/mes-commandes/${orderId}`);
  await expect(page.getByRole("heading", { name: "Votre choix est attendu" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Compléter le paiement" })).toBeVisible();
  await expect(page.getByText(sats("60 000")).first()).toBeVisible();

  await page.getByRole("button", { name: "Me faire rembourser mon versement" }).click();
  const dialog = page.getByRole("dialog", { name: "Vous faire rembourser ?" });
  await expect(dialog).toContainText("Les frais du réseau Bitcoin de ce remboursement sont à votre charge");
  // Adresse mal formée : message du serveur sous le champ
  await dialog.getByLabel("Adresse Bitcoin de remboursement").fill("pas-une-adresse");
  await dialog.getByRole("button", { name: "Demander le remboursement" }).click();
  await expect(dialog.getByText("Adresse Bitcoin attendue").first()).toBeVisible();
  await dialog.getByLabel("Adresse Bitcoin de remboursement").fill(refundAddress());
  await dialog.getByRole("button", { name: "Demander le remboursement" }).click();

  await expect(page.getByRole("heading", { name: "Commande remboursée" })).toBeVisible();
  const refunds = page.getByRole("region", { name: "Remboursements" });
  await expect(refunds.getByText("Remboursement d'un paiement partiel")).toBeVisible();
  await expect(refunds.getByText(sats("38 000"))).toBeVisible();
  await admin.dispose();
});

test("paiement partiel expiré : l'appoint complète la commande", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const { orderId, paymentAddress } = await insertExpiredOrder(batch.id, customer);
  await receivePayment(baseURL!, paymentAddress, "40000");
  await signIn(context, baseURL!, customer, "appoint");

  await page.goto(`/mes-commandes/${orderId}`);
  await expect(page.getByText(paymentAddress)).toBeVisible();
  await receivePayment(baseURL!, paymentAddress, "60000");
  await page.getByRole("button", { name: "Actualiser" }).click();
  await expect(page.getByRole("heading", { name: "Commande confirmée" })).toBeVisible();
  await admin.dispose();
});

test("la facture d'un autre client est introuvable", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin);
  const owner = await apiAs(baseURL!, newCustomerId());
  const order = await placeOrder(owner, batch.id);

  await signIn(context, baseURL!, newCustomerId(), "curieux");
  for (const path of [`/mes-commandes/${order.id}`, `/mes-commandes/${crypto.randomUUID()}`, "/mes-commandes/zzz"]) {
    expect((await page.goto(path))?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Cette page n'existe pas" })).toBeVisible();
  }
  await page.goto("/mes-commandes");
  await expect(page.getByRole("heading", { name: "Aucune commande pour l'instant" })).toBeVisible();
  expect((await page.request.get(`/api/orders/${order.id}`)).status()).toBe(404);
  expect((await owner.get(`/api/orders/${order.id}`)).status()).toBe(200);
  await owner.dispose();
  await admin.dispose();
});

test("« Mes commandes » sans connexion renvoie vers la connexion", async ({ request }) => {
  const response = await request.get("/mes-commandes", { maxRedirects: 0 });
  expect([303, 307, 308]).toContain(response.status());
});

test("machine souhaitée : « Commander » depuis « Mes intérêts », priorité annoncée et reprise", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { path: ["survey"] });
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  expect((await me.post("/api/wishlists", { data: { batchId: batch.id, choices: [], quantity: 1 } })).status()).toBe(201);
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "survey", to: "preorder" } })).status()).toBe(201);
  await signIn(context, baseURL!, customer, "prioritaire");

  await page.goto("/mes-interets");
  const lot = page.getByRole("region", { name: new RegExp(batch.name) });
  // Retirer pendant la journée de priorité : la perte de priorité est annoncée
  await lot.getByRole("button", { name: /^Retirer/ }).click();
  const dialog = page.getByRole("dialog", { name: "Retirer cette machine de vos intérêts ?" });
  await expect(dialog.getByRole("note")).toContainText("Vous perdrez la priorité pour cette machine");
  await dialog.getByRole("button", { name: "Garder" }).click();

  await lot.getByRole("link", { name: `Commander sur ${batch.name}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Commander" })).toBeVisible();
  await expect(page.getByRole("note").filter({ hasText: "Journée de priorité jusqu'au" })).toContainText("1 machine en priorité");
  await expect(page.getByRole("region", { name: "Machine 1" }).getByText("Machine souhaitée")).toBeVisible();
  await me.dispose();
  await admin.dispose();
});
