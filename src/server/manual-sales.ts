import { z } from "zod";
import { OffchainMeans, type Prisma } from "../../prisma/generated/client";
import { authUserIdToDb } from "./auth";
import { type Actor, batchNotFound } from "./batches";
import { writeConfiguration } from "./configurations";
import { getDb } from "./db";
import { ApiError } from "./errors";
import { optionalText } from "./http";
import { getAdminOrder } from "./backoffice-orders";
import { freeMachines } from "./machines";
import { checkManualSale, resolveContactEmail } from "./order-rules";
import { addressInput, choices, loadOrderingContext, resolveAddress, rethrowCreationFailure } from "./orders";
import { optionalContactEmail } from "./profile";

/**
 * Vente manuelle (backoffice, refonte R5, décisions Hugo 2026-11-11) : l'admin vend au comptoir, par téléphone… une
 * facture du canal `manual`, née payée hors chaîne (espèces, virement, autre), au prix du lot. Le client a déjà un compte
 * (créé par lui-même, jamais par l'admin) : l'admin le retrouve par e-mail parmi les comptes existants.
 *
 * SQL-first : la fonction create_manual_sale écrit la facture, ses lignes, l'encaissement de tout le total, le passage à
 * payée et l'attribution des machines dans la transaction ; les triggers de la boutique s'appliquent tels quels (lot
 * ouvert, priorité, facture vivante, délai, blocage, plafond, stock au COMMIT). Le domaine vérifie les mêmes règles
 * avant d'écrire pour un message clair (checkManualSale), écrit les configurations (writeConfiguration : prix relus en
 * base, jamais envoyés) et choisit les machines d'un lot de stock quand l'admin n'en donne pas (freeMachines). Ordre des
 * verrous identique à la boutique : utilisateur, (lot partagé : configurations), facture, lignes, machines, lot.
 */

type Tx = Prisma.TransactionClient;

/** Motif tracé d'une vente manuelle quand l'admin n'en saisit pas (Order.manual_reason, non vide). */
export const DEFAULT_MANUAL_REASON = "Vente au comptoir";

export const customerNotFound = () => new ApiError(422, "unknown_user", "Client introuvable.");

// ─── Entrées ───

export const customerSearchQuery = z.object({
  email: z.string().trim().min(3, { error: "Au moins 3 caractères" }).max(254, { error: "254 caractères au plus" }),
});

export const manualSaleInput = z
  .strictObject({
    /** Client (compte existant, retrouvé par e-mail) */
    userId: z.uuid(),
    batchId: z.uuid(),
    /** Une entrée par machine ; un menu non choisi reçoit sa valeur par défaut. Prix : ceux du lot, relus en base */
    lines: z
      .array(z.strictObject({ choices: choices.optional() }))
      .min(1, { error: "Au moins une machine attendue" })
      .max(1000),
    /**
     * Machine attribuée à chaque ligne, au même rang (`null` : aucune). Sur un lot de stock, une ligne sans machine
     * (liste absente ou `null`) reçoit d'office une machine vendable libre (prêtes d'abord, puis les plus anciennes),
     * hors celles choisies ; sur une palette, aucune (attribution au Contrôle, comme en ligne).
     */
    machineIds: z.array(z.uuid().nullable()).max(1000).optional(),
    billingAddress: addressInput,
    /** Absente : même adresse que la facturation */
    shippingAddress: addressInput.optional(),
    /** E-mail de la facture ; absent : celui du profil du client (il n'est pas modifié) */
    contactEmail: optionalContactEmail,
    /** Moyen de l'encaissement : espèces, virement, autre */
    means: z.enum(OffchainMeans, { error: "Moyen attendu : cash, bank_transfer ou other" }),
    /** Référence libre (n° de virement, reçu…), obligatoire pour « autre » */
    reference: optionalText(200).optional(),
    /** Motif tracé de la vente ; absent : « Vente au comptoir » */
    reason: optionalText(500).optional(),
  })
  .refine((input) => input.means !== "other" || !!input.reference, {
    error: "Référence obligatoire pour le moyen « autre » (chèque n° …)",
    path: ["reference"],
  })
  .refine((input) => input.machineIds === undefined || input.machineIds.length === input.lines.length, {
    error: "Une machine (ou null) par ligne, au même rang",
    path: ["machineIds"],
  })
  .refine(
    (input) => {
      const ids = (input.machineIds ?? []).filter((id) => id !== null);
      return new Set(ids).size === ids.length;
    },
    { error: "Une machine est attribuée deux fois", path: ["machineIds"] },
  );

// ─── Clients ───

const customerSelect = {
  id: true,
  auth_user_id: true,
  email: true,
  created_at: true,
  addresses: { where: { archived_at: null }, orderBy: [{ created_at: "desc" }, { id: "asc" }] },
} satisfies Prisma.UserSelect;

type CustomerRow = Prisma.UserGetPayload<{ select: typeof customerSelect }>;

function customerDto(u: CustomerRow) {
  return {
    id: u.id,
    /** Identifiant auth-service */
    authUserId: u.auth_user_id.toString(),
    email: u.email,
    createdAt: u.created_at.toISOString(),
    /** Adresses enregistrées (non archivées), de la plus récente à la plus ancienne : `{ addressId }` dans une vente */
    addresses: u.addresses.map((a) => ({
      id: a.id,
      fullName: a.full_name,
      company: a.company,
      line1: a.line1,
      line2: a.line2,
      postalCode: a.postal_code,
      city: a.city,
      country: a.country,
      phone: a.phone,
    })),
  };
}

/** Identifiants des clients dont l'e-mail du profil contient `text` (casse ignorée), e-mail identique d'abord. */
async function customerIdsByEmail(db: Tx | ReturnType<typeof getDb>, text: string, limit: number) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "User"
    WHERE strpos(lower("email"), lower(${text})) > 0
    ORDER BY (lower("email") = lower(${text})) DESC, "created_at" DESC, "id"
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

async function customersByIds(db: Tx | ReturnType<typeof getDb>, ids: string[]) {
  const rows = await db.user.findMany({ where: { id: { in: ids } }, select: customerSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => customerDto(byId.get(id)!));
}

/**
 * Recherche d'un client par e-mail du profil (au moins 3 caractères, casse ignorée), parmi les comptes existants :
 * e-mail identique d'abord, puis plus récents d'abord ; 20 au plus.
 */
export async function searchCustomers(query: z.output<typeof customerSearchQuery>) {
  const db = getDb();
  return { items: await customersByIds(db, await customerIdsByEmail(db, query.email, 20)) };
}

// ─── Vente ───

/**
 * Vente manuelle, une transaction : contrôles de la boutique formulés pour l'admin (lot ouvert, priorité, facture
 * vivante, blocage : `409 order_creation_blocked` avec `details.userId` et `batchId` pour lever le blocage, délai,
 * plafond, stock), e-mail de contact (fourni, sinon celui du profil), adresses, une configuration par ligne (prix du
 * lot), machines (données, ou choisies d'office sur un lot de stock), puis create_manual_sale. Renvoie la facture.
 */
export async function createManualSale(input: z.output<typeof manualSaleInput>, actor: Actor) {
  const { userId, batchId } = input;
  const requested = input.lines.length;
  let orderId: string;
  try {
    orderId = await getDb().$transaction(async (tx) => {
      // Verrou de l'utilisateur d'abord, comme une commande en ligne (Order_guard)
      const [user] = await tx.$queryRaw<{ email: string | null }[]>`
        SELECT "email" FROM "User" WHERE "id" = ${userId}::uuid FOR NO KEY UPDATE`;
      if (!user) throw customerNotFound();
      const ctx = await loadOrderingContext(tx, batchId, userId);
      if (!ctx) throw batchNotFound();
      const refused = checkManualSale(ctx, requested, { userId, batchId });
      if (refused) throw refused;
      const contact = resolveContactEmail(input.contactEmail, user.email);
      if (contact instanceof ApiError) throw contact;

      const billingId = await resolveAddress(tx, userId, input.billingAddress);
      const shippingId = input.shippingAddress ? await resolveAddress(tx, userId, input.shippingAddress) : billingId;
      const configurations: string[] = [];
      for (const line of input.lines) configurations.push((await writeConfiguration(tx, batchId, line.choices ?? [])).id);
      const machines = await resolveMachines(tx, ctx.batchKind, batchId, input.machineIds, requested);

      const [{ id }] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "create_manual_sale"(${userId}::uuid, ${batchId}::uuid, ${billingId}::uuid, ${shippingId}::uuid,
          ${contact.email}::text, ${configurations}::uuid[], ${input.means}::"offchain_means", ${input.reference ?? null}::text,
          ${input.reason ?? DEFAULT_MANUAL_REASON}::text, ${authUserIdToDb(actor.authUserId)}::bigint, ${machines}::uuid[]) AS "id"`;
      return id;
    });
  } catch (error) {
    return rethrowCreationFailure(error, batchId, userId, (ctx) => checkManualSale(ctx, requested, { userId, batchId }));
  }
  return getAdminOrder(orderId);
}

/**
 * Machine de chaque ligne. Lot de stock : les lignes sans machine (aucune liste, ou `null` dans une liste mixte)
 * reçoivent d'office une machine vendable libre, hors celles que l'admin a choisies (freeMachines : prêtes d'abord,
 * puis reçues en premier). Le stock contrôlé avant (checkManualSale) en laisse assez ; s'il en manque malgré tout, les
 * dernières lignes restent sans machine et le stock est tranché au COMMIT (Batch_stock). Palette : la liste telle
 * quelle (une ligne `null` reste sans machine jusqu'au Contrôle, comme en ligne).
 */
async function resolveMachines(
  tx: Tx,
  kind: string,
  batchId: string,
  given: (string | null)[] | undefined,
  lines: number,
): Promise<(string | null)[] | null> {
  if (kind !== "stock") return given ?? null;
  const chosen = (given ?? []).filter((id): id is string => id !== null);
  const missing = (given ?? Array.from({ length: lines }, () => null)).filter((id) => id === null).length;
  const found = await freeMachines(tx, batchId, missing, chosen);
  let next = 0;
  return Array.from({ length: lines }, (_, i) => given?.[i] ?? found[next++] ?? null);
}
