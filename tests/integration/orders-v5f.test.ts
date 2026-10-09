import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  CONTACT_EMAIL,
  ADMIN_AUTH_USER_ID,
  authUserIdOf,
  type Catalog,
  createBatch,
  createCatalog,
  createUser,
  type Customer,
  declareActor,
  EXPECTED_SATS,
  failureOf,
  pay,
  placeOrder,
  receivePayment,
  setRefundAddress,
  untilAnotherSessionWaitsOnLock,
  writeRefundAddress,
} from "./fixtures";

// Jalon 4, migration v5f : motif des remboursements (refund_cause) et payeur des frais réseau
// (refund_cause_fee_payer), prorata et plafonds sur le brut, aucune décision automatique quand le montant ne
// dépasse pas les frais, frais portés par une seule ligne, journal des changements d'adresse de remboursement.

type Tx = Prisma.TransactionClient;

let catalog: Catalog;
let alice: Customer;
let bob: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
  bob = await createUser();
});

const FEE = 300n;
const ADDRESS_A = "bc1qv5frefundaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS_B = "bc1qv5frefundbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_C = "bc1qv5frefundccccccccccccccccccccccccccccc";

const ADMIN = { initiated_by: "admin", created_by_auth_user_id: ADMIN_AUTH_USER_ID } as const;

const constraintOf = async (promise: Promise<unknown>) => pgFailureOf(await failureOf(promise))?.constraint;
const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { refunds: { orderBy: { created_at: "asc" } } } });

async function balanceOf(orderId: string) {
  const [row] = await prisma.$queryRaw<
    {
      status: string;
      refunded_sats: bigint;
      refund_due_sats: bigint;
      unsettled_sats: bigint;
      needs_admin_decision: boolean;
      needs_admin_attention: boolean;
      overpayment_unrefunded: boolean;
    }[]
  >`SELECT "status"::text AS "status", "refunded_sats", "refund_due_sats", "unsettled_sats", "needs_admin_decision",
           "needs_admin_attention", "overpayment_unrefunded"
    FROM "order_payment_balance" WHERE "order_id" = ${orderId}::uuid`;
  return row;
}

/** Facture payée de `lines` machines sans kit (50 000 c chacune), `extraSats` reçus en plus. */
async function paidOrder(batchId: string, customer: Customer, { lines = 1, extraSats = 0n, refundAddress = ADDRESS_A } = {}) {
  const orderId = await placeOrder({ catalog, batchId, customer, lines: Array(lines).fill(false), refundAddress });
  if (extraSats > 0n) await receivePayment(prisma, orderId, EXPECTED_SATS + extraSats);
  await pay(orderId);
  return orderId;
}

const lineIdsOf = async (orderId: string) =>
  (await prisma.orderLine.findMany({ where: { order_id: orderId }, orderBy: { position: "asc" } })).map((l) => l.id);

const prorata = async (tx: Tx | typeof prisma, orderId: string, amount: bigint) =>
  (await tx.$queryRaw<{ sats: bigint }[]>`SELECT "refund_prorata_sats"(${orderId}::uuid, ${amount}) AS "sats"`)[0].sats;

/** Remboursement d'annulation de `lineIds` (rattachées), sans changer le statut. */
async function cancelLines(tx: Tx, orderId: string, lineIds: string[], data: Omit<Prisma.RefundUncheckedCreateInput, "order_id" | "kind" | "amount" | "reason">) {
  const lines = await tx.orderLine.findMany({ where: { id: { in: lineIds } } });
  const amount = lines.reduce((sum, l) => sum + l.amount, 0n);
  const refund = await tx.refund.create({ data: { order_id: orderId, kind: "cancellation", amount, reason: "Annulation", ...data } });
  await tx.orderLine.updateMany({ where: { id: { in: lineIds } }, data: { refund_id: refund.id } });
  return refund;
}

/** Renoncement de l'utilisateur : frais à sa charge (user_renounce), il reçoit le prorata brut moins les frais. */
const RENOUNCE = { cause: "user_renounce", initiated_by: "user", network_fee_payer: "user", network_fee_sats: FEE } as const;
/** Même renoncement enregistré par l'admin à la demande de l'utilisateur (v5g) : seul à pouvoir joindre un reliquat (v5k). */
const RENOUNCE_BY_ADMIN = { ...RENOUNCE, ...ADMIN } as const;

describe("motif et payeur des frais réseau (refund_cause_fee_payer)", () => {
  it("défauts de Hugo (2026-10-08), dans une seule fonction", async () => {
    const rows = await prisma.$queryRaw<{ cause: string; payer: string }[]>`
      SELECT c::text AS "cause", "refund_cause_fee_payer"(c)::text AS "payer"
      FROM unnest(enum_range(NULL::"refund_cause")) c`;
    expect(Object.fromEntries(rows.map((r) => [r.cause, r.payer]))).toEqual({
      shop_stock: "shop",
      shop_defective_machine: "shop",
      user_renounce: "user",
      partial_payment: "user",
      late_payment_no_room: "shop",
      overpayment: "user",
      discount: "shop",
      admin_other: "shop",
    });
  });

  it("le payeur des frais suit le motif à la création ; motif, nature et initiateur cohérents ; motif immuable", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { lines: 2, extraSats: 1_000n });
    const [first] = await lineIdsOf(orderId);
    const sats = await prorata(prisma, orderId, 50_000n);

    // Excédent : frais à la charge de l'utilisateur, jamais de la boutique ; souci de stock : l'inverse
    const overpayment = (data: Partial<Prisma.RefundUncheckedCreateInput>) =>
      prisma.refund.create({
        data: { order_id: orderId, kind: "overpayment", cause: "overpayment", ...ADMIN, amount: 0n, amount_sats: 700n, network_fee_sats: FEE, reason: "Excédent", ...data },
      });
    expect(await constraintOf(overpayment({}))).toBe("Refund_cause_fee_payer"); // défaut de la colonne : shop
    expect(
      await constraintOf(prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { cause: "shop_stock", ...ADMIN, network_fee_payer: "user", network_fee_sats: FEE, amount_sats: sats - FEE }))),
    ).toBe("Refund_cause_fee_payer");
    // Machine défectueuse : décision de l'admin, jamais un automatisme ; excédent : jamais un rabais
    expect(
      await constraintOf(prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { cause: "shop_defective_machine", initiated_by: "system", network_fee_sats: FEE, amount_sats: sats }))),
    ).toBe("Refund_cause_check");
    expect(await constraintOf(overpayment({ network_fee_payer: "user", kind: "discount", amount: 100n, ...ADMIN }))).toBe("Refund_cause_check");

    const refund = await prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { cause: "shop_stock", ...ADMIN, network_fee_sats: FEE, amount_sats: sats }));
    expect(refund).toMatchObject({ cause: "shop_stock", network_fee_payer: "shop", amount_sats: sats });
    expect(await constraintOf(prisma.refund.update({ where: { id: refund.id }, data: { cause: "admin_other" } }))).toBe("Refund_immutable");
    await overpayment({ network_fee_payer: "user" });
    expect(await balanceOf(orderId)).toMatchObject({ status: "paid", refunded_sats: sats + 1_000n, refund_due_sats: 0n });
  });

  it("paiement tardif sans place : paiement complet exigé, frais à la charge de la boutique, montant au-dessus des frais", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const late = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 10 });
    await pay(await placeOrder({ catalog, batchId, customer: bob })); // la seule place
    const refundLate = (fee: bigint) =>
      prisma.$transaction(async (tx) => {
        const order = await tx.order.findUniqueOrThrow({ where: { id: late } });
        await cancelLines(tx, late, await lineIdsOf(late), { cause: "late_payment_no_room", initiated_by: "system", network_fee_sats: fee, amount_sats: order.received_sats });
        await tx.order.update({ where: { id: late }, data: { status: "refunded" } });
      });

    await receivePayment(prisma, late, 30_000n);
    expect(await constraintOf(refundLate(FEE))).toBe("Refund_late_payment_full"); // paiement partiel : autre motif
    await receivePayment(prisma, late, EXPECTED_SATS - 30_000n);
    expect(await constraintOf(refundLate(EXPECTED_SATS))).toBe("Refund_system_above_fee");
    await refundLate(FEE);
    expect((await orderOf(late)).refunds).toMatchObject([
      { cause: "late_payment_no_room", network_fee_payer: "shop", amount_sats: EXPECTED_SATS, network_fee_sats: FEE },
    ]);
  });
});

describe("aucune décision automatique sur un excédent (v5h)", () => {
  it("excédent, même au-dessus des frais : jamais d'initiateur system, « à traiter » jusqu'à la décision de l'admin", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    for (const extraSats of [FEE, FEE * 10n]) {
      const orderId = await paidOrder(batchId, alice, { extraSats });
      expect(await balanceOf(orderId)).toMatchObject({
        refund_due_sats: extraSats, overpayment_unrefunded: true, needs_admin_decision: false, needs_admin_attention: true,
      });

      const automatic = (data: Partial<Prisma.RefundUncheckedCreateInput>) =>
        prisma.refund.create({
          data: {
            order_id: orderId, kind: "overpayment", cause: "overpayment", initiated_by: "system", network_fee_payer: "user",
            network_fee_sats: FEE, amount: 0n, amount_sats: extraSats - FEE, reason: "Excédent", ...data,
          },
        });
      // Même un montant net positif : seul l'admin rembourse un excédent (Refund_cause_check)
      if (extraSats > FEE) expect(await constraintOf(automatic({}))).toBe("Refund_cause_check");
      else expect(await constraintOf(automatic({ amount_sats: 0n }))).toBe("Refund_user_net_positive"); // l'utilisateur ne recevrait rien
      if (extraSats > FEE) {
        expect(await constraintOf(automatic({ cause: "admin_other", network_fee_payer: "shop", amount_sats: extraSats }))).toBe("Refund_cause_check");
      }
      expect(await balanceOf(orderId)).toMatchObject({ refund_due_sats: extraSats, overpayment_unrefunded: true });

      await prisma.refund.create({
        data: { order_id: orderId, kind: "overpayment", cause: "admin_other", ...ADMIN, network_fee_sats: FEE, amount: 0n, amount_sats: extraSats, reason: "Excédent rendu, frais offerts" },
      });
      expect(await balanceOf(orderId)).toMatchObject({ refund_due_sats: 0n, overpayment_unrefunded: false, needs_admin_attention: false });
    }
  });
});

describe("brut : prorata, plafonds, frais portés par une seule ligne", () => {
  it("renoncement à une machine : le prorata porte sur le brut, l'utilisateur reçoit le brut moins les frais", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { lines: 2 });
    const [first, second] = await lineIdsOf(orderId);
    const gross = await prorata(prisma, orderId, 50_000n);
    expect(gross).toBe(EXPECTED_SATS / 2n);

    // Frais non déduits : le brut (versé + frais) dépasse le prorata
    expect(await constraintOf(prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { ...RENOUNCE, amount_sats: gross })))).toBe(
      "Refund_prorata",
    );
    await prisma.$transaction((tx) => cancelLines(tx, orderId, [first], { ...RENOUNCE, amount_sats: gross - FEE }));
    expect(await balanceOf(orderId)).toMatchObject({ refunded_sats: gross });
    // Le prorata suivant se calcule sur le brut déjà sorti du solde
    expect(await prorata(prisma, orderId, 50_000n)).toBe(EXPECTED_SATS - gross);
    await prisma.$transaction(async (tx) => {
      await cancelLines(tx, orderId, [second], { ...RENOUNCE, amount_sats: EXPECTED_SATS - gross - FEE });
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    });
    // Deux envois, deux fois les frais ; tout le reçu est sorti du solde
    expect(await balanceOf(orderId)).toMatchObject({ status: "refunded", refunded_sats: EXPECTED_SATS, unsettled_sats: 0n });
  });

  it("renoncement à toute la facture avec excédent : jamais de reliquat écrit par l'utilisateur (v5k) ; joint par l'admin, sans frais en plus", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { lines: 2, extraSats: 1_000n });
    const [first, second] = await lineIdsOf(orderId);
    const renounceAll = (by: typeof RENOUNCE | typeof RENOUNCE_BY_ADMIN, remainderFee: bigint) =>
      prisma.$transaction(async (tx) => {
        await cancelLines(tx, orderId, [first, second], { ...by, amount_sats: EXPECTED_SATS - FEE });
        await tx.refund.create({
          data: { order_id: orderId, kind: "overpayment", ...by, network_fee_sats: remainderFee, amount: 0n, amount_sats: 1_000n - remainderFee, reason: "Reliquat" },
        });
        await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
      });
    // L'utilisateur qui renonce lui-même : l'excédent ne part pas avec l'annulation (il reste « à traiter »)
    expect(await constraintOf(renounceAll(RENOUNCE, 0n))).toBe("Refund_cause_check");
    // L'admin peut le joindre : un seul envoi, les frais portés une fois
    expect(await constraintOf(renounceAll(RENOUNCE_BY_ADMIN, FEE))).toBe("Refund_fee_single_line_check");
    await renounceAll(RENOUNCE_BY_ADMIN, 0n);

    const order = await orderOf(orderId);
    expect(order.refunds.map((r) => [r.kind, r.cause, r.initiated_by, r.amount_sats, r.network_fee_sats])).toEqual([
      ["cancellation", "user_renounce", "admin", EXPECTED_SATS - FEE, FEE],
      ["overpayment", "user_renounce", "admin", 1_000n, 0n],
    ]);
    const received = order.received_sats;
    expect(order.refunds.reduce((sum, r) => sum + r.amount_sats, 0n)).toBe(received - FEE);
    expect(await balanceOf(orderId)).toMatchObject({ status: "refunded", refunded_sats: received, unsettled_sats: 0n });
  });

  it("le reliquat d'un renoncement n'existe qu'avec toute la facture ; l'excédent déjà remboursé compte brut", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { lines: 2, extraSats: 1_000n });
    const [first, second] = await lineIdsOf(orderId);
    expect(
      await constraintOf(
        prisma.$transaction(async (tx) => {
          await cancelLines(tx, orderId, [first], { ...RENOUNCE, amount_sats: EXPECTED_SATS / 2n - FEE });
          await tx.refund.create({
            data: { order_id: orderId, kind: "overpayment", ...RENOUNCE_BY_ADMIN, network_fee_sats: 0n, amount: 0n, amount_sats: 1_000n, reason: "Reliquat" },
          });
        }),
      ),
    ).toBe("Refund_cause_remainder");

    // Excédent remboursé par l'admin, frais à la charge de l'utilisateur (700 versés, 1 000 sortis du solde) ; plus de reliquat
    await prisma.refund.create({
      data: { order_id: orderId, kind: "overpayment", cause: "overpayment", ...ADMIN, network_fee_payer: "user", network_fee_sats: FEE, amount: 0n, amount_sats: 1_000n - FEE, reason: "Excédent" },
    });
    expect(await balanceOf(orderId)).toMatchObject({ refunded_sats: 1_000n, refund_due_sats: 0n, overpayment_unrefunded: false });
    await prisma.$transaction(async (tx) => {
      await cancelLines(tx, orderId, [first, second], { ...RENOUNCE, amount_sats: EXPECTED_SATS - FEE });
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    });
    expect(await balanceOf(orderId)).toMatchObject({ refunded_sats: EXPECTED_SATS + 1_000n, unsettled_sats: 0n });
  });
});

describe("journal des changements d'adresse de remboursement (OrderRefundAddressChange)", () => {
  const logOf = (orderId: string) =>
    prisma.orderRefundAddressChange
      .findMany({ where: { order_id: orderId }, orderBy: { created_at: "asc" } })
      .then((rows) => rows.map((r) => [r.old_address, r.new_address, r.actor, r.actor_auth_user_id]));

  it("saisie à la création, modification par l'admin, effacement : une ligne par écriture effective, avec l'acteur", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const aliceAuth = await authUserIdOf(prisma, alice.userId);
    const orderId = await placeOrder({ catalog, batchId, customer: alice, refundAddress: ADDRESS_A });
    await setRefundAddress(orderId, ADDRESS_A); // même valeur : rien à journaliser
    await setRefundAddress(orderId, ADDRESS_B, "admin");
    await setRefundAddress(orderId, null);
    await prisma.order.update({ where: { id: orderId }, data: { shipping_address_id: alice.addressId } }); // autre colonne, sans acteur
    expect(await logOf(orderId)).toEqual([
      [null, ADDRESS_A, "user", aliceAuth],
      [ADDRESS_A, ADDRESS_B, "admin", ADMIN_AUTH_USER_ID],
      [ADDRESS_B, null, "user", aliceAuth],
    ]);
    // Facture créée sans adresse : rien
    expect(await logOf(await placeOrder({ catalog, batchId, customer: bob }))).toEqual([]);
  });

  it("acteur obligatoire, déclaré dans la même transaction ; un utilisateur ne change que ses factures ; journal append-only", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, refundAddress: ADDRESS_A });
    const update = (tx: Tx | typeof prisma) => tx.order.update({ where: { id: orderId }, data: { refund_address: ADDRESS_B } });

    expect(await constraintOf(update(prisma))).toBe("OrderRefundAddressChange_actor");
    // La déclaration ne vaut que pour sa transaction (set_config local) : rien ne fuit sur la connexion suivante
    await setRefundAddress(orderId, ADDRESS_C);
    expect(await constraintOf(update(prisma))).toBe("OrderRefundAddressChange_actor");
    expect(await constraintOf(prisma.$transaction((tx) => declareActor(tx, "admin", 0n)))).toBe("OrderRefundAddressChange_actor");
    const bobAuth = await authUserIdOf(prisma, bob.userId);
    expect(
      await constraintOf(prisma.$transaction(async (tx) => { await declareActor(tx, "user", bobAuth); await update(tx); })),
    ).toBe("OrderRefundAddressChange_actor_user");
    // Création avec une adresse, sans acteur (refus immédiat, avant les contrôles différés de la facture)
    expect(
      await constraintOf(
        prisma.order.create({
          data: {
            user_id: bob.userId, batch_id: batchId, billing_address_id: bob.addressId, shipping_address_id: bob.addressId,
            total_amount: 50_000n, expected_sats: EXPECTED_SATS, payment_address: "bc1qv5fnoactor000000000000000000000000000",
            refund_address: ADDRESS_B, contact_email: CONTACT_EMAIL,
          },
        }),
      ),
    ).toBe("OrderRefundAddressChange_actor");

    const [entry] = await prisma.orderRefundAddressChange.findMany({ where: { order_id: orderId } });
    expect(await constraintOf(prisma.orderRefundAddressChange.update({ where: { id: entry.id }, data: { new_address: ADDRESS_C } }))).toBe(
      "OrderRefundAddressChange_append_only",
    );
    expect(await constraintOf(prisma.orderRefundAddressChange.delete({ where: { id: entry.id } }))).toBe("OrderRefundAddressChange_append_only");
    expect(await logOf(orderId)).toHaveLength(2);
  });

  it("concurrence : deux changements simultanés se suivent dans le journal (ancienne adresse lue sous verrou)", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice, refundAddress: ADDRESS_A });
    let changing: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await writeRefundAddress(tx, orderId, ADDRESS_B);
      changing = setRefundAddress(orderId, ADDRESS_C, "admin");
      await untilAnotherSessionWaitsOnLock();
    });
    await changing;
    expect((await logOf(orderId)).map(([from, to, actor]) => [from, to, actor])).toEqual([
      [null, ADDRESS_A, "user"],
      [ADDRESS_A, ADDRESS_B, "user"],
      [ADDRESS_B, ADDRESS_C, "admin"],
    ]);
  });

  it("concurrence : un changement d'adresse qui attend un envoi échoue et n'est pas journalisé", async () => {
    const batchId = await createBatch(catalog, { quantity: 5 });
    const orderId = await paidOrder(batchId, alice, { extraSats: 1_000n });
    const refund = await prisma.refund.create({
      data: { order_id: orderId, kind: "overpayment", cause: "overpayment", ...ADMIN, network_fee_payer: "user", network_fee_sats: FEE, amount: 0n, amount_sats: 700n, reason: "Excédent" },
    });
    let changing: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.refund.update({
        where: { id: refund.id },
        data: { sent_at: new Date(), reference: "txid", destination_address: ADDRESS_A, sent_by_auth_user_id: ADMIN_AUTH_USER_ID },
      });
      changing = failureOf(setRefundAddress(orderId, ADDRESS_B));
      await untilAnotherSessionWaitsOnLock();
    });
    expect(pgFailureOf(await changing!)?.constraint).toBe("Order_refund_address_frozen");
    expect(await logOf(orderId)).toHaveLength(1);
  });
});
