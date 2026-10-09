import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { findOrCreateUser, getCurrentUser } from "@/server/auth";
import { prisma } from "./db";
import { TEST_JWT_SECRET } from "./env";

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

describe("findOrCreateUser", () => {
  // auth.users.id, transmis en décimal dans `sub` ; colonne BIGINT.
  const authUserId = "42";

  it("crée la ligne User une seule fois", async () => {
    const first = await findOrCreateUser(authUserId);
    const second = await findOrCreateUser(authUserId);
    expect(second.id).toBe(first.id);
    expect(await prisma.user.count({ where: { auth_user_id: 42n } })).toBe(1);
  });

  it("reste idempotent sous appels concurrents", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => findOrCreateUser(authUserId)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });
});

// auth-service émet `sub` = auth.users.id (BIGINT, ex. "42") : User.auth_user_id est en BIGINT.
it("getCurrentUser crée puis retrouve l'utilisateur d'un vrai jeton auth-service", async () => {
  const token = await new SignJWT({ type: "access", pseudo: "satoshi" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("42")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
  cookieJar.set("access_token", token);

  const first = await getCurrentUser();
  const second = await getCurrentUser();
  expect(first).toMatchObject({ authUserId: "42", pseudo: "satoshi", isBackoffice: false });
  expect(second?.id).toBe(first?.id);
  expect(await prisma.user.count()).toBe(1);
  expect((await prisma.user.findFirstOrThrow()).auth_user_id).toBe(42n);
});
