import { z } from "zod";
import { machines } from "../lib/plural";
import { BatchStatus, Prisma } from "../../prisma/generated/client";
import { authUserIdToDb } from "./auth";
import {
  availableTransitions,
  BATCH_FIELD_LABELS,
  BATCH_STATUS_LABELS,
  type BatchFacts,
  type BatchField,
  EDITABLE_FIELDS,
  evaluateTransition,
  isFieldEditable,
  menusWithoutChoiceMessage,
} from "./batch-status";
import {
  type MenuState,
  newlyHidden,
  newlyWithdrawn,
  planHiddenWrites,
  planSettingWrites,
  type SettingRow,
  settingsChanges,
} from "./batch-settings";
import { getDb } from "./db";
import { ApiError } from "./errors";
import { bigintToJson, cents, centsBetween, intBetween, optionalText } from "./http";

/**
 * Lots (backoffice) : création en brouillon, lecture avec compteurs, modification selon le
 * statut (EDITABLE_FIELDS), changement de statut par le journal BatchStatusTransition.
 * Batch.status n'est jamais écrit directement : la base le met à jour à l'insertion d'une transition.
 * Menus et valeurs d'un lot : catalogue vivant en brouillon, instantané à la publication
 * (fonctions SQL batch_menus / batch_offered_values, voir ./batch-settings.ts).
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | ReturnType<typeof getDb>;
export type Actor = { authUserId: string };

export const batchNotFound = () => new ApiError(404, "batch_not_found", "Lot introuvable.");

const unknownOptionValue = () =>
  new ApiError(422, "unknown_option_value", "Une des valeurs d'option indiquées n'appartient pas au modèle du lot.");

// ─── Entrées ───

const statusEnum = z.enum(BatchStatus);

const maxQty = z.int().min(0).max(1_000_000).nullable();

const optionValueSettings = z
  .array(
    z.strictObject({
      optionValueId: z.uuid(),
      /** false = valeur retirée pour ce lot */
      enabled: z.boolean().default(true),
      /** Dérogation au prix catalogue, centimes ; null = prix catalogue */
      priceOverride: cents.nullable().default(null),
      /** Nombre maximal de ventes de cette valeur ; null = illimité */
      maxQty: maxQty.default(null),
    }),
  )
  .max(500)
  .refine((settings) => new Set(settings.map((s) => s.optionValueId)).size === settings.length, {
    error: "Une valeur d'option est listée deux fois",
  });

const hiddenOptions = z
  .array(z.uuid())
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, { error: "Un menu est listé deux fois" });

/** Bornes de saisie (docs/api.md, « Bornes ») : refusent les fautes de frappe, pas les cas réels. */
export const BATCH_LIMITS = {
  maxQuantity: 10_000,
  /** Prix d'achat du lot entier : 0,01 à 100 000 000,00 */
  maxPurchasePrice: 10_000_000_000n,
  /** Prix de revente d'une machine : 0,01 à 1 000 000,00 */
  maxResaleUnitPrice: 100_000_000n,
} as const;

const batchFields = {
  modelId: z.uuid(),
  quantity: intBetween(1, BATCH_LIMITS.maxQuantity, "Nombre entier de machines"),
  purchasePrice: centsBetween(1n, BATCH_LIMITS.maxPurchasePrice),
  resaleUnitPrice: centsBetween(1n, BATCH_LIMITS.maxResaleUnitPrice).nullable(),
  /** Vide ou null : nom par défaut « {quantité} {modèle} » */
  name: optionalText(120),
  /** Réglages par valeur d'option ; liste complète (remplace les réglages existants) */
  optionValues: optionValueSettings,
  /** Menus masqués (identifiants de menus) ; liste complète */
  hiddenOptions,
};

export const batchInput = z.strictObject({
  ...batchFields,
  resaleUnitPrice: batchFields.resaleUnitPrice.optional(),
  name: batchFields.name.optional(),
  optionValues: batchFields.optionValues.optional(),
  hiddenOptions: batchFields.hiddenOptions.optional(),
});
/**
 * Horodatage ISO 8601 exact de `updatedAt` (jusqu'à la microseconde, précision Postgres).
 * Plus de 6 décimales refusé : Postgres arrondirait et la comparaison ne serait plus exacte.
 */
const expectedUpdatedAt = z
  .iso.datetime({ offset: true, error: "Horodatage ISO 8601 attendu : renvoyez tel quel le champ updatedAt du lot" })
  .refine((value) => !/\.\d{7,}/.test(value), {
    error: "Horodatage ISO 8601 attendu : renvoyez tel quel le champ updatedAt du lot",
  });

export const batchPatch = z.strictObject({
  ...z.strictObject(batchFields).partial().shape,
  /** `updatedAt` du lot lu par le client : 409 batch_modified si le lot a changé depuis */
  expectedUpdatedAt,
  /**
   * Masquer un menu où des wishlists ont fait un choix, ou retirer une valeur que des wishlists ont choisie,
   * les ramène au défaut : confirmation requise (409 hidden_menu_has_choices, withdrawn_value_has_choices)
   */
  confirmResetChoices: z.literal(true).optional(),
});

/** « Proposer sur ce lot » une valeur ajoutée au catalogue après la publication. */
export const offerValueInput = z.strictObject({
  optionValueId: z.uuid(),
  priceOverride: cents.nullable().default(null),
  maxQty: maxQty.default(null),
});

export const transitionInput = z.strictObject({
  to: statusEnum,
  /** Statut affiché à l'écran (obligatoire) : 409 batch_status_changed s'il a changé entre-temps */
  from: z.enum(BatchStatus, {
    error: "Statut de départ attendu : renvoyez le statut du lot affiché à l'écran",
  }),
  note: optionalText(1000).optional(),
});

export const batchListQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((raw) => (raw ? raw.split(",").filter(Boolean) : []))
    .pipe(z.array(statusEnum)),
  modelId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── Données agrégées d'un lot (compteurs + conditions de transition) ───

/**
 * `Batch.updated_at` (timestamptz(6)) en chaîne ISO UTC sans perte : la base l'écrit à la
 * microseconde (now(), clock_timestamp()), un `Date` JS tronquerait à la milliseconde et le
 * contrôle `expectedUpdatedAt` échouerait sur un lot pourtant inchangé.
 */
const UPDATED_AT_ISO = Prisma.sql`to_char(b."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type FactsRow = {
  id: string;
  /** updated_at en ISO 8601 UTC à la microseconde (Date JS : milliseconde seulement) */
  updated_at: string;
  quantity: number;
  status: BatchStatus;
  has_resale_price: boolean;
  menus_without_choice: string[];
  paid_lines: number;
  stock_lines: number;
  available_stock: number;
  paid_orders: number;
  pending_orders: number;
  unpaid_pending_orders: number;
  wished_machines: number;
  interested_users: number;
  received_machines: number;
  unchecked_machines: number;
  checked_machines: number;
  assigned_lines: number;
  lines_needing_parts: number;
  undelivered_part_orders: number;
  machines_in_preparation: number;
  shipped_machines: number;
  undelivered_lines: number;
  attention_orders: number;
  blocked_users: number;
  priority_ends_at: Date | null;
};

/**
 * Une requête pour plusieurs lots. Les définitions de stock sont celles de la base, source
 * unique avec le trigger de stock : batch_active_lines (lignes payées actives),
 * batch_stock_lines (+ réservations vivantes), batch_available_stock (quantity − lignes payées
 * et réservées − machines sorties du stock), order_holds_stock (facture payée ou réservation vivante).
 */
async function loadFacts(db: Db, ids: string[]): Promise<Map<string, FactsEntry>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<FactsRow[]>`
    SELECT b."id", ${UPDATED_AT_ISO} AS "updated_at", b."quantity", b."status"::text AS "status",
      b."resale_unit_price" IS NOT NULL AS "has_resale_price",
      -- Menus visibles (« choix » ou Avec/Sans) qui proposent moins de deux valeurs
      -- (batch_offered_values) : choix sans alternative, ou Avec/Sans dont « Avec » est retiré
      ARRAY(
        SELECT o."title"
        FROM "batch_menus"(b."id") m
        JOIN "Option" o ON o."id" = m."option_id"
        LEFT JOIN (SELECT ov."option_id", count(*) AS "n" FROM "batch_offered_values"(b."id") ov GROUP BY 1) c
          ON c."option_id" = o."id"
        WHERE NOT m."hidden" AND coalesce(c."n", 0) < 2
        ORDER BY o."position", o."title") AS "menus_without_choice",
      (SELECT count(*) FROM "batch_active_lines"(b."id"))::int AS "paid_lines",
      (SELECT count(*) FROM "batch_stock_lines"(b."id"))::int AS "stock_lines",
      "batch_available_stock"(b."id") AS "available_stock",
      (SELECT count(*) FROM "Order" o WHERE o."batch_id" = b."id" AND o."status" = 'paid')::int AS "paid_orders",
      (SELECT count(*) FROM "Order" o
        WHERE o."batch_id" = b."id" AND o."status" = 'pending_payment'
          AND "order_holds_stock"(o."status", o."expires_at"))::int AS "pending_orders",
      -- Annulées par une transition qui ferme les commandes (même condition que BatchStatusTransition_apply)
      (SELECT count(*) FROM "Order" o
        WHERE o."batch_id" = b."id" AND o."status" = 'pending_payment'
          AND o."received_sats" = 0 AND o."expires_at" > now())::int AS "unpaid_pending_orders",
      (SELECT count(*) FROM "Wishlist" w WHERE w."batch_id" = b."id" AND w."cancelled_at" IS NULL)::int AS "wished_machines",
      (SELECT count(DISTINCT w."user_id") FROM "Wishlist" w
        WHERE w."batch_id" = b."id" AND w."cancelled_at" IS NULL)::int AS "interested_users",
      (SELECT count(*) FROM "Machine" m
        WHERE m."batch_id" = b."id" AND m."logistical_status" NOT IN ('expected', 'missing'))::int AS "received_machines",
      (SELECT count(*) FROM "Machine" m
        WHERE m."batch_id" = b."id" AND m."logistical_status" NOT IN ('expected', 'missing')
          AND m."functional_status" = 'unknown')::int AS "unchecked_machines",
      (SELECT count(*) FROM "Machine" m
        WHERE m."batch_id" = b."id" AND m."functional_status" <> 'unknown')::int AS "checked_machines",
      (SELECT count(*) FROM "batch_active_lines"(b."id") a WHERE a."machine_id" IS NOT NULL)::int AS "assigned_lines",
      (SELECT count(*) FROM "batch_active_lines"(b."id") a
        WHERE EXISTS (
          SELECT 1 FROM "ConfigurationItem" ci
          JOIN "OptionValuePart" p ON p."option_value_id" = ci."option_value_id"
          WHERE ci."configuration_id" = a."configuration_id"))::int AS "lines_needing_parts",
      (SELECT count(*) FROM "BatchPartOrder" p
        WHERE p."batch_id" = b."id" AND p."status" <> 'delivered')::int AS "undelivered_part_orders",
      (SELECT count(*) FROM "Machine" m
        WHERE m."batch_id" = b."id" AND m."logistical_status" = 'in_preparation')::int AS "machines_in_preparation",
      (SELECT count(*) FROM "Machine" m
        WHERE m."batch_id" = b."id" AND m."logistical_status" IN ('in_transit', 'delivered'))::int AS "shipped_machines",
      (SELECT count(*) FROM "batch_active_lines"(b."id") a
        LEFT JOIN "Machine" m ON m."id" = a."machine_id"
        WHERE m."id" IS NULL OR m."logistical_status" <> 'delivered')::int AS "undelivered_lines",
      -- « À traiter » (needs_admin_attention : décision de l'admin, choix attendu de l'utilisateur, paiement
      -- complet non traité, excédent non remboursé, remboursement sans adresse)
      (SELECT count(*) FROM "order_payment_balance" pb
        WHERE pb."batch_id" = b."id" AND pb."needs_admin_attention")::int AS "attention_orders",
      (SELECT count(*) FROM "order_creation_blocks" ocb WHERE ocb."batch_id" = b."id")::int AS "blocked_users",
      "batch_priority_ends_at"(b."id") AS "priority_ends_at"
    FROM "Batch" b
    WHERE b."id" = ANY(${ids}::uuid[])`;

  return new Map(
    rows.map((r) => {
      const facts: BatchFacts = {
        status: r.status,
        hasResalePrice: r.has_resale_price,
        menusWithoutChoice: r.menus_without_choice,
        paidOrders: r.paid_orders,
        pendingOrders: r.pending_orders,
        unpaidPendingOrders: r.unpaid_pending_orders,
        receivedMachines: r.received_machines,
        uncheckedMachines: r.unchecked_machines,
        checkedMachines: r.checked_machines,
        assignedLines: r.assigned_lines,
        linesNeedingParts: r.lines_needing_parts,
        undeliveredPartOrders: r.undelivered_part_orders,
        machinesInPreparation: r.machines_in_preparation,
        shippedMachines: r.shipped_machines,
        undeliveredLines: r.undelivered_lines,
      };
      const counters = {
        /** Machines payées (lignes actives de commandes payées) */
        paidMachines: r.paid_lines,
        /** Machines réservées par une facture en attente (30 min) */
        pendingMachines: r.stock_lines - r.paid_lines,
        /** Payées + réservées : ce qui consomme le stock */
        orderedMachines: r.stock_lines,
        /**
         * Machines encore vendables (batch_available_stock). Non bornée à 0 : une valeur
         * négative signale un lot survendu (impossible après COMMIT, mais visible si une règle change).
         */
        availableStock: r.available_stock,
        paidOrders: r.paid_orders,
        pendingOrders: r.pending_orders,
        /** Wishlists actives (une par machine souhaitée) */
        interestedMachines: r.wished_machines,
        interestedUsers: r.interested_users,
        /** Factures « à traiter » (GET /api/backoffice/orders/attention) */
        attentionOrders: r.attention_orders,
        /** Utilisateurs bloqués après trop d'abandons (GET /api/backoffice/order-blocks) */
        blockedUsers: r.blocked_users,
      };
      // used : places du stock théorique déjà prises (vendues, réservées, machines hors stock)
      return [
        r.id,
        {
          facts,
          counters,
          used: r.quantity - r.available_stock,
          updatedAt: r.updated_at,
          priorityEndsAt: r.priority_ends_at?.toISOString() ?? null,
        },
      ] as const;
    }),
  );
}

type FactsEntry = { facts: BatchFacts; counters: Counters; used: number; updatedAt: string; priorityEndsAt: string | null };

type Counters = {
  paidMachines: number;
  pendingMachines: number;
  orderedMachines: number;
  availableStock: number;
  paidOrders: number;
  pendingOrders: number;
  interestedMachines: number;
  interestedUsers: number;
  attentionOrders: number;
  blockedUsers: number;
};

/** Lignes payées ou réservées portant chaque valeur d'option, défauts compris (batch_option_usage, source de max_qty). */
async function usageByOptionValue(db: Db, batchId: string) {
  const rows = await db.$queryRaw<{ option_value_id: string; used: number }[]>`
    SELECT "option_value_id", "used" FROM "batch_option_usage"(${batchId}::uuid)`;
  return new Map(rows.map((r) => [r.option_value_id, r.used]));
}

/** Menus applicables au lot (batch_menus) et existence de leur ligne BatchOption. */
async function loadMenus(db: Db, batchId: string): Promise<MenuState[]> {
  return db.$queryRaw<MenuState[]>`
    SELECT m."option_id" AS "optionId", m."hidden",
      EXISTS (SELECT 1 FROM "BatchOption" bo WHERE bo."batch_id" = ${batchId}::uuid AND bo."option_id" = m."option_id") AS "hasRow"
    FROM "batch_menus"(${batchId}::uuid) m`;
}

/**
 * Intérêt des wishlists actives par valeur d'option, défauts compris : machines souhaitées et
 * utilisateurs distincts. Un menu masqué n'a pas d'item (son défaut s'applique d'office) : il
 * n'apparaît pas. `choices` par menu = machines dont le choix n'est pas le défaut, ce que masquer
 * le menu ramènerait au défaut (trigger BatchOption_sync_choices).
 */
async function wishlistInterest(db: Db, batchId: string) {
  const rows = await db.$queryRaw<
    { option_id: string; option_value_id: string; is_default: boolean; machines: number; users: number }[]
  >`
    SELECT ci."option_id", ci."option_value_id", v."is_default",
      count(*)::int AS "machines", count(DISTINCT w."user_id")::int AS "users"
    FROM "Wishlist" w
    JOIN "ConfigurationItem" ci ON ci."configuration_id" = w."configuration_id"
    JOIN "OptionValue" v ON v."id" = ci."option_value_id"
    WHERE w."batch_id" = ${batchId}::uuid AND w."cancelled_at" IS NULL
    GROUP BY ci."option_id", ci."option_value_id", v."is_default"`;
  const byValue = new Map(rows.map((r) => [r.option_value_id, { machines: r.machines, users: r.users }]));
  const choicesByMenu = new Map<string, number>();
  for (const r of rows) {
    if (!r.is_default) choicesByMenu.set(r.option_id, (choicesByMenu.get(r.option_id) ?? 0) + r.machines);
  }
  return { byValue, choicesByMenu };
}

// ─── Sorties ───

const batchInclude = { model: { select: { id: true, name: true } } } satisfies Prisma.BatchInclude;
type BatchRow = Prisma.BatchGetPayload<{ include: typeof batchInclude }>;

function batchSummaryDto(batch: BatchRow, { facts, counters, updatedAt, priorityEndsAt }: FactsEntry) {
  return {
    id: batch.id,
    name: batch.name,
    status: batch.status,
    statusLabel: BATCH_STATUS_LABELS[batch.status],
    model: batch.model,
    quantity: batch.quantity,
    purchasePrice: bigintToJson(batch.purchase_price),
    resaleUnitPrice: bigintToJson(batch.resale_unit_price),
    createdAt: batch.created_at.toISOString(),
    updatedAt,
    /** Fin de la journée de priorité (null : aucune) */
    priorityEndsAt,
    counters,
    transitions: availableTransitions(facts),
  };
}

/** Nombre de lots par statut (tous les statuts, 0 compris), filtré par modèle s'il est donné. */
async function countByStatus(db: Db, modelId?: string): Promise<Record<BatchStatus, number>> {
  const groups = await db.batch.groupBy({
    by: ["status"],
    where: modelId ? { model_id: modelId } : {},
    _count: { _all: true },
  });
  const counts = Object.fromEntries(Object.values(BatchStatus).map((s) => [s, 0])) as Record<BatchStatus, number>;
  for (const g of groups) counts[g.status] = g._count._all;
  return counts;
}

export async function listBatches(query: z.output<typeof batchListQuery>) {
  const db = getDb();
  const where: Prisma.BatchWhereInput = {
    ...(query.status.length > 0 ? { status: { in: query.status } } : {}),
    ...(query.modelId ? { model_id: query.modelId } : {}),
  };
  const [total, batches, statusCounts] = await Promise.all([
    db.batch.count({ where }),
    db.batch.findMany({
      where,
      include: batchInclude,
      orderBy: [{ updated_at: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    countByStatus(db, query.modelId),
  ]);
  const facts = await loadFacts(db, batches.map((b) => b.id));
  return {
    items: batches.map((b) => batchSummaryDto(b, facts.get(b.id)!)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    /** Lots par statut, sans le filtre `status` (compteurs des filtres de l'UI) */
    statusCounts,
  };
}

/** Disponibilité d'une valeur sur le lot. */
type Availability = "offered" | "withdrawn" | "not_offered";

export async function getBatch(batchId: string, db: Db = getDb()) {
  const batch = await db.batch.findUnique({
    where: { id: batchId },
    include: {
      model: {
        include: {
          options: {
            include: { values: { orderBy: [{ position: "asc" }, { label: "asc" }] } },
            orderBy: [{ position: "asc" }, { title: "asc" }],
          },
        },
      },
      option_values: true,
      status_transitions: { orderBy: { created_at: "asc" } },
    },
  });
  if (!batch) throw batchNotFound();
  const [facts, usage, menus, interest] = await Promise.all([
    loadFacts(db, [batchId]),
    usageByOptionValue(db, batchId),
    loadMenus(db, batchId),
    wishlistInterest(db, batchId),
  ]);
  const f = facts.get(batchId)!;
  const settings = new Map(batch.option_values.map((s) => [s.option_value_id, s]));
  const menuById = new Map(menus.map((m) => [m.optionId, m]));
  const { model } = batch;
  const draft = batch.status === "draft";
  // Proposer une valeur après coup : lot publié qui accepte encore des configurations
  const canOffer = !["draft", "closed", "cancelled"].includes(batch.status);

  return {
    ...batchSummaryDto({ ...batch, model: { id: model.id, name: model.name } }, f),
    model: { id: model.id, name: model.name, hashrate: bigintToJson(model.hashrate), hashboardQtt: model.hashboard_qtt },
    editableFields: EDITABLE_FIELDS[batch.status],
    /** Menus applicables au lot : tous ceux du modèle en brouillon, l'instantané de publication ensuite */
    options: model.options
      .filter((option) => menuById.has(option.id))
      .map((option) => ({
        id: option.id,
        kind: option.kind,
        title: option.title,
        description: option.description,
        position: option.position,
        /** Menu masqué : la valeur par défaut s'applique d'office */
        hidden: menuById.get(option.id)!.hidden,
        /** Choix (hors défaut) des wishlists actives : ramenés au défaut si le menu est masqué */
        wishlistChoices: interest.choicesByMenu.get(option.id) ?? 0,
        values: option.values.map((value) => {
          const s = settings.get(value.id);
          const availability: Availability = s ? (s.enabled ? "offered" : "withdrawn") : draft ? "offered" : "not_offered";
          const priceOverride = s?.price_override ?? null;
          return {
            id: value.id,
            label: value.label,
            isDefault: value.is_default,
            position: value.position,
            price: bigintToJson(value.price),
            availability,
            enabled: availability === "offered",
            /** Valeur ajoutée au catalogue après la publication : « Proposer sur ce lot » possible */
            canOffer: availability === "not_offered" && canOffer,
            priceOverride: bigintToJson(priceOverride),
            effectivePrice: bigintToJson(priceOverride ?? value.price),
            maxQty: s?.max_qty ?? null,
            /** Lignes payées ou réservées ayant choisi cette valeur (défaut compris) */
            used: usage.get(value.id) ?? 0,
            /** Manifestations d'intérêt actives ayant choisi cette valeur (défaut compris) : machines et utilisateurs distincts */
            interest: interest.byValue.get(value.id) ?? { machines: 0, users: 0 },
          };
        }),
      })),
    history: batch.status_transitions.map((t) => ({
      id: t.id,
      from: t.from_status,
      to: t.to_status,
      note: t.note,
      changedBy: t.changed_by_auth_user_id.toString(),
      createdAt: t.created_at.toISOString(),
    })),
  };
}

export type BatchDetail = Awaited<ReturnType<typeof getBatch>>;

// ─── Réglages d'options par lot ───

type Setting = z.output<typeof optionValueSettings>[number];

/** Valide les réglages contre le modèle ; écarte ceux qui n'ont aucun effet (hériter du catalogue). */
async function resolveSettings(tx: Tx, modelId: string, settings: Setting[]): Promise<SettingRow[]> {
  const values = await tx.optionValue.findMany({
    where: { id: { in: settings.map((s) => s.optionValueId) }, option: { model_id: modelId } },
    select: { id: true, option_id: true, is_default: true, label: true },
  });
  const byId = new Map(values.map((v) => [v.id, v]));
  const rows: SettingRow[] = [];
  for (const s of settings) {
    const value = byId.get(s.optionValueId);
    if (!value) throw unknownOptionValue();
    if (value.is_default) assertDefaultSetting(value.label, s);
    if (s.enabled && s.priceOverride === null && s.maxQty === null) continue;
    rows.push({ ...s, optionId: value.option_id });
  }
  return rows;
}

/** Le défaut d'un menu n'est jamais retiré et reste gratuit (pas de dérogation non nulle). */
function assertDefaultSetting(label: string, s: { enabled: boolean; priceOverride: bigint | null }) {
  if (!s.enabled) {
    throw new ApiError(
      409,
      "default_value_withdrawn",
      `« ${label} » est la valeur par défaut de son menu : elle ne peut pas être retirée du lot (masquez plutôt le menu).`,
    );
  }
  if (s.priceOverride !== null && s.priceOverride !== 0n) {
    throw new ApiError(422, "default_value_not_free", `« ${label} » est la valeur par défaut de son menu : elle reste gratuite.`);
  }
}

const settingData = (batchId: string, modelId: string, r: SettingRow) => ({
  batch_id: batchId,
  model_id: modelId,
  option_id: r.optionId,
  option_value_id: r.optionValueId,
  enabled: r.enabled,
  price_override: r.priceOverride,
  max_qty: r.maxQty,
});

/** Écrit les réglages ligne par ligne (voir planSettingWrites) ; ne supprime qu'en brouillon. */
async function writeSettings(tx: Tx, batchId: string, modelId: string, current: SettingRow[], next: SettingRow[], draft: boolean) {
  const writes = planSettingWrites(current, next, { draft });
  if (writes.remove.length > 0) {
    await tx.batchOptionValue.deleteMany({ where: { batch_id: batchId, option_value_id: { in: writes.remove } } });
  }
  for (const r of writes.update) {
    await tx.batchOptionValue.update({
      where: { batch_id_option_value_id: { batch_id: batchId, option_value_id: r.optionValueId } },
      data: { enabled: r.enabled, price_override: r.priceOverride, max_qty: r.maxQty },
    });
  }
  if (writes.create.length > 0) {
    await tx.batchOptionValue.createMany({ data: writes.create.map((r) => settingData(batchId, modelId, r)) });
  }
}

/** Masque exactement les menus `hidden` (voir planHiddenWrites) ; jamais de suppression. */
async function writeHidden(tx: Tx, batchId: string, modelId: string, menus: MenuState[], hidden: ReadonlySet<string>) {
  const writes = planHiddenWrites(menus, hidden);
  for (const w of writes.update) {
    await tx.batchOption.update({
      where: { batch_id_option_id: { batch_id: batchId, option_id: w.optionId } },
      data: { hidden: w.hidden },
    });
  }
  if (writes.create.length > 0) {
    await tx.batchOption.createMany({
      data: writes.create.map((optionId) => ({ batch_id: batchId, model_id: modelId, option_id: optionId, hidden: true })),
    });
  }
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

const defaultName = (quantity: number, modelName: string) => `${quantity} ${modelName}`;

// ─── Création ───

export async function createBatch(input: z.output<typeof batchInput>, actor: Actor) {
  const batchId = await getDb().$transaction(async (tx) => {
    const model = await tx.model.findUnique({ where: { id: input.modelId }, select: { id: true, name: true } });
    if (!model) throw new ApiError(422, "unknown_model", "Ce modèle n'existe pas.");
    const settings = await resolveSettings(tx, model.id, input.optionValues ?? []);
    const batch = await tx.batch.create({
      data: {
        model_id: model.id,
        name: input.name ?? defaultName(input.quantity, model.name),
        quantity: input.quantity,
        purchase_price: input.purchasePrice,
        resale_unit_price: input.resaleUnitPrice ?? null,
      },
    });
    // Création journalisée : première ligne du journal (from_status NULL)
    await tx.batchStatusTransition.create({
      data: { batch_id: batch.id, from_status: null, to_status: "draft", changed_by_auth_user_id: authUserIdToDb(actor.authUserId) },
    });
    await writeSettings(tx, batch.id, model.id, [], settings, true);
    if (input.hiddenOptions?.length) {
      await writeHidden(tx, batch.id, model.id, await loadMenus(tx, batch.id), new Set(input.hiddenOptions));
    }
    return batch.id;
  });
  return getBatch(batchId);
}

// ─── Modification ───

/**
 * Verrouille le lot (FOR UPDATE) et vérifie qu'il n'a pas changé depuis la lecture du client
 * (autre onglet, autre admin, changement de statut) : comparaison exacte en base, à la microseconde.
 */
async function lockUnchangedBatch(tx: Tx, batchId: string, expectedUpdatedAt: string) {
  const [row] = await tx.$queryRaw<{ unchanged: boolean }[]>`
    SELECT "updated_at" = ${expectedUpdatedAt}::timestamptz AS "unchanged"
    FROM "Batch" WHERE "id" = ${batchId}::uuid FOR UPDATE`;
  if (!row) throw batchNotFound();
  if (!row.unchanged) {
    throw new ApiError(
      409,
      "batch_modified",
      "Le lot a été modifié entre-temps (autre onglet ou autre administrateur). Rechargez la page pour repartir de la version à jour : vos modifications n'ont pas été enregistrées.",
    );
  }
}

/**
 * Horodatage de la base, à la microseconde : Prisma (@updatedAt) écrit l'heure du nœud
 * applicatif à la milliseconde ; deux enregistrements dans la même milliseconde, ou deux
 * nœuds aux horloges décalées, pourraient sinon laisser updated_at inchangé.
 */
const touchBatch = (tx: Tx, batchId: string) =>
  tx.$executeRaw`UPDATE "Batch" SET "updated_at" = clock_timestamp() WHERE "id" = ${batchId}::uuid`;

/**
 * Modifie un lot. Un champ envoyé avec sa valeur actuelle est ignoré (l'UI peut renvoyer tout
 * le formulaire) ; un champ modifié hors de EDITABLE_FIELDS[statut] donne 409 batch_field_locked.
 * Nom : null le remet au défaut ; sans nom envoyé, un nom par défaut suit quantité et modèle.
 * Masquer un menu où des wishlists ont choisi une autre valeur que le défaut les y ramène :
 * refusé (409 hidden_menu_has_choices) sans `confirmResetChoices: true`. De même pour retirer une
 * valeur choisie par des wishlists (409 withdrawn_value_has_choices).
 */
export async function updateBatch(batchId: string, patch: z.output<typeof batchPatch>) {
  await getDb().$transaction(async (tx) => {
    await lockUnchangedBatch(tx, batchId, patch.expectedUpdatedAt);
    const batch = await tx.batch.findUniqueOrThrow({
      where: { id: batchId },
      include: { model: { select: { name: true } }, option_values: true },
    });
    const draft = batch.status === "draft";

    const modelId = patch.modelId ?? batch.model_id;
    const modelChanged = modelId !== batch.model_id;
    const model = modelChanged ? await tx.model.findUnique({ where: { id: modelId }, select: { name: true } }) : batch.model;
    if (!model) throw new ApiError(422, "unknown_model", "Ce modèle n'existe pas.");
    const quantity = patch.quantity ?? batch.quantity;

    const current: SettingRow[] = batch.option_values.map((s) => ({
      optionValueId: s.option_value_id,
      optionId: s.option_id,
      enabled: s.enabled,
      priceOverride: s.price_override,
      maxQty: s.max_qty,
    }));
    // Changer de modèle sans nouveaux réglages efface les réglages (ils visent l'ancien modèle).
    const next = patch.optionValues
      ? await resolveSettings(tx, modelId, patch.optionValues)
      : modelChanged
        ? []
        : current;

    const menus = modelChanged ? [] : await loadMenus(tx, batchId);
    const hiddenBefore = new Set(menus.filter((m) => m.hidden).map((m) => m.optionId));
    const hiddenAfter = patch.hiddenOptions ? new Set(patch.hiddenOptions) : modelChanged ? new Set<string>() : hiddenBefore;

    const changed = new Set<BatchField>();
    if (modelChanged) changed.add("modelId");
    if (quantity !== batch.quantity) changed.add("quantity");
    if (patch.purchasePrice !== undefined && patch.purchasePrice !== batch.purchase_price) changed.add("purchasePrice");
    if (patch.resaleUnitPrice !== undefined && patch.resaleUnitPrice !== batch.resale_unit_price) changed.add("resaleUnitPrice");
    if (patch.name !== undefined && (patch.name ?? defaultName(quantity, model.name)) !== batch.name) changed.add("name");
    const settings = settingsChanges(modelChanged ? [] : current, next);
    if (settings.availability) changed.add("optionAvailability");
    if (settings.maxQty) changed.add("optionMaxQty");
    if (!sameSet(hiddenBefore, hiddenAfter)) changed.add("hiddenOptions");

    const locked = [...changed].filter((field) => !isFieldEditable(batch.status, field));
    if (locked.length > 0) {
      const names = locked.map((f) => `« ${BATCH_FIELD_LABELS[f]} »`).join(", ");
      throw new ApiError(
        409,
        "batch_field_locked",
        `Au statut « ${BATCH_STATUS_LABELS[batch.status]} », ces champs ne sont plus modifiables : ${names}.`,
      );
    }
    if (changed.size === 0) return;

    if (patch.resaleUnitPrice === null && !draft) {
      throw new ApiError(422, "resale_price_required", "Le prix de revente est obligatoire une fois le lot publié.");
    }
    if (changed.has("quantity") || changed.has("optionMaxQty")) {
      const { used } = (await loadFacts(tx, [batchId])).get(batchId)!;
      if (quantity < used) {
        throw new ApiError(
          409,
          "quantity_below_sold",
          `La quantité ne peut pas être inférieure à ${machines(used)} (vendues, réservées ou retirées du stock).`,
        );
      }
      const usage = await usageByOptionValue(tx, batchId);
      if (next.some((s) => s.maxQty !== null && s.maxQty < (usage.get(s.optionValueId) ?? 0))) {
        throw new ApiError(
          409,
          "max_qty_below_sold",
          "Une quantité maximale d'option est inférieure au nombre de machines déjà vendues ou réservées avec cette option.",
        );
      }
    }
    if ((changed.has("hiddenOptions") || changed.has("optionAvailability")) && !modelChanged && !patch.confirmResetChoices) {
      const { choicesByMenu, byValue } = await wishlistInterest(tx, batchId);
      const hiddenReset = newlyHidden(menus, hiddenAfter).reduce((sum, id) => sum + (choicesByMenu.get(id) ?? 0), 0);
      if (hiddenReset > 0) {
        throw new ApiError(
          409,
          "hidden_menu_has_choices",
          `Masquer ce menu ramènera ${hiddenReset} choix de manifestation(s) d'intérêt à la valeur par défaut. Confirmez pour continuer.`,
        );
      }
      // Retirer une valeur ramène tout de suite au défaut les wishlists qui l'avaient choisie (v5j, sondage
      // compris ; les personnes sont prévenues par optionWithdrawals) : l'admin confirme d'abord
      const chosen = newlyWithdrawn(current, next).filter((id) => (byValue.get(id)?.machines ?? 0) > 0);
      if (chosen.length > 0) {
        const values = await tx.optionValue.findMany({ where: { id: { in: chosen } }, select: { label: true } });
        const wishlists = chosen.reduce((sum, id) => sum + byValue.get(id)!.machines, 0);
        throw new ApiError(
          409,
          "withdrawn_value_has_choices",
          `Retirer ${values.map((v) => `« ${v.label} »`).join(", ")} du lot ramènera ${wishlists} manifestation(s) d'intérêt à la valeur par défaut du menu (les personnes concernées en seront prévenues, leur priorité est conservée). Confirmez pour continuer.`,
          undefined,
          { details: { wishlists } },
        );
      }
    }

    // Nom par défaut qui suit la quantité et le modèle tant que l'admin ne l'a pas personnalisé
    const followsDefault = batch.name === defaultName(batch.quantity, batch.model.name);
    const name =
      patch.name !== undefined
        ? (patch.name ?? defaultName(quantity, model.name))
        : followsDefault
          ? defaultName(quantity, model.name)
          : batch.name;

    // Réglages et menus référencent (lot, modèle) : ils partent avant un changement de modèle
    // (brouillon seulement, EDITABLE_FIELDS ; la base refuse toute suppression hors brouillon).
    if (modelChanged) {
      await tx.batchOptionValue.deleteMany({ where: { batch_id: batchId } });
      await tx.batchOption.deleteMany({ where: { batch_id: batchId } });
    }
    await tx.batch.update({
      where: { id: batchId },
      data: {
        name,
        model_id: modelId,
        quantity,
        purchase_price: patch.purchasePrice,
        resale_unit_price: patch.resaleUnitPrice,
      },
    });
    if (changed.has("optionAvailability") || changed.has("optionMaxQty") || modelChanged) {
      await writeSettings(tx, batchId, modelId, modelChanged ? [] : current, next, draft);
    }
    if (changed.has("hiddenOptions")) {
      await writeHidden(tx, batchId, modelId, modelChanged ? await loadMenus(tx, batchId) : menus, hiddenAfter);
    }
    // Lot publié : retirer des valeurs ou réafficher un menu ne doit pas laisser un menu visible
    // (« choix » ou Avec/Sans) sans alternative (en brouillon, c'est une condition de publication : evaluateTransition).
    if (!draft && (changed.has("optionAvailability") || changed.has("hiddenOptions"))) {
      const { facts } = (await loadFacts(tx, [batchId])).get(batchId)!;
      if (facts.menusWithoutChoice.length > 0) {
        throw new ApiError(409, "menu_without_choice", menusWithoutChoiceMessage(facts.menusWithoutChoice));
      }
    }
    await touchBatch(tx, batchId);
  });
  return getBatch(batchId);
}

/**
 * « Proposer sur ce lot » : rend disponible sur un lot publié (sondage à en transit) une valeur
 * ajoutée au catalogue après sa publication, éventuellement avec une dérogation de prix et une
 * quantité maximale. Le menu doit s'appliquer au lot (instantané de publication).
 */
export async function offerOptionValue(batchId: string, input: z.output<typeof offerValueInput>) {
  await getDb().$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ status: BatchStatus; model_id: string }[]>`
      SELECT "status"::text AS "status", "model_id" FROM "Batch" WHERE "id" = ${batchId}::uuid FOR UPDATE`;
    if (!row) throw batchNotFound();
    if (row.status === "draft") {
      throw new ApiError(
        409,
        "batch_draft",
        "En brouillon, toutes les valeurs du catalogue sont proposées : réglez-les dans le formulaire du lot.",
      );
    }
    if (row.status === "closed" || row.status === "cancelled") {
      throw new ApiError(409, "batch_finished", "Ce lot est clôturé ou annulé : aucune valeur d'option ne peut plus y être proposée.");
    }
    const value = await tx.optionValue.findFirst({
      where: { id: input.optionValueId, option: { model_id: row.model_id } },
      select: { option_id: true, label: true, is_default: true },
    });
    if (!value) throw unknownOptionValue();
    if (value.is_default) assertDefaultSetting(value.label, { enabled: true, priceOverride: input.priceOverride });
    const applicable = await tx.batchOption.count({ where: { batch_id: batchId, option_id: value.option_id } });
    if (applicable === 0) {
      throw new ApiError(409, "option_not_applicable", "Ce menu ne s'applique pas à ce lot : il a été ajouté au modèle après la publication du lot.");
    }
    const exists = await tx.batchOptionValue.count({ where: { batch_id: batchId, option_value_id: input.optionValueId } });
    if (exists > 0) {
      throw new ApiError(409, "option_value_already_offered", `« ${value.label} » est déjà réglée sur ce lot.`);
    }
    await tx.batchOptionValue.create({
      data: settingData(batchId, row.model_id, {
        optionValueId: input.optionValueId,
        optionId: value.option_id,
        enabled: true,
        priceOverride: input.priceOverride,
        maxQty: input.maxQty,
      }),
    });
    await touchBatch(tx, batchId);
  });
  return getBatch(batchId);
}

// ─── Statut ───

/**
 * Seul point d'entrée des changements de statut d'un lot. Dans une transaction, sous verrou du lot :
 * vérifie le statut attendu (`from`, obligatoire), le couple (TRANSITIONS), le motif et les conditions métier
 * (evaluateTransition), puis INSÈRE une BatchStatusTransition ; la base applique le statut et
 * revérifie le couple et l'absence de commande payée en cas d'annulation.
 */
export async function changeBatchStatus(
  batchId: string,
  input: { to: BatchStatus; from: BatchStatus; note?: string | null },
  actor: Actor,
) {
  await getDb().$transaction(async (tx) => {
    // Lot qui ferme les commandes (annulé, en transit, clôturé : batch_accepts_orders faux) : le trigger de
    // la base annule les factures en attente sans versement (v5h, v5i). Elles se verrouillent AVANT le lot,
    // dans l'ordre des paiements et de l'annulation par l'utilisateur (facture puis lot, Order_check >
    // Batch_lock au COMMIT) : sinon un paiement en cours et cette transition s'attendraient l'un l'autre
    // (interblocage). Un paiement validé entre-temps exclut sa facture de l'annulation.
    await tx.$queryRaw`
      SELECT 1 FROM "Order"
      WHERE "batch_id" = ${batchId}::uuid AND "status" = 'pending_payment'
        AND NOT coalesce("batch_accepts_orders"(${input.to}::"batch_status"), false)
      ORDER BY "id" FOR NO KEY UPDATE`;
    const [row] = await tx.$queryRaw<{ status: BatchStatus }[]>`
      SELECT "status"::text AS "status" FROM "Batch" WHERE "id" = ${batchId}::uuid FOR UPDATE`;
    if (!row) throw batchNotFound();
    if (input.from !== row.status) {
      throw new ApiError(
        409,
        "batch_status_changed",
        `Le lot est passé au statut « ${BATCH_STATUS_LABELS[row.status]} » entre-temps. Rechargez la page.`,
      );
    }
    const { facts } = (await loadFacts(tx, [batchId])).get(batchId)!;
    const check = evaluateTransition(facts, input.to);
    if (!check) {
      throw new ApiError(
        409,
        "transition_not_allowed",
        `Impossible de passer de « ${BATCH_STATUS_LABELS[row.status]} » à « ${BATCH_STATUS_LABELS[input.to]} ».`,
      );
    }
    if (check.noteRequired && !input.note) {
      throw new ApiError(422, "note_required", `Indiquez un motif pour « ${check.action} ».`);
    }
    if (!check.allowed) throw new ApiError(409, "transition_blocked", check.blockers.join(" "));
    await tx.batchStatusTransition.create({
      data: {
        batch_id: batchId,
        from_status: row.status,
        to_status: input.to,
        note: input.note ?? null,
        changed_by_auth_user_id: authUserIdToDb(actor.authUserId),
      },
    });
  });
  return getBatch(batchId);
}
