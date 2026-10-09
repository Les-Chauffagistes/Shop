-- ═════════════════════════════════════════════
-- v5e : remboursements (décisions de Hugo du 2026-10-07, jalon 4).
--   1. Adresse de remboursement mémorisée sur la facture (Order.refund_address, facultative, saisie à la
--      création) : modifiable tant qu'aucun remboursement de la facture n'est envoyé (Order_refund_address_frozen),
--      jamais une adresse de paiement de la boutique (Order_refund_address_ours, CHECK pour la sienne).
--      Adresse effective d'un remboursement non envoyé = coalesce(Refund.destination_address (choix explicite de
--      l'admin), Order.refund_address). Sans adresse effective, le remboursement est « à traiter »
--      (order_payment_balance.refund_address_missing, compris dans needs_admin_attention).
--   2. Envoi d'un remboursement : sent_at (horloge de la base), reference (txid) et sent_by_auth_user_id (admin ;
--      NULL = service de paiement). L'adresse inscrite à l'envoi doit être l'adresse effective lue sous verrou de la
--      facture (Refund_sent_destination) : un changement d'adresse de l'utilisateur pendant que l'admin envoie ne
--      passe pas inaperçu. Une fois envoyé, le remboursement est figé (Refund_sent_frozen). Vue refunds_to_send.
--   3. Initiateur d'un remboursement (Refund.initiated_by : user, admin, system ; admin tracé par
--      created_by_auth_user_id, motif déjà obligatoire). Renoncement de l'utilisateur à une commande payée (lignes
--      ou facture entière), frais réseau à la charge de la boutique, seulement tant que le lot est au plus en
--      Précommande (Refund_user_renounce_window, sous verrou du lot : sérialisé avec les transitions). L'admin
--      annule à tout statut. Un renoncement après paiement n'est pas un abandon (order_abandoned_at inchangé :
--      paid_at posé => NULL).
--   4. L'admin peut rembourser, frais à la charge de l'utilisateur, une facture partiellement payée dont la
--      réservation est terminée (Refund_user_fee_admin_after_expiry), dans les mêmes conditions que le choix de
--      l'utilisateur (Refund_user_fee_allowed, Refund_user_net_positive).
-- Aucune donnée supprimée : colonnes ajoutées (refund_address NULL ; initiated_by reprise des remboursements
-- existants, voir (3)), fonctions et triggers redéfinis, une vue redéfinie (colonnes existantes inchangées, trois
-- ajoutées en fin), une vue et un index ajoutés.
-- Retour arrière (dans l'esprit) : DROP VIEW "refunds_to_send" ; recréer order_payment_balance de v5d (les
-- trois colonnes de fin disparaissent) ; reprendre Refund_guard et Refund_check_user_fee de v5c/v5b ; DROP des
-- triggers Order_refund_address et Refund_user_renounce, de leurs fonctions, de batch_allows_user_renunciation et
-- bitcoin_address_is_ours ; DROP des CHECK ajoutés et de l'index Refund_unsent_created_at_idx. Les colonnes
-- refund_address, initiated_by, created_by_auth_user_id, sent_by_auth_user_id portent des données : les garder
-- (inertes) plutôt que les supprimer.
-- ═════════════════════════════════════════════

CREATE TYPE "refund_initiator" AS ENUM ('user', 'admin', 'system');

-- ─── Fonctions ──────────────────────────────

-- Statuts de lot où l'utilisateur renonce lui-même à une commande payée (jusqu'à Précommande inclus).
-- Une seule fonction à modifier pour déplacer la limite.
CREATE FUNCTION "batch_allows_user_renunciation"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st IN ('draft', 'survey', 'preorder')
$$;

-- Adresse de paiement d'une facture de la boutique (supervisée : un envoi y serait compté comme un paiement).
CREATE FUNCTION "bitcoin_address_is_ours"(addr text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "Order" WHERE "payment_address" = addr)
$$;

-- ─── (1) Adresse de remboursement de la facture ─────

ALTER TABLE "Order" ADD COLUMN "refund_address" TEXT;
-- Format : alphanumérique (base58 ou bech32), 26 à 100 caractères ; jamais l'adresse de paiement de la facture
ALTER TABLE "Order" ADD CONSTRAINT "Order_refund_address_check"
  CHECK ("refund_address" IS NULL OR ("refund_address" ~ '^[A-Za-z0-9]{26,100}$' AND "refund_address" <> "payment_address"));

CREATE FUNCTION "Order_check_refund_address"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."refund_address" IS NOT DISTINCT FROM OLD."refund_address" THEN
      RETURN NEW;
    END IF;
    -- La ligne Order est verrouillée par cet UPDATE ; l'envoi d'un remboursement la verrouille aussi
    -- (Refund_guard) : un envoi validé avant est vu ici, un envoi après voit la nouvelle adresse.
    IF EXISTS (SELECT 1 FROM "Refund" WHERE "order_id" = NEW."id" AND "sent_at" IS NOT NULL) THEN
      RAISE EXCEPTION 'Order %: a refund was already sent, the refund address is frozen (constraint "Order_refund_address_frozen")', NEW."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refund_address_frozen';
    END IF;
  END IF;
  IF NEW."refund_address" IS NOT NULL AND "bitcoin_address_is_ours"(NEW."refund_address") THEN
    RAISE EXCEPTION 'Order %: the refund address is a payment address of the shop (constraint "Order_refund_address_ours")', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refund_address_ours';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_refund_address" BEFORE INSERT OR UPDATE OF "refund_address" ON "Order"
FOR EACH ROW EXECUTE FUNCTION "Order_check_refund_address"();

-- ─── (2)(3) Colonnes du remboursement ───────

ALTER TABLE "Refund" ADD COLUMN "initiated_by" "refund_initiator";
ALTER TABLE "Refund" ADD COLUMN "created_by_auth_user_id" BIGINT;
ALTER TABLE "Refund" ADD COLUMN "sent_by_auth_user_id" BIGINT;

-- Reprise (aucune facture en production avant v5e) : frais à la charge de l'utilisateur = son choix ; rabais =
-- admin ; les deux textes du traitement automatique (src/server/payments.ts) = system ; le reste a été décidé
-- par l'admin, dont l'identifiant n'a pas été tracé (created_by_auth_user_id NULL : le CHECK
-- Refund_admin_traced_check est posé NOT VALID et ne s'impose qu'aux nouvelles écritures).
UPDATE "Refund" SET "initiated_by" = CASE
  WHEN "network_fee_payer" = 'user' THEN 'user'
  WHEN "kind" = 'discount' THEN 'admin'
  WHEN "reason" IN ('Excédent de paiement', 'Paiement reçu après l''expiration de la facture : plus de place sur le lot') THEN 'system'
  ELSE 'admin'
END::"refund_initiator";
ALTER TABLE "Refund" ALTER COLUMN "initiated_by" SET NOT NULL;

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_admin_traced_check"
  CHECK (("initiated_by" = 'admin') = ("created_by_auth_user_id" IS NOT NULL)
         AND ("created_by_auth_user_id" IS NULL OR "created_by_auth_user_id" > 0)) NOT VALID;
-- Rabais : décision humaine (admin). Frais à la charge de l'utilisateur : son choix ou celui de l'admin, jamais un automatisme.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_initiator_check"
  CHECK (("kind" <> 'discount' OR "initiated_by" = 'admin')
         AND ("network_fee_payer" = 'shop' OR "initiated_by" <> 'system'));
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_sent_by_check"
  CHECK ("sent_by_auth_user_id" IS NULL OR ("sent_by_auth_user_id" > 0 AND "sent_at" IS NOT NULL));
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_reference_check"
  CHECK ("reference" IS NULL OR btrim("reference") <> '');
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_destination_address_check"
  CHECK ("destination_address" IS NULL OR "destination_address" ~ '^[A-Za-z0-9]{26,100}$');

-- Remboursements à envoyer (vue refunds_to_send)
CREATE INDEX "Refund_unsent_created_at_idx" ON "Refund"("created_at") WHERE "sent_at" IS NULL;

-- ─── (2) Envoi et immuabilité ───────────────

CREATE OR REPLACE FUNCTION "Refund_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_address text;
  effective text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund is never deleted (constraint "Refund_append_only")'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'Refund_append_only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."order_id", NEW."kind", NEW."network_fee_payer", NEW."initiated_by", NEW."created_by_auth_user_id", NEW."created_at")
       IS DISTINCT FROM (OLD."order_id", OLD."kind", OLD."network_fee_payer", OLD."initiated_by", OLD."created_by_auth_user_id", OLD."created_at") THEN
      RAISE EXCEPTION 'Refund %: immutable field changed (constraint "Refund_immutable")', OLD."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_immutable';
    END IF;
    -- Envoyé : tout est figé (montants, frais, motif, adresse, transaction, date, auteur)
    IF OLD."sent_at" IS NOT NULL AND (
         NEW."amount", NEW."amount_sats", NEW."network_fee_sats", NEW."reason", NEW."destination_address",
         NEW."reference", NEW."sent_at", NEW."sent_by_auth_user_id")
       IS DISTINCT FROM (
         OLD."amount", OLD."amount_sats", OLD."network_fee_sats", OLD."reason", OLD."destination_address",
         OLD."reference", OLD."sent_at", OLD."sent_by_auth_user_id") THEN
      RAISE EXCEPTION 'Refund % was already sent: it cannot change (constraint "Refund_sent_frozen")', OLD."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_sent_frozen';
    END IF;
  END IF;

  IF NEW."destination_address" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."destination_address" IS DISTINCT FROM OLD."destination_address")
     AND "bitcoin_address_is_ours"(NEW."destination_address") THEN
    RAISE EXCEPTION 'Refund of order %: the destination is a payment address of the shop (constraint "Refund_destination_ours")', NEW."order_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_destination_ours';
  END IF;

  -- Envoi : date posée par la base ; adresse inscrite = adresse effective lue sous verrou de la facture
  -- (le changement d'adresse de l'utilisateur prend le même verrou, Order_check_refund_address).
  IF NEW."sent_at" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."sent_at" IS NULL) THEN
    SELECT "refund_address" INTO order_address FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
    IF TG_OP = 'UPDATE' THEN
      effective := coalesce(OLD."destination_address", order_address);
      IF effective IS NOT NULL AND NEW."destination_address" IS DISTINCT FROM effective THEN
        RAISE EXCEPTION 'Refund %: sent to %, but its destination is % (changed meanwhile?) (constraint "Refund_sent_destination")',
          OLD."id", NEW."destination_address", effective
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_sent_destination';
      END IF;
    END IF;
    NEW."sent_at" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "Refund_guard" ON "Refund";
CREATE TRIGGER "Refund_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Refund"
FOR EACH ROW EXECUTE FUNCTION "Refund_guard"();

-- ─── (4) Frais à la charge de l'utilisateur : son choix, ou l'admin après la fin de la réservation ─────

CREATE OR REPLACE FUNCTION "Refund_check_user_fee"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  bst "batch_status";
BEGIN
  IF NEW."network_fee_payer" <> 'user' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO o FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = o."batch_id";
  IF NOT (o."status" IN ('pending_payment', 'expired')
          AND o."received_sats" > 0 AND o."received_sats" < o."expected_sats"
          AND coalesce("batch_accepts_orders"(bst), false)) THEN
    RAISE EXCEPTION 'Order %: network fees are charged to the user only for the refund of a partially paid, unaccepted order of an open batch (constraint "Refund_user_fee_allowed")', NEW."order_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_fee_allowed';
  END IF;
  -- L'admin ne tranche à la place de l'utilisateur qu'une facture dont la réservation est terminée
  -- (awaiting_user_decision) : avant, l'utilisateur peut encore compléter.
  IF NEW."initiated_by" = 'admin' AND o."expires_at" > now() THEN
    RAISE EXCEPTION 'Order %: the reservation is still running, only the user may choose the refund of a partial payment (constraint "Refund_user_fee_admin_after_expiry")', NEW."order_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_fee_admin_after_expiry';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── (3) Renoncement de l'utilisateur à une commande payée ─────

CREATE FUNCTION "Refund_check_renounce"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  bst "batch_status";
BEGIN
  IF NEW."initiated_by" <> 'user' OR NEW."network_fee_payer" <> 'shop' THEN
    RETURN NEW;
  END IF;
  -- Ordre des verrous : facture, puis lot (comme Payment_apply puis Order_fits_stock)
  SELECT * INTO o FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
  IF o."status" <> 'paid' THEN
    RAISE EXCEPTION 'Order % is %: a user renounces only a paid order (constraint "Refund_user_renounce_paid")', NEW."order_id", o."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_renounce_paid';
  END IF;
  -- Verrou du lot (comme Batch_lock) : une transition de statut (FOR UPDATE du lot) attend ce renoncement,
  -- et un renoncement qui suit une transition validée lit le nouveau statut.
  UPDATE "Batch" SET "updated_at" = "updated_at" WHERE "id" = o."batch_id" RETURNING "status" INTO bst;
  IF NOT "batch_allows_user_renunciation"(bst) THEN
    RAISE EXCEPTION 'Batch % is %: after the preorder phase only an admin cancels a paid order (constraint "Refund_user_renounce_window")', o."batch_id", bst
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_renounce_window';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Refund_user_renounce" BEFORE INSERT ON "Refund"
FOR EACH ROW EXECUTE FUNCTION "Refund_check_renounce"();

-- ─── Vues ───────────────────────────────────

-- Colonnes v5d inchangées ; needs_admin_attention inclut refund_address_missing ; trois colonnes en fin :
--   unsent_refund_sats      sats des remboursements créés mais pas encore envoyés ;
--   refund_address_missing  un remboursement non envoyé n'a pas d'adresse effective : contacter l'utilisateur ;
--   user_renounce_allowed   facture payée d'un lot au plus en Précommande : l'utilisateur peut y renoncer.
CREATE OR REPLACE VIEW "order_payment_balance" AS
WITH b AS (
  SELECT
    o.*,
    coalesce(r."debited", 0)::bigint AS "debited",
    coalesce(r."over_sats", 0)::bigint AS "over_sats",
    coalesce(r."unsent_sats", 0)::bigint AS "unsent_sats",
    coalesce(r."unsent_without_destination", false) AND o."refund_address" IS NULL AS "address_missing",
    coalesce("batch_accepts_orders"(ba."status"), false) AS "batch_open",
    "batch_allows_user_renunciation"(ba."status") AS "renounce_window",
    "order_abandoned_at"(o) AS "abandoned"
  FROM "Order" o
  JOIN "Batch" ba ON ba."id" = o."batch_id"
  LEFT JOIN (
    SELECT rf."order_id", sum("refund_debited_sats"(rf)) AS "debited",
           sum(rf."amount_sats") FILTER (WHERE rf."kind" = 'overpayment') AS "over_sats",
           sum(rf."amount_sats") FILTER (WHERE rf."sent_at" IS NULL) AS "unsent_sats",
           bool_or(rf."sent_at" IS NULL AND rf."destination_address" IS NULL) AS "unsent_without_destination"
    FROM "Refund" rf GROUP BY rf."order_id"
  ) r ON r."order_id" = o."id"
), u AS (
  SELECT b.*,
    CASE WHEN b."status" = 'paid' THEN greatest(b."received_sats" - b."expected_sats" - b."over_sats", 0)
         ELSE b."received_sats" - b."debited" END::bigint AS "unsettled"
  FROM b
), d AS (
  SELECT u.*,
    (u."status" IN ('pending_payment', 'expired') AND u."batch_open" AND u."expires_at" <= now()
     AND u."received_sats" > 0 AND u."received_sats" < u."expected_sats") AS "user_decision",
    (u."unsettled" > 0 AND (u."status" IN ('refunded', 'cancelled')
                            OR (u."status" IN ('pending_payment', 'expired') AND NOT u."batch_open"))) AS "admin_decision",
    (u."status" IN ('pending_payment', 'expired') AND u."batch_open"
     AND u."received_sats" >= u."expected_sats") AS "full_payment"
  FROM u
)
SELECT
  d."id" AS "order_id",
  d."batch_id",
  d."user_id",
  d."status",
  d."expected_sats",
  d."received_sats",
  d."debited" AS "refunded_sats",
  CASE WHEN d."status" IN ('pending_payment', 'expired')
       THEN greatest(d."expected_sats" - d."received_sats", 0) ELSE 0 END::bigint AS "outstanding_sats",
  CASE WHEN d."status" = 'paid' THEN d."unsettled" ELSE 0 END::bigint AS "refund_due_sats",
  d."full_payment" AS "awaiting_decision",
  d."user_decision" AS "awaiting_user_decision",
  d."admin_decision" AS "needs_admin_decision",
  d."unsettled" AS "unsettled_sats",
  (d."status" IN ('pending_payment', 'expired') AND d."batch_open"
   AND d."received_sats" > 0 AND d."received_sats" < d."expected_sats") AS "user_refund_allowed",
  (d."admin_decision" OR d."user_decision" OR d."full_payment" OR d."address_missing") AS "needs_admin_attention",
  d."abandoned" AS "abandoned_at",
  CASE WHEN d."full_payment" THEN "batch_stock_violation"(d."batch_id", d."id") IS NULL END AS "fits_stock",
  d."unsent_sats" AS "unsent_refund_sats",
  d."address_missing" AS "refund_address_missing",
  (d."status" = 'paid' AND d."renounce_window") AS "user_renounce_allowed"
FROM d;

-- Remboursements créés mais pas encore envoyés, les plus anciens d'abord (index Refund_unsent_created_at_idx).
-- destination_address = adresse effective : celle choisie par l'admin sur le remboursement, sinon celle de la
-- facture ; destination_source = 'refund' | 'order' | NULL ; address_missing : contacter l'utilisateur.
CREATE VIEW "refunds_to_send" AS
SELECT
  r."id" AS "refund_id",
  r."order_id",
  o."batch_id",
  o."user_id",
  r."kind",
  r."initiated_by",
  r."amount_sats",
  r."network_fee_sats",
  r."network_fee_payer",
  coalesce(r."destination_address", o."refund_address") AS "destination_address",
  CASE WHEN r."destination_address" IS NOT NULL THEN 'refund'
       WHEN o."refund_address" IS NOT NULL THEN 'order' END AS "destination_source",
  coalesce(r."destination_address", o."refund_address") IS NULL AS "address_missing",
  r."created_at"
FROM "Refund" r
JOIN "Order" o ON o."id" = r."order_id"
WHERE r."sent_at" IS NULL;
