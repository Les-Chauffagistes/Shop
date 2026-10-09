import { forbidden, redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { loginUrl as shopLoginUrl } from "../../_lib/login";

/** Connexion avec retour sur `path` ; une adresse hors de la boutique revient à l'accueil du backoffice. */
export const loginUrl = (path: string) => shopLoginUrl(path, "/backoffice");

/**
 * Garde de chaque page du backoffice (le layout ne se ré-exécute pas à la navigation, la garde
 * est donc refaite au plus près des données) :
 * - non connecté : redirection vers la connexion, retour sur `path` ;
 * - connecté hors whitelist : `forbidden()`, qui affiche `forbidden.tsx` avec le vrai statut HTTP 403
 *   (`experimental.authInterrupts`, next.config.ts). Seul le streaming l'empêcherait : le
 *   backoffice n'a pas de `loading.tsx`, n'en ajouter aucun.
 * Les écritures restent gardées par les routes API (requireBackoffice).
 */
export async function backofficeAccess(path: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrl(path));
  if (!user.isBackoffice) forbidden();
}
