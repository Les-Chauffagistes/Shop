import { beforeEach, describe, expect, it, vi } from "vitest";
import * as boBatchRoute from "@/app/api/backoffice/batches/[batchId]/route";
import * as boTransitionsRoute from "@/app/api/backoffice/batches/[batchId]/transitions/route";
import * as shopBatchRoute from "@/app/api/shop/batches/[batchId]/route";
import * as shopBatchesRoute from "@/app/api/shop/batches/route";
import * as wishlistRoute from "@/app/api/wishlists/[wishlistId]/route";
import * as wishlistsRoute from "@/app/api/wishlists/route";
import type { BatchStatus } from "../../prisma/generated/enums";
import { prisma } from "./db";
import { randomUUID } from "node:crypto";
import { pgFailureOf } from "@/server/errors";
import {
  ADMIN_AUTH_USER_ID,
  type Catalog,
  createBatch,
  createCatalog,
  createConfiguration,
  EXPECTED_SATS,
  failureOf,
  moveBatch,
  pay,
  RESALE,
  untilAnotherSessionWaitsOnLock,
  writeFullRefund,
  writePayment,
} from "./fixtures";
import { ADMIN, call, type Reply, SAME_ORIGIN, signIn } from "./http";

// Jalon 3 : boutique publique (lots au sondage) et manifestations d'intérêt (wishlists).

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

const ALICE = "2001";
const BOB = "2002";

function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.body?.error?.code }).toEqual({
    status,
    code,
  });
}

const as = async (authUserId: string | null) => {
  cookieJar.clear();
  if (authUserId) await signIn(cookieJar, authUserId);
};

const wishFor = (body: object) => call(wishlistsRoute.POST, { body, headers: SAME_ORIGIN });
const patchWish = (wishlistId: string, body: object) =>
  call(wishlistRoute.PATCH, {
    params: { wishlistId },
    body,
    method: "PATCH",
    headers: SAME_ORIGIN,
  });
const getWish = (wishlistId: string) => call(wishlistRoute.GET, { params: { wishlistId } });
const deleteWish = (wishlistId: string) =>
  call(wishlistRoute.DELETE, {
    params: { wishlistId },
    method: "DELETE",
    headers: SAME_ORIGIN,
  });
const listWishes = (batchId?: string) =>
  call(wishlistsRoute.GET, {
    path: batchId ? `/api/wishlists?batchId=${batchId}` : "/api/wishlists",
  });

type Setup = Catalog & {
  batchId: string;
  airFlowId: string;
  cleaningId: string;
  cleaningNoId: string;
  cleaningFullId: string;
  firmwareId: string;
  firmwareCustomId: string;
};

/**
 * Lot de 10 S19 au sondage, revente 500 € :
 * - Kit de ventilation : Sans kit (défaut), Silent kit 75 € dérogé à 60 € et limité à 3, Air Flow retiré du lot ;
 * - Nettoyage : Sans (défaut), Complet 15 € ;
 * - Firmware : masqué sur le lot.
 */
async function setup(status: BatchStatus = "survey"): Promise<Setup> {
  const catalog = await createCatalog();
  const airFlow = await prisma.optionValue.create({
    data: {
      option_id: catalog.optionId,
      label: "Air Flow",
      price: 3_500n,
      position: 2,
    },
  });
  const cleaning = await prisma.option.create({
    data: {
      model_id: catalog.modelId,
      kind: "choice",
      title: "Nettoyage",
      position: 1,
      values: {
        create: [
          { label: "Sans", is_default: true, price: 0n, position: 0 },
          { label: "Complet", price: 1_500n, position: 1 },
        ],
      },
    },
    include: { values: { orderBy: { position: "asc" } } },
  });
  const firmware = await prisma.option.create({
    data: {
      model_id: catalog.modelId,
      kind: "choice",
      title: "Firmware",
      position: 2,
      values: {
        create: [
          { label: "Stock", is_default: true, price: 0n, position: 0 },
          { label: "Custom", price: 2_000n, position: 1 },
        ],
      },
    },
    include: { values: { orderBy: { position: "asc" } } },
  });
  const batchId = await createBatch(catalog, { quantity: 10, status: "draft" });
  await prisma.batchOptionValue.createMany({
    data: [
      {
        batch_id: batchId,
        model_id: catalog.modelId,
        option_id: catalog.optionId,
        option_value_id: catalog.silentId,
        price_override: 6_000n,
        max_qty: 3,
      },
      {
        batch_id: batchId,
        model_id: catalog.modelId,
        option_id: catalog.optionId,
        option_value_id: airFlow.id,
        enabled: false,
      },
    ],
  });
  await prisma.batchOption.create({
    data: {
      batch_id: batchId,
      model_id: catalog.modelId,
      option_id: firmware.id,
      hidden: true,
    },
  });
  if (status !== "draft") await moveBatch(batchId, "draft", "survey");
  if (status === "preorder") await moveBatch(batchId, "survey", "preorder");
  return {
    ...catalog,
    batchId,
    airFlowId: airFlow.id,
    cleaningId: cleaning.id,
    cleaningNoId: cleaning.values[0].id,
    cleaningFullId: cleaning.values[1].id,
    firmwareId: firmware.id,
    firmwareCustomId: firmware.values[1].id,
  };
}

let s: Setup;

beforeEach(async () => {
  cookieJar.clear();
  s = await setup();
});

describe("boutique publique", () => {
  it("liste sans connexion les lots publics (sondage, Précommande à Packaging), sans donnée interne", async () => {
    const draftCatalog = await createCatalog("S21");
    await createBatch(draftCatalog, { quantity: 4, status: "draft" });
    const preorderId = await createBatch(draftCatalog, { quantity: 5, status: "preorder" });
    const inTransitId = await createBatch(draftCatalog, { quantity: 6, status: "inspection" });
    await moveBatch(inTransitId, "inspection", "packaging");
    await moveBatch(inTransitId, "packaging", "in_transit");

    const reply = await call(shopBatchesRoute.GET);
    expect(reply.status).toBe(200);
    expect(reply.body.items.map((b: { id: string }) => b.id).sort()).toEqual([s.batchId, preorderId].sort());
    expect(reply.body.items.find((b: { id: string }) => b.id === preorderId)).toMatchObject({
      status: "preorder",
      acceptsOrders: true,
      priorityEndsAt: null,
      availableQuantity: 5,
    });
    expect(reply.body.items.filter((b: { id: string }) => b.id === s.batchId)).toEqual([
      {
        id: s.batchId,
        name: "10 S19",
        status: "survey",
        statusLabel: "Sondage",
        model: {
          id: s.modelId,
          name: "S19",
          hashrate: "95000000000000",
          description: null,
        },
        availableQuantity: 10,
        resaleUnitPrice: RESALE.toString(),
        acceptsOrders: false,
        priorityEndsAt: null,
      },
    ]);
    const text = JSON.stringify(reply.body);
    for (const internal of ["purchasePrice", "counters", "quantity", "interest", "history", "wishlistLimit"])
      expect(text).not.toContain(internal);
  });

  it("fiche produit : nom du lot, plafond de wishlists, menus visibles, valeurs proposées au prix du lot, quantité max", async () => {
    await prisma.batch.update({
      where: { id: s.batchId },
      data: { name: "Palette Bitmain" },
    });
    const reply = await call(shopBatchRoute.GET, {
      params: { batchId: s.batchId },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      name: "Palette Bitmain",
      wishlistLimit: 5,
      availableQuantity: 10,
    });
    expect(reply.body.options).toEqual([
      {
        id: s.optionId,
        kind: "choice",
        title: "Kit de ventilation",
        description: null,
        position: 0,
        values: [
          {
            id: s.noKitId,
            label: "Sans kit",
            isDefault: true,
            position: 0,
            price: "0",
            maxQty: null,
          },
          {
            id: s.silentId,
            label: "Silent kit",
            isDefault: false,
            position: 1,
            price: "6000",
            maxQty: 3,
          },
        ],
      },
      {
        id: s.cleaningId,
        kind: "choice",
        title: "Nettoyage",
        description: null,
        position: 1,
        values: [
          {
            id: s.cleaningNoId,
            label: "Sans",
            isDefault: true,
            position: 0,
            price: "0",
            maxQty: null,
          },
          {
            id: s.cleaningFullId,
            label: "Complet",
            isDefault: false,
            position: 1,
            price: "1500",
            maxQty: null,
          },
        ],
      },
    ]);
    expect(JSON.stringify(reply.body)).not.toContain("purchasePrice");
  });

  it("plafond de wishlists affiché : jamais plus que la quantité du lot", async () => {
    const other = await createCatalog("S21");
    const smallId = await createBatch(other, { quantity: 2, status: "survey" });
    const reply = await call(shopBatchRoute.GET, {
      params: { batchId: smallId },
    });
    expect(reply.body).toMatchObject({ name: "2 S19", wishlistLimit: 2 });
  });

  it("lot en brouillon, en transit, inconnu ou identifiant mal formé : 404", async () => {
    const other = await createCatalog("S21");
    const draftId = await createBatch(other, { quantity: 3, status: "draft" });
    const inTransitId = await createBatch(other, { quantity: 3, status: "inspection" });
    await moveBatch(inTransitId, "inspection", "packaging");
    await moveBatch(inTransitId, "packaging", "in_transit");
    for (const batchId of [draftId, inTransitId, "00000000-0000-4000-8000-000000000000", "pas-un-uuid"]) {
      expectError(await call(shopBatchRoute.GET, { params: { batchId } }), 404, "batch_not_found");
    }
  });
});

describe("wishlist : création", () => {
  it("exige d'être connecté", async () => {
    expectError(await wishFor({ batchId: s.batchId }), 401, "unauthenticated");
    expectError(await listWishes(), 401, "unauthenticated");
  });

  it("refuse une écriture cross-site", async () => {
    await as(ALICE);
    const reply = await call(wishlistsRoute.POST, {
      body: { batchId: s.batchId },
      headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
    });
    expectError(reply, 403, "cross_origin");
  });

  it("configuration complète : un item par menu visible, défaut à 0 €, prix relus en base", async () => {
    await as(ALICE);
    const reply = await wishFor({
      batchId: s.batchId,
      choices: [{ optionId: s.optionId, optionValueId: s.silentId }],
    });
    expect(reply.status).toBe(201);
    expect(reply.body.items).toHaveLength(1);
    const w = reply.body.items[0];
    expect(w).toMatchObject({
      batch: {
        id: s.batchId,
        name: "10 S19",
        status: "survey",
        statusLabel: "Sondage",
        model: { id: s.modelId, name: "S19" },
      },
      basePrice: "50000",
      amount: "56000",
      converted: false,
      editable: true,
    });
    expect(w.items).toEqual([
      {
        optionId: s.optionId,
        optionTitle: "Kit de ventilation",
        optionValueId: s.silentId,
        label: "Silent kit",
        isDefault: false,
        unitPrice: "6000",
        offered: true,
      },
      {
        optionId: s.cleaningId,
        optionTitle: "Nettoyage",
        optionValueId: s.cleaningNoId,
        label: "Sans",
        isDefault: true,
        unitPrice: "0",
        offered: true,
      },
    ]);
    expect(w).toMatchObject({ outdated: false, orderId: null, batch: { acceptsOrders: false } });
    // L'utilisateur local est créé à la première utilisation
    expect(await prisma.user.count({ where: { auth_user_id: BigInt(ALICE) } })).toBe(1);
  });

  it("plusieurs machines : une wishlist et une configuration par machine", async () => {
    await as(ALICE);
    const reply = await wishFor({ batchId: s.batchId, quantity: 3 });
    expect(reply.status).toBe(201);
    expect(reply.body.items).toHaveLength(3);
    const configs = await prisma.wishlist.findMany({
      where: { batch_id: s.batchId },
      select: { configuration_id: true },
    });
    expect(new Set(configs.map((c) => c.configuration_id)).size).toBe(3);
  });

  it("refuse une option masquée, retirée, d'un autre menu, ou un prix envoyé par le client", async () => {
    await as(ALICE);
    const choose = (optionId: string, optionValueId: string) =>
      wishFor({ batchId: s.batchId, choices: [{ optionId, optionValueId }] });
    expectError(await choose(s.firmwareId, s.firmwareCustomId), 422, "option_not_offered");
    expectError(await choose(s.optionId, s.airFlowId), 422, "option_not_offered");
    expectError(await choose(s.optionId, s.cleaningFullId), 422, "option_not_offered");
    expectError(await wishFor({ batchId: s.batchId, amount: "1" }), 400, "invalid_input");
    expect(await prisma.wishlist.count()).toBe(0);
  });

  it("nomme l'option qui n'est plus proposée (menu masqué, valeur retirée), sans prix", async () => {
    await as(ALICE);
    const hidden = await wishFor({
      batchId: s.batchId,
      choices: [{ optionId: s.firmwareId, optionValueId: s.firmwareCustomId }],
    });
    expect(hidden.body.error.message).toBe("L'option « Firmware : Custom » n'est plus proposée sur ce lot.");
    const removed = await wishFor({
      batchId: s.batchId,
      choices: [{ optionId: s.optionId, optionValueId: s.airFlowId }],
    });
    expect(removed.body.error.message).toBe(
      "L'option « Kit de ventilation : Air Flow » n'est plus proposée sur ce lot.",
    );
    const both = await wishFor({
      batchId: s.batchId,
      choices: [
        { optionId: s.firmwareId, optionValueId: s.firmwareCustomId },
        { optionId: s.optionId, optionValueId: s.airFlowId },
      ],
    });
    expect(both.body.error.message).toBe(
      "Les options « Firmware : Custom », « Kit de ventilation : Air Flow » ne sont plus proposées sur ce lot.",
    );
    // Identifiants inconnus : message générique, rien d'inventé
    const unknown = await wishFor({
      batchId: s.batchId,
      choices: [
        {
          optionId: "00000000-0000-4000-8000-000000000001",
          optionValueId: "00000000-0000-4000-8000-000000000002",
        },
      ],
    });
    expect(unknown.body.error.message).toBe("Une des options choisies n'est plus proposée sur ce lot.");
    expect(JSON.stringify([hidden.body, removed.body])).not.toMatch(/2000|3500/);
  });

  it("messages de validation en français, y compris ceux de Zod", async () => {
    await as(ALICE);
    const messages = (reply: Reply) => reply.body.error.issues.map((i: { message: string }) => i.message).join(" | ");
    expect(messages(await wishFor({ batchId: "pas-un-uuid" }))).toBe("UUID invalide");
    expect(messages(await wishFor({}))).toMatch(/chaîne de caractères attendu, indéfini reçu/);
    const notObject = await wishFor([]);
    expect(messages(notObject)).toBe("Entrée invalide : objet attendu, tableau reçu");
    for (const reply of [notObject, await wishFor({ batchId: "x", quantity: 0 })]) {
      expect(JSON.stringify(reply.body)).not.toMatch(/Invalid|expected|received/);
    }
  });

  it("lot hors sondage refusé, brouillon invisible", async () => {
    await as(ALICE);
    const other = await createCatalog("S21");
    const preorderId = await createBatch(other, {
      quantity: 3,
      status: "preorder",
    });
    const draftId = await createBatch(other, { quantity: 3, status: "draft" });
    expectError(await wishFor({ batchId: preorderId }), 409, "wishlist_closed");
    expectError(await wishFor({ batchId: draftId }), 404, "batch_not_found");
    expectError(await wishFor({ batchId: "00000000-0000-4000-8000-000000000000" }), 404, "batch_not_found");
  });

  it("plafond par utilisateur et par lot (5 par défaut), compté par utilisateur", async () => {
    await as(ALICE);
    expect((await wishFor({ batchId: s.batchId, quantity: 4 })).status).toBe(201);
    expectError(await wishFor({ batchId: s.batchId, quantity: 2 }), 409, "wishlist_limit_reached");
    expect((await wishFor({ batchId: s.batchId })).status).toBe(201);
    expectError(await wishFor({ batchId: s.batchId }), 409, "wishlist_limit_reached");
    await as(BOB);
    expect((await wishFor({ batchId: s.batchId, quantity: 5 })).status).toBe(201);
  });

  it("plafond borné par la quantité du lot, sûr en concurrence", async () => {
    const other = await createCatalog("S21");
    const smallId = await createBatch(other, { quantity: 2, status: "survey" });
    await as(ALICE);
    const replies = await Promise.all(Array.from({ length: 6 }, () => wishFor({ batchId: smallId })));
    expect(replies.filter((r) => r.status === 201)).toHaveLength(2);
    for (const r of replies.filter((r) => r.status !== 201)) expectError(r, 409, "wishlist_limit_reached");
    expect(await prisma.wishlist.count({ where: { batch_id: smallId } })).toBe(2);
  });
});

async function aliceWish(choices: object[] = []) {
  await as(ALICE);
  const reply = await wishFor({ batchId: s.batchId, choices });
  expect(reply.status).toBe(201);
  return reply.body.items[0].id as string;
}

/** Facture en attente d'Alice (lot en précommande) dont l'unique ligne reprend la wishlist. */
async function pendingOrderFor(wishlistId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { auth_user_id: BigInt(ALICE) },
  });
  const address = await prisma.address.create({
    data: {
      user_id: user.id,
      full_name: "Alice",
      line1: "1 rue",
      postal_code: "69001",
      city: "Lyon",
      country: "FR",
    },
  });
  return prisma.$transaction(async (tx) => {
    const configuration = await createConfiguration(tx, s, s.batchId);
    const order = await tx.order.create({
      data: {
        user_id: user.id,
        batch_id: s.batchId,
        billing_address_id: address.id,
        shipping_address_id: address.id,
        total_amount: configuration.amount,
        expected_sats: EXPECTED_SATS,
        payment_address: `bc1q${randomUUID().replaceAll("-", "")}`,
      },
    });
    await tx.orderLine.create({
      data: {
        order_id: order.id,
        user_id: user.id,
        batch_id: s.batchId,
        configuration_id: configuration.id,
        wishlist_id: wishlistId,
        amount: configuration.amount,
      },
    });
    return order.id;
  });
}

/** Wishlist d'Alice convertie : lot en précommande, facture payée. */
async function convertedWish() {
  const id = await aliceWish();
  await moveBatch(s.batchId, "survey", "preorder");
  const orderId = await pendingOrderFor(id);
  await pay(orderId);
  return { id, orderId };
}

const CONVERTED_MESSAGE =
  "Cette manifestation d'intérêt est devenue une commande payée : elle ne peut plus être retirée. Pour y renoncer, utilisez « Renoncer » sur la commande (tant que le lot est en précommande), sinon contactez-nous.";

/** Attend qu'une autre session de la base soit bloquée sur un verrou (la requête concurrente est en attente). */
describe("wishlist : lecture, modification, retrait", () => {
  it("un utilisateur ne voit ni ne modifie jamais la wishlist d'un autre", async () => {
    const id = await aliceWish();
    await as(BOB);
    expectError(await getWish(id), 404, "wishlist_not_found");
    expectError(await patchWish(id, { choices: [] }), 404, "wishlist_not_found");
    expectError(await deleteWish(id), 404, "wishlist_not_found");
    expect((await listWishes()).body.items).toEqual([]);
    expect((await listWishes(s.batchId)).body.items).toEqual([]);
    await as(ALICE);
    expect((await getWish(id)).status).toBe(200);
    expect((await listWishes(s.batchId)).body.items.map((w: { id: string }) => w.id)).toEqual([id]);
  });

  it("lecture : la wishlist et les options proposées pour la modifier", async () => {
    const id = await aliceWish();
    const reply = await getWish(id);
    expect(reply.status).toBe(200);
    expect(reply.body.options.map((o: { id: string }) => o.id)).toEqual([s.optionId, s.cleaningId]);
  });

  it("machine commandée : numéro de la facture ; lot ouvert aux commandes (acceptsOrders)", async () => {
    const { id, orderId } = await convertedWish();
    const expected = { converted: true, orderId, editable: false, batch: { status: "preorder", acceptsOrders: true } };
    expect((await getWish(id)).body).toMatchObject(expected);
    expect((await listWishes()).body.items[0]).toMatchObject(expected);
  });

  it("lot au sondage : pas de commande possible (acceptsOrders faux), pas de facture (orderId null)", async () => {
    const id = await aliceWish();
    expect((await getWish(id)).body).toMatchObject({ converted: false, orderId: null, batch: { status: "survey", acceptsOrders: false } });
  });

  it("option retirée du lot depuis la configuration : le choix est marqué « non proposé » (prix périmé), lecture et liste", async () => {
    const id = await aliceWish([{ optionId: s.optionId, optionValueId: s.silentId }]);
    expect((await getWish(id)).body).toMatchObject({ outdated: false });
    await prisma.batchOptionValue.updateMany({ where: { batch_id: s.batchId, option_value_id: s.silentId }, data: { enabled: false } });

    for (const w of [(await getWish(id)).body, (await listWishes()).body.items[0]]) {
      expect(w.outdated).toBe(true);
      expect(w.items.map((i: { label: string; offered: boolean }) => [i.label, i.offered])).toEqual([
        ["Silent kit", false],
        ["Sans", true],
      ]);
    }
    // Précommande : la configuration est figée, l'avertissement reste (la commande de cette machine serait refusée)
    await moveBatch(s.batchId, "survey", "preorder");
    expect((await getWish(id)).body).toMatchObject({ outdated: true, editable: false });
  });

  it("modifie la configuration : nouvel instantané, prix relus en base", async () => {
    const id = await aliceWish([{ optionId: s.optionId, optionValueId: s.silentId }]);
    // L'admin change le prix de revente pendant le sondage
    await prisma.batch.update({
      where: { id: s.batchId },
      data: { resale_unit_price: 52_000n },
    });
    const reply = await patchWish(id, {
      choices: [{ optionId: s.cleaningId, optionValueId: s.cleaningFullId }],
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ basePrice: "52000", amount: "53500" });
    expect(reply.body.items.map((i: { optionValueId: string }) => i.optionValueId)).toEqual([
      s.noKitId,
      s.cleaningFullId,
    ]);
    expectError(
      await patchWish(id, {
        choices: [{ optionId: s.firmwareId, optionValueId: s.firmwareCustomId }],
      }),
      422,
      "option_not_offered",
    );
  });

  it("lecture et liste : prix de revente actuel du lot à côté de l'instantané, au sondage seulement", async () => {
    const id = await aliceWish([{ optionId: s.optionId, optionValueId: s.silentId }]);
    await prisma.batch.update({
      where: { id: s.batchId },
      data: { resale_unit_price: 52_000n },
    });
    const reply = await getWish(id);
    expect(reply.body).toMatchObject({
      basePrice: "50000",
      amount: "56000",
      resaleUnitPrice: "52000",
      editable: true,
    });
    // Liste : prix actuel à côté de l'instantané (avertissement « le prix a changé »), sans l'offre du lot
    const listed = (await listWishes()).body.items[0];
    expect(listed).toMatchObject({
      basePrice: "50000",
      amount: "56000",
      resaleUnitPrice: "52000",
      editable: true,
    });
    expect(listed).not.toHaveProperty("options");
    await moveBatch(s.batchId, "survey", "preorder");
    expect((await getWish(id)).body).toMatchObject({
      resaleUnitPrice: null,
      options: null,
      editable: false,
    });
    // Configuration figée : le prix actuel du lot n'a plus de sens, la liste suit
    expect((await listWishes()).body.items[0]).toMatchObject({
      basePrice: "50000",
      resaleUnitPrice: null,
      editable: false,
    });
  });

  it("configuration figée dès la précommande, retrait toujours possible", async () => {
    const id = await aliceWish([{ optionId: s.optionId, optionValueId: s.silentId }]);
    await moveBatch(s.batchId, "survey", "preorder");
    const refused = await patchWish(id, { choices: [] });
    expectError(refused, 409, "wishlist_not_editable");
    expect(refused.body.error.message).toBe(
      "Le sondage de ce lot est terminé (statut « Précommande ») : la configuration de votre manifestation d'intérêt ne se modifie plus. Vous pouvez encore la retirer.",
    );
    const read = await getWish(id);
    expect(read.body).toMatchObject({
      editable: false,
      options: null,
      amount: "56000",
      batch: { status: "preorder" },
    });
    expect((await listWishes()).body.items[0]).toMatchObject({
      id,
      editable: false,
    });
    // Création toujours refusée hors sondage
    expectError(await wishFor({ batchId: s.batchId }), 409, "wishlist_closed");

    await prisma.batchStatusTransition.create({
      data: {
        batch_id: s.batchId,
        from_status: "preorder",
        to_status: "cancelled",
        note: "test",
        changed_by_auth_user_id: 1n,
      },
    });
    expectError(await patchWish(id, { choices: [] }), 409, "wishlist_not_editable");
    expect((await getWish(id)).body).toMatchObject({
      editable: false,
      options: null,
      batch: { status: "cancelled" },
    });
    expect((await deleteWish(id)).status).toBe(204);
  });

  it("une wishlist convertie en commande payée ne se modifie plus", async () => {
    const id = await aliceWish();
    await moveBatch(s.batchId, "survey", "preorder");
    const orderId = await pendingOrderFor(id);
    // Facture en attente : pas encore convertie, mais figée par la précommande
    expectError(await patchWish(id, { choices: [] }), 409, "wishlist_not_editable");
    await pay(orderId);
    expectError(await patchWish(id, { choices: [] }), 409, "wishlist_converted");
    expect((await getWish(id)).body).toMatchObject({
      converted: true,
      editable: false,
      options: null,
    });
  });

  it("retrait : idempotent, la wishlist disparaît, possible hors sondage", async () => {
    const id = await aliceWish();
    const second = await aliceWish();
    expect((await deleteWish(id)).status).toBe(204);
    expect((await deleteWish(id)).status).toBe(204);
    expectError(await getWish(id), 404, "wishlist_not_found");
    expectError(await patchWish(id, { choices: [] }), 404, "wishlist_not_found");
    expect((await listWishes()).body.items.map((w: { id: string }) => w.id)).toEqual([second]);

    await moveBatch(s.batchId, "survey", "preorder");
    expect((await deleteWish(second)).status).toBe(204);
    expect(await prisma.wishlist.count({ where: { cancelled_at: null } })).toBe(0);
  });

  it("nom du lot dans l'objet Wishlist (liste, lecture), à jour s'il est renommé", async () => {
    const id = await aliceWish();
    await prisma.batch.update({
      where: { id: s.batchId },
      data: { name: "Palette Bitmain" },
    });
    expect((await listWishes()).body.items[0].batch).toMatchObject({
      id: s.batchId,
      name: "Palette Bitmain",
    });
    expect((await getWish(id)).body.batch.name).toBe("Palette Bitmain");
  });

  it("un retrait libère une place sous le plafond", async () => {
    await as(ALICE);
    const created = await wishFor({ batchId: s.batchId, quantity: 5 });
    expectError(await wishFor({ batchId: s.batchId }), 409, "wishlist_limit_reached");
    expect((await deleteWish(created.body.items[0].id)).status).toBe(204);
    expect((await wishFor({ batchId: s.batchId })).status).toBe(201);
  });
});

describe("wishlist : retrait d'une wishlist convertie", () => {
  it("refusé (409 wishlist_converted), la wishlist reste ; 404 d'abord pour un autre utilisateur", async () => {
    const { id } = await convertedWish();
    const refused = await deleteWish(id);
    expectError(refused, 409, "wishlist_converted");
    expect(refused.body.error.message).toBe(CONVERTED_MESSAGE);
    expect((await listWishes()).body.items).toMatchObject([{ id, converted: true }]);
    expect((await prisma.wishlist.findUniqueOrThrow({ where: { id } })).cancelled_at).toBeNull();
    await as(BOB);
    expectError(await deleteWish(id), 404, "wishlist_not_found");
  });

  it("facture seulement en attente : pas convertie, retrait permis (204)", async () => {
    const id = await aliceWish();
    await moveBatch(s.batchId, "survey", "preorder");
    await pendingOrderFor(id);
    expect((await deleteWish(id)).status).toBe(204);
    expect((await deleteWish(id)).status).toBe(204);
  });

  it("ligne remboursée (commande annulée) : plus convertie, retrait permis", async () => {
    const { id, orderId } = await convertedWish();
    await prisma.$transaction((tx) => writeFullRefund(tx, orderId));
    expect((await deleteWish(id)).status).toBe(204);
  });

  it("refusé aussi par la base (Wishlist_converted), hors application", async () => {
    const { id } = await convertedWish();
    const error = await failureOf(
      prisma.wishlist.update({
        where: { id },
        data: { cancelled_at: new Date() },
      }),
    );
    expect(pgFailureOf(error)?.constraint).toBe("Wishlist_converted");
  });

  it("concurrence : un retrait pendant la conversion attend son COMMIT puis est refusé", async () => {
    const id = await aliceWish();
    await moveBatch(s.batchId, "survey", "preorder");
    const orderId = await pendingOrderFor(id);
    let deleting: Promise<Reply> | undefined;
    await prisma.$transaction(async (tx) => {
      await writePayment(tx, orderId);
      // Contrôles différés tout de suite : Order_check prend le verrou du lot, tenu jusqu'au COMMIT
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      deleting = deleteWish(id);
      await untilAnotherSessionWaitsOnLock();
    });
    expectError(await deleting!, 409, "wishlist_converted");
    expect((await prisma.wishlist.findUniqueOrThrow({ where: { id } })).cancelled_at).toBeNull();
  });

  it("concurrence, base seule : le trigger attend la conversion puis refuse", async () => {
    const id = await aliceWish();
    await moveBatch(s.batchId, "survey", "preorder");
    const orderId = await pendingOrderFor(id);
    let cancelling: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await writePayment(tx, orderId);
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      cancelling = failureOf(
        prisma.wishlist.update({
          where: { id },
          data: { cancelled_at: new Date() },
        }),
      );
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await cancelling!)?.constraint).toBe("Wishlist_converted");
  });

  it("concurrence : retrait validé avant le paiement, le paiement attend puis reste accepté", async () => {
    const id = await aliceWish();
    await moveBatch(s.batchId, "survey", "preorder");
    const orderId = await pendingOrderFor(id);
    let paying: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.wishlist.update({
        where: { id },
        data: { cancelled_at: new Date() },
      }); // verrou partagé du lot
      paying = pay(orderId);
      await untilAnotherSessionWaitsOnLock();
    });
    await paying;
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("paid");
    expect((await prisma.wishlist.findUniqueOrThrow({ where: { id } })).cancelled_at).not.toBeNull();
  });

  it("concurrence : retraits simultanés d'une même wishlist, tous 204, un seul horodatage", async () => {
    const id = await aliceWish();
    const replies = await Promise.all(Array.from({ length: 5 }, () => deleteWish(id)));
    expect(replies.map((r) => r.status)).toEqual([204, 204, 204, 204, 204]);
    expect(
      await prisma.wishlist.count({
        where: { id, cancelled_at: { not: null } },
      }),
    ).toBe(1);
  });
});

describe("wishlist : concurrence avec le changement de statut du lot", () => {
  /** Transition du lot en cours (verrou du lot tenu jusqu'au COMMIT) pendant laquelle `request` démarre. */
  async function duringTransition<T>(to: "preorder" | "draft", request: () => Promise<T>): Promise<T> {
    let pending: Promise<T> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.batchStatusTransition.create({
        data: {
          batch_id: s.batchId,
          from_status: "survey",
          to_status: to,
          changed_by_auth_user_id: ADMIN_AUTH_USER_ID,
        },
      });
      pending = request();
      await untilAnotherSessionWaitsOnLock();
    });
    return pending!;
  }

  const itemsOf = async (wishlistId: string) =>
    (
      await prisma.wishlist.findUniqueOrThrow({
        where: { id: wishlistId },
        include: { configuration: { include: { items: true } } },
      })
    ).configuration.items;

  it("création en attente d'un passage en précommande : refusée une fois le statut validé, rien d'écrit", async () => {
    await as(ALICE);
    const reply = await duringTransition("preorder", () => wishFor({ batchId: s.batchId }));
    expectError(reply, 409, "wishlist_closed");
    expect(await prisma.wishlist.count()).toBe(0);
    expect(await prisma.configuration.count({ where: { batch_id: s.batchId } })).toBe(0);
  });

  it("création en attente d'une dépublication : le lot redevient invisible (404)", async () => {
    await as(ALICE);
    expectError(await duringTransition("draft", () => wishFor({ batchId: s.batchId })), 404, "batch_not_found");
    expect(await prisma.wishlist.count()).toBe(0);
  });

  it("modification en attente d'un passage en précommande : refusée, configuration inchangée", async () => {
    const id = await aliceWish([{ optionId: s.optionId, optionValueId: s.silentId }]);
    const reply = await duringTransition("preorder", () =>
      patchWish(id, {
        choices: [{ optionId: s.cleaningId, optionValueId: s.cleaningFullId }],
      }),
    );
    expectError(reply, 409, "wishlist_not_editable");
    const items = await itemsOf(id);
    expect(items.map((i) => i.option_value_id).sort()).toEqual([s.silentId, s.cleaningNoId].sort());
  });

  it("retrait en attente d'un passage en précommande : accepté (le retrait reste possible)", async () => {
    const id = await aliceWish();
    expect((await duringTransition("preorder", () => deleteWish(id))).status).toBe(204);
  });

  it("deux modifications simultanées de la même wishlist : une configuration complète, sans interblocage", async () => {
    const id = await aliceWish();
    const replies = await Promise.all([
      patchWish(id, {
        choices: [{ optionId: s.optionId, optionValueId: s.silentId }],
      }),
      patchWish(id, {
        choices: [{ optionId: s.cleaningId, optionValueId: s.cleaningFullId }],
      }),
      patchWish(id, { choices: [] }),
    ]);
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    const items = await itemsOf(id);
    expect(items).toHaveLength(2); // un item par menu visible, jamais de doublon ni de manque
  });
});

describe("backoffice : mesure d'intérêt", () => {
  it("compteurs par lot et par valeur d'option (machines et utilisateurs distincts), retraits exclus", async () => {
    await as(ALICE);
    await wishFor({
      batchId: s.batchId,
      quantity: 2,
      choices: [{ optionId: s.optionId, optionValueId: s.silentId }],
    });
    const removed = await wishFor({ batchId: s.batchId });
    await deleteWish(removed.body.items[0].id);
    await as(BOB);
    await wishFor({
      batchId: s.batchId,
      choices: [
        { optionId: s.optionId, optionValueId: s.silentId },
        { optionId: s.cleaningId, optionValueId: s.cleaningFullId },
      ],
    });

    await as(ADMIN);
    const reply = await call(boBatchRoute.GET, {
      params: { batchId: s.batchId },
    });
    expect(reply.body.counters).toMatchObject({
      interestedMachines: 3,
      interestedUsers: 2,
    });
    const values = Object.fromEntries(
      reply.body.options.flatMap((o: { values: { id: string; interest: unknown }[] }) =>
        o.values.map((v) => [v.id, v.interest]),
      ),
    );
    expect(values[s.silentId]).toEqual({ machines: 3, users: 2 });
    expect(values[s.noKitId]).toEqual({ machines: 0, users: 0 });
    expect(values[s.cleaningNoId]).toEqual({ machines: 2, users: 1 });
    expect(values[s.cleaningFullId]).toEqual({ machines: 1, users: 1 });
    expect(values[s.firmwareCustomId]).toEqual({ machines: 0, users: 0 }); // menu masqué : pas d'item
    const menus = Object.fromEntries(
      reply.body.options.map((o: { id: string; wishlistChoices: number }) => [o.id, o.wishlistChoices]),
    );
    expect(menus).toMatchObject({ [s.optionId]: 3, [s.cleaningId]: 1 });
  });

  it("dépublier puis republier conserve les wishlists, qui ne sont plus modifiables en brouillon", async () => {
    await as(ALICE);
    const id = (await wishFor({ batchId: s.batchId })).body.items[0].id;
    await as(ADMIN);
    const back = await call(boTransitionsRoute.POST, {
      params: { batchId: s.batchId },
      body: { from: "survey", to: "draft", note: "erreur" },
      headers: SAME_ORIGIN,
    });
    expect(back.status).toBe(201);
    await as(ALICE);
    expectError(await patchWish(id, { choices: [] }), 409, "wishlist_not_editable");
    expect((await getWish(id)).body).toMatchObject({
      editable: false,
      options: null,
    });
    expectError(await call(shopBatchRoute.GET, { params: { batchId: s.batchId } }), 404, "batch_not_found");
  });
});
