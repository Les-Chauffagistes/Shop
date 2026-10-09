import { z } from "zod";
import { type PartMovementKind, type PartOrderStatus, Prisma } from "../../prisma/generated/client";
import type { Actor } from "./batches";
import { authUserIdToDb } from "./auth";
import { batchNotFound } from "./batches";
import { partNotFound } from "./catalog";
import { getDb } from "./db";
import { ApiError } from "./errors";
import { intBetween, label, optionalText } from "./http";

/**
 * Stock des produits d'options (Part) : stock commun à tous les lots, journal append-only
 * PartStockMovement (stock physique = somme des mouvements, jamais négatif en base), commandes
 * de produits par lot (BatchPartOrder) et lectures calculées (vues SQL part_stock,
 * batch_part_needs, part_stock_pressure, jamais stockées, lues par $queryRaw).
 * Toutes les règles sont garanties en base ; ce module les devance pour des messages clairs.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | ReturnType<typeof getDb>;

export const partOrderNotFound = () => new ApiError(404, "part_order_not_found", "Commande de produit introuvable.");

const MAX_KITS = 100_000;

// ─── Domaine pur ───

export const PART_ORDER_STATUS_LABELS: Record<PartOrderStatus, string> = {
  ordering: "Commande en cours",
  awaiting_delivery: "Attente de livraison",
  delivered: "Livré",
};

/** Avance seulement (BatchPartOrder_status_transition) : on peut sauter l'attente de livraison. */
const PART_ORDER_NEXT: Record<PartOrderStatus, readonly PartOrderStatus[]> = {
  ordering: ["awaiting_delivery", "delivered"],
  awaiting_delivery: ["delivered"],
  delivered: [],
};

export function canAdvancePartOrder(from: PartOrderStatus, to: PartOrderStatus): boolean {
  return PART_ORDER_NEXT[from].includes(to);
}

export const PART_MOVEMENT_LABELS: Record<PartMovementKind, string> = {
  reception: "Réception",
  adjustment: "Correction d'inventaire",
  kit_mounted: "Kit monté",
};

// ─── Entrées ───

const kits = intBetween(1, MAX_KITS, "Nombre de kits");

/**
 * Mouvement saisi par l'admin. `quantity` est un nombre de kits positif pour une réception
 * (entrée) et un kit monté (sortie, le serveur le signe) ; signé pour une correction.
 * Réception d'une commande de lot : passer par la livraison de la commande (PATCH part-orders).
 */
export const movementInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reception"), quantity: kits, note: optionalText(500).optional() }),
  z.strictObject({
    kind: z.literal("adjustment"),
    quantity: intBetween(-MAX_KITS, MAX_KITS, "Nombre de kits").refine((q) => q !== 0, {
      error: "Correction non nulle attendue (positive pour ajouter, négative pour retirer)",
    }),
    /** Motif obligatoire */
    note: label(500),
  }),
  z.strictObject({
    kind: z.literal("kit_mounted"),
    quantity: kits,
    batchId: z.uuid(),
    machineId: z.uuid().optional(),
    note: optionalText(500).optional(),
  }),
]);

export type MovementInput = z.output<typeof movementInput>;

/** Quantité signée du journal : entrée > 0, sortie < 0. */
export function signedQty(input: Pick<MovementInput, "kind" | "quantity">): number {
  return input.kind === "kit_mounted" ? -input.quantity : input.quantity;
}

export const partOrderInput = z.strictObject({ partId: z.uuid(), qty: kits });

export const partOrderPatch = z
  .strictObject({
    status: z.enum(["awaiting_delivery", "delivered"]).optional(),
    /** Quantité commandée (tant que la commande n'est pas livrée) */
    qty: kits.optional(),
    /** Livraison : kits réellement reçus (défaut : quantité commandée) */
    receivedQty: kits.optional(),
    /** Livraison : remarque jointe à la réception */
    note: optionalText(500).optional(),
  })
  .refine((p) => p.status === "delivered" || (p.receivedQty === undefined && p.note === undefined), {
    error: "receivedQty et note ne s'indiquent qu'à la livraison (status: \"delivered\")",
    path: ["status"],
  });

// ─── Lectures calculées ───

type PressureRow = {
  part_id: string;
  name: string;
  reference: string | null;
  on_hand: number;
  ordering_qty: number;
  awaiting_delivery_qty: number;
  firm_demand: number;
  potential_demand: number;
  pressure: string | null;
  over_pressure: boolean;
  shortfall: number;
  to_order: number;
};

function pressureDto(r: PressureRow) {
  return {
    partId: r.part_id,
    name: r.name,
    reference: r.reference,
    /** Stock physique (somme du journal) */
    onHand: r.on_hand,
    /** Kits commandés (commandes de lot « Commande en cours ») */
    orderingQty: r.ordering_qty,
    /** Kits en route (« Attente de livraison ») */
    awaitingDeliveryQty: r.awaiting_delivery_qty,
    /** Demande ferme restant à prélever : lignes payées + factures en attente non expirées, moins les kits montés */
    firmDemand: r.firm_demand,
    /** Wishlists des lots au sondage (hors pression) */
    potentialDemand: r.potential_demand,
    /** Demande ferme ÷ stock physique, décimal en chaîne ("1.600") ; null = demande sans stock (infinie) */
    pressure: r.pressure,
    /** Avertissement : pression > 1 */
    overPressure: r.over_pressure,
    /** Manque par rapport au stock physique */
    shortfall: r.shortfall,
    /** Manque une fois comptés les kits commandés et en route */
    toOrder: r.to_order,
  };
}

export type PartPressure = ReturnType<typeof pressureDto>;

function selectPressure(db: Db, partIds?: string[]) {
  const where = partIds ? Prisma.sql`WHERE "part_id" = ANY(${partIds}::uuid[])` : Prisma.empty;
  return db.$queryRaw<PressureRow[]>`
    SELECT "part_id", "name", "reference", "on_hand", "ordering_qty", "awaiting_delivery_qty",
      "firm_demand", "potential_demand", "pressure"::text AS "pressure", "over_pressure", "shortfall", "to_order"
    FROM "part_stock_pressure"
    ${where}
    ORDER BY "name", "part_id"`;
}

/** Vue d'ensemble : stock et pression de chaque produit d'option. */
export async function listPartStock() {
  return { items: (await selectPressure(getDb())).map(pressureDto) };
}

type NeedRow = {
  part_id: string;
  firm_qty: number;
  potential_qty: number;
  mounted_qty: number;
  remaining_qty: number;
  ordered_qty: number;
  delivered_qty: number;
};

const partOrderInclude = { part: { select: { name: true } }, reception: { select: { qty: true } } } satisfies Prisma.BatchPartOrderInclude;
type PartOrderRow = Prisma.BatchPartOrderGetPayload<{ include: typeof partOrderInclude }>;

function partOrderDto(o: PartOrderRow) {
  return {
    id: o.id,
    batchId: o.batch_id,
    partId: o.part_id,
    partName: o.part.name,
    qty: o.qty,
    status: o.status,
    statusLabel: PART_ORDER_STATUS_LABELS[o.status],
    orderedAt: o.ordered_at.toISOString(),
    deliveredAt: o.delivered_at?.toISOString() ?? null,
    /** Kits reçus (réception rattachée), null avant la livraison */
    receivedQty: o.reception?.qty ?? null,
  };
}

/**
 * Fiche lot : besoin par produit (batch_part_needs), avec le stock commun et la pression
 * globale du produit (part_stock_pressure), et les commandes de produits du lot.
 */
export async function getBatchPartNeeds(batchId: string) {
  const db = getDb();
  const batch = await db.batch.findUnique({ where: { id: batchId }, select: { id: true } });
  if (!batch) throw batchNotFound();
  const [needs, orders] = await Promise.all([
    db.$queryRaw<NeedRow[]>`
      SELECT "part_id", "firm_qty", "potential_qty", "mounted_qty", "remaining_qty", "ordered_qty", "delivered_qty"
      FROM "batch_part_needs" WHERE "batch_id" = ${batchId}::uuid`,
    db.batchPartOrder.findMany({ where: { batch_id: batchId }, include: partOrderInclude, orderBy: { ordered_at: "asc" } }),
  ]);
  const stock = new Map(
    (await selectPressure(db, needs.map((n) => n.part_id))).map((r) => [r.part_id, pressureDto(r)]),
  );
  return {
    batchId,
    parts: needs
      .map((n) => {
        const s = stock.get(n.part_id)!;
        return {
          partId: n.part_id,
          name: s.name,
          reference: s.reference,
          /** Kits de la demande ferme du lot (payées + factures en attente non expirées) */
          firmQty: n.firm_qty,
          /** Kits des wishlists (lot au sondage) */
          potentialQty: n.potential_qty,
          /** Kits déjà montés sur ce lot */
          mountedQty: n.mounted_qty,
          /** Demande ferme restant à prélever sur le stock commun (0 pour un lot clos ou annulé) */
          remainingQty: n.remaining_qty,
          /** Kits commandés pour ce lot, non livrés / livrés */
          orderedQty: n.ordered_qty,
          deliveredQty: n.delivered_qty,
          /** Stock commun et pression globale du produit (tous lots) */
          stock: s,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "fr")),
    orders: orders.map(partOrderDto),
  };
}

// ─── Journal de stock ───

const movementInclude = { batch: { select: { name: true } } } satisfies Prisma.PartStockMovementInclude;
type MovementRow = Prisma.PartStockMovementGetPayload<{ include: typeof movementInclude }>;

function movementDto(m: MovementRow) {
  return {
    id: m.id,
    partId: m.part_id,
    kind: m.kind,
    kindLabel: PART_MOVEMENT_LABELS[m.kind],
    /** Signé : entrée > 0, sortie < 0 */
    qty: m.qty,
    batchPartOrderId: m.batch_part_order_id,
    batch: m.batch_id ? { id: m.batch_id, name: m.batch!.name } : null,
    machineId: m.machine_id,
    note: m.note,
    createdBy: m.created_by_auth_user_id.toString(),
    createdAt: m.created_at.toISOString(),
  };
}

const MOVEMENTS_LIMIT = 200;

/** Journal d'un produit, du plus récent au plus ancien (200 derniers), avec son stock. */
export async function listMovements(partId: string) {
  const db = getDb();
  if (!(await db.part.findUnique({ where: { id: partId }, select: { id: true } }))) throw partNotFound();
  const [movements, [stock]] = await Promise.all([
    db.partStockMovement.findMany({
      where: { part_id: partId },
      include: movementInclude,
      orderBy: [{ created_at: "desc" }, { id: "asc" }],
      take: MOVEMENTS_LIMIT,
    }),
    selectPressure(db, [partId]),
  ]);
  return { stock: pressureDto(stock), items: movements.map(movementDto) };
}

/**
 * Enregistre un mouvement : réception hors commande de lot (réassort), correction d'inventaire
 * (motif obligatoire) ou kit monté sur une machine d'un lot. La base refuse un stock négatif
 * (409 part_stock_insufficient, sous verrou du produit) et un kit étranger au modèle du lot.
 */
export async function createMovement(partId: string, input: MovementInput, actor: Actor) {
  const movementId = await getDb().$transaction(async (tx) => {
    if (!(await tx.part.findUnique({ where: { id: partId }, select: { id: true } }))) throw partNotFound();
    if (input.kind === "kit_mounted") {
      const batch = await tx.batch.findUnique({ where: { id: input.batchId }, select: { id: true } });
      if (!batch) throw new ApiError(422, "unknown_batch", "Ce lot n'existe pas.");
      if (input.machineId) {
        const machine = await tx.machine.count({ where: { id: input.machineId, batch_id: input.batchId } });
        if (machine === 0) throw new ApiError(422, "unknown_machine", "Cette machine n'appartient pas au lot indiqué.");
      }
    }
    const movement = await tx.partStockMovement.create({
      data: {
        part_id: partId,
        kind: input.kind,
        qty: signedQty(input),
        batch_id: input.kind === "kit_mounted" ? input.batchId : null,
        machine_id: input.kind === "kit_mounted" ? (input.machineId ?? null) : null,
        note: input.note ?? null,
        created_by_auth_user_id: authUserIdToDb(actor.authUserId),
      },
    });
    return movement.id;
  });
  const db = getDb();
  const [movement, [stock]] = await Promise.all([
    db.partStockMovement.findUniqueOrThrow({ where: { id: movementId }, include: movementInclude }),
    selectPressure(db, [partId]),
  ]);
  return { movement: movementDto(movement), stock: pressureDto(stock) };
}

// ─── Commandes de produits par lot ───

const readPartOrder = async (db: Db, orderId: string) =>
  partOrderDto(await db.batchPartOrder.findUniqueOrThrow({ where: { id: orderId }, include: partOrderInclude }));

/** Commande d'un produit pour un lot (une par produit et par lot), statut « Commande en cours ». */
export async function createPartOrder(batchId: string, input: z.output<typeof partOrderInput>) {
  return getDb().$transaction(async (tx) => {
    const batch = await tx.batch.findUnique({ where: { id: batchId }, select: { status: true } });
    if (!batch) throw batchNotFound();
    if (batch.status === "closed" || batch.status === "cancelled") {
      throw new ApiError(409, "batch_finished", "Ce lot est clôturé ou annulé : on ne commande plus de produit pour lui.");
    }
    if (!(await tx.part.findUnique({ where: { id: input.partId }, select: { id: true } }))) {
      throw new ApiError(422, "unknown_part", "Ce produit n'existe pas.");
    }
    const order = await tx.batchPartOrder.create({ data: { batch_id: batchId, part_id: input.partId, qty: input.qty } });
    return readPartOrder(tx, order.id);
  });
}

/**
 * Fait avancer une commande de produit ou corrige sa quantité. Livraison (`status: delivered`) :
 * statut, date de livraison et mouvement de réception rattaché (kits reçus, par défaut la quantité
 * commandée) dans une seule transaction, sous verrou de la commande ; la base exige les deux
 * ensemble (BatchPartOrder_reception) et une seule réception par commande.
 */
export async function updatePartOrder(orderId: string, patch: z.output<typeof partOrderPatch>, actor: Actor) {
  return getDb().$transaction(async (tx) => {
    const [order] = await tx.$queryRaw<{ status: PartOrderStatus; qty: number; part_id: string }[]>`
      SELECT "status"::text AS "status", "qty", "part_id" FROM "BatchPartOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    if (!order) throw partOrderNotFound();
    const qty = patch.qty ?? order.qty;
    if (qty !== order.qty && order.status === "delivered") {
      throw new ApiError(409, "part_order_frozen", "Cette commande est livrée : sa quantité ne change plus.");
    }
    const status = patch.status ?? order.status;
    if (status !== order.status && !canAdvancePartOrder(order.status, status)) {
      throw new ApiError(
        409,
        "part_order_status_invalid",
        `La commande est « ${PART_ORDER_STATUS_LABELS[order.status]} » : elle ne peut pas passer à « ${PART_ORDER_STATUS_LABELS[status]} ».`,
      );
    }
    // Rejeu de la livraison : idempotent s'il est identique (même quantité reçue ou quantité
    // absente) ; une autre quantité est refusée, la réception étant unique (revue qualité M7).
    if (order.status === "delivered" && patch.receivedQty !== undefined) {
      const reception = await tx.partStockMovement.findFirst({
        where: { batch_part_order_id: orderId, kind: "reception" },
        select: { qty: true },
      });
      if (reception && reception.qty !== patch.receivedQty) {
        throw new ApiError(
          409,
          "part_order_already_delivered",
          `Cette commande est déjà livrée avec ${reception.qty} kit(s) reçu(s) : la quantité reçue ne change plus. Pour corriger le stock, enregistrez une correction d'inventaire sur le produit.`,
        );
      }
    }
    const delivering = status === "delivered" && order.status !== "delivered";
    await tx.batchPartOrder.update({
      where: { id: orderId },
      data: { qty, status, ...(delivering ? { delivered_at: new Date() } : {}) },
    });
    if (delivering) {
      await tx.partStockMovement.create({
        data: {
          part_id: order.part_id,
          kind: "reception",
          qty: patch.receivedQty ?? qty,
          batch_part_order_id: orderId,
          note: patch.note ?? null,
          created_by_auth_user_id: authUserIdToDb(actor.authUserId),
        },
      });
    }
    return readPartOrder(tx, orderId);
  });
}
