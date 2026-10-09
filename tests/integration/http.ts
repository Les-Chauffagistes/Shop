import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import { TEST_JWT_SECRET } from "./env";

// Appel direct des handlers de route, comme le ferait Next.js. Le fichier de test doit simuler
// `next/headers` avec un `cookieJar` (voir backoffice-*.test.ts) : cookies() lit ce Map.

/** Admin de la whitelist de test (integrationEnv.BACKOFFICE_USER_IDS = "1"). */
export const ADMIN = "1";

/** Jeton d'accès auth-service signé avec le secret de test, posé dans le cookie. */
export async function signIn(cookieJar: Map<string, string>, authUserId: string) {
  const token = await new SignJWT({ type: "access", pseudo: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(authUserId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
  cookieJar.set("access_token", token);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- chaque route a son propre type de params
type Handler = (request: NextRequest, context: { params: Promise<any> }) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- corps JSON libre, vérifié par les tests
export type Reply = { status: number; body: any; headers: Headers };

/** Origine des requêtes de test : en-têtes d'une requête same-origin d'un navigateur. */
export const SAME_ORIGIN = { origin: "http://shop.test", "sec-fetch-site": "same-origin" };

export async function call(
  handler: Handler,
  {
    path = "/",
    body,
    params = {},
    method,
    headers = {},
  }: {
    path?: string;
    body?: unknown;
    params?: Record<string, string>;
    /** Par défaut GET sans corps, POST avec (les handlers ne lisent pas la méthode) */
    method?: string;
    /** Remplacent ou complètent `content-type: application/json` et `host: shop.test` */
    headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  const request = new NextRequest(new URL(path, "http://shop.test"), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", host: "shop.test", ...headers },
  });
  const response = await handler(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}
