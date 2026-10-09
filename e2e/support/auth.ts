import type { BrowserContext } from "@playwright/test";
import { SignJWT } from "jose";
import { ADMIN_AUTH_USER_ID, E2E_JWT_SECRET } from "./env";

/**
 * Jeton d'accès au format d'auth-service back (src/server/auth.ts) : HS256 signé avec le
 * secret de test, claims `{ sub, pseudo, type: "access" }`, 15 min. Aucun contournement dans
 * l'application : elle vérifie ce cookie exactement comme un vrai.
 */
export async function forgeAccessToken(authUserId: string, pseudo: string): Promise<string> {
  return new SignJWT({ type: "access", pseudo })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(authUserId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(E2E_JWT_SECRET));
}

/** Pose le cookie `access_token` sur le contexte (pages et requêtes API). */
export async function signIn(context: BrowserContext, baseURL: string, authUserId = ADMIN_AUTH_USER_ID, pseudo = "admin-e2e") {
  await context.addCookies([
    {
      name: "access_token",
      value: await forgeAccessToken(authUserId, pseudo),
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/** Suffixe unique pour isoler les données d'un test (la base n'est pas vidée entre deux runs). */
export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
