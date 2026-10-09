/**
 * Adresse de la page de connexion d'auth-service front, avec retour sur un chemin de la boutique.
 * Le retour est bâti sur l'URL publique configurée (PUBLIC_URL), jamais sur les en-têtes `Host` /
 * `X-Forwarded-Host` de la requête : falsifiés, ils renverraient l'utilisateur fraîchement connecté
 * vers un site tiers (redirection ouverte). Sans dépendance serveur : utilisable dans le navigateur.
 */
export type LoginTarget = {
  /** Page de connexion d'auth-service front (ex. https://login.example.com/login) */
  loginPage: string;
  /** Origine publique de la boutique (PUBLIC_URL) */
  publicOrigin: string;
};

/** Caractères de contrôle (dont tabulation et retours à la ligne, ignorés par les navigateurs dans une URL). */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Vrai si `path` est un chemin relatif du site, avec sa requête éventuelle (« /lots/x?choix=a ») :
 * commence par un seul `/` (pas « //hote »), sans `\` (« /\hote » est lu « //hote » par les
 * navigateurs), sans caractère de contrôle, sans schéma (« javascript: », « https: »). Les mêmes
 * règles valent pour le chemin décodé (« /%2F%2Fhote », « /%5Chote ») : refusé au moindre doute.
 */
export function isSafeLocalPath(path: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\") || CONTROL.test(path)) return false;
  const pathname = path.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false; // encodage invalide
  }
  return !decoded.startsWith("//") && !decoded.includes("\\") && !CONTROL.test(decoded);
}

/**
 * Chemin de retour sûr : `path` s'il est un chemin relatif du site (voir isSafeLocalPath), sinon
 * `fallbackPath`.
 */
export function safeReturnPath(path: string, fallbackPath = "/"): string {
  return isSafeLocalPath(path) ? path : isSafeLocalPath(fallbackPath) ? fallbackPath : "/";
}

/**
 * `path` est le chemin complet où revenir (requête comprise). Toute adresse qui ne serait pas un
 * chemin relatif du site est remplacée par `fallbackPath`. Le retour est toujours rattaché à
 * l'origine publique ; vérifié une dernière fois après résolution.
 */
export function buildLoginUrl({ loginPage, publicOrigin }: LoginTarget, path: string, fallbackPath = "/"): string {
  const origin = new URL(publicOrigin).origin;
  let back = new URL(safeReturnPath(path, fallbackPath), origin);
  if (back.origin !== origin) back = new URL("/", origin);
  return `${loginPage}?redirect=${encodeURIComponent(back.toString())}`;
}
