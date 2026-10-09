import { beforeEach, describe, expect, it, vi } from "vitest";
import * as batchRoute from "@/app/api/backoffice/batches/[batchId]/route";
import * as transitionsRoute from "@/app/api/backoffice/batches/[batchId]/transitions/route";
import * as batchesRoute from "@/app/api/backoffice/batches/route";
import { BATCH_STATUS_LABELS, TRANSITIONS } from "@/server/batch-status";
import { toErrorResponse } from "@/server/errors";
import type { BatchStatus } from "../../prisma/generated/enums";
import { prisma } from "./db";
import {
  type Catalog,
  createBatch as createBatchInDb,
  createCatalog,
  createUser,
  failureOf,
  moveBatch,
  pay,
  placeOrder,
  priorityOverAt,
  wish,
} from "./fixtures";
import { ADMIN, call, type Reply, signIn } from "./http";

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

let catalog: Catalog;

beforeEach(async () => {
  cookieJar.clear();
  await signIn(cookieJar, ADMIN);
  catalog = await createCatalog(); // S19, menu « Kit de ventilation » : Sans kit (défaut), Silent kit 75 €
});

async function newBatch(body: object = {}) {
  const reply = await call(batchesRoute.POST, {
    body: { modelId: catalog.modelId, quantity: 10, purchasePrice: "1500000", ...body },
  });
  expect(reply.status).toBe(201);
  return reply.body;
}

const getBatch = (batchId: string) => call(batchRoute.GET, { params: { batchId } });
const patchAt = (batchId: string, expectedUpdatedAt: string | undefined, body: object) =>
  call(batchRoute.PATCH, { params: { batchId }, body: { expectedUpdatedAt, ...body } });
/** PATCH depuis un onglet à jour : relit `updatedAt` juste avant. */
const patch = async (batchId: string, body: object) => patchAt(batchId, (await getBatch(batchId)).body.updatedAt, body);
/** Transition ; sans `from` explicite, envoie le statut courant (onglet à jour). */
const move = async (batchId: string, body: { to: BatchStatus; from?: BatchStatus; note?: string }) =>
  call(transitionsRoute.POST, {
    params: { batchId },
    body: { from: body.from ?? (await getBatch(batchId)).body.status, ...body },
  });

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({ status, code });
}

describe("création", () => {
  it("brouillon, nom par défaut, journal, compteurs à zéro, montants en chaînes", async () => {
    const batch = await newBatch();
    expect(batch).toMatchObject({
      name: "10 S19",
      status: "draft",
      statusLabel: "Brouillon",
      model: { id: catalog.modelId, name: "S19", hashboardQtt: 3 },
      quantity: 10,
      purchasePrice: "1500000",
      resaleUnitPrice: null,
      counters: {
        paidMachines: 0,
        pendingMachines: 0,
        orderedMachines: 0,
        availableStock: 10,
        interestedMachines: 0,
        interestedUsers: 0,
      },
    });
    expect(batch).not.toHaveProperty("currency"); // devise unique : l'euro
    expect(batch.history).toEqual([
      { id: expect.any(String), from: null, to: "draft", note: null, changedBy: ADMIN, createdAt: expect.any(String) },
    ]);
    expect(batch.editableFields).toContain("modelId");
    // Sans prix de revente, seule l'annulation est faisable
    expect(batch.transitions.map((t: { to: string; allowed: boolean }) => [t.to, t.allowed])).toEqual([
      ["survey", false],
      ["preorder", false],
      ["ordering", false],
      ["cancelled", true],
    ]);
  });

  it("options retirées, dérogations de prix, quantités max", async () => {
    const batch = await newBatch({
      name: "Palette Bitmain",
      resaleUnitPrice: "180000",
      optionValues: [{ optionValueId: catalog.silentId, priceOverride: "6000", maxQty: 3 }],
    });
    expect(batch.name).toBe("Palette Bitmain");
    const values = batch.options[0].values;
    expect(values).toMatchObject([
      { label: "Sans kit", isDefault: true, enabled: true, price: "0", priceOverride: null, effectivePrice: "0", maxQty: null },
      { label: "Silent kit", enabled: true, price: "7500", priceOverride: "6000", effectivePrice: "6000", maxQty: 3, used: 0 },
    ]);

    const withdrawn = await patch(batch.id, { optionValues: [{ optionValueId: catalog.silentId, enabled: false }] });
    expect(withdrawn.body.options[0].values[1]).toMatchObject({ enabled: false, priceOverride: null, maxQty: null });
  });

  it("refuse de retirer la valeur par défaut ou une valeur d'un autre modèle", async () => {
    const reply = await call(batchesRoute.POST, {
      body: { modelId: catalog.modelId, quantity: 1, purchasePrice: "1", optionValues: [{ optionValueId: catalog.noKitId, enabled: false }] },
    });
    expectError(reply, 409, "default_value_withdrawn");

    const other = await createCatalog("S21");
    const foreign = await call(batchesRoute.POST, {
      body: { modelId: catalog.modelId, quantity: 1, purchasePrice: "1", optionValues: [{ optionValueId: other.silentId, maxQty: 1 }] },
    });
    expectError(foreign, 422, "unknown_option_value");
    expect(await prisma.batch.count()).toBe(0);
  });

  it("bornes : prix strictement positifs et plafonnés, quantité plafonnée, un message exact par champ", async () => {
    const post = (body: object) =>
      call(batchesRoute.POST, { body: { modelId: catalog.modelId, quantity: 1, purchasePrice: "100", ...body } });
    const issues = (reply: Reply) => reply.body.error.issues.map((i: { path: string; message: string }) => [i.path, i.message]);
    const purchase = "Montant compris entre 0,01 et 100\u202f000\u202f000,00 attendu";
    const resale = "Montant compris entre 0,01 et 1\u202f000\u202f000,00 attendu";
    const quantity = "Nombre entier de machines compris entre 1 et 10\u202f000 attendu";

    expect(issues(await post({ purchasePrice: "0" }))).toEqual([["purchasePrice", purchase]]);
    expect(issues(await post({ purchasePrice: "10000000001" }))).toEqual([["purchasePrice", purchase]]);
    expect(issues(await post({ purchasePrice: "9999999999999999" }))).toEqual([["purchasePrice", purchase]]);
    expect(issues(await post({ resaleUnitPrice: "0" }))).toEqual([["resaleUnitPrice", resale]]);
    expect(issues(await post({ resaleUnitPrice: "100000001" }))).toEqual([["resaleUnitPrice", resale]]);
    for (const q of [0, -1, 1.5, 10_001, 99_999_999, "3"]) {
      expect(issues(await post({ quantity: q })), String(q)).toEqual([["quantity", quantity]]);
    }
    expect((await post({ quantity: 10_000, purchasePrice: "10000000000", resaleUnitPrice: "100000000" })).status).toBe(201);
    expect((await post({ purchasePrice: "1", resaleUnitPrice: "1" })).status).toBe(201);
    expect((await post({ resaleUnitPrice: null })).status).toBe(201);

    const batch = await newBatch();
    expectError(await patch(batch.id, { purchasePrice: "0" }), 400, "invalid_input");
    expectError(await patch(batch.id, { resaleUnitPrice: "0" }), 400, "invalid_input");
    expectError(await patch(batch.id, { quantity: 99_999_999 }), 400, "invalid_input");
  });

  it("valide les entrées", async () => {
    expectError(await call(batchesRoute.POST, { body: { modelId: catalog.modelId, quantity: 0, purchasePrice: "1" } }), 400, "invalid_input");
    expectError(await call(batchesRoute.POST, { body: { modelId: catalog.modelId, quantity: 1, purchasePrice: 100 } }), 400, "invalid_input");
    expectError(await call(batchesRoute.POST, { body: { modelId: catalog.modelId, quantity: 1, purchasePrice: "-1" } }), 400, "invalid_input");
    expectError(
      await call(batchesRoute.POST, { body: { modelId: "00000000-0000-4000-8000-000000000000", quantity: 1, purchasePrice: "1" } }),
      422,
      "unknown_model",
    );
  });
});

describe("lecture", () => {
  it("liste paginée, filtre de statut, compteurs", async () => {
    const a = await newBatch({ resaleUnitPrice: "180000" });
    await newBatch({ quantity: 5 });
    await move(a.id, { to: "survey" });

    const all = await call(batchesRoute.GET, { path: "/api/backoffice/batches?pageSize=1" });
    expect(all.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(all.body.items).toHaveLength(1);

    const surveys = await call(batchesRoute.GET, { path: "/api/backoffice/batches?status=survey,preorder" });
    expect(surveys.body.items.map((b: { id: string }) => b.id)).toEqual([a.id]);
    expect(surveys.body.items[0].transitions.map((t: { to: string }) => t.to)).toEqual(["preorder", "draft", "cancelled"]);

    expectError(await call(batchesRoute.GET, { path: "/api/backoffice/batches?status=open" }), 400, "invalid_input");
    expectError(await getBatch("00000000-0000-4000-8000-000000000000"), 404, "batch_not_found");
  });

  it("compte machines payées, réservées et intérêt", async () => {
    const batchId = await createBatchInDb(catalog, { quantity: 5, status: "survey" });
    const alice = await createUser();
    const bob = await createUser();
    await wish(catalog, batchId, alice);
    // Journée de priorité terminée : Bob (sans wishlist) peut commander
    await moveBatch(batchId, "survey", "preorder", priorityOverAt());
    await pay(await placeOrder({ catalog, batchId, customer: alice, lines: [true, false] }));
    await placeOrder({ catalog, batchId, customer: bob });

    const batch = (await getBatch(batchId)).body;
    expect(batch.counters).toEqual({
      paidMachines: 2,
      pendingMachines: 1,
      orderedMachines: 3,
      availableStock: 2,
      paidOrders: 1,
      pendingOrders: 1,
      interestedMachines: 1,
      interestedUsers: 1,
      attentionOrders: 0,
      blockedUsers: 0,
    });
    expect(batch.options[0].values.find((v: { label: string }) => v.label === "Silent kit").used).toBe(1);
  });
});

describe("modification selon le statut", () => {
  it("brouillon : tout est modifiable, le nom par défaut suit quantité et modèle", async () => {
    const batch = await newBatch({ optionValues: [{ optionValueId: catalog.silentId, maxQty: 2 }] });
    const bigger = await patch(batch.id, { quantity: 12 });
    expect(bigger.body.name).toBe("12 S19");

    const other = await createCatalog("S21");
    await prisma.model.update({ where: { id: other.modelId }, data: { name: "S21" } });
    const switched = await patch(batch.id, { modelId: other.modelId });
    expect(switched.body).toMatchObject({ name: "12 S21", model: { id: other.modelId } });
    expect(switched.body.options[0].values.every((v: { maxQty: null }) => v.maxQty === null)).toBe(true);

    expectError(await patch(batch.id, { currency: "USD" }), 400, "invalid_input"); // devise unique : l'euro
    const named = await patch(batch.id, { name: "Lot Hong Kong", quantity: 8 });
    expect(named.body).toMatchObject({ name: "Lot Hong Kong", quantity: 8 });
    expect((await patch(batch.id, { quantity: 9 })).body.name).toBe("Lot Hong Kong");
    expect((await patch(batch.id, { name: null })).body.name).toBe("9 S21");
  });

  it("après publication : champs figés, valeur inchangée acceptée", async () => {
    const batch = await newBatch({ resaleUnitPrice: "180000" });
    await move(batch.id, { to: "preorder" });

    const locked = await patch(batch.id, { resaleUnitPrice: "190000", modelId: catalog.modelId });
    expectError(locked, 409, "batch_field_locked");
    expect(locked.body.error.message).toMatch(/Précommande.*Prix de revente/);

    const same = await patch(batch.id, { resaleUnitPrice: "180000", quantity: 11, name: "Renommé" });
    expect(same.body).toMatchObject({ resaleUnitPrice: "180000", quantity: 11, name: "Renommé" });

    expectError(await patch(batch.id, { optionValues: [{ optionValueId: catalog.silentId, priceOverride: "1" }] }), 409, "batch_field_locked");
    const maxQty = await patch(batch.id, { optionValues: [{ optionValueId: catalog.silentId, maxQty: 4 }] });
    expect(maxQty.body.options[0].values[1].maxQty).toBe(4);
  });

  it("quantité et max d'option jamais sous ce qui est vendu", async () => {
    const batchId = await createBatchInDb(catalog, { quantity: 3, silentMaxQty: 2 });
    const alice = await createUser();
    await pay(await placeOrder({ catalog, batchId, customer: alice, lines: [true, false] }));

    expectError(await patch(batchId, { quantity: 1 }), 409, "quantity_below_sold");
    expectError(await patch(batchId, { optionValues: [{ optionValueId: catalog.silentId, maxQty: 0 }] }), 409, "max_qty_below_sold");
    expect((await patch(batchId, { quantity: 2 })).body.counters.availableStock).toBe(0);
  });

  it("lot annulé : plus rien n'est modifiable", async () => {
    const batch = await newBatch();
    await move(batch.id, { to: "cancelled", note: "Fournisseur indisponible" });
    expectError(await patch(batch.id, { name: "x" }), 409, "batch_field_locked");
    expect((await getBatch(batch.id)).body.editableFields).toEqual([]);
  });
});

describe("modification depuis un onglet périmé (expectedUpdatedAt)", () => {
  it("updatedAt est exposé à la microseconde, identique dans la liste et le détail", async () => {
    const batch = await newBatch();
    expect(batch.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const [db] = await prisma.$queryRaw<{ iso: string }[]>`
      SELECT to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS iso FROM "Batch" WHERE "id" = ${batch.id}::uuid`;
    expect(batch.updatedAt).toBe(db.iso);
    expect((await call(batchesRoute.GET)).body.items[0].updatedAt).toBe(batch.updatedAt);
  });

  it("onglet B périmé après un enregistrement de l'onglet A : 409 batch_modified, rien n'est écrasé", async () => {
    const batch = await newBatch({ resaleUnitPrice: "52000" });
    const tabA = await patchAt(batch.id, batch.updatedAt, { resaleUnitPrice: "50000", name: "Palette A" });
    expect(tabA.status).toBe(200);
    expect(tabA.body.updatedAt).not.toBe(batch.updatedAt);

    const tabB = await patchAt(batch.id, batch.updatedAt, { quantity: 18, resaleUnitPrice: "52000", name: null });
    expectError(tabB, 409, "batch_modified");
    expect(tabB.body.error.message).toMatch(/modifié entre-temps.*Rechargez/);
    expect((await getBatch(batch.id)).body).toMatchObject({ name: "Palette A", resaleUnitPrice: "50000", quantity: 10 });

    // Après rechargement (updatedAt renvoyé par A), B enregistre
    expect((await patchAt(batch.id, tabA.body.updatedAt, { quantity: 18 })).body).toMatchObject({ quantity: 18, name: "Palette A" });
  });

  it("un changement de statut entre-temps rend l'onglet périmé", async () => {
    const batch = await newBatch({ resaleUnitPrice: "180000" });
    const moved = await move(batch.id, { to: "preorder", from: "draft" });
    expectError(await patchAt(batch.id, batch.updatedAt, { quantity: 17 }), 409, "batch_modified");
    expect((await patchAt(batch.id, moved.body.updatedAt, { quantity: 17 })).body.quantity).toBe(17);
  });

  it("deux enregistrements simultanés sur la même version : un seul passe", async () => {
    const batch = await newBatch();
    const replies = await Promise.all([
      patchAt(batch.id, batch.updatedAt, { quantity: 11 }),
      patchAt(batch.id, batch.updatedAt, { quantity: 12 }),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("accepte la même date dans un autre format ISO, refuse un horodatage absent ou mal formé", async () => {
    const batch = await newBatch();
    const asOffset = batch.updatedAt.replace("Z", "+00:00");
    expect((await patchAt(batch.id, asOffset, { quantity: 11 })).status).toBe(200);

    const fresh = (await getBatch(batch.id)).body.updatedAt;
    const missing = await call(batchRoute.PATCH, { params: { batchId: batch.id }, body: { quantity: 12 } });
    expectError(missing, 400, "invalid_input");
    expect(missing.body.error.issues.map((i: { path: string }) => i.path)).toEqual(["expectedUpdatedAt"]);
    expectError(await patchAt(batch.id, "hier", { quantity: 12 }), 400, "invalid_input");
    expectError(await patchAt(batch.id, fresh.replace("Z", "1Z"), { quantity: 12 }), 400, "invalid_input");
    // Milliseconde seulement (Date JS) : ne correspond pas, sauf si les microsecondes sont nulles
    if (!fresh.endsWith("000Z")) {
      expectError(await patchAt(batch.id, new Date(fresh).toISOString(), { quantity: 12 }), 409, "batch_modified");
    }
    expectError(await patchAt("5e1d0000-0000-4000-8000-000000000001", fresh, { quantity: 12 }), 404, "batch_not_found");
  });
});

describe("changement de statut", () => {
  it("la table du domaine est exactement celle de la base", async () => {
    const statuses = Object.keys(BATCH_STATUS_LABELS) as BatchStatus[];
    const rows = await prisma.$queryRaw<{ f: string; t: string }[]>`
      SELECT f::text, t::text
      FROM unnest(${statuses}::batch_status[]) f, unnest(${statuses}::batch_status[]) t
      WHERE "batch_transition_allowed"(f, t)`;
    const sql = rows.map((r) => `${r.f}>${r.t}`).sort();
    const domain = statuses.flatMap((f) => TRANSITIONS[f].map((t) => `${f}>${t}`)).sort();
    expect(domain).toEqual(sql);
  });

  it("publie, journalise avec l'auteur et le motif, renvoie les actions suivantes", async () => {
    const batch = await newBatch();
    const blocked = await move(batch.id, { to: "survey" });
    expectError(blocked, 409, "transition_blocked");
    expect(blocked.body.error.message).toMatch(/prix de revente/);

    await patch(batch.id, { resaleUnitPrice: "180000" });
    const published = await move(batch.id, { to: "survey", from: "draft", note: "Annonce Discord" });
    expect(published.status).toBe(201);
    expect(published.body.status).toBe("survey");
    expect(published.body.history.at(-1)).toMatchObject({ from: "draft", to: "survey", note: "Annonce Discord", changedBy: ADMIN });
    expect(published.body.transitions[0]).toMatchObject({ to: "preorder", action: "Ouvrir les précommandes", allowed: true });
    expect(await prisma.batchStatusTransition.count({ where: { batch_id: batch.id } })).toBe(2);
  });

  it("publication refusée si un menu « choix » visible propose moins de deux valeurs", async () => {
    // Menu du catalogue à une seule valeur (rempli valeur par valeur)
    const firmware = await prisma.option.create({
      data: { model_id: catalog.modelId, kind: "choice", title: "Firmware", position: 1, values: { create: { label: "Stock", is_default: true } } },
      include: { values: true },
    });
    const batch = await newBatch({ resaleUnitPrice: "180000" });
    expect(batch.transitions.find((t: { to: string }) => t.to === "survey")).toMatchObject({
      allowed: false,
      blockers: [expect.stringMatching(/^Le menu « Firmware » propose moins de deux valeurs sur ce lot/)],
    });
    for (const to of ["survey", "preorder", "ordering"] as const) {
      const blocked = await move(batch.id, { to, from: "draft" });
      expectError(blocked, 409, "transition_blocked");
      expect(blocked.body.error.message).toMatch(/« Firmware »/);
    }

    // Masquer le menu suffit (sa valeur par défaut s'applique d'office)
    await patch(batch.id, { hiddenOptions: [firmware.id] });
    expect((await move(batch.id, { to: "survey", from: "draft" })).status).toBe(201);
    await move(batch.id, { to: "draft", from: "survey", note: "Correction" });

    // Une seconde valeur au catalogue aussi ; mais retirer l'alternative sur le lot rebloque
    await prisma.optionValue.create({ data: { option_id: firmware.id, label: "Braiins", price: 1_000n, position: 1 } });
    await patch(batch.id, { hiddenOptions: [] });
    const withdrawn = await patch(batch.id, { optionValues: [{ optionValueId: catalog.silentId, enabled: false }] });
    expect(withdrawn.body.transitions[0]).toMatchObject({
      to: "survey",
      allowed: false,
      blockers: [expect.stringMatching(/« Kit de ventilation »/)],
    });
    await patch(batch.id, { optionValues: [] });
    expect((await move(batch.id, { to: "survey", from: "draft" })).status).toBe(201);
  });

  it("lot publié : retirer l'alternative ou réafficher un menu sans alternative est refusé", async () => {
    const batch = await newBatch({ resaleUnitPrice: "180000" });
    await move(batch.id, { to: "survey" });
    const withdraw = await patch(batch.id, { optionValues: [{ optionValueId: catalog.silentId, enabled: false }] });
    expectError(withdraw, 409, "menu_without_choice");
    expect(withdraw.body.error.message).toMatch(/^Le menu « Kit de ventilation » propose moins de deux valeurs sur ce lot/);
    expect(await prisma.batchOptionValue.findFirst({ where: { batch_id: batch.id, option_value_id: catalog.silentId } })).toMatchObject({
      enabled: true,
    });

    // Masquer le menu et retirer sa valeur dans la même requête : permis ; le réafficher seul : refusé
    const hidden = await patch(batch.id, {
      hiddenOptions: [catalog.optionId],
      optionValues: [{ optionValueId: catalog.silentId, enabled: false }],
    });
    expect(hidden.status).toBe(200);
    expectError(await patch(batch.id, { hiddenOptions: [] }), 409, "menu_without_choice");
  });

  it("menu Avec/Sans dont « Avec » est retiré : publication bloquée, refus sur lot publié, masqué hors règle", async () => {
    const cleaning = await prisma.option.create({
      data: {
        model_id: catalog.modelId,
        kind: "toggle",
        title: "Nettoyage",
        position: 1,
        values: {
          create: [
            { label: "Sans", is_default: true, price: 0n, position: 0 },
            { label: "Avec", price: 1_500n, position: 1 },
          ],
        },
      },
      include: { values: { orderBy: { position: "asc" } } },
    });
    const withId = cleaning.values[1].id;
    const message = /^Le menu « Nettoyage » propose moins de deux valeurs sur ce lot : .*masquez le menu\.$/;

    // Brouillon : l'enregistrement passe, la publication est bloquée (survey, preorder, ordering)
    const batch = await newBatch({ resaleUnitPrice: "180000", optionValues: [{ optionValueId: withId, enabled: false }] });
    for (const to of ["survey", "preorder", "ordering"] as const) {
      expect(batch.transitions.find((t: { to: string }) => t.to === to)).toMatchObject({
        allowed: false,
        blockers: [expect.stringMatching(message)],
      });
      const blocked = await move(batch.id, { to });
      expectError(blocked, 409, "transition_blocked");
      expect(blocked.body.error.message).toMatch(message);
    }

    // Menu masqué : hors règle
    await patch(batch.id, { hiddenOptions: [cleaning.id] });
    expect((await move(batch.id, { to: "survey" })).status).toBe(201);

    // Lot publié : réafficher le menu avec « Avec » retiré est refusé, rien n'est écrit
    const shown = await patch(batch.id, { hiddenOptions: [] });
    expectError(shown, 409, "menu_without_choice");
    expect(shown.body.error.message).toMatch(message);
    expect(await prisma.batchOption.findFirst({ where: { batch_id: batch.id, option_id: cleaning.id } })).toMatchObject({ hidden: true });

    // Rétablir « Avec » en réaffichant : permis ; le retirer ensuite : refusé
    expect((await patch(batch.id, { hiddenOptions: [], optionValues: [] })).status).toBe(200);
    expectError(await patch(batch.id, { optionValues: [{ optionValueId: withId, enabled: false }] }), 409, "menu_without_choice");
  });

  it("refuse un statut affiché périmé, un saut d'étape, un retour après précommande", async () => {
    const batch = await newBatch({ resaleUnitPrice: "180000" });
    expectError(await move(batch.id, { to: "preorder", from: "survey" }), 409, "batch_status_changed");
    // `from` obligatoire : une action sans statut affiché n'est jamais appliquée à l'aveugle
    const noFrom = await call(transitionsRoute.POST, { params: { batchId: batch.id }, body: { to: "survey" } });
    expectError(noFrom, 400, "invalid_input");
    expect(noFrom.body.error.issues).toEqual([
      { path: "from", message: "Statut de départ attendu : renvoyez le statut du lot affiché à l'écran" },
    ]);
    expectError(await move(batch.id, { to: "inspection" }), 409, "transition_not_allowed");
    await move(batch.id, { to: "preorder" });
    const back = await move(batch.id, { to: "survey" });
    expectError(back, 409, "transition_not_allowed");
    expect(back.body.error.message).toBe("Impossible de passer de « Précommande » à « Sondage ».");
  });

  it("motif obligatoire pour annuler ou revenir en arrière", async () => {
    const batch = await newBatch({ resaleUnitPrice: "180000" });
    await move(batch.id, { to: "survey" });
    expectError(await move(batch.id, { to: "draft" }), 422, "note_required");
    expectError(await move(batch.id, { to: "draft", note: "   " }), 422, "note_required");
    expect((await move(batch.id, { to: "draft", note: "Prix à revoir" })).body.status).toBe("draft");
    expectError(await move(batch.id, { to: "cancelled" }), 422, "note_required");
  });

  it("court-circuit du financement : brouillon vers Commande en cours", async () => {
    const batch = await newBatch({ resaleUnitPrice: "180000" });
    const reply = await move(batch.id, { to: "ordering" });
    expect(reply.body.status).toBe("ordering");
  });

  it("annulation impossible tant qu'une commande est payée (domaine, puis base)", async () => {
    const batchId = await createBatchInDb(catalog, { quantity: 2 });
    const alice = await createUser();
    await pay(await placeOrder({ catalog, batchId, customer: alice }));

    const reply = await move(batchId, { to: "cancelled", note: "Abandon" });
    expectError(reply, 409, "transition_blocked");
    expect(reply.body.error.message).toMatch(/1 commande payée/);

    // Même sans la garde du domaine, la base refuse (trigger BatchStatusTransition_cancel_refunded)
    const error = await failureOf(moveBatch(batchId, "preorder", "cancelled"));
    const response = toErrorResponse(error);
    expect((await response.json()).error.code).toBe("batch_has_paid_orders");
  });

  it("Contrôle exige une machine reçue", async () => {
    const batch = await newBatch({ resaleUnitPrice: "180000" });
    for (const to of ["preorder", "ordering", "awaiting_reception"] as const) {
      expect((await move(batch.id, { to })).status).toBe(201);
    }
    const blocked = await move(batch.id, { to: "inspection" });
    expectError(blocked, 409, "transition_blocked");

    await prisma.machine.create({
      data: { batch_id: batch.id, model_id: catalog.modelId, logistical_status: "in_stock", received_at: new Date() },
    });
    const inspection = await move(batch.id, { to: "inspection" });
    expect(inspection.body.status).toBe("inspection");
    // Machine non contrôlée : ni tuning ni packaging ; retour possible avec motif
    expect(inspection.body.transitions.map((t: { to: string; allowed: boolean }) => [t.to, t.allowed])).toEqual([
      ["tuning", false],
      ["packaging", false],
      ["awaiting_reception", true],
    ]);
  });

  it("deux admins sur la même action : une seule transition passe", async () => {
    const batch = await newBatch({ resaleUnitPrice: "180000" });
    const results = await Promise.all([
      move(batch.id, { to: "survey", from: "draft" }),
      move(batch.id, { to: "preorder", from: "draft" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("batch_status_changed");
    expect(await prisma.batchStatusTransition.count({ where: { batch_id: batch.id } })).toBe(2);
  });
});
