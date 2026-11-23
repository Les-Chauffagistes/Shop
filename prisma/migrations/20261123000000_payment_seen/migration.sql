-- Paiement vu : le décompte de réservation (30 min) s'arrête quand bitcoin-service voit, dans le mempool
-- ou la chaîne, de quoi couvrir le total de la facture. L'échéance est alors prolongée UNE fois, de 24 h
-- au plus (plafond si la transaction disparaît : la facture expire ensuite normalement). Tout le reste du
-- domaine lit expires_at : aucune autre règle ne change. payment_seen_at est posée avec la prolongation, puis immuable.
ALTER TABLE "Order" ADD COLUMN "payment_seen_at" TIMESTAMPTZ(6);

CREATE OR REPLACE FUNCTION "Order_guard"() RETURNS trigger
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

  IF (NEW."id", NEW."user_id", NEW."batch_id", NEW."payment_method", NEW."created_at",
      NEW."total_amount", NEW."expected_sats", NEW."payment_address",
      NEW."channel", NEW."created_by_auth_user_id", NEW."manual_reason")
     IS DISTINCT FROM (OLD."id", OLD."user_id", OLD."batch_id", OLD."payment_method", OLD."created_at",
      OLD."total_amount", OLD."expected_sats", OLD."payment_address",
      OLD."channel", OLD."created_by_auth_user_id", OLD."manual_reason")
     -- Échéance : immuable, sauf l'unique prolongation par un paiement complet vu (payment_seen_at posée en même temps)
     OR (NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
         AND NOT (OLD."payment_seen_at" IS NULL AND NEW."payment_seen_at" IS NOT NULL
                  AND OLD."status" = 'pending_payment' AND NEW."status" = 'pending_payment'
                  AND OLD."expires_at" > now() AND NEW."expires_at" > OLD."expires_at"
                  AND NEW."expires_at" <= now() + interval '24 hours'))
     OR (OLD."payment_seen_at" IS NOT NULL AND NEW."payment_seen_at" IS DISTINCT FROM OLD."payment_seen_at")
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

