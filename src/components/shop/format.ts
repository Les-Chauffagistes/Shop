/** Textes d'affichage de la boutique (aucune règle métier : les montants viennent du serveur). */

/**
 * Pourquoi une configuration n'est plus modifiable, en clair. N'appeler que si le serveur l'a dit
 * (`editable` faux) : ce texte explique le drapeau, il ne le recalcule pas.
 */
export function lockedReason(w: { converted: boolean; batch: { status: string; statusLabel: string } }): string {
  if (w.converted) {
    return "Commandée et payée : la machine se gère depuis la commande (renoncement tant que le lot est en précommande, sinon contactez-nous).";
  }
  switch (w.batch.status) {
    case "survey":
      return "La configuration ne peut pas être modifiée pour l'instant.";
    case "draft":
      return "Ce lot n'est plus publié pour l'instant : la configuration ne peut pas être modifiée. Votre intérêt est conservé.";
    case "closed":
    case "cancelled":
      return `Lot ${w.batch.statusLabel.toLowerCase()} : la configuration ne se modifie plus.`;
    default:
      return `Sondage terminé (statut « ${w.batch.statusLabel} ») : la configuration est figée. Vous pouvez encore retirer votre intérêt.`;
  }
}

/** Somme indicative de montants en centimes (chaînes décimales), sans flottant. */
export function sumCents(values: readonly string[]): string {
  return values.reduce((sum, v) => sum + BigInt(v), BigInt(0)).toString();
}

/** Montant × quantité, en centimes (chaîne décimale). */
export function timesCents(cents: string, qty: number): string {
  return (BigInt(cents) * BigInt(qty)).toString();
}

/** Date ISO encore à venir (lue à l'heure du serveur au rendu de la page). */
export function isFuture(iso: string | null): boolean {
  return iso !== null && new Date(iso).getTime() > Date.now();
}
