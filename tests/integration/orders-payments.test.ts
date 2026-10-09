import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  barrier,
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
  setShopSettings,
  SILENT_PRICE,
  untilAnotherSessionWaitsOnLock,
  wish,
  writeFullRefund,
  writeOrder,
  writePayment,
} from "./fixtures";

// Jalon 4 (migration v5) : priorité, garde-fous anti-accaparement, paiements partiels et excédents,
// remboursements au prorata, factures jamais supprimées, concurrence.

type Tx = Prisma.TransactionClient;

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

async function balanceOf(orderId: string) {
  const [row] = await prisma.$queryRaw<
    {
      outstanding_sats: bigint;
      refunded_sats: bigint;
      refund_due_sats: bigint;
      awaiting_decision: boolean;
      needs_admin_decision: boolean;
      unsettled_sats: bigint;
    }[]
  >`SELECT "outstanding_sats", "refunded_sats", "refund_due_sats", "awaiting_decision", "needs_admin_decision", "unsettled_sats"
    FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row;
}

async function prorata(orderId: string, amount: bigint) {
  const [{ sats }] = await prisma.$queryRaw<{ sats: bigint }[]>`
    SELECT "refund_prorata_sats"(${orderId}::uuid, ${amount}) AS sats`;
  return sats;
}

/** Facture expirée (sans changer son statut) ; `minutesAgo` : fin de réservation. */
const expiredOrder = (customer: Customer, batchId: string, minutesAgo: number, lines?: boolean[]) =>
  placeOrder({ catalog, batchId, customer, lines, expiredMinutesAgo: minutesAgo });

/** Passe une facture à paid si elle est intégralement payée (comme le futur service de paiement). */
const acceptIfComplete = (tx: Tx, orderId: string) => tx.$executeRaw`
  UPDATE "Order" SET "status" = 'paid', "paid_at" = now()
  WHERE "id" = ${orderId}::uuid AND "status" IN ('pending_payment', 'expired') AND "received_sats" >= "expected_sats"`;

describe("journée de priorité à l'ouverture des précommandes (Order_priority_window, OrderLine_priority_quota)", () => {
  const machinesLeft = async (batchId: string, customer: Customer) => {
    const [{ left }] = await prisma.$queryRaw<{ left: number | null }[]>`
      SELECT "order_priority_machines_left"(${batchId}::uuid, ${customer.userId}::uuid) AS left`;
    return left;
  };

  it("pendant un jour, un utilisateur commande au plus autant de machines que de wishlists actives", async () => {
    const batchId = await createBatch(catalog, { quantity: 10, status: "survey", priorityOpen: true });
    const [w1, w2] = [await wish(catalog, batchId, alice), await wish(catalog, batchId, alice)];
    const opening = await moveBatch(batchId, "survey", "preorder");

    const [{ ends }] = await prisma.$queryRaw<{ ends: Date }[]>`SELECT "batch_priority_ends_at"(${batchId}::uuid) AS ends`;
    expect(ends.getTime() - opening.created_at.getTime()).toBe(24 * 3_600_000);
    expect(await machinesLeft(batchId, alice)).toBe(2);
    expect(await machinesLeft(batchId, bob)).toBe(0);

    // Sans wishlist : refusé dès la facture ; au-delà du quota : refusé à la ligne
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: bob }))).toBe("Order_priority_window");
    expect(
      await constraintOf(placeOrder({ catalog, batchId, customer: alice, lines: [false, true, false], wishlistId: w1.id })),
    ).toBe("OrderLine_priority_quota");

    // Une facture expirée n'occupe pas le stock : elle ne consomme pas le quota
    await placeOrder({ catalog, batchId, customer: alice, lines: [false, false], expiredMinutesAgo: 10 });
    expect(await machinesLeft(batchId, alice)).toBe(2);

    const orderId = await placeOrder({ catalog, batchId, customer: alice, lines: [false, true], wishlistId: w2.id });
    expect(await machinesLeft(batchId, alice)).toBe(0);
    await pay(orderId);
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice }))).toBe("Order_priority_window");
  });

  it("retirer une wishlist réduit le quota ; la facture déjà créée garde son statut et se paie", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "survey", priorityOpen: true });
    const [w1, w2] = [await wish(catalog, batchId, alice), await wish(catalog, batchId, alice)];
    await wish(catalog, batchId, bob);
    await moveBatch(batchId, "survey", "preorder");
    const orderId = await placeOrder({ catalog, batchId, customer: alice, lines: [false, false], wishlistId: w1.id });

    await prisma.wishlist.update({ where: { id: w2.id }, data: { cancelled_at: new Date() } });
    expect(await machinesLeft(batchId, alice)).toBe(0);
    expect((await orderOf(orderId)).status).toBe("pending_payment");
    await pay(orderId);
    expect((await orderOf(orderId)).status).toBe("paid");
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice }))).toBe("Order_priority_window");
  });

  it("lot sans wishlist active : pas de journée de priorité (sondage sans intérêt, ou dernière wishlist retirée)", async () => {
    const empty = await createBatch(catalog, { quantity: 5, status: "survey", priorityOpen: true });
    await moveBatch(empty, "survey", "preorder");
    const [{ ends }] = await prisma.$queryRaw<{ ends: Date | null }[]>`SELECT "batch_priority_ends_at"(${empty}::uuid) AS ends`;
    expect(ends).toBeNull();
    expect(await machinesLeft(empty, bob)).toBeNull();
    await placeOrder({ catalog, batchId: empty, customer: bob, lines: [false, false, false] });

    const withdrawn = await createBatch(catalog, { quantity: 5, status: "survey", priorityOpen: true });
    const only = await wish(catalog, withdrawn, alice);
    await moveBatch(withdrawn, "survey", "preorder");
    expect(await constraintOf(placeOrder({ catalog, batchId: withdrawn, customer: bob }))).toBe("Order_priority_window");
    await prisma.wishlist.update({ where: { id: only.id }, data: { cancelled_at: new Date() } });
    await placeOrder({ catalog, batchId: withdrawn, customer: bob });
  });

  it("après la journée : premier arrivé, premier servi ; une wishlist retirée ne se commande plus", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "survey" });
    const wishlist = await wish(catalog, batchId, alice);
    await prisma.wishlist.update({ where: { id: wishlist.id }, data: { cancelled_at: new Date() } });
    await moveBatch(batchId, "survey", "preorder", new Date(Date.now() - 36 * 3_600_000));

    await placeOrder({ catalog, batchId, customer: bob, lines: [false, false] });
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice, wishlistId: wishlist.id }))).toBe(
      "OrderLine_wishlist_live",
    );
  });

  it("lot ouvert sans sondage : personne n'est prioritaire", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "draft", priorityOpen: true });
    await moveBatch(batchId, "draft", "preorder");
    const [{ ends }] = await prisma.$queryRaw<{ ends: Date | null }[]>`SELECT "batch_priority_ends_at"(${batchId}::uuid) AS ends`;
    expect(ends).toBeNull();
    await placeOrder({ catalog, batchId, customer: bob });
  });

  it("concurrence : la facture suivante du même utilisateur attend la première et voit son quota consommé", async () => {
    const batchId = await createBatch(catalog, { quantity: 10, status: "survey", priorityOpen: true });
    const w1 = await wish(catalog, batchId, alice);
    await wish(catalog, batchId, alice);
    await moveBatch(batchId, "survey", "preorder");
    let second: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      const id = await writeOrder(tx, { catalog, batchId, customer: alice, lines: [false, false], wishlistId: w1.id });
      await writePayment(tx, id);
      second = failureOf(placeOrder({ catalog, batchId, customer: alice })); // bloquée sur le verrou de l'utilisateur
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await second!)?.constraint).toBe("Order_priority_window");
    expect(await prisma.order.count()).toBe(1);
  });

  it("une wishlist au plus une fois par facture", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "survey" });
    const wishlist = await wish(catalog, batchId, alice);
    await moveBatch(batchId, "survey", "preorder", new Date(Date.now() - 36 * 3_600_000));
    const error = await failureOf(
      prisma.$transaction(async (tx) => {
        const orderId = await writeOrder(tx, { catalog, batchId, customer: alice, wishlistId: wishlist.id });
        const line = await tx.orderLine.findFirstOrThrow({ where: { order_id: orderId } });
        const copy = await tx.configuration.create({
          data: {
            batch_id: batchId,
            model_id: catalog.modelId,
            base_price: line.amount,
            items: { create: { option_id: catalog.optionId, option_value_id: catalog.noKitId, unit_price: 0n } },
          },
        });
        await tx.orderLine.create({
          data: { order_id: orderId, user_id: alice.userId, batch_id: batchId, configuration_id: copy.id, wishlist_id: wishlist.id, amount: line.amount },
        });
      }),
    );
    expect(pgFailureOf(error)?.constraint).toBe("OrderLine_order_id_wishlist_id_key");
  });
});

describe("garde-fous anti-accaparement (ShopSettings)", () => {
  it("une seule facture en attente vivante par utilisateur et par lot ; un autre lot reste permis", async () => {
    const first = await createBatch(catalog, { quantity: 5 });
    const second = await createBatch(catalog, { quantity: 5 });
    const orderId = await placeOrder({ catalog, batchId: first, customer: alice });
    expect(await constraintOf(placeOrder({ catalog, batchId: first, customer: alice }))).toBe("Order_one_live_per_user_batch");
    await placeOrder({ catalog, batchId: second, customer: alice });

    // Une fois payée, la facture n'est plus « en attente » : la suivante passe
    await pay(orderId);
    await placeOrder({ catalog, batchId: first, customer: alice });
  });

  it("délai après une facture expirée impayée (5 min par défaut), par utilisateur et par lot, réglable", async () => {
    const first = await createBatch(catalog, { quantity: 5 });
    const second = await createBatch(catalog, { quantity: 5 });
    await expiredOrder(alice, first, 2);
    expect(await constraintOf(placeOrder({ catalog, batchId: first, customer: alice }))).toBe("Order_abandoned_cooldown");
    // Autre lot, ou autre utilisateur sur le même lot : pas de délai
    await placeOrder({ catalog, batchId: second, customer: alice });
    await placeOrder({ catalog, batchId: first, customer: bob });

    await setShopSettings({ abandoned_order_cooldown_minutes: 1 });
    await placeOrder({ catalog, batchId: first, customer: alice });
  });

  it("une facture expirée intégralement payée (paiement tardif) n'impose pas de délai ; un paiement partiel, si", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const paidLate = await expiredOrder(alice, batchId, 2);
    await receivePayment(prisma, paidLate, EXPECTED_SATS);
    await placeOrder({ catalog, batchId, customer: alice });

    const partial = await expiredOrder(bob, batchId, 2);
    await receivePayment(prisma, partial, EXPECTED_SATS / 2n);
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: bob }))).toBe("Order_abandoned_cooldown");
  });

  it("10 machines au plus par facture, réglable (à l'insertion seulement)", async () => {
    const batchId = await createBatch(catalog, { quantity: 30 });
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice, lines: Array(11).fill(false) }))).toBe(
      "Order_max_lines",
    );
    const ten = await placeOrder({ catalog, batchId, customer: alice, lines: Array(10).fill(false) });

    await setShopSettings({ order_max_lines: 2 });
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: bob, lines: [false, false, false] }))).toBe(
      "Order_max_lines",
    );
    // La facture existante de 10 lignes n'est pas touchée : elle se paie
    await pay(ten);
  });

  it("plafond de wishlists par utilisateur et par lot (Wishlist_cap), borné par la quantité, réactivation comprise", async () => {
    const small = await createBatch(catalog, { quantity: 3, status: "survey" });
    for (let i = 0; i < 3; i++) await wish(catalog, small, alice);
    expect(await constraintOf(wish(catalog, small, alice))).toBe("Wishlist_cap");

    await setShopSettings({ wishlist_max_per_user_per_batch: 1 });
    const batchId = await createBatch(catalog, { quantity: 10, status: "survey" });
    const first = await wish(catalog, batchId, bob);
    expect(await constraintOf(wish(catalog, batchId, bob))).toBe("Wishlist_cap");
    await prisma.wishlist.update({ where: { id: first.id }, data: { cancelled_at: new Date() } });
    await wish(catalog, batchId, bob);
    expect(
      await constraintOf(prisma.wishlist.update({ where: { id: first.id }, data: { cancelled_at: null } })),
    ).toBe("Wishlist_cap");
  });

  it("réglages bornés, une seule ligne, jamais supprimée", async () => {
    expect(await constraintOf(setShopSettings({ order_max_lines: 0 }))).toBe("ShopSettings_order_max_lines_check");
    expect(await constraintOf(setShopSettings({ wishlist_max_per_user_per_batch: 1001 }))).toBe("ShopSettings_wishlist_max_check");
    expect(await constraintOf(setShopSettings({ abandoned_order_cooldown_minutes: -1 }))).toBe("ShopSettings_cooldown_check");
    expect(await constraintOf(setShopSettings({ abandoned_order_limit: 0 }))).toBe("ShopSettings_abandoned_limit_check");
    expect(await constraintOf(setShopSettings({ abandoned_order_window_hours: 721 }))).toBe("ShopSettings_abandoned_window_check");
    expect(await constraintOf(prisma.shopSettings.create({ data: { id: 2 } }))).toBe("ShopSettings_single_row_check");
    expect(await constraintOf(prisma.shopSettings.delete({ where: { id: 1 } }))).toBe("ShopSettings_no_delete");
  });
});

describe("paiements (Payment) : appoint, excédent, paiement jamais refusé", () => {
  it("paiement partiel : la facture attend l'appoint, payée seulement une fois complète", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, orderId, 30_000n);
    expect(await orderOf(orderId)).toMatchObject({ status: "pending_payment", received_sats: 30_000n });
    expect(await balanceOf(orderId)).toMatchObject({ outstanding_sats: 50_000n, awaiting_decision: false });

    expect(
      await constraintOf(prisma.order.update({ where: { id: orderId }, data: { status: "paid", paid_at: new Date() } })),
    ).toBe("Order_paid_in_full_check");

    await receivePayment(prisma, orderId, 50_000n);
    expect(await balanceOf(orderId)).toMatchObject({ outstanding_sats: 0n, awaiting_decision: true });
    await prisma.$transaction((tx) => acceptIfComplete(tx, orderId));
    expect(await orderOf(orderId)).toMatchObject({ status: "paid", received_sats: EXPECTED_SATS });
    expect(await prisma.payment.count({ where: { order_id: orderId } })).toBe(2);
  });

  it("received_sats n'est tenu que par les paiements ; journal append-only ; une sortie de transaction une fois", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    const payment = await receivePayment(prisma, orderId, 1_000n);

    expect(await constraintOf(prisma.order.update({ where: { id: orderId }, data: { received_sats: 80_000n } }))).toBe(
      "Order_received_via_payment",
    );
    expect(await constraintOf(prisma.payment.update({ where: { id: payment.id }, data: { amount_sats: 2_000n } }))).toBe(
      "Payment_append_only",
    );
    expect(await constraintOf(prisma.payment.delete({ where: { id: payment.id } }))).toBe("Payment_append_only");
    expect(
      await constraintOf(prisma.payment.create({ data: { order_id: orderId, amount_sats: 5n, txid: payment.txid, vout: payment.vout } })),
    ).toBe("Payment_txid_vout_key");
    expect(
      await constraintOf(prisma.payment.create({ data: { order_id: orderId, amount_sats: 0n, txid: "t", vout: 1 } })),
    ).toBe("Payment_amount_sats_check");
  });

  it("excédent : facture payée, excédent dû (order_payment_balance), remboursement plafonné à l'excédent", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, orderId, 100_000n);
    await prisma.$transaction((tx) => acceptIfComplete(tx, orderId));
    expect(await balanceOf(orderId)).toMatchObject({ refund_due_sats: 20_000n });

    // Excédent (v5f) : frais réseau à la charge de l'utilisateur, plafond sur le brut (versé + frais)
    const overpayment = (amount_sats: bigint, amount = 0n, network_fee_sats = 300n) =>
      prisma.refund.create({
        data: {
          order_id: orderId, kind: "overpayment", cause: "overpayment", initiated_by: "admin", created_by_auth_user_id: 1n,
          network_fee_payer: "user", network_fee_sats, amount, amount_sats, reason: "Excédent",
        },
      });
    expect(await constraintOf(overpayment(19_701n))).toBe("Refund_overpayment"); // brut 20 001 > excédent 20 000
    expect(await constraintOf(overpayment(1_000n, 100n))).toBe("Refund_kind_check");
    expect(await constraintOf(overpayment(1n, 0n, -1n))).toBe("Refund_network_fee_sats_check");
    // L'utilisateur reçoit l'excédent moins les frais ; tout l'excédent est sorti du solde
    await overpayment(19_700n);
    expect(await balanceOf(orderId)).toMatchObject({ refund_due_sats: 0n, refunded_sats: 20_000n });
    expect((await orderOf(orderId)).status).toBe("paid");
  });

  it("un paiement n'est jamais refusé : lot abandonné, puis paiement arrivé après le remboursement intégral (décision de l'admin)", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await moveBatch(batchId, "preorder", "cancelled");
    await receivePayment(prisma, orderId, EXPECTED_SATS);
    // Pas de remboursement d'office : à traiter par l'admin
    expect(await balanceOf(orderId)).toMatchObject({
      refund_due_sats: 0n, awaiting_decision: false, needs_admin_decision: true, unsettled_sats: EXPECTED_SATS,
    });
    await prisma.$transaction((tx) => writeFullRefund(tx, orderId));
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_decision: false, unsettled_sats: 0n });

    await receivePayment(prisma, orderId, 1_500n);
    expect(await balanceOf(orderId)).toMatchObject({ refund_due_sats: 0n, needs_admin_decision: true, unsettled_sats: 1_500n });
    await prisma.refund.create({
      data: {
        order_id: orderId, kind: "overpayment", cause: "admin_other", initiated_by: "admin", created_by_auth_user_id: 1n,
        amount: 0n, amount_sats: 1_500n, reason: "Paiement après remboursement",
      },
    });
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_decision: false, unsettled_sats: 0n, refunded_sats: EXPECTED_SATS + 1_500n });
  });

  it("appoint après expiration : accepté s'il reste de la place", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await expiredOrder(alice, batchId, 5);
    await receivePayment(prisma, orderId, 30_000n);
    await prisma.order.update({ where: { id: orderId }, data: { status: "expired", expired_at: new Date() } });
    await pay(orderId); // reçoit l'appoint puis paid (Order_stock : il reste la place)
    expect(await orderOf(orderId)).toMatchObject({ status: "paid", received_sats: EXPECTED_SATS });
  });

  it("appoint jamais venu : ce qui a été reçu se rembourse, même s'il reste de la place", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await expiredOrder(alice, batchId, 5);
    await receivePayment(prisma, orderId, 30_000n);
    await prisma.$transaction((tx) => writeFullRefund(tx, orderId));
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { refunds: true } });
    expect(order).toMatchObject({ status: "refunded", paid_at: null });
    expect(order.refunds.map((r) => r.amount_sats)).toEqual([30_000n]);
  });

  it("rien reçu : pas de remboursement possible", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await expiredOrder(alice, batchId, 5);
    expect(
      await constraintOf(prisma.order.update({ where: { id: orderId }, data: { status: "refunded", refunded_at: new Date() } })),
    ).toBe("Order_refunded_payment_check");
  });
});

describe("remboursements partiels au prorata de ce qui a été payé", () => {
  /** Annule la ligne `lineId` (remboursement d'annulation) sans changer le statut. */
  const cancelLine = (tx: Tx, orderId: string, lineId: string, amount: bigint, sats: bigint) =>
    tx.refund
      .create({
        data: {
          order_id: orderId, kind: "cancellation", cause: "admin_other", initiated_by: "admin", created_by_auth_user_id: 1n,
          amount, amount_sats: sats, reason: "Ligne annulée",
        },
      })
      .then((refund) => tx.orderLine.update({ where: { id: lineId }, data: { refund_id: refund.id } }));

  it("annulation d'une ligne, rabais, puis annulation du reste : le cumul suit le prorata, le total égale le reçu", async () => {
    const batchId = await createBatch(catalog, { quantity: 3 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, lines: [true, false] });
    await pay(orderId);
    const [silent, plain] = await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { amount: "desc" } });
    expect(silent.amount + plain.amount).toBe(107_500n);

    // 80 000 × 50 000 / 107 500 = 37 209,30 sats
    const sats = await prorata(orderId, plain.amount);
    expect(sats).toBe(37_209n);
    expect(await constraintOf(prisma.$transaction((tx) => cancelLine(tx, orderId, plain.id, plain.amount, 40_000n)))).toBe(
      "Refund_prorata",
    );
    await prisma.$transaction((tx) => cancelLine(tx, orderId, plain.id, plain.amount, sats));

    // Rabais de 100 € sans ligne : cumul 60 000 c → 44 651 sats, soit 7 442 de plus
    const discount = await prorata(orderId, 10_000n);
    expect(discount).toBe(7_442n);
    expect(
      await constraintOf(
        prisma.refund.create({
          data: {
            order_id: orderId, kind: "cancellation", cause: "admin_other", initiated_by: "admin", created_by_auth_user_id: 1n,
            amount: 10_000n, amount_sats: discount, reason: "x",
          },
        }),
      ),
    ).toBe("Refund_kind_lines");
    await prisma.refund.create({
      data: {
        order_id: orderId, kind: "discount", cause: "discount", initiated_by: "admin", created_by_auth_user_id: 1n,
        amount: 10_000n, amount_sats: discount, reason: "Hashboard",
      },
    });

    // Annulation du reste : ce qui reste de la facture (47 500 c) et tout le reçu restant
    await prisma.$transaction(async (tx) => {
      await cancelLine(tx, orderId, silent.id, 47_500n, EXPECTED_SATS - sats - discount);
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded", refunded_at: new Date() } });
    });
    expect(await balanceOf(orderId)).toMatchObject({ refunded_sats: EXPECTED_SATS, refund_due_sats: 0n });
  });

  it("annulation totale d'une facture payée avec excédent : le prix est rendu en entier, l'excédent part ou reste « à traiter » (v5i)", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, orderId, 90_000n);
    await prisma.$transaction((tx) => acceptIfComplete(tx, orderId));
    const [line] = await prisma.orderLine.findMany({ where: { order_id: orderId } });
    const refundAll = (cancelSats: bigint, overpaymentSats: bigint) =>
      prisma.$transaction(async (tx) => {
        await cancelLine(tx, orderId, line.id, line.amount, cancelSats);
        if (overpaymentSats > 0n) {
          await tx.refund.create({
            data: {
              order_id: orderId, kind: "overpayment", cause: "admin_other", initiated_by: "admin", created_by_auth_user_id: 1n,
              amount: 0n, amount_sats: overpaymentSats, reason: "Excédent",
            },
          });
        }
        await tx.order.update({ where: { id: orderId }, data: { status: "refunded", refunded_at: new Date() } });
      });
    // Le prix payé (80 000 sats) doit être rendu en entier, même si l'excédent couvre la différence
    expect(await constraintOf(refundAll(EXPECTED_SATS - 5_000n, 15_000n))).toBe("Order_refunded_in_full");
    // Une partie de l'excédent seulement : le reste (5 000 sats) attend la décision de l'admin
    await refundAll(EXPECTED_SATS, 5_000n);
    expect(await balanceOf(orderId)).toMatchObject({ unsettled_sats: 5_000n, needs_admin_decision: true });
  });
});

describe("on ne supprime jamais une facture", () => {
  it("ni facture, ni ligne ; montants, taux et adresse de paiement figés ; adresse jamais réutilisée", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    const order = await orderOf(orderId);
    const [line] = await prisma.orderLine.findMany({ where: { order_id: orderId } });

    expect(await constraintOf(prisma.order.delete({ where: { id: orderId } }))).toBe("Order_no_delete");
    expect(await constraintOf(prisma.orderLine.delete({ where: { id: line.id } }))).toBe("OrderLine_no_delete");
    for (const data of [{ expected_sats: 1n }, { payment_address: "bc1qautre" }, { total_amount: 1n }]) {
      expect(await constraintOf(prisma.order.update({ where: { id: orderId }, data }))).toBe("Order_immutable");
    }
    const reuse = await failureOf(
      prisma.$transaction(async (tx) => {
        const id = await writeOrder(tx, { catalog, batchId, customer: bob });
        await tx.order.update({ where: { id }, data: { payment_address: order.payment_address } });
      }),
    );
    expect(pgFailureOf(reuse)?.constraint).toBe("Order_immutable");
    expect(
      await constraintOf(
        prisma.order.create({
          data: {
            user_id: bob.userId,
            batch_id: batchId,
            billing_address_id: bob.addressId,
            shipping_address_id: bob.addressId,
            total_amount: 1n,
            expected_sats: 1n,
            payment_address: order.payment_address,
          },
        }),
      ),
    ).toBe("Order_payment_address_key");
  });

  it("une facture survit au retrait de sa wishlist et à l'archivage de ses adresses", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const wishlist = await wish(catalog, batchId, alice);
    await moveBatch(batchId, "survey", "preorder", new Date(Date.now() - 36 * 3_600_000));
    const orderId = await placeOrder({ catalog, batchId, customer: alice, wishlistId: wishlist.id });
    await prisma.wishlist.update({ where: { id: wishlist.id }, data: { cancelled_at: new Date() } });
    await prisma.address.update({ where: { id: alice.addressId }, data: { archived_at: new Date() } });
    await pay(orderId);
    expect((await orderOf(orderId)).status).toBe("paid");
  });
});

describe("Configuration.updated_at (tenue par la base)", () => {
  it("suit les changements de choix d'une configuration ouverte ; le verrouillage par une commande n'y touche pas", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "survey" });
    const wishlist = await wish(catalog, batchId, alice);
    await prisma.$executeRaw`
      UPDATE "Configuration" SET "updated_at" = "created_at" - interval '1 hour' WHERE "id" = ${wishlist.configuration_id}::uuid`;
    await prisma.configurationItem.update({
      where: { configuration_id_option_id: { configuration_id: wishlist.configuration_id, option_id: catalog.optionId } },
      data: { option_value_id: catalog.silentId, unit_price: SILENT_PRICE },
    });
    const touched = await prisma.configuration.findUniqueOrThrow({ where: { id: wishlist.configuration_id } });
    // created_at et updated_at viennent tous deux de l'horloge de la base (v5g) : comparables
    expect(touched.updated_at.getTime()).toBeGreaterThanOrEqual(touched.created_at.getTime());

    const preorder = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId: preorder, customer: bob });
    const [line] = await prisma.orderLine.findMany({ where: { order_id: orderId }, include: { configuration: true } });
    expect(line.configuration.locked_at).not.toBeNull();
    expect(line.configuration.updated_at).toEqual(line.configuration.created_at);
  });
});

describe("statuts publics et ouverts aux commandes", () => {
  it("batch_is_public = sondage + batch_accepts_orders (précommande à packaging ; en transit refusé)", async () => {
    const rows = await prisma.$queryRaw<{ st: string; open: boolean; public: boolean }[]>`
      SELECT st::text, "batch_accepts_orders"(st) AS open, "batch_is_public"(st) AS public
      FROM unnest(enum_range(NULL::batch_status)) st`;
    const open = rows.filter((r) => r.open).map((r) => r.st);
    expect(open).toEqual(["preorder", "ordering", "awaiting_reception", "inspection", "tuning", "packaging"]);
    expect(rows.filter((r) => r.public).map((r) => r.st)).toEqual(["survey", ...open]);
  });
});

describe("concurrence (READ COMMITTED)", () => {
  it("plafond de stock : 4 clients pour 2 places, 2 passent", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const customers = [alice, bob, await createUser(), await createUser()];
    const sync = barrier(customers.length);
    const results = await Promise.allSettled(
      customers.map((customer) =>
        prisma.$transaction(async (tx) => {
          await writeOrder(tx, { catalog, batchId, customer });
          await sync.wait(); // toutes les factures écrites avant le premier COMMIT
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results) if (r.status === "rejected") expect(pgFailureOf(r.reason)?.constraint).toBe("Batch_stock");
    expect(await prisma.order.count()).toBe(2);
  });

  it("une seule facture vivante : la seconde création simultanée du même utilisateur attend la première puis est refusée", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    let second: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await writeOrder(tx, { catalog, batchId, customer: alice });
      second = failureOf(placeOrder({ catalog, batchId, customer: alice })); // bloquée sur le verrou de l'utilisateur
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await second!)?.constraint).toBe("Order_one_live_per_user_batch");
    expect(await prisma.order.count()).toBe(1);
  });

  it("paiements simultanés sur une même facture : les montants s'additionnent, la facture est payée une fois", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    let second: Promise<number> | undefined;
    await prisma.$transaction(async (tx) => {
      await receivePayment(tx, orderId, 40_000n);
      second = prisma.$transaction(async (tx2) => {
        await receivePayment(tx2, orderId, 40_000n); // attend la ligne Order
        return acceptIfComplete(tx2, orderId);
      });
      await untilAnotherSessionWaitsOnLock();
      expect(await acceptIfComplete(tx, orderId)).toBe(0); // 40 000 sur 80 000 : pas encore
    });
    expect(await second!).toBe(1);
    expect(await orderOf(orderId)).toMatchObject({ status: "paid", received_sats: EXPECTED_SATS });
    expect(await prisma.payment.count({ where: { order_id: orderId } })).toBe(2);
  });

  it("deux paiements tardifs complets pour la dernière place : un accepté, l'autre remboursé", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const late = [await expiredOrder(alice, batchId, 10), await expiredOrder(bob, batchId, 10)];
    // Le service enregistre d'abord chaque paiement (jamais refusé), puis tente de l'accepter
    for (const id of late) await receivePayment(prisma, id, EXPECTED_SATS);
    const sync = barrier(2);
    const results = await Promise.allSettled(
      late.map((id) =>
        prisma.$transaction(async (tx) => {
          await acceptIfComplete(tx, id);
          await sync.wait();
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = late[results.findIndex((r) => r.status === "rejected")];
    expect(pgFailureOf((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)?.constraint).toBe("Batch_stock");

    const [{ fits }] = await prisma.$queryRaw<{ fits: boolean }[]>`SELECT "Order_fits_stock"(${loser}::uuid) AS fits`;
    expect(fits).toBe(false);
    await prisma.$transaction((tx) => writeFullRefund(tx, loser));
    expect((await orderOf(loser)).status).toBe("refunded");
  });

  it("paiement tardif contre nouvelle facture sur la place libérée : une seule passe", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const late = await expiredOrder(alice, batchId, 10);
    const sync = barrier(2);
    const results = await Promise.allSettled([
      prisma.$transaction(async (tx) => {
        await writePayment(tx, late);
        await sync.wait();
      }),
      prisma.$transaction(async (tx) => {
        await writeOrder(tx, { catalog, batchId, customer: bob });
        await sync.wait();
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
