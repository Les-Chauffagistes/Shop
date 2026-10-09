/** « 1 facture », « 3 factures » : accord du pluriel pour les messages (serveur) et l'affichage ; `many` dès 2. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

/** « 1 machine », « 3 machines ». */
export function machines(n: number): string {
  return plural(n, "machine", "machines");
}
