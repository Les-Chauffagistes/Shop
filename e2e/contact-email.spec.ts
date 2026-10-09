import { expect, test, type Page } from "@playwright/test";
import { profileEmailOf, signIn } from "./support/auth";
import { adminApi, apiAs, createBatch, newCustomerId, placeOrder } from "./support/orders";

/**
 * E-mail de contact (v5i/v5j/v5k) : vue profil, champ e-mail du formulaire de commande (prérempli par le
 * profil, obligatoire sans lui), e-mail figé sur la facture, e-mails du client au backoffice (liens mailto).
 */

/** Adresse de facturation saisie dans le formulaire de commande (nouveau client : aucune adresse enregistrée). */
async function fillBilling(page: Page) {
  await page.getByLabel("Nom complet").fill("Alice Martin");
  await page.getByLabel("Adresse", { exact: true }).fill("1 rue de la Paix");
  await page.getByLabel("Code postal").fill("69001");
  await page.getByLabel("Ville").fill("Lyon");
}

test("profil : l'e-mail se voit et se change ; vide ou mal formé, le message du serveur s'affiche", async ({ page, context, baseURL }) => {
  const customer = newCustomerId();
  await signIn(context, baseURL!, customer, "profil-e2e");

  await page.goto("/");
  await page.getByRole("link", { name: "Mon profil" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Mon profil" })).toBeVisible();
  const email = page.getByLabel("Adresse e-mail");
  await expect(email).toHaveValue(profileEmailOf(customer));

  // Format refusé par la base : message sous le champ, qui reçoit le focus
  await email.fill("pas-un-email");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(email).toHaveAccessibleDescription(/Adresse e-mail invalide/);
  await expect(email).toBeFocused();

  // On ne l'efface pas : l'UI envoie, le serveur refuse
  await email.fill("");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(email).toHaveAccessibleDescription(/vous pouvez la changer, pas l'effacer/);

  const next = `nouveau-${customer}@exemple.fr`;
  await email.fill(next);
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Adresse e-mail enregistrée." })).toBeVisible();
  expect(await (await page.request.get("/api/profile")).json()).toEqual({ email: next });
  await page.reload();
  await expect(page.getByLabel("Adresse e-mail")).toHaveValue(next);
});

test("le profil exige la connexion (redirection du proxy)", async ({ request }) => {
  const response = await request.get("/profil", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(decodeURIComponent(response.headers().location)).toContain("redirect=http://localhost:3100/profil");
});

test("commande : e-mail prérempli par le profil ; une autre adresse est annoncée, mémorisée sur le profil et figée sur la facture", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  await signIn(context, baseURL!, customer, "email-commande");

  await page.goto(`/lots/${batch.id}/commander`);
  const email = page.getByLabel("Adresse e-mail", { exact: true });
  await expect(email).toHaveValue(profileEmailOf(customer));
  await expect(page.getByText("remplacera celle de votre profil")).toHaveCount(0);

  await fillBilling(page);
  await email.fill("pas un e-mail");
  await page.getByRole("button", { name: "Créer la facture" }).click();
  await expect(email).toHaveAccessibleDescription(/Adresse e-mail invalide/);

  const other = `autre-${customer}@exemple.fr`;
  await email.fill(other);
  await expect(page.getByText(`remplacera celle de votre profil (${profileEmailOf(customer)})`)).toBeVisible();
  await page.getByRole("button", { name: "Créer la facture" }).click();
  await page.waitForURL(/\/mes-commandes\/[0-9a-f-]+\?nouvelle=1$/);
  await expect(page.getByRole("region", { name: "E-mail de contact" })).toContainText(other);
  expect(await (await page.request.get("/api/profile")).json()).toEqual({ email: other });
  await admin.dispose();
});

test("commande sans e-mail au profil : le serveur le réclame, puis la facture est créée et le profil rempli", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  await signIn(context, baseURL!, customer, "sans-email", { withEmail: false });
  expect(await (await page.request.get("/api/profile")).json()).toEqual({ email: null });

  await page.goto(`/lots/${batch.id}/commander`);
  const email = page.getByLabel("Adresse e-mail", { exact: true });
  await expect(email).toHaveValue("");
  await expect(email).toHaveAccessibleDescription(/enregistrée sur votre profil/);
  await fillBilling(page);
  await page.getByRole("button", { name: "Créer la facture" }).click();
  await expect(email).toHaveAccessibleDescription(/Indiquez une adresse e-mail/);
  // Dit une seule fois (sous le champ, qui reçoit le focus), sans alerte en double
  await expect(email).toBeFocused();
  await expect(page.getByText("Indiquez une adresse e-mail")).toHaveCount(1);

  const mine = `premier-${customer}@exemple.fr`;
  await email.fill(mine);
  await page.getByRole("button", { name: "Créer la facture" }).click();
  await page.waitForURL(/\/mes-commandes\/[0-9a-f-]+\?nouvelle=1$/);
  await expect(page.getByRole("region", { name: "E-mail de contact" })).toContainText(mine);

  await page.goto("/profil");
  await expect(page.getByLabel("Adresse e-mail")).toHaveValue(mine);
  await admin.dispose();
});

test("backoffice : e-mail de la facture et e-mail actuel du profil en liens mailto", async ({ page, context, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = newCustomerId();
  const me = await apiAs(baseURL!, customer);
  const order = await placeOrder(me, batch.id);
  const changed = `change-${customer}@exemple.fr`;
  expect((await me.patch("/api/profile", { data: { email: changed } })).status()).toBe(200);

  await signIn(context, baseURL!);
  await page.goto(`/backoffice/factures/${order.id}`);
  const contact = page.getByRole("region", { name: "Contact" });
  await expect(contact.getByRole("link", { name: profileEmailOf(customer) })).toHaveAttribute("href", `mailto:${profileEmailOf(customer)}`);
  await expect(contact.getByRole("link", { name: changed })).toHaveAttribute("href", `mailto:${changed}`);
  await expect(contact).toContainText("Profil (actuel)");
  await me.dispose();
  await admin.dispose();
});
