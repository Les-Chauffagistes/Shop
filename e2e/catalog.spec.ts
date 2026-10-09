import { expect, test } from "@playwright/test";
import { signIn, unique } from "./support/auth";

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test("créer un modèle avec un menu d'options ; le défaut reste gratuit (Avec/Sans : « Sans » toujours)", async ({ page }) => {
  const modelName = unique("S21");
  await page.goto("/backoffice/modeles");
  await page.getByRole("link", { name: "Nouveau modèle" }).click();

  await page.getByLabel("Nom du modèle").fill(modelName);
  await page.getByLabel("Hashrate théorique").fill("200");
  await page.getByLabel("Nombre de hashboards").fill("3");
  await page.getByLabel("Description").fill("Antminer S21, refroidissement air.");
  await page.getByRole("button", { name: "Créer le modèle" }).click();

  await expect(page.getByRole("heading", { level: 1, name: modelName })).toBeVisible();
  await expect(page.getByText("200 TH/s · 3 hashboards")).toBeVisible();

  // Menu « Choix entre options » avec trois valeurs (specs.md, exemple 1)
  await page.getByRole("button", { name: "Créer un menu d'options" }).click();
  await page.getByLabel("Titre").fill("Kit de ventilation");
  await page.getByLabel("Description").last().fill("Choisissez le type de ventilation");
  await page.getByLabel("Libellé de la valeur 1").fill("Sans kit");
  await page.getByLabel("Prix de la valeur 1").fill("0");
  await page.getByLabel("Libellé de la valeur 2").fill("Air Flow");
  await page.getByLabel("Prix de la valeur 2").fill("35");
  await page.getByRole("button", { name: "Ajouter une valeur" }).click();
  await page.getByLabel("Libellé de la valeur 3").fill("Silent kit");
  await page.getByLabel("Prix de la valeur 3").fill("75,50");

  // Défaut payant refusé avant l'envoi
  await page.getByLabel("Valeur 2 par défaut").check();
  await page.getByRole("button", { name: "Créer le menu" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "La valeur par défaut est toujours gratuite" })).toBeVisible();
  await page.getByLabel("Valeur 1 par défaut").check();
  await page.getByRole("button", { name: "Créer le menu" }).click();

  const menu = page.getByRole("article", { name: "Kit de ventilation" });
  await expect(menu).toBeVisible();
  const rows = menu.getByRole("row");
  await expect(rows.filter({ hasText: "Sans kit" })).toContainText("Par défaut");
  await expect(rows.filter({ hasText: "Silent kit" })).toContainText("75,50");

  // Une valeur payante ne devient le défaut qu'en passant à 0 €, après confirmation
  await menu.getByRole("button", { name: "Définir « Air Flow » par défaut" }).click();
  const dialog = page.getByRole("dialog", { name: "Faire de « Air Flow » la valeur par défaut ?" });
  await expect(dialog).toContainText("Son prix passera de 35,00 € à 0,00 €");
  await dialog.getByRole("button", { name: "Annuler" }).click();
  await expect(rows.filter({ hasText: "Sans kit" })).toContainText("Par défaut");
  await menu.getByRole("button", { name: "Définir « Air Flow » par défaut" }).click();
  await dialog.getByRole("button", { name: "Passer à 0 € et définir par défaut" }).click();
  await expect(dialog).toBeHidden();
  await expect(rows.filter({ hasText: "Air Flow" })).toContainText("Par défaut");
  await expect(rows.filter({ hasText: "Air Flow" })).toContainText("0,00");
  await expect(rows.filter({ hasText: "Sans kit" })).not.toContainText("Par défaut");

  // Une valeur gratuite redevient le défaut en un clic
  await menu.getByRole("button", { name: "Définir « Sans kit » par défaut" }).click();
  await expect(rows.filter({ hasText: "Sans kit" })).toContainText("Par défaut");

  // Modifier la valeur par défaut avec un prix : refusé avant l'envoi
  await menu.getByRole("button", { name: "Modifier la valeur Sans kit" }).click();
  await menu.getByLabel("Prix", { exact: true }).fill("10");
  await menu.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(menu.getByText("La valeur par défaut est toujours gratuite : prix 0.")).toBeVisible();
  await menu.getByRole("button", { name: "Annuler" }).click();

  // Un menu Avec/Sans
  await page.getByRole("button", { name: "Nouveau menu" }).click();
  await page.getByText("Avec / Sans", { exact: true }).click();
  await expect(page.getByText("Sélectionnée par défaut")).toHaveCount(0);
  await expect(page.getByText("« Sans » est toujours la valeur par défaut, gratuite.")).toBeVisible();
  await page.getByLabel("Titre").fill("Nettoyage");
  await page.getByLabel("Prix de l'option « Avec »").fill("20");
  await page.getByRole("button", { name: "Créer le menu" }).click();
  const toggle = page.getByRole("article", { name: "Nettoyage" });
  await expect(toggle.getByRole("row").filter({ hasText: "Sans" }).first()).toContainText("Par défaut");
  await expect(toggle.getByRole("row").filter({ hasText: "Avec" })).toContainText("20,00");
  await expect(toggle.getByRole("button", { name: /par défaut/ })).toHaveCount(0);
});

test("un libellé vide est signalé sous le champ, sans bouton grisé muet", async ({ page }) => {
  await page.goto("/backoffice/pieces");
  const add = page.getByRole("button", { name: "Ajouter le produit" });
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByText("Indiquez le nom du produit")).toBeVisible();

  await page.goto("/backoffice/modeles/nouveau");
  await page.getByLabel("Nom du modèle").fill(unique("Libellés"));
  await page.getByLabel("Hashrate théorique").fill("100");
  await page.getByRole("button", { name: "Créer le modèle" }).click();
  await page.getByRole("button", { name: "Créer un menu d'options" }).click();
  const create = page.getByRole("button", { name: "Créer le menu" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText("Indiquez le titre du menu")).toBeVisible();
});

test("une saisie invalide est signalée en français avant l'envoi", async ({ page }) => {
  await page.goto("/backoffice/modeles/nouveau");
  await page.getByLabel("Nom du modèle").fill("Sans hashrate");
  await page.getByLabel("Hashrate théorique").fill("abc");
  await page.getByLabel("Nombre de hashboards").fill("21");
  await page.getByRole("button", { name: "Créer le modèle" }).click();
  await expect(page.getByText("Indiquez un hashrate positif en TH/s")).toBeVisible();
  await expect(page.getByText("Nombre entier de hashboards compris entre 1 et 20.")).toBeVisible();
});

test("gérer les produits d'options : créer, renommer, refuser la suppression d'un produit utilisé", async ({ page }) => {
  const partName = unique("Ventilateur");
  await page.goto("/backoffice/pieces");
  await page.getByLabel("Nom").fill(partName);
  await page.getByLabel("Référence").fill("NF-A14");
  await page.getByRole("button", { name: "Ajouter le produit" }).click();
  await expect(page.getByText(`Produit « ${partName} » ajouté.`)).toBeVisible();
  const grid = page.getByRole("region", { name: "Liste des produits" });
  await expect(grid.getByText(partName)).toBeVisible();

  // Renommage directement dans la grille (double-clic, saisie, Entrée)
  const renamed = `${partName} v2`;
  await grid.getByText(partName, { exact: true }).dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(renamed);
  await page.keyboard.press("Enter");
  await expect(page.getByText("Modification enregistrée.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Liste des produits" }).getByText(renamed, { exact: true })).toBeVisible();

  // Produit du seed, associé à la valeur Silent kit : suppression refusée, ce qui bloque est nommé
  await grid.getByRole("button", { name: "Supprimer Silent kit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Supprimer le produit ?" });
  await dialog.getByRole("button", { name: "Supprimer" }).click();
  const refusal = dialog.getByRole("alert");
  await expect(refusal).toContainText("il ne peut pas être supprimé");
  await expect(refusal.getByText("Ce qui l'empêche :")).toBeVisible();
  await expect(refusal.getByRole("listitem").filter({ hasText: "Valeur d'option" }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Annuler" }).click();
  await expect(dialog).toBeHidden();
});

test("noms en double (majuscules et espaces ignorés) : le refus du serveur s'affiche sous le champ concerné", async ({
  page,
}) => {
  const modelName = unique("Doublon");
  const model = await (
    await page.request.post("/api/backoffice/models", { data: { name: modelName, hashrate: "100000000000000", hashboardQtt: 3 } })
  ).json();
  await page.request.post(`/api/backoffice/models/${model.id}/options`, {
    data: { kind: "choice", title: "Firmware", values: [{ label: "Stock", price: "0" }, { label: "Braiins", price: "1000" }] },
  });

  // Modèle : même nom, autre casse
  await page.goto("/backoffice/modeles/nouveau");
  const nameInput = page.getByLabel("Nom du modèle");
  await nameInput.fill(`  ${modelName.toUpperCase()} `);
  await page.getByLabel("Hashrate théorique").fill("100");
  await page.getByRole("button", { name: "Créer le modèle" }).click();
  await expect(nameInput).toHaveAccessibleDescription(/Un modèle porte déjà ce nom \(majuscules et espaces ignorés\)/);
  await expect(nameInput).toBeFocused();
  await expect(page.locator(".bo-alert-error")).toHaveCount(0); // pas de doublon du message en bas du formulaire

  // Menu : titre déjà pris sur ce modèle
  await page.goto(`/backoffice/modeles/${model.id}`);
  await page.getByRole("button", { name: "Nouveau menu" }).click();
  const form = page.getByRole("form", { name: "Nouveau menu d'options" });
  const title = form.getByLabel("Titre");
  await title.fill("firmware");
  await form.getByLabel("Libellé de la valeur 1").fill("Sans");
  await form.getByLabel("Libellé de la valeur 2").fill("Avec");
  await form.getByLabel("Prix de la valeur 2").fill("5");
  await form.getByRole("button", { name: "Créer le menu" }).click();
  await expect(title).toHaveAccessibleDescription(/Ce modèle a déjà un menu d'options de ce titre/);
  await expect(title).toBeFocused();

  // Création d'un menu avec deux libellés identiques : message sous les valeurs, lignes signalées
  await title.fill("Kit de ventilation");
  await form.getByLabel("Libellé de la valeur 2").fill(" sans ");
  await form.getByRole("button", { name: "Créer le menu" }).click();
  const label1 = form.getByLabel("Libellé de la valeur 1");
  await expect(label1).toHaveAccessibleDescription(/Ce menu a déjà une valeur de ce libellé/);
  await expect(label1).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByLabel("Libellé de la valeur 2")).toHaveAttribute("aria-invalid", "true");
  await expect(label1).toBeFocused();
  await expect(page.getByRole("article", { name: "Kit de ventilation" })).toHaveCount(0); // rien n'est créé
  await form.getByRole("button", { name: "Annuler" }).click();

  // Valeur ajoutée à un menu existant : libellé déjà pris
  const menu = page.getByRole("article", { name: "Firmware" });
  await menu.getByRole("button", { name: "Ajouter une valeur" }).click();
  const valueForm = menu.getByRole("form", { name: "Nouvelle valeur" });
  await valueForm.getByLabel("Libellé").fill("BRAIINS");
  await valueForm.getByLabel("Prix").fill("12");
  await valueForm.getByRole("button", { name: "Ajouter la valeur" }).click();
  await expect(valueForm.getByLabel("Libellé")).toHaveAccessibleDescription(/Ce menu a déjà une valeur de ce libellé/);

  // Produits : formulaire de création, puis renommage dans la grille
  const partA = unique("Kit A");
  const partB = unique("Kit B");
  for (const name of [partA, partB]) await page.request.post("/api/backoffice/parts", { data: { name } });
  await page.goto("/backoffice/pieces");
  const partName = page.getByLabel("Nom", { exact: true });
  await partName.fill(partA.toLowerCase());
  await page.getByRole("button", { name: "Ajouter le produit" }).click();
  await expect(partName).toHaveAccessibleDescription(/Un produit porte déjà ce nom/);
  await expect(partName).toBeFocused();

  const grid = page.getByRole("region", { name: "Liste des produits" });
  await grid.getByText(partB, { exact: true }).dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(partA);
  await page.keyboard.press("Enter");
  const refusal = page.getByRole("alert").filter({ hasText: "Un produit porte déjà ce nom" });
  await expect(refusal).toContainText(`« ${partB} » garde son nom.`);
  await expect(grid.getByText(partB, { exact: true })).toBeVisible();
  await expect(page.getByText("Modification enregistrée.")).toHaveCount(0);
});
