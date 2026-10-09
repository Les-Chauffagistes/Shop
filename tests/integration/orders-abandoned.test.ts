import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
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
  moveBatch,
  pay,
  placeOrder,
  receivePayment,
  setRefundAddress,
  setShopSettings,
  untilAnotherSessionWaitsOnLock,
  wish,
  writeFullRefund,
  writeOrder,
  writeUserRefund,
} from "./fixtures";

// Jalon 4, migration v5c : anti-accaparement sous toutes ses formes (délai après tout abandon,
// plafond d'abandons par utilisateur et par lot jusqu'à la levée de l'admin), paiement partiel qui ne
// réserve que jusqu'à l'expiration, remboursement d'un paiement partiel avant l'expiration, paiement
// partiel inférieur aux frais réseau, fin anticipée de la journée de priorité.

let catalog: Catalog;
let alice: Customer;
let bob: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
  bob = await createUser();
});

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const userRefund = (orderId: string, feeSats: bigint, amountSats?: bigint) =>
  prisma.$transaction((tx) => writeUserRefund(tx, orderId, feeSats, amountSats));

async function balanceOf(orderId: string) {
  const [row] = await prisma.$queryRaw<
    {
      awaiting_user_decision: boolean;
      needs_admin_decision: boolean;
      needs_admin_attention: boolean;
      user_refund_allowed: boolean;
      abandoned_at: Date | null;
    }[]
  >`SELECT "awaiting_user_decision", "needs_admin_decision", "needs_admin_attention", "user_refund_allowed", "abandoned_at"
    FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row;
}

async function cooldownEndsAt(batchId: string, customer: Customer) {
  const [{ at }] = await prisma.$queryRaw<{ at: Date | null }[]>`
    SELECT "user_batch_cooldown_ends_at"(${batchId}::uuid, ${customer.userId}::uuid) AS at`;
  return at;
}

async function blockedAt(batchId: string, customer: Customer) {
  const [{ at }] = await prisma.$queryRaw<{ at: Date | null }[]>`
    SELECT "user_batch_blocked_at"(${batchId}::uuid, ${customer.userId}::uuid) AS at`;
  return at;
}

const blocks = () =>
  prisma.$queryRaw<{ user_id: string; batch_id: string; abandoned_orders: number }[]>`
    SELECT "user_id"::text, "batch_id"::text, "abandoned_orders" FROM "order_creation_blocks"`;

const release = (batchId: string, customer: Customer) =>
  prisma.orderBlockRelease.create({
    data: { batch_id: batchId, user_id: customer.userId, released_by_auth_user_id: ADMIN_AUTH_USER_ID, reason: "Contacté, bonne foi" },
  });

/** Facture déjà expirée (abandonnée) il y a `hoursAgo` heures. */
const abandonedHoursAgo = (customer: Customer, batchId: string, hoursAgo: number) =>
  placeOrder({ catalog, batchId, customer, expiredMinutesAgo: hoursAgo * 60 });

/** Crée une facture vivante puis l'annule. */
const placeAndCancel = async (customer: Customer, batchId: string) =>
  cancelOrder(prisma, await placeOrder({ catalog, batchId, customer }));

describe("délai après tout abandon (Order_abandoned_cooldown), par utilisateur et par lot", () => {
  it("annulation : délai de 5 min ; un autre lot ou un autre utilisateur ne sont pas concernés ; réglable", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const other = await createBatch(catalog, { quantity: 5 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await cancelOrder(prisma, orderId);

    const { cancelled_at } = await orderOf(orderId);
    expect((await cooldownEndsAt(batchId, alice))!.getTime()).toBe(cancelled_at!.getTime() + 5 * 60_000);
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice }))).toBe("Order_abandoned_cooldown");
    await placeOrder({ catalog, batchId: other, customer: alice });
    await placeOrder({ catalog, batchId, customer: bob });

    await setShopSettings({ abandoned_order_cooldown_minutes: 0 });
    expect(await cooldownEndsAt(batchId, alice)).toBeNull();
    await placeOrder({ catalog, batchId, customer: alice });
  });

  it("annuler juste avant l'expiration ou laisser expirer : même effet (abandon daté de la fin)", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const expired = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 1 });
    expect((await balanceOf(expired)).abandoned_at).toEqual((await orderOf(expired)).expires_at);
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice }))).toBe("Order_abandoned_cooldown");

    await placeAndCancel(bob, batchId);
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: bob }))).toBe("Order_abandoned_cooldown");
  });
});

describe("plafond d'abandons (Order_abandoned_limit) : blocage jusqu'à la levée de l'admin", () => {
  it("chaîne annulation → recréation : au 3e abandon en 24 h, plus aucune facture sur ce lot, même déjà expirée", async () => {
    await setShopSettings({ abandoned_order_cooldown_minutes: 0 });
    const batchId = await createBatch(catalog, { quantity: 5 });
    const other = await createBatch(catalog, { quantity: 5 });
    for (let i = 0; i < 2; i++) await placeAndCancel(alice, batchId);
    expect(await blockedAt(batchId, alice)).toBeNull();
    await placeAndCancel(alice, batchId);

    expect(await blockedAt(batchId, alice)).not.toBeNull();
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice }))).toBe("Order_abandoned_limit");
    expect(await constraintOf(abandonedHoursAgo(alice, batchId, 1))).toBe("Order_abandoned_limit");
    await placeOrder({ catalog, batchId: other, customer: alice });
    await placeOrder({ catalog, batchId, customer: bob });
    expect(await blocks()).toEqual([{ user_id: alice.userId, batch_id: batchId, abandoned_orders: 3 }]);

    // L'admin lève le blocage : les abandons antérieurs ne comptent plus ; journal append-only
    const lift = await release(batchId, alice);
    expect(await blocks()).toEqual([]);
    await placeOrder({ catalog, batchId, customer: alice });
    expect(await constraintOf(prisma.orderBlockRelease.update({ where: { id: lift.id }, data: { reason: "x" } }))).toBe(
      "OrderBlockRelease_append_only",
    );
    expect(await constraintOf(prisma.orderBlockRelease.delete({ where: { id: lift.id } }))).toBe("OrderBlockRelease_append_only");
    expect(
      await constraintOf(
        prisma.orderBlockRelease.create({ data: { batch_id: batchId, user_id: bob.userId, released_by_auth_user_id: 0n } }),
      ),
    ).toBe("OrderBlockRelease_released_by_check");
  });

  it("fenêtre glissante : des abandons espacés ne bloquent pas ; un blocage ne cesse pas avec le temps", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    for (const hours of [72, 40, 10]) await abandonedHoursAgo(alice, batchId, hours);
    expect(await blockedAt(batchId, alice)).toBeNull();
    await placeAndCancel(alice, batchId); // 10 h et maintenant : 2 abandons sur 24 h
    expect(await blockedAt(batchId, alice)).toBeNull();

    // Trois abandons en 10 h, il y a deux jours : toujours bloqué
    for (const hours of [50, 45, 40]) await abandonedHoursAgo(bob, batchId, hours);
    const third = await prisma.order.findFirstOrThrow({ where: { user_id: bob.userId }, orderBy: { expires_at: "desc" } });
    expect(await blockedAt(batchId, bob)).toEqual(third.expires_at);
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: bob }))).toBe("Order_abandoned_limit");

    // Réglages lus à chaque création : une fenêtre plus courte ne voit plus trois abandons groupés
    await setShopSettings({ abandoned_order_window_hours: 1 });
    await placeOrder({ catalog, batchId, customer: bob });
  });

  it("factures d'une ou de dix machines : un abandon par facture", async () => {
    await setShopSettings({ abandoned_order_cooldown_minutes: 0, abandoned_order_limit: 2 });
    const batchId = await createBatch(catalog, { quantity: 20 });
    await cancelOrder(prisma, await placeOrder({ catalog, batchId, customer: alice, lines: Array(10).fill(false) }));
    await placeAndCancel(alice, batchId);
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice }))).toBe("Order_abandoned_limit");
  });

  it("n'est pas un abandon : une facture payée, ou payée intégralement en retard sans place ; un appoint accepté efface l'abandon", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const partial = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    await receivePayment(prisma, partial, 30_000n);
    expect((await balanceOf(partial)).abandoned_at).toEqual((await orderOf(partial)).expires_at);
    await pay(partial); // appoint, accepté (il reste la place)
    expect((await balanceOf(partial)).abandoned_at).toBeNull();

    const late = await placeOrder({ catalog, batchId, customer: bob, expiredMinutesAgo: 10 });
    await receivePayment(prisma, late, EXPECTED_SATS);
    expect(await constraintOf(pay(late))).toBe("Batch_stock");
    await prisma.$transaction((tx) => writeFullRefund(tx, late)); // aux frais de la boutique
    expect((await balanceOf(late)).abandoned_at).toBeNull();
  });

  it("une facture annulée payée ensuite reste un abandon tant que l'admin ne l'accepte pas", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await cancelOrder(prisma, orderId);
    await receivePayment(prisma, orderId, EXPECTED_SATS);
    expect((await balanceOf(orderId)).abandoned_at).toEqual((await orderOf(orderId)).cancelled_at);
    await pay(orderId);
    expect((await balanceOf(orderId)).abandoned_at).toBeNull();
  });

  it("le blocage n'empêche pas de payer une facture existante (accepté s'il reste de la place)", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const kept = await abandonedHoursAgo(alice, batchId, 3);
    for (const hours of [2, 1]) await abandonedHoursAgo(alice, batchId, hours);
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice }))).toBe("Order_abandoned_limit");
    await pay(kept);
    expect((await orderOf(kept)).status).toBe("paid");
  });

  it("concurrence : la création suivante attend le verrou de l'utilisateur et voit l'abandon validé entre-temps", async () => {
    await setShopSettings({ abandoned_order_cooldown_minutes: 0, abandoned_order_limit: 2 });
    const batchId = await createBatch(catalog, { quantity: 5 });
    await placeAndCancel(alice, batchId);
    let next: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      const id = await writeOrder(tx, { catalog, batchId, customer: alice }); // verrou de l'utilisateur
      await cancelOrder(tx, id); // 2e abandon, pas encore validé
      next = failureOf(placeOrder({ catalog, batchId, customer: alice }));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await next!)?.constraint).toBe("Order_abandoned_limit");
  });
});

describe("paiement partiel : la place ne dure que jusqu'à l'expiration", () => {
  it("vivante, elle réserve ; expirée, plus rien, et les appoints successifs ne prolongent rien", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const live = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, live, 10_000n);
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: bob }))).toBe("Batch_stock");
    expect(await constraintOf(cancelOrder(prisma, live))).toBe("Order_cancel_unpaid"); // le chemin est le remboursement

    const other = await createBatch(catalog, { quantity: 1 });
    const expired = await placeOrder({ catalog, batchId: other, customer: alice, expiredMinutesAgo: 1 });
    const { expires_at } = await orderOf(expired);
    for (const sats of [10_000n, 20_000n, 30_000n]) await receivePayment(prisma, expired, sats);
    expect(await orderOf(expired)).toMatchObject({ status: "pending_payment", expires_at, received_sats: 60_000n });

    // La place est libre : un autre la prend ; l'appoint final ne passe plus
    await pay(await placeOrder({ catalog, batchId: other, customer: bob }));
    expect(await constraintOf(pay(expired))).toBe("Batch_stock");
    const [{ fits }] = await prisma.$queryRaw<{ fits: boolean }[]>`SELECT "Order_fits_stock"(${expired}::uuid) AS fits`;
    expect(fits).toBe(false);
  });

  it("remboursement avant l'expiration : frais à la charge de l'utilisateur, place libérée tout de suite, abandon compté", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, orderId, 30_000n);
    expect(await balanceOf(orderId)).toMatchObject({ user_refund_allowed: true, awaiting_user_decision: false, abandoned_at: null });

    await userRefund(orderId, 400n);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { refunds: true } });
    expect(order).toMatchObject({ status: "refunded", paid_at: null });
    expect(order.refunds).toMatchObject([{ amount_sats: 29_600n, network_fee_sats: 400n, network_fee_payer: "user" }]);
    // v5e : aucune adresse de remboursement (ni sur le remboursement ni sur la facture) : « à traiter »
    expect(await balanceOf(orderId)).toMatchObject({ user_refund_allowed: false, needs_admin_attention: true, abandoned_at: order.refunded_at });
    await setRefundAddress(orderId, "bc1qalicerefund00000000000000000000000000");
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_attention: false });

    await placeOrder({ catalog, batchId, customer: bob }); // la place est libre
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice }))).toBe("Order_abandoned_cooldown");
  });

  it("concurrence : la facture d'un autre client qui attend le verrou du lot prend la place libérée au COMMIT", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, orderId, 30_000n);
    let bobOrder: Promise<string> | undefined;
    await prisma.$transaction(async (tx) => {
      await writeUserRefund(tx, orderId, 400n);
      await tx.$queryRaw`SELECT "Batch_lock"(${batchId}::uuid)`; // verrou du lot pris avant le COMMIT
      bobOrder = placeOrder({ catalog, batchId, customer: bob }); // contrôle de stock bloqué au COMMIT
      await untilAnotherSessionWaitsOnLock();
    });
    expect((await orderOf(await bobOrder!)).status).toBe("pending_payment");
  });

  it("paiement inférieur aux frais réseau : remboursement refusé (Refund_user_net_positive), la facture attend l'appoint, « à traiter »", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 5 });
    await receivePayment(prisma, orderId, 300n);
    expect(await constraintOf(userRefund(orderId, 400n))).toBe("Refund_user_net_positive");
    expect(await constraintOf(userRefund(orderId, 300n))).toBe("Refund_user_net_positive");
    expect(await orderOf(orderId)).toMatchObject({ status: "pending_payment", received_sats: 300n });
    expect(await balanceOf(orderId)).toMatchObject({
      awaiting_user_decision: true, needs_admin_decision: false, needs_admin_attention: true, user_refund_allowed: true,
    });

    // Ajustement des frais d'un remboursement non envoyé : même règle
    const other = await placeOrder({ catalog, batchId, customer: bob, expiredMinutesAgo: 5 });
    await receivePayment(prisma, other, 1_000n);
    await userRefund(other, 400n);
    const [refund] = await prisma.refund.findMany({ where: { order_id: other } });
    expect(
      await constraintOf(prisma.refund.update({ where: { id: refund.id }, data: { amount_sats: 0n, network_fee_sats: 1_000n } })),
    ).toBe("Refund_user_net_positive");

    // L'appoint complet est accepté
    await pay(orderId);
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_attention: false, abandoned_at: null });
  });
});

describe("journée de priorité : fin anticipée quand toutes les wishlists actives sont converties", () => {
  const priorityEnd = async (batchId: string) => {
    const [{ ends }] = await prisma.$queryRaw<{ ends: Date | null }[]>`SELECT "batch_priority_ends_at"(${batchId}::uuid) AS ends`;
    return ends;
  };

  it("se termine à la dernière conversion ; ensuite premier arrivé, premier servi", async () => {
    const carol = await createUser();
    const batchId = await createBatch(catalog, { quantity: 10, status: "survey", priorityOpen: true });
    const [wa, wb] = [await wish(catalog, batchId, alice), await wish(catalog, batchId, bob)];
    // Ouverture il y a une minute, conversions datées d'une seconde : l'horloge de l'hôte peut avancer sur celle de la base
    const opening = await moveBatch(batchId, "survey", "preorder", new Date(Date.now() - 60_000));
    expect((await priorityEnd(batchId))!.getTime()).toBe(opening.created_at.getTime() + 24 * 3_600_000);

    await pay(await placeOrder({ catalog, batchId, customer: alice, wishlistId: wa.id }), new Date(Date.now() - 2_000));
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: carol }))).toBe("Order_priority_window");

    await pay(await placeOrder({ catalog, batchId, customer: bob, wishlistId: wb.id }), new Date(Date.now() - 1_000));
    const bobPaid = await prisma.order.findFirstOrThrow({ where: { user_id: bob.userId, status: "paid" } });
    expect(await priorityEnd(batchId)).toEqual(bobPaid.paid_at);
    await placeOrder({ catalog, batchId, customer: carol, lines: [false, false] });
  });

  it("une wishlist retirée ne retient pas la journée ; une conversion remboursée la fait reprendre", async () => {
    const carol = await createUser();
    const batchId = await createBatch(catalog, { quantity: 10, status: "survey", priorityOpen: true });
    const [wa, wb] = [await wish(catalog, batchId, alice), await wish(catalog, batchId, bob)];
    await moveBatch(batchId, "survey", "preorder", new Date(Date.now() - 60_000));
    await prisma.wishlist.update({ where: { id: wb.id }, data: { cancelled_at: new Date() } });
    const converted = await placeOrder({ catalog, batchId, customer: alice, wishlistId: wa.id });
    await pay(converted, new Date(Date.now() - 1_000));
    expect((await priorityEnd(batchId))!.getTime()).toBeLessThanOrEqual(Date.now());
    const [{ left }] = await prisma.$queryRaw<{ left: number | null }[]>`
      SELECT "order_priority_machines_left"(${batchId}::uuid, ${carol.userId}::uuid) AS left`;
    expect(left).toBeNull();

    await prisma.$transaction((tx) => writeFullRefund(tx, converted));
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: carol }))).toBe("Order_priority_window");
  });

  it("toutes les wishlists retirées avant l'ouverture : pas de journée de priorité", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "survey", priorityOpen: true });
    const only = await wish(catalog, batchId, alice);
    await prisma.wishlist.update({ where: { id: only.id }, data: { cancelled_at: new Date() } });
    await moveBatch(batchId, "survey", "preorder");
    expect(await priorityEnd(batchId)).toBeNull();
    await placeOrder({ catalog, batchId, customer: bob });
  });
});
