import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../support/auth";
import { montageBatch } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});
// Hors du projet : une image écrite dans le dossier fait recompiler `next dev` et recharger les pages en boucle
const IMG = join(process.env.E2E_OUTPUT_DIR ?? join(tmpdir(), "shop-e2e-results"), "logisticien-");
// Scénario d'exploration (attentes fixes, captures) : plus long que le délai par défaut
test.setTimeout(180_000);
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

test("UI : plan, démarrer le montage (dialogue), terminé, attribuer, non conforme, envoi", async ({ page, baseURL }) => {
  const b = await montageBatch(baseURL!, [true, false, true]);
  await open(page, `/backoffice/lots/${b.batchId}?onglet=machines`);
  await page.screenshot({ path: `${IMG}montage-1-plan.png`, fullPage: true });
  const plan = page.getByTestId("mounting-plan");
  await expect(plan).toContainText("2 machines à monter");

  const pick = async (...idx: number[]) => { for (const i of idx) await page.locator(".ag-row", { hasText: b.serials[i] }).first().getByRole("checkbox").check(); };
  const toast = async () => console.log("MSG:", (await page.locator("[role=status],[role=alert]").allInnerTexts()).join(" // "));
  const btn = (n: RegExp) => page.getByRole("button", { name: n }).first();

  await pick(0, 1);
  await expect(btn(/^Démarrer le montage/)).toBeEnabled();
  await btn(/^Démarrer le montage/).click();
  const dialog = page.getByRole("dialog");
  await page.screenshot({ path: `${IMG}montage-2-dialogue.png` });
  console.log("DIALOG:", (await dialog.innerText()).replace(/\n+/g, " | "));
  await dialog.getByRole("button", { name: /Démarrer le montage/ }).click();
  await page.waitForTimeout(2000);
  await toast();
  console.log("PLAN after start:", await plan.innerText());
  await page.screenshot({ path: `${IMG}montage-3-en-montage.png`, fullPage: true });

  // Montage terminé : quel bouton ?
  console.log("BUTTONS:", await page.getByRole("group", { name: "Actions sur les machines cochées" }).getByRole("button").allInnerTexts());
  await pick(0, 1);
  await btn(/^Marquer prêtes/).click();
  await page.waitForTimeout(2500); await toast();
  await page.waitForTimeout(2000);
  await toast();
  console.log("PLAN after ready:", await plan.innerText());

  await page.waitForTimeout(6000);
  console.log("GRID rows:", (await page.locator(".ag-center-cols-container .ag-row").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").slice(0, 110)));
  const api = await b.get();
  console.log("API fitting:", api.lines.map((l) => `${l.mounting.required.length}:${l.fittingMachineIds.length}`), "machines:", api.machines.map((m) => `${m.logisticalStatus}/${JSON.stringify(m.mounting?.length ?? m.mounting)}`));
  if (process.env.RELOAD) { await open(page, `/backoffice/lots/${b.batchId}?onglet=machines`); }
  // attribuer à la main la ligne à kit
  const lines = page.getByRole("region", { name: "Commandes payées" });
  await lines.getByRole("button", { name: "Attribuer", exact: true }).first().click();
  await page.screenshot({ path: `${IMG}montage-4-attribuer.png` });
  const d2 = page.getByRole("dialog");
  console.log("DIALOG3:", (await d2.innerText()).replace(/\n+/g, " | "));
  console.log("OPTIONS:", await d2.getByLabel("Machine").locator("option").allInnerTexts());
  await d2.getByRole("button", { name: "Attribuer une machine" }).click();
  await page.waitForTimeout(2000);
  await toast();
  await page.screenshot({ path: `${IMG}montage-5-attribuee.png`, fullPage: true });
});
