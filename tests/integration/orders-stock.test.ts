import { beforeEach, describe, expect, it } from "vitest";
import { pgFailureOf, toErrorResponse } from "@/server/errors";
import type { Prisma } from "../../prisma/generated/client";
import { prisma } from "./db";
import {
  CONTACT_EMAIL,
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
  RECEIVED_SATS,
  RESALE,
  wish as wishFor,
  writeFullRefund,
  writeOrder,
  writePayment,
} from "./fixtures";

// Contraintes de la base sur les factures et le stock (migration init, triggers).
// Chaque erreur est aussi passée à toErrorResponse : le code métier doit arriver au client.

let catalog: Catalog;
let alice: Customer;
let bob: Customer;

beforeEach(async () => {
  catalog = await createCatalog();
  alice = await createUser();
  bob = await createUser();
});

async function errorCode(error: unknown) {
  const response = toErrorResponse(error);
  return { status: response.status, code: (await response.json()).error.code as string };
}

async function orderStatus(orderId: string) {
  return (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
}

describe("noms de contrainte des triggers jusqu'au code métier", () => {
  it("trigger différé (COMMIT) : Batch_stock -> out_of_stock", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    await placeOrder({ catalog, batchId, customer: alice });
    const error = await failureOf(placeOrder({ catalog, batchId, customer: bob }));
    expect(pgFailureOf(error)).toEqual({ sqlstate: "23514", constraint: "Batch_stock" });
    expect(await errorCode(error)).toEqual({ status: 409, code: "out_of_stock" });
  });

  it("trigger immédiat (requête) : Order_batch_open -> batch_not_open", async () => {
    const batchId = await createBatch(catalog, { quantity: 1, status: "survey" });
    const error = await failureOf(placeOrder({ catalog, batchId, customer: alice }));
    expect(pgFailureOf(error)).toEqual({ sqlstate: "23514", constraint: "Order_batch_open" });
    expect(await errorCode(error)).toEqual({ status: 409, code: "batch_not_open" });
  });

  it("max_qty : BatchOptionValue_max_qty_stock -> option_out_of_stock", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, silentMaxQty: 1 });
    await placeOrder({ catalog, batchId, customer: alice, lines: [true] });
    const error = await failureOf(placeOrder({ catalog, batchId, customer: bob, lines: [true] }));
    expect(await errorCode(error)).toEqual({ status: 409, code: "option_out_of_stock" });
  });
});

describe("réservation de 30 minutes", () => {
  it("une facture en attente non expirée occupe le stock", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    await placeOrder({ catalog, batchId, customer: alice, lines: [false] });
    const error = await failureOf(placeOrder({ catalog, batchId, customer: bob, lines: [false, false] }));
    expect(pgFailureOf(error)?.constraint).toBe("Batch_stock");
    await placeOrder({ catalog, batchId, customer: bob, lines: [false] });
  });

  it("une facture expirée libère sa place sans job, même encore en pending_payment", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const expired = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 1 });
    await placeOrder({ catalog, batchId, customer: bob });
    expect(await orderStatus(expired)).toBe("pending_payment");
  });

  it("le réservé compte aussi pour max_qty", async () => {
    const batchId = await createBatch(catalog, { quantity: 5, silentMaxQty: 1 });
    await placeOrder({ catalog, batchId, customer: alice, lines: [true], expiredMinutesAgo: 1 });
    await placeOrder({ catalog, batchId, customer: bob, lines: [true] });
    // Un troisième client (Alice sort d'une facture expirée : délai anti-accaparement)
    const error = await failureOf(placeOrder({ catalog, batchId, customer: await createUser(), lines: [true] }));
    expect(pgFailureOf(error)?.constraint).toBe("BatchOptionValue_max_qty_stock");
  });

  it("la réservation dure 30 minutes au plus, horloge de la base par défaut, immuable", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    const [{ minutes }] = await prisma.$queryRaw<{ minutes: number }[]>`
      SELECT extract(epoch FROM "expires_at" - now()) / 60 AS minutes FROM "Order" WHERE "id" = ${orderId}::uuid`;
    expect(Number(minutes)).toBeGreaterThan(29);
    expect(Number(minutes)).toBeLessThanOrEqual(30);

    const longer = await failureOf(
      prisma.order.update({ where: { id: orderId }, data: { expires_at: new Date(Date.now() + 40 * 60_000) } }),
    );
    expect(pgFailureOf(longer)?.constraint).toBe("Order_immutable");

    // Contrôle immédiat à l'insertion (avant les contrôles différés de lignes et de total).
    const tooLong = await failureOf(
      prisma.order.create({
        data: {
          user_id: bob.userId,
          batch_id: batchId,
          billing_address_id: bob.addressId,
          shipping_address_id: bob.addressId,
          total_amount: RESALE,
          expected_sats: EXPECTED_SATS,
          payment_address: "bc1qtoolong",
          contact_email: CONTACT_EMAIL,
          expires_at: new Date(Date.now() + 31 * 60_000),
        },
      }),
    );
    expect(pgFailureOf(tooLong)?.constraint).toBe("Order_reservation_length");
  });

  it("expired seulement après l'échéance", async () => {
    const batchId = await createBatch(catalog, { quantity: 2 });
    const live = await placeOrder({ catalog, batchId, customer: alice });
    const early = await failureOf(
      prisma.order.update({ where: { id: live }, data: { status: "expired", expired_at: new Date() } }),
    );
    expect(pgFailureOf(early)?.constraint).toBe("Order_expired_early");

    const old = await placeOrder({ catalog, batchId, customer: bob, expiredMinutesAgo: 1 });
    await prisma.order.update({ where: { id: old }, data: { status: "expired", expired_at: new Date() } });
  });
});

describe("paiement tardif", () => {
  it("accepté s'il reste de la place", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const late = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 5 });
    await prisma.order.update({ where: { id: late }, data: { status: "expired", expired_at: new Date() } });
    const [{ fits }] = await prisma.$queryRaw<{ fits: boolean }[]>`SELECT "Order_fits_stock"(${late}::uuid) AS fits`;
    expect(fits).toBe(true);
    await pay(late);
    expect(await orderStatus(late)).toBe("paid");
  });

  it("sans place : paiement refusé, puis remboursement intégral de la somme BTC reçue", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const late = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 5 });
    await placeOrder({ catalog, batchId, customer: bob }); // a pris la place libérée

    const refused = await failureOf(pay(late));
    expect(await errorCode(refused)).toEqual({ status: 409, code: "out_of_stock" });

    const [{ fits }] = await prisma.$queryRaw<{ fits: boolean }[]>`SELECT "Order_fits_stock"(${late}::uuid) AS fits`;
    expect(fits).toBe(false);
    await prisma.$transaction((tx) => writeFullRefund(tx, late, { receivedSats: RECEIVED_SATS }));
    const order = await prisma.order.findUniqueOrThrow({ where: { id: late }, include: { refunds: true } });
    expect(order.status).toBe("refunded");
    expect(order.refunds.map((r) => r.amount_sats)).toEqual([RECEIVED_SATS]);
  });

  it("pas de remboursement d'un paiement reçu dans le délai de réservation", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const live = await placeOrder({ catalog, batchId, customer: alice });
    const error = await failureOf(prisma.$transaction((tx) => writeFullRefund(tx, live, { receivedSats: RECEIVED_SATS })));
    expect(pgFailureOf(error)?.constraint).toBe("Order_late_payment_refund");
  });

  it("pas de remboursement d'un paiement tardif s'il reste de la place", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const late = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 5 });
    const error = await failureOf(prisma.$transaction((tx) => writeFullRefund(tx, late, { receivedSats: RECEIVED_SATS })));
    expect(pgFailureOf(error)?.constraint).toBe("Order_late_payment_refund");
  });

  it("un remboursement intégral renvoie exactement la somme BTC reçue", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const orderId = await placeOrder({ catalog, batchId, customer: alice });
    await pay(orderId);
    const error = await failureOf(
      prisma.$transaction(async (tx) => {
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        const refund = await tx.refund.create({
          data: {
            order_id: orderId, kind: "cancellation", cause: "admin_other", initiated_by: "admin", created_by_auth_user_id: 1n,
            amount: order.total_amount, amount_sats: RECEIVED_SATS - 1n, reason: "Annulation",
          },
        });
        await tx.orderLine.updateMany({ where: { order_id: orderId }, data: { refund_id: refund.id } });
        await tx.order.update({ where: { id: orderId }, data: { status: "refunded", refunded_at: new Date() } });
      }),
    );
    expect(pgFailureOf(error)?.constraint).toBe("Order_refunded_in_full");
  });

  it("un lot abandonné rembourse un paiement reçu sur une réservation encore vivante", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const live = await placeOrder({ catalog, batchId, customer: alice });
    await moveBatch(batchId, "preorder", "cancelled");
    const error = await failureOf(pay(live));
    expect(pgFailureOf(error)?.constraint).toBe("Order_batch_open");
    await prisma.$transaction((tx) => writeFullRefund(tx, live, { receivedSats: RECEIVED_SATS }));
    expect(await orderStatus(live)).toBe("refunded");
  });
});

describe("concurrence (READ COMMITTED, verrou du lot)", () => {
  it("deux réservations pour la dernière place : une seule passe", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const sync = barrier(2);
    const results = await Promise.allSettled(
      [alice, bob].map((customer) =>
        prisma.$transaction(async (tx) => {
          const id = await writeOrder(tx, { catalog, batchId, customer });
          await sync.wait(); // les deux factures sont écrites avant le premier COMMIT
          return id;
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(pgFailureOf(rejected?.reason)?.constraint).toBe("Batch_stock");
    expect(await prisma.order.count()).toBe(1);
  });

  it("paiement tardif contre nouvelle réservation sur la place libérée : une seule passe", async () => {
    const batchId = await createBatch(catalog, { quantity: 1 });
    const late = await placeOrder({ catalog, batchId, customer: alice, expiredMinutesAgo: 1 });
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
    const rejected = results.find((r) => r.status === "rejected");
    expect(pgFailureOf(rejected?.reason)?.constraint).toBe("Batch_stock");
    const [{ used }] = await prisma.$queryRaw<{ used: bigint }[]>`
      SELECT count(*) AS used FROM "batch_stock_lines"(${batchId}::uuid)`;
    expect(used).toBe(1n);
  });
});

describe("surplus de commandes payées", () => {
  it("machine morte : on rembourse la dernière payée dans la même transaction", async () => {
    const batchId = await createBatch(catalog, { quantity: 2, status: "inspection" });
    const first = await placeOrder({ catalog, batchId, customer: alice });
    await pay(first, new Date(Date.now() - 60_000));
    const second = await placeOrder({ catalog, batchId, customer: bob });
    await pay(second, new Date());
    const machines = await Promise.all(
      [1, 2].map((n) =>
        prisma.machine.create({
          data: { batch_id: batchId, model_id: catalog.modelId, serial: `SN-${n}`, logistical_status: "in_stock", received_at: new Date() },
        }),
      ),
    );
    const scrap = (tx: Prisma.TransactionClient) =>
      tx.machine.update({ where: { id: machines[1].id }, data: { functional_status: "faulty", logistical_status: "scrapped" } });

    // Seule, la mise au rebut dépasse le stock : refusée.
    expect(pgFailureOf(await failureOf(prisma.$transaction((tx) => scrap(tx))))?.constraint).toBe("Batch_stock");

    // Avec le remboursement de la dernière commande payée (paid_at le plus récent), dans la même transaction.
    await prisma.$transaction(async (tx) => {
      await scrap(tx);
      const [latest] = await tx.order.findMany({
        where: { batch_id: batchId, status: "paid" },
        orderBy: [{ paid_at: "desc" }, { id: "desc" }],
        take: 1,
      });
      await writeFullRefund(tx, latest.id);
    });
    expect(await orderStatus(first)).toBe("paid");
    expect(await orderStatus(second)).toBe("refunded");
  });
});

describe("statut du lot", () => {
  const OPEN_OR_LATER = [
    "preorder", "ordering", "awaiting_reception", "inspection", "tuning",
    "packaging", "in_transit", "closed", "cancelled",
  ];

  it("aucun retour vers survey ou draft une fois la précommande ouverte", async () => {
    const rows = await prisma.$queryRaw<{ f: string; t: string }[]>`
      SELECT f::text, t::text
      FROM unnest(${OPEN_OR_LATER}::batch_status[]) f, unnest(ARRAY['draft', 'survey']::batch_status[]) t
      WHERE "batch_transition_allowed"(f, t)`;
    expect(rows).toEqual([]);

    const batchId = await createBatch(catalog, { quantity: 1 });
    const error = await failureOf(moveBatch(batchId, "preorder", "survey"));
    expect(pgFailureOf(error)?.constraint).toBe("BatchStatusTransition_allowed_check");
  });
});

describe("wishlist uniquement pendant le sondage", () => {
  const wish = (batchId: string, customer: Customer) => wishFor(catalog, batchId, customer);

  it("acceptée en survey, refusée avant et après", async () => {
    const draft = await createBatch(catalog, { quantity: 1, status: "draft" });
    expect(pgFailureOf(await failureOf(wish(draft, alice)))?.constraint).toBe("Wishlist_batch_survey");

    const batchId = await createBatch(catalog, { quantity: 1, status: "survey" });
    const wishlist = await wish(batchId, alice);
    await prisma.wishlist.update({ where: { id: wishlist.id }, data: { cancelled_at: new Date() } });
    await moveBatch(batchId, "survey", "preorder");

    expect(pgFailureOf(await failureOf(wish(batchId, bob)))?.constraint).toBe("Wishlist_batch_survey");
    const reactivate = await failureOf(
      prisma.wishlist.update({ where: { id: wishlist.id }, data: { cancelled_at: null } }),
    );
    expect(pgFailureOf(reactivate)?.constraint).toBe("Wishlist_batch_survey");
  });
});
