import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  type Catalog,
  cancelOrder,
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
  SILENT_PRICE,
  wish,
  writeOrder,
} from "./fixtures";

// Jalon 4, migration v5i (décisions de Hugo du 2026-10-09) : e-mail du client figé sur la facture, classement
// sans suite d'un petit excédent, reliquat d'un renoncement complet laissé à l'admin, factures impayées annulées
// quand le lot ferme les commandes, option retirée d'une wishlist figée.

type Tx = Prisma.TransactionClient;

let catalog: Catalog;
let alice: Customer;
let bob: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
  bob = await createUser();
});

const FEE = 2_000n;
const ADMIN = { initiated_by: "admin", created_by_auth_user_id: ADMIN_AUTH_USER_ID } as const;

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

async function balanceOf(orderId: string) {
  const [row] = await prisma.$queryRaw<
    {
      status: string;
      unsettled_sats: bigint;
      refunded_sats: bigint;
      refund_due_sats: bigint;
      needs_admin_decision: boolean;
      needs_admin_attention: boolean;
      overpayment_unrefunded: boolean;
      dismissed_sats: bigint;
    }[]
  >`SELECT "status"::text AS "status", "unsettled_sats", "refunded_sats", "refund_due_sats", "needs_admin_decision",
      "needs_admin_attention", "overpayment_unrefunded", "dismissed_sats"
    FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row;
}

/** Commande payée d'une ligne, avec `extraSats` reçus en trop. */
async function paidOrder(batchId: string, customer: Customer, extraSats = 0n) {
  const orderId = await placeOrder({ catalog, batchId, customer });
  await prisma.$transaction(async (tx) => {
    await receivePayment(tx, orderId, EXPECTED_SATS + extraSats);
    await tx.order.update({ where: { id: orderId }, data: { status: "paid", paid_at: new Date() } });
  });
  return orderId;
}

const dismiss = (orderId: string, sats: bigint, { fee = FEE, reason = null as string | null, db = prisma as Tx | typeof prisma } = {}) =>
  db.orderExcessDismissal.create({
    data: { order_id: orderId, sats, network_fee_sats: fee, reason, dismissed_by_auth_user_id: ADMIN_AUTH_USER_ID },
  });

/** Annule toutes les lignes de la facture dans `tx` (un remboursement d'annulation) et la passe à remboursée. */
async function refundWhole(
  tx: Tx,
  orderId: string,
  refund: Omit<Prisma.RefundUncheckedCreateInput, "order_id" | "kind" | "amount" | "reason">,
) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const created = await tx.refund.create({
    data: { order_id: orderId, kind: "cancellation", amount: order.total_amount, reason: "Annulation de toute la facture", ...refund },
  });
  await tx.orderLine.updateMany({ where: { order_id: orderId }, data: { refund_id: created.id } });
  await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
}

describe("(1) e-mail du client, figé sur la facture", () => {
  it("saisi à la création, format contrôlé par la base", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, contactEmail: "Alice.Martin+mineur@exemple.fr" });
    expect((await orderRow(orderId)).contact_email).toBe("Alice.Martin+mineur@exemple.fr"); // casse conservée

    for (const contactEmail of ["alice", "alice@", "@exemple.fr", "alice@exemple", "alice@exemple..fr", "alice @exemple.fr", " alice@exemple.fr", `${"a".repeat(250)}@b.fr`]) {
      expect(await constraintOf(placeOrder({ catalog, batchId, customer: bob, contactEmail })), contactEmail).toBe("Order_contact_email_check");
    }
  });

  it("jamais modifié ni effacé une fois posé ; une facture antérieure (sans e-mail) peut en recevoir un, une fois", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const withEmail = await placeOrder({ catalog, batchId, customer: alice, contactEmail: "alice@exemple.fr" });
    for (const contact_email of ["autre@exemple.fr", null]) {
      expect(await constraintOf(prisma.order.update({ where: { id: withEmail }, data: { contact_email } }))).toBe("Order_contact_email_frozen");
    }
    const legacy = await placeOrder({ catalog, batchId, customer: bob });
    await prisma.order.update({ where: { id: legacy }, data: { contact_email: "bob@exemple.fr" } });
    expect(await constraintOf(prisma.order.update({ where: { id: legacy }, data: { contact_email: "bob2@exemple.fr" } }))).toBe(
      "Order_contact_email_frozen",
    );
    // Les autres changements d'une facture ne sont pas gênés par l'e-mail
    await cancelOrder(prisma, withEmail);
    expect((await orderRow(withEmail)).contact_email).toBe("alice@exemple.fr");
  });

  it("obligatoire à la création une fois Order_contact_email_required activé (v5k) : fourni, sinon copié du profil (v5j)", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const [{ enabled }] = await prisma.$queryRaw<{ enabled: string }[]>`
      SELECT "tgenabled"::text AS "enabled" FROM pg_trigger WHERE "tgname" = 'Order_contact_email_required'`;
    expect(enabled).toBe("D");

    const enableThen = (body: (tx: Tx) => Promise<unknown>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "Order" ENABLE TRIGGER "Order_contact_email_required"`);
        await body(tx);
        throw new Error("rollback");
      });
    expect(await constraintOf(enableThen((tx) => writeOrder(tx, { catalog, batchId, customer: alice })))).toBe(
      "Order_contact_email_required",
    );
    const ok = await failureOf(enableThen((tx) => writeOrder(tx, { catalog, batchId, customer: alice, contactEmail: "alice@exemple.fr" })));
    expect((ok as Error).message).toBe("rollback");

    // Sans e-mail fourni : l'instantané est copié du profil
    await prisma.user.update({ where: { id: bob.userId }, data: { email: "bob@exemple.fr" } });
    const copied = await failureOf(
      enableThen(async (tx) => {
        const id = await writeOrder(tx, { catalog, batchId, customer: bob });
        expect((await tx.order.findUniqueOrThrow({ where: { id } })).contact_email).toBe("bob@exemple.fr");
      }),
    );
    expect((copied as Error).message).toBe("rollback");
  });

  it("e-mail du profil (v5j) : modifiable, même format, sans unicité ; l'instantané de la facture ne suit pas", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    await prisma.user.update({ where: { id: alice.userId }, data: { email: "alice@exemple.fr" } });
    await prisma.user.update({ where: { id: bob.userId }, data: { email: "alice@exemple.fr" } }); // pas d'unicité
    const orderId = await placeOrder({ catalog, batchId, customer: alice, contactEmail: "alice@exemple.fr" });
    await prisma.user.update({ where: { id: alice.userId }, data: { email: "alice.nouvelle@exemple.fr" } });
    expect((await orderRow(orderId)).contact_email).toBe("alice@exemple.fr");
    for (const email of ["alice", "alice@exemple", "a b@exemple.fr"]) {
      expect(await constraintOf(prisma.user.update({ where: { id: alice.userId }, data: { email } })), email).toBe("User_email_check");
    }
    await prisma.user.update({ where: { id: alice.userId }, data: { email: null } });
    const views = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_views WHERE viewname = 'user_contact_email'`;
    expect(views[0].n).toBe(0);
  });
});

describe("(2) classer sans suite un excédent inférieur ou égal aux frais réseau", () => {
  it("commande payée avec 1 500 sats de trop : classée, la facture sort de « À traiter », la trace reste", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, 1_500n);
    expect(await balanceOf(orderId)).toMatchObject({ unsettled_sats: 1_500n, overpayment_unrefunded: true, needs_admin_attention: true });

    const dismissal = await dismiss(orderId, 1_500n, { reason: "Rendre 1 500 sats en coûterait 2 000" });
    expect(dismissal).toMatchObject({ sats: 1_500n, network_fee_sats: FEE, dismissed_by_auth_user_id: ADMIN_AUTH_USER_ID });
    expect(dismissal.created_at).toBeInstanceOf(Date);
    expect(await balanceOf(orderId)).toMatchObject({
      status: "paid",
      unsettled_sats: 0n,
      refund_due_sats: 0n,
      refunded_sats: 0n,
      dismissed_sats: 1_500n,
      overpayment_unrefunded: false,
      needs_admin_attention: false,
    });

    // Jamais deux fois, jamais modifié ni supprimé
    // (plus rien de non affecté ; en concurrence, l'index unique tranche : voir plus bas)
    expect(await constraintOf(dismiss(orderId, 1_500n))).toBe("OrderExcessDismissal_amount");
    expect(await constraintOf(prisma.orderExcessDismissal.update({ where: { id: dismissal.id }, data: { reason: "autre" } }))).toBe(
      "OrderExcessDismissal_append_only",
    );
    expect(await constraintOf(prisma.orderExcessDismissal.delete({ where: { id: dismissal.id } }))).toBe("OrderExcessDismissal_append_only");
    // L'excédent classé ne se rembourse plus
    const refund = prisma.refund.create({
      data: {
        order_id: orderId, kind: "overpayment", cause: "admin_other", ...ADMIN, amount: 0n, amount_sats: 1_500n, reason: "Excédent",
      },
    });
    expect(await constraintOf(refund)).toBe("Refund_overpayment");
  });

  it("impossible si l'excédent dépasse les frais, pour un autre montant que le non-affecté, ou sans rien à classer", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const big = await paidOrder(batchId, alice, 2_500n);
    expect(await constraintOf(dismiss(big, 2_500n))).toBe("OrderExcessDismissal_within_fee_check");
    expect(await constraintOf(dismiss(big, 1_000n))).toBe("OrderExcessDismissal_amount"); // une part seulement
    const exact = await paidOrder(batchId, bob);
    expect(await constraintOf(dismiss(exact, 1n))).toBe("OrderExcessDismissal_amount");
    // Égal aux frais : permis (motif facultatif, jamais vide)
    const atFee = await paidOrder(batchId, await createUser(), 2_000n);
    expect(await constraintOf(dismiss(atFee, 2_000n, { reason: "  " }))).toBe("OrderExcessDismissal_reason_check");
    await dismiss(atFee, 2_000n);
  });

  it("jamais sur une facture en attente ou expirée : l'appoint reste possible, ou l'utilisateur décide", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const pending = await placeOrder({ catalog, batchId, customer: alice });
    await receivePayment(prisma, pending, 1_000n);
    expect(await constraintOf(dismiss(pending, 1_000n))).toBe("OrderExcessDismissal_status");
    const expired = await placeOrder({ catalog, batchId, customer: bob, expiredMinutesAgo: 60 });
    await receivePayment(prisma, expired, 1_000n);
    expect(await constraintOf(dismiss(expired, 1_000n))).toBe("OrderExcessDismissal_status");
  });

  it("versement après une annulation : classé, puis la facture ne peut plus être acceptée ; un versement suivant se rembourse", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await cancelOrder(prisma, orderId);
    await receivePayment(prisma, orderId, 1_500n);
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_decision: true, unsettled_sats: 1_500n });
    await dismiss(orderId, 1_500n);
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_decision: false, needs_admin_attention: false, unsettled_sats: 0n });

    await receivePayment(prisma, orderId, EXPECTED_SATS);
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_decision: true, unsettled_sats: EXPECTED_SATS });
    const accept = prisma.order.update({ where: { id: orderId }, data: { status: "paid", paid_at: new Date() } });
    expect(await constraintOf(accept)).toBe("Order_dismissed_final");
    // Remboursement intégral : remboursé + classé = reçu
    await expect(
      prisma.$transaction((tx) => refundWhole(tx, orderId, { cause: "admin_other", ...ADMIN, amount_sats: EXPECTED_SATS + 1_500n })),
    ).rejects.toThrow();
    await prisma.$transaction((tx) => refundWhole(tx, orderId, { cause: "admin_other", ...ADMIN, amount_sats: EXPECTED_SATS }));
    expect(await balanceOf(orderId)).toMatchObject({ status: "refunded", unsettled_sats: 0n, needs_admin_decision: false, dismissed_sats: 1_500n });
  });

  it("versement arrivé après un classement sur une commande payée : de nouveau « à traiter », rien d'automatique", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, 1_500n);
    await dismiss(orderId, 1_500n);
    await receivePayment(prisma, orderId, 3_000n);
    expect(await balanceOf(orderId)).toMatchObject({
      status: "paid", unsettled_sats: 3_000n, dismissed_sats: 1_500n, overpayment_unrefunded: true, needs_admin_attention: true,
    });
    expect(await prisma.refund.count({ where: { order_id: orderId } })).toBe(0);
    expect(await constraintOf(dismiss(orderId, 3_000n))).toBe("OrderExcessDismissal_within_fee_check");
    // Même un petit nouveau versement : un seul classement par facture, l'admin rembourse
    const other = await paidOrder(batchId, bob, 1_500n);
    await dismiss(other, 1_500n);
    await receivePayment(prisma, other, 500n);
    expect(await constraintOf(dismiss(other, 500n))).toBe("OrderExcessDismissal_order_id_key");
  });

  it("deux classements simultanés de la même facture : un seul passe", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, 700n);
    const results = await Promise.allSettled([dismiss(orderId, 700n), dismiss(orderId, 700n)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.orderExcessDismissal.count({ where: { order_id: orderId } })).toBe(1);
  });
});

describe("(3) reliquat d'excédent d'un renoncement complet : l'admin choisit", () => {
  const renounceAll = (orderId: string, grossSats = EXPECTED_SATS, fee = FEE) =>
    prisma.$transaction((tx) =>
      refundWhole(tx, orderId, {
        cause: "user_renounce",
        initiated_by: "user",
        network_fee_payer: "user",
        network_fee_sats: fee,
        amount_sats: grossSats - fee,
      }),
    );

  it("renoncement à toute la facture sans le reliquat : remboursée, l'excédent reste « à traiter », l'admin le rembourse", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, 10_000n);
    await renounceAll(orderId);
    expect(await balanceOf(orderId)).toMatchObject({
      status: "refunded",
      unsettled_sats: 10_000n,
      needs_admin_decision: true,
      needs_admin_attention: true,
    });
    // Décision de l'admin : rembourser l'excédent (frais à la charge de l'utilisateur, motif overpayment)
    await prisma.refund.create({
      data: {
        order_id: orderId, kind: "overpayment", cause: "overpayment", ...ADMIN, network_fee_payer: "user", network_fee_sats: FEE,
        amount: 0n, amount_sats: 10_000n - FEE, reason: "Excédent rendu à la demande du client",
      },
    });
    expect(await balanceOf(orderId)).toMatchObject({ unsettled_sats: 0n, needs_admin_attention: true }); // adresse manquante
    expect(await balanceOf(orderId)).toMatchObject({ needs_admin_decision: false });
  });

  it("annulation de toute la commande par la boutique (toutes causes) : l'excédent reste « à traiter »", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    for (const cause of ["shop_stock", "shop_defective_machine", "admin_other"] as const) {
      const orderId = await paidOrder(batchId, await createUser(), 10_000n);
      await prisma.$transaction((tx) => refundWhole(tx, orderId, { cause, ...ADMIN, amount_sats: EXPECTED_SATS }));
      expect(await balanceOf(orderId), cause).toMatchObject({ status: "refunded", unsettled_sats: 10_000n, needs_admin_decision: true });
    }
  });

  it("reliquat inférieur aux frais : l'admin le classe sans suite", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, 1_500n);
    await renounceAll(orderId);
    await dismiss(orderId, 1_500n);
    expect(await balanceOf(orderId)).toMatchObject({ status: "refunded", unsettled_sats: 0n, needs_admin_decision: false });
  });

  it("le prix payé doit toujours être rendu en entier", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, 10_000n);
    // 79 000 sats bruts sur 80 000 : le reste de l'excédent ne compense pas le prix
    expect(await constraintOf(renounceAll(orderId, EXPECTED_SATS - 1_000n))).toBe("Order_refunded_in_full");
  });

  it("facture jamais acceptée : tout ce qui a été reçu sort du solde au passage à remboursée (inchangé)", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await cancelOrder(prisma, orderId);
    await receivePayment(prisma, orderId, 5_000n);
    const partial = prisma.$transaction((tx) => refundWhole(tx, orderId, { cause: "admin_other", ...ADMIN, amount_sats: 4_000n }));
    expect(await constraintOf(partial)).toBe("Order_refunded_in_full");
  });
});

describe("(4) lot qui ferme les commandes sans être annulé : factures impayées annulées", () => {
  async function packagingBatch() {
    const batchId = await createBatch(catalog, { quantity: 5, status: "inspection" });
    await moveBatch(batchId, "inspection", "packaging");
    return batchId;
  }
  const availableStock = async (batchId: string) =>
    (await prisma.$queryRaw<{ n: number }[]>`SELECT "batch_available_stock"(${batchId}::uuid) AS n`)[0].n;

  it("En transit : facture en attente sans versement annulée (jamais supprimée) ; versement partiel et facture expirée intacts", async () => {
    const batchId = await packagingBatch();
    const unpaid = await placeOrder({ catalog, batchId, customer: alice, lines: [false, false] });
    const partial = await placeOrder({ catalog, batchId, customer: bob });
    await receivePayment(prisma, partial, 1_000n);
    const carol = await createUser();
    const expired = await placeOrder({ catalog, batchId, customer: carol, expiredMinutesAgo: 60 });
    const before = await orderRow(unpaid);
    expect(await availableStock(batchId)).toBe(2);

    await moveBatch(batchId, "packaging", "in_transit");

    const after = await orderRow(unpaid);
    expect(after).toMatchObject({ status: "cancelled", payment_address: before.payment_address });
    expect(after.cancelled_at).toBeInstanceOf(Date);
    expect(await prisma.orderLine.count({ where: { order_id: unpaid } })).toBe(2);
    expect((await orderRow(partial)).status).toBe("pending_payment");
    expect(await balanceOf(partial)).toMatchObject({ needs_admin_decision: true });
    expect((await orderRow(expired)).status).toBe("pending_payment");
    expect(await availableStock(batchId)).toBe(4); // la facture de Bob réserve encore sa machine jusqu'à expiration

    // Un versement reçu ensuite sur la facture annulée reste « à traiter », rien d'automatique
    await receivePayment(prisma, unpaid, EXPECTED_SATS);
    expect(await balanceOf(unpaid)).toMatchObject({ status: "cancelled", needs_admin_decision: true, unsettled_sats: EXPECTED_SATS });
    expect(await prisma.refund.count({ where: { order_id: unpaid } })).toBe(0);
  });

  it("une transition qui garde le lot ouvert aux commandes ne touche pas les factures", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await moveBatch(batchId, "preorder", "ordering");
    expect((await orderRow(orderId)).status).toBe("pending_payment");
  });
});

describe("(5) option retirée d'un lot : wishlists ajustées tout de suite", () => {
  const silent = () => ({ optionId: catalog.optionId, valueId: catalog.silentId, price: SILENT_PRICE });
  const itemsOf = (wishlistId: string) =>
    prisma.configurationItem.findMany({
      where: { configuration: { wishlist: { id: wishlistId } } },
      select: { option_value_id: true, unit_price: true },
    });
  const withdrawSilent = (batchId: string, enabled = false) =>
    prisma.batchOptionValue.update({
      where: { batch_id_option_value_id: { batch_id: batchId, option_value_id: catalog.silentId } },
      data: { enabled },
    });
  const quota = async (batchId: string, customer: Customer) =>
    (await prisma.$queryRaw<{ n: number }[]>`SELECT "user_priority_quota"(${batchId}::uuid, ${customer.userId}::uuid) AS n`)[0].n;

  async function frozenWishlist() {
    const batchId = await createBatch(catalog, { quantity: 5, status: "survey" });
    const wishlist = await wish(catalog, batchId, alice, [silent()]);
    await moveBatch(batchId, "survey", "preorder");
    return { batchId, wishlist };
  }

  it("le retrait ramène la wishlist au défaut du menu (0 €), journalisé ; la wishlist et sa priorité restent", async () => {
    const { batchId, wishlist } = await frozenWishlist();
    expect(await quota(batchId, alice)).toBe(1);
    await withdrawSilent(batchId);

    expect(await itemsOf(wishlist.id)).toEqual([{ option_value_id: catalog.noKitId, unit_price: 0n }]);
    expect(await prisma.wishlistOptionWithdrawal.findMany({ where: { wishlist_id: wishlist.id } })).toEqual([
      expect.objectContaining({
        user_id: alice.userId,
        batch_id: batchId,
        option_id: catalog.optionId,
        withdrawn_value_id: catalog.silentId,
        withdrawn_unit_price: SILENT_PRICE,
        default_value_id: catalog.noKitId,
      }),
    ]);
    expect((await prisma.wishlist.findUniqueOrThrow({ where: { id: wishlist.id } })).cancelled_at).toBeNull();
    expect(await quota(batchId, alice)).toBe(1);
    const configuration = await prisma.configuration.findUniqueOrThrow({ where: { id: wishlist.configuration_id } });
    expect(configuration.updated_at.getTime()).toBeGreaterThanOrEqual(configuration.created_at.getTime());
  });

  it("le journal est append-only ; toute autre modification de la configuration figée reste refusée", async () => {
    const { batchId, wishlist } = await frozenWishlist();
    await withdrawSilent(batchId);
    const [entry] = await prisma.wishlistOptionWithdrawal.findMany({ where: { wishlist_id: wishlist.id } });
    expect(await constraintOf(prisma.wishlistOptionWithdrawal.delete({ where: { id: entry.id } }))).toBe(
      "WishlistOptionWithdrawal_append_only",
    );
    // Valeur proposée de nouveau : la wishlist ne la reprend pas, et l'utilisateur ne peut pas la remettre
    await withdrawSilent(batchId, true);
    const back = prisma.configurationItem.updateMany({
      where: { configuration_id: wishlist.configuration_id, option_id: catalog.optionId },
      data: { option_value_id: catalog.silentId, unit_price: SILENT_PRICE },
    });
    expect(await constraintOf(back)).toBe("Wishlist_configuration_frozen");
    expect(await constraintOf(prisma.configuration.update({ where: { id: wishlist.configuration_id }, data: { base_price: 1n } }))).toBe(
      "Wishlist_configuration_frozen",
    );
  });

  it("l'exception ne vaut que pour une valeur retirée : ramener au défaut une valeur encore proposée est refusé", async () => {
    const { wishlist } = await frozenWishlist();
    const reset = prisma.configurationItem.updateMany({
      where: { configuration_id: wishlist.configuration_id, option_id: catalog.optionId },
      data: { option_value_id: catalog.noKitId, unit_price: 0n },
    });
    expect(await constraintOf(reset)).toBe("Wishlist_configuration_frozen");
    expect(await prisma.wishlistOptionWithdrawal.count()).toBe(0);
  });

  it("les lignes de commande gardent leur choix (configuration verrouillée)", async () => {
    const { batchId } = await frozenWishlist();
    const orderId = await placeOrder({ catalog, batchId, customer: alice, lines: [true] });
    await withdrawSilent(batchId);
    const items = await prisma.configurationItem.findMany({ where: { configuration: { order_line: { order_id: orderId } } } });
    expect(items.map((i) => [i.option_value_id, i.unit_price])).toEqual([[catalog.silentId, SILENT_PRICE]]);
  });

  it("retrait au sondage (v5j) : ajustement immédiat et journalisé ; rien de plus à l'ouverture des précommandes", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "survey" });
    const wishlist = await wish(catalog, batchId, alice, [silent()]);
    await withdrawSilent(batchId);
    expect(await itemsOf(wishlist.id)).toEqual([{ option_value_id: catalog.noKitId, unit_price: 0n }]);
    expect(await prisma.wishlistOptionWithdrawal.count({ where: { wishlist_id: wishlist.id } })).toBe(1);

    await moveBatch(batchId, "survey", "preorder");
    expect(await prisma.wishlistOptionWithdrawal.count({ where: { wishlist_id: wishlist.id } })).toBe(1);
  });

  it("wishlists retirées ou converties : ajustées sans avertissement ; seule la wishlist vivante est journalisée", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, status: "survey" });
    const carol = await createUser();
    const live = await wish(catalog, batchId, alice, [silent()]);
    const withdrawn = await wish(catalog, batchId, bob, [silent()]);
    await prisma.wishlist.update({ where: { id: withdrawn.id }, data: { cancelled_at: new Date() } });
    const converted = await wish(catalog, batchId, carol, [silent()]);
    await moveBatch(batchId, "survey", "preorder");
    const orderId = await placeOrder({ catalog, batchId, customer: carol, lines: [true], wishlistId: converted.id });
    await pay(orderId);

    await withdrawSilent(batchId);
    for (const w of [live, withdrawn, converted]) {
      expect(await itemsOf(w.id)).toEqual([{ option_value_id: catalog.noKitId, unit_price: 0n }]);
    }
    expect((await prisma.wishlistOptionWithdrawal.findMany()).map((e) => e.wishlist_id)).toEqual([live.id]);
  });

  it("la valeur par défaut ne se retire jamais (BatchOptionValue_default_enabled), aucune wishlist touchée", async () => {
    const { batchId, wishlist } = await frozenWishlist();
    const withdrawDefault = prisma.batchOptionValue.update({
      where: { batch_id_option_value_id: { batch_id: batchId, option_value_id: catalog.noKitId } },
      data: { enabled: false },
    });
    expect(await constraintOf(withdrawDefault)).toBe("BatchOptionValue_default_enabled");
    expect(await itemsOf(wishlist.id)).toEqual([{ option_value_id: catalog.silentId, unit_price: SILENT_PRICE }]);
  });
});
