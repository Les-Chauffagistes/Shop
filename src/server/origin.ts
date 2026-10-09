/**
 * Protection CSRF par contrôle d'origine (docs/api.md, « Requêtes cross-site »).
 *
 * Le cookie `access_token` d'auth-service est posé en `SameSite=Lax` sur le domaine parent : le
 * navigateur ne l'envoie plus sur un POST cross-site, mais il l'envoie encore depuis les autres
 * sous-domaines (même site). Ce contrôle reste la défense en profondeur : toute méthode non sûre
 * (POST, PATCH, PUT, DELETE…) doit venir de la même origine que l'application :
 * - `Sec-Fetch-Site` présent (tous les navigateurs pris en charge par Next 16) : seul
 *   `same-origin` passe. `same-site` est refusé : les autres services du domaine parent
 *   partagent le cookie mais n'ont pas à écrire ici.
 * - sinon `Origin` présent : son hôte doit être celui de la requête (`X-Forwarded-Host`, à
 *   défaut `Host`, comme le contrôle des Server Actions de Next). `Origin: null` est refusé.
 * - ni l'un ni l'autre : client hors navigateur (curl, scripts, Playwright `request`). Accepté :
 *   un navigateur envoie toujours `Origin` sur une requête cross-origin non sûre, et un tel
 *   client n'a pas le cookie de la victime. Le `Content-Type: application/json` exigé par
 *   `readJson` reste un second rempart (preflight CORS, jamais autorisé par l'application).
 *
 * Appliqué deux fois, avec cette seule implémentation : par `src/proxy.ts` (toutes les routes, y
 * compris futures) et par `withErrorHandling` (chaque handler, même si le matcher du proxy change).
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Vrai si la requête est une écriture qui ne vient pas de la même origine. */
export function isCrossOriginWrite(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  const headers = request.headers;

  const site = headers.get("sec-fetch-site");
  if (site !== null) return site !== "same-origin";

  const origin = headers.get("origin");
  if (origin === null) return false;
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0].trim();
  if (!host) return true;
  try {
    const from = new URL(origin);
    // Même normalisation des deux côtés (casse, port par défaut du schéma de l'Origin)
    return from.host !== new URL(`${from.protocol}//${host}`).host;
  } catch {
    return true; // « null » (iframe sandbox, redirection) ou valeur illisible
  }
}
