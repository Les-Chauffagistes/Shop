import { beforeEach, describe, expect, it } from "vitest";
import { cancelPaidLines, listOrderBlocks, releaseOrderBlock } from "@/server/backoffice-orders";
import { pgFailureOf } from "@/server/errors";
import { getOrderingStatus, renounceOrder } from "@/server/orders";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  cancelOrder,
  type Catalog,
  createBatch,
  createCatalog,
  createUser,
  type Customer,
  EXPECTED_SATS,
  failureOf,
  pay,
  placeOrder,
  REFUND_ADDRESS,
  setRefundAddress,
  setShopSettings,
} from "./fixtures";

// Jalon L1 (décisions de Hugo du 2026-11-05, migration l1_renounce_fee_refund_address_block_expiry) :
//   1. frais réseau d'un renoncement à la charge de la boutique (refund_cause_fee_payer) ;
//   2. adresse de remboursement obligatoire à la création, jamais effacée (Order_refund_address_required) ;
//   3. blocage anti-abus : renoncements et abandons comptés ensemble, blocage borné qui se lève seul.
// Expirations jouées en antidatant la base (factures expirées il y a N heures), jamais en attendant.

let catalog: Catalog;
let alice: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
});

const HOUR = 3_600_000;
const ADMIN = { authUserId: ADMIN_AUTH_USER_ID.toString() };
const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;

/** Facture abandonnée : expirée sans paiement il y a `hoursAgo` heures (antidatée). */
const abandonedHoursAgo = (customer: Customer, batchId: string, hoursAgo: number) =>
  placeOrder({ catalog, batchId, customer, expiredMinutesAgo: Math.round(hoursAgo * 60) });

/** Commande payée de `lines` machines. */
async function paidOrder(customer: Customer, batchId: string, lines = 1) {
  const orderId = await placeOrder({ catalog, batchId, customer, lines: Array(lines).fill(false) });
  await pay(orderId);
  return orderId;
}

/** Commande payée d'une machine, puis renoncement de l'utilisateur (un événement). */
async function renounced(customer: Customer, batchId: string) {
  const orderId = await paidOrder(customer, batchId);
  await renounceOrder(customer.userId, orderId, {});
  return orderId;
}

async function block(batchId: string, customer: Customer) {
  const [row] = await prisma.$queryRaw<{ blocked_at: Date; ends_at: Date }[]>`
    SELECT "blocked_at", "ends_at" FROM "user_batch_block"(${batchId}::uuid, ${customer.userId}::uuid)`;
  return row ?? null;
}

const tryOrder = (customer: Customer, batchId: string) => constraintOf(placeOrder({ catalog, batchId, customer }));

describe("frais réseau d'un renoncement : à la charge de la boutique", () => {
  it("renoncement de l'utilisateur : tout le prorata rendu, frais tracés à part ; le motif ne laisse pas le choix", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(alice, batchId, 2);
    const [first] = await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } });
    await renounceOrder(alice.userId, orderId, { lineIds: [first.id] });
    const [refund] = await prisma.refund.findMany({ where: { order_id: orderId } });
    expect(refund).toMatchObject({ cause: "user_renounce", initiated_by: "user", network_fee_payer: "shop", amount_sats: EXPECTED_SATS / 2n });
    expect(refund.network_fee_sats).toBeGreaterThan(0n);
  });

  it("annulation par l'admin à la demande de l'utilisateur (cancel-lines, user_renounce) : même règle", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(alice, batchId);
    const detail = await cancelPaidLines(orderId, { reason: "Demande par e-mail", cause: "user_renounce" }, ADMIN);
    expect(detail.refunds).toEqual([
      expect.objectContaining({ cause: "user_renounce", initiatedBy: "admin", networkFeePayer: "shop", amountSats: EXPECTED_SATS.toString() }),
    ]);
    expect(detail.status).toBe("refunded");
  });

  it("restent à la charge de l'utilisateur : excédent et paiement partiel", async () => {
    const rows = await prisma.$queryRaw<{ cause: string; payer: string }[]>`
      SELECT c::text AS "cause", "refund_cause_fee_payer"(c)::text AS "payer"
      FROM unnest(ARRAY['user_renounce', 'overpayment', 'partial_payment']::"refund_cause"[]) c`;
    expect(Object.fromEntries(rows.map((r) => [r.cause, r.payer]))).toEqual({ user_renounce: "shop", overpayment: "user", partial_payment: "user" });
  });
});

describe("adresse de remboursement obligatoire (Order_refund_address_required)", () => {
  it("refusée sans adresse à la création ; remplaçable, jamais effacée ; une facture d'avant l1 en reçoit une", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    // Toute nouvelle facture, quel que soit l'écrivain : la base refuse
    expect(
      await constraintOf(
        prisma.order.create({
          data: {
            user_id: alice.userId, batch_id: batchId, billing_address_id: alice.addressId, shipping_address_id: alice.addressId,
            total_amount: 50_000n, expected_sats: EXPECTED_SATS, payment_address: "bc1ql1noaddress00000000000000000000000000",
            contact_email: "client@exemple.fr",
          },
        }),
      ),
    ).toBe("Order_refund_address_required");

    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).refund_address).toBe(REFUND_ADDRESS);
    const other = "bc1ql1otheraddress000000000000000000000000";
    await setRefundAddress(orderId, other, "admin");
    expect(await constraintOf(setRefundAddress(orderId, null))).toBe("Order_refund_address_required");
    expect(await constraintOf(setRefundAddress(orderId, null, "admin"))).toBe("Order_refund_address_required");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).refund_address).toBe(other);

    // Facture existante sans adresse (antérieure à l1) : intacte, peut en recevoir une, puis ne la perd plus
    const bob = await createUser();
    const legacy = await placeOrder({ catalog, batchId, customer: bob, refundAddress: null });
    await cancelOrder(prisma, legacy); // une autre écriture de la facture n'exige rien
    await setRefundAddress(legacy, REFUND_ADDRESS);
    expect(await constraintOf(setRefundAddress(legacy, null))).toBe("Order_refund_address_required");
  });
});

describe("blocage anti-abus : renoncements et abandons, levée automatique", () => {
  it("réglages par défaut : 3 événements sur 30 jours, blocage de 72 h, durée bornée en base", async () => {
    const [s] = await prisma.$queryRaw<{ limit: number; window: number; duration: number }[]>`
      SELECT "abandoned_order_limit" AS "limit", "abandoned_order_window_hours" AS "window", "order_block_duration_hours" AS "duration"
      FROM "shop_settings"()`;
    expect(s).toEqual({ limit: 3, window: 720, duration: 72 });
    expect(await constraintOf(setShopSettings({ order_block_duration_hours: 0 }))).toBe("ShopSettings_block_duration_check");
    expect(await constraintOf(setShopSettings({ order_block_duration_hours: 721 }))).toBe("ShopSettings_block_duration_check");
  });

  it("les renoncements comptent avec les abandons ; ils ne déclenchent pas le délai de quelques minutes", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    await renounced(alice, batchId);
    await renounced(alice, batchId);
    // Deux renoncements : ni délai ni blocage, une nouvelle facture passe tout de suite
    expect(await block(batchId, alice)).toBeNull();
    const pending = await placeOrder({ catalog, batchId, customer: alice });
    await cancelOrder(prisma, pending); // 3e événement : un abandon

    const b = (await block(batchId, alice))!;
    const { cancelled_at } = await prisma.order.findUniqueOrThrow({ where: { id: pending } });
    expect(b.blocked_at).toEqual(cancelled_at);
    expect(b.ends_at.getTime() - b.blocked_at.getTime()).toBe(72 * HOUR);
    expect(await tryOrder(alice, batchId)).toBe("Order_abandoned_limit");

    // Trois renoncements seuls suffisent aussi (un autre utilisateur, même lot)
    const bob = await createUser();
    for (let i = 0; i < 3; i++) await renounced(bob, batchId);
    expect(await block(batchId, bob)).not.toBeNull();

    // Vu par l'utilisateur (avant l'envoi) et par l'admin
    const status = await getOrderingStatus(alice.userId, batchId);
    expect(status).toMatchObject({ blockedAt: b.blocked_at.toISOString(), blockEndsAt: b.ends_at.toISOString() });
    expect(status.refusal).toMatchObject({ code: "order_creation_blocked", details: { blockEndsAt: b.ends_at.toISOString() } });
    expect(status.refusal!.message).toContain("jusqu'au");
    const { items } = await listOrderBlocks({ batchId });
    expect(items.find((i) => i.user.id === alice.userId)).toMatchObject({
      blockedAt: b.blocked_at.toISOString(),
      blockEndsAt: b.ends_at.toISOString(),
      abandonedOrders: 3,
    });
  });

  it("levée automatique à l'échéance (horloge de la base), sans intervention ; les événements d'avant ne comptent plus", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    for (const hours of [76, 75, 74]) await abandonedHoursAgo(alice, batchId, hours);
    // Bloqué il y a 74 h pour 72 h : levé depuis 2 h, sans OrderBlockRelease
    expect(await block(batchId, alice)).toBeNull();
    expect(await prisma.orderBlockRelease.count()).toBe(0);
    expect((await listOrderBlocks({ batchId })).items).toEqual([]);
    expect((await getOrderingStatus(alice.userId, batchId)).refusal).toBeNull();

    // Les trois abandons restent dans la fenêtre de 30 jours, mais le blocage levé les a effacés : un 4e ne rebloque pas
    const fourth = await placeOrder({ catalog, batchId, customer: alice });
    await cancelOrder(prisma, fourth);
    expect(await block(batchId, alice)).toBeNull();
    await setShopSettings({ abandoned_order_cooldown_minutes: 0 });
    await placeOrder({ catalog, batchId, customer: alice });
  });

  it("encore en cours une heure avant l'échéance ; la durée est lue dans les réglages", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    for (const hours of [73, 72, 71]) await abandonedHoursAgo(alice, batchId, hours);
    const b = (await block(batchId, alice))!;
    expect(b.ends_at.getTime() - Date.now()).toBeGreaterThan(0);
    expect(b.ends_at.getTime() - Date.now()).toBeLessThan(HOUR + 60_000);
    expect(await tryOrder(alice, batchId)).toBe("Order_abandoned_limit");

    // Durée raccourcie à 24 h : la même série est levée
    await setShopSettings({ order_block_duration_hours: 24 });
    expect(await block(batchId, alice)).toBeNull();
    await placeOrder({ catalog, batchId, customer: alice });
  });

  it("événements pendant un blocage échu : ils comptent pour le blocage suivant", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    for (const hours of [200, 199, 198]) await abandonedHoursAgo(alice, batchId, hours); // bloqué de -198 h à -126 h
    for (const hours of [150, 140]) await abandonedHoursAgo(alice, batchId, hours); // abandons pendant ce blocage
    expect(await block(batchId, alice)).toBeNull();

    const pending = await placeOrder({ catalog, batchId, customer: alice });
    await renounced(alice, await createBatch(catalog, { quantity: 5 })); // un autre lot ne compte pas
    expect(await block(batchId, alice)).toBeNull();
    await cancelOrder(prisma, pending); // 150 h, 140 h et maintenant : 3 événements après le blocage précédent
    expect(await block(batchId, alice)).not.toBeNull();
  });

  it("la levée manuelle par l'admin reste possible avant l'échéance", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    for (const hours of [3, 2, 1]) await abandonedHoursAgo(alice, batchId, hours);
    expect(await block(batchId, alice)).not.toBeNull();
    await releaseOrderBlock({ userId: alice.userId, batchId, reason: "Client contacté" }, ADMIN);
    expect(await block(batchId, alice)).toBeNull();
    expect((await listOrderBlocks({ batchId })).items).toEqual([]);
    await placeOrder({ catalog, batchId, customer: alice });
  });

  it("refus de création expliqué avec la date de levée, sans renvoyer vers l'admin", async () => {
    const batchId = await createBatch(catalog, { quantity: 10 });
    for (const hours of [3, 2, 1]) await abandonedHoursAgo(alice, batchId, hours);
    const refusal = (await getOrderingStatus(alice.userId, batchId)).refusal!;
    expect(refusal.code).toBe("order_creation_blocked");
    expect(refusal.message).toMatch(/renoncement : les commandes sont suspendues pour vous sur ce lot jusqu'au \d+ \S+ à \d\d:\d\d\.$/);
    expect(refusal.message).not.toContain("Contactez-nous");
  });
});
