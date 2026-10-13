import { randomUUID } from "node:crypto";
import type {
  ActorKind,
  BatchStatus,
  HashboardStatusValue,
  MachineFunctionalStatus,
  MachineLogisticalStatus,
  Prisma,
} from "../../prisma/generated/client";
import { prisma } from "./db";

// Données minimales pour exercer les contraintes de la base (stock, factures, wishlists).

type Tx = Prisma.TransactionClient;

export const ADMIN_AUTH_USER_ID = 1n;
export const RESALE = 50_000n;
export const SILENT_PRICE = 7_500n;

export type Catalog = { modelId: string; optionId: string; noKitId: string; silentId: string };

/** Modèle « S19 » par défaut ; un second catalogue dans le même test doit porter un autre nom (Model_name_ci_key). */
export async function createCatalog(name = "S19"): Promise<Catalog> {
  const model = await prisma.model.create({ data: { name, hashrate: 95_000_000_000_000n, hashboard_qtt: 3 } });
  const option = await prisma.option.create({
    data: {
      model_id: model.id,
      kind: "choice",
      title: "Kit de ventilation",
      values: {
        create: [
          { label: "Sans kit", is_default: true, price: 0n, position: 0 },
          { label: "Silent kit", price: SILENT_PRICE, position: 1 },
        ],
      },
    },
    include: { values: { orderBy: { position: "asc" } } },
  });
  return { modelId: model.id, optionId: option.id, noKitId: option.values[0].id, silentId: option.values[1].id };
}

const PATH: BatchStatus[] = ["draft", "survey", "preorder", "ordering", "awaiting_reception", "inspection"];

/** Durée de la journée de priorité (batch_priority_ends_at) : les lots des tests sont ouverts avant. */
const PRIORITY_WINDOW_MS = 24 * 3_600_000;

/**
 * Lot amené jusqu'à `status` (le long de draft → survey → preorder → …) via le journal.
 * Par défaut le journal est antidaté (ouverture des précommandes il y a plus d'un jour) : la journée
 * de priorité est passée et tout utilisateur peut commander. `priorityOpen: true` : transitions
 * datées de maintenant, journée de priorité en cours.
 */
export async function createBatch(
  catalog: Catalog,
  {
    quantity,
    status = "preorder",
    silentMaxQty,
    priorityOpen = false,
  }: { quantity: number; status?: BatchStatus; silentMaxQty?: number; priorityOpen?: boolean },
) {
  const batch = await prisma.batch.create({
    data: {
      name: `${quantity} S19`,
      model_id: catalog.modelId,
      quantity,
      purchase_price: 100_000n,
      resale_unit_price: RESALE,
      option_values:
        silentMaxQty === undefined
          ? undefined
          : { create: { option_id: catalog.optionId, option_value_id: catalog.silentId, max_qty: silentMaxQty } },
    },
  });
  const start = Date.now() - 2 * PRIORITY_WINDOW_MS;
  const at = (i: number) => (priorityOpen ? undefined : new Date(start + i * 1_000));
  await moveBatch(batch.id, null, "draft", at(0));
  for (let i = 1; i <= PATH.indexOf(status); i++) await moveBatch(batch.id, PATH[i - 1], PATH[i], at(i));
  return batch.id;
}

/** Date d'une ouverture des précommandes antidatée : journée de priorité déjà terminée. */
export const priorityOverAt = () => new Date(Date.now() - 1.5 * PRIORITY_WINDOW_MS);

/** Transition de statut ; `at` antidate l'entrée du journal (par défaut : horloge de la base). */
export function moveBatch(batchId: string, from: BatchStatus | null, to: BatchStatus, at?: Date) {
  return prisma.batchStatusTransition.create({
    data: { batch_id: batchId, from_status: from, to_status: to, changed_by_auth_user_id: ADMIN_AUTH_USER_ID, created_at: at },
  });
}

let nextAuthUserId = 1000n;

export async function createUser() {
  const user = await prisma.user.create({
    data: {
      auth_user_id: nextAuthUserId++,
      addresses: { create: { full_name: "Client Test", line1: "1 rue", postal_code: "69001", city: "Lyon", country: "FR" } },
    },
    include: { addresses: true },
  });
  return { userId: user.id, addressId: user.addresses[0].id };
}

export type Customer = Awaited<ReturnType<typeof createUser>>;

export type Item = { optionId: string; valueId: string; price?: bigint };

/**
 * Configuration complète (Configuration_complete) : `items` plus la valeur par défaut (0 €) de
 * chaque menu visible du lot (batch_menus, non masqué) qui n'a pas de choix dans `items`.
 */
export async function completeItems(batchId: string, items: Item[], db: Tx | typeof prisma = prisma): Promise<Item[]> {
  const defaults = await db.$queryRaw<{ option_id: string; value_id: string }[]>`
    SELECT m."option_id", v."id" AS "value_id"
    FROM "batch_menus"(${batchId}::uuid) m
    JOIN "OptionValue" v ON v."option_id" = m."option_id" AND v."is_default"
    WHERE NOT m."hidden"`;
  const chosen = new Set(items.map((i) => i.optionId));
  return [
    ...items,
    ...defaults.filter((d) => !chosen.has(d.option_id)).map((d) => ({ optionId: d.option_id, valueId: d.value_id, price: 0n })),
  ];
}

/** Configuration complète (prix figés) d'un lot ; les menus non choisis reçoivent leur défaut. */
export async function createConfiguration(tx: Tx, catalog: Catalog, batchId: string, items: Item[] = []) {
  const all = await completeItems(batchId, items, tx);
  const configuration = await tx.configuration.create({
    data: {
      batch_id: batchId,
      model_id: catalog.modelId,
      base_price: RESALE,
      items: {
        create: all.map((i) => ({ option_id: i.optionId, option_value_id: i.valueId, unit_price: i.price ?? 0n })),
      },
    },
  });
  return { id: configuration.id, amount: all.reduce((sum, i) => sum + (i.price ?? 0n), RESALE) };
}

/** Configuration de ligne de commande (prix figés) ; `silent` ajoute le Silent kit. */
function createLineConfiguration(tx: Tx, catalog: Catalog, batchId: string, silent: boolean) {
  return createConfiguration(tx, catalog, batchId, [
    { optionId: catalog.optionId, valueId: silent ? catalog.silentId : catalog.noKitId, price: silent ? SILENT_PRICE : 0n },
  ]);
}

/** Wishlist (intérêt sans argent) d'un client, configuration complète. */
export function wish(catalog: Catalog, batchId: string, customer: Customer, items: Item[] = []) {
  return prisma.$transaction(async (tx) => {
    const configuration = await createConfiguration(tx, catalog, batchId, items);
    return tx.wishlist.create({
      data: { user_id: customer.userId, batch_id: batchId, configuration_id: configuration.id },
    });
  });
}

/** E-mail de contact par défaut des factures écrites par les tests (obligatoire depuis la v5k). */
export const CONTACT_EMAIL = "client@exemple.fr";

/** Montant attendu en sats d'une facture des tests (indépendant du nombre de lignes). */
export const EXPECTED_SATS = 80_000n;

export type OrderInput = {
  catalog: Catalog;
  batchId: string;
  customer: Customer;
  /** Une entrée par machine : true = avec Silent kit */
  lines?: boolean[];
  /** Wishlist convertie par la première ligne */
  wishlistId?: string;
  /** Pour fabriquer une facture déjà expirée : created_at et expires_at dans le passé */
  expiredMinutesAgo?: number;
  expectedSats?: bigint;
  /** Adresse de remboursement saisie à la création (facultative, v5e) */
  refundAddress?: string;
  /**
   * E-mail de contact de la facture (v5i), obligatoire depuis la v5k : par défaut CONTACT_EMAIL ;
   * `null` : aucun fourni, la base copie celui du profil (ou refuse : Order_contact_email_required)
   */
  contactEmail?: string | null;
};

/** Écrit une facture pending_payment et ses lignes dans la transaction `tx`. */
export async function writeOrder(
  tx: Tx,
  {
    catalog,
    batchId,
    customer,
    lines = [false],
    wishlistId,
    expiredMinutesAgo,
    expectedSats = EXPECTED_SATS,
    refundAddress,
    contactEmail = CONTACT_EMAIL,
  }: OrderInput,
) {
  const configs = [];
  for (const silent of lines) configs.push(await createLineConfiguration(tx, catalog, batchId, silent));
  // Adresse de remboursement saisie par l'utilisateur : acteur déclaré (journal OrderRefundAddressChange)
  if (refundAddress) await declareActor(tx, "user", await authUserIdOf(tx, customer.userId));
  const now = Date.now();
  const order = await tx.order.create({
    data: {
      user_id: customer.userId,
      batch_id: batchId,
      billing_address_id: customer.addressId,
      shipping_address_id: customer.addressId,
      total_amount: configs.reduce((sum, c) => sum + c.amount, 0n),
      expected_sats: expectedSats,
      payment_address: `bc1q${randomUUID().replaceAll("-", "")}`,
      refund_address: refundAddress,
      contact_email: contactEmail ?? undefined,
      ...(expiredMinutesAgo === undefined
        ? {}
        : {
            created_at: new Date(now - (expiredMinutesAgo + 30) * 60_000),
            expires_at: new Date(now - expiredMinutesAgo * 60_000),
          }),
    },
  });
  await tx.orderLine.createMany({
    data: configs.map((c, i) => ({
      order_id: order.id,
      user_id: customer.userId,
      batch_id: batchId,
      configuration_id: c.id,
      wishlist_id: i === 0 ? wishlistId : undefined,
      amount: c.amount,
    })),
  });
  return order.id;
}

/** auth_user_id d'un utilisateur de la boutique. */
export async function authUserIdOf(db: Tx | typeof prisma, userId: string) {
  return (await db.user.findUniqueOrThrow({ where: { id: userId }, select: { auth_user_id: true } })).auth_user_id;
}

/** Déclare l'acteur de la transaction `tx` (declare_actor) : requis pour écrire Order.refund_address. */
export async function declareActor(tx: Tx, kind: ActorKind, authUserId: bigint) {
  await tx.$queryRaw`SELECT "declare_actor"(${kind}::"actor_kind", ${authUserId}::bigint)`;
}

/**
 * Change l'adresse de remboursement d'une facture dans `tx` (ou dans sa propre transaction), acteur
 * déclaré : l'utilisateur de la facture (par défaut) ou l'admin.
 */
export async function writeRefundAddress(tx: Tx, orderId: string, address: string | null, actor: ActorKind = "user") {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { user_id: true } });
  await declareActor(tx, actor, actor === "admin" ? ADMIN_AUTH_USER_ID : await authUserIdOf(tx, order.user_id));
  return tx.order.update({ where: { id: orderId }, data: { refund_address: address } });
}

export function setRefundAddress(orderId: string, address: string | null, actor: ActorKind = "user") {
  return prisma.$transaction((tx) => writeRefundAddress(tx, orderId, address, actor));
}

/** Facture créée et validée (COMMIT : contrôles différés de stock et de cohérence). */
export function placeOrder(input: OrderInput) {
  return prisma.$transaction((tx) => writeOrder(tx, input));
}

/** Paiement intégral d'une facture des tests. */
export const RECEIVED_SATS = EXPECTED_SATS;

/** Paiement reçu sur l'adresse de la facture (journal Payment) ; la base l'ajoute à received_sats. */
export function receivePayment(tx: Tx | typeof prisma, orderId: string, sats: bigint) {
  return tx.payment.create({ data: { order_id: orderId, amount_sats: sats, txid: randomUUID().replaceAll("-", ""), vout: 0 } });
}

/** Paiement accepté dans `tx` : reçoit ce qui manque (appoint compris) puis passe à paid. */
export async function writePayment(tx: Tx, orderId: string, paidAt = new Date()) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.received_sats < order.expected_sats) await receivePayment(tx, orderId, order.expected_sats - order.received_sats);
  return tx.order.update({ where: { id: orderId }, data: { status: "paid", paid_at: paidAt } });
}

export function pay(orderId: string, paidAt?: Date) {
  return prisma.$transaction((tx) => writePayment(tx, orderId, paidAt));
}

/**
 * Remboursement intégral d'une facture dans `tx` : une annulation de toutes les lignes, du montant
 * total et de toute la somme BTC reçue, statut refunded. `cause` : motif à la charge de la boutique (admin_other par défaut). `receivedSats` : paiement tardif reçu dans
 * la même transaction (facture impayée) ; absent pour une facture qui a déjà reçu ses paiements.
 */
export async function writeFullRefund(
  tx: Tx,
  orderId: string,
  { receivedSats, cause = "admin_other" }: { receivedSats?: bigint; cause?: "admin_other" | "shop_stock" | "shop_defective_machine" } = {},
) {
  if (receivedSats !== undefined) await receivePayment(tx, orderId, receivedSats);
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.received_sats === 0n) throw new Error("no BTC received");
  const refund = await tx.refund.create({
    data: {
      order_id: orderId,
      kind: "cancellation",
      cause,
      initiated_by: "admin",
      created_by_auth_user_id: ADMIN_AUTH_USER_ID,
      amount: order.total_amount,
      amount_sats: order.received_sats,
      reason: "Remboursement intégral",
    },
  });
  await tx.orderLine.updateMany({ where: { order_id: orderId }, data: { refund_id: refund.id } });
  await tx.order.update({ where: { id: orderId }, data: { status: "refunded", refunded_at: new Date() } });
}

/** Annulation volontaire d'une facture en attente (statut cancelled). */
export function cancelOrder(db: Tx | typeof prisma, orderId: string) {
  return db.order.update({ where: { id: orderId }, data: { status: "cancelled", cancelled_at: new Date() } });
}

/**
 * Remboursement choisi par l'utilisateur d'une facture partiellement payée (avant ou après
 * l'expiration) : annulation de toutes les lignes, frais réseau à sa charge (déduits de ce qu'il
 * reçoit), statut refunded. `amountSats` : montant versé, par défaut reçu − frais.
 */
export async function writeUserRefund(tx: Tx, orderId: string, feeSats: bigint, amountSats?: bigint) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const refund = await tx.refund.create({
    data: {
      order_id: orderId,
      kind: "cancellation",
      cause: "partial_payment",
      amount: order.total_amount,
      amount_sats: amountSats ?? order.received_sats - feeSats,
      network_fee_sats: feeSats,
      network_fee_payer: "user",
      initiated_by: "user",
      reason: "Remboursement demandé par l'utilisateur",
    },
  });
  await tx.orderLine.updateMany({ where: { order_id: orderId }, data: { refund_id: refund.id } });
  await tx.order.update({ where: { id: orderId }, data: { status: "refunded", refunded_at: new Date() } });
}

// ─── Machines (v6) : générées à l'Attente de réception, statuts via le journal MachineStatusChange ───

/** Machines d'un lot, dans l'ordre de création (générées par la base à l'entrée en Attente de réception). */
export function machinesOf(batchId: string, db: Tx | typeof prisma = prisma) {
  return db.machine.findMany({ where: { batch_id: batchId }, orderBy: [{ created_at: "asc" }, { id: "asc" }] });
}

/**
 * Change les statuts d'une machine par le journal (from_* = statuts courants lus juste avant). `to` : statut
 * logistique et/ou fonctionnel visé ; `note` : motif (obligatoire pour une sortie du flux, un retour, une correction).
 */
export async function changeMachine(
  db: Tx | typeof prisma,
  machineId: string,
  to: { logistical?: MachineLogisticalStatus; functional?: MachineFunctionalStatus },
  note?: string,
) {
  const m = await db.machine.findUniqueOrThrow({ where: { id: machineId } });
  return db.machineStatusChange.create({
    data: {
      machine_id: machineId,
      batch_id: m.batch_id,
      from_logistical: m.logistical_status,
      to_logistical: to.logistical ?? m.logistical_status,
      from_functional: m.functional_status,
      to_functional: to.functional ?? m.functional_status,
      note,
      changed_by_auth_user_id: ADMIN_AUTH_USER_ID,
    },
  });
}

/** Saisit l'état des hashboards d'une machine (index 0, 1, 2… dans l'ordre de `statuses`). */
export async function checkHashboards(db: Tx | typeof prisma, machineId: string, statuses: HashboardStatusValue[]) {
  for (const [index, status] of statuses.entries()) {
    await db.hashboardStatus.upsert({
      where: { machine_id_index: { machine_id: machineId, index } },
      create: { machine_id: machineId, index, status, checked_by_auth_user_id: ADMIN_AUTH_USER_ID },
      update: { status, checked_by_auth_user_id: ADMIN_AUTH_USER_ID },
    });
  }
}

/**
 * Reçoit et contrôle une machine (lot au Contrôle ou après) : in_stock, hashboards et état fonctionnel saisis
 * ensemble (cohérence vérifiée au COMMIT). `functional` : ok (3 hashboards ok), degraded (une morte) ou faulty.
 */
export function receiveAndCheck(machineId: string, functional: "ok" | "degraded" | "faulty" = "ok", db?: Tx) {
  const run = async (tx: Tx) => {
    const m = await tx.machine.findUniqueOrThrow({ where: { id: machineId } });
    if (m.logistical_status === "expected") await changeMachine(tx, machineId, { logistical: "in_stock" });
    if (functional !== "faulty") await checkHashboards(tx, machineId, functional === "ok" ? ["ok", "ok", "ok"] : ["ok", "dead", "ok"]);
    await changeMachine(tx, machineId, { functional });
  };
  return db ? run(db) : prisma.$transaction(run);
}

/** Attribue (ou remplace, avec motif) la machine d'une ligne de commande payée. */
export function assignMachine(db: Tx | typeof prisma, lineId: string, batchId: string, machineId: string | null, reason?: string) {
  return db.orderLineAssignment.create({
    data: { order_line_id: lineId, batch_id: batchId, machine_id: machineId, reason, changed_by_auth_user_id: ADMIN_AUTH_USER_ID },
  });
}

/** Réglages de la boutique (ShopSettings) pour un test ; resetDatabase les remet par défaut. */
export function setShopSettings(data: {
  wishlist_max_per_user_per_batch?: number;
  order_max_lines?: number;
  abandoned_order_cooldown_minutes?: number;
  abandoned_order_limit?: number;
  abandoned_order_window_hours?: number;
}) {
  return prisma.shopSettings.update({ where: { id: 1 }, data });
}

/** Erreur levée par une promesse (échoue si elle réussit). */
export async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

/** Barrière : `wait()` se débloque quand `n` participants l'ont atteinte. */
export function barrier(n: number) {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  let arrived = 0;
  return {
    wait() {
      arrived += 1;
      if (arrived === n) release();
      return opened;
    },
  };
}

/** Attend qu'une autre session de la base soit bloquée sur un verrou (tests de concurrence). */
export async function untilAnotherSessionWaitsOnLock() {
  for (let i = 0; i < 200; i++) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no session is waiting on a lock");
}
