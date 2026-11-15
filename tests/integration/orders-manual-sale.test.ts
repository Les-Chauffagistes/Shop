import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import { listRefundsToSend } from "@/server/backoffice-orders";
import type { Prisma, RefundCause, RefundKind } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  ADMIN_AUTH_USER_ID,
  assignMachine,
  barrier,
  type Catalog,
  cancelOrder,
  CONTACT_EMAIL,
  createAccountlessCustomer,
  createBatch,
  createCatalog,
  createStockBatch,
  createUser,
  type Customer,
  failureOf,
  machinesOf,
  manualSale,
  pay,
  placeOrder,
  receiveAndCheck,
  receivePayment,
  RESALE,
  restock,
  setShopSettings,
  SILENT_PRICE,
  writeManualSale,
  writeOrder,
} from "./fixtures";

// Refonte machines / stock, jalon R5a : vente manuelle de l'admin (Order canal manual, payée hors chaîne, offchain),
// client sans compte, encaissement et remboursement en euros, mêmes règles que la boutique (stock, blocage).

type Tx = Prisma.TransactionClient;

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;

let catalog: Catalog;
let alice: Customer;
let walkIn: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
  walkIn = await createAccountlessCustomer();
});

/** Lot de stock en vente avec `sellable` machines réassorties, reçues et contrôlées ok. */
async function stockWith(sellable: number) {
  const stock = await createStockBatch(catalog);
  const { machines } = await restock(catalog, stock, sellable);
  for (const m of machines) await receiveAndCheck(m.id);
  return { stock, machines };
}

async function balanceOf(orderId: string) {
  const [row] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row;
}

const toSend = () => prisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM "refunds_to_send" ORDER BY "created_at"`;

/** Remboursement hors chaîne décidé par l'admin (le moyen est recopié de la facture par la base). */
function offchainRefund(
  tx: Tx | typeof prisma,
  orderId: string,
  amount: bigint,
  { kind = "cancellation", cause = "admin_other", ...extra }: { kind?: RefundKind; cause?: RefundCause } & Partial<Prisma.RefundUncheckedCreateInput> = {},
) {
  return tx.refund.create({
    data: {
      order_id: orderId,
      kind,
      cause,
      amount,
      initiated_by: "admin",
      created_by_auth_user_id: ADMIN_AUTH_USER_ID,
      reason: "Machine reprise au comptoir",
      ...extra,
    },
  });
}

describe("vente manuelle : facture payée hors chaîne, mêmes règles que la boutique", () => {
  it("sur le lot de stock, client sans compte : facture payée à la création, encaissement tracé, machine attribuée", async () => {
    const { stock, machines } = await stockWith(2);
    const orderId = await manualSale({
      catalog, batchId: stock, customer: walkIn, lines: [true, false], machines: [machines[0].id, null],
      means: "bank_transfer", reference: "VIR-2026-117", contactEmail: null,
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, lines: { orderBy: { position: "asc" } } } });
    expect(order).toMatchObject({
      channel: "manual",
      payment_method: "offchain",
      created_by_auth_user_id: ADMIN_AUTH_USER_ID,
      manual_reason: "Vente au comptoir",
      status: "paid",
      total_amount: 2n * RESALE + SILENT_PRICE,
      received_cents: 2n * RESALE + SILENT_PRICE,
      received_sats: 0n,
      expected_sats: null,
      payment_address: null,
      refund_address: null,
      contact_email: CONTACT_EMAIL, // copié du profil du client sans compte
    });
    expect(order.paid_at).not.toBeNull();
    expect(order.payments).toEqual([
      expect.objectContaining({
        method: "offchain", amount_cents: order.total_amount, offchain_means: "bank_transfer", reference: "VIR-2026-117",
        recorded_by_auth_user_id: ADMIN_AUTH_USER_ID, amount_sats: null, txid: null, vout: null,
      }),
    ]);
    expect(order.lines.map((l) => [l.amount, l.machine_id])).toEqual([[RESALE + SILENT_PRICE, machines[0].id], [RESALE, null]]);
    expect(await balanceOf(orderId)).toMatchObject({
      payment_method: "offchain", received_cents: order.total_amount, refunded_cents: 0n, unsettled_sats: 0n,
      needs_admin_attention: false, user_renounce_allowed: false, offchain_refund_unsent: false,
    });

    // Plus aucune machine disponible : la boutique est refusée
    expect(await constraintOf(placeOrder({ catalog, batchId: stock, customer: alice }))).toBe("Batch_stock");
  });

  it("sur une palette en précommande ; la machine s'attribue plus tard (Contrôle), comme en ligne", async () => {
    const lot = await createBatch(catalog, { quantity: 2 });
    const orderId = await manualSale({ catalog, batchId: lot, customer: walkIn, means: "cash", reference: null });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("paid");

    const other = await createBatch(catalog, { quantity: 1, status: "inspection" });
    const [machine] = await machinesOf(other);
    await receiveAndCheck(machine.id);
    const early = manualSale({ catalog, batchId: lot, customer: alice, machines: [machine.id] });
    expect(await constraintOf(early)).toBe("OrderLineAssignment_batch_status");
  });

  it("refusée si le stock manque, ou pour une machine invendable du stock (degraded)", async () => {
    const { stock } = await stockWith(1);
    await pay(await placeOrder({ catalog, batchId: stock, customer: alice }));
    expect(await constraintOf(manualSale({ catalog, batchId: stock, customer: walkIn }))).toBe("Batch_stock");

    const { machines } = await restock(catalog, stock, 1);
    await receiveAndCheck(machines[0].id, "degraded");
    expect(await constraintOf(manualSale({ catalog, batchId: stock, customer: walkIn, machines: [machines[0].id] }))).toBe(
      "OrderLineAssignment_machine_assignable",
    );
    expect(await prisma.order.count({ where: { channel: "manual" } })).toBe(0);
  });

  it("lot en pause : refusée comme en ligne", async () => {
    const stock = await createStockBatch(catalog, { status: "draft" });
    expect(await constraintOf(manualSale({ catalog, batchId: stock, customer: walkIn }))).toBe("Order_batch_open");
  });

  it("dernière machine : vente au comptoir et commande en ligne simultanées, une seule passe", async () => {
    for (const withMachine of [false, true]) {
      const other = await createCatalog(withMachine ? "S21" : "S19j");
      const stock = await createStockBatch(other);
      const { machines } = await restock(other, stock, 1);
      await receiveAndCheck(machines[0].id);
      const customer = await createUser();
      const sync = barrier(2);
      const results = await Promise.allSettled([
        prisma.$transaction(async (tx) => {
          await writeOrder(tx, { catalog: other, batchId: stock, customer });
          await sync.wait();
        }),
        prisma.$transaction(async (tx) => {
          await writeManualSale(tx, { catalog: other, batchId: stock, customer: walkIn, machines: withMachine ? [machines[0].id] : undefined });
          await sync.wait();
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect(pgFailureOf(rejected?.reason)?.constraint).toBe("Batch_stock");
      const [{ available }] = await prisma.$queryRaw<{ available: number }[]>`SELECT "batch_available_stock"(${stock}::uuid) AS "available"`;
      expect(available).toBe(0);
    }
  });

  it("blocage anti-abus : une facture de l'admin est refusée aussi ; l'admin lève le blocage (tracé) pour vendre", async () => {
    await setShopSettings({ abandoned_order_limit: 1, abandoned_order_cooldown_minutes: 0 });
    const { stock } = await stockWith(2);
    await cancelOrder(prisma, await placeOrder({ catalog, batchId: stock, customer: alice }));
    expect(await constraintOf(manualSale({ catalog, batchId: stock, customer: alice }))).toBe("Order_abandoned_limit");

    await prisma.orderBlockRelease.create({
      data: { batch_id: stock, user_id: alice.userId, released_by_auth_user_id: ADMIN_AUTH_USER_ID, reason: "Vente au comptoir" },
    });
    await manualSale({ catalog, batchId: stock, customer: alice });
  });

  it("une facture en attente vivante du même client sur le lot bloque la vente, comme en ligne", async () => {
    const { stock } = await stockWith(2);
    await placeOrder({ catalog, batchId: stock, customer: alice });
    expect(await constraintOf(manualSale({ catalog, batchId: stock, customer: alice }))).toBe("Order_one_live_per_user_batch");
  });

  it("naît payée : sans encaissement complet, une facture hors chaîne ne se valide pas ; jamais plus que le total", async () => {
    const { stock } = await stockWith(2);
    /** Facture hors chaîne écrite à la main (sans create_manual_sale), en attente, avec une ligne. */
    const bare = async (tx: Tx) => {
      const [config] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "Configuration" ("batch_id", "model_id", "base_price") VALUES (${stock}::uuid, ${catalog.modelId}::uuid, ${RESALE}) RETURNING "id"`;
      await tx.configurationItem.create({
        data: { configuration_id: config.id, model_id: catalog.modelId, option_id: catalog.optionId, option_value_id: catalog.noKitId, unit_price: 0n },
      });
      const order = await tx.order.create({
        data: {
          user_id: walkIn.userId, batch_id: stock, billing_address_id: walkIn.addressId, shipping_address_id: walkIn.addressId,
          total_amount: RESALE, payment_method: "offchain", channel: "manual", created_by_auth_user_id: ADMIN_AUTH_USER_ID,
          manual_reason: "Comptoir",
        },
      });
      await tx.orderLine.create({ data: { order_id: order.id, user_id: walkIn.userId, batch_id: stock, configuration_id: config.id, amount: RESALE } });
      return order.id;
    };
    const cash = (tx: Tx, orderId: string, cents: bigint) =>
      tx.payment.create({ data: { order_id: orderId, amount_cents: cents, offchain_means: "cash", recorded_by_auth_user_id: ADMIN_AUTH_USER_ID } });

    expect(await constraintOf(prisma.$transaction((tx) => bare(tx)))).toBe("Order_manual_paid");
    expect(await constraintOf(prisma.$transaction(async (tx) => cash(tx, await bare(tx), RESALE + 1n)))).toBe("Order_received_cents_check");
    const partial = prisma.$transaction(async (tx) => {
      const id = await bare(tx);
      await cash(tx, id, RESALE - 1n);
      await tx.order.update({ where: { id }, data: { status: "paid", paid_at: new Date() } });
    });
    expect(await constraintOf(partial)).toBe("Order_paid_in_full_check");
    // Deux encaissements (espèces + virement) qui font le total : accepté
    await prisma.$transaction(async (tx) => {
      const id = await bare(tx);
      await cash(tx, id, RESALE - 1n);
      await tx.payment.create({
        data: { order_id: id, amount_cents: 1n, offchain_means: "bank_transfer", reference: "VIR-1", recorded_by_auth_user_id: ADMIN_AUTH_USER_ID },
      });
      await tx.order.update({ where: { id }, data: { status: "paid", paid_at: new Date() } });
    });
  });
});

describe("cohérence du moyen de paiement : aucun mélange", () => {
  it("canal et moyen liés ; vente manuelle tracée (admin, motif) ; ni sats ni adresse Bitcoin hors chaîne", async () => {
    const { stock } = await stockWith(1);
    const base = {
      user_id: walkIn.userId, batch_id: stock, billing_address_id: walkIn.addressId, shipping_address_id: walkIn.addressId,
      total_amount: RESALE,
    };
    const manual = { channel: "manual" as const, created_by_auth_user_id: ADMIN_AUTH_USER_ID, manual_reason: "Comptoir" };
    expect(await constraintOf(prisma.order.create({ data: { ...base, payment_method: "offchain" } }))).toBe("Order_method_check");
    expect(await constraintOf(prisma.order.create({ data: { ...base, ...manual, manual_reason: " ", payment_method: "offchain" } }))).toBe("Order_channel_check");
    expect(await constraintOf(prisma.order.create({ data: { ...base, ...manual, payment_method: "offchain", expected_sats: 1n } }))).toBe("Order_method_check");
    expect(
      await constraintOf(prisma.order.create({ data: { ...base, ...manual, payment_method: "offchain", refund_address: "bc1qfixturerefund0000000000000000000000000" } })),
    ).toBe("Order_method_check");
    expect(
      await constraintOf(prisma.order.create({ data: { ...base, ...manual, payment_method: "bitcoin", expected_sats: 1n, payment_address: "bc1qx", refund_address: "bc1qfixturerefund0000000000000000000000000" } })),
    ).toBe("Order_method_check");
  });

  it("paiement Bitcoin refusé sur une vente hors chaîne ; encaissement hors chaîne refusé sur une facture Bitcoin", async () => {
    const { stock } = await stockWith(2);
    const manualId = await manualSale({ catalog, batchId: stock, customer: walkIn });
    expect(await constraintOf(receivePayment(prisma, manualId, 1_000n))).toBe("Payment_offchain_pending");

    const online = await placeOrder({ catalog, batchId: stock, customer: alice });
    const cash = prisma.payment.create({
      data: { order_id: online, method: "offchain", amount_cents: RESALE, offchain_means: "cash", recorded_by_auth_user_id: ADMIN_AUTH_USER_ID },
    });
    expect(await constraintOf(cash)).toBe("Payment_method_check"); // le moyen recopié est bitcoin : txid, sats requis
    // Clé étrangère composite : le moyen d'un paiement est toujours celui de sa facture
    const [p] = await prisma.$queryRaw<{ method: string }[]>`
      SELECT p."method"::text FROM "Payment" p JOIN "Order" o ON o."id" = p."order_id" AND o."payment_method" = p."method"
      WHERE p."order_id" = ${manualId}::uuid`;
    expect(p.method).toBe("offchain");
  });

  it("encaissement hors chaîne : catégorie, référence non vide, obligatoire pour « autre »", async () => {
    const { stock } = await stockWith(1);
    const sale = (means: "other" | "cash", reference: string | null) => manualSale({ catalog, batchId: stock, customer: walkIn, means, reference });
    expect(await constraintOf(sale("other", null))).toBe("Payment_method_check");
    expect(await constraintOf(sale("cash", "  "))).toBe("Payment_reference_check");
    await sale("other", "Chèque n° 1234");
    expect(await prisma.payment.findFirstOrThrow({ where: { method: "offchain" } })).toMatchObject({ offchain_means: "other", reference: "Chèque n° 1234" });
  });

  it("remboursement : moyen de la facture ; sats, frais, adresse ou motif propre à la chaîne refusés hors chaîne", async () => {
    const { stock } = await stockWith(3);
    const manualId = await manualSale({ catalog, batchId: stock, customer: walkIn, lines: [false, false] });
    const lines = await prisma.orderLine.findMany({ where: { order_id: manualId }, orderBy: { position: "asc" } });
    const withLine = async (tx: Tx, extra: Parameters<typeof offchainRefund>[3]) => {
      const r = await offchainRefund(tx, manualId, RESALE, extra);
      await tx.orderLine.update({ where: { id: lines[0].id }, data: { refund_id: r.id } });
    };
    expect(await constraintOf(prisma.$transaction((tx) => withLine(tx, { amount_sats: 1_000n })))).toBe("Refund_method_check");
    expect(await constraintOf(prisma.$transaction((tx) => withLine(tx, { network_fee_sats: 300n })))).toBe("Refund_method_check");
    expect(await constraintOf(prisma.$transaction((tx) => withLine(tx, { destination_address: "bc1qfixturerefund0000000000000000000000000" })))).toBe(
      "Refund_method_check",
    );
    expect(await constraintOf(prisma.$transaction((tx) => withLine(tx, { cause: "user_renounce" })))).toBe("Refund_method_check");
    expect(await constraintOf(offchainRefund(prisma, manualId, 0n, { kind: "overpayment", cause: "admin_other" }))).toBe("Refund_method_check");
    // Paiement partiel : frais à la charge du client, impossible sans frais réseau hors chaîne
    expect(await constraintOf(prisma.$transaction((tx) => withLine(tx, { cause: "partial_payment" })))).toBe("Refund_cause_fee_payer");

    // Remboursement Bitcoin sans sats sur une facture Bitcoin : refusé aussi
    const online = await placeOrder({ catalog, batchId: stock, customer: alice });
    await pay(online);
    const line = await prisma.orderLine.findFirstOrThrow({ where: { order_id: online } });
    const noSats = prisma.$transaction(async (tx) => {
      const r = await offchainRefund(tx, online, RESALE);
      await tx.orderLine.update({ where: { id: line.id }, data: { refund_id: r.id } });
    });
    expect(await constraintOf(noSats)).toBe("Refund_method_check");
  });
});

describe("remboursement hors chaîne", () => {
  it("en euros, au prorata de ce qui a été reçu, sans frais ; à rendre : « À traiter » et « Remboursements » ; envoi avec référence datée par la base", async () => {
    const { stock } = await stockWith(2);
    const orderId = await manualSale({ catalog, batchId: stock, customer: walkIn, lines: [true, false] });
    const lines = await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } });

    // Plus que la ligne annulée n'est pas un remboursement « au prorata » : la facture ne garde que ce qu'elle a reçu
    const tooMuch = prisma.$transaction(async (tx) => {
      const r = await offchainRefund(tx, orderId, 3n * RESALE);
      await tx.orderLine.update({ where: { id: lines[0].id }, data: { refund_id: r.id } });
    });
    expect(await constraintOf(tooMuch)).toBe("Order_refunds");

    const refund = await prisma.$transaction(async (tx) => {
      const r = await offchainRefund(tx, orderId, lines[0].amount, { cause: "shop_defective_machine" });
      await tx.orderLine.update({ where: { id: lines[0].id }, data: { refund_id: r.id } });
      return r;
    });
    expect(refund).toMatchObject({ method: "offchain", amount: RESALE + SILENT_PRICE, amount_sats: null, network_fee_sats: null, network_fee_payer: "shop" });

    expect(await balanceOf(orderId)).toMatchObject({
      status: "paid", refunded_cents: RESALE + SILENT_PRICE, unsent_refund_cents: RESALE + SILENT_PRICE,
      offchain_refund_unsent: true, needs_admin_attention: true, refund_address_missing: false,
    });
    expect(await toSend()).toEqual([
      expect.objectContaining({ refund_id: refund.id, method: "offchain", amount: RESALE + SILENT_PRICE, amount_sats: null, address_missing: false }),
    ]);
    const { items } = await listRefundsToSend();
    expect(items).toEqual([expect.objectContaining({ refundId: refund.id, amountSats: null, addressMissing: false })]);

    // Envoi : référence obligatoire, date posée par la base, auteur ; ensuite figé
    const send = (reference: string | null) =>
      prisma.refund.update({
        where: { id: refund.id },
        data: { sent_at: new Date("2000-01-01"), reference, sent_by_auth_user_id: ADMIN_AUTH_USER_ID },
      });
    expect(await constraintOf(send(null))).toBe("Refund_sent_check");
    const sent = await send("Espèces rendues, reçu 43");
    expect(sent.sent_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await constraintOf(prisma.refund.update({ where: { id: refund.id }, data: { reference: "autre" } }))).toBe("Refund_sent_frozen");
    expect(await toSend()).toEqual([]);
    expect(await balanceOf(orderId)).toMatchObject({ offchain_refund_unsent: false, needs_admin_attention: false, unsent_refund_cents: 0n });

    // Rabais puis annulation du reste : la facture passe à remboursée quand tout le reçu est rendu
    await offchainRefund(prisma, orderId, 10_000n, { kind: "discount", cause: "discount" });
    await prisma.$transaction(async (tx) => {
      const r = await offchainRefund(tx, orderId, RESALE - 10_000n);
      await tx.orderLine.update({ where: { id: lines[1].id }, data: { refund_id: r.id } });
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    });
    expect(await balanceOf(orderId)).toMatchObject({ status: "refunded", refunded_cents: 2n * RESALE + SILENT_PRICE, unsettled_sats: 0n });
  });

  it("remboursée en entier seulement quand tout ce qui a été reçu est rendu (Order_refunded_in_full)", async () => {
    const { stock } = await stockWith(1);
    const orderId = await manualSale({ catalog, batchId: stock, customer: walkIn });
    const [line] = await prisma.orderLine.findMany({ where: { order_id: orderId } });
    const partial = prisma.$transaction(async (tx) => {
      await offchainRefund(tx, orderId, 1_000n, { kind: "discount", cause: "discount" });
      const r = await offchainRefund(tx, orderId, RESALE - 2_000n);
      await tx.orderLine.update({ where: { id: line.id }, data: { refund_id: r.id } });
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    });
    expect(await constraintOf(partial)).toBe("Order_refunds"); // l'annulation couvre au moins sa ligne
  });

  it("aucun classement sans suite hors chaîne", async () => {
    const { stock } = await stockWith(1);
    const orderId = await manualSale({ catalog, batchId: stock, customer: walkIn });
    const dismiss = prisma.orderExcessDismissal.create({
      data: { order_id: orderId, sats: 1n, network_fee_sats: 1n, reason: "x", dismissed_by_auth_user_id: ADMIN_AUTH_USER_ID },
    });
    expect(await constraintOf(dismiss)).toBe("OrderExcessDismissal_bitcoin");
  });
});

describe("client sans compte", () => {
  it("créé par un admin ; un compte se rattache une fois, puis ne change plus", async () => {
    expect(await constraintOf(prisma.user.create({ data: { email: "x@exemple.fr" } }))).toBe("User_account_check");
    expect(await constraintOf(prisma.user.create({ data: { created_by_auth_user_id: 0n } }))).toBe("User_created_by_check");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: walkIn.userId } });
    expect(user).toMatchObject({ auth_user_id: null, created_by_auth_user_id: ADMIN_AUTH_USER_ID, email: CONTACT_EMAIL });
    await prisma.user.update({ where: { id: walkIn.userId }, data: { auth_user_id: 9_001n } });
    expect(await constraintOf(prisma.user.update({ where: { id: walkIn.userId }, data: { auth_user_id: 9_002n } }))).toBe("User_auth_link");
    expect(await constraintOf(prisma.user.update({ where: { id: walkIn.userId }, data: { created_by_auth_user_id: 2n } }))).toBe("User_immutable");
    expect(await constraintOf(prisma.user.update({ where: { id: alice.userId }, data: { auth_user_id: null } }))).toBe("User_auth_link");
  });

  it("sans e-mail au profil ni sur la vente : refusée (Order_contact_email_required) ; e-mail fourni : figé sur la facture", async () => {
    const { stock } = await stockWith(2);
    const silent = await createAccountlessCustomer(null);
    expect(await constraintOf(manualSale({ catalog, batchId: stock, customer: silent, contactEmail: null }))).toBe("Order_contact_email_required");
    const orderId = await manualSale({ catalog, batchId: stock, customer: silent, contactEmail: "comptoir@exemple.fr" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).contact_email).toBe("comptoir@exemple.fr");
  });

  it("ses ventes apparaissent avec un client sans identifiant de compte (Remboursements)", async () => {
    const { stock } = await stockWith(1);
    const orderId = await manualSale({ catalog, batchId: stock, customer: walkIn });
    const [line] = await prisma.orderLine.findMany({ where: { order_id: orderId } });
    await prisma.$transaction(async (tx) => {
      const r = await offchainRefund(tx, orderId, RESALE);
      await tx.orderLine.update({ where: { id: line.id }, data: { refund_id: r.id } });
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    });
    const { items } = await listRefundsToSend();
    expect(items).toEqual([expect.objectContaining({ orderId, user: { id: walkIn.userId, authUserId: null } })]);
  });
});

describe("attribution après la vente", () => {
  it("une machine vendable du stock s'attribue ensuite à la ligne d'une vente manuelle", async () => {
    const { stock, machines } = await stockWith(1);
    const orderId = await manualSale({ catalog, batchId: stock, customer: walkIn });
    const [line] = await prisma.orderLine.findMany({ where: { order_id: orderId } });
    await assignMachine(prisma, line.id, stock, machines[0].id);
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: line.id } })).machine_id).toBe(machines[0].id);
  });
});
