-- ═════════════════════════════════════════════
-- v5b (2/2) : ajustements du jalon 4 (décisions Hugo du 2026-10-07, roadmap « Décisions du jalon 4 »).
--   1. Priorité d'un jour limitée au nombre de wishlists actives de l'utilisateur sur le lot ; un lot
--      sans wishlist active n'a pas de journée de priorité.
--   2. Délai entre deux factures expirées : par utilisateur ET par lot.
--   3. Facture expirée partiellement payée : l'utilisateur choisit l'appoint ou le remboursement de ce
--      qu'il a avancé, frais réseau à SA charge dans ce cas (Refund.network_fee_payer = 'user').
--   4. Statut cancelled : facture en attente impayée annulée par l'utilisateur (réservation libérée
--      tout de suite, pas de délai) ; jamais de DELETE ; un paiement arrivé ensuite relève de l'admin.
--   5. Paiement reçu après un remboursement intégral, après une annulation, ou sur un lot qui
--      n'accepte plus de commandes : pas de remboursement automatique, état « à traiter »
--      (order_payment_balance.needs_admin_decision).
--   6. batch_accepts_orders : dernier statut acceptant des commandes = packaging (in_transit refusé).
--      Défaut à confirmer par Hugo : une seule fonction à modifier pour revenir en arrière.
-- Convention inchangée : chaque erreur de trigger porte `(constraint "Nom")` dans son message.
-- Aucune donnée supprimée ni réécrite : colonnes ajoutées (NULL / défaut 'shop'), index remplacé,
-- fonctions et vue redéfinies.
-- ═════════════════════════════════════════════

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "cancelled_at" TIMESTAMPTZ(6);
ALTER TABLE "Refund" ADD COLUMN "network_fee_payer" "refund_fee_payer" NOT NULL DEFAULT 'shop';

-- Index des garde-fous : les deux règles (facture vivante, délai après expiration) filtrent désormais
-- sur (utilisateur, lot). L'index commence par user_id : il sert aussi la clé étrangère.
DROP INDEX "Order_user_id_expires_at_idx";
CREATE INDEX "Order_user_id_batch_id_expires_at_idx" ON "Order"("user_id", "batch_id", "expires_at");

-- ─── CHECK ────────────────────────────────────

-- cancelled : annulée en attente (ni payée, ni expirée, ni remboursée au moment de l'annulation).
-- cancelled_at est conservé si l'admin accepte ensuite un paiement tardif (paid) ou rembourse.
ALTER TABLE "Order" DROP CONSTRAINT "Order_status_dates_check";
ALTER TABLE "Order" ADD CONSTRAINT "Order_status_dates_check" CHECK (
  CASE "status"
    WHEN 'pending_payment' THEN "paid_at" IS NULL AND "expired_at" IS NULL AND "refunded_at" IS NULL AND "cancelled_at" IS NULL
    WHEN 'expired'         THEN "paid_at" IS NULL AND "expired_at" IS NOT NULL AND "refunded_at" IS NULL AND "cancelled_at" IS NULL
    WHEN 'cancelled'       THEN "paid_at" IS NULL AND "expired_at" IS NULL AND "refunded_at" IS NULL AND "cancelled_at" IS NOT NULL
    WHEN 'paid'            THEN "paid_at" IS NOT NULL AND "refunded_at" IS NULL
    WHEN 'refunded'        THEN "refunded_at" IS NOT NULL
  END);

-- Frais à la charge de l'utilisateur : seulement pour l'annulation de ses lignes (remboursement de
-- ce qu'il a avancé), avec le montant des frais connu (déduit de ce qu'il reçoit).
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_fee_payer_check" CHECK (
  "network_fee_payer" = 'shop' OR ("kind" = 'cancellation' AND "network_fee_sats" IS NOT NULL));

-- ─── Statuts d'un lot ───
-- (6) Commandes acceptées de la Précommande au Packaging inclus. En transit : machines remises au
-- transporteur, plus de commande (décision par défaut, à confirmer par Hugo). Pour revenir en
-- arrière, retirer 'in_transit' de la liste ci-dessous : c'est la seule source de la règle
-- (triggers Order_guard, vue order_payment_balance, batch_is_public, src/server/shop.ts).
-- batch_is_public en dépend : un lot en transit n'est plus listé publiquement.
CREATE OR REPLACE FUNCTION "batch_accepts_orders"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st NOT IN ('draft', 'survey', 'in_transit', 'closed', 'cancelled')
$$;

-- ─── (1) Priorité à l'ouverture des précommandes ───

-- Fin de la journée de priorité : première ouverture des précommandes + 1 jour, pour un lot passé
-- par le sondage ET qui a au moins une wishlist active (non retirée). NULL : pas de priorité (lot
-- ouvert sans sondage, aucune wishlist active, ou précommandes pas encore ouvertes). Si la dernière
-- wishlist active est retirée pendant la journée, la priorité cesse pour tout le monde.
CREATE OR REPLACE FUNCTION "batch_priority_ends_at"(b uuid) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT min(p."created_at") + interval '1 day'
  FROM "BatchStatusTransition" p
  WHERE p."batch_id" = b AND p."to_status" = 'preorder'
    AND EXISTS (SELECT 1 FROM "BatchStatusTransition" s WHERE s."batch_id" = b AND s."to_status" = 'survey')
    AND EXISTS (SELECT 1 FROM "Wishlist" w WHERE w."batch_id" = b AND w."cancelled_at" IS NULL)
$$;

-- Remplacée par user_priority_quota (la priorité se compte en machines).
DROP FUNCTION "user_has_batch_priority"(uuid, uuid);

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
CREATE OR REPLACE FUNCTION "order_priority_allows"(b uuid, u uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce("order_priority_machines_left"(b, u) > 0, true)
$$;

-- ─── Factures ───
-- Création : inchangée sauf
--   * Order_priority_window : pendant la journée de priorité, quota de machines non épuisé (le
--     nombre de lignes est contrôlé ligne par ligne, OrderLine_priority_quota) ;
--   * Order_expired_cooldown : par utilisateur ET par lot ; une facture annulée (cancelled) ne
--     déclenche pas de délai.
-- Mises à jour : transitions ajoutées
--   pending_payment → cancelled : annulation volontaire, rien reçu (Order_cancel_unpaid), réservation
--     encore vivante (Order_cancel_expired : une facture déjà expirée n'a plus rien à libérer, et
--     l'annuler contournerait le délai) ;
--   cancelled → paid | refunded : paiement arrivé après l'annulation, décision de l'admin (aucune
--     obligation d'accepter, contrairement à Order_late_payment_refund) ; paid exige toujours un lot
--     ouvert aux commandes et la place (Order_batch_open, Batch_stock).
-- cancelled_at : posé seulement au passage à cancelled, ensuite immuable (Order_immutable).
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
      RAISE EXCEPTION 'Batch %: until % preorders are reserved to users with wishlists, within their number of wishlists (constraint "Order_priority_window")',
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
        WHERE o."user_id" = NEW."user_id" AND o."batch_id" = NEW."batch_id" AND o."id" <> NEW."id"
          AND o."status" IN ('pending_payment', 'expired') AND o."received_sats" < o."expected_sats"
          AND o."expires_at" <= now()
          AND o."expires_at" > now() - make_interval(mins => s."expired_order_cooldown_minutes")
      ) THEN
        RAISE EXCEPTION 'User % let an order on batch % expire less than % minutes ago (constraint "Order_expired_cooldown")',
          NEW."user_id", NEW."batch_id", s."expired_order_cooldown_minutes"
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
  -- un paiement validé avant l'annulation la fait donc échouer.
  IF NEW."status" = 'cancelled' AND OLD."received_sats" > 0 THEN
    RAISE EXCEPTION 'Order %: a payment was received, it cannot be cancelled (constraint "Order_cancel_unpaid")', OLD."id"
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
  -- tardif qui tient dans le stock) doit être accepté. Un paiement incomplet (appoint jamais venu,
  -- remboursement choisi par l'utilisateur), un lot fermé aux commandes ou une facture annulée
  -- (décision de l'admin) se remboursent.
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

-- Lignes : ajout de OrderLine_priority_quota (pendant la journée de priorité, les machines de
-- l'utilisateur qui occupent le stock du lot, lignes de cette facture comprises, ne dépassent pas
-- ses wishlists actives). Les lignes de la même instruction déjà insérées sont visibles ici (trigger
-- BEFORE ROW) ; les factures concurrentes du même utilisateur attendent le verrou de l'utilisateur
-- (Order_guard), elles voient donc les lignes validées.
CREATE OR REPLACE FUNCTION "OrderLine_guard"() RETURNS trigger
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

-- ─── (3) Remboursements : qui paie les frais réseau ───

-- Sats sortis du solde d'une facture par un remboursement : ce que reçoit l'utilisateur, plus les
-- frais réseau quand ils sont à sa charge (déduits de ce qu'il a avancé). Frais à la charge de la
-- boutique : tracés à part, jamais déduits. Source unique pour Order_check, Order_refunded_in_full
-- et order_payment_balance.
CREATE FUNCTION "refund_debited_sats"(r "Refund") RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT r."amount_sats" + CASE WHEN r."network_fee_payer" = 'user' THEN coalesce(r."network_fee_sats", 0) ELSE 0 END
$$;

-- Frais à la charge de l'utilisateur (Refund_user_fee_allowed) : seulement le remboursement qu'il a
-- choisi pour une facture expirée partiellement payée (rien d'accepté, 0 < reçu < attendu, réservation
-- terminée) d'un lot qui accepte encore les commandes (sinon l'appoint est impossible : il n'a pas de
-- choix, les frais restent à la boutique). Verrou de la ligne Order (comme Payment_apply) : un appoint
-- validé avant fait échouer la demande (paiement complet, ou montants à recalculer : Order_refunded_in_full).
CREATE FUNCTION "Refund_check_user_fee"() RETURNS trigger
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
  IF NOT (o."status" IN ('pending_payment', 'expired') AND o."expires_at" <= now()
          AND o."received_sats" > 0 AND o."received_sats" < o."expected_sats"
          AND coalesce("batch_accepts_orders"(bst), false)) THEN
    RAISE EXCEPTION 'Order %: network fees are charged to the user only for the refund of an expired, partially paid order of an open batch (constraint "Refund_user_fee_allowed")', NEW."order_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_fee_allowed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Refund_user_fee_allowed"
  BEFORE INSERT ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION "Refund_check_user_fee"();

-- Remboursement : jamais supprimé ; facture, nature et payeur des frais figés ; montants figés une
-- fois envoyé (les frais à la charge de l'utilisateur et amount_sats s'ajustent jusqu'à l'envoi).
CREATE OR REPLACE FUNCTION "Refund_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund is never deleted (constraint "Refund_append_only")'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'Refund_append_only';
  END IF;
  IF NEW."order_id" <> OLD."order_id" OR NEW."kind" <> OLD."kind" OR NEW."network_fee_payer" <> OLD."network_fee_payer"
     OR (OLD."sent_at" IS NOT NULL AND (NEW."amount", NEW."amount_sats", NEW."network_fee_sats")
                                        IS DISTINCT FROM (OLD."amount", OLD."amount_sats", OLD."network_fee_sats")) THEN
    RAISE EXCEPTION 'Refund %: immutable field changed (constraint "Refund_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- Cohérence d'une facture (différé). v5b : cancelled se comporte comme une facture impayée (ni
-- remboursement ni machine tant qu'elle n'est pas passée à paid ou refunded) ; les sats sortis du
-- solde comptent les frais à la charge de l'utilisateur (refund_debited_sats).
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
  s_debited bigint;
  exact numeric;
BEGIN
  SELECT * INTO o FROM "Order" WHERE "id" = oid;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM "Batch_lock"(o."batch_id"); -- conversion concurrente d'une même wishlist

  SELECT count(*), count(*) FILTER (WHERE "refund_id" IS NULL), coalesce(sum("amount"), 0)
  INTO n_lines, n_active, s_lines
  FROM "OrderLine" WHERE "order_id" = oid;
  SELECT coalesce(sum(r."amount") FILTER (WHERE r."kind" <> 'overpayment'), 0),
         coalesce(sum(r."amount_sats") FILTER (WHERE r."kind" <> 'overpayment'), 0),
         coalesce(sum(r."amount_sats") FILTER (WHERE r."kind" = 'overpayment'), 0),
         coalesce(sum("refund_debited_sats"(r)), 0)
  INTO s_cents, s_prorata_sats, s_over_sats, s_debited
  FROM "Refund" r WHERE r."order_id" = oid;

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
  IF s_cents > o."total_amount" OR s_debited > o."received_sats" THEN
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

-- Remboursement intégral : au passage à refunded, tout ce qui a été reçu est sorti du solde (versé à
-- l'utilisateur, plus les frais à sa charge le cas échéant). Un paiement arrivé ensuite n'est pas
-- refusé : il apparaît dans order_payment_balance (needs_admin_decision).
CREATE OR REPLACE FUNCTION "Order_check_refunded_in_full"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  received bigint;
  refunded bigint;
BEGIN
  SELECT o."received_sats", coalesce((SELECT sum("refund_debited_sats"(r)) FROM "Refund" r WHERE r."order_id" = o."id"), 0)
  INTO received, refunded
  FROM "Order" o WHERE o."id" = NEW."id";
  IF refunded <> received THEN
    RAISE EXCEPTION 'Refunded order %: refunds % sats <> received % sats (constraint "Order_refunded_in_full")', NEW."id", refunded, received
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunded_in_full';
  END IF;
  RETURN NULL;
END;
$$;

-- ─── (3)(5) Solde de paiement d'une facture (calculé à la lecture, jamais stocké) ───
-- Colonnes existantes (même ordre, mêmes types), sens précisé :
--   refunded_sats      sats sortis du solde par les remboursements (versés + frais à la charge de
--                      l'utilisateur) ;
--   outstanding_sats   appoint attendu (facture en attente ou expirée) ;
--   refund_due_sats    à renvoyer d'office par la boutique (frais à sa charge) : excédent d'une
--                      facture payée. Les sommes reçues après un remboursement intégral, une
--                      annulation, ou sur un lot fermé aux commandes n'y sont plus : voir
--                      needs_admin_decision ;
--   awaiting_decision  paiement complet sur une facture en attente ou expirée d'un lot ouvert aux
--                      commandes : à accepter (paid) s'il reste de la place, sinon à rembourser
--                      (Order_fits_stock), sans intervention humaine.
-- Colonnes ajoutées :
--   awaiting_user_decision  facture expirée partiellement payée d'un lot ouvert : l'utilisateur
--                           choisit l'appoint ou le remboursement (frais à sa charge) ;
--   needs_admin_decision    sats reçus non affectés (ni acceptés pour la marchandise, ni remboursés)
--                           sur une facture remboursée, annulée, ou impayée d'un lot fermé aux
--                           commandes : « à traiter » au backoffice, pas de remboursement automatique ;
--   unsettled_sats          sats reçus non affectés : excédent pour une facture payée, sinon reçu −
--                           sorti du solde (montant en jeu pour les décisions ci-dessus).
CREATE OR REPLACE VIEW "order_payment_balance" AS
WITH b AS (
  SELECT
    o.*,
    coalesce(r."debited", 0)::bigint AS "debited",
    coalesce(r."over_sats", 0)::bigint AS "over_sats",
    coalesce("batch_accepts_orders"(ba."status"), false) AS "batch_open"
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
)
SELECT
  u."id" AS "order_id",
  u."batch_id",
  u."user_id",
  u."status",
  u."expected_sats",
  u."received_sats",
  u."debited" AS "refunded_sats",
  CASE WHEN u."status" IN ('pending_payment', 'expired')
       THEN greatest(u."expected_sats" - u."received_sats", 0) ELSE 0 END::bigint AS "outstanding_sats",
  CASE WHEN u."status" = 'paid' THEN u."unsettled" ELSE 0 END::bigint AS "refund_due_sats",
  (u."status" IN ('pending_payment', 'expired') AND u."batch_open"
   AND u."received_sats" >= u."expected_sats") AS "awaiting_decision",
  (u."status" IN ('pending_payment', 'expired') AND u."batch_open" AND u."expires_at" <= now()
   AND u."received_sats" > 0 AND u."received_sats" < u."expected_sats") AS "awaiting_user_decision",
  (u."unsettled" > 0 AND (u."status" IN ('refunded', 'cancelled')
                          OR (u."status" IN ('pending_payment', 'expired') AND NOT u."batch_open"))) AS "needs_admin_decision",
  u."unsettled" AS "unsettled_sats"
FROM u;
