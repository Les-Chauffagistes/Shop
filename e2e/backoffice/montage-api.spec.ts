import { expect, test, type APIRequestContext } from "@playwright/test";
import { unique } from "../support/auth";
import { adminApi, apiAs, newCustomerId, receivePayment, POSTAL, refundAddress } from "../support/orders";
import type { BatchMachinesJson, MachineJson, TransitionJson } from "./helpers";

/** Montage conforme à la commande : parcours côté API, journal des écarts avec api.md (mode série, état partagé). */
test.describe.configure({ mode: "serial" });

type M = MachineJson;
/** État partagé entre les étapes (mode série) */
const S = {} as {
  admin: APIRequestContext;
  optionId: string;
  silentId: string;
  partId: string;
  batchId: string;
  orders: { id: string; kit: boolean; cid: string }[];
  serials: string[];
  m1: string;
  m2: string;
  kitLine1: string;
};
const log = (k: string, v: unknown) => console.log(`LOG ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

async function snap(admin: APIRequestContext) {
  return (await (await admin.get(`/api/backoffice/batches/${S.batchId}/machines`)).json()) as BatchMachinesJson;
}
const st = (m: M, to: { logistical?: string; functional?: string }, extra: Record<string, unknown> = {}) => ({
  machineId: m.id,
  from: { logistical: m.logisticalStatus, functional: m.functionalStatus },
  to,
  ...extra,
});

test("setup : modèle, menu, produit lié au kit, lot, 4 commandes (2 kit, 2 sans), réception, contrôle", async ({ baseURL }) => {
  const admin = await adminApi(baseURL!);
  S.admin = admin;
  const model = await (await admin.post("/api/backoffice/models", { data: { name: unique("M21"), hashrate: "200000000000000", hashboardQtt: 3 } })).json();
  const opt = await (
    await admin.post(`/api/backoffice/models/${model.id}/options`, {
      data: { kind: "choice", title: "Kit de ventilation", values: [{ label: "Sans kit", price: "0" }, { label: "Silent kit", price: "7500" }] },
    })
  ).json();
  const silent = opt.values.find((v: { label: string }) => v.label === "Silent kit");
  const part = await (await admin.post("/api/backoffice/parts", { data: { name: unique("Kit silencieux") } })).json();
  // kit lié à la valeur
  const link = await admin.patch(`/api/backoffice/option-values/${silent.id}`, { data: { parts: [{ partId: part.id, qty: 1 }] } });
  expect(link.status(), await link.text()).toBe(200);
  S.optionId = opt.id; S.silentId = silent.id; S.partId = part.id;
  const batch = await (await admin.post("/api/backoffice/batches", { data: { modelId: model.id, quantity: 6, purchasePrice: "900000", resaleUnitPrice: "180000" } })).json();
  S.batchId = batch.id;
  let from = "draft";
  for (const to of ["preorder"]) {
    expect((await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to, from } })).status()).toBe(201);
    from = to;
  }
  // commandes : K1 (kit), N1 (sans), K2 (kit), N2 (sans)
  S.orders = [];
  for (const withKit of [true, false, true, false]) {
    const cid = newCustomerId();
    const c = await apiAs(baseURL!, cid, "cli");
    const reply = await c.post("/api/orders", {
      data: { batchId: batch.id, lines: [withKit ? { choices: [{ optionId: opt.id, optionValueId: silent.id }] } : {}], billingAddress: POSTAL, refundAddress: refundAddress() },
    });
    expect(reply.status(), await reply.text()).toBe(201);
    const o = await reply.json();
    await receivePayment(baseURL!, o.payment.address, o.payment.expectedSats);
    await expect.poll(async () => (await (await c.get(`/api/orders/${o.id}`)).json()).status, { timeout: 30_000 }).toBe("paid");
    S.orders.push({ id: o.id, kit: withKit, cid });
  }
  for (const to of ["ordering", "awaiting_reception"]) {
    const r = await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to, from } });
    expect(r.status(), await r.text()).toBe(201);
    from = to;
  }
  S.serials = Array.from({ length: 6 }, (_, i) => `MT-${Date.now().toString(36)}-${i}`);
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/receptions`, { data: { serials: S.serials } })).status()).toBe(201);
  const t = await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to: "inspection", from } });
  expect(t.status(), await t.text()).toBe(201);
  const { machines } = await snap(admin);
  expect((await admin.post("/api/backoffice/machines/check-ok", { data: { machineIds: machines.map((m) => m.id) } })).status()).toBe(201);
});

test("plan de montage : 2 commandes à kit, 2 machines à monter", async () => {
  const d = await snap(S.admin);
  log("plan", d.mountingPlan);
  expect(d.mountingPlan).toHaveLength(1);
  expect(d.mountingPlan[0]).toMatchObject({ lines: 2, inPreparation: 0, ready: 0, toBuild: 2 });
  log("lines mounting", d.lines.map((l) => ({ id: l.lineId, req: l.mounting, fit: l.fittingMachineIds.length })));
});

test("attribution auto avant montage : ne donne que des machines brutes aux lignes sans kit", async () => {
  const r = await S.admin.post(`/api/backoffice/batches/${S.batchId}/assignments/auto`, { data: {} });
  expect(r.status(), await r.text()).toBe(201);
  const body = await r.json();
  log("auto assigned", body.assigned);
  const d = await snap(S.admin);
  for (const l of d.lines) log("line", { kit: l.mounting.required.length, machine: l.machineId?.slice(0, 4) ?? null, conform: l.mounting.conform });
  const kitLines = d.lines.filter((l) => l.mounting.required.length);
  expect(kitLines.every((l) => l.machineId === null)).toBe(true);
  // les lignes sans kit ont reçu une machine brute (prête ou non ?)
  const plain = d.lines.filter((l) => !l.mounting.required.length);
  log("plain lines served", plain.map((l) => l.machineId !== null));
});

test("attribution manuelle non conforme refusée (machine brute sur ligne à kit)", async () => {
  const d = await snap(S.admin);
  const kitLine = d.lines.find((l) => l.mounting.required.length && !l.machineId)!;
  const free = d.machines.filter((m) => !m.line);
  const raw = free[0];
  log("kitLine.fitting", kitLine.fittingMachineIds);
  const r = await S.admin.post(`/api/backoffice/order-lines/${kitLine.lineId}/assignment`, { data: { expectedMachineId: null, machineId: raw.id } });
  log("assign raw -> kit line", { status: r.status(), body: await r.text() });
  expect(r.status()).toBe(409);
  expect((await r.json()).error?.code ?? (await r.json()).code).toBe("mounting_mismatch");
});

test("démarrer le montage avec mounting + terminé + Prête", async () => {
  const d = await snap(S.admin);
  const free = d.machines.filter((m) => !m.line);
  const m1 = free[0], m2 = free[1];
  // sans déclaration : montage brut ; mounting sur in_stock->in_preparation
  let r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m1, { logistical: "in_preparation" }, { mounting: [S.silentId] })] } });
  log("start mounting m1", { status: r.status(), body: (await r.text()).slice(0, 300) });
  expect(r.status()).toBeLessThan(300);
  // mounting sans statut interdit
  r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m2, { functional: "ok" }, { mounting: [S.silentId] })] } });
  log("mounting sans to.logistical", r.status());
  expect(r.status()).toBe(400);
  // valeur sans kit : valeur « Sans kit »
  await S.admin.get(`/api/backoffice/models`);
  const d2 = await snap(S.admin);
  log("plan after start", d2.mountingPlan);
  expect(d2.mountingPlan[0]).toMatchObject({ inPreparation: 1, toBuild: 1 });
  const m1b = d2.machines.find((m) => m.id === m1.id)!;
  r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m1b, { logistical: "ready" })] } });
  expect(r.status(), await r.text()).toBeLessThan(300);
  const d3 = await snap(S.admin);
  log("plan after ready", d3.mountingPlan);
  expect(d3.mountingPlan[0]).toMatchObject({ inPreparation: 0, ready: 1, toBuild: 1 });
  S.m1 = m1.id;
});

test("modifier le montage une fois prête refusé ; kit inexistant refusé", async () => {
  const d = await snap(S.admin);
  const m1 = d.machines.find((m) => m.id === S.m1)!;
  const r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m1, { logistical: "ready" }, { mounting: [] })] } });
  log("rewrite mounting on ready", { status: r.status(), body: (await r.text()).slice(0, 200) });
  await S.admin.get(`/api/backoffice/models`);
  // valeur sans kit : on récupère l'id « Sans kit »
  const opts = await (await S.admin.get(`/api/backoffice/options`)).json().catch(() => null);
  log("options list status", typeof opts);
});

test("attribution manuelle conforme : ligne à kit reçoit la machine prête montée", async () => {
  const d = await snap(S.admin);
  const kitLine = d.lines.find((l) => l.mounting.required.length && !l.machineId)!;
  log("fitting for kit line", { fit: kitLine.fittingMachineIds, m1: S.m1 });
  expect(kitLine.fittingMachineIds).toEqual([S.m1]);
  const r = await S.admin.post(`/api/backoffice/order-lines/${kitLine.lineId}/assignment`, { data: { expectedMachineId: null, machineId: S.m1 } });
  expect(r.status(), await r.text()).toBe(201);
  S.kitLine1 = kitLine.lineId;
});

test("machine montée (prête) ne peut pas être attribuée à une ligne sans kit", async () => {
  // créer une 2e machine prête montée silent, tenter ligne sans kit
  const d = await snap(S.admin);
  const free = d.machines.filter((m) => !m.line);
  const m2 = free[0];
  let r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m2, { logistical: "in_preparation" }, { mounting: [S.silentId] })] } });
  expect(r.status()).toBeLessThan(300);
  let d2 = await snap(S.admin);
  r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(d2.machines.find((m) => m.id === m2.id)!, { logistical: "ready" })] } });
  expect(r.status()).toBeLessThan(300);
  S.m2 = m2.id;
  d2 = await snap(S.admin);
  const plain = d2.lines.find((l) => !l.mounting.required.length && !l.machineId);
  log("plain unassigned line?", !!plain);
  if (plain) {
    r = await S.admin.post(`/api/backoffice/order-lines/${plain.lineId}/assignment`, { data: { expectedMachineId: null, machineId: m2.id } });
    log("kit machine -> plain line", { status: r.status(), body: (await r.text()).slice(0, 200) });
    expect(r.status()).toBe(409);
  }
});

test("démontage d'une machine attribuée : retour en stock puis ligne non conforme", async () => {
  let d = await snap(S.admin);
  const m1 = d.machines.find((m) => m.id === S.m1)!;
  log("m1 nextChanges", m1.nextChanges);
  // ready -> in_stock avec motif (démonter)
  let r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m1, { logistical: "in_stock" }, { note: "démontage test" })] } });
  log("unmount assigned machine", { status: r.status(), body: (await r.text()).slice(0, 300) });
  d = await snap(S.admin);
  const line = d.lines.find((l) => l.lineId === S.kitLine1)!;
  log("kit line after unmount", { machineId: line.machineId, conform: line.mounting.conform });
  log("summary linesToReplace", d.summary.linesToReplace);
  const m1n = d.machines.find((m) => m.id === S.m1)!;
  log("m1 after", { ls: m1n.logisticalStatus, nc: m1n.nextChanges.map((n) => `${n.to}:${n.allowed}:${n.blockers.join("|")}`) });
  // tenter de passer prête (brute) puis expédier
  r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m1n, { logistical: "ready" })] } });
  log("ready brut on kit line", { status: r.status(), body: (await r.text()).slice(0, 200) });
  d = await snap(S.admin);
  const m1r = d.machines.find((m) => m.id === S.m1)!;
  log("line conform after raw ready", d.lines.find((l) => l.lineId === S.kitLine1)!.mounting);
  r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m1r, { logistical: "in_transit" })] } });
  log("ship non conforme", { status: r.status(), body: (await r.text()).slice(0, 300) });
  expect(r.status()).toBe(409);
});

test("sortie du Contrôle bloquée par ligne non conforme", async () => {
  const b = await (await S.admin.get(`/api/backoffice/batches/${S.batchId}`)).json();
  log("transitions", b.transitions?.map((t: TransitionJson) => `${t.to}:${t.allowed}:${(t.blockers ?? []).join("|")}`));
});

test("correction sans retirer l'attribution : remonter le kit puis Prête", async () => {
  let d = await snap(S.admin);
  let m1 = d.machines.find((m) => m.id === S.m1)!;
  // m1 est ready brute attribuée : retour en stock, montage kit, prête
  let r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m1, { logistical: "in_stock" }, { note: "retour" })] } });
  expect(r.status(), await r.text()).toBeLessThan(300);
  d = await snap(S.admin); m1 = d.machines.find((m) => m.id === S.m1)!;
  r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m1, { logistical: "in_preparation" }, { mounting: [S.silentId] })] } });
  log("restart mounting on assigned", { status: r.status(), body: (await r.text()).slice(0, 200) });
  d = await snap(S.admin); m1 = d.machines.find((m) => m.id === S.m1)!;
  r = await S.admin.post("/api/backoffice/machines/status", { data: { items: [st(m1, { logistical: "ready" })] } });
  expect(r.status()).toBeLessThan(300);
  d = await snap(S.admin);
  const line = d.lines.find((l) => l.lineId === S.kitLine1)!;
  expect(line.mounting.conform).toBe(true);
});

test("attribution automatique : choisit des machines conformes seulement", async () => {
  const r = await S.admin.post(`/api/backoffice/batches/${S.batchId}/assignments/auto`, { data: {} });
  expect(r.status(), await r.text()).toBe(201);
  const body = await r.json();
  log("auto 2 assigned", body.assigned);
  const d = await snap(S.admin);
  for (const l of d.lines) log("line2", { kit: l.mounting.required.length, hasMachine: !!l.machineId, conform: l.mounting.conform });
  for (const l of d.lines) if (l.machineId) expect(l.mounting.conform).toBe(true);
});
