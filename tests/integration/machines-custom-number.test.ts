import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import { prisma } from "./db";
import { type Catalog, createBatch, createCatalog, createStockBatch, failureOf, machinesOf, restock } from "./fixtures";

// Numéro custom du technicien : compteur 1 à n par palette ou réassort, posé par la base, immuable.

let catalog: Catalog;

beforeEach(async () => {
  catalog = await createCatalog();
});

const numbersOf = async (where: { origin_batch_id?: string; restock_id?: string }) =>
  (await prisma.machine.findMany({ where, orderBy: { custom_number: "asc" } })).map((m) => m.custom_number);

describe("numéro custom", () => {
  it("numérote les machines d'une palette de 1 à n", async () => {
    const lot = await createBatch(catalog, { quantity: 4, status: "inspection" });
    expect(await numbersOf({ origin_batch_id: lot })).toEqual([1, 2, 3, 4]);
  });

  it("numérote chaque réassort à part", async () => {
    const stock = await createStockBatch(catalog);
    const a = await restock(catalog, stock, 2);
    const b = await restock(catalog, stock, 3);
    expect(await numbersOf({ restock_id: a.restockId })).toEqual([1, 2]);
    expect(await numbersOf({ restock_id: b.restockId })).toEqual([1, 2, 3]);
  });

  it("refuse de le modifier, et ignore la valeur fournie à la création", async () => {
    const lot = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const [first] = await machinesOf(lot);
    const failure = await failureOf(prisma.machine.update({ where: { id: first.id }, data: { custom_number: 9 } }));
    expect(pgFailureOf(failure)?.constraint).toBe("Machine_immutable");
  });
});
