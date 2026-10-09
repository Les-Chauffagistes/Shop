import { getConfig } from "@/server/config";
import { buildLoginUrl, type LoginTarget } from "@/lib/login";

/** Page de connexion et origine publique, d'après la configuration (transmissibles au navigateur). */
export function loginTarget(): LoginTarget {
  const { authFrontUrl, publicOrigin } = getConfig();
  return { loginPage: `${authFrontUrl}/login`, publicOrigin };
}

/** Page de connexion d'auth-service front, avec retour sur `path` (voir buildLoginUrl). */
export function loginUrl(path: string, fallbackPath = "/"): string {
  return buildLoginUrl(loginTarget(), path, fallbackPath);
}

/**
 * Chemin complet d'une page (requête comprise), d'après ses `searchParams` : pour revenir
 * exactement sur la page après la connexion.
 */
export function pagePath(pathname: string, searchParams: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const search = query.toString();
  return search ? `${pathname}?${search}` : pathname;
}

