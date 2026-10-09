-- ═════════════════════════════════════════════
-- v5c : anti-accaparement (toute forme), fin anticipée de la journée de priorité, remboursement
-- d'un paiement partiel (décisions Hugo du 2026-10-07, roadmap « Questions tranchées »).
--   1. Facture ABANDONNÉE (order_abandoned_at) : prise sans être payée puis terminée sans paiement
--      complet : annulée, expirée (réservation terminée, reçu < attendu), ou remboursée sans avoir été
--      payée intégralement (remboursement choisi par l'utilisateur, avant ou après l'expiration).
--      Par utilisateur et par lot :
--        * délai après tout abandon (Order_abandoned_cooldown, ShopSettings.abandoned_order_cooldown_minutes,
--          ex-expired_order_cooldown_minutes, renommé) ;
--        * plafond : au abandoned_order_limit-ième abandon dans une fenêtre glissante de
--          abandoned_order_window_hours heures, plus aucune facture sur ce lot jusqu'à ce que l'admin
--          lève le blocage (Order_abandoned_limit, table OrderBlockRelease, vue order_creation_blocks).
--   2. Journée de priorité : se termine dès que toutes les wishlists actives du lot sont converties.
--   3. Remboursement aux frais de l'utilisateur : refusé si ce qu'il a versé ne couvre pas les frais
--      (Refund_user_net_positive) ; il reste en attente de l'appoint ; l'admin voit la facture
--      (order_payment_balance.needs_admin_attention).
--   4. Remboursement d'un paiement partiel AVANT l'expiration : permis (frais à la charge de
--      l'utilisateur), la facture passe à refunded et libère la réservation au COMMIT ; c'est un abandon.
-- Convention inchangée : chaque erreur de trigger porte `(constraint "Nom")` dans son message.
-- Aucune donnée supprimée ni réécrite : une colonne renommée (valeur conservée), deux colonnes
-- ajoutées avec défaut, une table ajoutée, fonctions et vue redéfinies (colonnes ajoutées en fin).
-- ═════════════════════════════════════════════

-- ─── Réglages ─────────────────────────────────
-- Défauts : délai de 5 min (décision du jalon 4, étendu à tout abandon) ; blocage au 3e abandon en
-- 24 h glissantes. Un utilisateur de bonne foi peut se tromper une ou deux fois (configuration,
-- portefeuille) ; au-delà, l'admin le contacte. Plafond de réservation sans payer : 3 × 30 min par
-- lot et par jour, puis plus rien sans l'admin.
ALTER TABLE "ShopSettings" RENAME COLUMN "expired_order_cooldown_minutes" TO "abandoned_order_cooldown_minutes";
ALTER TABLE "ShopSettings" ADD COLUMN "abandoned_order_limit" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "ShopSettings" ADD COLUMN "abandoned_order_window_hours" INTEGER NOT NULL DEFAULT 24;

ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_abandoned_limit_check"
  CHECK ("abandoned_order_limit" BETWEEN 1 AND 100);
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_abandoned_window_check"
  CHECK ("abandoned_order_window_hours" BETWEEN 1 AND 720);

-- ─── Levée de blocage par l'admin ─────────────
-- Journal append-only : chaque ligne efface les abandons antérieurs de l'utilisateur sur le lot
-- (ils ne comptent plus ni pour le plafond ni pour le délai). Jamais modifiée ni supprimée.

-- CreateTable
CREATE TABLE "OrderBlockRelease" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "released_by_auth_user_id" BIGINT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "OrderBlockRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderBlockRelease_user_id_batch_id_created_at_idx" ON "OrderBlockRelease"("user_id", "batch_id", "created_at");

-- CreateIndex
CREATE INDEX "OrderBlockRelease_batch_id_idx" ON "OrderBlockRelease"("batch_id");

-- AddForeignKey
ALTER TABLE "OrderBlockRelease" ADD CONSTRAINT "OrderBlockRelease_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderBlockRelease" ADD CONSTRAINT "OrderBlockRelease_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderBlockRelease" ADD CONSTRAINT "OrderBlockRelease_released_by_check" CHECK ("released_by_auth_user_id" > 0);
ALTER TABLE "OrderBlockRelease" ADD CONSTRAINT "OrderBlockRelease_reason_check" CHECK (btrim("reason") <> '');

CREATE TRIGGER "OrderBlockRelease_append_only"
  BEFORE UPDATE OR DELETE ON "OrderBlockRelease"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

-- ─── (1) Factures abandonnées ─────────────────

-- Instant où la facture a été abandonnée, NULL si elle ne l'est pas (vivante, payée, ou payée
-- intégralement sans être acceptée : paiement tardif sans place, que la boutique rembourse).
--   * paid, ou paid_at posé (payée puis remboursée) : pas un abandon ;
--   * annulée (cancelled_at), même si un paiement est arrivé ensuite, tant que l'admin ne l'a pas
--     acceptée : cancelled_at ;
--   * reçu >= attendu : l'utilisateur a payé, pas un abandon ;
--   * remboursée (frais à sa charge, avant ou après l'expiration ; ou par l'admin) : le premier de
--     expires_at et refunded_at ;
--   * en attente ou expirée, réservation terminée, reçu < attendu (rien ou appoint manquant) : expires_at.
-- Un appoint qui complète puis fait accepter la facture (paid) efface l'abandon.
CREATE FUNCTION "order_abandoned_at"(o "Order") RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN o."status" = 'paid' OR o."paid_at" IS NOT NULL THEN NULL
    WHEN o."cancelled_at" IS NOT NULL THEN o."cancelled_at"
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

-- Blocage (plafond) : instant de l'abandon qui a atteint abandoned_order_limit abandons dans une
-- fenêtre de abandoned_order_window_hours heures. NULL : pas bloqué. Le blocage ne cesse pas avec le
-- temps : seule une levée de l'admin (OrderBlockRelease) remet le compteur à zéro.
CREATE FUNCTION "user_batch_blocked_at"(b uuid, u uuid) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  WITH s AS (SELECT * FROM "shop_settings"()),
       a AS (SELECT "abandoned_at" AS "at" FROM "user_batch_abandoned_orders"(b, u))
  SELECT min(a1."at")
  FROM a a1, s
  WHERE (SELECT count(*) FROM a a2
         WHERE a2."at" <= a1."at"
           AND a2."at" > a1."at" - make_interval(hours => s."abandoned_order_window_hours")) >= s."abandoned_order_limit"
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

-- Utilisateurs bloqués sur un lot ouvert aux commandes : « à traiter » au backoffice (lever ou non).
CREATE VIEW "order_creation_blocks" AS
SELECT p."user_id", p."batch_id", x."blocked_at",
       (SELECT count(*) FROM "user_batch_abandoned_orders"(p."batch_id", p."user_id"))::integer AS "abandoned_orders",
       "order_block_released_at"(p."batch_id", p."user_id") AS "last_released_at"
FROM (
  SELECT DISTINCT o."user_id", o."batch_id"
  FROM "Order" o JOIN "Batch" ba ON ba."id" = o."batch_id"
  WHERE coalesce("batch_accepts_orders"(ba."status"), false) AND "order_abandoned_at"(o) IS NOT NULL
) p
CROSS JOIN LATERAL (SELECT "user_batch_blocked_at"(p."batch_id", p."user_id") AS "blocked_at") x
WHERE x."blocked_at" IS NOT NULL;

-- ─── (2) Journée de priorité ──────────────────
-- Fin : première ouverture des précommandes + 1 jour, pour un lot passé par le sondage et qui a au
-- moins une wishlist active. Plus tôt si toutes les wishlists actives sont converties (ligne non
-- remboursée d'une facture payée) : à la dernière conversion (paid_at), jamais avant l'ouverture.
-- NULL : pas de priorité (lot ouvert sans sondage, aucune wishlist active, toutes retirées, ou
-- précommandes pas encore ouvertes). Calculée à la lecture : si une conversion est remboursée pendant
-- la journée, la priorité reprend jusqu'à la fin prévue.
CREATE OR REPLACE FUNCTION "batch_priority_ends_at"(b uuid) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN op."at" IS NULL OR ws."n" = 0 THEN NULL
    WHEN ws."n_converted" = ws."n" THEN least(op."at" + interval '1 day', greatest(op."at", ws."last_converted"))
    ELSE op."at" + interval '1 day'
  END
  FROM (
    SELECT min(p."created_at") AS "at"
    FROM "BatchStatusTransition" p
    WHERE p."batch_id" = b AND p."to_status" = 'preorder'
      AND EXISTS (SELECT 1 FROM "BatchStatusTransition" s WHERE s."batch_id" = b AND s."to_status" = 'survey')
  ) op,
  (
    SELECT count(*) AS "n", count(c."at") AS "n_converted", max(c."at") AS "last_converted"
    FROM "Wishlist" w
    CROSS JOIN LATERAL (
      SELECT max(o."paid_at") AS "at"
      FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
      WHERE l."wishlist_id" = w."id" AND l."refund_id" IS NULL AND o."status" = 'paid'
    ) c
    WHERE w."batch_id" = b AND w."cancelled_at" IS NULL
  ) ws
$$;

-- ─── Factures ─────────────────────────────────
-- Création : inchangée sauf
--   * Order_abandoned_limit (toute création, même déjà expirée) : utilisateur bloqué sur ce lot ;
--   * Order_abandoned_cooldown (facture qui réserve) : remplace Order_expired_cooldown, compte tout
--     abandon (annulation, expiration, remboursement d'un paiement partiel).
-- Ordre des contrôles : lot ouvert, priorité, facture vivante, blocage, délai. Verrou de
-- l'utilisateur pris avant (les créations concurrentes du même utilisateur se suivent).
-- Mises à jour : cancelled_at et refunded_at posés par la base au passage de statut (now()) ;
-- Order_cancel_unpaid oriente vers le remboursement ; le reste est inchangé.
CREATE OR REPLACE FUNCTION "Order_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bst "batch_status";
  t timestamptz;
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
    t := "user_batch_blocked_at"(NEW."batch_id", NEW."user_id");
    IF t IS NOT NULL THEN
      RAISE EXCEPTION 'User % reached the abandoned orders limit on batch % at %: new orders need an admin decision (constraint "Order_abandoned_limit")',
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

  -- Dates d'annulation et de remboursement : horloge de la base (la valeur fournie est remplacée).
  -- Elles datent les abandons (délai, plafond) : une date antidatée par un écrivain raccourcirait le
  -- délai, une horloge applicative en avance le prolongerait.
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status" = 'cancelled' THEN
      NEW."cancelled_at" := now();
    ELSIF NEW."status" = 'refunded' THEN
      NEW."refunded_at" := now();
    END IF;
  END IF;

  IF (NEW."id", NEW."user_id", NEW."batch_id", NEW."payment_method", NEW."created_at", NEW."expires_at",
      NEW."total_amount", NEW."expected_sats", NEW."payment_address")
     IS DISTINCT FROM (OLD."id", OLD."user_id", OLD."batch_id", OLD."payment_method", OLD."created_at", OLD."expires_at",
      OLD."total_amount", OLD."expected_sats", OLD."payment_address")
     OR (OLD."paid_at" IS NOT NULL AND NEW."paid_at" IS DISTINCT FROM OLD."paid_at")
     OR (OLD."refunded_at" IS NOT NULL AND NEW."refunded_at" IS DISTINCT FROM OLD."refunded_at")
     OR (NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
         AND (OLD."cancelled_at" IS NOT NULL OR NEW."status" <> 'cancelled')) THEN
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
  IF NEW."status" = 'cancelled' AND OLD."received_sats" > 0 THEN
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

-- ─── (3)(4) Remboursement aux frais de l'utilisateur ───
-- Permis pour toute facture en attente ou expirée partiellement payée (0 < reçu < attendu) d'un lot
-- ouvert aux commandes, AVANT comme après l'expiration (v5b : après seulement). Avant l'expiration,
-- le passage à refunded libère la réservation au COMMIT (order_holds_stock faux), et la facture
-- compte comme abandonnée (order_abandoned_at = refunded_at). Verrou de la ligne Order : un appoint
-- complet validé avant fait échouer la demande.
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
  RETURN NEW;
END;
$$;

-- (3) Ce que l'utilisateur a versé doit couvrir les frais réseau à sa charge : sinon pas de
-- remboursement (net nul ou négatif), il reste en attente de l'appoint. Avant Refund_amount_sats_check
-- (trigger BEFORE) pour que le refus soit nommé ; aussi à l'ajustement des frais avant l'envoi.
CREATE FUNCTION "Refund_check_user_net"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."network_fee_payer" = 'user' AND NEW."amount_sats" <= 0 THEN
    RAISE EXCEPTION 'Order %: what was received does not cover the network fees charged to the user; wait for the top-up (constraint "Refund_user_net_positive")', NEW."order_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_net_positive';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Refund_user_net_positive"
  BEFORE INSERT OR UPDATE OF "amount_sats", "network_fee_sats" ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION "Refund_check_user_net"();

-- ─── Solde de paiement ─────────────────────────
-- Colonnes existantes inchangées (même ordre, mêmes types et sens). Ajoutées :
--   user_refund_allowed    l'utilisateur peut demander le remboursement de ce qu'il a avancé, frais à
--                          sa charge (mêmes conditions que Refund_user_fee_allowed ; le montant doit
--                          aussi couvrir les frais, Refund_user_net_positive) ;
--   needs_admin_attention  « à traiter » au backoffice : décision de l'admin (needs_admin_decision) ou
--                          facture expirée partiellement payée qui attend le choix de l'utilisateur
--                          (awaiting_user_decision : l'admin le contacte ; rien d'automatique) ;
--   abandoned_at           order_abandoned_at (abandon compté par le délai et le plafond).
CREATE OR REPLACE VIEW "order_payment_balance" AS
WITH b AS (
  SELECT
    o.*,
    coalesce(r."debited", 0)::bigint AS "debited",
    coalesce(r."over_sats", 0)::bigint AS "over_sats",
    coalesce("batch_accepts_orders"(ba."status"), false) AS "batch_open",
    "order_abandoned_at"(o) AS "abandoned"
  FROM "Order" o
  JOIN "Batch" ba ON ba."id" = o."batch_id"
  LEFT JOIN (
    SELECT rf."order_id", sum("refund_debited_sats"(rf)) AS "debited",
           sum(rf."amount_sats") FILTER (WHERE rf."kind" = 'overpayment') AS "over_sats"
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
                            OR (u."status" IN ('pending_payment', 'expired') AND NOT u."batch_open"))) AS "admin_decision"
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
  (d."status" IN ('pending_payment', 'expired') AND d."batch_open"
   AND d."received_sats" >= d."expected_sats") AS "awaiting_decision",
  d."user_decision" AS "awaiting_user_decision",
  d."admin_decision" AS "needs_admin_decision",
  d."unsettled" AS "unsettled_sats",
  (d."status" IN ('pending_payment', 'expired') AND d."batch_open"
   AND d."received_sats" > 0 AND d."received_sats" < d."expected_sats") AS "user_refund_allowed",
  (d."admin_decision" OR d."user_decision") AS "needs_admin_attention",
  d."abandoned" AS "abandoned_at"
FROM d;
