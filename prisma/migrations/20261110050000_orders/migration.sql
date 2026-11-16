-- ═════════════════════════════════════════════
-- Utilisateurs, adresses, factures (Order), lignes (OrderLine), paiements (Payment).
-- Décisions Hugo, roadmap : « Réservation et paiement tardif », « Écarts de paiement, remboursements
-- et accaparement », décisions des jalons 3 et 4, « Jalon L ».
--   * Une facture réserve le stock 30 minutes au plus (horloge de la base). Paiements tracés un par
--     un (Payment, ajout seul) ; un paiement n'est jamais refusé : l'argent reçu est tracé, puis
--     accepté (paid) ou remboursé. Montant attendu en sats sur la facture, appoint possible.
--   * On ne supprime jamais une facture, une ligne, un paiement ni une adresse de paiement.
--   * Journée de priorité à l'ouverture des précommandes, limitée au nombre de wishlists actives de
--     l'utilisateur sur le lot ; ensuite premier arrivé, premier servi.
--   * Garde-fous anti-accaparement (valeurs dans ShopSettings), par utilisateur et par lot : une seule
--     facture en attente vivante ; order_max_lines machines au plus par facture ; délai après tout
--     abandon (annulation, sauf par la fermeture du lot, expiration, remboursement d'un paiement
--     partiel) ; blocage temporaire quand les abandons et renoncements atteignent un plafond dans une
--     fenêtre glissante. Le blocage expire
--     seul (calculé à la lecture, sans job) ; l'admin peut le lever avant (OrderBlockRelease).
--   * Statut cancelled : facture en attente impayée annulée (réservation libérée tout de suite) ; sa
--     cause (Order.cancel_reason) est posée par la base. Un paiement arrivé ensuite relève de l'admin.
--   * E-mail du client figé sur la facture (Order.contact_email), copié du profil s'il n'est pas fourni.
--   * Classer sans suite (OrderExcessDismissal, ajout seul) : sats reçus non affectés, au plus égaux aux
--     frais réseau d'un remboursement, une fois par facture ; ils sortent du solde.
--   * Vente manuelle (jalon R5, décisions Hugo 2026-11-11) : une facture du canal manual (saisie par l'admin, tracée :
--     created_by_auth_user_id, manual_reason) est payée hors chaîne (payment_method offchain : espèces, virement,
--     autre), en centimes (received_cents, Payment.amount_cents), sans adresse Bitcoin ni montant en sats. Elle naît
--     payée : créée pending_payment, payée et acceptée dans la même transaction (create_manual_sale), contrôlé au COMMIT
--     (Order_manual_paid). Mêmes règles que la boutique : lot ouvert, stock (Batch_stock), une facture vivante,
--     délai et blocage (l'admin lève le blocage, tracé, pour vendre quand même). Le canal et le moyen sont liés
--     (Order_method_check) ; Payment et Refund recopient le moyen de la facture (clé étrangère composite).
--   * Client sans compte : User sans auth_user_id, créé par l'admin (created_by_auth_user_id) ; ses adresses et
--     factures sont celles de tout client. Un compte peut lui être rattaché une fois (auth_user_id NULL → valeur).
-- Ordre des verrous : utilisateur, puis facture(s), ligne(s), machine(s), lot.
-- Remboursements et solde de paiement : refunds. Contrôle du stock : stock.
-- ═════════════════════════════════════════════

-- ─── Contraintes CHECK et index hors Prisma ───

-- User
-- Identifiants auth-service : auth.users.id, BIGINT auto-incrémenté. NULL : client sans compte (vente manuelle).
ALTER TABLE "User" ADD CONSTRAINT "User_auth_user_id_check" CHECK ("auth_user_id" > 0);

ALTER TABLE "User" ADD CONSTRAINT "User_created_by_check" CHECK ("created_by_auth_user_id" > 0);

-- Un client a un compte (auth-service), ou a été créé par un admin (client sans compte de la vente manuelle)
ALTER TABLE "User" ADD CONSTRAINT "User_account_check"
  CHECK ("auth_user_id" IS NOT NULL OR "created_by_auth_user_id" IS NOT NULL);

-- Même format que Order.contact_email (Order_contact_email_check)
ALTER TABLE "User" ADD CONSTRAINT "User_email_check" CHECK (
  "email" IS NULL OR (
    char_length("email") <= 254
    AND "email" ~ '^[^[:space:]@]+@[^[:space:]@.]+(\.[^[:space:]@.]+)+$'));

-- Address
ALTER TABLE "Address" ADD CONSTRAINT "Address_country_check" CHECK ("country" ~ '^[A-Z]{2}$');

-- Order
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_amount_check" CHECK ("total_amount" > 0);

-- Réservation : une facture en attente réserve le stock 30 minutes au plus (roadmap,
-- « Réservation et paiement tardif »). L'horloge de référence est celle de la base :
-- expires_at vaut par défaut now() + 30 min (à omettre côté application), ne peut pas
-- dépasser now() + 30 min à l'insertion et est immuable ensuite (Order_guard).
ALTER TABLE "Order" ADD CONSTRAINT "Order_expires_at_check" CHECK ("expires_at" > "created_at");

ALTER TABLE "Order" ADD CONSTRAINT "Order_expected_sats_check" CHECK ("expected_sats" > 0);

ALTER TABLE "Order" ADD CONSTRAINT "Order_received_sats_check" CHECK ("received_sats" >= 0);

-- Hors chaîne : l'admin enregistre ce qu'il encaisse, jamais plus que le total (pas d'excédent hors chaîne)
ALTER TABLE "Order" ADD CONSTRAINT "Order_received_cents_check"
  CHECK ("received_cents" >= 0 AND "received_cents" <= "total_amount");

-- Payée : tout le montant attendu est reçu, en sats (bitcoin) ou en centimes (offchain)
ALTER TABLE "Order" ADD CONSTRAINT "Order_paid_in_full_check"
  CHECK ("status" <> 'paid' OR CASE "payment_method"
                                  WHEN 'bitcoin' THEN "received_sats" >= "expected_sats"
                                  ELSE "received_cents" >= "total_amount" END);

ALTER TABLE "Order" ADD CONSTRAINT "Order_refunded_payment_check"
  CHECK ("status" <> 'refunded' OR "received_sats" > 0 OR "received_cents" > 0);

-- Canal : tunnel de la boutique (online) ou vente saisie par l'admin (manual : admin et motif tracés)
ALTER TABLE "Order" ADD CONSTRAINT "Order_channel_check" CHECK (coalesce(
  CASE "channel"
    WHEN 'online' THEN "created_by_auth_user_id" IS NULL AND "manual_reason" IS NULL
    WHEN 'manual' THEN "created_by_auth_user_id" > 0 AND btrim("manual_reason") <> ''
  END, false));

-- Moyen de paiement, lié au canal (décision Hugo 2026-11-11 : vente manuelle = paiement hors chaîne) :
--   bitcoin  : boutique en ligne ; adresse de paiement et montant en sats ; rien en centimes ;
--   offchain : vente manuelle ; ni adresse de paiement, ni sats, ni adresse de remboursement Bitcoin.
ALTER TABLE "Order" ADD CONSTRAINT "Order_method_check" CHECK (coalesce(
  CASE "payment_method"
    WHEN 'bitcoin'  THEN "channel" = 'online' AND "payment_address" IS NOT NULL AND "expected_sats" IS NOT NULL
                         AND "received_cents" = 0
    WHEN 'offchain' THEN "channel" = 'manual' AND "payment_address" IS NULL AND "expected_sats" IS NULL
                         AND "refund_address" IS NULL AND "received_sats" = 0
  END, false));

ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_address_check" CHECK (btrim("payment_address") <> '');

ALTER TABLE "Order" ADD CONSTRAINT "Order_status_dates_check" CHECK (
  CASE "status"
    WHEN 'pending_payment' THEN "paid_at" IS NULL AND "expired_at" IS NULL AND "refunded_at" IS NULL AND "cancelled_at" IS NULL
    WHEN 'expired'         THEN "paid_at" IS NULL AND "expired_at" IS NOT NULL AND "refunded_at" IS NULL AND "cancelled_at" IS NULL
    WHEN 'cancelled'       THEN "paid_at" IS NULL AND "expired_at" IS NULL AND "refunded_at" IS NULL AND "cancelled_at" IS NOT NULL
    WHEN 'paid'            THEN "paid_at" IS NOT NULL AND "refunded_at" IS NULL
    WHEN 'refunded'        THEN "refunded_at" IS NOT NULL
  END);

-- Format raisonnable, sans vérification par envoi : une partie locale, un @, un domaine à au moins deux
-- libellés non vides, aucun espace, 254 caractères au plus (RFC 5321). Casse conservée telle que saisie.
ALTER TABLE "Order" ADD CONSTRAINT "Order_contact_email_check" CHECK (
  "contact_email" IS NULL OR (
    char_length("contact_email") <= 254
    AND "contact_email" ~ '^[^[:space:]@]+@[^[:space:]@.]+(\.[^[:space:]@.]+)+$'));

-- Renseignée <=> la facture a été annulée (cancelled_at, immuable une fois posé ; obligatoire pour cancelled,
-- Order_status_dates_check). Conservée après cancelled → paid | refunded, comme cancelled_at.
ALTER TABLE "Order" ADD CONSTRAINT "Order_cancel_reason_check" CHECK (("cancel_reason" IS NULL) = ("cancelled_at" IS NULL));

-- OrderLine
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_amount_check" CHECK ("amount" >= 0);

ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_position_check" CHECK ("position" >= 1);

-- Payment
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_sats_check" CHECK ("amount_sats" > 0);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_txid_check" CHECK (btrim("txid") <> '');

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_vout_check" CHECK ("vout" >= 0);

-- Champs du moyen (method, recopié de la facture par Payment_stamp, clé étrangère composite) :
--   bitcoin  : sortie de transaction (amount_sats, txid, vout) ; rien de hors chaîne ;
--   offchain : centimes encaissés, catégorie (espèces, virement, autre), admin qui l'enregistre ; référence libre
--              (n° de virement, reçu…), obligatoire pour « autre » (elle dit lequel).
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_method_check" CHECK (coalesce(
  CASE "method"
    WHEN 'bitcoin'  THEN "amount_sats" IS NOT NULL AND "txid" IS NOT NULL AND "vout" IS NOT NULL
                         AND "amount_cents" IS NULL AND "offchain_means" IS NULL AND "reference" IS NULL
                         AND "recorded_by_auth_user_id" IS NULL
    WHEN 'offchain' THEN "amount_sats" IS NULL AND "txid" IS NULL AND "vout" IS NULL
                         AND "amount_cents" > 0 AND "offchain_means" IS NOT NULL AND "recorded_by_auth_user_id" > 0
                         AND ("offchain_means" <> 'other' OR "reference" IS NOT NULL)
  END, false));

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reference_check" CHECK (btrim("reference") <> '');

-- OrderBlockRelease
ALTER TABLE "OrderBlockRelease" ADD CONSTRAINT "OrderBlockRelease_released_by_check" CHECK ("released_by_auth_user_id" > 0);

ALTER TABLE "OrderBlockRelease" ADD CONSTRAINT "OrderBlockRelease_reason_check" CHECK (btrim("reason") <> '');

-- OrderExcessDismissal
ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_sats_check" CHECK ("sats" > 0);

ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_network_fee_sats_check" CHECK ("network_fee_sats" > 0);

-- Rendre la somme coûterait au moins autant qu'elle vaut : seulement si elle ne dépasse pas les frais
ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_within_fee_check" CHECK ("sats" <= "network_fee_sats");

ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_reason_check" CHECK (btrim("reason") <> '');

ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_dismissed_by_check" CHECK ("dismissed_by_auth_user_id" > 0);

-- ─── Adresses : figées dès qu'une commande les référence ───
CREATE FUNCTION "Address_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."user_id", NEW."full_name", NEW."company", NEW."line1", NEW."line2", NEW."postal_code", NEW."city", NEW."country", NEW."phone")
     IS DISTINCT FROM (OLD."user_id", OLD."full_name", OLD."company", OLD."line1", OLD."line2", OLD."postal_code", OLD."city", OLD."country", OLD."phone")
     AND EXISTS (SELECT 1 FROM "Order" WHERE "billing_address_id" = OLD."id" OR "shipping_address_id" = OLD."id") THEN
    RAISE EXCEPTION 'Address % is used by an order: create a new address and archive this one (constraint "Address_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Address_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Address_guard"
  BEFORE UPDATE ON "Address"
  FOR EACH ROW EXECUTE FUNCTION "Address_guard"();

-- ─── Client : compte rattaché une seule fois ───
-- Client sans compte (vente manuelle) : un compte peut lui être rattaché (NULL → valeur), puis il ne change plus.
-- L'admin qui l'a créé ne change jamais.
CREATE FUNCTION "User_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."auth_user_id" IS NOT NULL AND NEW."auth_user_id" IS DISTINCT FROM OLD."auth_user_id" THEN
    RAISE EXCEPTION 'User %: the account of a customer never changes once linked (constraint "User_auth_link")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'User_auth_link';
  END IF;
  IF NEW."created_by_auth_user_id" IS DISTINCT FROM OLD."created_by_auth_user_id" THEN
    RAISE EXCEPTION 'User %: immutable field changed (constraint "User_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'User_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "User_guard"
  BEFORE UPDATE OF "auth_user_id", "created_by_auth_user_id" ON "User"
  FOR EACH ROW EXECUTE FUNCTION "User_guard"();

-- ─── Une seule définition de « la facture occupe le stock » ───
-- Payée, ou en attente non expirée (réservation de 30 min, horloge de la base). Utilisée par
-- le trigger de stock (batch_stock_lines) et par la demande ferme en produits d'options.
CREATE FUNCTION "order_holds_stock"(st "order_status", expires timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT st = 'paid' OR (st = 'pending_payment' AND expires > now())
$$;

-- ─── Journée de priorité ───

-- Machines auxquelles l'utilisateur a droit en priorité : ses wishlists actives sur le lot (une
-- wishlist convertie reste active : elle compte, et la ligne qui la convertit aussi).
CREATE FUNCTION "user_priority_quota"(b uuid, u uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM "Wishlist" WHERE "batch_id" = b AND "user_id" = u AND "cancelled_at" IS NULL
$$;

-- Machines de l'utilisateur qui occupent le stock du lot : lignes non remboursées des factures payées
-- ou en attente non expirées (order_holds_stock).
CREATE FUNCTION "user_batch_held_lines"(b uuid, u uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer
  FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
  WHERE l."batch_id" = b AND l."user_id" = u AND l."refund_id" IS NULL
    AND "order_holds_stock"(o."status", o."expires_at")
$$;

-- Machines que l'utilisateur peut encore commander maintenant pendant la journée de priorité
-- (quota − machines déjà prises, borné à 0). NULL hors journée de priorité : pas de limite de
-- priorité (les autres garde-fous s'appliquent). Pour l'UI : « vous pouvez encore prendre N machines ».
CREATE FUNCTION "order_priority_machines_left"(b uuid, u uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN coalesce(now() < "batch_priority_ends_at"(b), false)
              THEN greatest("user_priority_quota"(b, u) - "user_batch_held_lines"(b, u), 0) END
$$;

-- L'utilisateur peut-il créer une facture sur ce lot maintenant ? (hors journée, ou quota non épuisé)
CREATE FUNCTION "order_priority_allows"(b uuid, u uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce("order_priority_machines_left"(b, u) > 0, true)
$$;

-- ─── Factures abandonnées, délai et blocage ───

-- Instant où la facture a été abandonnée, NULL si elle ne l'est pas (vivante, payée, ou payée
-- intégralement sans être acceptée : paiement tardif sans place, que la boutique rembourse).
--   * paid, ou paid_at posé (payée puis remboursée) : pas un abandon ;
--   * annulée par la fermeture du lot aux commandes (cancel_reason batch_closed : pause d'un lot de stock, lot
--     annulé, en transit ou clos) : geste de la boutique, pas un abandon du client (R4b), même si un paiement est
--     arrivé ensuite et a été remboursé ;
--   * annulée par l'admin (cancel_reason admin) : geste de la boutique, jamais un abandon du client (décision de
--     Hugo, 2026-11-16), même si un paiement est arrivé ensuite et a été remboursé ;
--   * annulée par l'utilisateur (cancel_reason user), même si un paiement est arrivé ensuite, tant que l'admin ne
--     l'a pas acceptée : cancelled_at ;
--   * reçu >= attendu : l'utilisateur a payé, pas un abandon ;
--   * remboursée (frais à sa charge, avant ou après l'expiration ; ou par l'admin) : le premier de
--     expires_at et refunded_at ;
--   * en attente ou expirée, réservation terminée, reçu < attendu (rien ou appoint manquant) : expires_at.
-- Un appoint qui complète puis fait accepter la facture (paid) efface l'abandon.
CREATE FUNCTION "order_abandoned_at"(o "Order") RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN o."status" = 'paid' OR o."paid_at" IS NOT NULL THEN NULL
    WHEN o."cancelled_at" IS NOT NULL THEN CASE WHEN o."cancel_reason" = 'user' THEN o."cancelled_at" END
    WHEN o."received_sats" >= o."expected_sats" THEN NULL
    WHEN o."status" = 'refunded' THEN least(o."expires_at", o."refunded_at")
    WHEN o."expires_at" <= now() THEN o."expires_at"
  END
$$;

-- Dernière levée de blocage de l'admin pour cet utilisateur sur ce lot (NULL : jamais).
CREATE FUNCTION "order_block_released_at"(b uuid, u uuid) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT max("created_at") FROM "OrderBlockRelease" WHERE "batch_id" = b AND "user_id" = u
$$;

-- Abandons qui comptent : ceux de l'utilisateur sur le lot postérieurs à la dernière levée.
CREATE FUNCTION "user_batch_abandoned_orders"(b uuid, u uuid)
RETURNS TABLE ("order_id" uuid, "abandoned_at" timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT o."id", a."at"
  FROM "Order" o
  CROSS JOIN LATERAL (SELECT "order_abandoned_at"(o) AS "at") a
  WHERE o."user_id" = u AND o."batch_id" = b AND a."at" IS NOT NULL
    AND a."at" > coalesce("order_block_released_at"(b, u), '-infinity'::timestamptz)
$$;

-- Fin du délai après le dernier abandon (NULL : pas de délai en cours).
CREATE FUNCTION "user_batch_cooldown_ends_at"(b uuid, u uuid) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN x."ends" > now() THEN x."ends" END
  FROM (
    SELECT max(a."abandoned_at") + make_interval(mins => ("shop_settings"())."abandoned_order_cooldown_minutes") AS "ends"
    FROM "user_batch_abandoned_orders"(b, u) a
  ) x
$$;

-- Événements qui comptent pour le blocage d'un utilisateur sur un lot, postérieurs à la dernière levée de l'admin :
-- abandons (user_batch_abandoned_orders, qui applique déjà la levée) et renoncements (un par remboursement de lignes
-- user_renounce, daté par la base : Refund.created_at, immuable).
CREATE FUNCTION "user_batch_block_events"(b uuid, u uuid)
RETURNS TABLE ("order_id" uuid, "at" timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT a."order_id", a."abandoned_at" FROM "user_batch_abandoned_orders"(b, u) a
  UNION ALL
  SELECT r."order_id", r."created_at"
  FROM "Refund" r JOIN "Order" o ON o."id" = r."order_id"
  WHERE o."user_id" = u AND o."batch_id" = b AND r."cause" = 'user_renounce' AND r."kind" = 'cancellation'
    AND r."created_at" > coalesce("order_block_released_at"(b, u), '-infinity'::timestamptz)
$$;

-- Blocage en cours (au plus une ligne) : début = instant de l'événement qui atteint abandoned_order_limit
-- événements dans la fenêtre glissante ; fin = début + order_block_duration_hours. Les blocages se succèdent dans
-- l'ordre : un blocage terminé efface les événements jusqu'à son début (inclus), le compte reprend avec les
-- suivants. Aucune ligne : pas bloqué maintenant (horloge de la base).
CREATE FUNCTION "user_batch_block"(b uuid, u uuid)
RETURNS TABLE ("blocked_at" timestamptz, "ends_at" timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  s "ShopSettings" := "shop_settings"();
  win interval := make_interval(hours => s."abandoned_order_window_hours");
  dur interval := make_interval(hours => s."order_block_duration_hours");
  ev timestamptz[];
  n integer;
  lo integer := 1;
  k integer := 1;
BEGIN
  SELECT coalesce(array_agg(e."at" ORDER BY e."at"), '{}')
  INTO ev FROM "user_batch_block_events"(b, u) e;
  n := cardinality(ev);
  WHILE k <= n LOOP
    -- Fenêtre (ev[k] - win, ev[k]] parmi les événements qui comptent encore (indices >= lo)
    WHILE ev[lo] <= ev[k] - win LOOP
      lo := lo + 1;
    END LOOP;
    IF k - lo + 1 >= s."abandoned_order_limit" THEN
      IF ev[k] + dur > now() THEN
        "blocked_at" := ev[k];
        "ends_at" := ev[k] + dur;
        RETURN NEXT;
        RETURN;
      END IF;
      -- Blocage terminé : les événements jusqu'à son début (mêmes instants compris) ne comptent plus
      WHILE k < n AND ev[k + 1] = ev[k] LOOP
        k := k + 1;
      END LOOP;
      lo := k + 1;
    END IF;
    k := k + 1;
  END LOOP;
END;
$$;

-- Fin du blocage en cours, levée automatique (NULL : pas bloqué). Lue par Order_guard ; le backend lit
-- user_batch_block (début et fin).
CREATE FUNCTION "user_batch_block_ends_at"(b uuid, u uuid) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT "ends_at" FROM "user_batch_block"(b, u)
$$;

-- Blocages en cours sur un lot ouvert aux commandes (backoffice : lever avant l'échéance ou laisser expirer).
-- abandoned_orders compte abandons et renoncements depuis la dernière levée de l'admin.
-- Toute paire utilisateur-lot qui a une facture est examinée : un renoncement porte sur une facture payée.
CREATE VIEW "order_creation_blocks" AS
SELECT p."user_id", p."batch_id", x."blocked_at",
       (SELECT count(*) FROM "user_batch_block_events"(p."batch_id", p."user_id"))::integer AS "abandoned_orders",
       "order_block_released_at"(p."batch_id", p."user_id") AS "last_released_at",
       x."ends_at" AS "block_ends_at"
FROM (
  SELECT DISTINCT o."user_id", o."batch_id"
  FROM "Order" o JOIN "Batch" ba ON ba."id" = o."batch_id"
  WHERE coalesce("batch_accepts_orders"(ba."status"), false)
) p
CROSS JOIN LATERAL "user_batch_block"(p."batch_id", p."user_id") x;

-- ─── Factures ───

-- Création : pending_payment, rien reçu, réservation <= 30 min, lot ouvert aux commandes. Verrou de
-- l'utilisateur (FOR NO KEY UPDATE, comme la création de wishlists) : deux créations simultanées du
-- même utilisateur se suivent, la seconde relit les factures validées, sans sérialiser les autres
-- clients du lot (le verrou du lot reste pris au COMMIT pour le stock). Puis, dans cet ordre :
--   * Order_priority_window : pendant la journée de priorité, quota de machines non épuisé (le nombre
--     de lignes est contrôlé ligne par ligne, OrderLine_priority_quota) ;
--   * Order_one_live_per_user_batch (facture qui réserve, expires_at > now()) : aucune autre facture en
--     attente vivante du même utilisateur sur ce lot ;
--   * Order_abandoned_limit (toute création, même déjà expirée) : blocage en cours, dont la fin est
--     donnée dans le message (user_batch_block_ends_at) ;
--   * Order_abandoned_cooldown (facture qui réserve) : délai après le dernier abandon.
-- Aucune exception pour le canal manual : une vente saisie par l'admin passe par les mêmes contrôles.
-- Mises à jour : champs figés (facture, canal, montants, adresse de paiement) ; received_sats et received_cents
-- seulement par un Payment, jamais en baisse ; transitions de statut :
--   pending_payment > paid       paiement reçu (réservation vivante, ou tardif s'il reste de la place : Order_stock)
--   pending_payment > expired    seulement une fois expires_at dépassé (statut d'affichage : le stock lit l'horloge)
--   pending_payment > cancelled  annulation, rien reçu (Order_cancel_unpaid), réservation encore vivante
--                                (Order_cancel_expired : une facture expirée n'a plus rien à libérer, et l'annuler
--                                contournerait le délai)
--   pending_payment | expired > refunded   paiement incomplet, tardif sans place, ou lot fermé aux commandes
--   expired > paid               paiement tardif qui tient dans le stock
--   paid > refunded              annulation de toute la facture, surplus de commandes (les dernières payées d'abord)
--   cancelled > paid | refunded  paiement arrivé après l'annulation, décision de l'admin (aucune obligation
--                                d'accepter, contrairement à Order_late_payment_refund) ; paid exige toujours un
--                                lot ouvert aux commandes et la place (Order_batch_open, Batch_stock).
-- cancelled_at et refunded_at sont posés par la base au passage de statut, puis immuables ; cancel_reason
-- est posée au passage à cancelled (user par défaut ; batch_closed réservé au trigger de transition du lot,
-- pg_trigger_depth() >= 2 ; admin donné par l'écrivain), puis immuable (Order_immutable). Les deux sont
-- conservées si la facture annulée est ensuite acceptée ou remboursée.
CREATE FUNCTION "Order_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bst "batch_status";
  t timestamptz;
BEGIN
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = NEW."batch_id";

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending_payment' OR NEW."received_sats" <> 0 OR NEW."received_cents" <> 0 THEN
      RAISE EXCEPTION 'An order is created as pending_payment with nothing received (constraint "Order_created_pending")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_created_pending';
    END IF;
    IF NEW."expires_at" > now() + interval '30 minutes' THEN
      RAISE EXCEPTION 'An order reserves stock for 30 minutes at most (constraint "Order_reservation_length")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_reservation_length';
    END IF;
    IF NOT coalesce("batch_accepts_orders"(bst), false) THEN
      RAISE EXCEPTION 'Batch % does not accept orders in its current status (constraint "Order_batch_open")', NEW."batch_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_batch_open';
    END IF;

    PERFORM 1 FROM "User" WHERE "id" = NEW."user_id" FOR NO KEY UPDATE;
    IF NOT "order_priority_allows"(NEW."batch_id", NEW."user_id") THEN
      RAISE EXCEPTION 'Batch %: until % preorders are reserved to users with wishlists, within their number of wishlists (constraint "Order_priority_window")',
        NEW."batch_id", "batch_priority_ends_at"(NEW."batch_id")
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_priority_window';
    END IF;
    IF NEW."expires_at" > now() AND EXISTS (
      SELECT 1 FROM "Order" o
      WHERE o."user_id" = NEW."user_id" AND o."batch_id" = NEW."batch_id" AND o."id" <> NEW."id"
        AND o."status" = 'pending_payment' AND o."expires_at" > now()
    ) THEN
      RAISE EXCEPTION 'User % already has a pending order on batch % (constraint "Order_one_live_per_user_batch")', NEW."user_id", NEW."batch_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_one_live_per_user_batch';
    END IF;
    t := "user_batch_block_ends_at"(NEW."batch_id", NEW."user_id");
    IF t IS NOT NULL THEN
      RAISE EXCEPTION 'User % reached the limit of abandoned or renounced orders on batch %: no new order before % (constraint "Order_abandoned_limit")',
        NEW."user_id", NEW."batch_id", t
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_abandoned_limit';
    END IF;
    IF NEW."expires_at" > now() THEN
      t := "user_batch_cooldown_ends_at"(NEW."batch_id", NEW."user_id");
      IF t IS NOT NULL THEN
        RAISE EXCEPTION 'User % abandoned an order on batch % recently: wait until % (constraint "Order_abandoned_cooldown")',
          NEW."user_id", NEW."batch_id", t
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_abandoned_cooldown';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Dates d'annulation et de remboursement, cause de l'annulation : posées par la base (la valeur fournie pour
  -- les dates est remplacée). cancelled_at date les abandons (délai, plafond) : début de transaction, comme
  -- avant. refunded_at : horloge prise sous le verrou de la ligne, comparée à Payment.received_at.
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status" = 'cancelled' THEN
      NEW."cancelled_at" := now();
      NEW."cancel_reason" := coalesce(NEW."cancel_reason", 'user');
      IF NEW."cancel_reason" = 'batch_closed' AND pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'Order %: only the transition of its batch to a status closed to orders cancels it as batch_closed (constraint "Order_cancel_reason_batch_closed")', OLD."id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_cancel_reason_batch_closed';
      END IF;
    ELSIF NEW."status" = 'refunded' THEN
      NEW."refunded_at" := clock_timestamp();
    END IF;
  END IF;

  IF (NEW."id", NEW."user_id", NEW."batch_id", NEW."payment_method", NEW."created_at", NEW."expires_at",
      NEW."total_amount", NEW."expected_sats", NEW."payment_address",
      NEW."channel", NEW."created_by_auth_user_id", NEW."manual_reason")
     IS DISTINCT FROM (OLD."id", OLD."user_id", OLD."batch_id", OLD."payment_method", OLD."created_at", OLD."expires_at",
      OLD."total_amount", OLD."expected_sats", OLD."payment_address",
      OLD."channel", OLD."created_by_auth_user_id", OLD."manual_reason")
     OR (OLD."paid_at" IS NOT NULL AND NEW."paid_at" IS DISTINCT FROM OLD."paid_at")
     OR (OLD."refunded_at" IS NOT NULL AND NEW."refunded_at" IS DISTINCT FROM OLD."refunded_at")
     OR (NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
         AND (OLD."cancelled_at" IS NOT NULL OR NEW."status" <> 'cancelled'))
     OR (NEW."cancel_reason" IS DISTINCT FROM OLD."cancel_reason"
         AND (OLD."cancel_reason" IS NOT NULL OR NEW."status" <> 'cancelled' OR OLD."status" = 'cancelled')) THEN
    RAISE EXCEPTION 'Order %: immutable field changed (constraint "Order_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_immutable';
  END IF;
  -- received_sats, received_cents = somme des paiements : seul Payment_apply (trigger imbriqué) les augmente
  IF (NEW."received_sats", NEW."received_cents") IS DISTINCT FROM (OLD."received_sats", OLD."received_cents")
     AND (pg_trigger_depth() < 2 OR NEW."received_sats" < OLD."received_sats" OR NEW."received_cents" < OLD."received_cents") THEN
    RAISE EXCEPTION 'Order %: received_sats and received_cents change only by inserting a Payment (constraint "Order_received_via_payment")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_received_via_payment';
  END IF;

  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) NOT IN (
    'pending_payment>paid', 'pending_payment>expired', 'pending_payment>refunded', 'pending_payment>cancelled',
    'expired>paid', 'expired>refunded', 'paid>refunded', 'cancelled>paid', 'cancelled>refunded'
  ) THEN
    RAISE EXCEPTION 'Order %: transition % -> % not allowed (constraint "Order_status_transition")', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_status_transition';
  END IF;
  IF NEW."status" = 'expired' AND OLD."expires_at" > now() THEN
    RAISE EXCEPTION 'Order % has not expired yet (constraint "Order_expired_early")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_expired_early';
  END IF;
  -- Annulation volontaire : OLD est la dernière version validée (ligne verrouillée par l'UPDATE) ;
  -- un paiement validé avant l'annulation la fait donc échouer. Avec un paiement partiel, le chemin
  -- est le remboursement (frais à la charge de l'utilisateur, Refund_user_fee_allowed).
  IF NEW."status" = 'cancelled' AND (OLD."received_sats" > 0 OR OLD."received_cents" > 0) THEN
    RAISE EXCEPTION 'Order %: a payment was received, it cannot be cancelled: request a refund instead (constraint "Order_cancel_unpaid")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_cancel_unpaid';
  END IF;
  IF NEW."status" = 'cancelled' AND OLD."expires_at" <= now() THEN
    RAISE EXCEPTION 'Order % has already expired: nothing left to cancel (constraint "Order_cancel_expired")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_cancel_expired';
  END IF;
  IF NEW."status" = 'paid' AND NOT coalesce("batch_accepts_orders"(bst), false) THEN
    RAISE EXCEPTION 'Batch % does not accept orders in its current status (constraint "Order_batch_open")', NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_batch_open';
  END IF;
  -- Un paiement complet reçu alors qu'il reste de la place (réservation vivante, ou paiement
  -- tardif qui tient dans le stock) doit être accepté. Un paiement incomplet (remboursement choisi
  -- par l'utilisateur, avant ou après l'expiration), un lot fermé aux commandes ou une facture
  -- annulée (décision de l'admin) se remboursent.
  IF NEW."status" = 'refunded' AND OLD."status" IN ('pending_payment', 'expired')
     AND coalesce("batch_accepts_orders"(bst), false)
     AND OLD."received_sats" >= OLD."expected_sats"
     AND (OLD."expires_at" > now() OR "Order_fits_stock"(OLD."id")) THEN
    RAISE EXCEPTION 'Order %: a payment received while stock remains must be accepted (constraint "Order_late_payment_refund")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_late_payment_refund';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_guard"
  BEFORE INSERT OR UPDATE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION "Order_guard"();

-- E-mail de contact obligatoire à la création d'une facture (pas pour la wishlist) : instantané fourni,
-- sinon copié du profil (User.email) ; aucun des deux : refus. Contrôle à l'insertion seulement : les
-- factures plus anciennes sans e-mail ne sont pas touchées. Le backend résout l'e-mail avant d'écrire
-- (422 contact_email_required) et mémorise sur le profil un e-mail saisi qui en diffère.
CREATE FUNCTION "Order_check_contact_email"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."contact_email" IS NULL THEN
    SELECT "email" INTO NEW."contact_email" FROM "User" WHERE "id" = NEW."user_id";
  END IF;
  IF NEW."contact_email" IS NULL THEN
    RAISE EXCEPTION 'An order is created with the contact e-mail of the customer, given or from the profile (constraint "Order_contact_email_required")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_contact_email_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_contact_email_required" BEFORE INSERT ON "Order"
FOR EACH ROW EXECUTE FUNCTION "Order_check_contact_email"();

-- Instantané : à qui l'on écrit pour cette facture. Jamais modifié une fois posé ; une facture sans
-- e-mail (créée avant la règle) peut en recevoir un, une fois (reprise par l'admin après contact).
CREATE FUNCTION "Order_guard_contact_email"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."contact_email" IS NOT NULL AND NEW."contact_email" IS DISTINCT FROM OLD."contact_email" THEN
    RAISE EXCEPTION 'Order %: the contact e-mail of an order never changes (constraint "Order_contact_email_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_contact_email_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_contact_email_frozen" BEFORE UPDATE OF "contact_email" ON "Order"
FOR EACH ROW EXECUTE FUNCTION "Order_guard_contact_email"();

-- Une facture annulée dont le versement a été classé sans suite n'est plus acceptée (cancelled → paid) :
-- les sats classés ne paieraient pas la commande. Seul chemin vers paid depuis un état classable.
CREATE FUNCTION "Order_guard_dismissed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "OrderExcessDismissal" WHERE "order_id" = OLD."id") THEN
    RAISE EXCEPTION 'Order %: sats received on it were dismissed, it can no longer be accepted (constraint "Order_dismissed_final")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_dismissed_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_dismissed_final" BEFORE UPDATE OF "status" ON "Order"
FOR EACH ROW WHEN (NEW."status" = 'paid' AND OLD."status" <> 'paid')
EXECUTE FUNCTION "Order_guard_dismissed"();

-- ─── Lignes ───

-- Lignes : jamais supprimées (on rembourse) ; ajoutées seulement à la création de la facture
-- (total_amount et expected_sats sont figés : une ligne ajoutée ensuite casse Order_total) ; wishlist
-- liée non retirée ; au plus order_max_lines lignes par facture (ShopSettings, à l'insertion seulement :
-- baisser le réglage ne bloque pas les factures existantes) ; pendant la journée de priorité, les
-- machines de l'utilisateur qui occupent le stock du lot, lignes de cette facture comprises, ne
-- dépassent pas ses wishlists actives (OrderLine_priority_quota). L'insertion verrouille la configuration.
-- Les lignes de la même instruction déjà insérées sont visibles ici (trigger BEFORE ROW) ; les factures
-- concurrentes du même utilisateur attendent le verrou de l'utilisateur (Order_guard).
-- position := dernière position de la facture + 1 (valeur fournie ignorée) : un createMany numérote dans
-- l'ordre de ses valeurs ; lignes jamais supprimées, donc pas de trou. Ensuite seuls machine_id (via
-- OrderLineAssignment) et refund_id (une fois) évoluent.
CREATE FUNCTION "OrderLine_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st "order_status";
  quota integer;
  used integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An order line is never deleted: refund it (constraint "OrderLine_no_delete")'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'OrderLine_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO st FROM "Order" WHERE "id" = NEW."order_id";
    IF st IS DISTINCT FROM 'pending_payment' THEN
      RAISE EXCEPTION 'Order lines can only be added while the order is pending_payment (constraint "OrderLine_frozen")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_frozen';
    END IF;
    IF NEW."machine_id" IS NOT NULL OR NEW."refund_id" IS NOT NULL THEN
      RAISE EXCEPTION 'A new order line has no machine and no refund (constraint "OrderLine_new")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_new';
    END IF;
    IF NEW."wishlist_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "Wishlist" WHERE "id" = NEW."wishlist_id" AND "cancelled_at" IS NULL
    ) THEN
      RAISE EXCEPTION 'Wishlist % is withdrawn: it cannot be ordered (constraint "OrderLine_wishlist_live")', NEW."wishlist_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_wishlist_live';
    END IF;
    IF (SELECT count(*) FROM "OrderLine" WHERE "order_id" = NEW."order_id") >= ("shop_settings"())."order_max_lines" THEN
      RAISE EXCEPTION 'Order % has reached the maximum number of machines per order (constraint "Order_max_lines")', NEW."order_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_max_lines';
    END IF;
    NEW."position" := (SELECT coalesce(max("position"), 0) + 1 FROM "OrderLine" WHERE "order_id" = NEW."order_id");
    IF coalesce(now() < "batch_priority_ends_at"(NEW."batch_id"), false) THEN
      quota := "user_priority_quota"(NEW."batch_id", NEW."user_id");
      SELECT count(*) INTO used
      FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
      WHERE l."batch_id" = NEW."batch_id" AND l."user_id" = NEW."user_id" AND l."refund_id" IS NULL
        AND ("order_holds_stock"(o."status", o."expires_at") OR l."order_id" = NEW."order_id");
      IF used >= quota THEN
        RAISE EXCEPTION 'User % has % wishlists on batch %: no more machines during the priority window (constraint "OrderLine_priority_quota")',
          NEW."user_id", quota, NEW."batch_id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_priority_quota';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM "Wishlist" WHERE "configuration_id" = NEW."configuration_id") THEN
      RAISE EXCEPTION 'Configuration % belongs to a wishlist: copy it for the order line (constraint "OrderLine_configuration_own")', NEW."configuration_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_configuration_own';
    END IF;
    UPDATE "Configuration" SET "locked_at" = now()
    WHERE "id" = NEW."configuration_id" AND "locked_at" IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Configuration % is already locked, one configuration per line (constraint "OrderLine_configuration_own")', NEW."configuration_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_configuration_own';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."order_id", NEW."user_id", NEW."batch_id", NEW."configuration_id", NEW."wishlist_id", NEW."amount", NEW."created_at", NEW."position")
     IS DISTINCT FROM (OLD."order_id", OLD."user_id", OLD."batch_id", OLD."configuration_id", OLD."wishlist_id", OLD."amount", OLD."created_at", OLD."position") THEN
    RAISE EXCEPTION 'OrderLine % is immutable (constraint "OrderLine_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_frozen';
  END IF;
  IF OLD."refund_id" IS NOT NULL AND NEW."refund_id" IS DISTINCT FROM OLD."refund_id" THEN
    RAISE EXCEPTION 'OrderLine % is already refunded (constraint "OrderLine_refunded_once")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_refunded_once';
  END IF;
  IF NEW."machine_id" IS DISTINCT FROM OLD."machine_id" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'OrderLine.machine_id changes only by inserting an OrderLineAssignment (constraint "OrderLine_machine_via_assignment")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_machine_via_assignment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OrderLine_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "OrderLine"
  FOR EACH ROW EXECUTE FUNCTION "OrderLine_guard"();

-- ─── Paiements ───
-- Journal en ajout seul des paiements. Moyen (method) recopié de la facture (Payment_stamp) : la clé étrangère
-- composite (order_id, method) et Payment_method_check interdisent tout mélange (sortie Bitcoin sur une vente hors
-- chaîne, encaissement hors chaîne sur une facture Bitcoin).
--   * bitcoin : paiement reçu sur l'adresse de la facture. Il n'est JAMAIS refusé par la base, quel que soit l'état
--     de la facture ou du lot : l'argent reçu est tracé, puis accepté (paid) ou remboursé. L'insertion ajoute le
--     montant à Order.received_sats (verrou de la ligne Order : deux paiements simultanés s'additionnent).
--   * offchain : encaissement enregistré par l'admin pendant la création de la vente (facture en attente,
--     Payment_offchain_pending), ajouté à Order.received_cents (jamais au-delà du total, Order_received_cents_check).

-- Date d'un paiement : horloge de la base prise SOUS LE VERROU de la facture (FOR NO KEY UPDATE, le même que
-- celui de Payment_apply, pris un peu plus tôt dans la même transaction : l'ordre des verrous, facture puis
-- lot, est inchangé). La valeur fournie est remplacée. Un paiement validé avant qu'un remboursement verrouille
-- la facture a donc une date antérieure à refunded_at, un paiement appliqué après, une date postérieure.
-- Moyen : celui de la facture (valeur fournie remplacée).
CREATE FUNCTION "Payment_stamp"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o_method "payment_method";
  o_status "order_status";
BEGIN
  SELECT "payment_method", "status" INTO o_method, o_status FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
  NEW."method" := coalesce(o_method, NEW."method"); -- facture inconnue : clé étrangère
  IF NEW."method" = 'offchain' AND o_status IS DISTINCT FROM 'pending_payment' THEN
    RAISE EXCEPTION 'Order % is %: an off-chain payment is recorded with the manual sale it pays (constraint "Payment_offchain_pending")', NEW."order_id", o_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Payment_offchain_pending';
  END IF;
  NEW."received_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Payment_stamp" BEFORE INSERT ON "Payment"
FOR EACH ROW EXECUTE FUNCTION "Payment_stamp"();

CREATE FUNCTION "Payment_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Order"
  SET "received_sats" = "received_sats" + coalesce(NEW."amount_sats", 0),
      "received_cents" = "received_cents" + coalesce(NEW."amount_cents", 0),
      "updated_at" = now()
  WHERE "id" = NEW."order_id";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Payment_apply"
  AFTER INSERT ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION "Payment_apply"();

-- ─── Classer sans suite ───

-- Classement : sous verrou de la facture (comme Payment_apply et les remboursements), la facture est payée,
-- remboursée ou annulée (jamais en attente ou expirée : l'appoint reste possible ou l'utilisateur décide) et
-- `sats` est exactement ce qui reste non affecté (excédent d'une facture payée, sinon reçu − sorti du solde,
-- remboursements non envoyés compris), sats déjà classés retirés (comme order_payment_balance). Un second
-- classement de la même facture : index unique. Un versement arrivé après un classement : rien d'automatique.
CREATE FUNCTION "OrderExcessDismissal_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  debited bigint;
  over_sats bigint;
  dismissed bigint;
  unsettled bigint;
BEGIN
  SELECT * INTO o FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- clé étrangère
  END IF;
  IF o."payment_method" <> 'bitcoin' THEN
    RAISE EXCEPTION 'Order % is paid off-chain: there are no sats to dismiss (constraint "OrderExcessDismissal_bitcoin")', o."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderExcessDismissal_bitcoin';
  END IF;
  IF o."status" NOT IN ('paid', 'refunded', 'cancelled') THEN
    RAISE EXCEPTION 'Order % is %: only the sats left over on a paid, refunded or cancelled order can be dismissed (constraint "OrderExcessDismissal_status")', o."id", o."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderExcessDismissal_status';
  END IF;
  SELECT coalesce(sum("refund_debited_sats"(r)), 0),
         coalesce(sum("refund_debited_sats"(r)) FILTER (WHERE r."kind" = 'overpayment'), 0)
  INTO debited, over_sats
  FROM "Refund" r WHERE r."order_id" = o."id";
  SELECT coalesce(sum("sats"), 0) INTO dismissed FROM "OrderExcessDismissal" WHERE "order_id" = o."id";
  unsettled := CASE WHEN o."status" = 'paid' THEN greatest(o."received_sats" - o."expected_sats" - over_sats - dismissed, 0)
                    ELSE o."received_sats" - debited - dismissed END;
  IF NEW."sats" IS DISTINCT FROM unsettled OR unsettled <= 0 THEN
    RAISE EXCEPTION 'Order %: % sats are left over, not % (constraint "OrderExcessDismissal_amount")', o."id", unsettled, NEW."sats"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderExcessDismissal_amount';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OrderExcessDismissal_check" BEFORE INSERT ON "OrderExcessDismissal"
FOR EACH ROW EXECUTE FUNCTION "OrderExcessDismissal_check"();

-- ─── Cohérence d'une facture (différé) ───
-- Rien ici ne dépend d'une hausse de received_sats : un paiement n'est jamais refusé. Une facture
-- impayée (en attente, expirée, annulée) n'a ni remboursement ni machine.
--   Order_lines, Order_total            au moins une ligne ; total = somme des lignes ;
--   Order_status_lines                  statut cohérent avec les lignes actives ;
--   Order_manual_paid                   vente hors chaîne : payée (ou ensuite remboursée), jamais en attente,
--                                       expirée ni annulée (elle naît payée) ;
--   Order_refunds                       annulations + rabais <= facturé ; sats sortis du solde (brut, frais
--                                       à la charge de l'utilisateur compris, refund_debited_sats) + classés
--                                       sans suite <= reçu ; hors chaîne, centimes remboursés <= centimes reçus ;
--                                       une annulation couvre ses lignes, ou tout ce qui reste de la facture ;
--   Refund_kind_lines                   annulation <=> au moins une ligne liée ; rabais et excédent sans ligne ;
--   Refund_cause_remainder              reliquat d'excédent d'un renoncement seulement pour une facture
--                                       entièrement remboursée ;
--   Refund_prorata                      facture Bitcoin payée : sats bruts des annulations + rabais = prorata du
--                                       montant attendu (arrondi inférieur ou supérieur du cumul). Hors chaîne,
--                                       reçu = total (Order_paid_in_full_check, Order_received_cents_check) : le
--                                       prorata de ce qui a été reçu est le montant lui-même, en centimes ;
--   Refund_overpayment                  facture Bitcoin payée : excédents remboursés (brut) + classés <= reçu − attendu ;
--   OrderLine_amount                    prix de ligne = prix de sa configuration ;
--   OrderLine_wishlist_converted_once   une wishlist convertie en au plus une ligne active payée.
-- Le remboursement intégral (refunded) est contrôlé au passage de statut (Order_refunded_in_full, refunds).
CREATE FUNCTION "Order_check"(oid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  n_lines integer;
  n_active integer;
  s_lines bigint;
  s_cents bigint;
  s_prorata_sats bigint;
  s_over_sats bigint;
  s_debited bigint;
  s_dismissed bigint;
  exact numeric;
BEGIN
  SELECT * INTO o FROM "Order" WHERE "id" = oid;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM "Batch_lock"(o."batch_id"); -- conversion concurrente d'une même wishlist

  SELECT count(*), count(*) FILTER (WHERE "refund_id" IS NULL), coalesce(sum("amount"), 0)
  INTO n_lines, n_active, s_lines
  FROM "OrderLine" WHERE "order_id" = oid;
  SELECT coalesce(sum(r."amount") FILTER (WHERE r."kind" <> 'overpayment'), 0),
         coalesce(sum("refund_debited_sats"(r)) FILTER (WHERE r."kind" <> 'overpayment'), 0),
         coalesce(sum("refund_debited_sats"(r)) FILTER (WHERE r."kind" = 'overpayment'), 0),
         coalesce(sum("refund_debited_sats"(r)), 0)
  INTO s_cents, s_prorata_sats, s_over_sats, s_debited
  FROM "Refund" r WHERE r."order_id" = oid;
  SELECT coalesce(sum("sats"), 0) INTO s_dismissed FROM "OrderExcessDismissal" WHERE "order_id" = oid;

  IF n_lines = 0 THEN
    RAISE EXCEPTION 'Order % has no line (constraint "Order_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_lines';
  END IF;
  IF s_lines <> o."total_amount" THEN
    RAISE EXCEPTION 'Order %: total_amount % <> sum of lines % (constraint "Order_total")', oid, o."total_amount", s_lines
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_total';
  END IF;
  IF o."status" IN ('pending_payment', 'expired', 'cancelled') AND (
       n_active <> n_lines OR s_debited > 0
       OR EXISTS (SELECT 1 FROM "OrderLine" WHERE "order_id" = oid AND "machine_id" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Unpaid order % cannot have refunds or assigned machines (constraint "Order_status_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_status_lines';
  END IF;
  IF o."status" = 'paid' AND n_active = 0 THEN
    RAISE EXCEPTION 'Order %: every line is refunded, status must be refunded (constraint "Order_status_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_status_lines';
  END IF;
  IF o."status" = 'refunded' AND n_active > 0 THEN
    RAISE EXCEPTION 'Refunded order % still has active lines (constraint "Order_status_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_status_lines';
  END IF;
  IF o."payment_method" = 'offchain' AND o."status" NOT IN ('paid', 'refunded') THEN
    RAISE EXCEPTION 'Order %: a manual sale paid off-chain is recorded paid in full in the transaction that creates it (constraint "Order_manual_paid")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_manual_paid';
  END IF;
  -- Plafonds : centimes <= facturé ; sats sortis du solde (brut, frais de l'utilisateur compris) et sats
  -- classés sans suite <= reçu ; hors chaîne, centimes remboursés <= centimes reçus.
  IF s_cents > o."total_amount" OR s_debited + s_dismissed > o."received_sats"
     OR (o."payment_method" = 'offchain' AND s_cents > o."received_cents") THEN
    RAISE EXCEPTION 'Order %: refunds exceed what was paid (constraint "Order_refunds")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunds';
  END IF;
  -- Une annulation rembourse ses lignes en entier, ou tout ce qui reste de la facture (après un rabais)
  IF EXISTS (
    SELECT 1 FROM "Refund" r
    WHERE r."order_id" = oid AND r."kind" = 'cancellation'
      AND r."amount" < least(
        (SELECT coalesce(sum(l."amount"), 0) FROM "OrderLine" l WHERE l."refund_id" = r."id"),
        o."total_amount" - (s_cents - r."amount"))
  ) THEN
    RAISE EXCEPTION 'Order %: a refund is smaller than the lines it cancels (constraint "Order_refunds")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunds';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Refund" r
    WHERE r."order_id" = oid
      AND (r."kind" = 'cancellation') <> EXISTS (SELECT 1 FROM "OrderLine" l WHERE l."refund_id" = r."id")
  ) THEN
    RAISE EXCEPTION 'Order %: a cancellation refund cancels lines, a discount or overpayment refund none (constraint "Refund_kind_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_kind_lines';
  END IF;
  -- Reliquat d'excédent d'un renoncement (sans frais : l'annulation les porte) : seulement quand
  -- toute la facture est remboursée.
  IF o."status" <> 'refunded' AND EXISTS (
    SELECT 1 FROM "Refund" r WHERE r."order_id" = oid AND r."kind" = 'overpayment' AND r."cause" = 'user_renounce'
  ) THEN
    RAISE EXCEPTION 'Order %: the overpayment remainder of a renunciation goes with the cancellation of the whole order (constraint "Refund_cause_remainder")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_cause_remainder';
  END IF;
  IF o."status" = 'paid' AND o."payment_method" = 'bitcoin' THEN
    exact := o."expected_sats"::numeric * s_cents / o."total_amount";
    IF s_prorata_sats < floor(exact) OR s_prorata_sats > ceil(exact) THEN
      RAISE EXCEPTION 'Order %: partial refunds total % sats (gross), prorata of what was paid is % (constraint "Refund_prorata")', oid, s_prorata_sats, round(exact, 2)
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_prorata';
    END IF;
    IF s_over_sats + s_dismissed > o."received_sats" - o."expected_sats" THEN
      RAISE EXCEPTION 'Order %: overpayment refunds (gross) and dismissed sats exceed the sats received beyond the expected amount (constraint "Refund_overpayment")', oid
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_overpayment';
    END IF;
  END IF;
  -- Prix de ligne = prix de sa configuration (snapshot)
  IF EXISTS (
    SELECT 1 FROM "OrderLine" l JOIN "Configuration" c ON c."id" = l."configuration_id"
    WHERE l."order_id" = oid
      AND l."amount" IS DISTINCT FROM "configuration_price"(c."id")
  ) THEN
    RAISE EXCEPTION 'Order %: a line amount differs from its configuration price (constraint "OrderLine_amount")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_amount';
  END IF;
  -- Une wishlist est convertie en au plus une ligne active payée
  IF o."status" = 'paid' AND EXISTS (
    SELECT 1 FROM "OrderLine" l
    WHERE l."order_id" = oid AND l."refund_id" IS NULL AND l."wishlist_id" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "OrderLine" l2 JOIN "Order" o2 ON o2."id" = l2."order_id"
        WHERE l2."wishlist_id" = l."wishlist_id" AND l2."id" <> l."id"
          AND l2."refund_id" IS NULL AND o2."status" = 'paid')
  ) THEN
    RAISE EXCEPTION 'Order %: a wishlist is already converted by another paid line (constraint "OrderLine_wishlist_converted_once")', oid
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'OrderLine_wishlist_converted_once';
  END IF;
END;
$$;

CREATE FUNCTION "trg_check_order"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Order' THEN
    PERFORM "Order_check"(NEW."id");
  ELSE
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM "Order_check"(OLD."order_id"); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM "Order_check"(NEW."order_id"); END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_check" AFTER INSERT OR UPDATE ON "Order"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_order"();

CREATE CONSTRAINT TRIGGER "OrderLine_order_check" AFTER INSERT OR UPDATE OR DELETE ON "OrderLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_order"();

CREATE CONSTRAINT TRIGGER "Refund_order_check" AFTER INSERT OR UPDATE OR DELETE ON "Refund"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_order"();

-- Cohérence de la facture au COMMIT (plafonds avec les remboursements de la même transaction)
CREATE CONSTRAINT TRIGGER "OrderExcessDismissal_order_check" AFTER INSERT ON "OrderExcessDismissal"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_order"();

-- ─── Vente manuelle (backoffice) ───
-- Seul chemin d'écriture d'une vente manuelle : la facture du canal manual, ses lignes, l'encaissement hors chaîne
-- de tout le total et le passage à paid, puis l'attribution des machines données, dans la transaction de l'appelant.
-- Aucune règle n'est ici : les triggers de la boutique s'appliquent tels quels (Order_guard : lot ouvert, journée
-- de priorité, une facture vivante, délai, blocage ; OrderLine_guard ; Payment_stamp ; OrderLineAssignment_apply :
-- machine du lot, vendable depuis le stock, lot au Contrôle ou après pour une palette) et, au COMMIT, Batch_stock
-- (pas de survente entre le comptoir et la boutique), Order_check (prix des lignes = configurations, Order_manual_paid).
-- Ordre des verrous inchangé : utilisateur, facture, ligne(s), machine(s), lot.
--   p_configurations   configurations complètes du lot, prix figés (écrites avant par le domaine, comme pour une
--                      commande en ligne), une par machine, dans l'ordre des lignes ;
--   p_machines         NULL, ou une machine (ou NULL) par configuration, au même rang : attribuée à la ligne ;
--   p_contact_email    NULL : celui du profil (Order_contact_email_required) ;
--   p_reference        référence libre de l'encaissement (obligatoire pour « autre », Payment_method_check).
-- Renvoie l'identifiant de la facture.
CREATE FUNCTION "create_manual_sale"(
  p_user uuid, p_batch uuid, p_billing_address uuid, p_shipping_address uuid, p_contact_email text,
  p_configurations uuid[], p_means "offchain_means", p_reference text, p_reason text, p_admin bigint,
  p_machines uuid[] DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  oid uuid := gen_random_uuid();
  total bigint;
BEGIN
  IF coalesce(cardinality(p_configurations), 0) = 0 THEN
    RAISE EXCEPTION 'A manual sale has at least one line (constraint "Order_lines")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_lines';
  END IF;
  IF p_machines IS NOT NULL AND cardinality(p_machines) <> cardinality(p_configurations) THEN
    RAISE EXCEPTION 'create_manual_sale: one machine (or NULL) per configuration, % given for % lines', cardinality(p_machines), cardinality(p_configurations)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Prix d'une ligne = prix de sa configuration (instantané) ; configuration inconnue : clé étrangère de la ligne
  SELECT coalesce(sum("configuration_price"(u."cid")), 0) INTO total FROM unnest(p_configurations) u("cid");
  INSERT INTO "Order" ("id", "user_id", "batch_id", "billing_address_id", "shipping_address_id", "total_amount",
                       "payment_method", "channel", "created_by_auth_user_id", "manual_reason", "contact_email")
  VALUES (oid, p_user, p_batch, p_billing_address, p_shipping_address, total,
          'offchain', 'manual', p_admin, p_reason, p_contact_email);
  INSERT INTO "OrderLine" ("order_id", "user_id", "batch_id", "configuration_id", "amount")
  SELECT oid, p_user, p_batch, u."cid", coalesce("configuration_price"(u."cid"), 0)
  FROM unnest(p_configurations) WITH ORDINALITY u("cid", "ord")
  ORDER BY u."ord";
  INSERT INTO "Payment" ("order_id", "method", "amount_cents", "offchain_means", "reference", "recorded_by_auth_user_id")
  VALUES (oid, 'offchain', total, p_means, p_reference, p_admin);
  UPDATE "Order" SET "status" = 'paid', "paid_at" = now(), "updated_at" = now() WHERE "id" = oid;

  IF p_machines IS NOT NULL THEN
    INSERT INTO "OrderLineAssignment" ("order_line_id", "batch_id", "machine_id", "changed_by_auth_user_id")
    SELECT l."id", p_batch, m."mid", p_admin
    FROM unnest(p_machines) WITH ORDINALITY m("mid", "ord")
    JOIN "OrderLine" l ON l."order_id" = oid AND l."position" = m."ord"
    WHERE m."mid" IS NOT NULL
    ORDER BY m."ord";
  END IF;
  RETURN oid;
END;
$$;

-- ─── Tables en ajout seul ou jamais supprimées ───

-- Une facture n'est jamais supprimée (son adresse de paiement reste supervisée).
CREATE TRIGGER "Order_no_delete"
  BEFORE DELETE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION "raise_never_deleted"();

CREATE TRIGGER "Payment_append_only"
  BEFORE UPDATE OR DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

-- Levée de blocage par l'admin : chaque ligne efface les événements antérieurs de l'utilisateur sur le
-- lot (ils ne comptent plus ni pour le plafond ni pour le délai). Jamais modifiée ni supprimée.
CREATE TRIGGER "OrderBlockRelease_append_only"
  BEFORE UPDATE OR DELETE ON "OrderBlockRelease"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

CREATE TRIGGER "OrderExcessDismissal_append_only"
  BEFORE UPDATE OR DELETE ON "OrderExcessDismissal"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();
