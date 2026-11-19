import { expect, type APIRequestContext } from "@playwright/test";
import { unique } from "../support/auth";
import { adminApi, apiAs, newCustomerId, receivePayment, POSTAL, refundAddress } from "../support/orders";

/** Réponses JSON lues par les scénarios de montage (champs utilisés seulement). */
export type MachineJson = {
  id: string;
  serial: string | null;
  logisticalStatus: string;
  functionalStatus: string;
  updatedAt: string;
  mounting: { optionValueId: string; option: string; value: string }[];
  line: { lineId: string } | null;
  nextChanges: { to: string; allowed: boolean; blockers: string[] }[];
};
export type LineJson = {
  lineId: string;
  machineId: string | null;
  fittingMachineIds: string[];
  mounting: { required: { optionValueId: string; value: string }[]; conform: boolean | null };
};
export type PlanJson = { lines: number; inPreparation: number; ready: number; toBuild: number };
export type BatchMachinesJson = { machines: MachineJson[]; lines: LineJson[]; mountingPlan: PlanJson[]; summary: { linesToReplace: number } };
export type TransitionJson = { to: string; allowed: boolean; blockers?: string[] };
type OptionValueJson = { id: string; label: string };
type StatusTarget = { logistical?: string; functional?: string };

/**
 * Lot de `quantity` machines, option « Kit de ventilation » (Sans kit / Silent kit lié à un produit), commandes payées
 * (`kits[i]` : avec ou sans kit), réception, passage au Contrôle, machines contrôlées OK (`check`).
 */
export async function montageBatch(baseURL: string, kits: boolean[], { quantity = kits.length + 2, check = true } = {}) {
  const admin = await adminApi(baseURL);
  const model = await (await admin.post("/api/backoffice/models", { data: { name: unique("M21"), hashrate: "200000000000000", hashboardQtt: 3 } })).json();
  const opt = await (
    await admin.post(`/api/backoffice/models/${model.id}/options`, {
      data: { kind: "choice", title: "Kit de ventilation", values: [{ label: "Sans kit", price: "0" }, { label: "Silent kit", price: "7500" }] },
    })
  ).json();
  const silent = opt.values.find((v: OptionValueJson) => v.label === "Silent kit");
  const none = opt.values.find((v: OptionValueJson) => v.label === "Sans kit");
  const part = await (await admin.post("/api/backoffice/parts", { data: { name: unique("Kit silencieux") } })).json();
  const link = await admin.patch(`/api/backoffice/option-values/${silent.id}`, { data: { parts: [{ partId: part.id, qty: 1 }] } });
  expect(link.status(), await link.text()).toBe(200);
  const batch = await (await admin.post("/api/backoffice/batches", { data: { modelId: model.id, quantity, purchasePrice: "900000", resaleUnitPrice: "180000" } })).json();
  const step = async (to: string, from: string) => {
    const r = await admin.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to, from } });
    expect(r.status(), await r.text()).toBe(201);
  };
  await step("preorder", "draft");
  const orders: { id: string; kit: boolean; cid: string; lineId: string }[] = [];
  for (const withKit of kits) {
    const cid = newCustomerId();
    const c = await apiAs(baseURL, cid, "cli");
    const reply = await c.post("/api/orders", {
      data: { batchId: batch.id, lines: [withKit ? { choices: [{ optionId: opt.id, optionValueId: silent.id }] } : {}], billingAddress: POSTAL, refundAddress: refundAddress() },
    });
    expect(reply.status(), await reply.text()).toBe(201);
    const o = await reply.json();
    await receivePayment(baseURL, o.payment.address, o.payment.expectedSats);
    await expect.poll(async () => (await (await c.get(`/api/orders/${o.id}`)).json()).status, { timeout: 30_000 }).toBe("paid");
    orders.push({ id: o.id, kit: withKit, cid, lineId: o.lines[0].id });
  }
  await step("ordering", "preorder");
  await step("awaiting_reception", "ordering");
  const serials = Array.from({ length: quantity }, (_, i) => `MT-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}-${i}`);
  expect((await admin.post(`/api/backoffice/batches/${batch.id}/receptions`, { data: { serials } })).status()).toBe(201);
  await step("inspection", "awaiting_reception");
  const get = () => admin.get(`/api/backoffice/batches/${batch.id}/machines`).then((r) => r.json()) as Promise<BatchMachinesJson>;
  if (check) {
    const { machines } = await get();
    expect((await admin.post("/api/backoffice/machines/check-ok", { data: { machineIds: machines.map((m) => m.id) } })).status()).toBe(201);
  }
  return { admin, batchId: batch.id as string, optionId: opt.id as string, silentId: silent.id as string, noneId: none.id as string, partId: part.id as string, orders, serials, get, step };
}

export const st = (m: Pick<MachineJson, "id" | "logisticalStatus" | "functionalStatus">, to: StatusTarget, extra: Record<string, unknown> = {}) => ({ machineId: m.id, from: { logistical: m.logisticalStatus, functional: m.functionalStatus }, to, ...extra });
export const setStatus = (admin: APIRequestContext, items: ReturnType<typeof st>[]) => admin.post("/api/backoffice/machines/status", { data: { items } });
