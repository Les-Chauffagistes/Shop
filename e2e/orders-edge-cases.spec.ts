import { expect, test } from "@playwright/test";
import { signIn } from "./support/auth";
import { retireOptionValue } from "./support/db";
import { adminApi, apiAs, createBatch, newCustomerId, placeOrder, receivePayment, refundAddress, sats } from "./support/orders";

/**
 * Cas limites des factures (revue qualité du jalon 4, décisions de Hugo du 2026-10-09) : lot annulé avec une
 * facture impayée, excédent jamais remboursé d'office, paiement reçu après un remboursement intégral,
 * messages des formulaires de l'admin, états affichés au client (renoncement fermé, lot épuisé, option retirée).
 * Promus des scénarios des testeurs (e2e/customer et e2e/logistician, non lancés par `npm run e2e`).
 */

test("lot annulé : la facture impayée est annulée, le versement reçu ensuite est « à traiter » et le client le voit", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  const order = await placeOrder(me, batch.id, { lines: 2 });
  await signIn(context, baseURL!, customer, "lot-annule");

  await page.goto(`/mes-commandes/${order.id}`);
  await expect(page.getByRole("heading", { name: "Payer en bitcoins" })).toBeVisible();

  expect((await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "preorder", to: "cancelled", note: "Lot abandonné" } })).status()).toBe(201);

  // Plus de paiement proposé : ni adresse, ni compte à rebours, ni « remboursé automatiquement »
  await page.reload();
  await expect(page.getByRole("heading", { name: "Lot annulé" })).toBeVisible();
  await expect(page.getByText("Annulée", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payer en bitcoins" })).toHaveCount(0);
  await expect(page.getByText(order.payment.address)).toHaveCount(0);
  await expect(page.getByText(/rembours.* automatiquement/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Voir le lot" })).toHaveCount(0);

  // Le client paie quand même : rien d'automatique, l'équipe traite
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);
  await page.reload();
  await expect(page.getByText("votre versement est traité par notre équipe")).toBeVisible();
  const detail = await (await me.get(`/api/orders/${order.id}`)).json();
  expect(detail.refunds).toEqual([]);

  // Admin : « à traiter », on rembourse (frais de la boutique) ; l'adresse de paiement et la facture restent
  await signIn(context, baseURL!);
  await page.goto("/backoffice/a-traiter");
  await page.getByRole("row").filter({ hasText: batch.name }).getByRole("link", { name: "Décision de la boutique" }).click();
  await expect(page.getByText("lot qui n'accepte plus de commande")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accepter la commande" })).toHaveCount(0);

  // Formulaire incomplet : pas de confirmation, des messages lisibles, deux libellés distincts
  const refund = page.getByRole("form", { name: "Rembourser" });
  await refund.getByRole("button", { name: "Rembourser…" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const alert = refund.getByRole("alert");
  await expect(alert).toContainText("Motif : Choisissez l'un des motifs proposés");
  await expect(alert).toContainText("Explication : Explication obligatoire");
  await expect(alert).not.toContainText(/Option invalide|shop_stock|attendue/);

  await refund.getByRole("radio", { name: /Souci de stock/ }).check();
  await refund.getByLabel("Explication").fill("Lot abandonné : versement rendu");
  await refund.getByRole("button", { name: "Rembourser…" }).click();
  await page.getByRole("dialog", { name: "Rembourser cette facture ?" }).getByRole("button", { name: "Rembourser" }).click();
  await expect(page.getByText("Remboursement créé")).toBeVisible();
  await me.dispose();
  await admin.dispose();
});

test("excédent : jamais remboursé d'office ; le client est prévenu, l'admin ne se voit proposer que les motifs applicables", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);

  // Petit excédent (1 500 sats, frais 2 000) et grand excédent (50 000 sats)
  const small = await placeOrder(me, batch.id);
  await receivePayment(baseURL!, small.payment.address, String(BigInt(small.payment.expectedSats) + 1_500n));
  await signIn(context, baseURL!, customer, "petit-exces");
  await page.goto(`/mes-commandes/${small.id}`);
  await expect(page.getByRole("heading", { name: "Commande confirmée" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Un versement est en cours de traitement" })).toBeVisible();
  await expect(page.getByText("Rien n'est remboursé automatiquement")).toBeVisible();
  await expect(page.getByRole("region", { name: "Remboursements" })).toContainText("Aucun remboursement.");

  const big = await placeOrder(await apiAs(baseURL!, newCustomerId()), batch.id);
  await receivePayment(baseURL!, big.payment.address, String(BigInt(big.payment.expectedSats) + 50_000n));
  const bigRefunds = await (await (await apiAs(baseURL!, "1", "admin-e2e")).get(`/api/backoffice/orders/${big.id}`)).json();
  expect(bigRefunds.refunds).toEqual([]);
  expect(bigRefunds.attention.reason).toBe("overpayment_decision");

  await signIn(context, baseURL!);
  // Petit excédent : « Excédent de paiement » (frais à l'utilisateur) n'est pas proposé
  await page.goto(`/backoffice/factures/${small.id}`);
  const smallForm = page.getByRole("form", { name: "Rembourser" });
  await expect(smallForm.getByRole("radio", { name: /Autre décision de la boutique/ })).toBeVisible();
  await expect(smallForm.getByRole("radio", { name: /Excédent de paiement/ })).toHaveCount(0);
  // Grand excédent : les deux motifs, avec le payeur des frais
  await page.goto(`/backoffice/factures/${big.id}`);
  const bigForm = page.getByRole("form", { name: "Rembourser" });
  await expect(bigForm.getByRole("radio", { name: /Excédent de paiement/ })).toBeVisible();
  await expect(bigForm.getByRole("radio", { name: /Autre décision de la boutique/ })).toBeVisible();
  await me.dispose();
  await admin.dispose();
});

test("paiement reçu après un remboursement intégral : le client voit un message, pas un « Remboursée » muet", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  const order = await placeOrder(me, batch.id, { lines: 2, refund: refundAddress() });
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);

  // Annuler des machines sans en cocher aucune : pas de « Annuler 0 machine ? », un message lisible
  await signIn(context, baseURL!);
  await page.goto(`/backoffice/factures/${order.id}`);
  const cancel = page.getByRole("form", { name: "Annuler des machines" });
  await cancel.getByRole("button", { name: "Annuler les machines…" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cancel.getByRole("alert")).toContainText("Machines : Cochez au moins une machine");
  await expect(cancel.getByRole("alert")).toContainText("Explication : Explication obligatoire");
  await expect(cancel.getByRole("alert")).not.toContainText(/Trop petit|tableau/);

  // Remboursement intégral, puis un nouveau versement
  expect((await admin.post(`/api/backoffice/orders/${order.id}/cancel-lines`, { data: { reason: "Stock", cause: "shop_stock" } })).status()).toBe(200);
  await receivePayment(baseURL!, order.payment.address, "3000000");
  await signIn(context, baseURL!, customer, "apres-remboursement");
  await page.goto(`/mes-commandes/${order.id}`);
  await expect(page.getByText("Remboursée", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Un versement est en cours de traitement" })).toBeVisible();
  await expect(page.getByText(`Un paiement de ${sats("3 000 000")} est arrivé après le remboursement`)).toBeVisible();
  await me.dispose();
  await admin.dispose();
});

test("après « Commande en cours », « Renoncer » disparaît : la page dit de contacter l'équipe", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  const order = await placeOrder(me, batch.id);
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);
  await signIn(context, baseURL!, customer, "renoncement-ferme");

  await page.goto(`/mes-commandes/${order.id}`);
  await expect(page.getByRole("heading", { name: "Renoncer à ma commande" })).toBeVisible();
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "preorder", to: "ordering" } })).status()).toBe(201);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Renoncer à ma commande" })).toHaveCount(0);
  await expect(page.getByText("Contactez-nous si vous souhaitez l'annuler")).toBeVisible();
  await me.dispose();
  await admin.dispose();
});

test("lot épuisé : « Épuisé » affiché, « Commander » reste proposé, le serveur refuse", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const holder = await apiAs(baseURL!, newCustomerId());
  await placeOrder(holder, batch.id, { lines: 10 });
  await signIn(context, baseURL!, newCustomerId(), "retardataire");

  await page.goto("/");
  const card = page.getByRole("listitem").filter({ hasText: batch.modelName });
  await expect(card.getByText("Épuisé", { exact: true })).toBeVisible();
  await page.goto(`/lots/${batch.id}`);
  await expect(page.getByRole("heading", { name: "Lot épuisé" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Commander" })).toBeVisible();
  const refused = await page.request.post("/api/orders", {
    data: { batchId: batch.id, lines: [{}], billingAddress: { fullName: "A B", line1: "1 rue", postalCode: "69001", city: "Lyon", country: "FR" } },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("out_of_stock");
  await holder.dispose();
  await admin.dispose();
});

// v5j (décision Hugo 2026-10-09) : au retrait, la wishlist revient tout de suite à la valeur par défaut du menu. L'avertissement
// (journal WishlistOptionWithdrawal, `optionWithdrawals`) reste à afficher par l'UI : assertion à compléter par frontend-dev.
test("option retirée du lot après la manifestation d'intérêt : la wishlist revient au défaut dans « Mes intérêts »", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { path: ["survey"] });
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  const kit = await (await me.get(`/api/shop/batches/${batch.id}`)).json();
  const menu = kit.options.find((o: { title: string }) => o.title === "Kit de ventilation");
  const silent = menu.values.find((v: { label: string }) => v.label === "Silent kit");
  expect((await me.post("/api/wishlists", { data: { batchId: batch.id, choices: [{ optionId: menu.id, optionValueId: silent.id }] } })).status()).toBe(201);
  await signIn(context, baseURL!, customer, "option-retiree");

  await page.goto("/mes-interets");
  const lot = page.getByRole("region", { name: new RegExp(batch.name) });
  await expect(lot.getByText("Silent kit")).toBeVisible();
  await expect(lot.getByText("n'est plus proposée")).toHaveCount(0);

  await retireOptionValue(batch.id, silent.id);
  await page.reload();
  await expect(lot.getByText("Silent kit")).toHaveCount(0);
  await expect(lot.getByText("n'est plus proposée")).toHaveCount(0);
  await me.dispose();
  await admin.dispose();
});

test("la page de commande d'un lot exige la connexion (redirection du proxy, comme « Mes commandes »)", async ({ request }) => {
  for (const path of ["/lots/00000000-0000-4000-8000-000000000000/commander", "/mes-commandes/00000000-0000-4000-8000-000000000000"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(307);
    expect(decodeURIComponent(response.headers().location), path).toContain(`redirect=http://localhost:3100${path}`);
  }
});
