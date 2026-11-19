import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support/auth";
import { montageBatch, setStatus, st } from "./backoffice/helpers";

/**
 * Montage des machines à option côté écrans (revue logisticien du 2026-11-19) : le dialogue « Attribuer » lit la ligne
 * à jour juste après « Marquer prêtes » (sans recharger), ne propose pas de valider sans machine, et « Remettre au
 * transporteur » est grisé avec la raison du serveur pour une machine au montage non conforme.
 */

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

const row = (page: Page, serial: string) => page.locator(".ag-row", { hasText: serial }).first();
const bar = (page: Page) => page.getByRole("group", { name: "Actions sur les machines cochées" });

test("Attribuer : les machines montées et prêtes sont proposées sans recharger ; pas de validation à vide", async ({ page, baseURL }) => {
  const b = await montageBatch(baseURL!, [true, false]);
  await open(page, `/backoffice/lots/${b.batchId}?onglet=machines`);
  const lines = page.getByRole("region", { name: "Commandes payées du lot" });
  const kitLine = lines.locator(".ag-row", { hasText: "à monter : Silent kit" }).first();

  // Avant le montage : aucune machine conforme, l'aide renvoie au bon bouton et la validation est désactivée
  await kitLine.getByRole("button", { name: "Attribuer", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("« Marquer prêtes »");
  await expect(dialog.getByRole("button", { name: "Attribuer une machine" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Ne rien changer" }).click();
  await expect(dialog).toBeHidden();

  // Montage par l'écran : démarrer avec le kit du plan, puis « Marquer prêtes »
  await row(page, b.serials[0]).getByRole("checkbox").check();
  await bar(page).getByRole("button", { name: /^Démarrer le montage/ }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Démarrer le montage/ }).click();
  await expect(row(page, b.serials[0])).toContainText("En montage");
  await row(page, b.serials[0]).getByRole("checkbox").check();
  await bar(page).getByRole("button", { name: /^Marquer prêtes/ }).click();
  await expect(row(page, b.serials[0])).toContainText("Prête");

  // Sans recharger : la machine prête montée est proposée et s'attribue
  await kitLine.getByRole("button", { name: "Attribuer", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Machine", { exact: true }).locator("option")).toHaveCount(1);
  await expect(dialog.getByLabel("Machine", { exact: true })).toContainText(b.serials[0]);
  await dialog.getByRole("button", { name: "Attribuer une machine" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Machine attribuée." })).toBeVisible();
  await expect(lines.locator(".ag-row", { hasText: b.serials[0] })).toBeVisible();
});

test("Remettre au transporteur : grisé avec la raison pour une machine au montage non conforme", async ({ page, baseURL }) => {
  const b = await montageBatch(baseURL!, [true, false]);
  // Machine montée, prête, attribuée à la ligne à kit, puis démontée et remise prête brute (API)
  let d = await b.get();
  const m0 = d.machines[0];
  expect((await setStatus(b.admin, [st(m0, { logistical: "in_preparation" }, { mounting: [b.silentId] })])).status()).toBe(201);
  d = await b.get();
  expect((await setStatus(b.admin, [st(d.machines[0], { logistical: "ready" })])).status()).toBe(201);
  const kitLine = d.lines.find((l) => l.mounting.required.length > 0)!;
  const assigned = await b.admin.post(`/api/backoffice/order-lines/${kitLine.lineId}/assignment`, { data: { expectedMachineId: null, machineId: m0.id } });
  expect(assigned.status(), await assigned.text()).toBe(201);
  d = await b.get();
  expect((await setStatus(b.admin, [st(d.machines[0], { logistical: "in_stock" }, { note: "démontage du kit" })])).status()).toBe(201);
  d = await b.get();
  expect((await setStatus(b.admin, [st(d.machines[0], { logistical: "ready" })])).status()).toBe(201);

  await open(page, `/backoffice/lots/${b.batchId}?onglet=machines`);
  await expect(page.getByTestId("mounting-mismatch")).toBeVisible();

  // Par machine : bouton de la ligne grisé, raison en infobulle
  const own = row(page, b.serials[0]).getByRole("button", { name: "Remettre au transporteur" });
  await expect(own).toBeDisabled();
  await expect(own).toHaveAttribute("title", /n'est pas celui de sa commande/);

  // En groupe : bouton de la barre grisé avec la même raison, avant toute saisie du suivi
  await row(page, b.serials[0]).getByRole("checkbox").check();
  const ship = bar(page).getByRole("button", { name: /^Remettre au transporteur/ });
  await expect(ship).toBeDisabled();
  await expect(ship).toHaveAttribute("title", /n'est pas celui de sa commande/);

  // Fiche machine : non-conformité signalée avec le kit attendu
  await open(page, `/backoffice/machines/${m0.id}`);
  await expect(page.getByTestId("mounting-mismatch-notice")).toContainText("Silent kit");
});
