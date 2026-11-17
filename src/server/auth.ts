import { cookies } from "next/headers";
import { errors, jwtVerify } from "jose";
import { AUTH_USER_ID_PATTERN, getConfig } from "./config";
import { getDb } from "./db";
import { ApiError } from "./errors";

/**
 * Contrat avec auth-service back (../auth-service back, src/v1/jwt.py et cookie.py) :
 * après connexion, le navigateur porte un cookie HttpOnly `access_token` (domaine parent
 * partagé), JWT HS256 signé avec JWT_SECRET, durée 15 min, claims
 * `{ sub: "<users.id>", pseudo, type: "access", iat, exp }`.
 * La boutique vérifie ce jeton localement, sans appel réseau. Le rafraîchissement
 * (POST {AUTH_API_URL}/refresh, cookie `refresh_token`) est fait par le navigateur.
 */
export const ACCESS_TOKEN_COOKIE = "access_token";

/**
 * Identifiant auth-service : `auth.users.id`, BIGINT. Côté application il reste la chaîne
 * décimale du claim `sub` (comparaison exacte avec la whitelist, sérialisable en JSON) ;
 * il n'est converti en `bigint` qu'à la frontière de la base (colonnes BIGINT, Prisma `BigInt`).
 * Pas de `number` : au-delà de 2^53 il perdrait des chiffres en silence.
 */
export type AccessTokenClaims = { authUserId: string; pseudo: string | null };

/** Plus grand BIGINT Postgres : un `sub` plus grand ne peut pas exister côté auth-service. */
const MAX_AUTH_USER_ID = 9_223_372_036_854_775_807n;

/** `sub` valide : entier décimal positif représentable en BIGINT. */
function isAuthUserId(sub: unknown): sub is string {
  return typeof sub === "string" && AUTH_USER_ID_PATTERN.test(sub) && BigInt(sub) <= MAX_AUTH_USER_ID;
}

/** Valeur de colonne BIGINT (User.auth_user_id, changed_by_auth_user_id) d'un identifiant auth-service. */
export function authUserIdToDb(authUserId: string): bigint {
  if (!isAuthUserId(authUserId)) throw new RangeError("Invalid auth user id");
  return BigInt(authUserId);
}

export type CurrentUser = {
  /** User.id local (uuid) */
  id: string;
  /** Identifiant du service d'auth (claim `sub`) */
  authUserId: string;
  pseudo: string | null;
  isBackoffice: boolean;
};

/** Vérifie un jeton d'accès. `null` si absent, mal signé, expiré ou d'un autre type. */
export async function verifyAccessToken(
  token: string | undefined,
  secret: Uint8Array,
): Promise<AccessTokenClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"], requiredClaims: ["exp", "sub"] });
    if (payload.type !== "access") return null;
    if (!isAuthUserId(payload.sub)) return null;
    return { authUserId: payload.sub, pseudo: typeof payload.pseudo === "string" ? payload.pseudo : null };
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}

function isBackofficeUser(authUserId: string, whitelist: ReadonlySet<string>): boolean {
  return whitelist.has(authUserId);
}

/** Pseudo du jeton tel que la base l'accepte (User_pseudo_check : ni blanc ni au-delà de 200 caractères), sinon `null`. */
function storablePseudo(pseudo: string | null | undefined): string | null {
  return pseudo?.slice(0, 200).trim() || null;
}

/**
 * Retrouve ou crée la ligne User locale. Idempotent et sûr en concurrence :
 * lecture d'abord (cas courant), sinon INSERT … ON CONFLICT DO NOTHING puis relecture.
 * Le pseudo du jeton est enregistré à la création et rafraîchi seulement s'il a changé (aucune écriture à chaque
 * requête) ; un jeton sans pseudo ne l'efface pas. Donnée personnelle : jamais loggée.
 */
export async function findOrCreateUser(authUserId: string, pseudo?: string | null): Promise<{ id: string }> {
  const db = getDb();
  const where = { auth_user_id: authUserIdToDb(authUserId) };
  const wanted = storablePseudo(pseudo);
  const existing = await db.user.findUnique({ where, select: { id: true, pseudo: true } });
  if (existing) {
    if (wanted !== null && existing.pseudo !== wanted) await db.user.update({ where, data: { pseudo: wanted } });
    return { id: existing.id };
  }
  await db.user.createMany({ data: [{ ...where, pseudo: wanted }], skipDuplicates: true });
  return db.user.findUniqueOrThrow({ where, select: { id: true } });
}

/** Utilisateur de la requête courante, ou `null` s'il n'est pas authentifié. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  // Les cookies d'abord : la page devient dynamique (jamais prérendue au build, qui n'a pas la
  // configuration d'exécution) avant que la configuration soit lue.
  const token = (await cookies()).get(ACCESS_TOKEN_COOKIE)?.value;
  const config = getConfig();
  const claims = await verifyAccessToken(token, config.jwtSecret);
  if (!claims) return null;
  const user = await findOrCreateUser(claims.authUserId, claims.pseudo);
  return {
    id: user.id,
    authUserId: claims.authUserId,
    pseudo: claims.pseudo,
    isBackoffice: isBackofficeUser(claims.authUserId, config.backofficeUserIds),
  };
}

/** Garde : utilisateur authentifié, sinon ApiError 401 `unauthenticated`. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, "unauthenticated", "Vous devez être connecté.");
  return user;
}

/** Garde : utilisateur de la whitelist BACKOFFICE_USER_IDS, sinon 401 ou 403 `forbidden`. */
export async function requireBackoffice(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.isBackoffice) throw new ApiError(403, "forbidden", "Accès réservé au backoffice.");
  return user;
}
