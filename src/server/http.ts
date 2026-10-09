import { z } from "zod";
import { ApiError } from "./errors";

/**
 * Conventions JSON de l'API (voir docs/api.md) :
 * - colonnes BIGINT (montants en centimes, hashrate en H/s, identifiants auth-service) :
 *   chaînes décimales, en entrée comme en sortie (`"3500"` = 35,00 €). Jamais de `number` :
 *   au-delà de 2^53 il perdrait des chiffres, et `JSON.stringify` refuse les `bigint`.
 * - colonnes INTEGER (quantités, positions) : nombres entiers.
 * - dates : chaînes ISO 8601.
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** Réponse JSON non mise en cache (données backoffice, toujours fraîches). */
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: NO_STORE });
}

/**
 * Corps JSON validé par `schema`.
 * - 415 `unsupported_media_type` si le `Content-Type` n'est pas `application/json` : un formulaire
 *   HTML d'un site tiers ne peut envoyer que `text/plain`, `multipart/form-data` ou
 *   `application/x-www-form-urlencoded` sans preflight CORS (que l'application n'autorise pas).
 *   Protection CSRF, en plus du contrôle d'origine (`src/server/origin.ts`).
 * - 400 `invalid_json` si le corps n'est pas du JSON.
 */
export async function readJson<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Le corps de la requête doit être envoyé en JSON (Content-Type: application/json).",
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Le corps de la requête doit être du JSON.");
  }
  return schema.parse(body);
}

/** Identifiant de chemin : un uuid mal formé est traité comme une ressource introuvable. */
export async function pathId<K extends string>(
  params: Promise<Record<K, string>>,
  key: K,
  notFound: ApiError,
): Promise<string> {
  const value = (await params)[key];
  if (!z.uuid().safeParse(value).success) throw notFound;
  return value;
}

// ─── Primitives de validation ───

const MAX_BIGINT_DIGITS = 18; // < 2^63 : tient dans un BIGINT Postgres

const CENTS_FORMAT = 'Montant en centimes attendu, sous forme de chaîne (ex. "3500")';

/** Montant en centimes : chaîne d'entier positif ou nul (ex. "3500"). */
export const cents = z
  .string({ error: CENTS_FORMAT })
  .regex(new RegExp(`^(0|[1-9][0-9]{0,${MAX_BIGINT_DIGITS - 1}})$`), { error: CENTS_FORMAT })
  .transform((value) => BigInt(value));

/** « 10000000000 » centimes → « 100 000 000,00 » (espace insécable fine, comme Intl fr-FR). */
function centsLabel(value: bigint): string {
  const units = (value / 100n).toLocaleString("fr-FR");
  return `${units},${(value % 100n).toString().padStart(2, "0")}`;
}

/**
 * Montant en centimes borné : `min`–`max` inclus. Un seul message par champ : format, ou plage
 * en euros (devise unique, non répétée dans le message).
 */
export const centsBetween = (min: bigint, max: bigint) =>
  cents.refine((value) => value >= min && value <= max, {
    error: `Montant compris entre ${centsLabel(min)} et ${centsLabel(max)} attendu`,
  });

/** Entier simple borné (quantités, nombre de pièces) : un seul message, qui cite la plage. */
export const intBetween = (min: number, max: number, what = "Nombre entier") => {
  const message = `${what} compris entre ${min.toLocaleString("fr-FR")} et ${max.toLocaleString("fr-FR")} attendu`;
  return z.int({ error: message }).min(min, { error: message }).max(max, { error: message });
};

/** Entier strictement positif sous forme de chaîne (BIGINT, ex. hashrate en H/s), au plus `max`. */
export const positiveBigint = (max: bigint, message: string) =>
  z
    .string({ error: message })
    .regex(new RegExp(`^[1-9][0-9]{0,${MAX_BIGINT_DIGITS - 1}}$`), { error: message })
    .transform((value) => BigInt(value))
    .refine((value) => value <= max, { error: message });

/** Texte court obligatoire (espaces de bord retirés). */
export const label = (max = 120) =>
  z.string().trim().min(1, { error: "Ce champ est obligatoire" }).max(max, { error: `${max} caractères au plus` });

/** Texte libre facultatif : chaîne vide ou null = absent. */
export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max, { error: `${max} caractères au plus` })
    .nullable()
    .transform((value) => (value ? value : null));

export const position = z.int({ error: "Entier attendu" }).min(0).max(10_000);

/** Sérialise une valeur BIGINT (voir conventions ci-dessus). */
export function bigintToJson(value: bigint): string;
export function bigintToJson(value: bigint | null): string | null;
export function bigintToJson(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}
