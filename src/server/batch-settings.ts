import { ApiError } from "./errors";

/**
 * Réglages d'options d'un lot : domaine pur (aucun accès base), testé sans HTTP.
 *
 * Deux tables (schéma v4) :
 * - BatchOptionValue (une ligne par valeur) : `enabled` (false = retirée), dérogation de prix,
 *   quantité maximale. Brouillon : absence de ligne = hérite du catalogue. Publié : instantané
 *   pris à la publication, une ligne par valeur ; absence = valeur créée depuis, non proposée.
 *   Les lignes d'un lot publié ne sont jamais supprimées (BatchOptionValue_snapshot).
 * - BatchOption (une ligne par menu) : `hidden` (menu masqué). Brouillon : absence = affiché.
 *   Publié : une ligne par menu applicable, jamais ajoutée ni supprimée (BatchOption_snapshot).
 * D'où des écritures ligne par ligne (création, mise à jour), jamais « tout supprimer puis
 * recréer » ; une suppression n'a lieu qu'en brouillon.
 */

export type SettingRow = {
  optionValueId: string;
  optionId: string;
  enabled: boolean;
  priceOverride: bigint | null;
  maxQty: number | null;
};

type SettingValues = Pick<SettingRow, "enabled" | "priceOverride" | "maxQty">;

/** Réglage sans effet : valeur proposée au prix catalogue, sans limite. */
export const NEUTRAL: SettingValues = { enabled: true, priceOverride: null, maxQty: null };

export const isNeutral = (s: SettingValues) => s.enabled && s.priceOverride === null && s.maxQty === null;

/** Ce qui change entre deux listes de réglages, par famille de champs (EDITABLE_FIELDS). */
export function settingsChanges(current: readonly SettingRow[], next: readonly SettingRow[]) {
  const before = new Map(current.map((s) => [s.optionValueId, s]));
  const after = new Map(next.map((s) => [s.optionValueId, s]));
  let availability = false;
  let maxQty = false;
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id) ?? NEUTRAL;
    const b = after.get(id) ?? NEUTRAL;
    if (a.enabled !== b.enabled || a.priceOverride !== b.priceOverride) availability = true;
    if (a.maxQty !== b.maxQty) maxQty = true;
  }
  return { availability, maxQty };
}

export type SettingWrites = { create: SettingRow[]; update: SettingRow[]; remove: string[] };

/**
 * Écritures qui amènent les réglages `current` (lignes en base) à `next` (liste complète voulue ;
 * une valeur absente revient au réglage neutre).
 * - Brouillon : une ligne devenue neutre est supprimée, une ligne non neutre créée ou mise à jour.
 * - Publié : jamais de suppression (neutre = mise à jour) ; une valeur sans ligne n'est pas
 *   proposée par le lot : la régler est refusé (409 option_value_not_offered), il faut d'abord
 *   la proposer (« Proposer sur ce lot »).
 */
export function planSettingWrites(
  current: readonly SettingRow[],
  next: readonly SettingRow[],
  { draft }: { draft: boolean },
): SettingWrites {
  const before = new Map(current.map((s) => [s.optionValueId, s]));
  const after = new Map(next.map((s) => [s.optionValueId, s]));
  const writes: SettingWrites = { create: [], update: [], remove: [] };
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const row = before.get(id);
    const wanted = after.get(id) ?? (row ? { ...row, ...NEUTRAL } : undefined);
    if (!wanted) continue;
    if (row) {
      if (row.enabled === wanted.enabled && row.priceOverride === wanted.priceOverride && row.maxQty === wanted.maxQty) {
        continue;
      }
      if (draft && isNeutral(wanted)) writes.remove.push(id);
      else writes.update.push(wanted);
    } else if (!isNeutral(wanted)) {
      if (!draft) {
        throw new ApiError(
          409,
          "option_value_not_offered",
          "Une des valeurs réglées n'est pas proposée par ce lot (ajoutée au catalogue après sa publication) : proposez-la d'abord sur le lot.",
        );
      }
      writes.create.push(wanted);
    }
  }
  return writes;
}

/** Menu applicable au lot (`batch_menus`) et existence de sa ligne BatchOption. */
export type MenuState = { optionId: string; hidden: boolean; hasRow: boolean };

export type HiddenWrites = { create: string[]; update: { optionId: string; hidden: boolean }[] };

/**
 * Écritures qui masquent exactement les menus `hidden` (liste complète) parmi les menus
 * applicables. Une ligne existante est mise à jour ; une ligne manquante (brouillon seulement :
 * un lot publié a une ligne par menu) n'est créée que pour masquer. Jamais de suppression.
 * Un identifiant hors des menus applicables : 422 unknown_option.
 */
export function planHiddenWrites(menus: readonly MenuState[], hidden: ReadonlySet<string>): HiddenWrites {
  const known = new Set(menus.map((m) => m.optionId));
  if ([...hidden].some((id) => !known.has(id))) {
    throw new ApiError(422, "unknown_option", "Un des menus à masquer n'existe pas sur ce lot.");
  }
  const writes: HiddenWrites = { create: [], update: [] };
  for (const menu of menus) {
    const wanted = hidden.has(menu.optionId);
    if (menu.hidden === wanted) continue;
    if (menu.hasRow) writes.update.push({ optionId: menu.optionId, hidden: wanted });
    else writes.create.push(menu.optionId);
  }
  return writes;
}

/** Menus qui passent de visible à masqué. */
export function newlyHidden(menus: readonly MenuState[], hidden: ReadonlySet<string>): string[] {
  return menus.filter((m) => !m.hidden && hidden.has(m.optionId)).map((m) => m.optionId);
}
