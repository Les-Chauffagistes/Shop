-- ═════════════════════════════════════════════
-- l1 : conformité légale, points figés par Hugo le 2026-11-05 (roadmap « Jalon L », docs/legal-cadrage.md).
--   1. Frais réseau d'un renoncement à la charge de la boutique : refund_cause_fee_payer('user_renounce') = 'shop'
--      (règle unique, lue à la création d'un remboursement par le trigger Refund_cause_fee_payer). Restent à la
--      charge de l'utilisateur : partial_payment (paiement partiel, choix ou sans réponse) et overpayment
--      (excédent). Les remboursements déjà créés gardent leur payeur (immuable, Refund_immutable).
--   2. Adresse de remboursement obligatoire pour toute NOUVELLE facture (Order_refund_address_required, trigger
--      BEFORE INSERT) ; une adresse donnée ne s'efface plus (même contrainte, à l'UPDATE : non NULL → NULL
--      refusé), elle reste modifiable tant qu'aucun remboursement n'est envoyé (Order_refund_address_frozen,
--      journal OrderRefundAddressChange inchangés). Les factures existantes sans adresse ne sont pas touchées :
--      elles peuvent en recevoir une ; leur remboursement sans adresse reste « à traiter »
--      (order_payment_balance.refund_address_missing).
--   3. Blocage anti-abus qui expire seul :
--        * les renoncements (remboursements de lignes, cause user_renounce, que l'utilisateur renonce lui-même
--          ou que l'admin annule à sa demande) comptent avec les abandons, par utilisateur et par lot, datés par
--          la base (Refund.created_at) : user_batch_block_events. Ils ne déclenchent pas le délai de quelques
--          minutes (Order_abandoned_cooldown), qui vise les réservations sans paiement : user_batch_abandoned_orders
--          est inchangée ;
--        * plafond : abandoned_order_limit événements dans une fenêtre glissante de abandoned_order_window_hours
--          heures (défaut de la fenêtre porté de 24 h à 720 h, 30 jours) ;
--        * durée du blocage : ShopSettings.order_block_duration_hours (défaut 72 h, CHECK 1 à 720). À l'échéance,
--          le blocage se lève sans intervention : les événements jusqu'à son début ne comptent plus (comme une
--          levée), ceux qui suivent comptent pour un blocage suivant. Calculé à la lecture sur l'horloge de la
--          base (now()), sans job : user_batch_block ;
--        * la levée manuelle (OrderBlockRelease) reste possible et efface les événements antérieurs.
-- Données touchées : la ligne ShopSettings (fenêtre 24 h → 720 h, seulement si elle avait encore l'ancien défaut ;
-- nouvelle colonne avec défaut). Rien n'est supprimé.
-- Retour arrière (dans l'esprit) : recréer user_batch_blocked_at de v5c, reposer refund_cause_fee_payer de v5f,
-- Order_guard de v5l et la vue order_creation_blocks de v5c (DROP VIEW puis CREATE : colonne retirée) ; DROP du
-- trigger Order_refund_address_required et de sa fonction, des fonctions user_batch_block_events, user_batch_block
-- et user_batch_block_ends_at ; la colonne order_block_duration_hours peut rester (inerte).
-- ═════════════════════════════════════════════

-- ─── (1) Qui paie les frais réseau ─────────────
-- Source unique (v5f). Seule ligne changée : user_renounce passe à la boutique.
CREATE OR REPLACE FUNCTION "refund_cause_fee_payer"(c "refund_cause") RETURNS "refund_fee_payer"
LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE c
    WHEN 'shop_stock'             THEN 'shop'  -- la boutique annule : stock, surplus, lot abandonné
    WHEN 'shop_defective_machine' THEN 'shop'  -- la boutique annule : machine défectueuse
    WHEN 'late_payment_no_room'   THEN 'shop'  -- paiement tardif complet, plus de place
    WHEN 'discount'               THEN 'shop'  -- rabais décidé par l'admin
    WHEN 'admin_other'            THEN 'shop'  -- autre annulation ou remboursement décidé par l'admin
    WHEN 'user_renounce'          THEN 'shop'  -- l'utilisateur renonce à sa commande payée (l1 : droit de rétractation)
    WHEN 'partial_payment'        THEN 'user'  -- remboursement d'un paiement partiel (choix ou sans réponse)
    WHEN 'overpayment'            THEN 'user'  -- excédent de paiement
  END)::"refund_fee_payer"
$$;

-- ─── (2) Adresse de remboursement obligatoire ─────────────
-- Nouvelle facture : adresse exigée. Adresse donnée : remplaçable, jamais effacée. Une facture d'avant l1 sans
-- adresse peut en recevoir une (NULL → adresse), ou rester sans (aucune écriture de la colonne).
CREATE FUNCTION "Order_check_refund_address_required"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."refund_address" IS NULL AND (TG_OP = 'INSERT' OR OLD."refund_address" IS NOT NULL) THEN
    RAISE EXCEPTION 'Order %: a refund address is required, it can be replaced but not removed (constraint "Order_refund_address_required")', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refund_address_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_refund_address_required" BEFORE INSERT OR UPDATE OF "refund_address" ON "Order"
FOR EACH ROW EXECUTE FUNCTION "Order_check_refund_address_required"();

-- ─── (3) Blocage qui expire seul ─────────────

-- Durée d'un blocage (heures), bornée. Fenêtre du plafond : 30 jours par défaut (proposition à confirmer par Hugo).
ALTER TABLE "ShopSettings" ADD COLUMN "order_block_duration_hours" INTEGER NOT NULL DEFAULT 72;
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_block_duration_check"
  CHECK ("order_block_duration_hours" BETWEEN 1 AND 720);
ALTER TABLE "ShopSettings" ALTER COLUMN "abandoned_order_window_hours" SET DEFAULT 720;
UPDATE "ShopSettings" SET "abandoned_order_window_hours" = 720 WHERE "abandoned_order_window_hours" = 24;

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
-- Colonnes de v5c inchangées (abandoned_orders compte désormais abandons et renoncements depuis la dernière levée de
-- l'admin), block_ends_at ajoutée.
-- Toute paire utilisateur-lot qui a une facture est examinée : un renoncement porte sur une facture payée.
CREATE OR REPLACE VIEW "order_creation_blocks" AS
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

-- Remplacée par user_batch_block (début et fin) : plus lue par la vue ni par Order_guard.
DROP FUNCTION "user_batch_blocked_at"(uuid, uuid);

-- Order_guard de v5l, à l'identique sauf le contrôle du blocage : il lit la fin du blocage en cours
-- (user_batch_block_ends_at) et la donne dans le message (plus de « décision de l'admin »).
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
  -- avant. refunded_at : horloge prise sous le verrou de la ligne (v5l), comparée à Payment.received_at.
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
      NEW."total_amount", NEW."expected_sats", NEW."payment_address")
     IS DISTINCT FROM (OLD."id", OLD."user_id", OLD."batch_id", OLD."payment_method", OLD."created_at", OLD."expires_at",
      OLD."total_amount", OLD."expected_sats", OLD."payment_address")
     OR (OLD."paid_at" IS NOT NULL AND NEW."paid_at" IS DISTINCT FROM OLD."paid_at")
     OR (OLD."refunded_at" IS NOT NULL AND NEW."refunded_at" IS DISTINCT FROM OLD."refunded_at")
     OR (NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
         AND (OLD."cancelled_at" IS NOT NULL OR NEW."status" <> 'cancelled'))
     OR (NEW."cancel_reason" IS DISTINCT FROM OLD."cancel_reason"
         AND (OLD."cancel_reason" IS NOT NULL OR NEW."status" <> 'cancelled' OR OLD."status" = 'cancelled')) THEN
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
