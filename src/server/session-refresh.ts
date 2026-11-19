import { ACCESS_TOKEN_COOKIE } from "./auth";

/** Cookie HttpOnly du jeton de rafraîchissement posé par auth-service back (voir `auth.ts`). */
export const REFRESH_TOKEN_COOKIE = "refresh_token";

/** Délai maximal accordé à auth-service : le proxy bloque la requête de l'utilisateur pendant l'appel. */
const REFRESH_TIMEOUT_MS = 5_000;

/** Cookies posés par auth-service après un rafraîchissement réussi. */
export type RefreshedSession = {
  /** En-têtes `Set-Cookie` bruts, à renvoyer tels quels au navigateur (domaine, SameSite, Secure…) */
  setCookies: string[];
  /** Nouveau jeton d'accès, pour que la requête en cours soit déjà authentifiée */
  accessToken: string;
};

/**
 * Le jeton de rafraîchissement tourne à chaque usage (l'ancien devient invalide) : deux requêtes
 * simultanées (page + préchargements RSC) avec le même jeton ne doivent faire qu'un seul appel,
 * sinon la seconde échouerait et déconnecterait l'utilisateur. Entrée retirée une fois l'appel terminé.
 */
const inFlight = new Map<string, Promise<RefreshedSession | null>>();

/** Valeur du cookie `name` dans un en-tête `Set-Cookie` (`name=valeur; Path=/…`), sinon `undefined`. */
function cookieValue(setCookie: string, name: string): string | undefined {
  const pair = setCookie.split(";", 1)[0];
  const eq = pair.indexOf("=");
  if (eq < 0 || pair.slice(0, eq).trim() !== name) return undefined;
  return pair.slice(eq + 1).trim();
}

async function callRefresh(authApiUrl: string, refreshToken: string): Promise<RefreshedSession | null> {
  try {
    const response = await fetch(`${authApiUrl}/refresh`, {
      method: "POST",
      headers: { cookie: `${REFRESH_TOKEN_COOKIE}=${refreshToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const setCookies = response.headers.getSetCookie();
    const accessToken = setCookies.map((c) => cookieValue(c, ACCESS_TOKEN_COOKIE)).find((v) => v);
    return accessToken ? { setCookies, accessToken } : null;
  } catch {
    // auth-service injoignable ou trop lent : la session n'est pas rafraîchie, la connexion sera demandée
    return null;
  }
}

/**
 * Échange le jeton de rafraîchissement contre une nouvelle paire de cookies (POST {AUTH_API_URL}/refresh).
 * `null` si le jeton est refusé (expiré, révoqué, inconnu) ou si auth-service ne répond pas.
 */
export function refreshSession(authApiUrl: string, refreshToken: string): Promise<RefreshedSession | null> {
  const pending = inFlight.get(refreshToken);
  if (pending) return pending;
  const call = callRefresh(authApiUrl, refreshToken).finally(() => inFlight.delete(refreshToken));
  inFlight.set(refreshToken, call);
  return call;
}

/** En-tête `Cookie` de la requête avec les cookies d'authentification remplacés par ceux de `session`. */
export function withRefreshedCookies(cookieHeader: string | null, session: RefreshedSession): string {
  const renewed = new Map<string, string>();
  for (const setCookie of session.setCookies) {
    for (const name of [ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]) {
      const value = cookieValue(setCookie, name);
      if (value !== undefined) renewed.set(name, value);
    }
  }
  const kept = (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !renewed.has(part.split("=", 1)[0]));
  return [...kept, ...[...renewed].map(([name, value]) => `${name}=${value}`)].join("; ");
}
