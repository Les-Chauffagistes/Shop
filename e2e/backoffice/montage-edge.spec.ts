import { test, type APIResponse } from "@playwright/test";
import { montageBatch, setStatus, st, type MachineJson } from "./helpers";

const log = (k: string, v: unknown) => console.log(`LOG ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const brief = async (r: APIResponse) => ({ s: r.status(), b: (await r.text()).slice(0, 220) });

test("cas limites du montage (journal)", async ({ baseURL }) => {
  const b = await montageBatch(baseURL!, [true, true, false], { quantity: 6 });
  const a = b.admin;
  let d = await b.get();
  const [m0] = d.machines;
  // 1 valeur sans kit
  log("mounting Sans kit", await brief(await setStatus(a, [st(m0, { logistical: "in_preparation" }, { mounting: [b.noneId] })])));
  // 2 id inconnu
  log("mounting uuid inconnu", await brief(await setStatus(a, [st(m0, { logistical: "in_preparation" }, { mounting: ["00000000-0000-4000-8000-000000000000"] })])));
  // 3 doublon
  log("mounting doublon", await brief(await setStatus(a, [st(m0, { logistical: "in_preparation" }, { mounting: [b.silentId, b.silentId] })])));
  d = await b.get();
  log("m0 now", d.machines[0].logisticalStatus);
  // 4 machine en montage (pas prête) -> attribution ligne kit
  d = await b.get();
  const kitLine = d.lines.find((l) => l.mounting.required.length)!;
  const mm = d.machines.find((m) => m.logisticalStatus === "in_preparation") ?? d.machines[0];
  if (mm.logisticalStatus !== "in_preparation") await setStatus(a, [st(mm, { logistical: "in_preparation" }, { mounting: [b.silentId] })]);
  log("assign in_preparation -> kit line", await brief(await a.post(`/api/backoffice/order-lines/${kitLine.lineId}/assignment`, { data: { expectedMachineId: null, machineId: mm.id } })));
  // 5 changer le montage pendant in_preparation -> ready en un appel
  d = await b.get();
  const mp = d.machines.find((m) => m.id === mm.id)!;
  log("redeclare brut at ready", await brief(await setStatus(a, [st(mp, { logistical: "ready" }, { mounting: [] })])));
  d = await b.get();
  log("mounting after", d.machines.find((m) => m.id === mm.id)!.mounting);
  // 6 retirer le lien produit de la valeur alors qu'une machine est montée et des lignes l'exigent
  const unlink = await a.patch(`/api/backoffice/option-values/${b.silentId}`, { data: { parts: [] } });
  log("unlink kit après commandes payées", await brief(unlink));
  d = await b.get();
  log("plan après unlink", d.mountingPlan.map((p) => ({ lines: p.lines, toBuild: p.toBuild })));
  log("lines après unlink", d.lines.map((l) => `${l.mounting.required.length}/${l.mounting.conform}/${l.fittingMachineIds.length}`));
  await a.patch(`/api/backoffice/option-values/${b.silentId}`, { data: { parts: [{ partId: b.partId, qty: 1 }] } });
  // 7 transfert d'une machine montée au stock
  d = await b.get();
  const ready: MachineJson | undefined = d.machines.find((m) => m.logisticalStatus === "ready");
  log("ready machine", ready ? ready.id : "none");
  if (ready) log("transfer ready/mounted -> stock", await brief(await a.post(`/api/backoffice/batches/${b.batchId}/transfers`, { data: { machineIds: [ready.id], note: "t" } })));
  // 8 remplacement sur ligne à kit sans machine conforme libre
  d = await b.get();
  const assigned = d.lines.filter((l) => l.machineId);
  log("assigned lines", assigned.length);
  // 9 vente manuelle
  const opts = await a.get(`/api/backoffice/batches/${b.batchId}`);
  log("batch ok", opts.status());
});
