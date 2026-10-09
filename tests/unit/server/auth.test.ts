import { SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const secret = new TextEncoder().encode("unit-test-secret");

const cookieJar = vi.hoisted(() => new Map<string, string>());
const users = vi.hoisted(() => ({
  findUnique: vi.fn(),
  createMany: vi.fn(),
  findUniqueOrThrow: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));
vi.mock("@/server/db", () => ({ getDb: () => ({ user: users }) }));
vi.mock("@/server/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/config")>()),
  getConfig: () => ({ jwtSecret: secret, backofficeUserIds: new Set(["7"]) }),
}));

const { ApiError } = await import("@/server/errors");
const { authUserIdToDb, getCurrentUser, requireBackoffice, requireUser, verifyAccessToken } = await import(
  "@/server/auth"
);

function token(claims: Record<string, unknown>, options: { key?: Uint8Array; exp?: string | number } = {}) {
  return new SignJWT({ type: "access", pseudo: "satoshi", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(options.exp ?? "15m")
    .sign(options.key ?? secret);
}

beforeEach(() => {
  cookieJar.clear();
  vi.clearAllMocks();
  users.findUnique.mockResolvedValue({ id: "local-user" });
});

describe("verifyAccessToken", () => {
  it("accepte un jeton d'accès valide émis par auth-service", async () => {
    expect(await verifyAccessToken(await token({ sub: "42" }), secret)).toEqual({ authUserId: "42", pseudo: "satoshi" });
  });

  it.each([
    ["absent", async () => undefined],
    ["mal signé", () => token({ sub: "42" }, { key: new TextEncoder().encode("autre-secret") })],
    ["expiré", () => token({ sub: "42" }, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ["d'onboarding", () => token({ sub: "42", type: "onboarding" })],
    ["sans sub", () => token({})],
    ["au sub non numérique", () => token({ sub: "admin" })],
    ["au sub hors BIGINT", () => token({ sub: "9223372036854775808" })],
    ["malformé", async () => "pas.un.jwt"],
  ])("rejette un jeton %s", async (_label, make) => {
    expect(await verifyAccessToken(await make(), secret)).toBeNull();
  });

  it("rejette l'algorithme none", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "7", type: "access", exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString("base64url");
    expect(await verifyAccessToken(`${header}.${payload}.`, secret)).toBeNull();
  });
});

describe("authUserIdToDb", () => {
  it("convertit l'identifiant en BIGINT sans perte au-delà de 2^53", () => {
    expect(authUserIdToDb("9223372036854775807")).toBe(9_223_372_036_854_775_807n);
  });

  it("refuse un identifiant invalide", () => {
    expect(() => authUserIdToDb("0")).toThrow(RangeError);
    expect(() => authUserIdToDb("9223372036854775808")).toThrow(RangeError);
  });
});

describe("gardes", () => {
  it("getCurrentUser renvoie null sans cookie, sans toucher la base", async () => {
    expect(await getCurrentUser()).toBeNull();
    expect(users.findUnique).not.toHaveBeenCalled();
  });

  it("requireUser lève 401 sans jeton valide", async () => {
    cookieJar.set("access_token", "invalide");
    await expect(requireUser()).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  });

  it("requireUser renvoie l'utilisateur local", async () => {
    cookieJar.set("access_token", await token({ sub: "42" }));
    expect(await requireUser()).toEqual({ id: "local-user", authUserId: "42", pseudo: "satoshi", isBackoffice: false });
  });

  it("requireBackoffice lève 403 hors whitelist", async () => {
    cookieJar.set("access_token", await token({ sub: "42" }));
    const error = await requireBackoffice().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("requireBackoffice lève 401 sans jeton", async () => {
    await expect(requireBackoffice()).rejects.toMatchObject({ status: 401 });
  });

  it("requireBackoffice accepte un identifiant de la whitelist", async () => {
    cookieJar.set("access_token", await token({ sub: "7" }));
    expect(await requireBackoffice()).toMatchObject({ authUserId: "7", isBackoffice: true });
  });

  it("la whitelist compare l'identifiant exact (pas de préfixe)", async () => {
    cookieJar.set("access_token", await token({ sub: "77" }));
    await expect(requireBackoffice()).rejects.toMatchObject({ status: 403 });
  });

  it("crée la ligne User si elle n'existe pas encore", async () => {
    users.findUnique.mockResolvedValue(null);
    users.findUniqueOrThrow.mockResolvedValue({ id: "new-user" });
    cookieJar.set("access_token", await token({ sub: "42" }));
    expect(await requireUser()).toMatchObject({ id: "new-user" });
    expect(users.createMany).toHaveBeenCalledWith({ data: [{ auth_user_id: 42n }], skipDuplicates: true });
  });
});
