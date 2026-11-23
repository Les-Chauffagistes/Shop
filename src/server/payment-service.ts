import { randomBytes } from "node:crypto";
import { ApiError } from "./errors";
import { getConfig } from "./config";

/**
 * Service de paiement Bitcoin (décision Hugo 2026-10-06 : service maison, une adresse de réception
 * par facture). Deux implémentations de la même interface : `HttpPaymentService` (bitcoin-service,
 * contrat `docs/bitcoin-service-contrat.md`) quand PAYMENT_SERVICE_URL et PAYMENT_SERVICE_TOKEN sont
 * définis, sinon `SimulatedPaymentService` (dev, tests, CI). Les paiements reçus
 * arrivent par le point d'entrée interne `POST /api/internal/payments` (./payments.ts).
 *
 * Argent : centimes et satoshis en `bigint`, jamais de nombre à virgule.
 */
export interface PaymentService {
  /**
   * Adresse de réception propre à la facture (jamais réutilisée : la base l'impose aussi par un index
   * unique, et une facture n'est jamais supprimée) et montant attendu en sats au taux du moment, figé.
   */
  requestInvoice(input: { orderId: string; amountCents: bigint }): Promise<{ address: string; expectedSats: bigint }>;
  /** Frais réseau estimés pour renvoyer des sats à l'utilisateur (remboursement), en sats. */
  estimateRefundNetworkFeeSats(): Promise<bigint>;
}

export const SATS_PER_BTC = 100_000_000n;

/**
 * Montant en sats d'un montant en centimes au prix `btcPriceEurCents` (centimes pour 1 BTC),
 * arrondi au sat supérieur : la boutique ne reçoit jamais moins que le prix. Domaine pur.
 */
export function eurCentsToSats(amountCents: bigint, btcPriceEurCents: bigint): bigint {
  if (amountCents < 0n || btcPriceEurCents <= 0n) throw new RangeError("Invalid amount or BTC price");
  const numerator = amountCents * SATS_PER_BTC;
  return (numerator + btcPriceEurCents - 1n) / btcPriceEurCents;
}

/** Alphabet bech32 (BIP 173). */
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/**
 * Adresse simulée à partir de 32 octets aléatoires : préfixe de réseau de test `bcrt1q` (jamais une
 * adresse du réseau principal : un portefeuille réel refuse d'y envoyer des fonds) suivi de 38
 * caractères bech32. 190 bits d'aléa : une collision est impossible en pratique (et refusée par la base).
 */
export function simulatedAddress(random: Uint8Array): string {
  if (random.length < 38) throw new RangeError("Not enough random bytes");
  let body = "";
  for (let i = 0; i < 38; i++) body += BECH32[random[i] % 32];
  return `bcrt1q${body}`;
}

/** Implémentation simulée : taux et frais fixés en configuration (PAYMENT_BTC_PRICE_EUR_CENTS, PAYMENT_REFUND_NETWORK_FEE_SATS). */
export class SimulatedPaymentService implements PaymentService {
  constructor(private readonly settings: { btcPriceEurCents: bigint; refundNetworkFeeSats: bigint }) {}

  async requestInvoice({ amountCents }: { orderId: string; amountCents: bigint }) {
    return {
      address: simulatedAddress(randomBytes(38)),
      expectedSats: eurCentsToSats(amountCents, this.settings.btcPriceEurCents),
    };
  }

  async estimateRefundNetworkFeeSats() {
    return this.settings.refundNetworkFeeSats;
  }
}

const REQUEST_TIMEOUT_MS = 5_000;
const UINT_STRING = /^\d{1,30}$/;

const unavailable = () => new ApiError(503, "payment_unavailable", "Le service de paiement est indisponible. Réessayez dans un instant.");

/** Client de bitcoin-service. Aucune relance : l'appelant échoue en 503 et rien n'est créé. */
export class HttpPaymentService implements PaymentService {
  constructor(
    private readonly service: { url: string; token: string },
    private readonly fallback: { refundNetworkFeeSats: bigint },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${this.service.url}/v1${path}`, {
      ...init,
      headers: { ...init.headers, "X-Api-Key": this.service.token, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  }

  async requestInvoice({ orderId, amountCents }: { orderId: string; amountCents: bigint }) {
    let body: { address?: unknown; expectedSats?: unknown };
    try {
      const res = await this.call("/invoices", {
        method: "POST",
        body: JSON.stringify({ orderId, amountCents: amountCents.toString() }),
      });
      if (!res.ok) {
        console.error(`bitcoin-service POST /v1/invoices : ${res.status}`);
        throw unavailable();
      }
      body = await res.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error("bitcoin-service POST /v1/invoices : échec", error instanceof Error ? error.name : error);
      throw unavailable();
    }
    if (typeof body.address !== "string" || body.address === "" || typeof body.expectedSats !== "string" || !UINT_STRING.test(body.expectedSats)) {
      console.error("bitcoin-service POST /v1/invoices : réponse inattendue");
      throw unavailable();
    }
    return { address: body.address, expectedSats: BigInt(body.expectedSats) };
  }

  /** Repli sur PAYMENT_REFUND_NETWORK_FEE_SATS : une estimation indisponible ne bloque jamais un règlement. */
  async estimateRefundNetworkFeeSats() {
    try {
      const res = await this.call("/fee-estimate");
      if (!res.ok) return this.fallback.refundNetworkFeeSats;
      const body = (await res.json()) as { refundNetworkFeeSats?: unknown };
      const sats = body.refundNetworkFeeSats;
      return typeof sats === "string" && UINT_STRING.test(sats) ? BigInt(sats) : this.fallback.refundNetworkFeeSats;
    } catch {
      return this.fallback.refundNetworkFeeSats;
    }
  }
}

/** Service de paiement du processus (sans état : relit la configuration). */
export function getPaymentService(): PaymentService {
  const { service, ...settings } = getConfig().payment;
  return service ? new HttpPaymentService(service, settings) : new SimulatedPaymentService(settings);
}
