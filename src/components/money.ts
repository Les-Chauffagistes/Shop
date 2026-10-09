/**
 * Affichage des montants Bitcoin (sats en chaînes décimales, docs/api.md « BIGINT en chaînes »),
 * sans flottant. Aucun calcul qui fait foi : les montants viennent du serveur.
 */

const SATS_PER_BTC = BigInt(100_000_000);

/** Séparateur de milliers français (espace fine insécable, comme formatCents). */
function group(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** « 1 194 445 sats » */
export function formatSats(sats: string | null | undefined): string {
  if (sats === null || sats === undefined || sats === "") return "—";
  return `${group(BigInt(sats))} sats`;
}

/** « 0,01194445 BTC » (8 décimales, exactes) */
export function formatBtc(sats: string | null | undefined): string {
  if (sats === null || sats === undefined || sats === "") return "—";
  const n = BigInt(sats);
  const sign = n < BigInt(0) ? "-" : "";
  const abs = n < BigInt(0) ? -n : n;
  return `${sign}${group(abs / SATS_PER_BTC)},${(abs % SATS_PER_BTC).toString().padStart(8, "0")} BTC`;
}

/** Montant à copier dans un portefeuille : « 0.01194445 » (point décimal, sans séparateur). */
export function btcForWallet(sats: string): string {
  const n = BigInt(sats);
  return `${n / SATS_PER_BTC}.${(n % SATS_PER_BTC).toString().padStart(8, "0")}`;
}

/** Qui paie les frais réseau d'un remboursement, en clair. */
export function feePayerLabel(payer: "shop" | "user"): string {
  return payer === "shop" ? "à la charge de la boutique" : "à la charge de l'utilisateur";
}
