import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { signIn, unique } from "./support/auth";
import { adminApi, apiAs, createBatch, newCustomerId, placeOrder, receivePayment } from "./support/orders";

/**
 * Jalon 5 bis (décisions de Hugo du 2026-11-16) côté écrans : numéro de série à la réception, machine dégradée
 * attribuée avec l'acceptation du client, blocages de sortie du Contrôle, mise au rebut avec avertissement puis retour
 * en stock, annulation d'une facture en attente, « Machine attribuée » côté client. L'UI n'empêche jamais, l'API décide.
 */

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

/** Ouvre une page et attend l'hydratation (compilation `next dev` à la première visite) avant de cliquer. */
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

type Machine = { id: string; serial: string | null; functionalStatus: string; logisticalStatus: string };

const serialsOf = (n: number) => Array.from({ length: n }, (_, i) => unique(`SN${i}`).replace(" ", "-"));

/** Palette de 10 machines avec une facture payée (précommande), conduite jusqu'à l'attente de réception ou au Contrôle. */
async function paidPalette(baseURL: string, to: "awaiting_reception" | "inspection", received: string[] = []) {
  const admin = await adminApi(baseURL);
  const batch = await createBatch(admin, { withOptions: false });
  const customerId = newCustomerId();
  const customer = await apiAs(baseURL, customerId, "client-5bis");
  const order = await placeOrder(customer, batch.id);
  await receivePayment(baseURL, order.payment.address, order.payment.expectedSats);
  await expect
    .poll(async () => (await (await customer.get(`/api/orders/${order.id}`)).json()).status, { timeout: 30_000 })
    .toBe("paid");
  let from = "preorder";
  for (const next of to === "inspection" ? ["ordering", "awaiting_reception"] : ["ordering", "awaiting_reception"]) {
    const reply = await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to: next, from } });
    expect(reply.status(), await reply.text()).toBe(201);
    from = next;
  }
  if (to === "inspection") {
    expect((await admin.post(`/api/backoffice/batches/${batch.id}/receptions`, { data: { serials: received } })).status()).toBe(201);
  }
  for (const next of to === "inspection" ? ["inspection"] : []) {
    const reply = await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to: next, from } });
    expect(reply.status(), await reply.text()).toBe(201);
    from = next;
  }
  return { admin, batch, customer, customerId, order };
}

async function machinesOf(admin: APIRequestContext, batchId: string) {
  const data = await (await admin.get(`/api/backoffice/batches/${batchId}/machines`)).json();
  return data as { machines: Machine[]; lines: { lineId: string; machineId: string | null }[] };
}

test("réception : le numéro de série est obligatoire et le message dit quoi faire", async ({ page, baseURL }) => {
  const { admin, batch } = await paidPalette(baseURL!, "awaiting_reception");
  await open(page, `/backoffice/lots/${batch.id}?onglet=machines`);
  const reception = page.getByRole("region", { name: "Réception" });
  await expect(reception.getByLabel("Numéros de série (obligatoires)").first()).toBeVisible();

  // Sans numéro : refusé par l'API, l'écran explique
  await reception.getByRole("button", { name: /Tout recevoir, numéros déjà saisis/ }).click();
  await expect(reception.getByTestId("serial-required").first()).toContainText("Saisissez le numéro de série de chaque machine reçue");

  // Avec numéros : reçues
  const serials = serialsOf(3);
  await reception.getByLabel("Numéros de série (obligatoires)").first().fill(serials.join("\n"));
  await reception.getByRole("button", { name: "Recevoir 3 machines" }).click();
  await expect(reception.getByText("3 machines reçues : à contrôler.")).toBeVisible();
  await expect(page.locator(".ag-row", { hasText: serials[0] }).first()).toBeVisible();
  await admin.dispose();
});

test("machine dégradée : attribuée seulement avec l'acceptation du client, comptée à part, « Machine attribuée » côté client", async ({
  page,
  browser,
  baseURL,
}) => {
  const serials = serialsOf(10);
  const { admin, batch, customerId, order } = await paidPalette(baseURL!, "inspection", serials);
  const { machines } = await machinesOf(admin, batch.id);
  const degraded = machines.find((m) => m.serial === serials[0])!;
  const ok = machines.filter((m) => m.id !== degraded.id).map((m) => m.id);
  expect((await admin.post("/api/backoffice/machines/check-ok", { data: { machineIds: ok } })).status()).toBe(201);
  const set = await admin.post("/api/backoffice/machines/status", {
    data: {
      items: [
        {
          machineId: degraded.id,
          from: { logistical: degraded.logisticalStatus, functional: degraded.functionalStatus },
          to: { functional: "degraded" },
          hashboards: [
            { index: 0, status: "degraded" },
            { index: 1, status: "ok" },
            { index: 2, status: "ok" },
          ],
        },
      ],
    },
  });
  expect(set.status(), await set.text()).toBeLessThan(300);

  // Compteurs : « dégradées » jamais confondues avec « OK »
  await open(page, `/backoffice/lots/${batch.id}`);
  await expect(page.getByTestId("quality-counters")).toContainText("9 OK");
  await expect(page.getByTestId("quality-counters")).toContainText("1 dégradée");
  await open(page, `/backoffice/lots/${batch.id}?onglet=machines`);
  const stats = page.getByRole("region", { name: "Résumé des machines" });
  await expect(stats.locator(".bo-stat", { hasText: "Dégradées" })).toContainText("1");
  await expect(stats.locator(".bo-stat", { hasText: /^OK/ })).toContainText("9");

  // Attribution de la machine dégradée : acceptation du client obligatoire, refusée par l'API sans elle
  const lines = page.getByRole("region", { name: "Commandes payées" });
  await lines.getByRole("button", { name: "Attribuer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Attribuer une machine ?" });
  await dialog.getByLabel("Machine").selectOption({ label: new RegExp(`${serials[0]} · Dégradée`) as never }).catch(async () => {
    await dialog.getByLabel("Machine").selectOption(degraded.id);
  });
  await expect(dialog.getByTestId("degraded-notice")).toContainText("dégradée");
  await dialog.getByLabel(/Motif/).fill("Hashboard 1 dégradée, rabais accordé");
  await dialog.getByRole("button", { name: "Attribuer une machine" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/accept/i);
  await dialog.getByLabel("Le client a accepté explicitement la machine dégradée").check();
  await dialog.getByRole("button", { name: "Attribuer une machine" }).click();
  await expect(page.getByText("Machine attribuée.")).toBeVisible();
  await expect(page.getByTestId("degraded-accepted")).toContainText("acceptée par le client le");

  // Côté client : « Machine attribuée », jamais le numéro de série
  const shopContext = await browser.newContext();
  await signIn(shopContext, baseURL!, customerId, "client-5bis");
  const shop = await shopContext.newPage();
  await open(shop, "/mes-commandes");
  await expect(shop.getByTestId("machines-assigned")).toHaveText("Machine attribuée");
  await open(shop, `/mes-commandes/${order.id}`);
  await expect(shop.getByText("Machine attribuée", { exact: true })).toBeVisible();
  await expect(shop.getByText(serials[0])).toHaveCount(0);
  await shopContext.close();
  await admin.dispose();
});

test("sortie du Contrôle : blocages annoncés avant le clic, puis détail du refus de l'API", async ({ page, baseURL }) => {
  const serials = serialsOf(10);
  // 9 machines reçues, une encore attendue : la sortie est annoncée bloquée avant tout clic
  const { admin, batch } = await paidPalette(baseURL!, "inspection", serials.slice(0, 9));
  await open(page, `/backoffice/lots/${batch.id}`);
  const panel = page.getByRole("group", { name: "Prochaine action" });
  await expect(panel.getByRole("button", { name: /Passer en (tuning|packaging)/ }).first()).toBeDisabled();
  await expect(panel.locator(".bo-blockers").first()).toBeVisible();

  // Tout reçu, contrôlé et attribué : la sortie est libre ; l'admin voit le bouton actif...
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/receptions`, { data: { serials: [serials[9]] } })).status()).toBe(201);
  const { machines } = await machinesOf(admin, batch.id);
  expect((await admin.post("/api/backoffice/machines/check-ok", { data: { machineIds: machines.map((m) => m.id) } })).status()).toBe(201);
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/assignments/auto`, { data: {} })).status()).toBe(201);
  await open(page, `/backoffice/lots/${batch.id}`);
  const packaging = panel.getByRole("button", { name: "Passer en packaging" });
  await expect(packaging).toBeEnabled();

  // ... mais l'attribution est retirée entre-temps (autre onglet) : l'API refuse, la ligne fautive est nommée
  const { lines } = await machinesOf(admin, batch.id);
  const removed = await admin.post(`/api/backoffice/order-lines/${lines[0].lineId}/assignment`, {
    data: { expectedMachineId: lines[0].machineId, machineId: null, reason: "Test e2e" },
  });
  expect(removed.status(), await removed.text()).toBeLessThan(300);
  await packaging.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirmer", exact: true }).click();
  await expect(dialog.getByTestId("exit-blockers")).toContainText("Lignes payées sans machine");
  await expect(dialog.getByTestId("exit-blockers").getByRole("link", { name: /Facture · machine 1/ })).toBeVisible();
  await admin.dispose();
});

test("rebut : gros avertissement avant validation, puis « Remettre en stock » avec motif", async ({ page, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const model = await (
    await admin.post("/api/backoffice/models", { data: { name: unique("S19R"), hashrate: "14000000000000", hashboardQtt: 3 } })
  ).json();
  const batch = await (await admin.post("/api/backoffice/batches", { data: { kind: "stock", modelId: model.id, resaleUnitPrice: "52000" } })).json();
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/restocks`, { data: { quantity: 1, purchasePrice: "45000" } })).status()).toBe(201);
  const serial = unique("SN-R").replace(" ", "-");
  const received = await (await admin.post(`/api/backoffice/batches/${batch.id}/receptions`, { data: { serials: [serial] } })).json();
  const machine = (received.machines as Machine[])[0];
  const dead = await admin.post("/api/backoffice/machines/status", {
    data: {
      items: [
        {
          machineId: machine.id,
          from: { logistical: machine.logisticalStatus, functional: machine.functionalStatus },
          to: { functional: "faulty" },
          hashboards: [
            { index: 0, status: "dead" },
            { index: 1, status: "ok" },
            { index: 2, status: "ok" },
          ],
        },
      ],
    },
  });
  expect(dead.status(), await dead.text()).toBeLessThan(300);

  await open(page, `/backoffice/machines/${machine.id}`);
  await page.getByRole("button", { name: /Mettre au rebut/i }).click();
  const scrap = page.getByRole("dialog");
  await expect(scrap.getByTestId("scrap-warning")).toContainText("action lourde");
  await scrap.getByLabel(/Motif/).fill("Carte mère irréparable");
  await scrap.getByRole("button", { name: /Mettre au rebut/i }).click();
  await expect(page.getByText(/passée à « Au rebut »|Au rebut/).first()).toBeVisible();

  // Retour en stock : motif obligatoire
  await page.getByRole("button", { name: "Remettre en stock" }).click();
  const back = page.getByRole("dialog");
  await back.getByRole("button", { name: "Remettre en stock" }).click();
  await expect(back.getByText("Indiquez le motif de ce changement.")).toBeVisible();
  await back.getByLabel(/Motif/).fill("Erreur de saisie : la machine est réparable");
  await back.getByRole("button", { name: "Remettre en stock" }).click();
  await expect(page.getByText("Machine passée à « En stock ».")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remettre en stock" })).toHaveCount(0);
  await admin.dispose();
});

test("facture en attente : « Annuler la facture » libère la réservation (cause admin)", async ({ page, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false });
  const customer = await apiAs(baseURL!, newCustomerId(), "client-attente");
  const order = await placeOrder(customer, batch.id);

  await open(page, `/backoffice/factures/${order.id}`);
  await page.getByRole("button", { name: "Annuler la facture" }).click();
  const dialog = page.getByRole("dialog", { name: "Annuler cette facture ?" });
  await dialog.getByRole("button", { name: "Annuler la facture" }).click();
  await expect(page.getByText("Facture annulée : les places réservées sont libérées.")).toBeVisible();
  await expect(page.getByText("Annulée par la boutique")).toBeVisible();
  await expect(page.getByRole("button", { name: "Annuler la facture" })).toHaveCount(0);
  await admin.dispose();
});

test("marquer morte une machine d'une palette pleine : succès sans confirmation, remboursement affiché", async ({ page, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const batch = await createBatch(admin, { withOptions: false, path: ["preorder"] });
  const customer = await apiAs(baseURL!, newCustomerId(), "client-plein");
  // Palette pleine : 10 lignes payées pour 10 machines, toutes reçues et non attribuées
  const order = await placeOrder(customer, batch.id, { lines: 10 });
  await receivePayment(baseURL!, order.payment.address, order.payment.expectedSats);
  await expect
    .poll(async () => (await (await customer.get(`/api/orders/${order.id}`)).json()).status, { timeout: 30_000 })
    .toBe("paid");
  let from = "preorder";
  for (const next of ["ordering", "awaiting_reception"]) {
    expect((await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to: next, from } })).status()).toBe(201);
    from = next;
  }
  const received = await admin.post(`/api/backoffice/batches/${batch.id}/receptions`, { data: { serials: serialsOf(10) } });
  expect(received.status(), await received.text()).toBe(201);
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to: "inspection", from } })).status()).toBe(201);
  const machine = (await machinesOf(admin, batch.id)).machines[0];

  await open(page, `/backoffice/machines/${machine.id}`);
  await page.getByRole("button", { name: /Corriger le contrôle|Contrôler/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Défectueuse" }).check({ force: true });
  await dialog.getByRole("group", { name: /Hashboard 1/ }).getByRole("radio", { name: "Morte" }).check({ force: true });
  await dialog.getByLabel(/Motif|Note/).fill("Hashboard grillée");
  await dialog.getByRole("button", { name: "Enregistrer le contrôle" }).click();

  // Aucune annonce ni confirmation : le marquage réussit et la commande remboursée est affichée
  await expect(page.getByText(/Machine contrôlée : « Défectueuse »\./)).toBeVisible();
  await expect(page.getByText(/commande payée en trop a été remboursée/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await customer.dispose();
  await admin.dispose();
});

test("machine morte sans machine libre : « Aucune machine de remplacement » et annulation de la ligne ou de la facture", async ({ page, baseURL }) => {
  const serials = serialsOf(1);
  const { admin, batch, order } = await paidPalette(baseURL!, "inspection", serials);
  const { machines, lines } = await machinesOf(admin, batch.id);
  const machine = machines.find((m) => m.serial === serials[0])!;
  expect((await admin.post("/api/backoffice/machines/check-ok", { data: { machineIds: [machine.id] } })).status()).toBe(201);
  const assigned = await admin.post(`/api/backoffice/order-lines/${lines[0].lineId}/assignment`, { data: { expectedMachineId: null, machineId: machine.id } });
  expect(assigned.status(), await assigned.text()).toBe(201);
  const dead = await admin.post("/api/backoffice/machines/status", {
    data: {
      items: [{ machineId: machine.id, from: { logistical: "in_stock", functional: "ok" }, to: { functional: "faulty" }, note: "Morte" }],
    },
  });
  expect(dead.status(), await dead.text()).toBe(201);

  await open(page, `/backoffice/lots/${batch.id}?onglet=machines`);
  await expect(page.getByTestId("no-replacement-alert")).toContainText("Aucune machine de remplacement disponible");
  await expect(page.getByTestId("no-replacement").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Annuler la ligne" })).toBeVisible();
  await page.getByRole("button", { name: "Annuler la facture" }).click();
  const dialog = page.getByRole("dialog", { name: "Annuler la facture ?" });
  await dialog.getByRole("button", { name: "Annuler la facture" }).click();
  await expect(page.getByText("Facture annulée et remboursée.")).toBeVisible();
  const refunded = await (await admin.get(`/api/backoffice/orders/${order.id}`)).json();
  expect(refunded.status).toBe("refunded");
  expect(refunded.refunds[0]).toMatchObject({ cause: "shop_defective_machine", initiatedBy: "admin", networkFeePayer: "shop" });
  await admin.dispose();
});

// R4b lot 3 (décision Hugo 2026-11-16) : le bouton groupé grisé dit pourquoi, avec les machines bloquées.
test("actions groupées : « Remettre au transporteur » grisé explique les raisons et nomme les machines bloquées", async ({ page, baseURL }) => {
  const admin = await adminApi(baseURL!);
  const model = await (
    await admin.post("/api/backoffice/models", { data: { name: unique("S9"), hashrate: "14000000000000", hashboardQtt: 3 } })
  ).json();
  const batch = await (await admin.post("/api/backoffice/batches", { data: { kind: "stock", modelId: model.id, resaleUnitPrice: "52000" } })).json();
  const serials = serialsOf(2);
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/restocks`, { data: { quantity: 2, purchasePrice: "90000" } })).status()).toBe(201);
  const received = await (await admin.post(`/api/backoffice/batches/${batch.id}/receptions`, { data: { serials } })).json();
  const ids = (received.machines as { id: string }[]).map((m) => m.id);
  expect((await admin.post("/api/backoffice/machines/check-ok", { data: { machineIds: ids } })).status()).toBe(201);
  const ready = await admin.post("/api/backoffice/machines/status", {
    data: { items: ids.map((machineId) => ({ machineId, from: { logistical: "in_stock", functional: "ok" }, to: { logistical: "ready" } })) },
  });
  expect(ready.status(), await ready.text()).toBeLessThan(300);

  await open(page, `/backoffice/lots/${batch.id}?onglet=machines`);
  for (const serial of serials) await page.locator(".ag-row", { hasText: serial }).first().getByRole("checkbox").check();
  const ship = page.getByRole("group", { name: "Actions sur les machines cochées" }).getByRole("button", { name: /Remettre au transporteur/ });
  await expect(ship).toBeDisabled();
  const why = page.getByTestId("group-blocked-ship");
  await expect(why).toContainText("Attribuez d'abord la machine à une commande payée");
  await expect(why).toContainText("2 machines");
  for (const serial of serials) await expect(why).toContainText(serial);
  await expect(ship).toHaveAttribute("title", /Attribuez d'abord/);
  await admin.dispose();
});

test("import CSV du contrôle : erreurs par ligne, aperçu, puis import et résumé", async ({ page, baseURL }) => {
  const serials = serialsOf(10);
  const { admin, batch } = await paidPalette(baseURL!, "inspection", serials);
  await open(page, `/backoffice/lots/${batch.id}?onglet=machines`);
  await page.getByRole("button", { name: "Importer un contrôle (CSV)" }).click();
  const dialog = page.getByRole("dialog", { name: "Importer un contrôle (CSV)" });
  await expect(dialog.getByText("name,serial,board1_statut,board2_statut,board3_statut")).toBeVisible();
  const file = (rows: string[]) => ({
    name: "controle.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(["name,serial,board1_statut,board2_statut,board3_statut", ...rows].join("\n")),
  });

  // Statut inconnu : refusé par l'API, erreur à la ligne, import bloqué
  await dialog.getByLabel("Fichier CSV").setInputFiles(file([`,${serials[0]},ok,cassée,ok`]));
  await expect(dialog.getByTestId("import-issues")).toContainText("Ligne 2");
  await expect(dialog.getByRole("button", { name: /^Importer/ })).toBeDisabled();

  // Fichier correct : aperçu, puis import
  await dialog.getByLabel("Fichier CSV").setInputFiles(file([`,${serials[0]},ok,ok,ok`, `,${serials[1]},ok,dead,ok`]));
  const preview = dialog.getByTestId("import-preview");
  await expect(preview.locator("tr", { hasText: serials[1] })).toContainText("Non contrôlée → Dégradée");
  await dialog.getByRole("button", { name: "Importer 2 machines" }).click();
  await expect(page.getByText("Contrôle importé : 2 machines contrôlées, dont 1 passée « Dégradée ».")).toBeVisible();
  const { machines } = await machinesOf(admin, batch.id);
  expect(machines.find((m) => m.serial === serials[1])?.functionalStatus).toBe("degraded");
  await admin.dispose();
});
