/**
 * Ordre par unités de code UTF-16, identique au tri par défaut de `Array.prototype.sort` sur des chaînes.
 * Sert à verrouiller des lignes (lots, commandes) toujours dans le même ordre : ne pas le remplacer par
 * `localeCompare`, dont l'ordre dépend de la locale.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
