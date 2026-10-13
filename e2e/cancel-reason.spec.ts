import { expect, test, type Locator } from "@playwright/test";
import { signIn } from "./support/auth";
import { adminApi, apiAs, createBatch, newCustomerId, placeOrder, receivePayment, sats } from "./support/orders";

/**
 * Décisions de Hugo du 2026-10-13 (v5l) côté écrans : la cause d'annulation vient de `cancelReason`
 * (jamais de l'état du lot), le surplus resté et le versement arrivé après le remboursement viennent
 * des montants de l'API (aucune comparaison de dates), « Classer sans suite » passe en premier quand
 * l'excédent ne dépasse pas les frais, et la grille « À traiter » tient à 1280 px.
 */

/** Factures de Dave dans le seed (lot E « 3 S19 » annulé, prisma/seed.ts). */
const DAVE = "1004";
const DAVE_RENOUNCED = "5e1d0000-0000-4000-8000-000000000806";
const DAVE_CLOSED = "5e1d0000-0000-4000-8000-000000000807";

/** `first` précède `second` dans le document. */
async function precedes(first: Locator, second: Locator) {
  const handle = await second.elementHandle();
  return first.evaluate((a, b) => !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, handle);
}

test("client qui annule puis lot qui ferme : « Facture annulée » ; facture annulée par le lot : « Lot annulé » ; cause au backoffice", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const early = newCustomerId();
  const late = newCustomerId();
  const cancelledByUser = await placeOrder(await apiAs(baseURL!, early), batch.id);
  const cancelledByBatch = await placeOrder(await apiAs(baseURL!, late), batch.id);
  const earlyApi = await apiAs(baseURL!, early);
  expect((await earlyApi.post(`/api/orders/${cancelledByUser.id}/cancel`, { data: {} })).status()).toBe(200);
  expect(
    (await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { from: "preorder", to: "cancelled", note: "Fournisseur défaillant" } })).status(),
  ).toBe(201);

  await signIn(context, baseURL!, early, "annule-avant");
  await page.goto(`/mes-commandes/${cancelledByUser.id}`);
  await expect(page.getByRole("heading", { name: "Facture annulée", exact: true })).toBeVisible();
  await expect(page.getByText("Vous avez annulé cette facture")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lot annulé" })).toHaveCount(0);

  await signIn(context, baseURL!, late, "annule-par-lot");
  await page.goto(`/mes-commandes/${cancelledByBatch.id}`);
  await expect(page.getByRole("heading", { name: "Lot annulé" })).toBeVisible();
  await expect(page.getByText("Ce lot a été annulé : votre facture est annulée")).toBeVisible();

  // Un versement arrive ensuite sur chacune : « À traiter » montre qui avait annulé, sans le déduire du lot
  await receivePayment(baseURL!, cancelledByUser.payment.address, "5000");
  await receivePayment(baseURL!, cancelledByBatch.payment.address, "5000");
  await signIn(context, baseURL!);
  await page.goto("/backoffice/a-traiter");
  await expect(page.locator(`.ag-row[row-id="${cancelledByUser.id}"]`).first()).toContainText("Annulée par le client");
  await expect(page.locator(`.ag-row[row-id="${cancelledByBatch.id}"]`).first()).toContainText("Annulée par la fermeture du lot");
  await page.goto(`/backoffice/factures/${cancelledByUser.id}`);
  await expect(page.getByText(/^Annulée par le client le /)).toBeVisible();
  await page.goto(`/backoffice/factures/${cancelledByBatch.id}`);
  await expect(page.getByText(/^Annulée par la fermeture du lot le /)).toBeVisible();
  await earlyApi.dispose();
  await admin.dispose();
});

test("seed de Dave : surplus resté et versement après le remboursement affichés ensemble ; facture annulée par le lot", async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL!, DAVE, "dave", { withEmail: false });
  await page.goto(`/mes-commandes/${DAVE_RENOUNCED}`);
  await expect(page.getByRole("heading", { name: "Commande remboursée" })).toBeVisible();
  await expect(page.getByText("Le prix de la commande vous est remboursé")).toBeVisible();
  const review = page.getByRole("region", { name: "Deux versements sont en cours de traitement" });
  await expect(review).toContainText(`Vous aviez envoyé ${sats("1 000")} de plus que le montant de la commande`);
  await expect(review).toContainText(`Un paiement de ${sats("3 000")} est arrivé après le remboursement`);

  await page.goto(`/mes-commandes/${DAVE_CLOSED}`);
  await expect(page.getByRole("heading", { name: "Lot annulé" })).toBeVisible();

  await signIn(context, baseURL!);
  await page.goto(`/backoffice/factures/${DAVE_RENOUNCED}`);
  const paid = page.getByRole("region", { name: "Paiement" });
  await expect(paid.getByRole("term").filter({ hasText: "Surplus resté" }).locator("..")).toContainText(sats("1 000"));
  await expect(paid.getByRole("term").filter({ hasText: "Versé après le remboursement" }).locator("..")).toContainText(sats("3 000"));
  await page.goto(`/backoffice/factures/${DAVE_CLOSED}`);
  await expect(page.getByText(/^Annulée par la fermeture du lot le /)).toBeVisible();
});

test("excédent au plus égal aux frais : « Classer sans suite » passe en premier ; au-delà, « Rembourser » reste principal", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const small = await placeOrder(await apiAs(baseURL!, newCustomerId()), batch.id);
  await receivePayment(baseURL!, small.payment.address, String(BigInt(small.payment.expectedSats) + 1_500n));
  const big = await placeOrder(await apiAs(baseURL!, newCustomerId()), batch.id);
  await receivePayment(baseURL!, big.payment.address, String(BigInt(big.payment.expectedSats) + 50_000n));

  await signIn(context, baseURL!);
  await page.goto(`/backoffice/factures/${small.id}`);
  const dismiss = page.getByRole("form", { name: "Classer sans suite" });
  const refund = page.getByRole("form", { name: "Rembourser" });
  await expect(dismiss).toBeVisible();
  await expect(refund).toBeVisible();
  expect(await precedes(dismiss, refund)).toBe(true);
  await expect(dismiss.getByRole("button", { name: "Classer sans suite…" })).toHaveClass(/bo-btn-primary/);
  await expect(refund.getByRole("button", { name: "Rembourser…" })).toHaveClass(/bo-btn-secondary/);

  await page.goto(`/backoffice/factures/${big.id}`);
  await expect(page.getByRole("form", { name: "Rembourser" }).getByRole("button", { name: "Rembourser…" })).toHaveClass(/bo-btn-primary/);
  await expect(page.getByRole("form", { name: "Classer sans suite" })).toHaveCount(0);
  await admin.dispose();
});

test("« À traiter » à 1280 px : pas de défilement horizontal, « Facture » et « Client » épinglées", async ({ page, context, baseURL }) => {
  /** Largeur que la grille ferait défiler horizontalement (0 : tout tient). */
  const overflow = () =>
    page.locator(".ag-body-horizontal-scroll-viewport").evaluate((el) => el.scrollWidth - el.clientWidth);
  await signIn(context, baseURL!);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/backoffice/a-traiter");
  await expect(page.getByRole("region", { name: "Factures à traiter" })).toBeVisible();
  const facture = page.locator('.ag-header-cell[col-id="status"]');
  const client = page.locator('.ag-header-cell[col-id="user"]');
  await expect(facture).toHaveText("Facture");
  await expect(client).toHaveClass(/ag-header-cell-last-left-pinned/);
  expect((await facture.boundingBox())!.x).toBeLessThan((await client.boundingBox())!.x);
  expect(await overflow()).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  // Témoin : plus étroite, la grille défile (la mesure ci-dessus détecte bien un défilement)
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(overflow).toBeGreaterThan(1);
});
