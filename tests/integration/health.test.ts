import { afterEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";
import { prisma } from "./db";

afterEach(() => vi.restoreAllMocks());

it("répond 200 quand la base répond", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ok" });
});

it("répond 503 sans détail quand la base échoue", async () => {
  vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe(JSON.stringify({ status: "unavailable" }));
});
