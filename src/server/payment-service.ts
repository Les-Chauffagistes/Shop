import { randomBytes } from "node:crypto";
import { getConfig } from "./config";

/**
 * Service de paiement Bitcoin (décision Hugo 2026-10-06 : service maison, une adresse de réception
 * par facture). Au jalon 4 il est SIMULÉ : `SimulatedPaymentService` est la seule implémentation,
 * à remplacer par le client du vrai service quand il existera (même interface). Les paiements reçus
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

/** Service de paiement du processus (sans état : relit la configuration). */
export function getPaymentService(): PaymentService {
  return new SimulatedPaymentService(getConfig().payment);
}
