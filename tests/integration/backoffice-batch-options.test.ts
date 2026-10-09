import { beforeEach, describe, expect, it, vi } from "vitest";
import * as batchRoute from "@/app/api/backoffice/batches/[batchId]/route";
import * as offeredValuesRoute from "@/app/api/backoffice/batches/[batchId]/offered-values/route";
import * as transitionsRoute from "@/app/api/backoffice/batches/[batchId]/transitions/route";
import * as batchesRoute from "@/app/api/backoffice/batches/route";
import * as modelRoute from "@/app/api/backoffice/models/[modelId]/route";
import * as optionsRoute from "@/app/api/backoffice/models/[modelId]/options/route";
import * as valueRoute from "@/app/api/backoffice/option-values/[valueId]/route";
import * as optionRoute from "@/app/api/backoffice/options/[optionId]/route";
import * as partRoute from "@/app/api/backoffice/parts/[partId]/route";
import { writeConfiguration } from "@/server/configurations";
import type { BatchStatus } from "../../prisma/generated/enums";
import { prisma } from "./db";
import { type Catalog, createCatalog, createUser, SILENT_PRICE, wish } from "./fixtures";
import { ADMIN, call, type Reply, signIn } from "./http";

// Schéma v4 côté API : menus masqués, réglages ligne par ligne d'un lot publié, « Proposer sur
// ce lot », catalogue figé, suppressions refusées qui nomment ce qui bloque, configuration complète.

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
  catalog = await createCatalog(); // S19, « Kit de ventilation » : Sans kit (défaut), Silent kit 75 €
});

async function newBatch(body: object = {}) {
  const reply = await call(batchesRoute.POST, {
    body: { modelId: catalog.modelId, quantity: 10, purchasePrice: "1500000", resaleUnitPrice: "180000", ...body },
  });
  expect(reply.status).toBe(201);
  return reply.body;
}

const getBatch = (batchId: string) => call(batchRoute.GET, { params: { batchId } });
const patch = async (batchId: string, body: object) =>
  call(batchRoute.PATCH, { params: { batchId }, body: { expectedUpdatedAt: (await getBatch(batchId)).body.updatedAt, ...body } });
/** Transition depuis le statut courant (`from` obligatoire). */
const move = async (batchId: string, body: { to: BatchStatus; note?: string }) =>
  call(transitionsRoute.POST, { params: { batchId }, body: { from: (await getBatch(batchId)).body.status, ...body } });
const offer = (batchId: string, body: object) => call(offeredValuesRoute.POST, { params: { batchId }, body });
const patchValue = (valueId: string, body: object) => call(valueRoute.PATCH, { params: { valueId }, body });

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({ status, code });
}

/** Menu « Nettoyage » : Sans (défaut, 0), Complet (`price`). */
function createCleaning(price = 1500n) {
  return prisma.option.create({
    data: {
      model_id: catalog.modelId,
      kind: "choice",
      title: "Nettoyage",
      position: 1,
      values: {
        create: [
          { label: "Sans", is_default: true, price: 0n, position: 0 },
          { label: "Complet", price, position: 1 },
        ],
      },
    },
    include: { values: { orderBy: { position: "asc" } } },
  });
}

describe("menus masqués", () => {
  it("masqué à la création, affiché ensuite ; figé dès la précommande", async () => {
    const batch = await newBatch({ hiddenOptions: [catalog.optionId] });
    expect(batch.options[0]).toMatchObject({ id: catalog.optionId, hidden: true, wishlistChoices: 0 });
    expect(batch.editableFields).toContain("hiddenOptions");

    const shown = await patch(batch.id, { hiddenOptions: [] });
    expect(shown.body.options[0].hidden).toBe(false);
    expectError(await patch(batch.id, { hiddenOptions: ["00000000-0000-4000-8000-000000000000"] }), 422, "unknown_option");

    await move(batch.id, { to: "preorder" });
    expectError(await patch(batch.id, { hiddenOptions: [catalog.optionId] }), 409, "batch_field_locked");
  });

  it("au sondage : masquer ramène les choix des wishlists au défaut, après confirmation", async () => {
    const batch = await newBatch();
    await move(batch.id, { to: "survey" });
    await wish(catalog, batch.id, await createUser(), [{ optionId: catalog.optionId, valueId: catalog.silentId, price: SILENT_PRICE }]);
    await wish(catalog, batch.id, await createUser());
    expect((await getBatch(batch.id)).body.options[0].wishlistChoices).toBe(1);

    const refused = await patch(batch.id, { hiddenOptions: [catalog.optionId] });
    expectError(refused, 409, "hidden_menu_has_choices");
    expect(refused.body.error.message).toMatch(/1 choix/);
    expect(await prisma.configurationItem.count({ where: { option_value_id: catalog.silentId } })).toBe(1);

    const hidden = await patch(batch.id, { hiddenOptions: [catalog.optionId], confirmResetChoices: true });
    expect(hidden.body.options[0]).toMatchObject({ hidden: true, wishlistChoices: 0 });
    expect(await prisma.configurationItem.count({ where: { option_id: catalog.optionId } })).toBe(0);

    // Réafficher : chaque configuration ouverte reçoit le défaut à 0 €
    await patch(batch.id, { hiddenOptions: [] });
    const items = await prisma.configurationItem.findMany({ where: { option_id: catalog.optionId } });
    expect(items.map((i) => [i.option_value_id, i.unit_price])).toEqual([
      [catalog.noKitId, 0n],
      [catalog.noKitId, 0n],
    ]);
  });
});

describe("réglages d'un lot publié, ligne par ligne", () => {
  it("met à jour sans supprimer ; une valeur ajoutée après publication se propose d'abord", async () => {
    const batch = await newBatch({ optionValues: [{ optionValueId: catalog.silentId, priceOverride: "6000" }] });
    await move(batch.id, { to: "survey" });
    expect(await prisma.batchOptionValue.count({ where: { batch_id: batch.id } })).toBe(2); // instantané

    const reset = await patch(batch.id, { optionValues: [] });
    expect(reset.status).toBe(200);
    expect(reset.body.options[0].values[1]).toMatchObject({ availability: "offered", priceOverride: null });
    expect(await prisma.batchOptionValue.count({ where: { batch_id: batch.id } })).toBe(2);

    const airFlow = await prisma.optionValue.create({
      data: { option_id: catalog.optionId, label: "Air Flow", price: 3500n, position: 2 },
    });
    const detail = (await getBatch(batch.id)).body;
    expect(detail.options[0].values[2]).toMatchObject({ label: "Air Flow", availability: "not_offered", enabled: false, canOffer: true });
    expectError(await patch(batch.id, { optionValues: [{ optionValueId: airFlow.id, maxQty: 2 }] }), 409, "option_value_not_offered");

    const offered = await offer(batch.id, { optionValueId: airFlow.id, priceOverride: "3000", maxQty: 2 });
    expect(offered.status).toBe(201);
    expect(offered.body.options[0].values[2]).toMatchObject({ availability: "offered", effectivePrice: "3000", maxQty: 2, canOffer: false });
    expect(offered.body.updatedAt).not.toBe(detail.updatedAt);
    expectError(await offer(batch.id, { optionValueId: airFlow.id }), 409, "option_value_already_offered");
  });

  it("proposer : refusé en brouillon, sur un menu ajouté après publication, sur un lot terminé", async () => {
    const batch = await newBatch();
    expectError(await offer(batch.id, { optionValueId: catalog.silentId }), 409, "batch_draft");
    await move(batch.id, { to: "survey" });

    const late = await createCleaning();
    expectError(await offer(batch.id, { optionValueId: late.values[1].id }), 409, "option_not_applicable");
    // Le menu ajouté après publication ne s'applique pas au lot
    expect((await getBatch(batch.id)).body.options.map((o: { id: string }) => o.id)).toEqual([catalog.optionId]);

    await move(batch.id, { to: "cancelled", note: "Abandon" });
    expectError(await offer(batch.id, { optionValueId: late.values[1].id }), 409, "batch_finished");
  });
});

describe("catalogue figé par la publication", () => {
  it("prix catalogue figé tant qu'un lot publié propose la valeur : 409 qui nomme le lot", async () => {
    const batch = await newBatch({ name: "Palette A" });
    expect((await patchValue(catalog.silentId, { price: "8000" })).status).toBe(200); // brouillon : catalogue vivant
    await move(batch.id, { to: "survey" });

    const frozen = await patchValue(catalog.silentId, { price: "9000" });
    expectError(frozen, 409, "option_price_frozen");
    expect(frozen.body.error.blockers).toEqual([{ kind: "batch", id: batch.id, label: "Palette A (Sondage)" }]);
    expect(frozen.body.error.message).toMatch(/Palette A.*dérogation/);
    expect((await patchValue(catalog.silentId, { label: "Silent kit v2" })).status).toBe(200);
  });

  it("défaut payant refusé dès la création du menu", async () => {
    const reply = await call(optionsRoute.POST, {
      params: { modelId: catalog.modelId },
      body: { kind: "choice", title: "Express", values: [{ label: "Standard", price: "0" }, { label: "Express", price: "1000", isDefault: true }] },
    });
    expectError(reply, 400, "invalid_input");
    expect(reply.body.error.issues).toEqual([{ path: "values.1.price", message: "La valeur par défaut d'un menu est gratuite (0 €)" }]);
  });

  it("changement de défaut refusé s'il modifie une wishlist existante (menu masqué : défaut implicite)", async () => {
    const cleaning = await createCleaning(0n);
    const batch = await newBatch({ hiddenOptions: [cleaning.id] });
    await move(batch.id, { to: "survey" });
    await wish(catalog, batch.id, await createUser());

    expectError(await patchValue(cleaning.values[1].id, { isDefault: true }), 409, "default_change_locked");
    expect((await prisma.optionValue.findUniqueOrThrow({ where: { id: cleaning.values[0].id } })).is_default).toBe(true);
  });
});

describe("suppression refusée : ce qui bloque est nommé", () => {
  it("modèle, menu seulement masqué sur un lot, produit", async () => {
    const batch = await newBatch({ name: "Palette A", hiddenOptions: [catalog.optionId] });

    const model = await call(modelRoute.DELETE, { params: { modelId: catalog.modelId } });
    expectError(model, 409, "model_in_use");
    expect(model.body.error.blockers).toEqual([{ kind: "batch", id: batch.id, label: "Palette A (Brouillon)" }]);
    expect(model.body.error.message).toBe("Ce modèle est utilisé par 1 lot(s) : « Palette A (Brouillon) ». Il ne peut pas être supprimé.");

    const option = await call(optionRoute.DELETE, { params: { optionId: catalog.optionId } });
    expectError(option, 409, "option_in_use");
    expect(option.body.error.blockers.map((b: { id: string }) => b.id)).toEqual([batch.id]);

    const part = await prisma.part.create({ data: { name: "Kit silencieux" } });
    await prisma.optionValuePart.create({ data: { option_value_id: catalog.silentId, part_id: part.id } });
    await prisma.partStockMovement.create({ data: { part_id: part.id, kind: "reception", qty: 5, created_by_auth_user_id: 1n } });
    const del = await call(partRoute.DELETE, { params: { partId: part.id } });
    expectError(del, 409, "part_in_use");
    expect(del.body.error.blockers).toEqual([
      { kind: "option_value", id: catalog.silentId, label: "S19 › Kit de ventilation › Silent kit" },
      { kind: "stock_movement", id: part.id, label: "1 mouvement(s) de stock" },
    ]);
  });
});

describe("liste", () => {
  it("compteurs de lots par statut, sans le filtre de statut", async () => {
    const a = await newBatch();
    await newBatch();
    await move(a.id, { to: "survey" });
    const list = await call(batchesRoute.GET, { path: "/api/backoffice/batches?status=survey" });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.statusCounts).toMatchObject({ draft: 1, survey: 1, preorder: 0, cancelled: 0 });
    expect(Object.keys(list.body.statusCounts)).toHaveLength(11);
  });
});

describe("configuration complète (writeConfiguration)", () => {
  it("un item par menu visible, prix relus en base ; menu masqué sans item ; menu vide ignoré", async () => {
    const cleaning = await createCleaning();
    await prisma.option.create({ data: { model_id: catalog.modelId, kind: "choice", title: "Vide", position: 2 } });
    const batch = await newBatch({
      optionValues: [{ optionValueId: catalog.silentId, priceOverride: "6000" }],
      hiddenOptions: [cleaning.id],
    });
    await move(batch.id, { to: "survey" });

    const write = (choices: { optionId: string; optionValueId: string }[]) =>
      prisma.$transaction((tx) => writeConfiguration(tx, batch.id, choices));

    const silent = await write([{ optionId: catalog.optionId, optionValueId: catalog.silentId }]);
    expect(silent.amount).toBe(186_000n);
    const items = await prisma.configurationItem.findMany({ where: { configuration_id: silent.id } });
    expect(items.map((i) => [i.option_id, i.option_value_id, i.unit_price])).toEqual([[catalog.optionId, catalog.silentId, 6000n]]);

    const plain = await write([]);
    expect(plain.amount).toBe(180_000n);
    expect(await prisma.configurationItem.findMany({ where: { configuration_id: plain.id }, select: { option_value_id: true } })).toEqual([
      { option_value_id: catalog.noKitId },
    ]);

    await expect(write([{ optionId: cleaning.id, optionValueId: cleaning.values[1].id }])).rejects.toMatchObject({
      code: "option_not_offered",
    });
  });
});
