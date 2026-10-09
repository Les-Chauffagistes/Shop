import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import { ADMIN, call, SAME_ORIGIN, signIn } from "./http";

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

// Inventaire de toutes les routes du backoffice : une route ajoutée plus tard est couverte d'office.
const API_DIR = fileURLToPath(new URL("../../src/app/api/backoffice", import.meta.url));
const ROUTE_FILES = (readdirSync(API_DIR, { recursive: true }) as string[])
  .filter((file) => file.endsWith("route.ts"))
  .map((file) => join(API_DIR, file))
  .sort();
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
const WRITE_METHODS = new Set<string>(["POST", "PATCH", "PUT", "DELETE"]);
const ANY_UUID = "5e1d0000-0000-4000-8000-000000000001";

type Handler = Parameters<typeof call>[0];

async function handlers() {
  const out: { name: string; method: string; handler: Handler; params: Record<string, string> }[] = [];
  for (const file of ROUTE_FILES) {
    const route = (await import(file)) as Record<string, Handler | undefined>;
    // Paramètres de chemin ([batchId]…) : un uuid quelconque, la garde passe avant toute lecture
    const params = Object.fromEntries([...file.matchAll(/\[(\w+)\]/g)].map(([, key]) => [key, ANY_UUID]));
    for (const method of METHODS) {
      const handler = route[method];
      if (handler) out.push({ name: `${method} ${relative(API_DIR, file)}`, method, handler, params });
    }
  }
  return out;
}

beforeEach(() => cookieJar.clear());

describe("garde du backoffice sur chaque route", () => {
  it("trouve les routes à vérifier", async () => {
    expect((await handlers()).length).toBeGreaterThanOrEqual(17);
  });

  it("401 sans session, 403 hors whitelist, sans rien écrire", async () => {
    const before = await prisma.model.count();
    for (const { name, handler, params } of await handlers()) {
      cookieJar.clear();
      const anonymous = await call(handler, { params, body: {} });
      expect(anonymous.status, name).toBe(401);
      expect(anonymous.body.error.code, name).toBe("unauthenticated");

      await signIn(cookieJar, "2");
      const outsider = await call(handler, { params, body: {} });
      expect(outsider.status, name).toBe(403);
      expect(outsider.body.error.code, name).toBe("forbidden");
    }
    expect(await prisma.model.count()).toBe(before);
  });

  it("un jeton signé avec un autre secret vaut absence de session", async () => {
    const { SignJWT } = await import("jose");
    cookieJar.set(
      "access_token",
      await new SignJWT({ type: "access" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("1")
        .setExpirationTime("15m")
        .sign(new TextEncoder().encode("another-secret-another-secret-xx")),
    );
    for (const { name, handler, params } of await handlers()) {
      expect((await call(handler, { params, body: {} })).status, name).toBe(401);
    }
  });
});

// CSRF (docs/api.md, « Requêtes cross-site ») : le cookie access_token est en SameSite=Lax : un
// autre sous-domaine (même site) peut faire envoyer une requête authentifiée par le navigateur
// d'un admin, et le contrôle d'origine reste la défense en profondeur contre un site tiers.
describe("écritures cross-site refusées sur chaque route", () => {
  const CROSS_SITE: Record<string, string>[] = [
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    { origin: "https://autre.chauffagistes.example", "sec-fetch-site": "same-site" },
    { origin: "https://evil.example" }, // navigateur sans Sec-Fetch-Site
    { origin: "null" }, // iframe sandbox, redirection
    { "sec-fetch-site": "cross-site" },
  ];

  it("403 cross_origin pour un admin connecté, avant toute lecture du corps, sans rien écrire", async () => {
    await signIn(cookieJar, ADMIN);
    const before = await Promise.all([prisma.model.count(), prisma.part.count(), prisma.batch.count()]);
    for (const { name, method, handler, params } of await handlers()) {
      if (!WRITE_METHODS.has(method)) continue;
      for (const headers of CROSS_SITE) {
        // Formulaire HTML forgé : text/plain, corps JSON valide
        const reply = await call(handler, {
          method,
          params,
          body: JSON.stringify({ name: "Intrus" }),
          headers: { ...headers, "content-type": "text/plain" },
        });
        expect(reply.status, `${name} ${JSON.stringify(headers)}`).toBe(403);
        expect(reply.body.error.code, name).toBe("cross_origin");
      }
    }
    expect(await Promise.all([prisma.model.count(), prisma.part.count(), prisma.batch.count()])).toEqual(before);
  });

  it("les lectures restent permises quelle que soit l'origine", async () => {
    await signIn(cookieJar, ADMIN);
    for (const { name, method, handler, params } of await handlers()) {
      if (method !== "GET") continue;
      for (const headers of CROSS_SITE) {
        expect((await call(handler, { method, params, headers })).status, name).not.toBe(403);
      }
    }
  });

  it("415 unsupported_media_type sur un corps qui n'est pas application/json, même en same-origin", async () => {
    await signIn(cookieJar, ADMIN);
    for (const { name, method, handler, params } of await handlers()) {
      if (method !== "POST" && method !== "PATCH") continue;
      for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
        const reply = await call(handler, {
          method,
          params,
          body: "{}",
          headers: { ...SAME_ORIGIN, "content-type": contentType },
        });
        expect(reply.status, `${name} ${contentType}`).toBe(415);
        expect(reply.body.error.code, name).toBe("unsupported_media_type");
      }
    }
  });
});

describe("écriture same-origin acceptée", () => {
  it("navigateur (Origin + Sec-Fetch-Site same-origin), Origin seul, proxy (X-Forwarded-Host), client sans Origin", async () => {
    await signIn(cookieJar, ADMIN);
    const { POST } = await import("@/app/api/backoffice/parts/route");
    const variants: Record<string, string>[] = [
      SAME_ORIGIN,
      { origin: "http://shop.test" },
      { origin: "https://boutique.example", "x-forwarded-host": "boutique.example" },
      {}, // curl, scripts, Playwright `request`
      { "content-type": "application/json; charset=utf-8", ...SAME_ORIGIN },
    ];
    for (const [i, headers] of variants.entries()) {
      const reply = await call(POST, { method: "POST", body: { name: `Pièce ${i}` }, headers });
      expect(reply.status, JSON.stringify(headers)).toBe(201);
    }
    expect(await prisma.part.count()).toBe(variants.length);
  });
});
