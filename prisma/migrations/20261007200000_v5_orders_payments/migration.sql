-- ═════════════════════════════════════════════
-- v5 : précommande, commande et paiement Bitcoin (jalon 4). Décisions Hugo, roadmap :
--   « Réservation et paiement tardif », « Écarts de paiement, remboursements et accaparement »,
--   « Décisions du jalon 3 », « Décisions du jalon 4 ».
--   * paiements tracés un par un (Payment, append-only), montant attendu en sats sur la facture,
--     appoint (facture en attente de complément), excédent remboursé ;
--   * remboursements typés (annulation de lignes, rabais, excédent), au prorata de ce qui a été
--     reçu pour une facture payée ; frais réseau à la charge de la boutique (tracés à part) ;
--   * priorité d'un jour à l'ouverture des précommandes pour les utilisateurs ayant une wishlist
--     non retirée ; ensuite premier arrivé, premier servi ;
--   * garde-fou anti-accaparement (valeurs réglables dans ShopSettings) : une seule facture en
--     attente vivante par utilisateur et par lot, 10 machines au plus par facture, 5 minutes après
--     une facture expirée impayée avant d'en créer une autre ;
--   * plafond de wishlists par utilisateur et par lot imposé par la base (ShopSettings) ;
--   * on ne supprime jamais une facture, une ligne, un paiement ni une adresse de paiement ;
--   * Configuration.updated_at (dernière modification), maintenue par la base.
-- Convention inchangée : chaque erreur de trigger porte `(constraint "Nom")` dans son message.
-- Aucune donnée supprimée : payment_reference et received_sats deviennent des lignes Payment.
-- ═════════════════════════════════════════════

-- ─── Contrôle préalable (échec explicite plutôt qu'un montant inventé) ───
-- Le montant attendu en sats n'est connu que pour les factures déjà payées (received_sats).
-- Une facture impayée antérieure à v5 n'a ni taux ni montant BTC : aucune valeur juste n'existe.
-- Le jalon 4 n'a jamais été déployé : ces factures sont des données de dev/test. Remède :
-- `npm run db:reset` (dev), ou les rembourser/solder puis relancer la migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Order" WHERE "received_sats" IS NULL OR "payment_address" IS NULL) THEN
    RAISE EXCEPTION 'v5: unpaid orders or orders without payment address exist; no expected BTC amount can be derived. Reset the dev database (npm run db:reset).';
  END IF;
END;
$$;

-- CreateEnum
CREATE TYPE "refund_kind" AS ENUM ('cancellation', 'discount', 'overpayment');

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "wishlist_max_per_user_per_batch" INTEGER NOT NULL DEFAULT 5,
    "order_max_lines" INTEGER NOT NULL DEFAULT 10,
    "expired_order_cooldown_minutes" INTEGER NOT NULL DEFAULT 5,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "amount_sats" BIGINT NOT NULL,
    "txid" TEXT NOT NULL,
    "vout" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_order_id_received_at_idx" ON "Payment"("order_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_txid_vout_key" ON "Payment"("txid", "vout");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "expected_sats" BIGINT;
ALTER TABLE "Refund" ADD COLUMN "kind" "refund_kind";
ALTER TABLE "Refund" ADD COLUMN "network_fee_sats" BIGINT;
ALTER TABLE "Configuration" ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- DropIndex / CreateIndex : (user_id, expires_at) sert les garde-fous (facture vivante, délai) et
-- remplace l'index sur user_id seul.
DROP INDEX "Order_user_id_idx";
CREATE INDEX "Order_user_id_expires_at_idx" ON "Order"("user_id", "expires_at");

-- CreateIndex : une wishlist au plus une fois par facture (les NULL ne comptent pas)
CREATE UNIQUE INDEX "OrderLine_order_id_wishlist_id_key" ON "OrderLine"("order_id", "wishlist_id");

-- ─── Reprise des données (triggers des tables concernées suspendus) ───
ALTER TABLE "Order" DISABLE TRIGGER USER;
ALTER TABLE "Refund" DISABLE TRIGGER USER;
ALTER TABLE "Configuration" DISABLE TRIGGER USER;

-- Facture payée avant v5 : le montant reçu valait paiement intégral.
UPDATE "Order" SET "expected_sats" = "received_sats";
-- Le paiement reçu devient une ligne du journal des paiements (txid = ancienne référence).
INSERT INTO "Payment" ("order_id", "amount_sats", "txid", "vout", "received_at")
SELECT o."id", o."received_sats",
       coalesce(nullif(btrim(o."payment_reference"), ''), 'legacy-' || o."id"::text),
       (row_number() OVER (PARTITION BY coalesce(nullif(btrim(o."payment_reference"), ''), 'legacy-' || o."id"::text)
                           ORDER BY o."created_at", o."id") - 1)::integer,
       coalesce(o."paid_at", o."updated_at")
FROM "Order" o
WHERE o."received_sats" IS NOT NULL;
-- Remboursements : lignes liées = annulation, sinon rabais (aucun excédent n'existait avant v5).
UPDATE "Refund" r SET "kind" = CASE
  WHEN EXISTS (SELECT 1 FROM "OrderLine" l WHERE l."refund_id" = r."id") THEN 'cancellation'::"refund_kind"
  ELSE 'discount'::"refund_kind" END;
UPDATE "Configuration" SET "updated_at" = "created_at";

ALTER TABLE "Order" ENABLE TRIGGER USER;
ALTER TABLE "Refund" ENABLE TRIGGER USER;
ALTER TABLE "Configuration" ENABLE TRIGGER USER;

ALTER TABLE "Order" ALTER COLUMN "expected_sats" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "payment_address" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "received_sats" SET DEFAULT 0;
ALTER TABLE "Order" ALTER COLUMN "received_sats" SET NOT NULL;
ALTER TABLE "Order" DROP COLUMN "payment_reference";
ALTER TABLE "Refund" ALTER COLUMN "kind" SET NOT NULL;

-- Réglages : une seule ligne, valeurs par défaut des décisions du jalon 4 et du jalon 3.
INSERT INTO "ShopSettings" DEFAULT VALUES;

-- ═════════════════════════════════════════════
-- Raw SQL v5
-- ═════════════════════════════════════════════

-- ─── CHECK ────────────────────────────────────

ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_single_row_check" CHECK ("id" = 1);
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_wishlist_max_check"
  CHECK ("wishlist_max_per_user_per_batch" BETWEEN 1 AND 1000);
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_order_max_lines_check"
  CHECK ("order_max_lines" BETWEEN 1 AND 1000);
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_cooldown_check"
  CHECK ("expired_order_cooldown_minutes" BETWEEN 0 AND 1440);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_sats_check" CHECK ("amount_sats" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_txid_check" CHECK (btrim("txid") <> '');
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_vout_check" CHECK ("vout" >= 0);

-- Facture : montant attendu en sats (taux figé à la création), montant reçu = somme des
-- paiements (tenu par la base). paid = payée intégralement (appoint compris). paid_at = passage à
-- paid ; un paiement refusé faute de place (remboursé) n'a pas de paid_at.
ALTER TABLE "Order" DROP CONSTRAINT "Order_payment_received_check";
ALTER TABLE "Order" DROP CONSTRAINT "Order_payment_address_check";
ALTER TABLE "Order" DROP CONSTRAINT "Order_received_sats_check";
ALTER TABLE "Order" DROP CONSTRAINT "Order_status_dates_check";
ALTER TABLE "Order" ADD CONSTRAINT "Order_expected_sats_check" CHECK ("expected_sats" > 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_received_sats_check" CHECK ("received_sats" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_paid_in_full_check"
  CHECK ("status" <> 'paid' OR "received_sats" >= "expected_sats");
ALTER TABLE "Order" ADD CONSTRAINT "Order_refunded_payment_check"
  CHECK ("status" <> 'refunded' OR "received_sats" > 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_address_check" CHECK (btrim("payment_address") <> '');
ALTER TABLE "Order" ADD CONSTRAINT "Order_status_dates_check" CHECK (
  CASE "status"
    WHEN 'pending_payment' THEN "paid_at" IS NULL AND "expired_at" IS NULL AND "refunded_at" IS NULL
    WHEN 'expired'         THEN "paid_at" IS NULL AND "expired_at" IS NOT NULL AND "refunded_at" IS NULL
    WHEN 'paid'            THEN "paid_at" IS NOT NULL AND "refunded_at" IS NULL
    WHEN 'refunded'        THEN "refunded_at" IS NOT NULL
  END);

-- Remboursement : excédent (overpayment) = 0 € (des sats reçus en trop, rien de la facture) ;
-- annulation et rabais > 0 €. Frais réseau à la charge de la boutique : tracés, jamais déduits.
ALTER TABLE "Refund" DROP CONSTRAINT "Refund_amount_check";
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_kind_check" CHECK (("kind" = 'overpayment') = ("amount" = 0));
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_network_fee_sats_check" CHECK ("network_fee_sats" >= 0);

-- ─── Utilitaires ──────────────────────────────

CREATE FUNCTION "raise_never_deleted"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is never deleted (constraint "%_no_delete")', TG_TABLE_NAME, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Réglages de la boutique (une ligne, créée par cette migration, jamais supprimée).
CREATE FUNCTION "shop_settings"() RETURNS "ShopSettings"
LANGUAGE plpgsql STABLE AS $$
DECLARE
  s "ShopSettings";
BEGIN
  SELECT * INTO s FROM "ShopSettings" WHERE "id" = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ShopSettings row is missing (constraint "ShopSettings_required")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ShopSettings_required';
  END IF;
  RETURN s;
END;
$$;

CREATE TRIGGER "ShopSettings_no_delete"
  BEFORE DELETE ON "ShopSettings"
  FOR EACH ROW EXECUTE FUNCTION "raise_never_deleted"();

-- Statuts d'un lot : commandes acceptées (création d'une facture, passage à paid) et visibilité
-- publique (sondage + commandes ouvertes). Source unique pour les triggers et src/server/shop.ts.
CREATE FUNCTION "batch_accepts_orders"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st NOT IN ('draft', 'survey', 'closed', 'cancelled')
$$;

CREATE FUNCTION "batch_is_public"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st = 'survey' OR "batch_accepts_orders"(st)
$$;

-- ─── Priorité à l'ouverture des précommandes ───
-- Fin de la journée de priorité : première ouverture des précommandes + 1 jour, pour un lot passé
-- par le sondage. NULL : pas de priorité (lot ouvert sans sondage, specs « personne ne sera
-- prioritaire », ou précommandes pas encore ouvertes).
CREATE FUNCTION "batch_priority_ends_at"(b uuid) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT min(p."created_at") + interval '1 day'
  FROM "BatchStatusTransition" p
  WHERE p."batch_id" = b AND p."to_status" = 'preorder'
    AND EXISTS (SELECT 1 FROM "BatchStatusTransition" s WHERE s."batch_id" = b AND s."to_status" = 'survey')
$$;

-- Utilisateur prioritaire sur un lot : au moins une wishlist non retirée. Retirer ses wishlists
-- après l'ouverture fait perdre la priorité (décision 2026-10-07) ; une facture déjà créée garde
-- son statut (rien n'est vérifié au paiement).
CREATE FUNCTION "user_has_batch_priority"(b uuid, u uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "Wishlist" WHERE "batch_id" = b AND "user_id" = u AND "cancelled_at" IS NULL)
$$;

-- L'utilisateur peut-il créer une facture sur ce lot maintenant ? (hors journée de priorité, ou prioritaire)
CREATE FUNCTION "order_priority_allows"(b uuid, u uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(now() >= "batch_priority_ends_at"(b), true) OR "user_has_batch_priority"(b, u)
$$;

-- ─── Factures ───

-- Création : pending_payment, rien reçu, réservation <= 30 min, lot ouvert aux commandes, priorité.
-- Garde-fous anti-accaparement (ShopSettings), seulement pour une facture qui réserve vraiment
-- (expires_at > now()) :
--   * Order_one_live_per_user_batch : aucune autre facture en attente vivante du même utilisateur
--     sur ce lot ;
--   * Order_expired_cooldown : aucune facture impayée de l'utilisateur (tous lots) expirée depuis
--     moins de expired_order_cooldown_minutes.
-- Verrou de l'utilisateur (FOR NO KEY UPDATE, comme la création de wishlists) : deux créations
-- simultanées du même utilisateur se suivent, la seconde relit les factures validées. Ce verrou
-- couvre la règle « par utilisateur et par lot » sans sérialiser les autres clients du lot (le
-- verrou du lot reste pris au COMMIT pour le stock). Ordre des verrous : utilisateur, puis lot.
-- Mises à jour : champs figés (facture, montants, adresse de paiement) ; received_sats seulement
-- par un Payment, jamais en baisse ; transitions de statut (inchangées sauf le remboursement :
-- un paiement incomplet peut toujours être remboursé).
CREATE OR REPLACE FUNCTION "Order_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bst "batch_status";
  s "ShopSettings";
BEGIN
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = NEW."batch_id";

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending_payment' OR NEW."received_sats" <> 0 THEN
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
      RAISE EXCEPTION 'Batch %: preorders are reserved until % to users with a wishlist (constraint "Order_priority_window")',
        NEW."batch_id", "batch_priority_ends_at"(NEW."batch_id")
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_priority_window';
    END IF;
    IF NEW."expires_at" > now() THEN
      s := "shop_settings"();
      IF EXISTS (
        SELECT 1 FROM "Order" o
        WHERE o."user_id" = NEW."user_id" AND o."batch_id" = NEW."batch_id" AND o."id" <> NEW."id"
          AND o."status" = 'pending_payment' AND o."expires_at" > now()
      ) THEN
        RAISE EXCEPTION 'User % already has a pending order on batch % (constraint "Order_one_live_per_user_batch")', NEW."user_id", NEW."batch_id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_one_live_per_user_batch';
      END IF;
      IF EXISTS (
        SELECT 1 FROM "Order" o
        WHERE o."user_id" = NEW."user_id" AND o."id" <> NEW."id"
          AND o."status" IN ('pending_payment', 'expired') AND o."received_sats" < o."expected_sats"
          AND o."expires_at" <= now()
          AND o."expires_at" > now() - make_interval(mins => s."expired_order_cooldown_minutes")
      ) THEN
        RAISE EXCEPTION 'User % let an order expire less than % minutes ago (constraint "Order_expired_cooldown")', NEW."user_id", s."expired_order_cooldown_minutes"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_expired_cooldown';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."user_id", NEW."batch_id", NEW."payment_method", NEW."created_at", NEW."expires_at",
      NEW."total_amount", NEW."expected_sats", NEW."payment_address")
     IS DISTINCT FROM (OLD."id", OLD."user_id", OLD."batch_id", OLD."payment_method", OLD."created_at", OLD."expires_at",
      OLD."total_amount", OLD."expected_sats", OLD."payment_address")
     OR (OLD."paid_at" IS NOT NULL AND NEW."paid_at" IS DISTINCT FROM OLD."paid_at")
     OR (OLD."refunded_at" IS NOT NULL AND NEW."refunded_at" IS DISTINCT FROM OLD."refunded_at") THEN
    RAISE EXCEPTION 'Order %: immutable field changed (constraint "Order_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_immutable';
  END IF;
  -- received_sats = somme des paiements : seul Payment_apply (trigger imbriqué) l'augmente
  IF NEW."received_sats" IS DISTINCT FROM OLD."received_sats"
     AND (pg_trigger_depth() < 2 OR NEW."received_sats" < OLD."received_sats") THEN
    RAISE EXCEPTION 'Order %: received_sats changes only by inserting a Payment (constraint "Order_received_via_payment")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_received_via_payment';
  END IF;

  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) NOT IN (
    'pending_payment>paid', 'pending_payment>expired', 'pending_payment>refunded',
    'expired>paid', 'expired>refunded', 'paid>refunded'
  ) THEN
    RAISE EXCEPTION 'Order %: transition % -> % not allowed (constraint "Order_status_transition")', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_status_transition';
  END IF;
  IF NEW."status" = 'expired' AND OLD."expires_at" > now() THEN
    RAISE EXCEPTION 'Order % has not expired yet (constraint "Order_expired_early")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_expired_early';
  END IF;
  IF NEW."status" = 'paid' AND NOT coalesce("batch_accepts_orders"(bst), false) THEN
    RAISE EXCEPTION 'Batch % does not accept orders in its current status (constraint "Order_batch_open")', NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_batch_open';
  END IF;
  -- Un paiement complet reçu alors qu'il reste de la place (réservation vivante, ou paiement
  -- tardif qui tient dans le stock) doit être accepté. Un paiement incomplet (appoint jamais
  -- venu) ou un lot clos/abandonné se rembourse.
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

-- Une facture n'est jamais supprimée (son adresse de paiement reste supervisée).
CREATE TRIGGER "Order_no_delete"
  BEFORE DELETE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION "raise_never_deleted"();

-- Lignes : jamais supprimées (on rembourse) ; ajoutées seulement à la création de la facture
-- (total_amount et expected_sats sont figés : une ligne ajoutée ensuite casse Order_total) ;
-- wishlist liée non retirée ; au plus order_max_lines lignes par facture (ShopSettings, à
-- l'insertion seulement : baisser le réglage ne bloque pas les factures existantes).
CREATE OR REPLACE FUNCTION "OrderLine_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st "order_status";
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

  IF (NEW."order_id", NEW."user_id", NEW."batch_id", NEW."configuration_id", NEW."wishlist_id", NEW."amount", NEW."created_at")
     IS DISTINCT FROM (OLD."order_id", OLD."user_id", OLD."batch_id", OLD."configuration_id", OLD."wishlist_id", OLD."amount", OLD."created_at") THEN
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

-- ─── Paiements ───
-- Journal append-only des paiements reçus sur l'adresse d'une facture (service maison, simulé au
-- jalon 4). Un paiement n'est JAMAIS refusé par la base, quel que soit l'état de la facture ou du
-- lot : l'argent reçu est tracé, puis accepté (paid) ou remboursé. L'insertion ajoute le montant à
-- Order.received_sats (verrou de la ligne Order : deux paiements simultanés s'additionnent).
CREATE TRIGGER "Payment_append_only"
  BEFORE UPDATE OR DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

CREATE FUNCTION "Payment_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Order" SET "received_sats" = "received_sats" + NEW."amount_sats", "updated_at" = now()
  WHERE "id" = NEW."order_id";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Payment_apply"
  AFTER INSERT ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION "Payment_apply"();

-- ─── Remboursements ───

-- Sats à rembourser pour un remboursement partiel (annulation de lignes, rabais) de `amount`
-- centimes sur une facture payée : prorata de ce qui a été reçu pour la marchandise
-- (expected_sats ; l'excédent se rembourse à part), arrondi au sat le plus proche sur le cumul,
-- moins ce qui a déjà été remboursé au prorata. Source unique pour le domaine et Refund_prorata.
CREATE FUNCTION "refund_prorata_sats"(oid uuid, amount bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT (round(o."expected_sats"::numeric * (coalesce(r."cents", 0) + amount) / o."total_amount"))::bigint
         - coalesce(r."sats", 0)
  FROM "Order" o
  LEFT JOIN (
    SELECT "order_id", sum("amount") AS "cents", sum("amount_sats") AS "sats"
    FROM "Refund" WHERE "order_id" = oid AND "kind" <> 'overpayment' GROUP BY "order_id"
  ) r ON r."order_id" = o."id"
  WHERE o."id" = oid
$$;

CREATE OR REPLACE FUNCTION "Refund_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund is never deleted (constraint "Refund_append_only")'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'Refund_append_only';
  END IF;
  IF NEW."order_id" <> OLD."order_id" OR NEW."kind" <> OLD."kind"
     OR (OLD."sent_at" IS NOT NULL AND (NEW."amount", NEW."amount_sats") IS DISTINCT FROM (OLD."amount", OLD."amount_sats")) THEN
    RAISE EXCEPTION 'Refund %: immutable field changed (constraint "Refund_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- Cohérence d'une facture (différé). Ajouts v5 : nature des remboursements, prorata, excédent.
-- Rien ici ne dépend d'une hausse de received_sats : un paiement n'est jamais refusé.
--   Order_refunds        annulations + rabais <= total facturé ; tous remboursements (sats) <= reçu ;
--                        une annulation couvre ses lignes, ou tout ce qui reste de la facture ;
--   Refund_kind_lines    annulation <=> au moins une ligne liée ; rabais et excédent sans ligne ;
--   Refund_prorata       facture payée : sats des annulations + rabais = prorata du montant attendu
--                        (arrondi inférieur ou supérieur du cumul, refund_prorata_sats) ;
--   Refund_overpayment   facture payée : excédent remboursé <= reçu - attendu.
-- Le remboursement intégral (refunded) est contrôlé au passage de statut (Order_refunded_in_full).
CREATE OR REPLACE FUNCTION "Order_check"(oid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  n_lines integer;
  n_active integer;
  s_lines bigint;
  s_cents bigint;
  s_prorata_sats bigint;
  s_over_sats bigint;
  exact numeric;
BEGIN
  SELECT * INTO o FROM "Order" WHERE "id" = oid;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM "Batch_lock"(o."batch_id"); -- conversion concurrente d'une même wishlist

  SELECT count(*), count(*) FILTER (WHERE "refund_id" IS NULL), coalesce(sum("amount"), 0)
  INTO n_lines, n_active, s_lines
  FROM "OrderLine" WHERE "order_id" = oid;
  SELECT coalesce(sum("amount") FILTER (WHERE "kind" <> 'overpayment'), 0),
         coalesce(sum("amount_sats") FILTER (WHERE "kind" <> 'overpayment'), 0),
         coalesce(sum("amount_sats") FILTER (WHERE "kind" = 'overpayment'), 0)
  INTO s_cents, s_prorata_sats, s_over_sats
  FROM "Refund" WHERE "order_id" = oid;

  IF n_lines = 0 THEN
    RAISE EXCEPTION 'Order % has no line (constraint "Order_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_lines';
  END IF;
  IF s_lines <> o."total_amount" THEN
    RAISE EXCEPTION 'Order %: total_amount % <> sum of lines % (constraint "Order_total")', oid, o."total_amount", s_lines
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_total';
  END IF;
  IF o."status" IN ('pending_payment', 'expired') AND (
       n_active <> n_lines OR s_prorata_sats + s_over_sats > 0
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
  IF s_cents > o."total_amount" OR s_prorata_sats + s_over_sats > o."received_sats" THEN
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
  IF o."status" = 'paid' THEN
    exact := o."expected_sats"::numeric * s_cents / o."total_amount";
    IF s_prorata_sats < floor(exact) OR s_prorata_sats > ceil(exact) THEN
      RAISE EXCEPTION 'Order %: partial refunds total % sats, prorata of what was paid is % (constraint "Refund_prorata")', oid, s_prorata_sats, round(exact, 2)
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_prorata';
    END IF;
    IF s_over_sats > o."received_sats" - o."expected_sats" THEN
      RAISE EXCEPTION 'Order %: overpayment refunds exceed the sats received beyond the expected amount (constraint "Refund_overpayment")', oid
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_overpayment';
    END IF;
  END IF;
  -- Prix de ligne = prix de sa configuration (snapshot)
  IF EXISTS (
    SELECT 1 FROM "OrderLine" l JOIN "Configuration" c ON c."id" = l."configuration_id"
    WHERE l."order_id" = oid
      AND l."amount" <> c."base_price"
        + (SELECT coalesce(sum(ci."unit_price"), 0) FROM "ConfigurationItem" ci WHERE ci."configuration_id" = c."id")
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

-- Remboursement intégral : au passage à refunded, tout ce qui a été reçu est renvoyé (sats,
-- sans conversion). Un paiement arrivé ensuite sur l'adresse n'est pas refusé : il apparaît dans
-- order_payment_balance.refund_due_sats et se rembourse (excédent).
CREATE FUNCTION "Order_check_refunded_in_full"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  received bigint;
  refunded bigint;
BEGIN
  SELECT o."received_sats", coalesce((SELECT sum(r."amount_sats") FROM "Refund" r WHERE r."order_id" = o."id"), 0)
  INTO received, refunded
  FROM "Order" o WHERE o."id" = NEW."id";
  IF refunded <> received THEN
    RAISE EXCEPTION 'Refunded order %: refunds % sats <> received % sats (constraint "Order_refunded_in_full")', NEW."id", refunded, received
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunded_in_full';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_refunded_in_full"
  AFTER UPDATE OF "status" ON "Order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'refunded' AND OLD."status" <> 'refunded')
  EXECUTE FUNCTION "Order_check_refunded_in_full"();

-- Solde de paiement d'une facture (calculé à la lecture, jamais stocké) :
--   outstanding_sats  appoint attendu (facture en attente ou expirée) ;
--   refunded_sats     tout ce qui a été remboursé ;
--   refund_due_sats   ce qu'il faut encore renvoyer : excédent d'une facture payée, paiement reçu
--                     après un remboursement intégral, ou sats reçus sur une facture impayée d'un
--                     lot clos ou abandonné ;
--   awaiting_decision paiement complet sur une facture encore impayée : à accepter (paid) s'il
--                     reste de la place, sinon à rembourser (Order_fits_stock).
CREATE VIEW "order_payment_balance" AS
SELECT
  o."id" AS "order_id",
  o."batch_id",
  o."user_id",
  o."status",
  o."expected_sats",
  o."received_sats",
  coalesce(r."all_sats", 0)::bigint AS "refunded_sats",
  CASE WHEN o."status" IN ('pending_payment', 'expired')
       THEN greatest(o."expected_sats" - o."received_sats", 0) ELSE 0 END::bigint AS "outstanding_sats",
  CASE
    WHEN o."status" = 'paid' THEN greatest(o."received_sats" - o."expected_sats" - coalesce(r."over_sats", 0), 0)
    WHEN o."status" = 'refunded' THEN o."received_sats" - coalesce(r."all_sats", 0)
    WHEN NOT "batch_accepts_orders"(b."status") THEN o."received_sats" - coalesce(r."all_sats", 0)
    ELSE 0
  END::bigint AS "refund_due_sats",
  (o."status" IN ('pending_payment', 'expired') AND o."received_sats" >= o."expected_sats") AS "awaiting_decision"
FROM "Order" o
JOIN "Batch" b ON b."id" = o."batch_id"
LEFT JOIN (
  SELECT "order_id", sum("amount_sats") AS "all_sats",
         sum("amount_sats") FILTER (WHERE "kind" = 'overpayment') AS "over_sats"
  FROM "Refund" GROUP BY "order_id"
) r ON r."order_id" = o."id";

-- ─── Wishlist : plafond par utilisateur et par lot ───
-- Wishlists non retirées d'un utilisateur sur un lot <= least(ShopSettings.wishlist_max_per_user_per_batch,
-- Batch.quantity), à la création ou à la réactivation. Verrou de l'utilisateur (FOR NO KEY UPDATE,
-- comme src/server/wishlists.ts) : deux créations simultanées se suivent. Nommé pour s'exécuter
-- avant Wishlist_guard_batch (ordre alphabétique) : utilisateur, puis lot, comme les factures.
CREATE FUNCTION "Wishlist_check_cap"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  n integer;
BEGIN
  IF NEW."cancelled_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."batch_id" = OLD."batch_id" AND NEW."user_id" = OLD."user_id"
     AND OLD."cancelled_at" IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "User" WHERE "id" = NEW."user_id" FOR NO KEY UPDATE;
  SELECT least(("shop_settings"())."wishlist_max_per_user_per_batch", b."quantity") INTO cap
  FROM "Batch" b WHERE b."id" = NEW."batch_id";
  SELECT count(*) INTO n FROM "Wishlist"
  WHERE "user_id" = NEW."user_id" AND "batch_id" = NEW."batch_id" AND "cancelled_at" IS NULL AND "id" <> NEW."id";
  IF n + 1 > cap THEN
    RAISE EXCEPTION 'User % already has % wishlists on batch % (cap %) (constraint "Wishlist_cap")', NEW."user_id", n, NEW."batch_id", cap
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Wishlist_cap';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Wishlist_cap"
  BEFORE INSERT OR UPDATE OF "batch_id", "user_id", "cancelled_at" ON "Wishlist"
  FOR EACH ROW EXECUTE FUNCTION "Wishlist_check_cap"();

-- ─── Configuration : date de dernière modification ───
-- updated_at suit tout changement de choix : item ajouté, modifié ou retiré (choix de
-- l'utilisateur, masquage d'un menu, complétion à la publication) et prix de base. Une
-- configuration verrouillée (ligne de commande) ne change plus. Une seule écriture par transaction.
CREATE FUNCTION "Configuration_set_updated_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."base_price" IS DISTINCT FROM OLD."base_price" THEN
    NEW."updated_at" := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Configuration_set_updated_at"
  BEFORE UPDATE OF "base_price" ON "Configuration"
  FOR EACH ROW EXECUTE FUNCTION "Configuration_set_updated_at"();

CREATE FUNCTION "ConfigurationItem_touch"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Configuration" SET "updated_at" = now()
  WHERE "id" IN (
      CASE TG_OP WHEN 'INSERT' THEN NULL ELSE OLD."configuration_id" END,
      CASE TG_OP WHEN 'DELETE' THEN NULL ELSE NEW."configuration_id" END)
    AND "locked_at" IS NULL AND "updated_at" < now();
  RETURN NULL;
END;
$$;

CREATE TRIGGER "ConfigurationItem_touch"
  AFTER INSERT OR UPDATE OR DELETE ON "ConfigurationItem"
  FOR EACH ROW EXECUTE FUNCTION "ConfigurationItem_touch"();
