-- ═════════════════════════════════════════════
-- v5l : recommandations de la revue qualité v5k validées par Hugo (2026-10-13).
--   1. Cause de l'annulation d'une facture (Order.cancel_reason, enum order_cancel_reason), posée par la base au
--      passage à cancelled (Order_guard), jamais modifiée ensuite :
--        * batch_closed : la transition d'un lot vers un statut qui ferme les commandes (annulé v5h ; en transit,
--          clôturé v5i) annule ses factures en attente sans versement (BatchStatusTransition_apply la pose) ;
--          refusée hors de ce trigger (Order_cancel_reason_batch_closed : pg_trigger_depth() < 2) ;
--        * user : le client annule lui-même sa facture en attente (défaut quand l'écrivain n'en donne pas : c'est
--          le seul chemin applicatif existant, POST /api/orders/{id}/cancel) ;
--        * admin : l'admin l'annule (aucune route aujourd'hui ; l'écrivain la donne explicitement).
--      CHECK Order_cancel_reason_check : cancel_reason renseigné <=> cancelled_at renseigné. Donc obligatoire
--      quand status = cancelled, NULL pour une facture jamais annulée. Comme cancelled_at (v5b), la cause est
--      CONSERVÉE si la facture annulée est ensuite acceptée (cancelled → paid) ou remboursée (cancelled →
--      refunded) : l'effacer perdrait l'historique que le client et l'admin lisent (« versement reçu après
--      l'annulation par le lot »). Une expiration reste `expired` (rien n'est posé).
--      Reprise des factures déjà annulées : voir (1) plus bas (critère et cas ambigus).
--   2. Versements d'une facture remboursée : la vue order_payment_balance distingue, sans colonne de table,
--        * le SURPLUS RESTÉ : excédent d'une commande payée puis annulée en entier (renoncement compris), laissé
--          « à traiter » par le remboursement du prix (v5i/v5k) ;
--        * le VERSEMENT ARRIVÉ APRÈS LE REMBOURSEMENT INTÉGRAL : sats reçus sur l'adresse après le passage à
--          refunded.
--      Définition exacte en (2). Pour qu'elle ne dépende ni d'une horloge applicative ni d'une course entre un
--      paiement et le remboursement, les deux dates comparées sont prises par la base SOUS LE VERROU de la
--      facture : Payment.received_at (nouveau trigger Payment_stamp : verrou de la facture puis
--      clock_timestamp(), la valeur fournie est remplacée) et Order.refunded_at (Order_guard : clock_timestamp()
--      au lieu de now(), la ligne est déjà verrouillée par l'UPDATE). Deux transactions qui touchent la même
--      facture se suivent : l'ordre des dates est celui des verrous.
-- Données touchées à l'application : la seule reprise (1) de cancel_reason sur les factures annulées. Rien n'est
-- supprimé ; aucune autre colonne réécrite (updated_at compris).
-- Retour arrière (dans l'esprit) : reposer Order_guard de v5c, BatchStatusTransition_apply de v5i et
-- order_payment_balance de v5i (DROP VIEW puis CREATE : colonnes retirées) ; DROP TRIGGER Payment_stamp et sa
-- fonction ; DROP CONSTRAINT Order_cancel_reason_check. La colonne cancel_reason porte des données : la garder
-- (inerte) plutôt que la supprimer. Les dates déjà posées par la nouvelle horloge restent valables.
-- ═════════════════════════════════════════════

-- ─── (1) Cause de l'annulation ─────────────

-- CreateEnum
CREATE TYPE "order_cancel_reason" AS ENUM ('user', 'batch_closed', 'admin');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "cancel_reason" "order_cancel_reason";

-- Reprise des factures déjà annulées. La base n'a jamais noté qui annulait ; critère retenu, plus sûr que le
-- seul état actuel du lot (qui présenterait comme « annulée par le lot » une facture annulée par le client des
-- jours avant la fermeture : le défaut que corrige cette migration) :
--   batch_closed si une transition du même lot vers un statut qui ferme les commandes (batch_accepts_orders
--     faux : cancelled, in_transit, closed) a été écrite dans les 10 secondes qui SUIVENT cancelled_at. Une
--     annulation par le lot a lieu dans la transaction de la transition : cancelled_at = now() (début de cette
--     transaction) <= created_at de la transition (clock_timestamp(), plus tard dans la même transaction) ;
--   user sinon (lot encore ouvert, ou fermé plus de 10 s après l'annulation).
-- Cas ambigus (documentés, comptés par le NOTICE ci-dessous) :
--   * un client qui a annulé lui-même dans les 10 s précédant la fermeture du lot est repris en batch_closed ;
--   * une transition écrite en SQL avec un created_at antidaté (seed, fixtures) échappe au critère : sa facture
--     est reprise en user. Aucune facture d'avant v5h (2026-10-09) n'a pu être annulée par un lot.
-- Seuls Order_guard (BEFORE UPDATE) et Order_check (différé, toute colonne) réagissent à cette mise à jour ; ils
-- sont suspendus le temps de la reprise pour ne pas revalider les factures existantes contre des règles
-- postérieures à leur écriture (aucun autre trigger de "Order" ne porte sur cancel_reason).
ALTER TABLE "Order" DISABLE TRIGGER "Order_guard";
ALTER TABLE "Order" DISABLE TRIGGER "Order_check";

UPDATE "Order" o
SET "cancel_reason" = CASE WHEN EXISTS (
    SELECT 1 FROM "BatchStatusTransition" t
    WHERE t."batch_id" = o."batch_id"
      AND NOT coalesce("batch_accepts_orders"(t."to_status"), false)
      AND t."created_at" >= o."cancelled_at"
      AND t."created_at" < o."cancelled_at" + interval '10 seconds'
  ) THEN 'batch_closed'::"order_cancel_reason" ELSE 'user'::"order_cancel_reason" END
WHERE o."cancelled_at" IS NOT NULL;

ALTER TABLE "Order" ENABLE TRIGGER "Order_guard";
ALTER TABLE "Order" ENABLE TRIGGER "Order_check";

DO $$
DECLARE
  n_user integer;
  n_batch integer;
  n_ambiguous integer;
BEGIN
  SELECT count(*) FILTER (WHERE "cancel_reason" = 'user'), count(*) FILTER (WHERE "cancel_reason" = 'batch_closed')
  INTO n_user, n_batch FROM "Order" WHERE "cancelled_at" IS NOT NULL;
  -- Ambiguës : annulées par le client alors que le lot a fermé ensuite, ou reprises batch_closed
  SELECT count(*) INTO n_ambiguous FROM "Order" o JOIN "Batch" b ON b."id" = o."batch_id"
  WHERE o."cancelled_at" IS NOT NULL
    AND (o."cancel_reason" = 'batch_closed' OR NOT coalesce("batch_accepts_orders"(b."status"), false));
  RAISE NOTICE 'v5l cancel_reason backfill: % user, % batch_closed (% on a batch closed to orders: check them by hand)',
    n_user, n_batch, n_ambiguous;
END;
$$;

-- Renseignée <=> la facture a été annulée (cancelled_at, immuable une fois posé ; obligatoire pour cancelled,
-- Order_status_dates_check). Conservée après cancelled → paid | refunded, comme cancelled_at.
ALTER TABLE "Order" ADD CONSTRAINT "Order_cancel_reason_check" CHECK (("cancel_reason" IS NULL) = ("cancelled_at" IS NULL));

-- Order_guard de v5c, à l'identique sauf :
--   * passage à cancelled : cancel_reason posé (user par défaut ; batch_closed réservé au trigger de transition
--     du lot, pg_trigger_depth() >= 2 ; admin donné par l'écrivain) ;
--   * passage à refunded : refunded_at = clock_timestamp() (ligne déjà verrouillée par l'UPDATE) au lieu de
--     now() (début de transaction, qui peut précéder un paiement validé avant que la transaction obtienne le
--     verrou) : comparé à Payment.received_at par order_payment_balance ;
--   * cancel_reason immuable une fois posé, et seulement au passage à cancelled (Order_immutable).
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

-- BatchStatusTransition_apply de v5i, à l'identique sauf la cause posée sur les factures annulées par la
-- transition (batch_closed). Seul écrivain de cette cause (Order_cancel_reason_batch_closed).
CREATE OR REPLACE FUNCTION "BatchStatusTransition_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur "batch_status";
BEGIN
  SELECT "status" INTO cur FROM "Batch" WHERE "id" = NEW."batch_id" FOR UPDATE;
  IF NEW."from_status" IS NULL THEN
    IF cur <> 'draft' OR EXISTS (SELECT 1 FROM "BatchStatusTransition" WHERE "batch_id" = NEW."batch_id") THEN
      RAISE EXCEPTION 'Creation transition only for a new draft batch % (constraint "BatchStatusTransition_current")', NEW."batch_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_current';
    END IF;
    RETURN NEW;
  END IF;
  IF cur IS DISTINCT FROM NEW."from_status" THEN
    RAISE EXCEPTION 'Batch % is %, not % (constraint "BatchStatusTransition_current")', NEW."batch_id", cur, NEW."from_status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_current';
  END IF;
  -- Annulation : tout ce qui a été payé doit être remboursé (roadmap, décisions Paiement)
  IF NEW."to_status" = 'cancelled' AND EXISTS (
    SELECT 1 FROM "Order" WHERE "batch_id" = NEW."batch_id" AND "status" = 'paid'
  ) THEN
    RAISE EXCEPTION 'Batch % has paid orders: refund them before cancelling (constraint "BatchStatusTransition_cancel_refunded")', NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_cancel_refunded';
  END IF;
  -- (v5h, étendu en v5i) Lot qui n'accepte plus de commande (annulé, en transit…) : les factures en attente
  -- sans aucun versement sont annulées avec la transition (cancelled_at posé par Order_guard ; v5l : cause
  -- batch_closed). Le WHERE est réévalué sous le verrou de la ligne : un versement validé entre-temps, ou une
  -- annulation par le client validée juste avant (cause user conservée), exclut la facture. Les factures
  -- expirées (expires_at passé) n'ont plus rien à annuler (Order_cancel_expired).
  IF NOT coalesce("batch_accepts_orders"(NEW."to_status"), false) THEN
    UPDATE "Order" SET "status" = 'cancelled', "cancel_reason" = 'batch_closed', "updated_at" = now()
    WHERE "batch_id" = NEW."batch_id" AND "status" = 'pending_payment'
      AND "received_sats" = 0 AND "expires_at" > now();
  END IF;
  IF NEW."from_status" = 'draft' AND NEW."to_status" <> 'cancelled' THEN
    INSERT INTO "BatchOption" ("batch_id", "model_id", "option_id")
    SELECT b."id", b."model_id", o."id"
    FROM "Batch" b JOIN "Option" o ON o."model_id" = b."model_id"
    WHERE b."id" = NEW."batch_id"
    ON CONFLICT DO NOTHING;
    INSERT INTO "BatchOptionValue" ("batch_id", "model_id", "option_id", "option_value_id")
    SELECT bo."batch_id", bo."model_id", bo."option_id", v."id"
    FROM "BatchOption" bo JOIN "OptionValue" v ON v."option_id" = bo."option_id"
    WHERE bo."batch_id" = NEW."batch_id"
    ON CONFLICT DO NOTHING;
    INSERT INTO "ConfigurationItem" ("configuration_id", "model_id", "option_id", "option_value_id", "unit_price")
    SELECT c."id", c."model_id", bo."option_id", v."id", 0
    FROM "Configuration" c
    JOIN "BatchOption" bo ON bo."batch_id" = c."batch_id" AND NOT bo."hidden"
    JOIN "OptionValue" v ON v."option_id" = bo."option_id" AND v."is_default"
    WHERE c."batch_id" = NEW."batch_id" AND c."locked_at" IS NULL
    ON CONFLICT DO NOTHING;
  END IF;
  -- (v5i) Les wishlists se figent (sortie du brouillon ou du sondage vers la précommande, ou directement vers
  -- Commande en cours) : un choix retiré au sondage revient au défaut, ajustement journalisé. Le lot a encore
  -- son ancien statut ici : la garde d'immuabilité laisse faire, l'instantané de publication est déjà pris.
  IF NEW."from_status" IN ('draft', 'survey') AND "batch_wishlists_frozen"(NEW."to_status") THEN
    PERFORM "batch_reset_withdrawn_choices"(NEW."batch_id");
  END IF;
  UPDATE "Batch" SET "status" = NEW."to_status", "updated_at" = now() WHERE "id" = NEW."batch_id";
  RETURN NEW;
END;
$$;

-- ─── (2) Versements d'une facture remboursée ─────────────

-- Date d'un paiement : horloge de la base prise SOUS LE VERROU de la facture (FOR NO KEY UPDATE, le même que
-- celui de Payment_apply, pris un peu plus tôt dans la même transaction : l'ordre des verrous, facture puis
-- lot, est inchangé). La valeur fournie est remplacée. Un paiement validé avant qu'un remboursement verrouille
-- la facture a donc une date antérieure à refunded_at, un paiement appliqué après, une date postérieure.
CREATE FUNCTION "Payment_stamp"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
  NEW."received_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Payment_stamp" BEFORE INSERT ON "Payment"
FOR EACH ROW EXECUTE FUNCTION "Payment_stamp"();

-- Solde de paiement. Colonnes de v5i inchangées (ordre, types) ; colonnes ajoutées en fin, toutes à 0 / faux
-- sauf pour une facture remboursée (status = refunded, seule à avoir refunded_at) :
--   received_after_refund_sats = somme des Payment.amount_sats dont received_at > refunded_at (versements
--     appliqués après le passage à refunded ; historique, même s'ils ont été traités depuis) ;
--   surplus_left_sats = sats reçus AVANT le remboursement intégral et toujours non affectés :
--     greatest(reçu − received_after_refund_sats − sortis du solde (refunded_sats, brut) − classés sans suite, 0).
--     Non nul seulement pour une commande payée puis annulée en entier (paid_at posé) dont l'excédent est resté
--     (Order_refunded_in_full, v5i) ; toujours 0 pour une facture jamais acceptée (tout le reçu est sorti du
--     solde au passage à refunded) ;
--   paid_after_refund_sats = unsettled_sats − surplus_left_sats : part non affectée qui vient des versements
--     arrivés après le remboursement intégral ;
--   surplus_left = surplus_left_sats > 0 ; paid_after_refund = paid_after_refund_sats > 0 (drapeaux) ;
--   surplus_left_sats + paid_after_refund_sats = unsettled_sats pour une facture remboursée.
-- Convention d'imputation (seul cas où les montants ne disent pas tout) : un remboursement ou un classement fait
-- APRÈS le passage à refunded éteint d'abord le surplus resté (le plus ancien), puis les versements tardifs.
CREATE OR REPLACE VIEW "order_payment_balance" AS
WITH b AS (
  SELECT
    o.*,
    coalesce(r."debited", 0)::bigint AS "debited",
    coalesce(r."over_sats", 0)::bigint AS "over_sats",
    coalesce(r."unsent_sats", 0)::bigint AS "unsent_sats",
    coalesce(r."unsent_without_destination", false) AND o."refund_address" IS NULL AS "address_missing",
    coalesce(dm."sats", 0)::bigint AS "dismissed",
    coalesce(pa."sats", 0)::bigint AS "after_refund",
    coalesce("batch_accepts_orders"(ba."status"), false) AS "batch_open",
    "batch_allows_user_renunciation"(ba."status") AS "renounce_window",
    "order_abandoned_at"(o) AS "abandoned"
  FROM "Order" o
  JOIN "Batch" ba ON ba."id" = o."batch_id"
  LEFT JOIN (
    SELECT rf."order_id", sum("refund_debited_sats"(rf)) AS "debited",
           sum("refund_debited_sats"(rf)) FILTER (WHERE rf."kind" = 'overpayment') AS "over_sats",
           sum(rf."amount_sats") FILTER (WHERE rf."sent_at" IS NULL) AS "unsent_sats",
           bool_or(rf."sent_at" IS NULL AND rf."destination_address" IS NULL) AS "unsent_without_destination"
    FROM "Refund" rf GROUP BY rf."order_id"
  ) r ON r."order_id" = o."id"
  LEFT JOIN "OrderExcessDismissal" dm ON dm."order_id" = o."id"
  LEFT JOIN LATERAL (
    SELECT sum(p."amount_sats") AS "sats"
    FROM "Payment" p
    WHERE p."order_id" = o."id" AND p."received_at" > o."refunded_at"
  ) pa ON true
), u AS (
  SELECT b.*,
    CASE WHEN b."status" = 'paid' THEN greatest(b."received_sats" - b."expected_sats" - b."over_sats" - b."dismissed", 0)
         ELSE b."received_sats" - b."debited" - b."dismissed" END::bigint AS "unsettled",
    CASE WHEN b."status" = 'refunded'
         THEN greatest(b."received_sats" - b."after_refund" - b."debited" - b."dismissed", 0)
         ELSE 0 END::bigint AS "surplus"
  FROM b
), d AS (
  SELECT u.*,
    (u."status" IN ('pending_payment', 'expired') AND u."batch_open" AND u."expires_at" <= now()
     AND u."received_sats" > 0 AND u."received_sats" < u."expected_sats") AS "user_decision",
    (u."unsettled" > 0 AND (u."status" IN ('refunded', 'cancelled')
                            OR (u."status" IN ('pending_payment', 'expired') AND NOT u."batch_open"))) AS "admin_decision",
    (u."status" IN ('pending_payment', 'expired') AND u."batch_open"
     AND u."received_sats" >= u."expected_sats") AS "full_payment",
    (u."status" = 'paid' AND u."unsettled" > 0) AS "excess",
    CASE WHEN u."status" = 'refunded' THEN u."unsettled" - u."surplus" ELSE 0 END::bigint AS "late"
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
  (d."admin_decision" OR d."user_decision" OR d."full_payment" OR d."address_missing" OR d."excess") AS "needs_admin_attention",
  d."abandoned" AS "abandoned_at",
  CASE WHEN d."full_payment" THEN "batch_stock_violation"(d."batch_id", d."id") IS NULL END AS "fits_stock",
  d."unsent_sats" AS "unsent_refund_sats",
  d."address_missing" AS "refund_address_missing",
  (d."status" = 'paid' AND d."renounce_window") AS "user_renounce_allowed",
  d."excess" AS "overpayment_unrefunded",
  d."dismissed" AS "dismissed_sats",
  d."after_refund" AS "received_after_refund_sats",
  d."surplus" AS "surplus_left_sats",
  d."late" AS "paid_after_refund_sats",
  (d."surplus" > 0) AS "surplus_left",
  (d."late" > 0) AS "paid_after_refund"
FROM d;
