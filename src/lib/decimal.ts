/**
 * Conversions exactes entre une saisie décimale (texte) et un entier mis à l'échelle, sans
 * jamais passer par un `number` flottant : montants en centimes, hashrate en H/s.
 * L'API échange ces entiers sous forme de chaînes décimales (docs/api.md, « BIGINT en chaînes »).
 */

/**
 * Lit une saisie décimale française ou anglaise (« 1 500,50 », « 1500.5 », « 35 € ») et renvoie
 * l'entier `valeur × 10^scale` en chaîne décimale. `null` si la saisie est vide, négative,
 * mal formée ou plus précise que `scale` décimales.
 */
export function parseScaledDecimal(input: string, scale: number, unit = ""): string | null {
  let text = input.trim();
  if (unit && text.toLowerCase().endsWith(unit.toLowerCase())) text = text.slice(0, -unit.length).trim();
  // Espaces (dont insécables) comme séparateurs de milliers
  text = text.replace(/[\s  ]/g, "");
  if (text === "") return null;
  const match = /^(\d*)(?:[.,](\d*))?$/.exec(text);
  if (!match) return null;
  const [, whole = "", fraction = ""] = match;
  if (whole === "" && fraction === "") return null;
  if (fraction.length > scale) {
    // Zéros superflus tolérés (« 35,500 » = 35,50 €), toute autre précision est refusée
    if (/[1-9]/.test(fraction.slice(scale))) return null;
  }
  const digits = (whole || "0") + fraction.slice(0, scale).padEnd(scale, "0");
  return BigInt(digits).toString();
}

/** Découpe un entier mis à l'échelle en partie entière et partie décimale (chaînes). */
function splitScaled(value: string, scale: number): { whole: bigint; fraction: string } {
  const n = BigInt(value);
  const factor = BigInt(10) ** BigInt(scale);
  return { whole: n / factor, fraction: (n % factor).toString().padStart(scale, "0") };
}

/** Partie entière avec séparateur de milliers français (espace fine insécable). */
function groupThousands(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// ─── Montants ───

/** Saisie en euros → centimes en chaîne. `null` si invalide. Devise unique : l'euro. */
export function eurosToCents(input: string): string | null {
  return parseScaledDecimal(input, 2, "€");
}

/** Centimes → valeur à préremplir dans un champ de saisie (« 1500,00 »). */
export function centsToInput(cents: string | null | undefined): string {
  if (cents === null || cents === undefined || cents === "") return "";
  const { whole, fraction } = splitScaled(cents, 2);
  return `${whole},${fraction}`;
}

/** Centimes → montant affichable (« 1 500,00 € »). */
export function formatCents(cents: string | null | undefined): string {
  if (cents === null || cents === undefined || cents === "") return "—";
  const { whole, fraction } = splitScaled(cents, 2);
  return `${groupThousands(whole)},${fraction} €`;
}

// ─── Hashrate ───

const TERA_SCALE = 12;

/** Saisie en TH/s → H/s en chaîne (« 95 » → « 95000000000000 »). `null` si invalide ou nulle. */
export function terahashToHashes(input: string): string | null {
  const value = parseScaledDecimal(input, TERA_SCALE, "TH/s");
  return value === null || value === "0" ? null : value;
}

/** H/s → valeur en TH/s pour un champ de saisie (« 95 », « 13,5 »). */
export function hashesToTerahashInput(hashes: string): string {
  const { whole, fraction } = splitScaled(hashes, TERA_SCALE);
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole},${trimmed}` : whole.toString();
}

/** H/s → hashrate affichable (« 95 TH/s »). */
export function formatHashrate(hashes: string): string {
  const { whole, fraction } = splitScaled(hashes, TERA_SCALE);
  const trimmed = fraction.replace(/0+$/, "");
  return `${groupThousands(whole)}${trimmed ? `,${trimmed}` : ""} TH/s`;
}
