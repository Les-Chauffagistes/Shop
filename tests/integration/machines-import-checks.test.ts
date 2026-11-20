import { beforeEach, describe, expect, it, vi } from "vitest";
import * as importRoute from "@/app/api/backoffice/machines/import-checks/route";
import { prisma } from "./db";
import { type Catalog, changeMachine, createBatch, createCatalog, machinesOf } from "./fixtures";
import { ADMIN, call, SAME_ORIGIN, signIn } from "./http";

// Import CSV du contrôle : nombre de hashboards du modèle, correspondance par numéro de série, tout ou rien.

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

let catalog: Catalog;

const importCsv = (csv: string, dryRun = false) =>
  call(importRoute.POST, { body: { modelId: catalog.modelId, csv, dryRun }, headers: SAME_ORIGIN });

/** Machines reçues (en stock), numéros de série SN1…, non contrôlées. */
async function receivedMachines(n: number) {
  const lot = await createBatch(catalog, { quantity: n, status: "inspection" });
  const machines = await machinesOf(lot);
  for (const [i, m] of machines.entries()) {
    await prisma.machine.update({ where: { id: m.id }, data: { serial: `SN${i + 1}` } });
    await changeMachine(prisma, m.id, { logistical: "in_stock" });
  }
  return machines;
}

beforeEach(async () => {
  catalog = await createCatalog();
  cookieJar.clear();
  await signIn(cookieJar, ADMIN);
});

describe("POST /machines/import-checks", () => {
  it("refuse un fichier dont le nombre de boards n'est pas celui du modèle, sans rien écrire", async () => {
    const [m] = await receivedMachines(1);
    const reply = await importCsv("name,serial,board1_statut,board2_statut\nM1,SN1,ok,ok");
    expect(reply.status).toBe(422);
    expect(reply.body.error.code).toBe("csv_invalid");
    expect(reply.body.error.details.issues[0].message).toContain("3 hashboards");
    expect(await prisma.hashboardStatus.count({ where: { machine_id: m.id } })).toBe(0);
  });

  it("importe : machine OK si toutes les boards sont OK, dégradée si l'une est défectueuse", async () => {
    const [a, b] = await receivedMachines(2);
    const csv = "name,serial,board1_statut,board2_statut,board3_statut\n1,SN1,ok,ok,ok\n2,SN2,ok,dead,ok";
    const reply = await importCsv(csv);
    expect(reply.status).toBe(201);
    const [ma, mb] = await Promise.all([a, b].map((m) => prisma.machine.findUniqueOrThrow({ where: { id: m.id } })));
    expect([ma.functional_status, mb.functional_status]).toEqual(["ok", "degraded"]);
    expect(await prisma.hashboardStatus.count({ where: { machine_id: b.id } })).toBe(3);
    expect((await prisma.hashboardStatus.findUniqueOrThrow({ where: { machine_id_index: { machine_id: b.id, index: 1 } } })).status).toBe("dead");
  });

  it("dryRun n'écrit rien ; tout ou rien si un numéro de série est inconnu", async () => {
    const [a] = await receivedMachines(1);
    const head = "name,serial,board1_statut,board2_statut,board3_statut";
    const dry = await importCsv(`${head}\n1,SN1,ok,ok,ok`, true);
    expect(dry.status).toBe(200);
    expect(dry.body.items[0]).toMatchObject({ serial: "SN1", from: "unknown", to: "ok" });
    expect(await prisma.hashboardStatus.count({ where: { machine_id: a.id } })).toBe(0);

    const bad = await importCsv(`${head}\n1,SN1,ok,ok,ok\n2,NOPE,ok,ok,ok`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.issues).toEqual([expect.objectContaining({ line: 3 })]);
    expect((await prisma.machine.findUniqueOrThrow({ where: { id: a.id } })).functional_status).toBe("unknown");
  });

  it("refuse une ligne dont le name n'est pas le numéro custom de la machine", async () => {
    await receivedMachines(2);
    const reply = await importCsv("name,serial,board1_statut,board2_statut,board3_statut\n2,SN1,ok,ok,ok");
    expect(reply.status).toBe(422);
    expect(reply.body.error.details.issues[0].message).toContain("n° 1");
  });

  it("refuse une machine pas encore reçue", async () => {
    const lot = await createBatch(catalog, { quantity: 1, status: "awaiting_reception" });
    const [m] = await machinesOf(lot);
    await prisma.machine.update({ where: { id: m.id }, data: { serial: "SN1" } });
    const reply = await importCsv("name,serial,board1_statut,board2_statut,board3_statut\n1,SN1,ok,ok,ok");
    expect(reply.status).toBe(422);
    expect(reply.body.error.details.issues[0].message).toContain("en main");
  });
});
