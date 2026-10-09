import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  cancelOrder as cancel,
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
  untilAnotherSessionWaitsOnLock,
  writeFullRefund,
  writeUserRefund,
} from "./fixtures";

// Jalon 4, migration v5b : annulation d'une facture impayée, facture expirée partiellement payée
// (choix de l'utilisateur, frais à sa charge en cas de remboursement), sommes « à traiter » par
// l'admin, fin des commandes au Packaging.

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
      awaiting_user_decision: boolean;
      needs_admin_decision: boolean;
      unsettled_sats: bigint;
    }[]
  >`SELECT "outstanding_sats", "refunded_sats", "refund_due_sats", "awaiting_decision",
           "awaiting_user_decision", "needs_admin_decision", "unsettled_sats"
    FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row;
}

describe("annulation d'une facture en attente impayée (cancelled)", () => {
  it("libère la réservation tout de suite (délai pour l'utilisateur) ; jamais supprimée", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: bob }))).toBe("Batch_stock");

    await cancel(prisma, orderId);
    expect(await orderOf(orderId)).toMatchObject({ status: "cancelled", paid_at: null, expired_at: null });
    // La place est libre pour un autre ; l'annulation est un abandon : délai pour l'utilisateur (v5c)
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: alice }))).toBe("Order_abandoned_cooldown");
    await placeOrder({ catalog, batchId, customer: bob });

    expect(await constraintOf(prisma.order.delete({ where: { id: orderId } }))).toBe("Order_no_delete");
    expect(await constraintOf(prisma.order.update({ where: { id: orderId }, data: { cancelled_at: new Date(0) } }))).toBe(
      "Order_immutable",
    );
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_decision: false, unsettled_sats: 0n });
  });

  it("refusée si un paiement a été reçu, si la facture a expiré ou n'est plus en attente ; date posée par la base", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const partial = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, partial, 1_000n);
    expect(await constraintOf(cancel(prisma, partial))).toBe("Order_cancel_unpaid");

    const expired = await placeOrder({ catalog, batchId, customer: bob, expiredMinutesAgo: 10 });
    expect(await constraintOf(cancel(prisma, expired))).toBe("Order_cancel_expired");
    await prisma.order.update({ where: { id: expired }, data: { status: "expired", expired_at: new Date() } });
    expect(await constraintOf(cancel(prisma, expired))).toBe("Order_status_transition");

    // Date d'annulation posée par la base (horloge de la base, valeur fournie ignorée)
    const carol = await createUser();
    const live = await placeOrder({ catalog, batchId, customer: carol });
    const cancelled = await prisma.order.update({ where: { id: live }, data: { status: "cancelled", cancelled_at: new Date(0) } });
    expect(cancelled.cancelled_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const dave = await createUser();
    const other = await placeOrder({ catalog, batchId, customer: dave });
    await pay(other);
    expect(await constraintOf(cancel(prisma, other))).toBe("Order_status_transition");
  });

  it("paiement arrivé après l'annulation : jamais refusé, à traiter par l'admin, qui l'accepte s'il reste de la place", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await cancel(prisma, orderId);
    await receivePayment(prisma, orderId, EXPECTED_SATS);
    expect(await balanceOf(orderId)).toMatchObject({
      awaiting_decision: false, refund_due_sats: 0n, needs_admin_decision: true, unsettled_sats: EXPECTED_SATS,
    });

    await pay(orderId);
    const order = await orderOf(orderId);
    expect(order).toMatchObject({ status: "paid" });
    expect(order.cancelled_at).not.toBeNull(); // trace de l'annulation conservée
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_decision: false, unsettled_sats: 0n });
  });

  it("paiement arrivé après l'annulation sans place : l'acceptation échoue (Batch_stock), l'admin rembourse", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await cancel(prisma, orderId);
    await pay(await placeOrder({ catalog, batchId, customer: bob }));
    await receivePayment(prisma, orderId, EXPECTED_SATS);

    expect(await constraintOf(pay(orderId))).toBe("Batch_stock");
    await prisma.$transaction((tx) => writeFullRefund(tx, orderId));
    expect(await orderOf(orderId)).toMatchObject({ status: "refunded" });
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_decision: false, unsettled_sats: 0n });
  });

  it("concurrence : un paiement validé avant l'annulation la fait échouer ; après, il devient « à traiter »", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });

    // Paiement d'abord : l'annulation attend la ligne Order puis voit le montant reçu
    const first = await placeOrder({ catalog, batchId, customer: alice });
    let cancelling: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await receivePayment(tx, first, 1_000n);
      cancelling = failureOf(cancel(prisma, first));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await cancelling!)?.constraint).toBe("Order_cancel_unpaid");
    expect((await orderOf(first)).status).toBe("pending_payment");

    // Annulation d'abord : le paiement attend, puis s'ajoute à la facture annulée
    const second = await placeOrder({ catalog, batchId, customer: bob });
    let paying: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await cancel(tx, second);
      paying = receivePayment(prisma, second, 2_000n).then(() => undefined); // .then : la requête part tout de suite
      await untilAnotherSessionWaitsOnLock();
    });
    await paying;
    expect(await orderOf(second)).toMatchObject({ status: "cancelled", received_sats: 2_000n });
    expect(await balanceOf(second)).toMatchObject({ needs_admin_decision: true, unsettled_sats: 2_000n });
  });
});

describe("facture expirée partiellement payée : l'utilisateur choisit l'appoint ou le remboursement", () => {
  it("en attente de décision de l'utilisateur ; l'appoint est accepté s'il reste de la place", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    await receivePayment(prisma, orderId, 30_000n);
    expect(await balanceOf(orderId)).toMatchObject({
      outstanding_sats: 50_000n, awaiting_user_decision: true, awaiting_decision: false,
      needs_admin_decision: false, refund_due_sats: 0n, unsettled_sats: 30_000n,
    });
    await pay(orderId); // appoint puis paid
    expect(await balanceOf(orderId)).toMatchObject({ awaiting_user_decision: false, unsettled_sats: 0n });
  });

  it("une facture encore vivante partiellement payée n'attend pas de décision (l'appoint court)", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, orderId, 30_000n);
    expect(await balanceOf(orderId)).toMatchObject({ awaiting_user_decision: false, outstanding_sats: 50_000n });
  });

  it("remboursement choisi : frais réseau déduits de ce que reçoit l'utilisateur, tout le reçu sort du solde", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    await receivePayment(prisma, orderId, 30_000n);

    // Frais à sa charge : il ne reçoit pas tout le montant en plus des frais
    expect(await constraintOf(prisma.$transaction((tx) => writeUserRefund(tx, orderId, 400n, 30_000n)))).toBe("Order_refunds");
    expect(await constraintOf(prisma.$transaction((tx) => writeUserRefund(tx, orderId, 400n, 29_000n)))).toBe(
      "Order_refunded_in_full",
    );
    await prisma.$transaction((tx) => writeUserRefund(tx, orderId, 400n));

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { refunds: true } });
    expect(order).toMatchObject({ status: "refunded", paid_at: null });
    expect(order.refunds).toMatchObject([{ amount_sats: 29_600n, network_fee_sats: 400n, network_fee_payer: "user" }]);
    expect(await balanceOf(orderId)).toMatchObject({
      refunded_sats: 30_000n, unsettled_sats: 0n, awaiting_user_decision: false, needs_admin_decision: false,
    });

    // Payeur des frais figé ; frais figés une fois envoyé
    const [refund] = order.refunds;
    expect(
      await constraintOf(prisma.refund.update({ where: { id: refund.id }, data: { network_fee_payer: "shop" } })),
    ).toBe("Refund_immutable");
    await prisma.refund.update({ where: { id: refund.id }, data: { sent_at: new Date(), reference: "txid-refund", destination_address: "bc1qaliceretour0000000000000000000000000" } });
    expect(await constraintOf(prisma.refund.update({ where: { id: refund.id }, data: { network_fee_sats: 300n } }))).toBe(
      "Refund_sent_frozen",
    );
  });

  it("frais à la charge de l'utilisateur seulement pour un paiement partiel non accepté d'un lot ouvert", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const userRefund = (orderId: string) => prisma.$transaction((tx) => writeUserRefund(tx, orderId, 400n));

    // Rien reçu : rien à rembourser (l'annulation est le chemin)
    const live = await placeOrder({ catalog, batchId, customer: alice });
    expect(await constraintOf(userRefund(live))).toBe("Refund_partial_payment_allowed");

    // Paiement complet (à accepter, ou à rembourser par la boutique s'il n'y a plus de place)
    const complete = await placeOrder({ catalog, batchId, customer: bob, expiredMinutesAgo: 10 });
    await receivePayment(prisma, complete, EXPECTED_SATS);
    expect(await constraintOf(userRefund(complete))).toBe("Refund_partial_payment_allowed");

    // Lot abandonné : l'appoint est impossible, les frais restent à la boutique
    const other = await createBatch(catalog, { quantity: 5 });
    const abandoned = await placeOrder({ catalog, batchId: other, customer: alice, expiredMinutesAgo: 10 });
    await receivePayment(prisma, abandoned, 30_000n);
    await moveBatch(other, "preorder", "cancelled");
    expect(await constraintOf(userRefund(abandoned))).toBe("Refund_partial_payment_allowed");
    expect(await balanceOf(abandoned)).toMatchObject({ awaiting_user_decision: false, needs_admin_decision: true });

    // Forme (v5f) : le payeur des frais suit le motif (un rabais est à la charge de la boutique) ; frais connus
    const carol = await createUser();
    const partial = await placeOrder({ catalog, batchId, customer: carol, expiredMinutesAgo: 10 });
    await receivePayment(prisma, partial, 30_000n);
    const refund = (data: Partial<Prisma.RefundUncheckedCreateInput>) =>
      prisma.refund.create({
        data: {
          order_id: partial, kind: "cancellation", cause: "partial_payment", initiated_by: "user", amount: 100n, amount_sats: 1n,
          network_fee_payer: "user", reason: "x", ...data,
        },
      });
    expect(
      await constraintOf(refund({ kind: "discount", cause: "discount", initiated_by: "admin", created_by_auth_user_id: 1n, network_fee_sats: 10n })),
    ).toBe("Refund_cause_fee_payer");
    expect(await constraintOf(refund({ network_fee_sats: null }))).toBe("Refund_fee_payer_check");
  });

  it("concurrence : un appoint validé avant la demande de remboursement la fait échouer", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    await receivePayment(prisma, orderId, 30_000n);

    let refunding: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await receivePayment(tx, orderId, 50_000n); // appoint complet, ligne Order verrouillée
      refunding = failureOf(prisma.$transaction((tx2) => writeUserRefund(tx2, orderId, 400n, 29_600n)));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await refunding!)?.constraint).toBe("Refund_partial_payment_allowed");
    expect(await balanceOf(orderId)).toMatchObject({ awaiting_decision: true, awaiting_user_decision: false });
  });
});

describe("sommes « à traiter » par l'admin (needs_admin_decision)", () => {
  it("excédent d'une facture payée : remboursé d'office (refund_due_sats), pas une décision de l'admin", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, orderId, EXPECTED_SATS + 5_000n);
    await pay(orderId);
    expect(await balanceOf(orderId)).toMatchObject({ refund_due_sats: 5_000n, unsettled_sats: 5_000n, needs_admin_decision: false });
  });

  it("paiement complet sur un lot qui n'accepte plus de commandes : ni accepté d'office, ni remboursé d'office", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await moveBatch(batchId, "preorder", "cancelled");
    await receivePayment(prisma, orderId, EXPECTED_SATS);
    expect(await balanceOf(orderId)).toMatchObject({ awaiting_decision: false, refund_due_sats: 0n, needs_admin_decision: true });
    expect(await constraintOf(pay(orderId))).toBe("Order_batch_open");
  });
});

describe("statut maximal acceptant des commandes : Packaging (batch_accepts_orders)", () => {
  it("en transit : plus de nouvelle facture ni de paiement accepté", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const pending = await placeOrder({ catalog, batchId, customer: alice });
    await moveBatch(batchId, "inspection", "tuning");
    await moveBatch(batchId, "tuning", "packaging");
    await placeOrder({ catalog, batchId, customer: bob }); // Packaging : encore ouvert

    await moveBatch(batchId, "packaging", "in_transit");
    const carol = await createUser();
    expect(await constraintOf(placeOrder({ catalog, batchId, customer: carol }))).toBe("Order_batch_open");
    await receivePayment(prisma, pending, EXPECTED_SATS);
    expect(await constraintOf(pay(pending))).toBe("Order_batch_open");
    expect(await balanceOf(pending)).toMatchObject({ needs_admin_decision: true });
  });
});
