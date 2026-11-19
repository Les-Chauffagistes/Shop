import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../support/auth";
import { montageBatch, setStatus, st, type TransitionJson } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => { await signIn(context, baseURL!); });
// Hors du projet : une image écrite dans le dossier fait recompiler `next dev` et recharger les pages en boucle
const IMG = join(process.env.E2E_OUTPUT_DIR ?? join(tmpdir(), "shop-e2e-results"), "logisticien-");
// Scénario d'exploration (attentes fixes, captures) : plus long que le délai par défaut
test.setTimeout(180_000);
async function open(page: Page, url: string) { await page.goto(url); await page.waitForLoadState("networkidle"); }
const toast = async (page: Page) => console.log("MSG:", (await page.locator("[role=status],[role=alert]").allInnerTexts()).join(" // "));

test("non conforme visible, envoi refusé, correction, tuning, packaging, envoi, livraison", async ({ page, baseURL }) => {
  const b = await montageBatch(baseURL!, [true, false]);
  let d = await b.get();
  const [m0] = d.machines;
  // monter m0 avec kit, prête, attribuée à la ligne à kit (API), puis démontée (retour en stock)
  expect((await setStatus(b.admin, [st(m0, { logistical: "in_preparation" }, { mounting: [b.silentId] })])).status()).toBe(201);
  d = await b.get();
  expect((await setStatus(b.admin, [st(d.machines[0], { logistical: "ready" })])).status()).toBe(201);
  d = await b.get();
  const kitLine = d.lines.find((l) => l.mounting.required.length)!;
  expect((await b.admin.post(`/api/backoffice/order-lines/${kitLine.lineId}/assignment`, { data: { expectedMachineId: null, machineId: m0.id } })).status()).toBe(201);
  d = await b.get();
  expect((await setStatus(b.admin, [st(d.machines[0], { logistical: "in_stock" }, { note: "démontage du kit" })])).status()).toBe(201);
  d = await b.get();
  expect((await setStatus(b.admin, [st(d.machines[0], { logistical: "ready" })])).status()).toBe(201); // prête brute, attribuée

  await open(page, `/backoffice/lots/${b.batchId}?onglet=machines`);
  await expect(page.getByTestId("mounting-mismatch")).toBeVisible();
  await page.screenshot({ path: `${IMG}montage-6-non-conforme.png`, fullPage: true });
  console.log("HINT:", (await page.getByText(/À faire/).first().innerText()));
  console.log("NEXT:", (await page.getByRole("group", { name: "Prochaine action" }).innerText()).replace(/\n+/g, " | "));

  // envoi depuis l'UI de la machine non conforme
  await page.locator(".ag-row", { hasText: b.serials[0] }).first().getByRole("checkbox").check();
  const ship = page.getByRole("group", { name: "Actions sur les machines cochées" }).getByRole("button", { name: /^Remettre au transporteur/ });
  console.log("ship enabled:", await ship.isEnabled(), "title:", await ship.getAttribute("title"));
  if (await ship.isEnabled()) {
    await ship.click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: /Remettre au transporteur/ }).click();
    await page.waitForTimeout(2000);
    console.log("SHIP DIALOG:", (await dlg.innerText()).replace(/\n+/g, " | "));
    await page.screenshot({ path: `${IMG}montage-7-envoi-refuse.png` });
    await page.keyboard.press("Escape");
  }
  // fiche machine : nextChanges / blockers
  await open(page, `/backoffice/machines/${m0.id}`);
  await page.screenshot({ path: `${IMG}montage-8-fiche.png`, fullPage: true });
  console.log("FICHE:", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 900));

  // correction : retour stock, remontage kit, prête (API), puis tuning -> packaging via UI
  d = await b.get();
  await setStatus(b.admin, [st(d.machines[0], { logistical: "in_stock" }, { note: "remontage" })]);
  d = await b.get();
  await setStatus(b.admin, [st(d.machines[0], { logistical: "in_preparation" }, { mounting: [b.silentId] })]);
  d = await b.get();
  await setStatus(b.admin, [st(d.machines[0], { logistical: "ready" })]);
  await b.admin.post(`/api/backoffice/batches/${b.batchId}/assignments/auto`, { data: {} });
  d = await b.get();
  console.log("lines:", d.lines.map((l) => `${l.mounting.required.length}/${!!l.machineId}/${l.mounting.conform}`));
  const bt = await (await b.admin.get(`/api/backoffice/batches/${b.batchId}`)).json();
  console.log("transitions:", bt.transitions.map((t: TransitionJson) => `${t.to}:${t.allowed}:${(t.blockers ?? []).join("|")}`));
  for (const to of ["tuning", "packaging"]) {
    const cur = (await (await b.admin.get(`/api/backoffice/batches/${b.batchId}`)).json());
    const r = await b.admin.post(`/api/backoffice/batches/${b.batchId}/transitions`, { data: { to, from: cur.status } });
    console.log("->", to, r.status(), r.status() > 299 ? await r.text() : "");
  }
  d = await b.get();
  for (const m of d.machines.filter((m) => m.line && m.logisticalStatus !== "ready")) await setStatus(b.admin, [st(m, { logistical: "ready" })]);
  await open(page, `/backoffice/lots/${b.batchId}?onglet=machines`);
  await page.waitForTimeout(1500);
  for (const s of b.serials) { const row = page.locator(".ag-row", { hasText: s }).first(); if (await row.getByText("Prête").count()) await page.waitForTimeout(500); await row.getByRole("checkbox").click(); }
  await page.getByRole("group", { name: "Actions sur les machines cochées" }).getByRole("button", { name: /^Remettre au transporteur/ }).click();
  const dlg = page.getByRole("dialog");
  console.log("SHIP2:", (await dlg.innerText()).replace(/\n+/g, " | "));
  await dlg.getByLabel("Transporteur").first().fill("DHL");
  await dlg.getByLabel("Numéro de suivi").first().fill("TRK1");
  await dlg.getByLabel("Lien de suivi").first().fill("https://t.example.com/TRK1");
  await dlg.getByRole("button", { name: /Remettre au transporteur/ }).click();
  await page.waitForTimeout(2500);
  await toast(page);
  await page.screenshot({ path: `${IMG}montage-9-expedie.png`, fullPage: true });
});
