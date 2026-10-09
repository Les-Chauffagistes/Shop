import { expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { forgeAccessToken, unique } from "./auth";
import { E2E_PAYMENT_SECRET } from "./env";

/** Montant tel qu'affiché (« 1 860,00 € » : milliers séparés par U+202F, espace insécable avant l'euro). */
const THIN_NBSP = String.fromCharCode(0x202f);
const NBSP = String.fromCharCode(0xa0);
export const eur = (text: string) => `${text.replaceAll(" ", THIN_NBSP)}${NBSP}€`;
/** « 40 000 sats » tel qu'affiché */
export const sats = (text: string) => `${text.replaceAll(" ", THIN_NBSP)} sats`;

export const newCustomerId = () => String(100_000 + Math.floor(Math.random() * 1_000_000_000));

/** Adresse Bitcoin de remboursement valide pour l'API (format bech32 de test). */
export const refundAddress = () => `bc1q${Array.from({ length: 38 }, () => "qpzry9x8gf2tvdw0s3jn54khce6mua7l"[Math.floor(Math.random() * 32)]).join("")}`;

export const POSTAL = { fullName: "Alice Martin", line1: "1 rue de la Paix", postalCode: "69001", city: "Lyon", country: "FR" };

export async function apiAs(baseURL: string, authUserId: string, pseudo = "e2e"): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Cookie: `access_token=${await forgeAccessToken(authUserId, pseudo)}` },
  });
}

export const adminApi = (baseURL: string) => apiAs(baseURL, "1", "admin-e2e");

type Value = { id: string; label: string };

/**
 * Lot de 10 machines à 1 800 €, conduit par `path` (par défaut : précommandes ouvertes sans sondage).
 * `withOptions` : menu « Kit de ventilation » (Sans kit, Silent kit à 75 €) ; sans : aucune option
 * (les factures fabriquées en SQL n'ont alors rien à configurer).
 */
export async function createBatch(
  api: APIRequestContext,
  { path = ["preorder"], withOptions = true }: { path?: string[]; withOptions?: boolean } = {},
) {
  const modelName = unique("S21");
  const model = await (
    await api.post("/api/backoffice/models", { data: { name: modelName, hashrate: "200000000000000", hashboardQtt: 3 } })
  ).json();
  let silent: Value | null = null;
  if (withOptions) {
    const kit = await (
      await api.post(`/api/backoffice/models/${model.id}/options`, {
        data: {
          kind: "choice",
          title: "Kit de ventilation",
          values: [
            { label: "Sans kit", price: "0" },
            { label: "Silent kit", price: "7500" },
          ],
        },
      })
    ).json();
    silent = (kit.values as Value[]).find((v) => v.label === "Silent kit")!;
  }
  const response = await api.post("/api/backoffice/batches", {
    data: { modelId: model.id, quantity: 10, purchasePrice: "1500000", resaleUnitPrice: "180000" },
  });
  expect(response.status()).toBe(201);
  const batch = await response.json();
  let from = "draft";
  for (const to of path) {
    expect((await api.post(`/api/backoffice/batches/${batch.id}/transitions`, { data: { to, from } })).status()).toBe(201);
    from = to;
  }
  return { id: batch.id as string, name: batch.name as string, modelName, silent };
}

export type OrderJson = {
  id: string;
  status: string;
  payment: { address: string; expectedSats: string; receivedSats: string; outstandingSats: string };
  lines: { id: string; position: number }[];
};

/** Facture créée par l'API au nom du client (`lines` machines, toutes par défaut). */
export async function placeOrder(
  customer: APIRequestContext,
  batchId: string,
  { lines = 1, refund }: { lines?: number; refund?: string } = {},
): Promise<OrderJson> {
  const response = await customer.post("/api/orders", {
    data: {
      batchId,
      lines: Array.from({ length: lines }, () => ({})),
      billingAddress: POSTAL,
      ...(refund ? { refundAddress: refund } : {}),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

let txSeq = 0;

/** Versement simulé reçu sur l'adresse d'une facture (point d'entrée interne du service de paiement). */
export async function receivePayment(baseURL: string, address: string, amountSats: string) {
  const service = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${E2E_PAYMENT_SECRET}` },
  });
  const response = await service.post("/api/internal/payments", {
    data: { address, txid: `e2e-${Date.now().toString(36)}-${++txSeq}-${Math.random().toString(36).slice(2, 8)}`, vout: 0, amountSats },
  });
  expect(response.status(), await response.text()).toBe(201);
  const result = await response.json();
  await service.dispose();
  return result;
}
