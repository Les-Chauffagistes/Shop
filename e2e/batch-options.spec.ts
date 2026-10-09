import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { signIn, unique } from "./support/auth";
import { addPendingOrder, addWishlist } from "./support/db";

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

type Menu = { id: string; values: { id: string; label: string; price: string }[] };

/** Modèle avec un menu « Kit » (Sans kit, Silent) ; `partId` : produit monté avec Silent. */
async function createModel(request: APIRequestContext, partId?: string) {
  const model = await (
    await request.post("/api/backoffice/models", {
      data: { name: unique("S21"), hashrate: "200000000000000", hashboardQtt: 3 },
    })
  ).json();
  const response = await request.post(`/api/backoffice/models/${model.id}/options`, {
    data: {
      kind: "choice",
      title: "Kit",
      values: [
        { label: "Sans kit", price: "0" },
        { label: "Silent", price: "5000", ...(partId ? { parts: [{ partId, qty: 1 }] } : {}) },
      ],
    },
  });
  expect(response.status()).toBe(201);
  const menu = (await response.json()) as Menu;
  const value = (label: string) => menu.values.find((v) => v.label === label)!;
  return { id: model.id as string, name: model.name as string, menu, value };
}

async function createBatch(request: APIRequestContext, modelId: string, path: string[], quantity = 10) {
  const response = await request.post("/api/backoffice/batches", {
    data: { modelId, quantity, purchasePrice: "1500000", resaleUnitPrice: "180000" },
  });
  expect(response.status()).toBe(201);
  const batch = await response.json();
  let from = "draft";
  for (const to of path) {
    expect((await request.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to, from } })).status()).toBe(201);
    from = to;
  }
  return batch.id as string;
}

const save = (page: Page) => page.getByRole("button", { name: "Enregistrer les modifications" }).click();
const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: /^Lot enregistré à/ })).toBeVisible();

test("masquer un menu au sondage : les choix des clients sont annoncés, confirmés, puis ramenés au défaut", async ({
  page,
}) => {
  const model = await createModel(page.request);
  const batchId = await createBatch(page.request, model.id, ["survey"]);
  const silent = model.value("Silent");
  await addWishlist(batchId, "alice", [{ optionId: model.menu.id, optionValueId: silent.id, unitPrice: silent.price }]);

  await page.goto(`/backoffice/lots/${batchId}`);
  await page.getByRole("button", { name: "Masquer le menu « Kit »" }).click();
  const menu = page.getByRole("region", { name: "Menu Kit" });
  await expect(menu).toContainText("la valeur par défaut « Sans kit » (gratuite) s'applique d'office");
  await expect(menu.getByRole("note")).toContainText("1 client a fait un choix dans ce menu");

  // Le serveur demande confirmation, avec le nombre de choix ramenés au défaut
  await save(page);
  const dialog = page.getByRole("dialog", { name: "Masquer ce menu ?" });
  await expect(dialog).toContainText("ramènera 1 choix de manifestation(s) d'intérêt à la valeur par défaut");
  await dialog.getByRole("button", { name: "Masquer et ramener au défaut" }).click();
  await expect(dialog).toBeHidden();
  await saved(page);
  await expect(page.getByRole("region", { name: "Menu Kit" }).getByText("Masqué", { exact: true })).toBeVisible();

  const batch = await (await page.request.get(`/api/backoffice/batches/${batchId}`)).json();
  expect(batch.options[0]).toMatchObject({ hidden: true, wishlistChoices: 0 });

  // Réafficher le menu tout de suite, sans recharger : le formulaire a repris la version enregistrée,
  // et le rafraîchissement de la page qui arrive ensuite n'écrase pas ce clic (même version du lot)
  await page.getByRole("button", { name: "Afficher le menu « Kit »" }).click();
  await expect(page.getByRole("button", { name: "Masquer le menu « Kit »" })).toBeVisible();
  // Sans choix à ramener, aucune confirmation ; la version envoyée est la dernière enregistrée (pas de 409)
  const second = page.waitForResponse((r) => r.url().endsWith(`/api/backoffice/batches/${batchId}`) && r.request().method() === "PATCH");
  await save(page);
  expect((await second).status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Masquer le menu « Kit »" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Masquer le menu « Kit »" })).toBeVisible();
  const final = await (await page.request.get(`/api/backoffice/batches/${batchId}`)).json();
  expect(final.options[0]).toMatchObject({ hidden: false });
});

test("proposer sur un lot publié une valeur ajoutée après coup, avec avertissement si une saisie est en cours", async ({
  page,
}) => {
  const model = await createModel(page.request);
  const batchId = await createBatch(page.request, model.id, ["survey"]);
  // Valeur ajoutée au catalogue après la publication : pas proposée sur ce lot
  expect(
    (await page.request.post(`/api/backoffice/options/${model.menu.id}/values`, { data: { label: "Turbo", price: "4000" } })).status(),
  ).toBe(201);

  await page.goto(`/backoffice/lots/${batchId}`);
  const row = page.getByRole("region", { name: "Menu Kit" }).getByRole("row").filter({ hasText: "Turbo" });
  await expect(row).toContainText("ajoutée après la publication");

  // Une saisie non enregistrée est signalée avant l'action qui recharge le lot
  await page.getByLabel("Nom du lot").fill("Saisie en cours");
  await row.getByRole("button", { name: "Proposer « Turbo » sur ce lot" }).click();
  const dialog = page.getByRole("dialog", { name: "Proposer « Turbo » sur ce lot ?" });
  await expect(dialog.getByRole("note")).toContainText("Modifications non enregistrées");
  await dialog.getByRole("button", { name: "Annuler" }).click();
  await page.getByLabel("Nom du lot").fill("");

  await row.getByRole("button", { name: "Proposer « Turbo » sur ce lot" }).click();
  await expect(dialog.getByRole("note")).toHaveCount(0);
  await dialog.getByLabel("Prix pour ce lot").fill("30");
  await dialog.getByRole("button", { name: "Proposer sur ce lot" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "« Turbo » est maintenant proposée sur ce lot." })).toBeVisible();
  await expect(page.getByLabel("Proposer « Turbo » (Kit) pour ce lot")).toBeChecked();
  await expect(page.getByLabel("Prix dérogatoire de « Turbo »")).toHaveValue("30,00");
});

test("changement de statut avec une saisie non enregistrée, et modification d'un lot déjà commandé", async ({ page }) => {
  const model = await createModel(page.request);
  const batchId = await createBatch(page.request, model.id, []);
  await page.goto(`/backoffice/lots/${batchId}`);

  // Bornes : quantité au-delà de 10 000 refusée avant l'envoi
  await page.getByLabel("Quantité de machines").fill("10001");
  await save(page);
  await expect(page.getByText("Nombre entier de machines compris entre 1 et 10 000.")).toBeVisible();

  // La transition prévient que la saisie sera perdue
  const panel = page.getByRole("complementary", { name: "Actions du lot" });
  await panel.getByRole("button", { name: "Commander sur fonds propres" }).click();
  const transition = page.getByRole("dialog", { name: "Commander sur fonds propres ?" });
  await expect(transition.getByRole("note")).toContainText("Modifications non enregistrées");
  await transition.getByRole("button", { name: "Ne rien changer" }).click();
  await page.getByLabel("Quantité de machines").fill("10");
  await panel.getByRole("button", { name: "Commander sur fonds propres" }).click();
  await expect(transition.getByRole("note")).toHaveCount(0);
  await transition.getByRole("button", { name: "Confirmer" }).click();
  await expect(page.getByRole("heading", { level: 1 }).locator(".bo-badge")).toHaveText("Commande en cours");

  // Lot commandé au fournisseur : la modification de quantité est confirmée avant l'enregistrement
  await page.getByLabel("Quantité de machines").fill("12");
  await save(page);
  const confirm = page.getByRole("dialog", { name: "Modifier un lot déjà commandé ?" });
  await expect(confirm).toContainText("Quantité : 10 → 12");
  await confirm.getByRole("button", { name: "Ne rien enregistrer" }).click();
  expect((await (await page.request.get(`/api/backoffice/batches/${batchId}`)).json()).quantity).toBe(10);
  await save(page);
  await confirm.getByRole("button", { name: "Enregistrer quand même" }).click();
  await saved(page);
  expect((await (await page.request.get(`/api/backoffice/batches/${batchId}`)).json()).quantity).toBe(12);
});

test("pression sur le stock d'un produit d'option : alerte, commande, réception, journal", async ({ page }) => {
  const partName = unique("Kit silencieux");
  const part = await (await page.request.post("/api/backoffice/parts", { data: { name: partName } })).json();
  const model = await createModel(page.request, part.id);
  // Précommandes ouvertes sans sondage : pas de journée de priorité, Alice et Bob (sans wishlist) commandent
  const batchId = await createBatch(page.request, model.id, ["preorder"]);
  const silent = model.value("Silent");
  const choice = [{ optionId: model.menu.id, optionValueId: silent.id, unitPrice: silent.price }];
  // Demande ferme : deux factures en attente (Alice, Bob) avec le kit
  await addPendingOrder(batchId, "alice", choice);
  await addPendingOrder(batchId, "bob", choice);

  // Aucun kit en stock : demande sans stock
  await page.goto(`/backoffice/lots/${batchId}`);
  const section = page.getByRole("region", { name: "Produits d'options" });
  const row = section.getByRole("table", { name: "Besoin du lot par produit" }).getByRole("row").filter({ hasText: partName });
  await expect(row).toContainText("Demande sans stock");
  await expect(section.getByRole("note")).toContainText("demande ferme de 2 sans aucun kit en stock");

  // Un kit reçu (réassort) : pression 2, au-dessus de 1
  await page.goto(`/backoffice/pieces/${part.id}`);
  await page.getByLabel("Nombre de kits").fill("1");
  await page.getByRole("button", { name: "Enregistrer le mouvement" }).click();
  await expect(page.getByRole("status").filter({ hasText: `1 « ${partName} » ajouté au stock.` })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("demande ferme de 2 pour 1 kit en stock (pression 2). Manque 1 : 1 kit à commander.");
  await expect(page.getByRole("region", { name: "Journal du stock" })).toContainText("Réception");

  // Correction d'inventaire : motif obligatoire
  await page.getByText("Correction d'inventaire", { exact: true }).click();
  await page.getByLabel("Nombre de kits").fill("1");
  await page.getByRole("button", { name: "Enregistrer le mouvement" }).click();
  await expect(page.getByText("Indiquez le motif de la correction")).toBeVisible();
  await page.getByLabel("Sens").selectOption("add");
  await page.getByLabel("Motif").fill("Kit retrouvé");
  await page.getByRole("button", { name: "Enregistrer le mouvement" }).click();
  await expect(page.getByRole("region", { name: "Journal du stock" })).toContainText("Kit retrouvé");
  await page.getByLabel("Sens").selectOption("remove");
  await page.getByLabel("Nombre de kits").fill("1");
  await page.getByLabel("Motif").fill("Erreur de saisie");
  await page.getByRole("button", { name: "Enregistrer le mouvement" }).click();
  await expect(page.getByRole("region", { name: "Journal du stock" })).toContainText("Erreur de saisie");

  // Vue d'ensemble : le produit est signalé
  await page.goto("/backoffice/pieces");
  await expect(page.getByRole("note").getByRole("listitem").filter({ hasText: partName })).toContainText("Manque 1");

  // Fiche du lot : commander le kit manquant, puis le réceptionner
  await page.goto(`/backoffice/lots/${batchId}`);
  await expect(row).toContainText("2 · manque 1");
  await section.getByLabel("Produit", { exact: true }).selectOption({ label: partName });
  await section.getByLabel("Quantité de kits").fill("1");
  await section.getByRole("button", { name: "Enregistrer la commande" }).click();
  await expect(section.getByRole("note")).toContainText("1 déjà commandé ou en route : rien à commander de plus");
  const order = section.getByRole("table", { name: "Commandes de produits du lot" }).getByRole("row").filter({ hasText: partName });
  await order.getByRole("button", { name: "Marquer en route" }).click();
  await expect(order).toContainText("Attente de livraison");
  await order.getByRole("button", { name: `Réceptionner la commande de « ${partName} »` }).click();
  const deliver = page.getByRole("dialog", { name: `Réceptionner « ${partName} » ?` });
  await expect(deliver.getByLabel("Kits reçus")).toHaveValue("1");
  await deliver.getByRole("button", { name: "Réceptionner" }).click();
  await expect(deliver).toBeHidden();
  await expect(order).toContainText("Livré");
  // Stock 2 pour une demande de 2 : plus d'alerte
  await expect(section.getByRole("note")).toHaveCount(0);
  await expect(row).not.toContainText("manque");
});
