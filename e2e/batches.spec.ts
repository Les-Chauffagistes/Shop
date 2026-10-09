import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { signIn, unique } from "./support/auth";

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

/** Modèle avec un menu « Kit de ventilation », créé par l'API (la saisie est couverte par catalog.spec.ts). */
async function createModel(request: APIRequestContext) {
  const name = unique("M30S");
  const model = await (
    await request.post("/api/backoffice/models", { data: { name, hashrate: "112000000000000", hashboardQtt: 3 } })
  ).json();
  const response = await request.post(`/api/backoffice/models/${model.id}/options`, {
    data: {
      kind: "choice",
      title: "Kit de ventilation",
      values: [
        { label: "Sans kit", price: "0" },
        { label: "Air Flow", price: "3500" },
        { label: "Silent kit", price: "7500" },
      ],
    },
  });
  expect(response.status()).toBe(201);
  const option = await response.json();
  const valueId = (label: string) => option.values.find((v: { label: string }) => v.label === label).id as string;
  return { id: model.id as string, name, valueId };
}

async function transition(page: Page, action: string, expectedStatus: string, note?: string) {
  const panel = page.getByRole("complementary", { name: "Actions du lot" });
  await panel.getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `${action} ?` });
  await expect(dialog).toBeVisible();
  if (note) await dialog.getByLabel("Motif").fill(note);
  await dialog.getByRole("button", { name: /^(Confirmer|Annuler le lot)$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 }).locator(".bo-badge")).toHaveText(expectedStatus);
}

test("créer un lot et le faire passer de brouillon à sondage puis précommande", async ({ page }) => {
  const model = await createModel(page.request);

  await page.goto("/backoffice/lots");
  await page.getByRole("link", { name: "Nouveau lot" }).click();
  await expect(page.getByRole("link", { name: "Créer un modèle" })).toBeVisible();

  await page.getByLabel("Modèle de mineur").selectOption({ label: model.name });
  await page.getByLabel("Quantité de machines").fill("10");
  await page.getByLabel("Prix d'achat du lot").fill("15 000");
  await expect(page.getByText("soit 1 500,00 € par machine")).toBeVisible();
  // Nom par défaut visible tant que le champ est vide
  await expect(page.getByLabel("Nom du lot")).toHaveAttribute("placeholder", `10 ${model.name}`);

  // Options : Air Flow retirée, Silent kit à 60 € limité à 3
  await page.getByLabel("Proposer « Air Flow » (Kit de ventilation) pour ce lot").uncheck();
  await expect(page.getByLabel("Proposer « Sans kit » (Kit de ventilation) pour ce lot")).toBeDisabled();
  await page.getByLabel("Prix dérogatoire de « Silent kit »").fill("60");
  await page.getByLabel("Quantité maximale de « Silent kit »").fill("3");
  await page.getByRole("button", { name: "Créer le lot en brouillon" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText(`10 ${model.name}`);
  await expect(page.getByRole("heading", { level: 1 }).locator(".bo-badge")).toHaveText("Brouillon");
  await expect(page.getByLabel("Proposer « Air Flow » (Kit de ventilation) pour ce lot")).not.toBeChecked();
  await expect(page.getByLabel("Prix dérogatoire de « Silent kit »")).toHaveValue("60,00");

  // Publication bloquée sans prix de revente : le bloquant est affiché
  const panel = page.getByRole("complementary", { name: "Actions du lot" });
  await expect(panel.getByRole("button", { name: "Publier pour sondage" })).toBeDisabled();
  await expect(panel.getByText("Renseignez le prix de revente unitaire.").first()).toBeVisible();

  await page.getByLabel("Prix de revente unitaire").fill("1 800");
  await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
  await expect(panel.getByRole("button", { name: "Publier pour sondage" })).toBeEnabled();
  // La confirmation survit au rechargement des données (le formulaire, lui, est recréé)
  await expect(page.getByRole("status").filter({ hasText: /^Lot enregistré à \d{2}:\d{2}\.$/ })).toBeVisible();

  await transition(page, "Publier pour sondage", "Sondage");
  // Au sondage, le modèle n'est plus modifiable
  await expect(page.getByLabel("Modèle de mineur")).toBeDisabled();

  await transition(page, "Ouvrir les précommandes", "Précommande");
  await expect(page.getByLabel("Prix de revente unitaire")).toBeDisabled();
  await expect(page.getByLabel("Quantité maximale de « Silent kit »")).toBeEnabled();

  const history = page.getByRole("region", { name: "Historique" });
  await expect(history.getByRole("listitem")).toHaveCount(3);
  await expect(history.getByRole("listitem").first()).toContainText("Sondage → Précommande");

  // Le lot apparaît dans la liste filtrée sur « Précommande », avec sa prochaine action
  await page.goto("/backoffice/lots?statut=preorder");
  const grid = page.getByRole("region", { name: "Liste des lots" });
  const row = grid.getByRole("row").filter({ hasText: `10 ${model.name}` });
  await expect(row).toContainText("Précommande");
  await expect(row).toContainText("Confirmer la commande du lot");
});

test("un retour arrière exige un motif, et un statut changé ailleurs propose de recharger", async ({ page }) => {
  const model = await createModel(page.request);
  const batch = await (
    await page.request.post("/api/backoffice/batches", {
      data: { modelId: model.id, quantity: 4, purchasePrice: "600000", resaleUnitPrice: "180000" },
    })
  ).json();
  await page.request.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to: "survey", from: "draft" } });

  await page.goto(`/backoffice/lots/${batch.id}`);
  const panel = page.getByRole("complementary", { name: "Actions du lot" });
  await panel.getByRole("button", { name: "Dépublier (retour en brouillon)" }).click();
  const dialog = page.getByRole("dialog", { name: "Dépublier (retour en brouillon) ?" });
  await expect(dialog.getByText("Le lot ne sera plus visible")).toBeVisible();
  await dialog.getByRole("button", { name: "Confirmer" }).click();
  await expect(dialog.getByText("Indiquez le motif de ce changement.")).toBeVisible();
  await dialog.getByRole("button", { name: "Ne rien changer" }).click();

  // Un autre admin ouvre les précommandes pendant que la page est affichée
  await panel.getByRole("button", { name: "Ouvrir les précommandes", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Ouvrir les précommandes ?" });
  await page.request.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to: "preorder", from: "survey" } });
  await confirm.getByRole("button", { name: "Confirmer" }).click();
  await expect(panel.getByRole("alert")).toContainText("entre-temps");
  await panel.getByRole("button", { name: "Recharger le lot" }).click();
  await expect(page.getByRole("heading", { level: 1 }).locator(".bo-badge")).toHaveText("Précommande");
});

test("deux onglets : la saisie de l'onglet périmé est refusée sans rien écraser, puis reprise sur la version actuelle", async ({
  page,
  context,
}) => {
  const model = await createModel(page.request);
  const created = await (
    await page.request.post("/api/backoffice/batches", {
      data: { modelId: model.id, quantity: 10, purchasePrice: "1500000", resaleUnitPrice: "52000" },
    })
  ).json();
  const url = `/backoffice/lots/${created.id}`;
  const name = unique("Palette A");

  const tabA = page;
  const tabB = await context.newPage();
  await tabA.goto(url);
  await tabB.goto(url);

  // Onglet A : prix de revente et nom, enregistrés ; la confirmation reste visible après le rechargement
  await tabA.getByLabel("Prix de revente unitaire").fill("500");
  await tabA.getByLabel("Nom du lot").fill(name);
  await tabA.getByRole("button", { name: "Enregistrer les modifications" }).click();
  await expect(tabA.getByRole("heading", { level: 1 })).toContainText(name);
  await expect(tabA.getByRole("status").filter({ hasText: /^Lot enregistré à/ })).toBeVisible();

  // Onglet B, resté sur l'ancienne version : seule la quantité change
  await tabB.getByLabel("Quantité de machines").fill("18");
  await tabB.getByRole("button", { name: "Enregistrer les modifications" }).click();
  const conflict = tabB.getByRole("alert").filter({ hasText: "Vos saisies restent affichées" });
  await expect(conflict).toBeVisible();
  await expect(tabB.getByRole("status").filter({ hasText: "Lot enregistré" })).toHaveCount(0);
  await expect(tabB.getByLabel("Quantité de machines")).toHaveValue("18"); // la saisie n'est pas perdue

  // Rien n'a été écrasé
  let current = await (await page.request.get(`/api/backoffice/batches/${created.id}`)).json();
  expect(current).toMatchObject({ quantity: 10, resaleUnitPrice: "50000", name });

  // Recharger : version actuelle affichée, saisies refusées listées puis reprises
  await conflict.getByRole("button", { name: "Recharger le lot" }).click();
  const unsaved = tabB.getByRole("region", { name: "Vos saisies non enregistrées" });
  await expect(unsaved).toContainText("Quantité : 18");
  await expect(tabB.getByLabel("Prix de revente unitaire")).toHaveValue("500,00");
  await expect(tabB.getByLabel("Quantité de machines")).toHaveValue("10");
  await unsaved.getByRole("button", { name: "Reprendre mes saisies" }).click();
  await expect(tabB.getByLabel("Quantité de machines")).toHaveValue("18");
  await expect(tabB.getByLabel("Nom du lot")).toHaveValue(name);
  await tabB.getByRole("button", { name: "Enregistrer les modifications" }).click();
  await expect(tabB.getByRole("status").filter({ hasText: /^Lot enregistré à/ })).toBeVisible();

  current = await (await page.request.get(`/api/backoffice/batches/${created.id}`)).json();
  expect(current).toMatchObject({ quantity: 18, resaleUnitPrice: "50000", name });
});

test("alerte de marge non bloquante : revente unitaire comparée au coût d'achat d'une machine", async ({ page }) => {
  const model = await createModel(page.request);
  await page.goto("/backoffice/lots/nouveau");
  await page.getByLabel("Modèle de mineur").selectOption({ label: model.name });
  const resale = page.getByLabel("Prix de revente unitaire");
  const warning = /Prix de revente inférieur au coût d'achat d'une machine/;

  // 10 machines pour 15 000 € : 1 500 € par machine ; revendre au prix coûtant n'alerte pas
  await page.getByLabel("Quantité de machines").fill("10");
  await page.getByLabel("Prix d'achat du lot").fill("15 000");
  await resale.fill("1 500");
  await expect(resale).not.toHaveAccessibleDescription(warning);
  await resale.fill("1 499,99");
  await expect(resale).toHaveAccessibleDescription(warning);
  await expect(page.getByText(/coût d'achat d'une machine \(1\s500,00\s€\)/)).toBeVisible();

  // Écart extrême : 1 € de revente pour un lot de 99 999 999 € ; l'enregistrement reste possible
  await page.getByLabel("Prix d'achat du lot").fill("99 999 999");
  await resale.fill("1");
  await expect(resale).toHaveAccessibleDescription(warning);
  await page.getByRole("button", { name: "Créer le lot en brouillon" }).click();
  await expect(page.getByRole("heading", { level: 1 }).locator(".bo-badge")).toHaveText("Brouillon");
  await expect(page.getByLabel("Prix de revente unitaire")).toHaveAccessibleDescription(warning);

  // Prix corrigé : l'alerte disparaît
  await page.getByLabel("Prix d'achat du lot").fill("10");
  await expect(page.getByLabel("Prix de revente unitaire")).not.toHaveAccessibleDescription(warning);
});

test("menu sans choix : publication bloquée en brouillon, enregistrement refusé au sondage", async ({ page }) => {
  const model = await createModel(page.request);
  const withdrawn = [model.valueId("Air Flow"), model.valueId("Silent kit")].map((optionValueId) => ({
    optionValueId,
    enabled: false,
  }));
  const message =
    "Le menu « Kit de ventilation » propose moins de deux valeurs sur ce lot : ajoutez une valeur au catalogue, rétablissez une valeur retirée ou masquez le menu.";

  // Brouillon : le bloquant de la publication est affiché sous le bouton, et le décrit
  const draft = await (
    await page.request.post("/api/backoffice/batches", {
      data: { modelId: model.id, quantity: 4, purchasePrice: "600000", resaleUnitPrice: "180000", optionValues: withdrawn },
    })
  ).json();
  await page.goto(`/backoffice/lots/${draft.id}`);
  const panel = page.getByRole("complementary", { name: "Actions du lot" });
  const publish = panel.getByRole("button", { name: "Publier pour sondage" });
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveAccessibleDescription(message);
  await expect(panel.getByText(message).first()).toBeVisible();

  // Sondage : retirer les deux valeurs payantes est refusé, message du serveur au-dessus des options
  const survey = await (
    await page.request.post("/api/backoffice/batches", {
      data: { modelId: model.id, quantity: 4, purchasePrice: "600000", resaleUnitPrice: "180000" },
    })
  ).json();
  await page.request.post(`/api/backoffice/batches/${survey.id}/transitions`, { data: { to: "survey", from: "draft" } });
  await page.goto(`/backoffice/lots/${survey.id}`);
  await page.getByLabel("Proposer « Air Flow » (Kit de ventilation) pour ce lot").uncheck();
  await page.getByLabel("Proposer « Silent kit » (Kit de ventilation) pour ce lot").uncheck();
  await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
  const refusal = page.getByRole("alert").filter({ hasText: message });
  await expect(refusal).toBeVisible();
  await expect(refusal).toBeInViewport();
  await expect(page.getByText("Rien n'a été enregistré : corrigez les options du lot ci-dessus.")).toBeVisible();
  const current = await (await page.request.get(`/api/backoffice/batches/${survey.id}`)).json();
  expect(current.options[0].values.every((v: { enabled: boolean }) => v.enabled)).toBe(true);

  // Masquer le menu dans la même requête est permis
  await page.getByRole("button", { name: "Masquer le menu « Kit de ventilation »" }).click();
  await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Lot enregistré à/ })).toBeVisible();
  await expect(refusal).toHaveCount(0);
});
