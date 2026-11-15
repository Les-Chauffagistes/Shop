import { z } from "zod";
import {
  type BatchKind,
  type BatchStatus,
  MachineFunctionalStatus,
  MachineLogisticalStatus,
  Prisma,
  type RefundCause,
} from "../../prisma/generated/client";
import { machines as machinesLabel, plural } from "../lib/plural";
import { authUserIdToDb } from "./auth";
import { batchStatusLabel } from "./batch-status";
import { type Actor, batchNotFound } from "./batches";
import { getDb } from "./db";
import { ApiError, type JsonValue } from "./errors";
import { intBetween, optionalText } from "./http";
import {
  isInHand,
  MACHINE_FUNCTIONAL_LABELS,
  MACHINE_LOGISTICAL_LABELS,
  nextMachineChanges,
} from "./machine-status";
import { cancelOrderLines } from "./orders";
import { getPaymentService } from "./payment-service";

/**
 * Machines (backoffice, jalon 5 et refonte R3) : lecture (liste filtrée, fiche, machines et commandes d'un lot,
 * stock par modèle), réception (en bloc, numéros de série collés), machine reçue en plus d'une palette, contrôle
 * (état fonctionnel et hashboards, « Tout OK » en bloc), statuts logistiques jusqu'à la livraison, attribution aux
 * lignes payées (manuelle, automatique, remplacement).
 *
 * Toutes les règles sont celles de la base (migration machines) : le serveur insère dans les journaux
 * (MachineStatusChange, HashboardStatus, OrderLineAssignment) et traduit les refus. Statuts et dates d'une machine
 * ne s'écrivent jamais directement.
 *
 * Machines en moins (« commandes en trop ») : toute écriture qui laisserait un lot avec plus de lignes payées et
 * réservées que de machines utilisables (batch_available_stock < 0, refusée par Batch_stock au COMMIT) est
 * détectée avant le COMMIT ; les lignes à rembourser sont les premières de batch_surplus_lines (paiement le plus
 * récent d'abord, source unique en base). Sans confirmation : `409 machine_shortage` (rien n'est écrit) ; avec
 * `confirmRefunds` = exactement ces lignes : même transaction, factures verrouillées d'abord, lignes annulées par le
 * moteur de remboursement des commandes (cancelOrderLines, frais à la charge de la boutique), puis l'écriture.
 * Ordre des verrous : factures → lignes → machines (par id) → lot(s).
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | ReturnType<typeof getDb>;

/** Écritures en bloc (jusqu'à quelques milliers de machines) : délai de transaction relevé (défaut Prisma : 5 s). */
const BULK = { timeout: 60_000 } as const;

export const machineNotFound = () => new ApiError(404, "machine_not_found", "Machine introuvable.");
export const lineNotFound = () => new ApiError(404, "line_not_found", "Ligne de commande introuvable.");

// ─── Entrées ───

const logistical = z.enum(MachineLogisticalStatus);
const functional = z.enum(MachineFunctionalStatus);

const uniqueIds = (max: number, what: string) =>
  z
    .array(z.uuid())
    .min(1, { error: `Choisissez au moins une ${what}` })
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { error: `Une ${what} est listée deux fois` });

/** Numéro de série : texte court, espaces de bord retirés. */
const serial = z.string().trim().min(1, { error: "Numéro de série vide" }).max(100, { error: "100 caractères au plus" });

/**
 * Numéros de série collés en bloc (une ligne par machine) : lignes vides ignorées, doublons refusés. Appariés dans
 * l'ordre aux machines reçues.
 */
const serialList = z
  .array(z.string().trim().max(100, { error: "100 caractères au plus" }))
  .max(10_000)
  .transform((lines) => lines.filter((l) => l !== ""))
  .refine((lines) => new Set(lines).size === lines.length, { error: "Un numéro de série est collé deux fois" });

const hashboardValue = z.enum(["ok", "degraded", "dead"], { error: "État de hashboard attendu : ok, degraded ou dead" });

const hashboards = z
  .array(z.strictObject({ index: z.int().min(0).max(19), status: hashboardValue }))
  .max(20)
  .refine((h) => new Set(h.map((x) => x.index)).size === h.length, { error: "Une hashboard est listée deux fois" });

const trackingUrl = z
  .string()
  .trim()
  .max(500, { error: "500 caractères au plus" })
  .refine((url) => url === "" || /^https?:\/\/\S+$/i.test(url), { error: "Lien http:// ou https:// attendu" })
  .nullable()
  .transform((url) => (url ? url : null));

/** Suivi du transporteur (facultatif) ; `null` ou `""` efface. */
const tracking = {
  carrier: optionalText(100),
  trackingNumber: optionalText(100),
  trackingUrl,
};

/**
 * Lignes annoncées par `409 machine_shortage` (`details.refunds[].lineId`), renvoyées telles quelles pour confirmer
 * leur remboursement : la requête est refusée si la liste ne correspond plus (autre paiement entre-temps).
 */
const confirmRefunds = z.array(z.uuid()).max(1000).optional();

const statusItem = z.strictObject({
  machineId: z.uuid(),
  /** Statuts affichés (obligatoires) : 409 machine_status_changed s'ils ont changé entre-temps */
  from: z.strictObject(
    { logistical, functional },
    { error: "Statuts affichés attendus : renvoyez logistical et functional de la machine affichée" },
  ),
  to: z
    .strictObject({ logistical: logistical.optional(), functional: functional.optional() })
    .refine((to) => to.logistical !== undefined || to.functional !== undefined, {
      error: "Indiquez le statut logistique ou l'état fonctionnel visé",
    }),
  /** Hashboards saisies avec le changement ; `to.functional: "ok"` sans liste : toutes OK */
  hashboards: hashboards.optional(),
  note: optionalText(1000).optional(),
  /** Remise au transporteur : transporteur, numéro et lien de suivi */
  tracking: z.strictObject(tracking).partial().optional(),
});

export const statusChangesInput = z
  .strictObject({
    items: z
      .array(statusItem)
      .min(1, { error: "Au moins une machine" })
      .max(1000)
      .refine((items) => new Set(items.map((i) => i.machineId)).size === items.length, {
        error: "Une machine est listée deux fois",
      }),
    confirmRefunds,
  })
  .superRefine((input, ctx) => {
    input.items.forEach((item, i) => {
      if (item.tracking && item.to.logistical !== "in_transit") {
        ctx.addIssue({ code: "custom", path: ["items", i, "tracking"], message: "Le suivi se donne à la remise au transporteur" });
      }
    });
  });

export const hashboardsInput = z.strictObject({
  hashboards: hashboards.refine((h) => h.length > 0, { error: "Au moins une hashboard" }),
});

/** « Tout OK » : hashboards toutes OK et machine OK (contrôle ou recontrôle après un retour en main). */
export const checkOkInput = z.strictObject({
  machineIds: uniqueIds(1000, "machine"),
  /** Obligatoire pour corriger une machine déjà saisie dégradée ou défectueuse */
  note: optionalText(1000).optional(),
});

const expectedUpdatedAt = z.iso.datetime({
  offset: true,
  error: "Horodatage ISO 8601 attendu : renvoyez tel quel le champ updatedAt de la machine",
});

export const machinePatch = z.strictObject({
  expectedUpdatedAt,
  serial: serial.nullable().optional(),
  psuSerial: serial.nullable().optional(),
  note: optionalText(1000).optional(),
  ...z.strictObject(tracking).partial().shape,
});

/**
 * Réception en bloc des machines attendues d'un lot (palette ou réassort du lot de stock). Au choix :
 * `machineIds` (ces machines), sinon `serials` (autant de machines attendues que de numéros, les plus anciennes
 * d'abord), sinon `count` (défaut : toutes les attendues). `serials` est apparié dans l'ordre aux machines reçues.
 */
export const receptionInput = z
  .strictObject({
    machineIds: uniqueIds(10_000, "machine").optional(),
    serials: serialList.optional(),
    count: intBetween(1, 10_000, "Nombre entier de machines").optional(),
  })
  .superRefine((input, ctx) => {
    if (input.machineIds && input.count !== undefined) {
      ctx.addIssue({ code: "custom", path: ["count"], message: "Choisissez des machines ou un nombre, pas les deux" });
    }
    if (input.serials && input.count !== undefined && input.serials.length > 0 && input.serials.length !== input.count) {
      ctx.addIssue({ code: "custom", path: ["count"], message: "Autant de machines que de numéros de série" });
    }
    if (input.machineIds && input.serials && input.serials.length > 0 && input.serials.length !== input.machineIds.length) {
      ctx.addIssue({ code: "custom", path: ["serials"], message: "Un numéro de série par machine choisie (ou aucun)" });
    }
  });

/** Machines reçues en plus d'une palette pleine : créées reçues au lot de stock du modèle. */
export const extraMachinesInput = z
  .strictObject({
    serials: serialList.optional(),
    count: intBetween(1, 1000, "Nombre entier de machines").optional(),
    note: optionalText(500).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.serials && input.serials.length > 0 && input.count !== undefined && input.count !== input.serials.length) {
      ctx.addIssue({ code: "custom", path: ["count"], message: "Autant de machines que de numéros de série" });
    }
  });

const reason = optionalText(500);

export const assignmentInput = z.strictObject({
  /** Machine affichée pour la ligne (`null` si aucune) : 409 assignment_changed si elle a changé */
  expectedMachineId: z.uuid({ error: "Machine affichée attendue (null si aucune)" }).nullable(),
  /** Nouvelle machine ; `null` retire la machine (motif obligatoire) */
  machineId: z.uuid().nullable(),
  /** Obligatoire pour un remplacement, un retrait ou une machine dégradée */
  reason: reason.optional(),
  confirmRefunds,
});

export const replacementInput = z.strictObject({
  expectedMachineId: z.uuid({ error: "Machine affichée attendue" }),
  reason: z.string().trim().min(1, { error: "Motif obligatoire" }).max(500, { error: "500 caractères au plus" }),
  confirmRefunds,
});

const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw ? raw.split(",").filter(Boolean) : []))
    .pipe(z.array(item));

export const machineListQuery = z.object({
  batchId: z.uuid().optional(),
  modelId: z.uuid().optional(),
  /** Statuts logistiques, séparés par des virgules */
  logistical: csv(logistical),
  /** États fonctionnels, séparés par des virgules */
  functional: csv(functional),
  /** Recherche dans les numéros de série (machine et alimentation), sans tenir compte de la casse */
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

// ─── Lecture ───

const ISO = (column: Prisma.Sql) => Prisma.sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type MachineRow = {
  id: string;
  model_id: string;
  model_name: string;
  hashboard_qtt: number;
  batch_id: string;
  batch_name: string;
  batch_kind: BatchKind;
  batch_status: BatchStatus;
  origin_batch_id: string | null;
  origin_batch_name: string | null;
  restock_id: string | null;
  serial: string | null;
  psu_serial: string | null;
  logistical_status: MachineLogisticalStatus;
  functional_status: MachineFunctionalStatus;
  note: string | null;
  received_at: Date | null;
  in_hand_since: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  sellable: boolean;
  updated_at: string;
  line_id: string | null;
  order_id: string | null;
  line_position: number | null;
  paid_at: Date | null;
  contact_email: string | null;
  auth_user_id: bigint | null;
};

/** Machines (avec lot, origine, vendabilité machine_sellable et ligne active) qui satisfont `where`. */
function selectMachines(db: Db, where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty) {
  return db.$queryRaw<MachineRow[]>`
    SELECT m."id", m."model_id", mo."name" AS "model_name", mo."hashboard_qtt",
      m."batch_id", b."name" AS "batch_name", b."kind"::text AS "batch_kind", b."status"::text AS "batch_status",
      m."origin_batch_id", ob."name" AS "origin_batch_name", m."restock_id",
      m."serial", m."psu_serial", m."logistical_status"::text AS "logistical_status",
      m."functional_status"::text AS "functional_status", m."note",
      m."received_at", m."in_hand_since", m."shipped_at", m."delivered_at",
      m."carrier", m."tracking_number", m."tracking_url",
      "machine_sellable"(m) AS "sellable", ${ISO(Prisma.sql`m."updated_at"`)} AS "updated_at",
      al."id" AS "line_id", al."order_id", al."position" AS "line_position", al."paid_at", al."contact_email", al."auth_user_id"
    FROM "Machine" m
    JOIN "Model" mo ON mo."id" = m."model_id"
    JOIN "Batch" b ON b."id" = m."batch_id"
    LEFT JOIN "Batch" ob ON ob."id" = m."origin_batch_id"
    LEFT JOIN LATERAL (
      SELECT l."id", l."order_id", l."position", o."paid_at", o."contact_email", u."auth_user_id"
      FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id" JOIN "User" u ON u."id" = o."user_id"
      WHERE l."machine_id" = m."id" AND l."refund_id" IS NULL AND o."status" = 'paid'
    ) al ON true
    WHERE ${where}
    ${tail}`;
}

type HashboardRow = {
  machine_id: string;
  index: number;
  status: "ok" | "degraded" | "dead";
  checked_by_auth_user_id: bigint;
  updated_at: Date;
  /** Saisie depuis la dernière entrée en main (même comparaison que machine_sellable, à la microseconde) */
  current: boolean;
};

async function hashboardsOf(db: Db, ids: string[]) {
  const rows =
    ids.length === 0
      ? []
      : await db.$queryRaw<HashboardRow[]>`
          SELECT h."machine_id", h."index", h."status"::text AS "status", h."checked_by_auth_user_id", h."updated_at",
            coalesce(h."updated_at" >= m."in_hand_since", false) AS "current"
          FROM "HashboardStatus" h JOIN "Machine" m ON m."id" = h."machine_id"
          WHERE h."machine_id" = ANY(${ids}::uuid[])`;
  const byMachine = new Map<string, HashboardRow[]>();
  for (const r of rows) byMachine.set(r.machine_id, [...(byMachine.get(r.machine_id) ?? []), r]);
  return byMachine;
}

function machineDto(r: MachineRow, boards: Awaited<ReturnType<typeof hashboardsOf>>) {
  const inHand = isInHand(r.logistical_status);
  const hasActiveLine = r.line_id !== null;
  const saved = new Map((boards.get(r.id) ?? []).map((h) => [h.index, h]));
  return {
    id: r.id,
    model: { id: r.model_id, name: r.model_name, hashboardQtt: r.hashboard_qtt },
    /** Lot d'appartenance (celui dont la machine alimente le stock) */
    batchId: r.batch_id,
    batch: {
      id: r.batch_id,
      name: r.batch_name,
      kind: r.batch_kind,
      status: r.batch_status,
      statusLabel: batchStatusLabel(r.batch_kind, r.batch_status),
    },
    /** Origine immuable : la palette d'où elle vient, ou le réassort du lot de stock */
    originBatchId: r.origin_batch_id,
    originBatch: r.origin_batch_id ? { id: r.origin_batch_id, name: r.origin_batch_name! } : null,
    restockId: r.restock_id,
    serial: r.serial,
    psuSerial: r.psu_serial,
    logisticalStatus: r.logistical_status,
    logisticalLabel: MACHINE_LOGISTICAL_LABELS[r.logistical_status],
    functionalStatus: r.functional_status,
    functionalLabel: MACHINE_FUNCTIONAL_LABELS[r.functional_status],
    note: r.note,
    receivedAt: r.received_at?.toISOString() ?? null,
    /** Dernière entrée en main (réception, retour, machine retrouvée) : un contrôle compte depuis cette date */
    inHandSince: r.in_hand_since?.toISOString() ?? null,
    shippedAt: r.shipped_at?.toISOString() ?? null,
    deliveredAt: r.delivered_at?.toISOString() ?? null,
    carrier: r.carrier,
    trackingNumber: r.tracking_number,
    trackingUrl: r.tracking_url,
    /**
     * Une entrée par hashboard du modèle ; `status: null` = jamais contrôlée ; `current` : saisie depuis la dernière
     * entrée en main (sinon à ressaisir pour que la machine redevienne vendable depuis le stock)
     */
    hashboards: Array.from({ length: r.hashboard_qtt }, (_, index) => {
      const h = saved.get(index);
      return {
        index,
        status: h?.status ?? null,
        checkedBy: h ? h.checked_by_auth_user_id.toString() : null,
        updatedAt: h ? h.updated_at.toISOString() : null,
        current: h?.current ?? false,
      };
    }),
    /** Ligne de commande active (facture payée) dont c'est la machine */
    line: hasActiveLine
      ? {
          lineId: r.line_id!,
          orderId: r.order_id!,
          position: r.line_position!,
          paidAt: r.paid_at?.toISOString() ?? null,
          customer: { authUserId: r.auth_user_id?.toString() ?? null, contactEmail: r.contact_email },
        }
      : null,
    inHand,
    /** Vendable depuis un lot de stock (machine_sellable : en main, OK, contrôle complet depuis l'entrée en main) */
    sellable: r.sellable,
    /** En main et OK, mais hashboards à ressaisir depuis son retour en main */
    toRecheck: inHand && r.functional_status === "ok" && !r.sellable,
    /** Attribuable à une ligne payée de son lot : palette, en main OK ou dégradée ; lot de stock, vendable */
    assignable:
      !hasActiveLine &&
      inHand &&
      r.batch_status !== "cancelled" &&
      (r.batch_kind === "stock" ? r.sellable : r.functional_status === "ok" || r.functional_status === "degraded"),
    nextChanges: nextMachineChanges({
      logistical: r.logistical_status,
      functional: r.functional_status,
      batchStatus: r.batch_status,
      hasActiveLine,
    }),
    /** À la microseconde : à renvoyer tel quel dans `expectedUpdatedAt` */
    updatedAt: r.updated_at,
  };
}

export type MachineDto = ReturnType<typeof machineDto>;

async function machinesDto(db: Db, rows: MachineRow[]) {
  const boards = await hashboardsOf(db, rows.map((r) => r.id));
  return rows.map((r) => machineDto(r, boards));
}

async function machinesByIds(db: Db, ids: string[]) {
  const rows = await selectMachines(db, Prisma.sql`m."id" = ANY(${ids}::uuid[])`, Prisma.sql`ORDER BY m."created_at", m."id"`);
  return machinesDto(db, rows);
}

/** Liste filtrée et paginée (ordre : lot, puis création). */
export async function listMachines(query: z.output<typeof machineListQuery>) {
  const db = getDb();
  const conditions: Prisma.Sql[] = [Prisma.sql`true`];
  if (query.batchId) conditions.push(Prisma.sql`m."batch_id" = ${query.batchId}::uuid`);
  if (query.modelId) conditions.push(Prisma.sql`m."model_id" = ${query.modelId}::uuid`);
  if (query.logistical.length > 0) {
    conditions.push(Prisma.sql`m."logistical_status"::text = ANY(${query.logistical}::text[])`);
  }
  if (query.functional.length > 0) {
    conditions.push(Prisma.sql`m."functional_status"::text = ANY(${query.functional}::text[])`);
  }
  if (query.q) {
    const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(Prisma.sql`(m."serial" ILIKE ${pattern} OR m."psu_serial" ILIKE ${pattern})`);
  }
  const where = Prisma.join(conditions, " AND ");
  const [rows, [{ total }]] = await Promise.all([
    selectMachines(
      db,
      where,
      Prisma.sql`ORDER BY b."created_at", m."batch_id", m."created_at", m."id"
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
    ),
    db.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS "total" FROM "Machine" m WHERE ${where}`,
  ]);
  return { items: await machinesDto(db, rows), total, page: query.page, pageSize: query.pageSize };
}

/** Fiche d'une machine : la machine, son journal des statuts, ses attributions et ses transferts. */
export async function getMachine(machineId: string, db: Db = getDb()) {
  const [machine] = await machinesByIds(db, [machineId]);
  if (!machine) throw machineNotFound();
  const [changes, assignments, transfers] = await Promise.all([
    db.machineStatusChange.findMany({ where: { machine_id: machineId }, orderBy: [{ created_at: "asc" }, { id: "asc" }] }),
    db.orderLineAssignment.findMany({
      where: { OR: [{ machine_id: machineId }, { order_line: { assignments: { some: { machine_id: machineId } } } }] },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      include: { order_line: { select: { order_id: true, position: true } } },
    }),
    db.machineTransfer.findMany({
      where: { machine_id: machineId },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      include: { from_batch: { select: { id: true, name: true } }, to_batch: { select: { id: true, name: true } } },
    }),
  ]);
  return {
    ...machine,
    /** Journal des statuts, du plus ancien au plus récent */
    statusChanges: changes.map((c) => ({
      id: c.id,
      fromLogistical: c.from_logistical,
      toLogistical: c.to_logistical,
      fromFunctional: c.from_functional,
      toFunctional: c.to_functional,
      note: c.note,
      changedBy: c.changed_by_auth_user_id.toString(),
      createdAt: c.created_at.toISOString(),
    })),
    /**
     * Journal des attributions des lignes où la machine est passée (attribution, remplacement, retrait), du plus
     * ancien au plus récent ; `machineId` : machine donnée à la ligne (null : retirée)
     */
    assignments: assignments.map((a) => ({
      id: a.id,
      lineId: a.order_line_id,
      orderId: a.order_line.order_id,
      position: a.order_line.position,
      machineId: a.machine_id,
      reason: a.reason,
      changedBy: a.changed_by_auth_user_id.toString(),
      createdAt: a.created_at.toISOString(),
    })),
    /** Transferts palette → lot de stock */
    transfers: transfers.map((t) => ({
      id: t.id,
      from: t.from_batch,
      to: t.to_batch,
      reason: t.reason,
      note: t.note,
      changedBy: t.changed_by_auth_user_id.toString(),
      createdAt: t.created_at.toISOString(),
    })),
  };
}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Ligne de la vue batch_machine_summary en camelCase (sans batchId ni batchStatus). */
async function machineSummary(db: Db, batchId: string) {
  const [row] = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "batch_machine_summary" WHERE "batch_id" = ${batchId}::uuid`;
  if (!row) throw batchNotFound();
  return Object.fromEntries(
    Object.entries(row)
      .filter(([k]) => k !== "batch_id" && k !== "batch_status")
      .map(([k, v]) => [camel(k), v]),
  ) as Record<string, number | string | null>;
}

type LineRow = {
  id: string;
  order_id: string;
  position: number;
  paid_at: Date | null;
  contact_email: string | null;
  auth_user_id: bigint | null;
  amount: bigint;
  configuration_id: string;
  machine_id: string | null;
  serial: string | null;
  logistical_status: MachineLogisticalStatus | null;
  functional_status: MachineFunctionalStatus | null;
  surplus_rank: number | null;
};

/** Lignes payées actives d'un lot, premier payé d'abord, avec leur configuration et leur rang de surplus. */
async function activeLines(db: Db, batchId: string) {
  const rows = await db.$queryRaw<LineRow[]>`
    SELECT l."id", l."order_id", l."position", o."paid_at", o."contact_email", u."auth_user_id", l."amount", l."configuration_id",
      l."machine_id", m."serial", m."logistical_status"::text AS "logistical_status",
      m."functional_status"::text AS "functional_status", s."rank" AS "surplus_rank"
    FROM "OrderLine" l
    JOIN "Order" o ON o."id" = l."order_id"
    JOIN "User" u ON u."id" = o."user_id"
    LEFT JOIN "Machine" m ON m."id" = l."machine_id"
    LEFT JOIN "batch_surplus_lines"(${batchId}::uuid) s ON s."line_id" = l."id"
    WHERE l."batch_id" = ${batchId}::uuid AND l."refund_id" IS NULL AND o."status" = 'paid'
    ORDER BY o."paid_at", o."id", l."position"`;
  const items = await db.configurationItem.findMany({
    where: { configuration_id: { in: rows.map((r) => r.configuration_id) } },
    include: { option: { select: { title: true, position: true } }, option_value: { select: { label: true } } },
  });
  return rows.map((r) => ({
    lineId: r.id,
    orderId: r.order_id,
    position: r.position,
    paidAt: r.paid_at?.toISOString() ?? null,
    customer: { authUserId: r.auth_user_id?.toString() ?? null, contactEmail: r.contact_email },
    amount: r.amount.toString(),
    /** Choix de la configuration (menus dans l'ordre du lot) : options à monter */
    configuration: items
      .filter((i) => i.configuration_id === r.configuration_id)
      .sort((a, b) => a.option.position - b.option.position || a.option.title.localeCompare(b.option.title))
      .map((i) => ({ option: i.option.title, value: i.option_value.label })),
    machineId: r.machine_id,
    machineSerial: r.serial,
    /** Machine à remplacer (faulty, lost) ou attribuée dégradée (decision tracée) ; null sinon */
    problem:
      r.functional_status === "faulty"
        ? ("faulty" as const)
        : r.logistical_status === "lost"
          ? ("lost" as const)
          : r.functional_status === "degraded"
            ? ("degraded" as const)
            : null,
    /** Rang dans batch_surplus_lines (ligne payée en trop, la plus récente d'abord) ; null sinon */
    surplusRank: r.surplus_rank,
  }));
}

/** Machines et commandes d'un lot : résumé (vue), machines (ordre de création), lignes payées (premier payé d'abord). */
export async function getBatchMachines(batchId: string, db: Db = getDb()) {
  const summary = await machineSummary(db, batchId);
  const [rows, lines] = await Promise.all([
    selectMachines(db, Prisma.sql`m."batch_id" = ${batchId}::uuid`, Prisma.sql`ORDER BY m."created_at", m."id"`),
    activeLines(db, batchId),
  ]);
  return { summary, machines: await machinesDto(db, rows), lines };
}

type StockRow = {
  model_id: string;
  model_name: string;
  stock_batch_id: string | null;
  stock_batch_name: string | null;
  stock_batch_status: BatchStatus | null;
  expected: number;
  to_check: number;
  sellable: number;
  available: number;
  reserved: number;
  assigned: number;
  degraded: number;
  faulty: number;
  in_palettes: number;
};

/** Stock par modèle (vue model_stock_summary), modèles par nom. */
export async function listModelStock() {
  const rows = await getDb().$queryRaw<StockRow[]>`
    SELECT s."model_id", mo."name" AS "model_name", s."stock_batch_id", b."name" AS "stock_batch_name",
      s."stock_batch_status"::text AS "stock_batch_status", s."expected", s."to_check", s."sellable", s."available",
      s."reserved", s."assigned", s."degraded", s."faulty", s."in_palettes"
    FROM "model_stock_summary" s
    JOIN "Model" mo ON mo."id" = s."model_id"
    LEFT JOIN "Batch" b ON b."id" = s."stock_batch_id"
    ORDER BY mo."name", mo."id"`;
  return {
    items: rows.map((r) => ({
      model: { id: r.model_id, name: r.model_name },
      /** Lot de stock du modèle ; null tant qu'il n'existe pas (créé au premier transfert, clôture ou création) */
      stockBatch:
        r.stock_batch_id === null
          ? null
          : {
              id: r.stock_batch_id,
              name: r.stock_batch_name!,
              status: r.stock_batch_status!,
              statusLabel: batchStatusLabel("stock", r.stock_batch_status!),
            },
      expected: r.expected,
      toCheck: r.to_check,
      sellable: r.sellable,
      available: r.available,
      reserved: r.reserved,
      assigned: r.assigned,
      degraded: r.degraded,
      faulty: r.faulty,
      inPalettes: r.in_palettes,
    })),
  };
}

// ─── Machines en moins : remboursement des lignes payées en trop ───

type Refundable = { lineId: string; orderId: string; batchId: string; paidAt: string | null; contactEmail: string | null; amount: string };
type Shortage = { batchId: string; refunds: Refundable[]; missing: number; pendingOrders: number };

/** Lot qui manque de machines après l'écriture courante (non validée) : lève l'annulation de la transaction. */
class ShortageFound extends Error {
  constructor(readonly shortages: Shortage[]) {
    super("machine shortage");
  }
}

/**
 * Lots où l'écriture en cours laisse plus de lignes payées et réservées que de places (batch_available_stock < 0) :
 * les lignes à rembourser sont les premières de batch_surplus_lines (la plus récente d'abord), autant que de places
 * manquantes. `missing` > 0 : les lignes payées ne suffisent pas, des factures en attente occupent les places.
 */
async function findShortages(tx: Tx, batchIds: readonly string[]): Promise<Shortage[]> {
  const deficits = await tx.$queryRaw<{ batch_id: string; available: number }[]>`
    SELECT b AS "batch_id", "batch_available_stock"(b) AS "available" FROM unnest(${[...batchIds]}::uuid[]) b ORDER BY b`;
  const shortages: Shortage[] = [];
  for (const { batch_id: batchId, available } of deficits) {
    if (available >= 0) continue;
    const deficit = -available;
    const lines = await tx.$queryRaw<
      { line_id: string; order_id: string; paid_at: Date | null; contact_email: string | null; amount: bigint }[]
    >`
      SELECT s."line_id", s."order_id", s."paid_at", o."contact_email", l."amount"
      FROM "batch_surplus_lines"(${batchId}::uuid) s
      JOIN "Order" o ON o."id" = s."order_id"
      JOIN "OrderLine" l ON l."id" = s."line_id"
      ORDER BY s."rank" DESC
      LIMIT ${deficit}`;
    const [{ pending }] = await tx.$queryRaw<{ pending: number }[]>`
      SELECT count(*)::int AS "pending" FROM "Order" o
      WHERE o."batch_id" = ${batchId}::uuid AND o."status" = 'pending_payment' AND "order_holds_stock"(o."status", o."expires_at")`;
    shortages.push({
      batchId,
      refunds: lines.map((l) => ({
        lineId: l.line_id,
        orderId: l.order_id,
        batchId,
        paidAt: l.paid_at?.toISOString() ?? null,
        contactEmail: l.contact_email,
        amount: l.amount.toString(),
      })),
      missing: deficit - lines.length,
      pendingOrders: pending,
    });
  }
  return shortages;
}

function shortageError(shortages: Shortage[]): ApiError {
  const refunds = shortages.flatMap((s) => s.refunds);
  const detailRefunds = refunds as unknown as JsonValue[];
  const missing = shortages.reduce((sum, s) => sum + s.missing, 0);
  if (missing > 0) {
    const pendingOrders = shortages.reduce((sum, s) => sum + s.pendingOrders, 0);
    return new ApiError(
      409,
      "machine_shortage_reserved",
      `Il manquerait ${machinesLabel(missing)} : ${plural(pendingOrders, "facture en attente de paiement occupe", "factures en attente de paiement occupent")} les dernières places du lot. Attendez la fin de leur réservation (30 minutes au plus), puis recommencez.`,
      undefined,
      { details: { pendingOrders, refunds: detailRefunds } },
    );
  }
  const who =
    refunds.length === 1
      ? "la commande payée la plus récente sera remboursée pour une machine"
      : `les ${refunds.length} machines payées les plus récentes seront remboursées`;
  return new ApiError(
    409,
    "machine_shortage",
    `Il n'y a plus assez de machines pour toutes les commandes payées du lot : ${who} (frais à la charge de la boutique). Confirmez pour continuer.`,
    undefined,
    { details: { refunds: detailRefunds } },
  );
}

const REFUND_REASONS: Partial<Record<RefundCause, string>> = {
  shop_defective_machine: "Machine défectueuse : la boutique rembourse cette machine (frais à sa charge).",
  shop_stock: "Machine indisponible (manquante ou perdue) : la boutique rembourse cette machine (frais à sa charge).",
};

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;

/**
 * Exécute `write` (qui renvoie les lots touchés) dans une transaction et vérifie avant le COMMIT qu'aucun lot ne
 * manque de machines. Manque sans confirmation : `409 machine_shortage` (rien n'est écrit). Confirmation exacte
 * (`confirm` = lignes annoncées) : nouvelle transaction qui verrouille d'abord les factures, annule ces lignes
 * (cancelOrderLines, motif `cause`, frais boutique), puis rejoue `write` (`refunded` : lignes remboursées, pour ne
 * rien attribuer à l'une d'elles). Renvoie les lignes remboursées.
 */
async function withSurplusRefunds(
  options: { confirm: readonly string[] | undefined; cause: RefundCause; actor: Actor },
  write: (tx: Tx, refunded: ReadonlySet<string>) => Promise<string[]>,
): Promise<Refundable[]> {
  let plan: Refundable[] = [];
  const fee = await getPaymentService().estimateRefundNetworkFeeSats();
  for (;;) {
    try {
      await getDb().$transaction(async (tx) => {
        if (plan.length > 0) await refundLines(tx, plan, options.cause, options.actor, fee);
        const batchIds = await write(tx, new Set(plan.map((p) => p.lineId)));
        const shortages = await findShortages(tx, batchIds);
        if (shortages.length > 0) throw new ShortageFound(shortages);
      }, BULK);
      return plan;
    } catch (error) {
      if (!(error instanceof ShortageFound)) throw error;
      if (plan.length > 0) {
        // Le lot a changé entre la lecture du plan et son exécution (autre paiement, autre machine) : à refaire
        throw new ApiError(409, "retry", "Le lot a changé pendant l'opération : rechargez la page et recommencez.");
      }
      const next = error.shortages.flatMap((s) => s.refunds);
      const complete = error.shortages.every((s) => s.missing === 0);
      if (!complete || !options.confirm || !sameIds(options.confirm, next.map((r) => r.lineId))) {
        throw shortageError(error.shortages);
      }
      plan = next;
    }
  }
}

/** Annule les lignes du plan, facture par facture (factures verrouillées d'abord, par id). */
async function refundLines(tx: Tx, plan: readonly Refundable[], cause: RefundCause, actor: Actor, fee: bigint) {
  const byOrder = new Map<string, string[]>();
  for (const p of plan) byOrder.set(p.orderId, [...(byOrder.get(p.orderId) ?? []), p.lineId]);
  const orderIds = [...byOrder.keys()].sort();
  await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ANY(${orderIds}::uuid[]) ORDER BY "id" FOR NO KEY UPDATE`;
  for (const orderId of orderIds) {
    await cancelOrderLines(tx, orderId, byOrder.get(orderId), {
      cause,
      networkFeeSats: fee,
      initiatedBy: "admin",
      createdBy: authUserIdToDb(actor.authUserId),
      reason: REFUND_REASONS[cause]!,
    });
  }
}

// ─── Écritures : statuts, contrôle, hashboards ───

type LockedMachine = {
  id: string;
  batch_id: string;
  model_id: string;
  hashboard_qtt: number;
  logistical_status: MachineLogisticalStatus;
  functional_status: MachineFunctionalStatus;
};

/** Verrouille des machines par id (ordre des verrous) ; 404 si l'une n'existe pas. */
async function lockMachines(tx: Tx, ids: readonly string[]): Promise<Map<string, LockedMachine>> {
  const sorted = [...ids].sort();
  const rows = await tx.$queryRaw<LockedMachine[]>`
    SELECT m."id", m."batch_id", m."model_id", mo."hashboard_qtt",
      m."logistical_status"::text AS "logistical_status", m."functional_status"::text AS "functional_status"
    FROM "Machine" m JOIN "Model" mo ON mo."id" = m."model_id"
    WHERE m."id" = ANY(${sorted}::uuid[]) ORDER BY m."id" FOR NO KEY UPDATE OF m`;
  if (rows.length !== sorted.length) throw machineNotFound();
  return new Map(rows.map((r) => [r.id, r]));
}

async function writeHashboards(tx: Tx, machineId: string, entries: { index: number; status: "ok" | "degraded" | "dead" }[], actor: Actor) {
  const by = authUserIdToDb(actor.authUserId);
  for (const { index, status } of entries) {
    await tx.hashboardStatus.upsert({
      where: { machine_id_index: { machine_id: machineId, index } },
      create: { machine_id: machineId, index, status, checked_by_auth_user_id: by },
      update: { status, checked_by_auth_user_id: by },
    });
  }
}

const allOk = (qtt: number) => Array.from({ length: qtt }, (_, index) => ({ index, status: "ok" as const }));

type StatusItem = z.output<typeof statusChangesInput>["items"][number];

/** Une ligne au journal des statuts, puis les hashboards (machine désormais en main) et le suivi. */
async function writeStatusChange(tx: Tx, m: LockedMachine, item: StatusItem, actor: Actor) {
  const toFunctional = item.to.functional ?? item.from.functional;
  await tx.machineStatusChange.create({
    data: {
      machine_id: m.id,
      from_logistical: item.from.logistical,
      to_logistical: item.to.logistical ?? item.from.logistical,
      from_functional: item.from.functional,
      to_functional: toFunctional,
      note: item.note ?? null,
      changed_by_auth_user_id: authUserIdToDb(actor.authUserId),
    },
  });
  // OK = toutes les hashboards OK (Machine_hashboards) : celles qui ne sont pas données le sont d'office
  let boards = item.hashboards ?? [];
  if (toFunctional === "ok" && item.from.functional !== "ok") {
    const given = new Set(boards.map((h) => h.index));
    boards = [...boards, ...allOk(m.hashboard_qtt).filter((h) => !given.has(h.index))];
  }
  await writeHashboards(tx, m.id, boards, actor);
  if (item.tracking) {
    await tx.machine.update({
      where: { id: m.id },
      data: {
        carrier: item.tracking.carrier,
        tracking_number: item.tracking.trackingNumber,
        tracking_url: item.tracking.trackingUrl,
      },
    });
  }
}

/** Motif du remboursement d'une ligne en trop : machine défectueuse ou dégradée, sinon machine manquante. */
const causeOf = (functionalStatus: MachineFunctionalStatus | null | undefined): RefundCause =>
  functionalStatus === "faulty" || functionalStatus === "degraded" ? "shop_defective_machine" : "shop_stock";

/**
 * Changements de statut de machines (réception, contrôle, montage, préparation, expédition, livraison, perte, retour,
 * rebut), tout ou rien. Une machine qui devient inutilisable sur un lot plein fait rembourser la commande payée la
 * plus récente (voir withSurplusRefunds). Renvoie les machines à jour et les lignes remboursées.
 */
export async function changeMachineStatuses(input: z.output<typeof statusChangesInput>, actor: Actor) {
  const ids = input.items.map((i) => i.machineId);
  // Machine qui meurt ou se dégrade : défectueuse ; manquante ou perdue : souci de stock
  const cause = causeOf(input.items.find((i) => i.to.functional === "faulty" || i.to.functional === "degraded")?.to.functional);
  const refunds = await withSurplusRefunds({ confirm: input.confirmRefunds, cause, actor }, async (tx) => {
    const locked = await lockMachines(tx, ids);
    for (const item of input.items) await writeStatusChange(tx, locked.get(item.machineId)!, item, actor);
    return [...new Set([...locked.values()].map((m) => m.batch_id))];
  });
  return { machines: await machinesByIds(getDb(), ids), refunds };
}

/** Correction de hashboards sans changer l'état fonctionnel (seules les entrées envoyées sont écrites). */
export async function setHashboards(machineId: string, input: z.output<typeof hashboardsInput>, actor: Actor) {
  await getDb().$transaction(async (tx) => {
    await lockMachines(tx, [machineId]);
    await writeHashboards(tx, machineId, input.hashboards, actor);
  });
  return getMachine(machineId);
}

/**
 * « Tout OK » : pour chaque machine (en main), hashboards toutes OK et état fonctionnel OK. Sert aussi au recontrôle
 * d'une machine retournée ou retrouvée (déjà OK : hashboards ressaisies, elle redevient vendable). Corriger une
 * machine dégradée ou défectueuse exige `note`. Ne fait qu'ajouter des machines utilisables.
 */
export async function checkMachinesOk(input: z.output<typeof checkOkInput>, actor: Actor) {
  await getDb().$transaction(async (tx) => {
    const locked = await lockMachines(tx, input.machineIds);
    for (const m of [...locked.values()]) {
      await writeHashboards(tx, m.id, allOk(m.hashboard_qtt), actor);
      if (m.functional_status !== "ok") {
        await tx.machineStatusChange.create({
          data: {
            machine_id: m.id,
            from_logistical: m.logistical_status,
            to_logistical: m.logistical_status,
            from_functional: m.functional_status,
            to_functional: "ok",
            note: input.note ?? null,
            changed_by_auth_user_id: authUserIdToDb(actor.authUserId),
          },
        });
      }
    }
  }, BULK);
  return { machines: await machinesByIds(getDb(), input.machineIds) };
}

/**
 * Saisie directe : numéros de série, note, suivi. `expectedUpdatedAt` comparé sous verrou à la microseconde
 * (`409 machine_modified`).
 */
export async function updateMachine(machineId: string, patch: z.output<typeof machinePatch>) {
  await getDb().$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ unchanged: boolean }[]>`
      SELECT "updated_at" = ${patch.expectedUpdatedAt}::timestamptz AS "unchanged"
      FROM "Machine" WHERE "id" = ${machineId}::uuid FOR NO KEY UPDATE`;
    if (!row) throw machineNotFound();
    if (!row.unchanged) {
      throw new ApiError(
        409,
        "machine_modified",
        "La machine a été modifiée entre-temps (autre onglet ou autre administrateur) : rechargez la page, vos modifications n'ont pas été enregistrées.",
      );
    }
    await tx.machine.update({
      where: { id: machineId },
      data: {
        serial: patch.serial,
        psu_serial: patch.psuSerial,
        note: patch.note,
        carrier: patch.carrier,
        tracking_number: patch.trackingNumber,
        tracking_url: patch.trackingUrl,
      },
    });
  });
  return getMachine(machineId);
}

// ─── Réception ───

/** Refuse les numéros déjà portés par une autre machine du modèle, en les nommant (`409 serial_taken`). */
async function assertSerialsFree(tx: Tx, modelId: string, serials: readonly string[]) {
  if (serials.length === 0) return;
  const taken = await tx.machine.findMany({ where: { model_id: modelId, serial: { in: [...serials] } }, select: { serial: true } });
  if (taken.length > 0) {
    const list = taken.map((t) => `« ${t.serial} »`).join(", ");
    throw new ApiError(
      409,
      "serial_taken",
      `${taken.length > 1 ? "Ces numéros de série sont déjà enregistrés" : "Ce numéro de série est déjà enregistré"} sur une autre machine de ce modèle : ${list}.`,
      undefined,
      { details: { serials: taken.map((t) => t.serial!) } },
    );
  }
}

/** Marque reçues des machines attendues (journal) et leur donne leurs numéros de série, dans l'ordre. */
async function receive(tx: Tx, ids: readonly string[], serials: readonly string[], actor: Actor) {
  const by = authUserIdToDb(actor.authUserId);
  await tx.machineStatusChange.createMany({
    data: ids.map((id) => ({
      machine_id: id,
      from_logistical: "expected" as const,
      to_logistical: "in_stock" as const,
      from_functional: "unknown" as const,
      to_functional: "unknown" as const,
      changed_by_auth_user_id: by,
    })),
  });
  for (const [i, s] of serials.entries()) await tx.machine.update({ where: { id: ids[i] }, data: { serial: s } });
}

/**
 * Réception en bloc des machines attendues d'un lot (palette ou lot de stock), à tout statut du lot sauf annulé.
 * Plus de numéros que de machines attendues : `409 reception_exceeds_expected` (une machine en plus d'une palette
 * s'enregistre par « Machine en plus »). Renvoie les machines du lot.
 */
export async function receiveMachines(batchId: string, input: z.output<typeof receptionInput>, actor: Actor) {
  const serials = input.serials ?? [];
  await getDb().$transaction(async (tx) => {
    const batch = await tx.batch.findUnique({ where: { id: batchId }, select: { model_id: true } });
    if (!batch) throw batchNotFound();
    let ids: string[];
    if (input.machineIds) {
      const locked = await lockMachines(tx, input.machineIds);
      if ([...locked.values()].some((m) => m.batch_id !== batchId || m.logistical_status !== "expected")) {
        throw new ApiError(
          409,
          "machine_not_expected",
          "Une des machines choisies n'est plus attendue dans ce lot (déjà reçue, manquante ou transférée) : rechargez la page.",
        );
      }
      ids = input.machineIds;
    } else {
      // Verrous par id (ordre commun à toutes les écritures sur des machines), puis les plus anciennes d'abord
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Machine" WHERE "batch_id" = ${batchId}::uuid AND "logistical_status" = 'expected'
        ORDER BY "id" FOR NO KEY UPDATE`;
      const expected = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Machine" WHERE "id" = ANY(${locked.map((m) => m.id)}::uuid[]) ORDER BY "created_at", "id"`;
      const wanted = serials.length > 0 ? serials.length : (input.count ?? expected.length);
      if (wanted > expected.length) {
        throw new ApiError(
          409,
          "reception_exceeds_expected",
          `Ce lot n'attend plus que ${machinesLabel(expected.length)} : enregistrez les autres comme machines en plus (palette pleine) ou vérifiez la liste.`,
          undefined,
          { details: { expected: expected.length } },
        );
      }
      if (wanted === 0) {
        throw new ApiError(409, "reception_exceeds_expected", "Ce lot n'attend plus aucune machine.", undefined, { details: { expected: 0 } });
      }
      ids = expected.slice(0, wanted).map((m) => m.id);
    }
    await assertSerialsFree(tx, batch.model_id, serials);
    await receive(tx, ids, serials, actor);
  }, BULK);
  return getBatchMachines(batchId);
}

/**
 * Machines reçues en plus d'une palette : créées au lot de stock du modèle (créé en pause s'il n'existe pas,
 * stock_batch_of), origine la palette, et reçues aussitôt (à contrôler). Seulement une fois la palette pleine
 * (machines générées : Machine_origin) et sans machine encore attendue (`409 palette_has_expected`).
 */
export async function receiveExtraMachines(paletteId: string, input: z.output<typeof extraMachinesInput>, actor: Actor) {
  const serials = input.serials ?? [];
  const count = serials.length > 0 ? serials.length : (input.count ?? 1);
  const created = await getDb().$transaction(async (tx) => {
    const [palette] = await tx.$queryRaw<{ kind: BatchKind; model_id: string; name: string; expected: number }[]>`
      SELECT b."kind"::text AS "kind", b."model_id", b."name",
        (SELECT count(*)::int FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'expected') AS "expected"
      FROM "Batch" b WHERE b."id" = ${paletteId}::uuid`;
    if (!palette) throw batchNotFound();
    if (palette.kind !== "wholesale") {
      throw new ApiError(409, "not_palette", "Seule une palette reçoit des machines en plus : un lot de stock se réassortit.");
    }
    if (palette.expected > 0) {
      throw new ApiError(
        409,
        "palette_has_expected",
        `Cette palette attend encore ${machinesLabel(palette.expected)} : recevez-les (ou marquez-les manquantes) avant d'enregistrer une machine en plus.`,
        undefined,
        { details: { expected: palette.expected } },
      );
    }
    await assertSerialsFree(tx, palette.model_id, serials);
    const [{ id: stockId }] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "stock_batch_of"(${palette.model_id}::uuid, ${authUserIdToDb(actor.authUserId)},
        ${`Créé par une machine reçue en plus du lot ${palette.name}`}) AS "id"`;
    const machines = await tx.machine.createManyAndReturn({
      data: Array.from({ length: count }, () => ({
        model_id: palette.model_id,
        batch_id: stockId,
        origin_batch_id: paletteId,
        note: input.note ?? null,
      })),
      select: { id: true },
    });
    const ids = machines.map((m) => m.id);
    await receive(tx, ids, serials, actor);
    return { stockId, ids };
  }, BULK);
  return { stockBatchId: created.stockId, machines: await machinesByIds(getDb(), created.ids) };
}

// ─── Attribution ───

type LockedLine = { id: string; batch_id: string; machine_id: string | null; functional_status: MachineFunctionalStatus | null };

/** Verrouille une ligne (ordre : après les factures, avant les machines) et vérifie la machine affichée. */
async function lockLine(tx: Tx, lineId: string, expectedMachineId: string | null): Promise<LockedLine> {
  const [line] = await tx.$queryRaw<LockedLine[]>`
    SELECT l."id", l."batch_id", l."machine_id", m."functional_status"::text AS "functional_status"
    FROM "OrderLine" l LEFT JOIN "Machine" m ON m."id" = l."machine_id"
    WHERE l."id" = ${lineId}::uuid FOR NO KEY UPDATE OF l`;
  if (!line) throw lineNotFound();
  if (line.machine_id !== expectedMachineId) {
    throw new ApiError(409, "assignment_changed", "La machine de cette ligne a changé entre-temps : rechargez la page.");
  }
  return line;
}

const assign = (tx: Tx, line: LockedLine, machineId: string | null, reason: string | null, actor: Actor) =>
  tx.orderLineAssignment.create({
    data: {
      order_line_id: line.id,
      batch_id: line.batch_id,
      machine_id: machineId,
      reason,
      changed_by_auth_user_id: authUserIdToDb(actor.authUserId),
    },
  });

/**
 * Machines libres attribuables d'un lot, dans l'ordre de préférence (prêtes d'abord, puis reçues en premier) : en
 * main et OK, d'aucune ligne non remboursée ; lot de stock : vendables (machine_sellable). Les machines dégradées ne
 * sont jamais choisies d'office (décision du technicien, avec motif).
 */
export async function freeMachines(tx: Tx, batchId: string, limit: number, exclude: readonly string[] = []) {
  if (limit <= 0) return [];
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT m."id" FROM "Machine" m JOIN "Batch" b ON b."id" = m."batch_id"
    WHERE m."batch_id" = ${batchId}::uuid AND m."id" <> ALL(${[...exclude]}::uuid[])
      AND "machine_in_hand"(m."logistical_status") AND m."functional_status" = 'ok'
      AND (b."kind" = 'wholesale' OR "machine_sellable"(m))
      AND NOT EXISTS (SELECT 1 FROM "OrderLine" l WHERE l."machine_id" = m."id" AND l."refund_id" IS NULL)
    ORDER BY (m."logistical_status" = 'ready') DESC, m."received_at", m."id"
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

/** Lot d'une ligne (404 si elle n'existe pas). */
async function batchOfLine(lineId: string) {
  const line = await getDb().orderLine.findUnique({ where: { id: lineId }, select: { batch_id: true } });
  if (!line) throw lineNotFound();
  return line.batch_id;
}

/**
 * Attribuer, remplacer ou retirer la machine d'une ligne payée (règles de la base : OrderLineAssignment_apply).
 * Un remplacement qui prend la dernière machine vendable d'un lot de stock plein fait rembourser la commande payée
 * la plus récente (withSurplusRefunds). Renvoie les machines et commandes du lot, et les lignes remboursées.
 */
export async function assignLine(lineId: string, input: z.output<typeof assignmentInput>, actor: Actor) {
  const batchId = await batchOfLine(lineId);
  const current = await getDb().orderLine.findUnique({
    where: { id: lineId },
    select: { machine: { select: { functional_status: true } } },
  });
  const refunds = await withSurplusRefunds(
    { confirm: input.confirmRefunds, cause: causeOf(current?.machine?.functional_status), actor },
    async (tx, refunded) => {
      const line = await lockLine(tx, lineId, input.expectedMachineId);
      if (!refunded.has(lineId)) await assign(tx, line, input.machineId, input.reason ?? null, actor);
      return [line.batch_id];
    },
  );
  return { ...(await getBatchMachines(batchId)), refunds };
}

/**
 * Remplacer en un clic la machine d'une ligne (morte, perdue, ou autre) : la meilleure machine libre OK du lot. S'il
 * n'y en a pas, la machine est retirée de la ligne ; si le lot manque alors de machines, la commande payée la plus
 * récente est remboursée (`409 machine_shortage`, puis confirmation) et sa machine, si elle est en main et OK, est
 * donnée à cette ligne ; si la ligne remboursée est celle-ci, elle est simplement remboursée.
 */
export async function replaceLineMachine(lineId: string, input: z.output<typeof replacementInput>, actor: Actor) {
  const batchId = await batchOfLine(lineId);
  const current = await getDb().machine.findUnique({ where: { id: input.expectedMachineId }, select: { functional_status: true } });
  const refunds = await withSurplusRefunds(
    { confirm: input.confirmRefunds, cause: causeOf(current?.functional_status), actor },
    async (tx, refunded) => {
      const line = await lockLine(tx, lineId, input.expectedMachineId);
      if (refunded.has(lineId)) return [line.batch_id];
      const [replacement] = await freeMachines(tx, line.batch_id, 1, [input.expectedMachineId]);
      await assign(tx, line, replacement ?? null, input.reason, actor);
      return [line.batch_id];
    },
  );
  return { ...(await getBatchMachines(batchId)), refunds };
}

const ASSIGNABLE_PALETTE: ReadonlySet<BatchStatus> = new Set(["inspection", "tuning", "packaging", "in_transit"]);

/**
 * Attribution automatique : chaque ligne payée sans machine reçoit une machine libre OK du lot, premier payé d'abord
 * (ordre de batch_surplus_lines, inverse), machines prêtes d'abord. Lignes verrouillées d'abord : deux attributions
 * simultanées se suivent sans attribuer deux fois. Renvoie les machines et commandes du lot et le nombre d'attributions.
 */
export async function autoAssign(batchId: string, actor: Actor) {
  const assigned = await getDb().$transaction(async (tx) => {
    const batch = await tx.batch.findUnique({ where: { id: batchId }, select: { kind: true, status: true } });
    if (!batch) throw batchNotFound();
    if (batch.kind === "wholesale" && !ASSIGNABLE_PALETTE.has(batch.status)) {
      throw new ApiError(
        409,
        "assignment_batch_status",
        `Les machines d'une palette s'attribuent du Contrôle à En transit (statut actuel : « ${batchStatusLabel(batch.kind, batch.status)} »).`,
      );
    }
    const lines = await tx.$queryRaw<{ id: string }[]>`
      SELECT l."id" FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
      WHERE l."batch_id" = ${batchId}::uuid AND l."refund_id" IS NULL AND o."status" = 'paid' AND l."machine_id" IS NULL
      ORDER BY o."paid_at", o."id", l."position"
      FOR NO KEY UPDATE OF l`;
    const machineIds = await freeMachines(tx, batchId, lines.length);
    for (const [i, machineId] of machineIds.entries()) {
      await assign(tx, { id: lines[i].id, batch_id: batchId, machine_id: null, functional_status: null }, machineId, null, actor);
    }
    return machineIds.length;
  }, BULK);
  return { ...(await getBatchMachines(batchId)), assigned };
}
