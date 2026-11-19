import { NextResponse, type NextRequest } from "next/server";
import { buildLoginUrl } from "@/lib/login";
import { ACCESS_TOKEN_COOKIE, verifyAccessToken } from "@/server/auth";
import { getConfig } from "@/server/config";
import { crossOriginError, toErrorResponse } from "@/server/errors";
import { isCrossOriginWrite } from "@/server/origin";
import { REFRESH_TOKEN_COOKIE, refreshSession, withRefreshedCookies } from "@/server/session-refresh";

/**
 * Espace personnel de la boutique : connexion requise pour l'afficher. Un chemin entier ou un préfixe
 * suivi de `/` ou de la fin (« /mes-interets-bis » n'en fait pas partie), et la page de commande d'un lot.
 */
const SIGNED_IN_AREAS: readonly RegExp[] = [/^\/mes-interets(\/|$)/, /^\/mes-commandes(\/|$)/, /^\/profil(\/|$)/, /^\/lots\/[^/]+\/commander\/?$/];
/** Où revenir si le chemin demandé n'est pas sûr (ne devrait pas arriver : le chemin vient de la requête). */
const LOGIN_FALLBACK = "/mes-interets";
/** Paramètre technique des requêtes de navigation côté client, sans rapport avec la page. */
const INTERNAL_PARAMS = ["_rsc"];

/** Chemin complet demandé, requête comprise (sans les paramètres techniques de Next). */
export function requestPath(request: NextRequest): string {
  const url = request.nextUrl.clone();
  for (const name of INTERNAL_PARAMS) url.searchParams.delete(name);
  return `${url.pathname}${url.search}`;
}

function inSignedInArea(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  return (request.method === "GET" || request.method === "HEAD") && SIGNED_IN_AREAS.some((area) => area.test(pathname));
}

/**
 * - Protection CSRF par défaut : toute écriture (POST, PATCH, PUT, DELETE…) venue d'une autre
 *   origine est refusée en 403 `cross_origin`, quelle que soit la route, y compris les routes
 *   ajoutées plus tard et les Server Functions. Règle et justification : `src/server/origin.ts`.
 *   Les handlers refont le même contrôle (`withErrorHandling`) au cas où ce matcher changerait.
 * - Session : le jeton d'accès dure 15 minutes. S'il est absent, expiré ou invalide et que le cookie
 *   `refresh_token` est là, le proxy appelle auth-service (POST /refresh) avant tout rendu : la requête en
 *   cours voit déjà les nouveaux cookies (pages, Server Components, routes API) et ils sont renvoyés au
 *   navigateur. Un refus ou une panne d'auth-service laisse la requête sans session (connexion demandée).
 * - « Mes intérêts », « Mes commandes », « Mon profil » et la page de commande d'un lot sans jeton d'accès valide
 *   (après tentative de rafraîchissement) :
 *   vraie redirection HTTP vers la connexion, avant tout rendu (le chargement enverrait sinon la page en
 *   200), avec retour sur le chemin exact demandé, requête comprise (`/mes-interets/{id}?…`). Le retour est rattaché à PUBLIC_URL, jamais
 *   à l'hôte de la requête (buildLoginUrl). Chaque page refait sa propre garde.
 */
export async function proxy(request: NextRequest) {
  if (isCrossOriginWrite(request)) return toErrorResponse(crossOriginError());
  const signedInArea = inSignedInArea(request);
  const hasRefreshToken = Boolean(request.cookies.get(REFRESH_TOKEN_COOKIE)?.value);
  if (!signedInArea && !hasRefreshToken) return NextResponse.next();

  const { authApiUrl, authFrontUrl, publicOrigin, jwtSecret } = getConfig();
  const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  if (await verifyAccessToken(accessToken, jwtSecret)) return NextResponse.next();

  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  const session = refreshToken ? await refreshSession(authApiUrl, refreshToken) : null;
  if (session) {
    const headers = new Headers(request.headers);
    headers.set("cookie", withRefreshedCookies(request.headers.get("cookie"), session));
    const response = NextResponse.next({ request: { headers } });
    for (const setCookie of session.setCookies) response.headers.append("set-cookie", setCookie);
    return response;
  }
  if (signedInArea) {
    const login = buildLoginUrl({ loginPage: `${authFrontUrl}/login`, publicOrigin }, requestPath(request), LOGIN_FALLBACK);
    return NextResponse.redirect(login, 307);
  }
  return NextResponse.next();
}

export const config = {
  // Tout sauf les fichiers statiques du build (jamais en écriture)
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
