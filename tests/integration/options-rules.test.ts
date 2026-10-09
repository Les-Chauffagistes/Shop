import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  type Catalog,
  completeItems,
  createBatch,
  createCatalog,
  createUser,
  failureOf,
  type Item,
  moveBatch,
  pay,
  placeOrder,
  priorityOverAt,
  RESALE,
  SILENT_PRICE,
  wish,
} from "./fixtures";

// Règles de la base sur les options d'un lot (migrations init et v4, décisions Hugo 2026-10-06
// et 2026-10-07) : défaut gratuit, menu Avec/Sans, changement de défaut, configuration complète,
// menus masqués, instantané des menus et valeurs à la publication, prix figé, stock disponible
// (batch_available_stock), devise unique.

type Tx = Prisma.TransactionClient;

let catalog: Catalog;
/** Second menu du modèle, Avec/Sans : « Sans » (défaut, 0) et « Avec » (2 000). */
let cleaning: { optionId: string; offId: string; onId: string };

beforeEach(async () => {
  catalog = await createCatalog();
  cleaning = await createMenu("Nettoyage", [
    { label: "Sans", price: 0n, is_default: true },
    { label: "Avec", price: 2_000n },
  ]);
});

async function createMenu(title: string, values: { label: string; price: bigint; is_default?: boolean }[]) {
  const option = await prisma.option.create({
    data: {
      model_id: catalog.modelId,
      kind: values.length === 2 ? "toggle" : "choice",
      title,
      values: { create: values.map((v, position) => ({ ...v, position })) },
    },
    include: { values: { orderBy: { position: "asc" } } },
  });
  return { optionId: option.id, offId: option.values[0].id, onId: option.values[1]?.id };
}

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;

/**
 * Configuration (prix figés) d'un lot, hors wishlist et commande. Complète par défaut : les menus
 * visibles non choisis reçoivent leur défaut ; `exact` écrit `items` tels quels.
 */
async function configure(batchId: string, items: Item[], db: Tx | typeof prisma = prisma, { exact = false } = {}) {
  const all = exact ? items : await completeItems(batchId, items, db);
  return db.configuration.create({
    data: {
      batch_id: batchId,
      model_id: catalog.modelId,
      base_price: RESALE,
      items: {
        create: all.map((i) => ({ option_id: i.optionId, option_value_id: i.valueId, unit_price: i.price ?? 0n })),
      },
    },
  });
}

/** Choix (option_id → option_value_id) d'une configuration. */
async function choices(configurationId: string) {
  const items = await prisma.configurationItem.findMany({ where: { configuration_id: configurationId } });
  return new Map(items.map((i) => [i.option_id, i.option_value_id]));
}

function addItem(configurationId: string, item: Item, db: Tx | typeof prisma = prisma) {
  return db.configurationItem.create({
    data: {
      configuration_id: configurationId,
      model_id: catalog.modelId,
      option_id: item.optionId,
      option_value_id: item.valueId,
      unit_price: item.price ?? 0n,
    },
  });
}

function setHidden(batchId: string, optionId: string, hidden: boolean, db: Tx | typeof prisma = prisma) {
  return db.batchOption.update({ where: { batch_id_option_id: { batch_id: batchId, option_id: optionId } }, data: { hidden } });
}

async function menus(batchId: string) {
  const rows = await prisma.$queryRaw<{ option_id: string; hidden: boolean }[]>`
    SELECT "option_id", "hidden" FROM "batch_menus"(${batchId}::uuid)`;
  return new Map(rows.map((r) => [r.option_id, r.hidden]));
}

async function offered(batchId: string) {
  const rows = await prisma.$queryRaw<{ option_value_id: string; price: bigint }[]>`
    SELECT "option_value_id", "price" FROM "batch_offered_values"(${batchId}::uuid)`;
  return new Map(rows.map((r) => [r.option_value_id, r.price]));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Transaction qui exécute `write`, signale, puis garde ses verrous `holdMs` avant le COMMIT. */
function holdingTransaction(write: (tx: Tx) => Promise<unknown>, holdMs = 400) {
  let signal!: () => void;
  const written = new Promise<void>((resolve) => (signal = resolve));
  const done = prisma.$transaction(async (tx) => {
    await write(tx);
    signal();
    await sleep(holdMs);
  });
  return { written, done };
}

describe("valeur par défaut brute : gratuite", () => {
  it("prix 0 garanti par CHECK : création, modification, changement de défaut", async () => {
    const priced = prisma.option.create({
      data: { model_id: catalog.modelId, kind: "choice", title: "Firmware", values: { create: { label: "Stock", is_default: true, price: 100n } } },
    });
    expect(await constraintOf(priced)).toBe("OptionValue_default_free_check");

    expect(await constraintOf(prisma.optionValue.update({ where: { id: catalog.noKitId }, data: { price: 100n } }))).toBe(
      "OptionValue_default_free_check",
    );

    const swap = (price?: bigint) =>
      prisma.$transaction(async (tx) => {
        await tx.optionValue.update({ where: { id: catalog.noKitId }, data: { is_default: false } });
        await tx.optionValue.update({ where: { id: catalog.silentId }, data: { is_default: true, price } });
      });
    expect(await constraintOf(swap())).toBe("OptionValue_default_free_check");
    await swap(0n); // le nouveau défaut devient gratuit dans la même requête
  });

  it("règle « défaut sans pièce » supprimée (v4) : le défaut gratuit peut porter une pièce", async () => {
    const part = await prisma.part.create({ data: { name: "Ventilateur" } });
    await prisma.optionValuePart.create({ data: { option_value_id: catalog.noKitId, part_id: part.id } });
    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgname LIKE '%default_no_parts%'`;
    expect(triggers).toEqual([]);
  });

  it("pas de dérogation non nulle sur le défaut, item de configuration du défaut à 0", async () => {
    const draft = await createBatch(catalog, { quantity: 2, status: "draft" });
    const override = (price: bigint) =>
      prisma.batchOptionValue.upsert({
        where: { batch_id_option_value_id: { batch_id: draft, option_value_id: catalog.noKitId } },
        update: { price_override: price },
        create: { batch_id: draft, model_id: catalog.modelId, option_id: catalog.optionId, option_value_id: catalog.noKitId, price_override: price },
      });
    expect(await constraintOf(override(500n))).toBe("BatchOptionValue_default_free");
    await override(0n);

    const batchId = await createBatch(catalog, { quantity: 2 });
    const item = { optionId: catalog.optionId, valueId: catalog.noKitId };
    expect(await constraintOf(configure(batchId, [{ ...item, price: 100n }]))).toBe("ConfigurationItem_default_free");
    await configure(batchId, [item]);
  });
});

describe("menu masqué par lot", () => {
  it("masqué en brouillon : instantané à la publication, défaut d'office, aucun item dans ce menu", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "draft" });
    await prisma.batchOption.create({
      data: { batch_id: batchId, model_id: catalog.modelId, option_id: cleaning.optionId, hidden: true },
    });
    await moveBatch(batchId, "draft", "survey");

    expect(await menus(batchId)).toEqual(new Map([[catalog.optionId, false], [cleaning.optionId, true]]));
    const values = await offered(batchId);
    expect(values.has(catalog.silentId)).toBe(true);
    expect(values.has(cleaning.offId) || values.has(cleaning.onId)).toBe(false);

    for (const valueId of [cleaning.offId, cleaning.onId]) {
      expect(await constraintOf(configure(batchId, [{ optionId: cleaning.optionId, valueId }]))).toBe(
        "ConfigurationItem_option_hidden",
      );
    }
    await configure(batchId, [{ optionId: catalog.optionId, valueId: catalog.silentId, price: SILENT_PRICE }]);
  });

  it("masquer au sondage ramène les choix des wishlists au défaut ; démasquer leur redonne le défaut", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const alice = await createUser();
    const wishlist = await wish(catalog, batchId, alice, [
      { optionId: catalog.optionId, valueId: catalog.silentId, price: SILENT_PRICE },
      { optionId: cleaning.optionId, valueId: cleaning.onId, price: 2_000n },
    ]);

    await setHidden(batchId, cleaning.optionId, true);
    expect(await choices(wishlist.configuration_id)).toEqual(new Map([[catalog.optionId, catalog.silentId]]));

    await setHidden(batchId, cleaning.optionId, false);
    expect(await choices(wishlist.configuration_id)).toEqual(
      new Map([[catalog.optionId, catalog.silentId], [cleaning.optionId, cleaning.offId]]),
    );
    const item = await prisma.configurationItem.findUniqueOrThrow({
      where: { configuration_id_option_id: { configuration_id: wishlist.configuration_id, option_id: cleaning.optionId } },
    });
    expect(item.unit_price).toBe(0n);
  });

  it("figé dès la précommande ; menus d'un lot publié ni ajoutés ni retirés", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    await setHidden(batchId, cleaning.optionId, true);
    await moveBatch(batchId, "survey", "preorder");
    expect(await constraintOf(setHidden(batchId, cleaning.optionId, false))).toBe("BatchOption_hidden_locked");
    expect(await constraintOf(setHidden(batchId, catalog.optionId, true))).toBe("BatchOption_hidden_locked");
    await setHidden(batchId, cleaning.optionId, true); // valeur inchangée : acceptée
    const late = await createMenu("Firmware", [{ label: "Stock", price: 0n, is_default: true }]);
    const add = prisma.batchOption.create({ data: { batch_id: batchId, model_id: catalog.modelId, option_id: late.optionId } });
    expect(await constraintOf(add)).toBe("BatchOption_snapshot");
    const remove = prisma.batchOption.delete({
      where: { batch_id_option_id: { batch_id: batchId, option_id: cleaning.optionId } },
    });
    expect(await constraintOf(remove)).toBe("BatchOption_snapshot");

    // En brouillon, les réglages de menus restent libres
    const draft = await createBatch(catalog, { quantity: 1, status: "draft" });
    await prisma.batchOption.create({ data: { batch_id: draft, model_id: catalog.modelId, option_id: late.optionId, hidden: true } });
    await prisma.batchOption.delete({ where: { batch_id_option_id: { batch_id: draft, option_id: late.optionId } } });
  });

  it("concurrence : une saisie de configuration attend un masquage en cours puis est refusée", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const hide = holdingTransaction((tx) => setHidden(batchId, cleaning.optionId, true, tx));
    await hide.written;
    const choose = failureOf(configure(batchId, [{ optionId: cleaning.optionId, valueId: cleaning.onId, price: 2_000n }]));
    await hide.done;
    expect(pgFailureOf(await choose)?.constraint).toBe("ConfigurationItem_option_hidden");
  });

  it("concurrence : un masquage attend une saisie de choix en cours, puis ramène ce choix au défaut", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    let configurationId = "";
    const choose = holdingTransaction(async (tx) => {
      configurationId = (await configure(batchId, [{ optionId: cleaning.optionId, valueId: cleaning.onId, price: 2_000n }], tx)).id;
    });
    await choose.written;
    const hide = prisma.$transaction((tx) => setHidden(batchId, cleaning.optionId, true, tx));
    await choose.done;
    await hide;
    expect((await choices(configurationId)).has(cleaning.optionId)).toBe(false);
  });
});

describe("menus et valeurs ajoutés après la publication", () => {
  it("un menu créé après la publication ne s'applique pas au lot (défaut implicite)", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const draft = await createBatch(catalog, { quantity: 2, status: "draft" });
    const late = await createMenu("Firmware", [
      { label: "Stock", price: 0n, is_default: true },
      { label: "Braiins", price: 1_000n },
    ]);

    expect((await menus(batchId)).has(late.optionId)).toBe(false);
    expect((await menus(draft)).has(late.optionId)).toBe(true); // brouillon : catalogue vivant
    expect(await constraintOf(configure(batchId, [{ optionId: late.optionId, valueId: late.onId, price: 1_000n }]))).toBe(
      "ConfigurationItem_option_applicable",
    );
    const setting = prisma.batchOptionValue.create({
      data: { batch_id: batchId, model_id: catalog.modelId, option_id: late.optionId, option_value_id: late.onId },
    });
    expect(await constraintOf(setting)).toBe("BatchOptionValue_option_applicable");
  });

  it("une valeur créée après la publication n'est pas proposée, sauf si l'admin l'ajoute au lot", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const hydro = await prisma.optionValue.create({ data: { option_id: catalog.optionId, label: "Hydro", price: 0n, position: 2 } });
    const item = { optionId: catalog.optionId, valueId: hydro.id };

    expect((await offered(batchId)).has(hydro.id)).toBe(false);
    expect(await constraintOf(configure(batchId, [item]))).toBe("ConfigurationItem_value_enabled");

    // Elle ne peut pas non plus devenir le défaut : le lot publié n'aurait plus de défaut proposé
    const makeDefault = (tx: Tx) =>
      tx.optionValue.updateMany({ where: { option_id: catalog.optionId }, data: { is_default: false } }).then(() =>
        tx.optionValue.update({ where: { id: hydro.id }, data: { is_default: true } }),
      );
    expect(await constraintOf(prisma.$transaction(makeDefault))).toBe("BatchOptionValue_default_enabled");

    // Décision admin : proposer la nouvelle valeur sur ce lot
    await prisma.batchOptionValue.create({
      data: { batch_id: batchId, model_id: catalog.modelId, option_id: catalog.optionId, option_value_id: hydro.id },
    });
    expect((await offered(batchId)).get(hydro.id)).toBe(0n);
    await configure(batchId, [item]);
    await prisma.$transaction(makeDefault);
  });

  it("les réglages d'un lot publié ne sont jamais supprimés ; une re-publication complète l'instantané", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    expect(await prisma.batchOptionValue.count({ where: { batch_id: batchId } })).toBe(4);
    const remove = prisma.batchOptionValue.deleteMany({ where: { batch_id: batchId, option_value_id: catalog.silentId } });
    expect(await constraintOf(remove)).toBe("BatchOptionValue_snapshot");
    // Retirer une valeur d'un lot publié : enabled = false
    await prisma.batchOptionValue.update({
      where: { batch_id_option_value_id: { batch_id: batchId, option_value_id: catalog.silentId } },
      data: { enabled: false },
    });
    expect((await offered(batchId)).has(catalog.silentId)).toBe(false);

    // Dépublication : catalogue vivant, réglages libres ; re-publication : instantané complété
    await moveBatch(batchId, "survey", "draft");
    const late = await createMenu("Firmware", [{ label: "Stock", price: 0n, is_default: true }]);
    await prisma.batchOptionValue.deleteMany({ where: { batch_id: batchId, option_value_id: catalog.noKitId } });
    await moveBatch(batchId, "draft", "survey");
    expect([...(await menus(batchId)).keys()].sort()).toEqual([catalog.optionId, cleaning.optionId, late.optionId].sort());
    const values = await offered(batchId);
    expect(values.has(catalog.noKitId) && values.has(late.offId)).toBe(true);
    expect(values.has(catalog.silentId)).toBe(false); // le retrait du brouillon est conservé
  });

  it("annulé depuis le brouillon : pas d'instantané", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "draft" });
    await moveBatch(batchId, "draft", "cancelled");
    expect(await prisma.batchOption.count({ where: { batch_id: batchId } })).toBe(0);
    expect(await prisma.batchOptionValue.count({ where: { batch_id: batchId } })).toBe(0);
  });
});

describe("prix catalogue figé par un lot en cours", () => {
  const setPrice = (valueId: string, price: bigint) => prisma.optionValue.update({ where: { id: valueId }, data: { price } });

  it("prix et menu figés de la publication à la clôture ; la dérogation de lot reste possible", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "draft" });
    await setPrice(catalog.silentId, 8_000n); // brouillon : catalogue vivant
    await moveBatch(batchId, "draft", "survey");

    expect(await constraintOf(setPrice(catalog.silentId, 9_000n))).toBe("OptionValue_price_frozen");
    const move = prisma.optionValue.update({ where: { id: catalog.silentId }, data: { option_id: cleaning.optionId } });
    expect(await constraintOf(move)).toBe("OptionValue_option_frozen");
    await prisma.optionValue.update({ where: { id: catalog.silentId }, data: { label: "Silent kit v2", position: 5 } });

    await prisma.batchOptionValue.update({
      where: { batch_id_option_value_id: { batch_id: batchId, option_value_id: catalog.silentId } },
      data: { price_override: 9_000n },
    });
    expect((await offered(batchId)).get(catalog.silentId)).toBe(9_000n);

    // Valeur créée après la publication, non proposée par le lot : prix libre
    const hydro = await prisma.optionValue.create({ data: { option_id: catalog.optionId, label: "Hydro", price: 100n, position: 3 } });
    await setPrice(hydro.id, 200n);

    // Plus aucun lot en cours : le catalogue redevient modifiable
    await moveBatch(batchId, "survey", "cancelled");
    await setPrice(catalog.silentId, 9_000n);
  });

  it("concurrence : un changement de prix attend une publication en cours puis est refusé", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "draft" });
    const publish = holdingTransaction((tx) =>
      tx.batchStatusTransition.create({
        data: { batch_id: batchId, from_status: "draft", to_status: "survey", changed_by_auth_user_id: 1n },
      }),
    );
    await publish.written;
    const change = failureOf(setPrice(catalog.silentId, 9_000n));
    await publish.done;
    expect(pgFailureOf(await change)?.constraint).toBe("OptionValue_price_frozen");
    expect((await prisma.optionValue.findUniqueOrThrow({ where: { id: catalog.silentId } })).price).toBe(SILENT_PRICE);
  });
});

describe("menu Avec/Sans (toggle)", () => {
  it("exactement deux valeurs (différé), à la création comme à l'ajout ou au retrait", async () => {
    const one = prisma.option.create({
      data: { model_id: catalog.modelId, kind: "toggle", title: "Seul", values: { create: { label: "Sans", is_default: true } } },
    });
    expect(await constraintOf(one)).toBe("OptionValue_toggle_two_values");
    const third = prisma.optionValue.create({ data: { option_id: cleaning.optionId, label: "Peut-être", price: 1n } });
    expect(await constraintOf(third)).toBe("OptionValue_toggle_two_values");
    expect(await constraintOf(prisma.optionValue.delete({ where: { id: cleaning.onId } }))).toBe("OptionValue_toggle_two_values");

    // Supprimer le menu entier (valeurs puis menu) dans une transaction : accepté
    await prisma.$transaction(async (tx) => {
      await tx.optionValue.deleteMany({ where: { option_id: cleaning.optionId } });
      await tx.option.delete({ where: { id: cleaning.optionId } });
    });
  });

  it("« Sans » est toujours le défaut : « Avec » ne le devient jamais ; type figé une fois les valeurs créées", async () => {
    const swap = prisma.$transaction(async (tx) => {
      await tx.optionValue.update({ where: { id: cleaning.offId }, data: { is_default: false } });
      await tx.optionValue.update({ where: { id: cleaning.onId }, data: { is_default: true, price: 0n } });
    });
    expect(await constraintOf(swap)).toBe("OptionValue_toggle_default_fixed");

    // « Avec » payant désigné défaut à la création : refusé (défaut gratuit)
    const paidDefault = prisma.option.create({
      data: {
        model_id: catalog.modelId, kind: "toggle", title: "Firmware",
        values: { create: [{ label: "Sans", position: 0 }, { label: "Avec", price: 1_500n, is_default: true, position: 1 }] },
      },
    });
    expect(await constraintOf(paidDefault)).toBe("OptionValue_default_free_check");

    const kind = prisma.option.update({ where: { id: cleaning.optionId }, data: { kind: "choice" } });
    expect(await constraintOf(kind)).toBe("Option_kind_fixed");
  });
});

describe("changement de la valeur par défaut après publication", () => {
  /** Menu « Firmware » (choix) : Stock (défaut) et Braiins, gratuits tous deux. */
  let firmware: { optionId: string; offId: string; onId: string };
  beforeEach(async () => {
    firmware = await createMenu("Firmware", [
      { label: "Stock", price: 0n, is_default: true },
      { label: "Braiins", price: 0n },
      { label: "LuxOS", price: 0n },
    ]);
  });
  const makeBraiinsDefault = () =>
    prisma.$transaction(async (tx) => {
      await tx.optionValue.update({ where: { id: firmware.offId }, data: { is_default: false } });
      await tx.optionValue.update({ where: { id: firmware.onId }, data: { is_default: true } });
    });

  it("autorisé si chaque wishlist porte un choix explicite dans ce menu (instantané inchangé)", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const wishlist = await wish(catalog, batchId, await createUser());
    await makeBraiinsDefault();
    expect((await choices(wishlist.configuration_id)).get(firmware.optionId)).toBe(firmware.offId);
  });

  it("refusé si une wishlist ou une commande vivante n'a pas d'item dans ce menu (masqué) ; une wishlist retirée ne compte pas", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    await setHidden(batchId, firmware.optionId, true);
    const wishlist = await wish(catalog, batchId, await createUser());
    expect(await constraintOf(makeBraiinsDefault())).toBe("OptionValue_default_change_locked");

    await prisma.wishlist.update({ where: { id: wishlist.id }, data: { cancelled_at: new Date() } });
    await moveBatch(batchId, "survey", "preorder", priorityOverAt());
    await placeOrder({ catalog, batchId, customer: await createUser() });
    expect(await constraintOf(makeBraiinsDefault())).toBe("OptionValue_default_change_locked");
  });

  it("lots clos ou annulés : ne bloquent plus", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    await setHidden(batchId, firmware.optionId, true);
    await wish(catalog, batchId, await createUser());
    await moveBatch(batchId, "survey", "cancelled");
    await makeBraiinsDefault();
  });
});

describe("configuration complète : un item par menu visible", () => {
  it("un menu visible sans item est refusé (différé), y compris en retirant un choix ; un menu masqué n'a pas d'item", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const ventilationOnly = [{ optionId: catalog.optionId, valueId: catalog.noKitId }];
    expect(await constraintOf(configure(batchId, ventilationOnly, prisma, { exact: true }))).toBe("Configuration_complete");

    // Configuration et items dans la même transaction : accepté
    await prisma.$transaction(async (tx) => {
      const configuration = await configure(batchId, ventilationOnly, tx, { exact: true });
      await addItem(configuration.id, { optionId: cleaning.optionId, valueId: cleaning.offId }, tx);
    });

    const configuration = await configure(batchId, []);
    const remove = prisma.configurationItem.delete({
      where: { configuration_id_option_id: { configuration_id: configuration.id, option_id: cleaning.optionId } },
    });
    expect(await constraintOf(remove)).toBe("Configuration_complete");

    await setHidden(batchId, cleaning.optionId, true);
    await configure(batchId, ventilationOnly, prisma, { exact: true });
  });

  it("re-publication : les wishlists restées en brouillon reçoivent le défaut des menus ajoutés", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const wishlist = await wish(catalog, batchId, await createUser());
    await moveBatch(batchId, "survey", "draft");
    const late = await createMenu("Firmware", [
      { label: "Sans", price: 0n, is_default: true },
      { label: "Avec", price: 1_000n },
    ]);
    await moveBatch(batchId, "draft", "survey");
    expect((await choices(wishlist.configuration_id)).get(late.optionId)).toBe(late.offId);
  });

  it("instantané : le prix choisi ne suit pas le catalogue", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const wishlist = await wish(catalog, batchId, await createUser(), [
      { optionId: catalog.optionId, valueId: catalog.silentId, price: SILENT_PRICE },
    ]);
    await moveBatch(batchId, "survey", "cancelled");
    await prisma.optionValue.update({ where: { id: catalog.silentId }, data: { price: 9_900n } });
    const item = await prisma.configurationItem.findUniqueOrThrow({
      where: { configuration_id_option_id: { configuration_id: wishlist.configuration_id, option_id: catalog.optionId } },
    });
    expect(item.unit_price).toBe(SILENT_PRICE);
  });
});

describe("proposer après coup une valeur sur un lot publié", () => {
  it("lot de survey à in_transit seulement", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const hydro = await prisma.optionValue.create({ data: { option_id: catalog.optionId, label: "Hydro", price: 5_000n, position: 3 } });
    await moveBatch(batchId, "survey", "cancelled");
    const propose = prisma.batchOptionValue.create({
      data: { batch_id: batchId, model_id: catalog.modelId, option_id: catalog.optionId, option_value_id: hydro.id },
    });
    expect(await constraintOf(propose)).toBe("BatchOptionValue_batch_open");
  });
});

describe("stock disponible : batch_available_stock", () => {
  const available = async (batchId: string, plus: string | null = null) => {
    const [{ stock }] = await prisma.$queryRaw<{ stock: number | null }[]>`
      SELECT "batch_available_stock"(${batchId}::uuid, ${plus}::uuid) AS "stock"`;
    return stock;
  };

  it("quantity − lignes payées et réservées − machines sorties du stock ; `plus` ; NULL si lot inconnu", async () => {
    const batchId = await createBatch(catalog, { quantity: 6, status: "inspection" });
    const [alice, bob] = [await createUser(), await createUser()];
    await pay(await placeOrder({ catalog, batchId, customer: alice, lines: [true] }));
    await placeOrder({ catalog, batchId, customer: bob, lines: [false, true] });
    const expired = await placeOrder({ catalog, batchId, customer: bob, expiredMinutesAgo: 1 });
    await prisma.machine.create({
      data: {
        batch_id: batchId, model_id: catalog.modelId, serial: "SN-DEAD", received_at: new Date(),
        functional_status: "faulty", logistical_status: "scrapped",
      },
    });

    expect(await available(batchId)).toBe(6 - 1 - 2 - 1);
    expect(await available(batchId, expired)).toBe(1);
    expect(await available("00000000-0000-4000-8000-000000000000")).toBeNull();

    const usage = await prisma.$queryRaw<{ option_value_id: string; used: number }[]>`
      SELECT * FROM "batch_option_usage"(${batchId}::uuid)`;
    // Configurations complètes : le défaut « Sans » du menu Nettoyage est compté aussi
    expect(new Map(usage.map((u) => [u.option_value_id, u.used]))).toEqual(
      new Map([[catalog.silentId, 2], [catalog.noKitId, 1], [cleaning.offId, 3]]),
    );

    // Le trigger de stock applique la même règle : à 0 disponible près
    await placeOrder({ catalog, batchId, customer: alice, lines: [false, false] });
    expect(await available(batchId)).toBe(0);
    // (un autre client : Alice a déjà une facture en attente vivante sur ce lot)
    expect(pgFailureOf(await failureOf(placeOrder({ catalog, batchId, customer: await createUser() })))?.constraint).toBe("Batch_stock");
  });
});

describe("configuration de wishlist figée dès la précommande (Wishlist_configuration_frozen)", () => {
  const FROZEN = "Wishlist_configuration_frozen";

  /** Lot au sondage et wishlist (Silent kit, Nettoyage « Avec »). */
  async function surveyWish() {
    const batchId = await createBatch(catalog, { quantity: 4, status: "survey" });
    const wishlist = await wish(catalog, batchId, await createUser(), [
      { optionId: catalog.optionId, valueId: catalog.silentId, price: SILENT_PRICE },
      { optionId: cleaning.optionId, valueId: cleaning.onId, price: 2_000n },
    ]);
    return { batchId, wishlist };
  }

  const setItem = (configurationId: string, optionId: string, valueId: string, price: bigint, db: Tx | typeof prisma = prisma) =>
    db.configurationItem.update({
      where: { configuration_id_option_id: { configuration_id: configurationId, option_id: optionId } },
      data: { option_value_id: valueId, unit_price: price },
    });

  it("modifiable au sondage ; le passage en précommande n'est pas bloqué et ne change rien", async () => {
    const { batchId, wishlist } = await surveyWish();
    await setItem(wishlist.configuration_id, catalog.optionId, catalog.noKitId, 0n);
    await setItem(wishlist.configuration_id, catalog.optionId, catalog.silentId, SILENT_PRICE);
    await prisma.configuration.update({ where: { id: wishlist.configuration_id }, data: { base_price: RESALE } });

    await moveBatch(batchId, "survey", "preorder");
    expect(await choices(wishlist.configuration_id)).toEqual(
      new Map([[catalog.optionId, catalog.silentId], [cleaning.optionId, cleaning.onId]]),
    );
  });

  it("refusée dès la précommande : items, configuration, changement de configuration de la wishlist", async () => {
    const { batchId, wishlist } = await surveyWish();
    await moveBatch(batchId, "survey", "preorder");
    const cid = wishlist.configuration_id;

    expect(await constraintOf(setItem(cid, catalog.optionId, catalog.noKitId, 0n))).toBe(FROZEN);
    const removeItem = prisma.configurationItem.delete({
      where: { configuration_id_option_id: { configuration_id: cid, option_id: cleaning.optionId } },
    });
    expect(await constraintOf(removeItem)).toBe(FROZEN);
    expect(await constraintOf(addItem(cid, { optionId: catalog.optionId, valueId: catalog.noKitId }))).toBe(FROZEN);
    expect(await constraintOf(prisma.configuration.update({ where: { id: cid }, data: { base_price: 1n } }))).toBe(FROZEN);
    expect(await constraintOf(prisma.configuration.delete({ where: { id: cid } }))).toBe(FROZEN);

    // Une configuration hors wishlist (commande) du même lot reste libre jusqu'à son verrouillage
    const other = await configure(batchId, []);
    const repoint = prisma.$executeRaw`UPDATE "Wishlist" SET "configuration_id" = ${other.id}::uuid WHERE "id" = ${wishlist.id}::uuid`;
    expect(await constraintOf(repoint)).toBe(FROZEN);
    await setItem(other.id, catalog.optionId, catalog.silentId, SILENT_PRICE);

    // Le retrait reste possible, la configuration retirée reste figée
    await prisma.wishlist.update({ where: { id: wishlist.id }, data: { cancelled_at: new Date() } });
    expect(await constraintOf(setItem(cid, catalog.optionId, catalog.noKitId, 0n))).toBe(FROZEN);
    expect(await choices(cid)).toEqual(new Map([[catalog.optionId, catalog.silentId], [cleaning.optionId, cleaning.onId]]));
  });

  it("masquer un menu au sondage ramène toujours les choix des wishlists au défaut", async () => {
    const { batchId, wishlist } = await surveyWish();
    await setHidden(batchId, cleaning.optionId, true);
    await setHidden(batchId, cleaning.optionId, false);
    expect((await choices(wishlist.configuration_id)).get(cleaning.optionId)).toBe(cleaning.offId);
    await moveBatch(batchId, "survey", "preorder");
    expect(await constraintOf(setHidden(batchId, cleaning.optionId, true))).toBe("BatchOption_hidden_locked");
  });

  it("dépublié puis précommande directe : la complétion de la publication passe (lot encore brouillon), puis figée", async () => {
    const { batchId, wishlist } = await surveyWish();
    await moveBatch(batchId, "survey", "draft");
    await setItem(wishlist.configuration_id, catalog.optionId, catalog.noKitId, 0n); // brouillon : permis en base
    const late = await createMenu("Firmware", [
      { label: "Sans", price: 0n, is_default: true },
      { label: "Avec", price: 1_000n },
    ]);
    await moveBatch(batchId, "draft", "preorder");
    expect((await choices(wishlist.configuration_id)).get(late.optionId)).toBe(late.offId);
    expect(await constraintOf(setItem(wishlist.configuration_id, late.optionId, late.onId, 1_000n))).toBe(FROZEN);
  });

  it("concurrence : une modification qui attend l'ouverture des précommandes en cours est refusée", async () => {
    const { batchId, wishlist } = await surveyWish();
    const open = holdingTransaction((tx) =>
      tx.batchStatusTransition.create({
        data: { batch_id: batchId, from_status: "survey", to_status: "preorder", changed_by_auth_user_id: 1n },
      }),
    );
    await open.written;
    const edit = failureOf(setItem(wishlist.configuration_id, catalog.optionId, catalog.noKitId, 0n));
    await open.done;
    expect(pgFailureOf(await edit)?.constraint).toBe(FROZEN);
  });

  it("concurrence : l'ouverture des précommandes attend une modification en cours, qui reste", async () => {
    const { batchId, wishlist } = await surveyWish();
    const edit = holdingTransaction((tx) => setItem(wishlist.configuration_id, catalog.optionId, catalog.noKitId, 0n, tx));
    await edit.written;
    const open = moveBatch(batchId, "survey", "preorder");
    await edit.done;
    await open;
    expect((await choices(wishlist.configuration_id)).get(catalog.optionId)).toBe(catalog.noKitId);
  });
});

it("devise unique : aucune colonne currency", async () => {
  const columns = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT "table_name" FROM information_schema.columns
    WHERE "table_schema" = 'public' AND "column_name" = 'currency'`;
  expect(columns).toEqual([]);
});
