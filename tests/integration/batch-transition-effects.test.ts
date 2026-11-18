import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import { BATCH_STATUS_LABELS, TRANSITIONS } from "@/server/batch-status";
import type { BatchStatus } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  cancelOrder,
  type Catalog,
  createBatch,
  createConfiguration,
  createCatalog,
  createStockBatch,
  createUser,
  failureOf,
  machinesOf,
  moveBatch,
  pay,
  placeOrder,
  receiveAndCheck,
  receivePayment,
  restock,
  wish,
} from "./fixtures";

// Caractérisation des effets d'une transition de statut de lot (BatchStatusTransition). Depuis la refonte R2, un
// trigger par responsabilité, déclenchés dans l'ordre de leur nom (migration batches, en-tête) :
//   1. machine à états (BatchStatusTransition_1_check) : statut courant, couple autorisé pour le type du lot,
//      annulation d'un lot payé ; le statut est écrit par BatchStatusTransition_4_set_status
//   2. fermeture des commandes (2_cancel_orders) : factures en attente sans versement annulées
//   3. instantané des options à la sortie du brouillon (3_snapshot_options)
//   4. wishlists : la transition n'y touche plus (le « gel » était du code mort, un retrait les ajuste déjà)
//   5. génération des machines à l'entrée en Attente de réception (5_generate_machines)
//   6. clôture d'une palette : invendus en main transférés au lot de stock (6_close_to_stock)

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const statusOf = async (batchId: string) => (await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status;

let catalog: Catalog;
beforeEach(async () => {
  catalog = await createCatalog();
});

/** Chemin depuis le brouillon ; « cancelled » est atteint depuis le brouillon, les autres le long du flux normal. */
const FLOW: BatchStatus[] = [
  "draft", "survey", "preorder", "ordering", "awaiting_reception", "inspection", "tuning", "packaging", "in_transit", "closed",
];

/** Lot de 2 places amené au statut demandé par des transitions du journal (sans passer par les conditions du domaine). */
async function lotAt(status: BatchStatus, quantity = 2) {
  const id = await createBatch(catalog, { quantity, status: "draft" });
  if (status === "cancelled") {
    await moveBatch(id, "draft", "cancelled");
    return id;
  }
  const steps = FLOW.slice(0, FLOW.indexOf(status) + 1);
  for (let i = 1; i < steps.length; i++) {
    // tuning n'est pas sur le chemin le plus court mais la table l'autorise depuis inspection
    await moveBatch(id, steps[i - 1], steps[i]);
  }
  return id;
}


/** Lot de stock amené au statut demandé ; un lot de stock par modèle : un autre modèle pour un second lot. */
function stockAt(status: "draft" | "on_sale", cat: Catalog = catalog) {
  return createStockBatch(cat, { status });
}

let models = 0;
const otherCatalog = () => createCatalog(`Autre ${++models}`);

describe("1. machine à états", () => {
  const statuses = Object.keys(BATCH_STATUS_LABELS) as BatchStatus[];
  const wholesaleStatuses = statuses.filter((s) => s !== "on_sale");

  it("palette : chaque couple autorisé applique le statut au lot ; chaque couple refusé échoue sans rien changer", async () => {
    for (const from of wholesaleStatuses) {
      const refused = statuses.filter((to) => !TRANSITIONS.wholesale[from].includes(to));
      const lot = await lotAt(from);
      const before = await prisma.batchStatusTransition.count({ where: { batch_id: lot } });
      for (const to of refused) {
        expect(await constraintOf(moveBatch(lot, from, to)), `${from}>${to}`).toBe("BatchStatusTransition_allowed_check");
      }
      expect(await statusOf(lot)).toBe(from);
      expect(await prisma.batchStatusTransition.count({ where: { batch_id: lot } })).toBe(before);

      for (const to of TRANSITIONS.wholesale[from]) {
        const other = await lotAt(from);
        // updated_at antidaté d'une heure : la transition doit le reposer à l'horloge de la base (sinon, créé et changé
        // dans la même milliseconde, le lot garderait une date égale, tronquée à la milliseconde par Prisma)
        await prisma.$executeRaw`UPDATE "Batch" SET "updated_at" = now() - interval '1 hour' WHERE "id" = ${other}::uuid`;
        const [{ now: startedAt }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
        await moveBatch(other, from, to);
        const after = await prisma.batch.findUniqueOrThrow({ where: { id: other } });
        expect(after.status, `${from}>${to}`).toBe(to);
        expect(after.updated_at.getTime(), `${from}>${to}`).toBeGreaterThanOrEqual(startedAt.getTime());
      }
    }
  });

  it("lot de stock : brouillon (pause) ↔ en vente, rien d'autre ; même table en base", async () => {
    for (const from of ["draft", "on_sale"] as const) {
      const allowed = TRANSITIONS.stock[from];
      const lot = await stockAt(from, await otherCatalog());
      for (const to of statuses.filter((t) => !allowed.includes(t))) {
        expect(await constraintOf(moveBatch(lot, from, to)), `stock ${from}>${to}`).toBe("BatchStatusTransition_allowed_check");
      }
      expect(await statusOf(lot)).toBe(from);
      for (const to of allowed) {
        await moveBatch(lot, from, to);
        expect(await statusOf(lot), `stock ${from}>${to}`).toBe(to);
      }
    }
    const rows = await prisma.$queryRaw<{ f: string; t: string }[]>`
      SELECT f::text, t::text
      FROM unnest(enum_range(NULL::batch_status)) f, unnest(enum_range(NULL::batch_status)) t
      WHERE "batch_transition_allowed"('stock', f, t)`;
    expect(rows.map((r) => `${r.f}>${r.t}`).sort()).toEqual(["draft>on_sale", "on_sale>draft"]);
  });

  it("un statut hors de son type est refusé par la table aussi (Batch_kind_status_check)", async () => {
    const lot = await lotAt("draft");
    const stock = await stockAt("draft");
    const force = (id: string, status: BatchStatus) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "Batch" DISABLE TRIGGER "Batch_guard_status"');
        await tx.$executeRaw`UPDATE "Batch" SET "status" = ${status}::batch_status WHERE "id" = ${id}::uuid`;
      });
    expect(await constraintOf(force(lot, "on_sale"))).toBe("Batch_kind_status_check");
    expect(await constraintOf(force(stock, "preorder"))).toBe("Batch_kind_status_check");
  });

  it("from_status doit être le statut courant du lot", async () => {
    const lot = await lotAt("preorder");
    expect(await constraintOf(moveBatch(lot, "survey", "preorder"))).toBe("BatchStatusTransition_current");
    expect(await constraintOf(moveBatch(lot, "ordering", "awaiting_reception"))).toBe("BatchStatusTransition_current");
    expect(await statusOf(lot)).toBe("preorder");
  });

  it("la transition de création (from null) n'est valable que pour un nouveau brouillon, une seule fois", async () => {
    const lot = await lotAt("survey");
    expect(await constraintOf(moveBatch(lot, null, "draft"))).toBe("BatchStatusTransition_current");
    // Pas de transition de création vers autre chose que draft (le statut courant est vérifié avant le couple)
    expect(await constraintOf(moveBatch(lot, null, "survey"))).toBe("BatchStatusTransition_current");
    expect(await statusOf(lot)).toBe("survey");
  });

  it("annuler un lot qui a une commande payée est refusé ; remboursée, l'annulation passe", async () => {
    const lot = await lotAt("preorder");
    const orderId = await placeOrder({ catalog, batchId: lot, customer: await createUser() });
    await pay(orderId);
    expect(await constraintOf(moveBatch(lot, "preorder", "cancelled"))).toBe("BatchStatusTransition_cancel_refunded");
    expect(await statusOf(lot)).toBe("preorder");
  });
});

describe("2. fermeture des commandes : factures en attente sans versement", () => {
  /** Lot ouvert avec une facture de chaque sorte ; renvoie leurs identifiants. */
  async function lotWithOrders(status: BatchStatus) {
    const lot = await lotAt(status, 6);
    const [a, b, c, d, e] = [await createUser(), await createUser(), await createUser(), await createUser(), await createUser()];
    const unpaid = await placeOrder({ catalog, batchId: lot, customer: a });
    const partial = await placeOrder({ catalog, batchId: lot, customer: b });
    await receivePayment(prisma, partial, 1_000n);
    const expired = await placeOrder({ catalog, batchId: lot, customer: c, expiredMinutesAgo: 5 });
    const paid = await placeOrder({ catalog, batchId: lot, customer: d });
    await pay(paid);
    const userCancelled = await placeOrder({ catalog, batchId: lot, customer: e });
    await cancelOrder(prisma, userCancelled);
    return { lot, unpaid, partial, expired, paid, userCancelled };
  }
  const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

  it("sortie des statuts qui acceptent des commandes : seule la facture en attente sans versement et non expirée est annulée", async () => {
    const o = await lotWithOrders("packaging");
    await moveBatch(o.lot, "packaging", "in_transit");
    const unpaid = await orderOf(o.unpaid);
    expect(unpaid).toMatchObject({ status: "cancelled", cancel_reason: "batch_closed" });
    expect(unpaid.cancelled_at).not.toBeNull();
    expect((await orderOf(o.partial)).status).toBe("pending_payment");
    expect((await orderOf(o.expired)).status).toBe("pending_payment");
    expect((await orderOf(o.paid)).status).toBe("paid");
    expect((await orderOf(o.userCancelled)).cancel_reason).not.toBe("batch_closed");
  });

  it("annulation du lot : même effet", async () => {
    const lot = await lotAt("preorder");
    const unpaid = await placeOrder({ catalog, batchId: lot, customer: await createUser() });
    await moveBatch(lot, "preorder", "cancelled");
    expect(await orderOf(unpaid)).toMatchObject({ status: "cancelled", cancel_reason: "batch_closed" });
  });

  it("lot de stock mis en pause : même effet ; remis en vente, rien n'est touché", async () => {
    const lot = await stockAt("on_sale");
    for (const m of (await restock(catalog, lot, 2)).machines) await receiveAndCheck(m.id);
    const unpaid = await placeOrder({ catalog, batchId: lot, customer: await createUser() });
    await moveBatch(lot, "on_sale", "draft");
    expect(await orderOf(unpaid)).toMatchObject({ status: "cancelled", cancel_reason: "batch_closed" });
    await moveBatch(lot, "draft", "on_sale");
    const again = await placeOrder({ catalog, batchId: lot, customer: await createUser() });
    expect((await orderOf(again)).status).toBe("pending_payment");
  });

  it("une transition qui reste dans les statuts acceptant des commandes ne touche à aucune facture", async () => {
    const o = await lotWithOrders("preorder");
    for (const [from, to] of [["preorder", "ordering"], ["ordering", "awaiting_reception"], ["awaiting_reception", "inspection"]] as const) {
      await moveBatch(o.lot, from, to);
    }
    expect((await orderOf(o.unpaid)).status).toBe("pending_payment");
    expect((await orderOf(o.partial)).status).toBe("pending_payment");
  });
});

describe("3. instantané des options à la sortie du brouillon", () => {
  const snapshot = async (batchId: string) => ({
    menus: await prisma.batchOption.findMany({ where: { batch_id: batchId } }),
    values: await prisma.batchOptionValue.findMany({ where: { batch_id: batchId } }),
  });

  it("brouillon : aucun instantané ; la publication fige les menus et les valeurs du modèle ; annulation sans instantané", async () => {
    const cancelled = await lotAt("draft");
    const lot = await lotAt("draft");
    expect(await snapshot(lot)).toEqual({ menus: [], values: [] });

    await moveBatch(cancelled, "draft", "cancelled");
    expect(await snapshot(cancelled)).toEqual({ menus: [], values: [] });

    await moveBatch(lot, "draft", "survey");
    const { menus, values } = await snapshot(lot);
    expect(menus.map((m) => [m.option_id, m.hidden])).toEqual([[catalog.optionId, false]]);
    expect(values.map((v) => v.option_value_id).sort()).toEqual([catalog.noKitId, catalog.silentId].sort());
    expect(values.every((v) => v.enabled && v.price_override === null && v.max_qty === null)).toBe(true);
  });

  it("un menu ajouté au catalogue après la publication n'entre pas dans l'instantané ; dépublier puis republier le complète", async () => {
    const lot = await lotAt("survey");
    const late = await prisma.option.create({
      data: {
        model_id: catalog.modelId, kind: "choice", title: "Firmware", position: 1,
        values: { create: [{ label: "Stock", is_default: true, price: 0n }, { label: "Custom", price: 1_000n, position: 1 }] },
      },
    });
    await moveBatch(lot, "survey", "preorder");
    expect((await snapshot(lot)).menus.map((m) => m.option_id)).toEqual([catalog.optionId]);

    const lot2 = await lotAt("survey");
    await moveBatch(lot2, "survey", "draft");
    await moveBatch(lot2, "draft", "preorder");
    expect((await snapshot(lot2)).menus.map((m) => m.option_id).sort()).toEqual([catalog.optionId, late.id].sort());
  });

  it("lot de stock : la mise en vente prend l'instantané ; la pause puis la remise en vente le complètent", async () => {
    const lot = await stockAt("draft");
    expect(await snapshot(lot)).toEqual({ menus: [], values: [] });
    await moveBatch(lot, "draft", "on_sale");
    expect((await snapshot(lot)).values).toHaveLength(2);
    const late = await prisma.option.create({
      data: { model_id: catalog.modelId, kind: "toggle", title: "Firmware", position: 1,
        values: { create: [{ label: "Sans", is_default: true, price: 0n }, { label: "Avec", price: 1_000n, position: 1 }] } },
    });
    await moveBatch(lot, "on_sale", "draft");
    await moveBatch(lot, "draft", "on_sale");
    expect((await snapshot(lot)).menus.map((m) => m.option_id).sort()).toEqual([catalog.optionId, late.id].sort());
  });

  it("les réglages posés au brouillon sont conservés, les valeurs manquantes complétées", async () => {
    const lot = await createBatch(catalog, { quantity: 3, status: "draft", silentMaxQty: 2 });
    await moveBatch(lot, "draft", "survey");
    const { values } = await snapshot(lot);
    expect(values).toHaveLength(2);
    expect(values.find((v) => v.option_value_id === catalog.silentId)?.max_qty).toBe(2);
    expect(values.find((v) => v.option_value_id === catalog.noKitId)?.max_qty).toBeNull();
  });

  it("une configuration ouverte du brouillon reçoit la valeur par défaut (0 €) d'un menu ajouté au catalogue depuis", async () => {
    const lot = await lotAt("draft");
    const config = await prisma.$transaction((tx) => createConfiguration(tx, catalog, lot, []));
    const late = await prisma.option.create({
      data: {
        model_id: catalog.modelId, kind: "choice", title: "Firmware", position: 1,
        values: { create: [{ label: "Stock", is_default: true, price: 0n }, { label: "Custom", price: 1_000n, position: 1 }] },
        },
      include: { values: true },
    });
    expect(await prisma.configurationItem.count({ where: { configuration_id: config.id } })).toBe(1);
    await moveBatch(lot, "draft", "survey");
    const items = await prisma.configurationItem.findMany({ where: { configuration_id: config.id }, orderBy: { option_id: "asc" } });
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.option_id === late.id)).toMatchObject({
      option_value_id: late.values.find((v) => v.is_default)!.id,
      unit_price: 0n,
    });
  });
});

describe("4. wishlists : aucun effet de la transition", () => {
  // Le « gel » (retour au défaut des valeurs retirées à l'ouverture des précommandes) a été retiré : un retrait
  // ramène déjà les wishlists au défaut à tout statut vivant (BatchOptionValue_withdraw_from_wishlists), et une
  // configuration ne peut pas choisir une valeur non proposée (ConfigurationItem_value_enabled). Il n'était
  // atteignable qu'en suspendant ce trigger.
  const choiceOf = async (configurationId: string) =>
    prisma.configurationItem.findUniqueOrThrow({
      where: { configuration_id_option_id: { configuration_id: configurationId, option_id: catalog.optionId } },
    });
  const withdrawSilent = (lot: string) =>
    prisma.batchOptionValue.update({
      where: { batch_id_option_value_id: { batch_id: lot, option_value_id: catalog.silentId } },
      data: { enabled: false },
    });
  const silentWish = async (lot: string) =>
    wish(catalog, lot, await createUser(), [{ optionId: catalog.optionId, valueId: catalog.silentId, price: 7_500n }]);

  it("retirer une valeur ramène tout de suite les wishlists au défaut, au sondage, ajustement journalisé", async () => {
    const lot = await lotAt("survey", 4);
    const wishlist = await silentWish(lot);
    await withdrawSilent(lot);
    expect(await choiceOf(wishlist.configuration_id)).toMatchObject({ option_value_id: catalog.noKitId, unit_price: 0n });
    const log = await prisma.wishlistOptionWithdrawal.findMany({ where: { wishlist_id: wishlist.id } });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ withdrawn_value_id: catalog.silentId, withdrawn_unit_price: 7_500n, default_value_id: catalog.noKitId });
  });

  it("de même une fois les wishlists figées (précommande)", async () => {
    const lot = await lotAt("survey", 4);
    const wishlist = await silentWish(lot);
    await moveBatch(lot, "survey", "preorder");
    await withdrawSilent(lot);
    expect(await choiceOf(wishlist.configuration_id)).toMatchObject({ option_value_id: catalog.noKitId, unit_price: 0n });
    expect(await prisma.wishlistOptionWithdrawal.count({ where: { wishlist_id: wishlist.id } })).toBe(1);
  });

  it("une valeur toujours proposée est conservée par les transitions", async () => {
    const lot = await lotAt("survey", 4);
    const wishlist = await silentWish(lot);
    await moveBatch(lot, "survey", "draft");
    await moveBatch(lot, "draft", "preorder");
    expect((await choiceOf(wishlist.configuration_id)).option_value_id).toBe(catalog.silentId);
    expect(await prisma.wishlistOptionWithdrawal.count()).toBe(0);
  });
});

describe("5. génération des machines", () => {
  it("à l'entrée en Attente de réception : une machine attendue par place, du modèle du lot ; aucune avant", async () => {
    const lot = await lotAt("ordering", 3);
    expect(await machinesOf(lot)).toHaveLength(0);
    await moveBatch(lot, "ordering", "awaiting_reception");
    const machines = await machinesOf(lot);
    expect(machines).toHaveLength(3);
    expect(
      machines.every(
        (m) => m.model_id === catalog.modelId && m.logistical_status === "expected" && m.functional_status === "unknown" && m.received_at === null,
      ),
    ).toBe(true);
  });

  it("aucune machine pour les autres transitions (annulation depuis la commande en cours comprise)", async () => {
    for (const status of ["draft", "survey", "preorder", "ordering"] as const) {
      const lot = await lotAt(status);
      expect(await machinesOf(lot), status).toHaveLength(0);
    }
    const lot = await lotAt("ordering");
    await moveBatch(lot, "ordering", "cancelled");
    expect(await machinesOf(lot)).toHaveLength(0);
  });

  it("retour inspection > Attente de réception : ne crée que le manquant, jamais de doublon", async () => {
    const lot = await lotAt("inspection", 2);
    expect(await machinesOf(lot)).toHaveLength(2);
    await moveBatch(lot, "inspection", "awaiting_reception");
    expect(await machinesOf(lot)).toHaveLength(2);
  });
});

describe("6. clôture d'une palette : invendus au lot de stock", () => {
  /** Palette en transit : `sold` machines vendues et livrées, les autres reçues et contrôlées (`functional`). */
  async function palette(quantity: number, sold: number) {
    const lot = await lotAt("inspection", quantity);
    const machines = await machinesOf(lot);
    for (const m of machines) await receiveAndCheck(m.id);
    for (const m of machines.slice(0, sold)) {
      const orderId = await placeOrder({ catalog, batchId: lot, customer: await createUser() });
      await pay(orderId);
      const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
      await prisma.orderLineAssignment.create({
        data: { order_line_id: line.id, batch_id: lot, machine_id: m.id, changed_by_auth_user_id: 1n },
      });
    }
    await moveBatch(lot, "inspection", "packaging");
    await moveBatch(lot, "packaging", "in_transit");
    return { lot, machines };
  }

  it("invendus en main transférés (motif batch_closed, auteur de la transition), sans recréation ; lot de stock créé en brouillon", async () => {
    const { lot, machines } = await palette(3, 1);
    await moveBatch(lot, "in_transit", "closed");
    const stock = await prisma.batch.findFirstOrThrow({ where: { kind: "stock", model_id: catalog.modelId } });
    expect(stock).toMatchObject({ status: "draft", name: "Stock S19", quantity: null, purchase_price: null });
    expect(await prisma.machine.count()).toBe(3);
    const moved = await machinesOf(stock.id);
    expect(moved.map((m) => m.id).sort()).toEqual(machines.slice(1).map((m) => m.id).sort());
    expect(moved.every((m) => m.origin_batch_id === lot)).toBe(true);
    const log = await prisma.machineTransfer.findMany({ where: { from_batch_id: lot } });
    expect(log.map((t) => [t.to_batch_id, t.reason, t.changed_by_auth_user_id])).toEqual([
      [stock.id, "batch_closed", 1n],
      [stock.id, "batch_closed", 1n],
    ]);
    expect((await machinesOf(lot)).map((m) => m.id)).toEqual([machines[0].id]);
  });

  it("lot de stock existant : réutilisé ; rien à transférer : aucun lot créé", async () => {
    const stock = await stockAt("on_sale");
    const { lot } = await palette(2, 0);
    await moveBatch(lot, "in_transit", "closed");
    expect(await prisma.batch.count({ where: { kind: "stock" } })).toBe(1);
    expect(await machinesOf(stock)).toHaveLength(2);

    const other = await otherCatalog();
    const empty = await createBatch(other, { quantity: 1, status: "awaiting_reception" });
    for (const [f, t] of [["awaiting_reception", "inspection"], ["inspection", "packaging"], ["packaging", "in_transit"], ["in_transit", "closed"]] as const) {
      await moveBatch(empty, f, t);
    }
    expect(await prisma.batch.count({ where: { kind: "stock", model_id: other.modelId } })).toBe(0);
  });
});
