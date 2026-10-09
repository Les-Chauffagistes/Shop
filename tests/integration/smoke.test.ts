import { expect, it } from "vitest";
import { prisma } from "./db";

it("insère un modèle et le relit", async () => {
  const created = await prisma.model.create({
    data: { name: "S19", hashrate: 95_000_000_000_000n, hashboard_qtt: 3 },
  });
  const found = await prisma.model.findUniqueOrThrow({ where: { id: created.id } });
  expect(found.name).toBe("S19");
  expect(found.hashrate).toBe(95_000_000_000_000n);
});

it("repart d'une base vide à chaque test", async () => {
  expect(await prisma.model.count()).toBe(0);
});
