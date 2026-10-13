// Seed de dev/test. Idempotent (identifiants fixes, chaque bloc ignoré s'il existe déjà).
// Montants en centimes d'euro (devise unique).
// - Modèle S19 : menus « Kit de ventilation » (specs.md, exemple 1) et « Nettoyage » (Avec/Sans,
//   « Sans » toujours défaut). Les valeurs par défaut sont gratuites (garanti en base).
// - Produits d'options (Part) : « Silent kit » et « Kit Air Flow », stock commun à tous les lots
//   (journal PartStockMovement) : 3 Silent kits reçus, 1 retiré à l'inventaire (abîmé).
// - Lot A « 10 S19 » en brouillon.
// - Lot B « 4 S19 » en précommande depuis 2 jours (draft → survey → preorder, journée de priorité
//   passée), Air Flow retiré, Silent kit limité à 2, menu « Nettoyage » masqué (le défaut « Sans »
//   s'applique d'office, aucun item de configuration). La publication a pris l'instantané des menus
//   et valeurs (BatchOption, BatchOptionValue).
//   Alice : 1 wishlist convertie + commande payée de 2 lignes, en deux paiements (le second est
//   l'appoint). Bob : facture en attente avec un paiement partiel (appoint attendu), qui réserve une
//   place pendant 30 minutes après le seed (puis la libère, sans job ; elle attend alors la décision de
//   Bob : appoint ou remboursement). Alice : facture expirée partiellement payée dont elle a choisi le
//   remboursement (frais réseau à sa charge) ; facture annulée puis payée quand même (« à traiter »
//   par l'admin, order_payment_balance.needs_admin_decision). Ces deux factures sont des abandons
//   (order_abandoned_at) : Alice est dans le délai après abandon (Order_abandoned_cooldown) pendant 5 min.
//   Bob peut aussi demander le remboursement de son paiement partiel avant l'expiration (frais à sa
//   charge, order_payment_balance.user_refund_allowed). Carol : 3 factures expirées sans paiement dans
//   les 6 dernières heures : bloquée sur ce lot jusqu'à une levée de l'admin (Order_abandoned_limit,
//   vue order_creation_blocks). Commande de 1 Silent kit pour ce lot, en attente de livraison
//   (BatchPartOrder).
//   v5e : Alice a donné une adresse de remboursement à la création de sa commande payée, puis a renoncé
//   à la machine sans kit (lot encore en Précommande) : remboursement au prorata, à envoyer à cette adresse
//   (vue refunds_to_send). Bob : facture expirée il y a 3 h avec un paiement partiel, sans réponse après
//   contact : l'admin l'a remboursée, frais à la charge de Bob ; pas d'adresse connue, le remboursement
//   reste « à traiter » (order_payment_balance.refund_address_missing).
//   v5f : chaque remboursement a un motif (cause) qui fixe le payeur des frais (refund_cause_fee_payer).
//   Le renoncement d'Alice est à ses frais (user_renounce : elle reçoit le prorata moins les frais). Alice
//   avait saisi une adresse de remboursement erronée à la création, puis l'a corrigée : deux lignes au
//   journal OrderRefundAddressChange (acteur déclaré par declare_actor). Bob : commande payée avec 300
//   sats de trop, pas plus que les frais réseau : rien d'automatique, « à traiter » par l'admin
//   (order_payment_balance.overpayment_unrefunded).
//   v5i/v5j : chaque client a un e-mail de profil (User.email) et chaque facture l'instantané de l'adresse utilisée
//   (Order.contact_email).
//   Carol avait souhaité au sondage une machine avec Air Flow ; Air Flow est retiré après l'ouverture des
//   précommandes : sa wishlist figée revient à « Sans kit » (journal WishlistOptionWithdrawal), elle la garde.
//   Bob renvoie 400 sats sur sa facture déjà remboursée : moins que les frais, l'admin les classe sans suite
//   (OrderExcessDismissal).
// - Lot C « 6 S19 » au sondage : wishlists de Bob (Silent kit + nettoyage) et d'Alice (Air Flow),
//   demande potentielle visible dans part_stock_pressure.
// - Lot D « 8 S19 » en précommande ouverte au moment du seed : journée de priorité en cours.
//   Alice (1 wishlist) a payé trop : facture payée et excédent remboursé d'office, frais à sa charge
//   (motif overpayment, v5f), envoyé par l'admin à l'adresse donnée à la création de la facture ; sa
//   priorité vaut 1 machine,
//   elle est consommée. Bob, sans wishlist, ne peut pas commander avant la fin de la journée
//   (Order_priority_window).
// - Lot E « 3 S19 » annulé (v5l) : Dave (client à part, pour ne pas changer les vues d'Alice, Bob et Carol) avait payé
//   1 000 sats de trop puis renoncé à toute sa commande pendant la Précommande : le prix lui est remboursé (frais à sa
//   charge), l'excédent reste « à traiter » (order_payment_balance.surplus_left_sats) ; il renvoie ensuite 3 000 sats
//   sur la même adresse (paid_after_refund_sats). Sa seconde facture, en attente sans versement, est annulée par
//   l'annulation du lot (Order.cancel_reason = batch_closed). La facture annulée d'Alice (lot B) a la cause user.
// - Lot F « 4 S19 » au Contrôle (v6, jalon 5) : ses 4 machines ont été générées par la base à l'entrée en Attente de
//   réception. Clients à part (Erin, Frank). Erin (payée la première) : sa machine attribuée est morte après le test
//   (faulty), remplacée par une machine contrôlée ok (journal OrderLineAssignment, motif), la morte est mise au rebut.
//   Frank (payé ensuite) : pas encore de machine. Une machine reçue a une hashboard morte (degraded, décision du
//   technicien attendue), une dernière est reçue mais pas contrôlée. Journal MachineStatusChange complet.
// Paiements : taux fictif de 10 sats par centime (1 BTC = 100 000 €) ; montant attendu figé sur la facture.
// Réglages (ShopSettings) : ligne créée par la migration v5, valeurs par défaut.
// Configurations complètes : un item par menu visible du lot, « Sans » compris (Configuration_complete).
// Lancement : DATABASE_URL=... npx prisma db seed
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "./generated/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const IDS = {
  model: "5e1d0000-0000-4000-8000-000000000001",
  ventilation: "5e1d0000-0000-4000-8000-000000000101",
  cleaning: "5e1d0000-0000-4000-8000-000000000102",
  noKit: "5e1d0000-0000-4000-8000-000000000201",
  airFlow: "5e1d0000-0000-4000-8000-000000000202",
  silentKit: "5e1d0000-0000-4000-8000-000000000203",
  noCleaning: "5e1d0000-0000-4000-8000-000000000211",
  cleaningOn: "5e1d0000-0000-4000-8000-000000000212",
  silentKitPart: "5e1d0000-0000-4000-8000-000000000251",
  airFlowPart: "5e1d0000-0000-4000-8000-000000000252",
  batch: "5e1d0000-0000-4000-8000-000000000301",
  preorderBatch: "5e1d0000-0000-4000-8000-000000000302",
  surveyBatch: "5e1d0000-0000-4000-8000-000000000303",
  priorityBatch: "5e1d0000-0000-4000-8000-000000000304",
  cancelledBatch: "5e1d0000-0000-4000-8000-000000000305",
  inspectionBatch: "5e1d0000-0000-4000-8000-000000000306",
  alice: "5e1d0000-0000-4000-8000-000000000401",
  bob: "5e1d0000-0000-4000-8000-000000000402",
  carol: "5e1d0000-0000-4000-8000-000000000403",
  dave: "5e1d0000-0000-4000-8000-000000000404",
  erin: "5e1d0000-0000-4000-8000-000000000405",
  frank: "5e1d0000-0000-4000-8000-000000000406",
  aliceAddress: "5e1d0000-0000-4000-8000-000000000501",
  bobAddress: "5e1d0000-0000-4000-8000-000000000502",
  carolAddress: "5e1d0000-0000-4000-8000-000000000503",
  daveAddress: "5e1d0000-0000-4000-8000-000000000504",
  erinAddress: "5e1d0000-0000-4000-8000-000000000505",
  frankAddress: "5e1d0000-0000-4000-8000-000000000506",
  aliceWishlistConfig: "5e1d0000-0000-4000-8000-000000000601",
  aliceWishlist: "5e1d0000-0000-4000-8000-000000000701",
  aliceOrder: "5e1d0000-0000-4000-8000-000000000801",
  bobOrder: "5e1d0000-0000-4000-8000-000000000802",
  aliceExpiredOrder: "5e1d0000-0000-4000-8000-000000000804",
  aliceCancelledOrder: "5e1d0000-0000-4000-8000-000000000805",
  alicePriorityOrder: "5e1d0000-0000-4000-8000-000000000803",
  daveRenouncedOrder: "5e1d0000-0000-4000-8000-000000000806",
  daveClosedOrder: "5e1d0000-0000-4000-8000-000000000807",
  erinOrder: "5e1d0000-0000-4000-8000-000000000808",
  frankOrder: "5e1d0000-0000-4000-8000-000000000809",
  alicePriorityWishlist: "5e1d0000-0000-4000-8000-000000000702",
  alicePriorityWishlistConfig: "5e1d0000-0000-4000-8000-000000000602",
  silentKitOrder: "5e1d0000-0000-4000-8000-000000000901",
};

// Identifiants du service d'auth (auth.users.id, BIGINT). Admin fictif pour les journaux :
// mettre le même identifiant dans BACKOFFICE_USER_IDS pour l'utiliser en dev.
const SEED_ADMIN_AUTH_USER_ID = BigInt(process.env.SEED_ADMIN_AUTH_USER_ID ?? "1");
const AUTH_USER_IDS = {
  alice: BigInt(1001),
  bob: BigInt(1002),
  carol: BigInt(1003),
  dave: BigInt(1004),
  erin: BigInt(1005),
  frank: BigInt(1006),
};

type Tx = Prisma.TransactionClient;

/** Taux fictif du seed : 10 sats par centime d'euro (1 BTC = 100 000 €). */
const SATS_PER_CENT = BigInt(10);

/** Adresse Bitcoin de remboursement d'Alice (donnée à la création de ses factures) */
const ALICE_REFUND_ADDRESS = "bc1qseedalicerefund000000000000000000000";
/** Adresse erronée saisie d'abord par Alice, corrigée ensuite (journal OrderRefundAddressChange) */
const ALICE_MISTYPED_REFUND_ADDRESS = "bc1qseedalicetypo00000000000000000000000";
/** E-mails donnés par les clients à la création de leurs factures (v5i : figés sur chaque facture) */
const CONTACT_EMAILS = {
  alice: "alice.martin@exemple.fr",
  bob: "bob.durand@exemple.fr",
  carol: "carol.petit@exemple.fr",
  dave: "dave.leroy@exemple.fr",
  erin: "erin.moreau@exemple.fr",
  frank: "frank.girard@exemple.fr",
};
/** Frais réseau estimés d'un remboursement dans le seed (sats) */
const SEED_NETWORK_FEE = BigInt(450);
const DAY_MS = 24 * 3_600_000;
type Choice = { optionId: string; optionValueId: string; unitPrice: bigint };

/** Acteur de la transaction pour les écritures de Order.refund_address (declare_actor, journal d'audit). */
async function declareActor(tx: Tx, kind: "user" | "admin", authUserId: bigint) {
  await tx.$queryRaw`SELECT "declare_actor"(${kind}::"actor_kind", ${authUserId}::bigint)`;
}

const noKit: Choice = { optionId: IDS.ventilation, optionValueId: IDS.noKit, unitPrice: BigInt(0) };
const noCleaning: Choice = { optionId: IDS.cleaning, optionValueId: IDS.noCleaning, unitPrice: BigInt(0) };

/**
 * Crée une configuration complète (prix figés : un choix par menu visible du lot, défaut compris) ;
 * renvoie son id et son prix total.
 */
async function createConfiguration(tx: Tx, batchId: string, basePrice: bigint, choices: Choice[], id?: string) {
  const configuration = await tx.configuration.create({
    data: {
      id,
      batch_id: batchId,
      model_id: IDS.model,
      base_price: basePrice,
      items: {
        create: choices.map((c) => ({
          option_id: c.optionId,
          option_value_id: c.optionValueId,
          unit_price: c.unitPrice,
        })),
      },
    },
  });
  const total = choices.reduce((sum, c) => sum + c.unitPrice, basePrice);
  return { id: configuration.id, total };
}

async function seedCatalog(tx: Tx) {
  await tx.model.upsert({
    where: { id: IDS.model },
    update: {},
    create: {
      id: IDS.model,
      name: "S19",
      hashrate: BigInt(95_000_000_000_000), // 95 TH/s
      hashboard_qtt: 3,
      description: "Antminer S19, mineur SHA-256 reconditionné.",
    },
  });

  await tx.option.upsert({
    where: { id: IDS.ventilation },
    update: {},
    create: {
      id: IDS.ventilation,
      model_id: IDS.model,
      kind: "choice",
      title: "Kit de ventilation",
      description: "Choisissez le type de ventilation de votre nouvel appareil",
      position: 0,
    },
  });

  const values = [
    { id: IDS.noKit, label: "Sans kit", is_default: true, price: BigInt(0), position: 0 },
    { id: IDS.airFlow, label: "Air Flow", is_default: false, price: BigInt(3_500), position: 1 },
    { id: IDS.silentKit, label: "Silent kit", is_default: false, price: BigInt(7_500), position: 2 },
  ];
  for (const value of values) {
    await tx.optionValue.upsert({
      where: { id: value.id },
      update: {},
      create: { ...value, option_id: IDS.ventilation },
    });
  }

  await tx.option.upsert({
    where: { id: IDS.cleaning },
    update: {},
    create: { id: IDS.cleaning, model_id: IDS.model, kind: "toggle", title: "Nettoyage", position: 1 },
  });
  for (const value of [
    { id: IDS.noCleaning, label: "Sans", is_default: true, price: BigInt(0), position: 0 },
    { id: IDS.cleaningOn, label: "Avec", is_default: false, price: BigInt(2_000), position: 1 },
  ]) {
    await tx.optionValue.upsert({ where: { id: value.id }, update: {}, create: { ...value, option_id: IDS.cleaning } });
  }

  // Produits d'options : achetés tels quels, un kit par machine
  for (const [partId, valueId, name, reference] of [
    [IDS.silentKitPart, IDS.silentKit, "Silent kit", "SK-120"],
    [IDS.airFlowPart, IDS.airFlow, "Kit Air Flow", "AF-200"],
  ] as const) {
    await tx.part.upsert({ where: { id: partId }, update: {}, create: { id: partId, name, reference } });
    await tx.optionValuePart.upsert({
      where: { option_value_id_part_id: { option_value_id: valueId, part_id: partId } },
      update: {},
      create: { option_value_id: valueId, part_id: partId, qty: 1 },
    });
  }

  // Stock commun (journal append-only) : seulement au premier seed
  if ((await tx.partStockMovement.count({ where: { part_id: IDS.silentKitPart } })) === 0) {
    await tx.partStockMovement.createMany({
      data: [
        { part_id: IDS.silentKitPart, kind: "reception", qty: 3, note: "Stock initial", created_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID },
        { part_id: IDS.silentKitPart, kind: "adjustment", qty: -1, note: "Kit abîmé, retiré à l'inventaire", created_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID },
      ],
    });
  }
}

async function seedDraftBatch(tx: Tx) {
  if (await tx.batch.findUnique({ where: { id: IDS.batch } })) return;
  const quantity = 10;
  await tx.batch.create({
    data: {
      id: IDS.batch,
      name: `${quantity} S19`,
      model_id: IDS.model,
      quantity,
      purchase_price: BigInt(300_000), // 3 000 € le lot
      resale_unit_price: BigInt(45_000), // 450 € l'unité
    },
  });
  await tx.batchStatusTransition.create({
    data: { batch_id: IDS.batch, from_status: null, to_status: "draft", changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID, note: "Seed" },
  });
}

async function seedPreorderBatch(tx: Tx) {
  if (await tx.batch.findUnique({ where: { id: IDS.preorderBatch } })) return;
  const quantity = 4;
  const resale = BigInt(48_000);
  await tx.batch.create({
    data: {
      id: IDS.preorderBatch,
      name: `${quantity} S19`,
      model_id: IDS.model,
      quantity,
      purchase_price: BigInt(140_000),
      resale_unit_price: resale,
      // Menu masqué pour ce lot : réglé en brouillon (ou au sondage), figé ensuite
      options: { create: { option_id: IDS.cleaning, hidden: true } },
      option_values: {
        create: [
          // Air Flow est retiré après l'ouverture des précommandes (plus bas, v5i)
          // Dérogation de prix et quantité maximale
          { option_id: IDS.ventilation, option_value_id: IDS.silentKit, price_override: BigInt(6_900), max_qty: 2 },
        ],
      },
    },
  });

  // Le statut ne change que par le journal des transitions (trigger). Journal antidaté : sondage il y
  // a 3 jours, précommandes ouvertes il y a 2 jours (journée de priorité terminée).
  const log = (from_status: "draft" | "survey" | null, to_status: "draft" | "survey" | "preorder", daysAgo: number) =>
    tx.batchStatusTransition.create({
      data: {
        batch_id: IDS.preorderBatch,
        from_status,
        to_status,
        changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID,
        note: "Seed",
        created_at: new Date(Date.now() - daysAgo * DAY_MS),
      },
    });
  await log(null, "draft", 3.1);
  await log("draft", "survey", 3);

  // Utilisateurs et adresses
  for (const [userKey, userId, authUserId, addressId, fullName, city] of [
    ["alice", IDS.alice, AUTH_USER_IDS.alice, IDS.aliceAddress, "Alice Martin", "Lyon"],
    ["bob", IDS.bob, AUTH_USER_IDS.bob, IDS.bobAddress, "Bob Durand", "Nantes"],
    ["carol", IDS.carol, AUTH_USER_IDS.carol, IDS.carolAddress, "Carol Petit", "Lille"],
  ] as const) {
    await tx.user.upsert({
      where: { id: userId },
      update: {},
      // v5j : e-mail du profil (prérempli sur les factures, modifiable par l'utilisateur)
      create: { id: userId, auth_user_id: authUserId, email: CONTACT_EMAILS[userKey] },
    });
    await tx.address.upsert({
      where: { id: addressId },
      update: {},
      create: { id: addressId, user_id: userId, full_name: fullName, line1: "1 rue de la Paix", postal_code: "69001", city, country: "FR" },
    });
  }

  // Sondage : Alice manifeste son intérêt pour une machine avec Silent kit (Nettoyage masqué : pas d'item)
  const silentKit: Choice = { optionId: IDS.ventilation, optionValueId: IDS.silentKit, unitPrice: BigInt(6_900) };
  await createConfiguration(tx, IDS.preorderBatch, resale, [silentKit], IDS.aliceWishlistConfig);
  await tx.wishlist.create({
    data: { id: IDS.aliceWishlist, user_id: IDS.alice, batch_id: IDS.preorderBatch, configuration_id: IDS.aliceWishlistConfig },
  });

  // Sondage : Carol souhaite une machine avec Air Flow
  const carolWishlist = await createConfiguration(tx, IDS.preorderBatch, resale, [
    { optionId: IDS.ventilation, optionValueId: IDS.airFlow, unitPrice: BigInt(3_500) },
  ]);
  await tx.wishlist.create({ data: { user_id: IDS.carol, batch_id: IDS.preorderBatch, configuration_id: carolWishlist.id } });

  // Ouverture des précommandes : début de la journée de priorité (terminée depuis)
  await log("survey", "preorder", 2);

  // Option retirée pour ce lot après l'ouverture des précommandes (jamais la valeur par défaut : garanti en
  // base). v5i : la wishlist figée de Carol revient d'office à « Sans kit » (0 €), elle la garde avec sa
  // priorité, et l'ajustement est journalisé pour la prévenir (WishlistOptionWithdrawal).
  await tx.batchOptionValue.update({
    where: { batch_id_option_value_id: { batch_id: IDS.preorderBatch, option_value_id: IDS.airFlow } },
    data: { enabled: false },
  });

  // Alice : 2 machines. La ligne issue de la wishlist reçoit une copie de sa configuration (prix figés).
  // Elle saisit une adresse de remboursement (erronée, corrigée plus bas) : acteur déclaré.
  await declareActor(tx, "user", AUTH_USER_IDS.alice);
  const fromWishlist = await createConfiguration(tx, IDS.preorderBatch, resale, [silentKit]);
  const plain = await createConfiguration(tx, IDS.preorderBatch, resale, [noKit]);
  await tx.order.create({
    data: {
      id: IDS.aliceOrder,
      user_id: IDS.alice,
      batch_id: IDS.preorderBatch,
      billing_address_id: IDS.aliceAddress,
      shipping_address_id: IDS.aliceAddress,
      total_amount: fromWishlist.total + plain.total,
      expected_sats: (fromWishlist.total + plain.total) * SATS_PER_CENT,
      payment_address: "bc1qseedalice0000000000000000000000000000",
      contact_email: CONTACT_EMAILS.alice,
      refund_address: ALICE_MISTYPED_REFUND_ADDRESS,
    },
  });
  await tx.orderLine.createMany({
    data: [
      { order_id: IDS.aliceOrder, user_id: IDS.alice, batch_id: IDS.preorderBatch, configuration_id: fromWishlist.id, amount: fromWishlist.total, wishlist_id: IDS.aliceWishlist },
      { order_id: IDS.aliceOrder, user_id: IDS.alice, batch_id: IDS.preorderBatch, configuration_id: plain.id, amount: plain.total },
    ],
  });
  // Deux paiements : un premier insuffisant, puis l'appoint ; la base tient received_sats.
  const aliceExpected = (fromWishlist.total + plain.total) * SATS_PER_CENT;
  await tx.payment.createMany({
    data: [
      { order_id: IDS.aliceOrder, amount_sats: BigInt(600_000), txid: "seed-txid-alice-1", vout: 0 },
      { order_id: IDS.aliceOrder, amount_sats: aliceExpected - BigInt(600_000), txid: "seed-txid-alice-2", vout: 1 },
    ],
  });
  await tx.order.update({ where: { id: IDS.aliceOrder }, data: { status: "paid", paid_at: new Date() } });

  // Alice corrige son adresse de remboursement (2e ligne du journal)
  await declareActor(tx, "user", AUTH_USER_IDS.alice);
  await tx.order.update({ where: { id: IDS.aliceOrder }, data: { refund_address: ALICE_REFUND_ADDRESS } });

  // Alice renonce à la machine sans kit (lot en Précommande) : annulation au prorata (brut) de ce qu'elle a
  // payé, frais réseau à sa charge (user_renounce) ; adresse effective : celle de la facture (pas encore envoyé).
  const [{ sats: renouncedSats }] = await tx.$queryRaw<{ sats: bigint }[]>`
    SELECT "refund_prorata_sats"(${IDS.aliceOrder}::uuid, ${plain.total}) AS "sats"`;
  const renounced = await tx.refund.create({
    data: {
      order_id: IDS.aliceOrder,
      kind: "cancellation",
      cause: "user_renounce",
      initiated_by: "user",
      amount: plain.total,
      amount_sats: renouncedSats - SEED_NETWORK_FEE,
      network_fee_sats: SEED_NETWORK_FEE,
      network_fee_payer: "user",
      reason: "Renoncement de l'utilisateur à une machine (lot en Précommande)",
    },
  });
  await tx.orderLine.update({ where: { configuration_id: plain.id }, data: { refund_id: renounced.id } });

  // Bob : commande payée avec 300 sats de trop, pas plus que les frais réseau : aucun remboursement
  // automatique (Refund_system_above_fee), « à traiter » par l'admin (overpayment_unrefunded). Créée avant
  // sa facture en attente (une seule facture vivante par utilisateur et par lot).
  const bobPaidConfig = await createConfiguration(tx, IDS.preorderBatch, resale, [noKit]);
  const bobPaid = await tx.order.create({
    data: {
      user_id: IDS.bob,
      batch_id: IDS.preorderBatch,
      billing_address_id: IDS.bobAddress,
      shipping_address_id: IDS.bobAddress,
      total_amount: bobPaidConfig.total,
      expected_sats: bobPaidConfig.total * SATS_PER_CENT,
      payment_address: "bc1qseedbobpaid000000000000000000000000000",
      contact_email: CONTACT_EMAILS.bob,
    },
  });
  await tx.orderLine.create({
    data: { order_id: bobPaid.id, user_id: IDS.bob, batch_id: IDS.preorderBatch, configuration_id: bobPaidConfig.id, amount: bobPaidConfig.total },
  });
  await tx.payment.create({
    data: { order_id: bobPaid.id, amount_sats: bobPaidConfig.total * SATS_PER_CENT + BigInt(300), txid: "seed-txid-bob-paid", vout: 0 },
  });
  await tx.order.update({ where: { id: bobPaid.id }, data: { status: "paid", paid_at: new Date() } });

  // Bob : facture en attente, réserve une place jusqu'à expires_at
  const bobConfig = await createConfiguration(tx, IDS.preorderBatch, resale, [noKit]);
  await tx.order.create({
    data: {
      id: IDS.bobOrder,
      user_id: IDS.bob,
      batch_id: IDS.preorderBatch,
      billing_address_id: IDS.bobAddress,
      shipping_address_id: IDS.bobAddress,
      total_amount: bobConfig.total,
      expected_sats: bobConfig.total * SATS_PER_CENT,
      payment_address: "bc1qseedbob00000000000000000000000000000",
      contact_email: CONTACT_EMAILS.bob,
    },
  });
  await tx.orderLine.create({
    data: { order_id: IDS.bobOrder, user_id: IDS.bob, batch_id: IDS.preorderBatch, configuration_id: bobConfig.id, amount: bobConfig.total },
  });
  // Paiement partiel : la facture reste en attente, l'appoint est attendu (order_payment_balance)
  await tx.payment.create({ data: { order_id: IDS.bobOrder, amount_sats: BigInt(200_000), txid: "seed-txid-bob-1", vout: 0 } });

  // Alice : facture expirée il y a 90 min avec un paiement partiel ; elle a choisi le remboursement de
  // ce qu'elle avait avancé, frais réseau à sa charge (déduits de ce qu'elle reçoit).
  const expiredConfig = await createConfiguration(tx, IDS.preorderBatch, resale, [noKit]);
  await tx.order.create({
    data: {
      id: IDS.aliceExpiredOrder,
      user_id: IDS.alice,
      batch_id: IDS.preorderBatch,
      billing_address_id: IDS.aliceAddress,
      shipping_address_id: IDS.aliceAddress,
      total_amount: expiredConfig.total,
      expected_sats: expiredConfig.total * SATS_PER_CENT,
      payment_address: "bc1qseedaliceexpired000000000000000000000",
      contact_email: CONTACT_EMAILS.alice,
      created_at: new Date(Date.now() - 2 * 3_600_000),
      expires_at: new Date(Date.now() - 1.5 * 3_600_000),
    },
  });
  await tx.orderLine.create({
    data: { order_id: IDS.aliceExpiredOrder, user_id: IDS.alice, batch_id: IDS.preorderBatch, configuration_id: expiredConfig.id, amount: expiredConfig.total },
  });
  await tx.payment.create({ data: { order_id: IDS.aliceExpiredOrder, amount_sats: BigInt(150_000), txid: "seed-txid-alice-expired", vout: 0 } });
  const userRefund = await tx.refund.create({
    data: {
      order_id: IDS.aliceExpiredOrder,
      kind: "cancellation",
      cause: "partial_payment",
      amount: expiredConfig.total,
      amount_sats: BigInt(150_000 - 600),
      network_fee_sats: BigInt(600),
      network_fee_payer: "user",
      initiated_by: "user",
      reason: "Remboursement demandé par l'utilisateur (facture expirée, appoint non versé)",
      destination_address: ALICE_REFUND_ADDRESS,
    },
  });
  await tx.orderLine.updateMany({ where: { order_id: IDS.aliceExpiredOrder }, data: { refund_id: userRefund.id } });
  await tx.order.update({ where: { id: IDS.aliceExpiredOrder }, data: { status: "refunded", refunded_at: new Date() } });

  // Bob : facture expirée il y a 3 h, paiement partiel, aucune réponse après contact. L'admin rembourse
  // ce qu'il a envoyé moins les frais réseau (à sa charge) ; sans adresse connue : « à traiter ».
  const bobExpiredConfig = await createConfiguration(tx, IDS.preorderBatch, resale, [noKit]);
  const bobExpired = await tx.order.create({
    data: {
      user_id: IDS.bob,
      batch_id: IDS.preorderBatch,
      billing_address_id: IDS.bobAddress,
      shipping_address_id: IDS.bobAddress,
      total_amount: bobExpiredConfig.total,
      expected_sats: bobExpiredConfig.total * SATS_PER_CENT,
      payment_address: "bc1qseedbobexpired0000000000000000000000",
      contact_email: CONTACT_EMAILS.bob,
      created_at: new Date(Date.now() - 3.5 * 3_600_000),
      expires_at: new Date(Date.now() - 3 * 3_600_000),
    },
  });
  await tx.orderLine.create({
    data: { order_id: bobExpired.id, user_id: IDS.bob, batch_id: IDS.preorderBatch, configuration_id: bobExpiredConfig.id, amount: bobExpiredConfig.total },
  });
  await tx.payment.create({ data: { order_id: bobExpired.id, amount_sats: BigInt(120_000), txid: "seed-txid-bob-expired", vout: 0 } });
  const adminRefund = await tx.refund.create({
    data: {
      order_id: bobExpired.id,
      kind: "cancellation",
      cause: "partial_payment",
      initiated_by: "admin",
      created_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID,
      amount: bobExpiredConfig.total,
      amount_sats: BigInt(120_000 - 600),
      network_fee_sats: BigInt(600),
      network_fee_payer: "user",
      reason: "Contacté le jour même, sans réponse : versement remboursé, frais réseau à sa charge",
    },
  });
  await tx.orderLine.updateMany({ where: { order_id: bobExpired.id }, data: { refund_id: adminRefund.id } });
  await tx.order.update({ where: { id: bobExpired.id }, data: { status: "refunded" } });
  // v5i : Bob renvoie ensuite 400 sats sur la même adresse. Les rendre coûterait plus que les frais réseau
  // (450 sats) : l'admin les classe sans suite (OrderExcessDismissal), la trace reste.
  await tx.payment.create({ data: { order_id: bobExpired.id, amount_sats: BigInt(400), txid: "seed-txid-bob-expired-late", vout: 0 } });
  await tx.orderExcessDismissal.create({
    data: {
      order_id: bobExpired.id,
      sats: BigInt(400),
      network_fee_sats: SEED_NETWORK_FEE,
      reason: "400 sats reçus après le remboursement : les renvoyer coûterait davantage en frais réseau",
      dismissed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID,
    },
  });

  // Alice : facture annulée avant tout paiement (place libérée tout de suite), puis payée quand même :
  // ni acceptée ni remboursée d'office, à traiter par l'admin.
  const cancelledConfig = await createConfiguration(tx, IDS.preorderBatch, resale, [noKit]);
  await tx.order.create({
    data: {
      id: IDS.aliceCancelledOrder,
      user_id: IDS.alice,
      batch_id: IDS.preorderBatch,
      billing_address_id: IDS.aliceAddress,
      shipping_address_id: IDS.aliceAddress,
      total_amount: cancelledConfig.total,
      expected_sats: cancelledConfig.total * SATS_PER_CENT,
      payment_address: "bc1qseedalicecancelled0000000000000000000",
      contact_email: CONTACT_EMAILS.alice,
    },
  });
  await tx.orderLine.create({
    data: { order_id: IDS.aliceCancelledOrder, user_id: IDS.alice, batch_id: IDS.preorderBatch, configuration_id: cancelledConfig.id, amount: cancelledConfig.total },
  });
  await tx.order.update({ where: { id: IDS.aliceCancelledOrder }, data: { status: "cancelled", cancelled_at: new Date() } });
  await tx.payment.create({
    data: { order_id: IDS.aliceCancelledOrder, amount_sats: cancelledConfig.total * SATS_PER_CENT, txid: "seed-txid-alice-cancelled", vout: 0 },
  });

  // Carol : trois factures laissées expirer sans payer en 6 h (abandons). Au 3e abandon dans la fenêtre
  // de 24 h (ShopSettings), elle ne peut plus créer de facture sur ce lot sans décision de l'admin.
  for (const hoursAgo of [6, 4, 2]) {
    const config = await createConfiguration(tx, IDS.preorderBatch, resale, [noKit]);
    const order = await tx.order.create({
      data: {
        user_id: IDS.carol,
        batch_id: IDS.preorderBatch,
        billing_address_id: IDS.carolAddress,
        shipping_address_id: IDS.carolAddress,
        total_amount: config.total,
        expected_sats: config.total * SATS_PER_CENT,
        payment_address: `bc1qseedcarolabandoned${hoursAgo}00000000000000000000`,
        contact_email: CONTACT_EMAILS.carol,
        created_at: new Date(Date.now() - hoursAgo * 3_600_000 - 30 * 60_000),
        expires_at: new Date(Date.now() - hoursAgo * 3_600_000),
      },
    });
    await tx.orderLine.create({
      data: { order_id: order.id, user_id: IDS.carol, batch_id: IDS.preorderBatch, configuration_id: config.id, amount: config.total },
    });
  }

  // Produit d'option commandé pour ce lot, en route (le stock commun le recevra à la livraison)
  await tx.batchPartOrder.create({
    data: { id: IDS.silentKitOrder, batch_id: IDS.preorderBatch, part_id: IDS.silentKitPart, qty: 1, status: "awaiting_delivery" },
  });
}

async function seedSurveyBatch(tx: Tx) {
  if (await tx.batch.findUnique({ where: { id: IDS.surveyBatch } })) return;
  const quantity = 6;
  const resale = BigInt(46_000);
  await tx.batch.create({
    data: {
      id: IDS.surveyBatch,
      name: `${quantity} S19`,
      model_id: IDS.model,
      quantity,
      purchase_price: BigInt(210_000),
      resale_unit_price: resale,
    },
  });
  await tx.batchStatusTransition.createMany({
    data: [
      { batch_id: IDS.surveyBatch, from_status: null, to_status: "draft", changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID, note: "Seed" },
      { batch_id: IDS.surveyBatch, from_status: "draft", to_status: "survey", changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID, note: "Seed" },
    ],
  });

  // Intérêts (sans argent) : demande potentielle de produits d'options
  const wishes: [string, Choice[]][] = [
    [IDS.bob, [
      { optionId: IDS.ventilation, optionValueId: IDS.silentKit, unitPrice: BigInt(7_500) },
      { optionId: IDS.cleaning, optionValueId: IDS.cleaningOn, unitPrice: BigInt(2_000) },
    ]],
    [IDS.alice, [{ optionId: IDS.ventilation, optionValueId: IDS.airFlow, unitPrice: BigInt(3_500) }, noCleaning]],
  ];
  for (const [userId, choices] of wishes) {
    const configuration = await createConfiguration(tx, IDS.surveyBatch, resale, choices);
    await tx.wishlist.create({ data: { user_id: userId, batch_id: IDS.surveyBatch, configuration_id: configuration.id } });
  }
}

async function seedPriorityBatch(tx: Tx) {
  if (await tx.batch.findUnique({ where: { id: IDS.priorityBatch } })) return;
  const quantity = 8;
  const resale = BigInt(47_000);
  await tx.batch.create({
    data: { id: IDS.priorityBatch, name: `${quantity} S19`, model_id: IDS.model, quantity, purchase_price: BigInt(280_000), resale_unit_price: resale },
  });
  const log = (from_status: "draft" | "survey" | null, to_status: "draft" | "survey" | "preorder") =>
    tx.batchStatusTransition.create({
      data: { batch_id: IDS.priorityBatch, from_status, to_status, changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID, note: "Seed" },
    });
  await log(null, "draft");
  await log("draft", "survey");

  // Sondage : Alice souhaite une machine avec Silent kit et nettoyage
  const choices: Choice[] = [
    { optionId: IDS.ventilation, optionValueId: IDS.silentKit, unitPrice: BigInt(7_500) },
    { optionId: IDS.cleaning, optionValueId: IDS.cleaningOn, unitPrice: BigInt(2_000) },
  ];
  await createConfiguration(tx, IDS.priorityBatch, resale, choices, IDS.alicePriorityWishlistConfig);
  await tx.wishlist.create({
    data: { id: IDS.alicePriorityWishlist, user_id: IDS.alice, batch_id: IDS.priorityBatch, configuration_id: IDS.alicePriorityWishlistConfig },
  });

  // Ouverture des précommandes maintenant : journée de priorité en cours (Alice seule peut commander)
  await log("survey", "preorder");

  // Alice convertit sa wishlist et paie 5 000 sats de trop : excédent remboursé d'office, frais réseau à
  // sa charge (motif overpayment) : elle reçoit 5 000 − 450 sats. Adresse saisie à la création : acteur déclaré.
  await declareActor(tx, "user", AUTH_USER_IDS.alice);
  const line = await createConfiguration(tx, IDS.priorityBatch, resale, choices);
  const expected = line.total * SATS_PER_CENT;
  await tx.order.create({
    data: {
      id: IDS.alicePriorityOrder,
      user_id: IDS.alice,
      batch_id: IDS.priorityBatch,
      billing_address_id: IDS.aliceAddress,
      shipping_address_id: IDS.aliceAddress,
      total_amount: line.total,
      expected_sats: expected,
      payment_address: "bc1qseedalicepriority00000000000000000000",
      contact_email: CONTACT_EMAILS.alice,
      refund_address: ALICE_REFUND_ADDRESS,
    },
  });
  await tx.orderLine.create({
    data: {
      order_id: IDS.alicePriorityOrder,
      user_id: IDS.alice,
      batch_id: IDS.priorityBatch,
      configuration_id: line.id,
      wishlist_id: IDS.alicePriorityWishlist,
      amount: line.total,
    },
  });
  await tx.payment.create({
    data: { order_id: IDS.alicePriorityOrder, amount_sats: expected + BigInt(5_000), txid: "seed-txid-alice-priority", vout: 0 },
  });
  await tx.order.update({ where: { id: IDS.alicePriorityOrder }, data: { status: "paid", paid_at: new Date() } });
  await tx.refund.create({
    data: {
      order_id: IDS.alicePriorityOrder,
      kind: "overpayment",
      cause: "overpayment",
      amount: BigInt(0),
      amount_sats: BigInt(5_000) - SEED_NETWORK_FEE,
      network_fee_sats: SEED_NETWORK_FEE,
      network_fee_payer: "user",
      // Aucun excédent n'est remboursé d'office (v5h) : décision de l'admin
      initiated_by: "admin",
      created_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID,
      reason: "Excédent de paiement",
      destination_address: ALICE_REFUND_ADDRESS,
      reference: "seed-txid-alice-overpayment-refund",
      // Envoi enregistré par l'admin ; date posée par la base
      sent_at: new Date(),
      sent_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID,
    },
  });
}

/**
 * Lot E annulé (v5l) : surplus resté après un renoncement complet, versement arrivé après le remboursement intégral,
 * facture en attente annulée par le lot (cancel_reason batch_closed, posée par la base).
 */
async function seedCancelledBatch(tx: Tx) {
  if (await tx.batch.findUnique({ where: { id: IDS.cancelledBatch } })) return;
  const quantity = 3;
  const resale = BigInt(44_000);
  await tx.batch.create({
    data: { id: IDS.cancelledBatch, name: `${quantity} S19`, model_id: IDS.model, quantity, purchase_price: BigInt(105_000), resale_unit_price: resale },
  });
  const log = (from_status: "draft" | "preorder" | null, to_status: "draft" | "preorder" | "cancelled", daysAgo?: number, note = "Seed") =>
    tx.batchStatusTransition.create({
      data: {
        batch_id: IDS.cancelledBatch,
        from_status,
        to_status,
        changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID,
        note,
        created_at: daysAgo === undefined ? undefined : new Date(Date.now() - daysAgo * DAY_MS),
      },
    });
  // Précommandes ouvertes sans sondage (pas de journée de priorité)
  await log(null, "draft", 1.1);
  await log("draft", "preorder", 1);

  await tx.user.upsert({
    where: { id: IDS.dave },
    update: {},
    create: { id: IDS.dave, auth_user_id: AUTH_USER_IDS.dave, email: CONTACT_EMAILS.dave },
  });
  await tx.address.upsert({
    where: { id: IDS.daveAddress },
    update: {},
    create: { id: IDS.daveAddress, user_id: IDS.dave, full_name: "Dave Leroy", line1: "1 rue de la Paix", postal_code: "69001", city: "Rennes", country: "FR" },
  });

  // Commande payée avec 1 000 sats de trop, adresse de remboursement donnée à la création (acteur déclaré)
  await declareActor(tx, "user", AUTH_USER_IDS.dave);
  const paidConfig = await createConfiguration(tx, IDS.cancelledBatch, resale, [noKit, noCleaning]);
  const expected = paidConfig.total * SATS_PER_CENT;
  await tx.order.create({
    data: {
      id: IDS.daveRenouncedOrder,
      user_id: IDS.dave,
      batch_id: IDS.cancelledBatch,
      billing_address_id: IDS.daveAddress,
      shipping_address_id: IDS.daveAddress,
      total_amount: paidConfig.total,
      expected_sats: expected,
      payment_address: "bc1qseeddaverenounced000000000000000000000",
      contact_email: CONTACT_EMAILS.dave,
      refund_address: "bc1qseeddaverefund0000000000000000000000",
    },
  });
  await tx.orderLine.create({
    data: { order_id: IDS.daveRenouncedOrder, user_id: IDS.dave, batch_id: IDS.cancelledBatch, configuration_id: paidConfig.id, amount: paidConfig.total },
  });
  await tx.payment.create({
    data: { order_id: IDS.daveRenouncedOrder, amount_sats: expected + BigInt(1_000), txid: "seed-txid-dave-paid", vout: 0 },
  });
  await tx.order.update({ where: { id: IDS.daveRenouncedOrder }, data: { status: "paid", paid_at: new Date() } });

  // Renoncement à toute la commande (lot en Précommande) : le prix est rendu, frais à sa charge ; l'utilisateur
  // n'écrit jamais l'excédent (v5k) : les 1 000 sats restent « à traiter » (surplus resté)
  const renounced = await tx.refund.create({
    data: {
      order_id: IDS.daveRenouncedOrder,
      kind: "cancellation",
      cause: "user_renounce",
      initiated_by: "user",
      amount: paidConfig.total,
      amount_sats: expected - SEED_NETWORK_FEE,
      network_fee_sats: SEED_NETWORK_FEE,
      network_fee_payer: "user",
      reason: "Renoncement de l'utilisateur à toute sa commande (lot en Précommande)",
    },
  });
  await tx.orderLine.updateMany({ where: { order_id: IDS.daveRenouncedOrder }, data: { refund_id: renounced.id } });
  await tx.order.update({ where: { id: IDS.daveRenouncedOrder }, data: { status: "refunded" } });
  // Versement arrivé après le remboursement intégral, sur la même adresse
  await tx.payment.create({
    data: { order_id: IDS.daveRenouncedOrder, amount_sats: BigInt(3_000), txid: "seed-txid-dave-after-refund", vout: 0 },
  });

  // Nouvelle facture en attente, sans versement : annulée par l'annulation du lot (cause batch_closed)
  const pendingConfig = await createConfiguration(tx, IDS.cancelledBatch, resale, [noKit, noCleaning]);
  await tx.order.create({
    data: {
      id: IDS.daveClosedOrder,
      user_id: IDS.dave,
      batch_id: IDS.cancelledBatch,
      billing_address_id: IDS.daveAddress,
      shipping_address_id: IDS.daveAddress,
      total_amount: pendingConfig.total,
      expected_sats: pendingConfig.total * SATS_PER_CENT,
      payment_address: "bc1qseeddaveclosed0000000000000000000000",
      contact_email: CONTACT_EMAILS.dave,
    },
  });
  await tx.orderLine.create({
    data: { order_id: IDS.daveClosedOrder, user_id: IDS.dave, batch_id: IDS.cancelledBatch, configuration_id: pendingConfig.id, amount: pendingConfig.total },
  });
  await log("preorder", "cancelled", undefined, "Lot abandonné (seed)");
}

/**
 * Lot F au Contrôle (v6) : machines générées par la base, réception, contrôle (hashboards), machine morte remplacée
 * puis mise au rebut, machine à hashboard morte en attente de décision, machine reçue non contrôlée.
 */
async function seedInspectionBatch(tx: Tx) {
  if (await tx.batch.findUnique({ where: { id: IDS.inspectionBatch } })) return;
  const quantity = 4;
  const resale = BigInt(46_000);
  await tx.batch.create({
    data: { id: IDS.inspectionBatch, name: `${quantity} S19`, model_id: IDS.model, quantity, purchase_price: BigInt(150_000), resale_unit_price: resale },
  });
  const statuses = ["draft", "preorder", "ordering", "awaiting_reception", "inspection"] as const;
  for (const [i, to] of statuses.entries()) {
    await tx.batchStatusTransition.create({
      data: {
        batch_id: IDS.inspectionBatch,
        from_status: i === 0 ? null : statuses[i - 1],
        to_status: to,
        changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID,
        note: "Seed",
        // Précommandes ouvertes sans sondage il y a 5 jours, Contrôle depuis ce matin
        created_at: new Date(Date.now() - (5 - i) * DAY_MS + (i === 4 ? 0.8 * DAY_MS : 0)),
      },
    });
  }

  // Clients : une commande payée chacun, sans option (Erin payée la première)
  const paidLine = async (who: "erin" | "frank", hoursAgo: number) => {
    const [userId, addressId, orderId, city] =
      who === "erin" ? [IDS.erin, IDS.erinAddress, IDS.erinOrder, "Nantes"] : [IDS.frank, IDS.frankAddress, IDS.frankOrder, "Lille"];
    await tx.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, auth_user_id: AUTH_USER_IDS[who], email: CONTACT_EMAILS[who] } });
    await tx.address.upsert({
      where: { id: addressId },
      update: {},
      create: { id: addressId, user_id: userId, full_name: who === "erin" ? "Erin Moreau" : "Frank Girard", line1: "3 rue des Lilas", postal_code: "44000", city, country: "FR" },
    });
    const config = await createConfiguration(tx, IDS.inspectionBatch, resale, [noKit, noCleaning]);
    const expected = config.total * SATS_PER_CENT;
    await tx.order.create({
      data: {
        id: orderId, user_id: userId, batch_id: IDS.inspectionBatch, billing_address_id: addressId, shipping_address_id: addressId,
        total_amount: config.total, expected_sats: expected, payment_address: `bc1qseed${who}inspection0000000000000000000`,
        contact_email: CONTACT_EMAILS[who],
        // Facture créée 10 min avant son paiement (antidatée, réservation de 30 min)
        created_at: new Date(Date.now() - hoursAgo * 3_600_000 - 10 * 60_000),
        expires_at: new Date(Date.now() - hoursAgo * 3_600_000 + 20 * 60_000),
      },
    });
    const line = await tx.orderLine.create({
      data: { order_id: orderId, user_id: userId, batch_id: IDS.inspectionBatch, configuration_id: config.id, amount: config.total },
    });
    await tx.payment.create({ data: { order_id: orderId, amount_sats: expected, txid: `seed-txid-${who}-inspection`, vout: 0 } });
    await tx.order.update({ where: { id: orderId }, data: { status: "paid", paid_at: new Date(Date.now() - hoursAgo * 3_600_000) } });
    return line.id;
  };
  const erinLine = await paidLine("erin", 30);
  await paidLine("frank", 6);

  // Machines générées à l'entrée en Attente de réception : numéros de série saisis à la réception
  const machines = await tx.machine.findMany({ where: { batch_id: IDS.inspectionBatch }, orderBy: [{ created_at: "asc" }, { id: "asc" }] });
  // La quatrième machine est reçue mais pas encore contrôlée
  const [replacement, degraded, dead] = machines;
  const change = async (machineId: string, to: { logistical?: "in_stock" | "scrapped"; functional?: "ok" | "degraded" | "faulty" }, note?: string) => {
    const m = await tx.machine.findUniqueOrThrow({ where: { id: machineId } });
    await tx.machineStatusChange.create({
      data: {
        machine_id: machineId, batch_id: IDS.inspectionBatch,
        from_logistical: m.logistical_status, to_logistical: to.logistical ?? m.logistical_status,
        from_functional: m.functional_status, to_functional: to.functional ?? m.functional_status,
        note, changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID,
      },
    });
  };
  const boards = async (machineId: string, statuses: ("ok" | "degraded" | "dead")[]) => {
    for (const [index, status] of statuses.entries()) {
      await tx.hashboardStatus.create({ data: { machine_id: machineId, index, status, checked_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID } });
    }
  };
  for (const [n, m] of machines.entries()) {
    await tx.machine.update({ where: { id: m.id }, data: { serial: `S19-F-000${n + 1}`, psu_serial: `APW12-F-000${n + 1}` } });
    await change(m.id, { logistical: "in_stock" });
  }
  // Première machine contrôlée et attribuée à Erin, morte au test d'endurance : remplacée, puis mise au rebut
  await boards(dead.id, ["ok", "ok", "ok"]);
  await change(dead.id, { functional: "ok" });
  await tx.orderLineAssignment.create({
    data: { order_line_id: erinLine, batch_id: IDS.inspectionBatch, machine_id: dead.id, changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID },
  });
  await change(dead.id, { functional: "faulty" }, "Ne redémarre plus après 2 h de test d'endurance");
  await boards(replacement.id, ["ok", "ok", "ok"]);
  await change(replacement.id, { functional: "ok" });
  await tx.orderLineAssignment.create({
    data: {
      order_line_id: erinLine, batch_id: IDS.inspectionBatch, machine_id: replacement.id,
      changed_by_auth_user_id: SEED_ADMIN_AUTH_USER_ID, reason: "Remplacement : machine d'origine morte au test",
    },
  });
  await change(dead.id, { logistical: "scrapped" }, "Carte de contrôle grillée, retirée du stock");
  // Hashboard 2 morte : marquée telle quelle, décision du technicien attendue (annulation, remplacement, rabais)
  await boards(degraded.id, ["ok", "dead", "ok"]);
  await change(degraded.id, { functional: "degraded" });
}

async function main() {
  // Les contrôles différés (stock, totaux) s'exécutent au commit de cette transaction.
  await prisma.$transaction(
    async (tx) => {
      await seedCatalog(tx);
      await seedDraftBatch(tx);
      await seedPreorderBatch(tx);
      await seedSurveyBatch(tx);
      await seedPriorityBatch(tx);
      await seedCancelledBatch(tx);
      await seedInspectionBatch(tx);
    },
    { timeout: 20_000 },
  );
}

main()
  .then(() => console.log("Seed OK"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
