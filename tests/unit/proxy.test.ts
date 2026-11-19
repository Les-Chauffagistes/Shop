// La doc de Next 16 annonce `unstable_doesProxyMatch`, la version installée exporte encore ce nom-ci.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

const secret = new TextEncoder().encode("unit-test-secret");
vi.mock("@/server/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/config")>()),
  getConfig: () => ({ jwtSecret: secret, authApiUrl: "https://auth.example", authFrontUrl: "https://login.example", publicOrigin: "https://boutique.example" }),
}));
import { config, proxy } from "@/proxy";
import { isCrossOriginWrite } from "@/server/origin";

const request = (method: string, headers: Record<string, string> = {}, path = "/api/backoffice/parts") =>
  new NextRequest(new URL(path, "https://boutique.example"), { method, headers: { host: "boutique.example", ...headers } });

describe("isCrossOriginWrite", () => {
  it("laisse passer toute lecture, quelle que soit l'origine", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isCrossOriginWrite(request(method, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBe(false);
    }
  });

  it("écriture : Sec-Fetch-Site fait foi, seul same-origin passe", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(isCrossOriginWrite(request(method, { "sec-fetch-site": "same-origin" }))).toBe(false);
      expect(isCrossOriginWrite(request(method, { "sec-fetch-site": "cross-site" }))).toBe(true);
      expect(isCrossOriginWrite(request(method, { "sec-fetch-site": "same-site" }))).toBe(true);
      expect(isCrossOriginWrite(request(method, { "sec-fetch-site": "none" }))).toBe(true);
    }
  });

  it("écriture sans Sec-Fetch-Site : Origin doit être l'hôte de la requête (X-Forwarded-Host d'abord)", () => {
    expect(isCrossOriginWrite(request("POST", { origin: "https://boutique.example" }))).toBe(false);
    expect(isCrossOriginWrite(request("POST", { origin: "https://BOUTIQUE.example:443" }))).toBe(false);
    expect(isCrossOriginWrite(request("POST", { origin: "https://boutique.example", host: "boutique.example:443" }))).toBe(false);
    expect(isCrossOriginWrite(request("POST", { origin: "https://evil.example" }))).toBe(true);
    expect(isCrossOriginWrite(request("POST", { origin: "https://boutique.example.evil.example" }))).toBe(true);
    expect(isCrossOriginWrite(request("POST", { origin: "https://boutique.example:8443" }))).toBe(true);
    expect(isCrossOriginWrite(request("POST", { origin: "null" }))).toBe(true);
    expect(
      isCrossOriginWrite(request("POST", { origin: "https://boutique.example", host: "shop:3000", "x-forwarded-host": "boutique.example" })),
    ).toBe(false);
    expect(
      isCrossOriginWrite(request("POST", { origin: "https://evil.example", "x-forwarded-host": "boutique.example, evil.example" })),
    ).toBe(true);
  });

  it("écriture sans Origin ni Sec-Fetch-Site (client hors navigateur) : acceptée", () => {
    expect(isCrossOriginWrite(request("POST"))).toBe(false);
  });
});

describe("proxy", () => {
  it("refuse une écriture cross-site en 403 cross_origin, sur toute route", async () => {
    for (const path of ["/api/backoffice/batches", "/api/health", "/api/une-route-future", "/backoffice/lots"]) {
      const response = await proxy(request("POST", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }, path));
      expect(response.status, path).toBe(403);
      expect((await response.json()).error.code).toBe("cross_origin");
    }
  });

  it("laisse passer les lectures et les écritures same-origin", async () => {
    const pass = async (r: NextRequest) => (await proxy(r)).headers.get("x-middleware-next");
    expect(await pass(request("GET", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBe("1");
    expect(await pass(request("POST", { origin: "https://boutique.example", "sec-fetch-site": "same-origin" }))).toBe("1");
  });

  it("s'applique à toutes les routes, y compris futures, sauf les fichiers statiques du build", () => {
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, nextConfig, url });
    for (const url of ["/api/backoffice/parts", "/api/backoffice/x/y/z", "/api/demain", "/backoffice/lots/nouveau", "/"]) {
      expect(matches(url), url).toBe(true);
    }
    expect(matches("/_next/static/chunks/main.js")).toBe(false);
  });
});

describe("en-têtes de sécurité (next.config.ts)", () => {
  it("X-Powered-By désactivé, en-têtes posés sur toutes les routes", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");
    const headers = Object.fromEntries(rules[0].headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(headers).toMatchObject({
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    });
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["permissions-policy"]).toContain("camera=()");
  });
});

describe("garde de l'espace personnel (intérêts, commandes, commander)", () => {
  const token = () =>
    new SignJWT({ type: "access", pseudo: "alice" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("42")
      .setExpirationTime("5m")
      .sign(secret);
  const back = (location: string | null) => new URL(location!).searchParams.get("redirect");

  it("sans jeton valide : 307 vers la connexion, retour sur le chemin exact, requête comprise", async () => {
    const response = await proxy(request("GET", {}, "/mes-interets/abc?source=courriel&_rsc=x1"));
    expect(response.status).toBe(307);
    const location = response.headers.get("location")!;
    expect(location.startsWith("https://login.example/login?")).toBe(true);
    expect(back(location)).toBe("https://boutique.example/mes-interets/abc?source=courriel");

    const forged = await proxy(request("GET", { cookie: "access_token=pas-un-jeton" }, "/mes-interets"));
    expect(back(forged.headers.get("location"))).toBe("https://boutique.example/mes-interets");
  });

  it("« Mes commandes », « Mon profil » et la page de commande d'un lot sont gardées de la même façon", async () => {
    for (const path of ["/mes-commandes", "/mes-commandes/abc?fait=annulation", "/lots/abc/commander", "/profil"]) {
      const response = await proxy(request("GET", {}, path));
      expect(response.status, path).toBe(307);
      expect(back(response.headers.get("location")), path).toBe(`https://boutique.example${path}`);
    }
    const signedIn = await proxy(request("GET", { cookie: `access_token=${await token()}` }, "/lots/abc/commander"));
    expect(signedIn.headers.get("x-middleware-next")).toBe("1");
  });

  it("le retour ignore l'hôte de la requête", async () => {
    const response = await proxy(request("GET", { host: "evil.example", "x-forwarded-host": "evil.example" }, "/mes-interets"));
    expect(new URL(back(response.headers.get("location"))!).origin).toBe("https://boutique.example");
  });

  it("avec un jeton valide, ou hors de l'espace personnel : laisse passer", async () => {
    const signedIn = await proxy(request("GET", { cookie: `access_token=${await token()}` }, "/mes-interets/abc"));
    expect(signedIn.headers.get("x-middleware-next")).toBe("1");
    for (const path of ["/", "/lots/abc", "/lots/abc/commander/x", "/mes-interets-bis", "/mes-commandes-bis", "/profil-bis", "/api/wishlists", "/api/profile"]) {
      expect((await proxy(request("GET", {}, path))).headers.get("x-middleware-next"), path).toBe("1");
    }
  });
});

describe("rafraîchissement de la session", () => {
  const freshToken = () =>
    new SignJWT({ type: "access", pseudo: "alice" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("42")
      .setExpirationTime("15m")
      .sign(secret);
  const refreshed = async () => {
    const access = await freshToken();
    return new Response("{}", {
      status: 200,
      headers: [
        ["set-cookie", `access_token=${access}; Domain=example; Path=/; HttpOnly; SameSite=None; Secure`],
        ["set-cookie", "refresh_token=neuf; Domain=example; Path=/; HttpOnly; SameSite=None; Secure"],
      ],
    });
  };
  const forwardedCookie = (response: Response) => response.headers.get("x-middleware-request-cookie");

  afterEach(() => vi.unstubAllGlobals());

  it("jeton d'accès expiré, jeton de rafraîchissement accepté : la requête passe avec les nouveaux cookies", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(refreshed);
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxy(request("GET", { cookie: "access_token=perime; refresh_token=ancien; theme=sombre" }, "/mes-commandes"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://auth.example/refresh");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ cookie: "refresh_token=ancien" });
    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]).toContain("access_token=");
    expect(forwardedCookie(response)).toMatch(/^theme=sombre; access_token=.+; refresh_token=neuf$/);
  });

  it("s'applique aussi hors de l'espace personnel (backoffice, API) dès qu'un jeton de rafraîchissement est présent", async () => {
    vi.stubGlobal("fetch", vi.fn(refreshed));
    const response = await proxy(request("GET", { cookie: "refresh_token=ancien" }, "/backoffice/lots"));
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("jeton d'accès encore valide : aucun appel à auth-service", async () => {
    const fetchMock = vi.fn(refreshed);
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxy(request("GET", { cookie: `access_token=${await freshToken()}; refresh_token=ancien` }, "/mes-commandes"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("jeton de rafraîchissement refusé : espace personnel redirigé vers la connexion, le reste laissé passer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const guarded = await proxy(request("GET", { cookie: "refresh_token=revoque" }, "/mes-commandes"));
    expect(guarded.status).toBe(307);
    const open = await proxy(request("GET", { cookie: "refresh_token=revoque" }, "/lots/abc"));
    expect(open.headers.get("x-middleware-next")).toBe("1");
    expect(open.headers.getSetCookie()).toHaveLength(0);
  });

  it("auth-service injoignable : même comportement qu'un refus, sans erreur", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const response = await proxy(request("GET", { cookie: "refresh_token=ancien" }, "/profil"));
    expect(response.status).toBe(307);
  });

  it("requêtes simultanées avec le même jeton : un seul appel (le jeton tourne à chaque usage)", async () => {
    const fetchMock = vi.fn(refreshed);
    vi.stubGlobal("fetch", fetchMock);
    const responses = await Promise.all(
      [1, 2, 3].map(() => proxy(request("GET", { cookie: "refresh_token=partage" }, "/mes-commandes"))),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const response of responses) expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
