import { expect, test } from "@playwright/test";
import { signIn, unique } from "./support/auth";

// Non-régression I1 (recette 2026-10-07) : une réception partielle affiche les kits reçus,
// pas la quantité commandée, et prévient l'admin (une seule réception par commande).

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test("réception partielle : « reçus » et manquants, avertissement dans le dialogue", async ({ page }) => {
  const request = page.request;
  const partName = unique("Kit partiel");
  const part = await (await request.post("/api/backoffice/parts", { data: { name: partName } })).json();
  const model = await (
    await request.post("/api/backoffice/models", { data: { name: unique("S21"), hashrate: "200000000000000", hashboardQtt: 3 } })
  ).json();
  await request.post(`/api/backoffice/models/${model.id}/options`, {
    data: {
      kind: "choice",
      title: "Kit",
      values: [
        { label: "Sans kit", price: "0" },
        { label: "Silent", price: "5000", parts: [{ partId: part.id, qty: 1 }] },
      ],
    },
  });
  const batch = await (
    await request.post("/api/backoffice/batches", {
      data: { modelId: model.id, quantity: 10, purchasePrice: "1500000", resaleUnitPrice: "180000" },
    })
  ).json();
  const order = await (await request.post(`/api/backoffice/batches/${batch.id}/part-orders`, { data: { partId: part.id, qty: 6 } })).json();

  await page.goto(`/backoffice/lots/${batch.id}`);
  const section = page.getByRole("region", { name: "Produits d'options" });
  await section.getByRole("button", { name: `Réceptionner la commande de « ${partName} »` }).click();
  const dialog = page.getByRole("dialog", { name: `Réceptionner « ${partName} » ?` });
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByLabel("Kits reçus").fill("3");
  await expect(dialog.getByRole("status")).toContainText("3 reçus sur 6 commandés");
  await dialog.getByRole("button", { name: "Réceptionner" }).click();
  await expect(dialog).toBeHidden();

  const needs = section.getByRole("table", { name: "Besoin du lot par produit" }).getByRole("row").filter({ hasText: partName });
  await expect(needs).toContainText("3 reçus");
  await expect(needs).toContainText("3 manquants à la livraison");
  await expect(needs).not.toContainText("6 livré");
  const body = await (await request.get(`/api/backoffice/batches/${batch.id}/part-needs`)).json();
  expect(body.parts[0]).toMatchObject({ deliveredQty: 3, orderedQty: 0 });
  expect(order.qty).toBe(6);
});
