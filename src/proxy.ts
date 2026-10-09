import { NextResponse, type NextRequest } from "next/server";
import { buildLoginUrl } from "@/lib/login";
import { ACCESS_TOKEN_COOKIE, verifyAccessToken } from "@/server/auth";
import { getConfig } from "@/server/config";
import { crossOriginError, toErrorResponse } from "@/server/errors";
import { isCrossOriginWrite } from "@/server/origin";

/**
 * Espace personnel de la boutique : connexion requise pour l'afficher. Un chemin entier ou un préfixe
 * suivi de `/` ou de la fin (« /mes-interets-bis » n'en fait pas partie), et la page de commande d'un lot.
 */
const SIGNED_IN_AREAS: readonly RegExp[] = [/^\/mes-interets(\/|$)/, /^\/mes-commandes(\/|$)/, /^\/lots\/[^/]+\/commander\/?$/];
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
 * - « Mes intérêts », « Mes commandes » et la page de commande d'un lot sans jeton d'accès valide :
 *   vraie redirection HTTP vers la connexion, avant tout rendu (le chargement enverrait sinon la page en
 *   200), avec retour sur le chemin exact demandé, requête comprise (`/mes-interets/{id}?…`). Le retour est rattaché à PUBLIC_URL, jamais
 *   à l'hôte de la requête (buildLoginUrl). Chaque page refait sa propre garde.
 */
export async function proxy(request: NextRequest) {
  if (isCrossOriginWrite(request)) return toErrorResponse(crossOriginError());
  if (inSignedInArea(request)) {
    const { authFrontUrl, publicOrigin, jwtSecret } = getConfig();
    if (!(await verifyAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE)?.value, jwtSecret))) {
      const login = buildLoginUrl({ loginPage: `${authFrontUrl}/login`, publicOrigin }, requestPath(request), LOGIN_FALLBACK);
      return NextResponse.redirect(login, 307);
    }
  }
  return NextResponse.next();
}

export const config = {
  // Tout sauf les fichiers statiques du build (jamais en écriture)
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
