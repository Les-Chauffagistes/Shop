-- ═════════════════════════════════════════════
-- v5i : décisions de Hugo du 2026-10-09 sur les questions ouvertes du jalon 4 (roadmap, « Décisions de
-- Hugo sur les questions ouvertes du jalon 4 »).
--   1. E-mail du client : figé sur la facture (Order.contact_email), recueilli à sa création, format
--      contrôlé (CHECK), jamais modifié ensuite (Order_contact_email_frozen). « Dernier e-mail connu » d'un
--      utilisateur : vue user_contact_email (dernière facture qui en porte un), pas de copie sur User.
--      Obligatoire à la création : trigger Order_contact_email_required, créé DÉSACTIVÉ ici et activé par
--      la migration suivante, livrée avec le backend qui envoie l'e-mail (sinon toute création de facture
--      échouerait d'ici là).
--   2. Classer sans suite (OrderExcessDismissal, append-only) : sats reçus non affectés d'une facture payée,
--      remboursée ou annulée, au plus égaux aux frais réseau d'un remboursement, une seule fois par facture.
--      Ils sortent du solde (order_payment_balance.unsettled_sats, colonne dismissed_sats ajoutée en fin) :
--      la facture sort de « À traiter ». Plafonds (Order_check) et remboursement intégral comptent ces sats.
--   3. Reliquat d'excédent d'un renoncement complet : il ne part plus obligatoirement avec l'annulation.
--      Order_refunded_in_full est assoupli pour une facture qui a été payée (paid_at) : le prix payé doit
--      être entièrement rendu (annulations et rabais >= expected_sats), l'excédent peut rester ; il reste
--      alors « à traiter » (needs_admin_decision, facture remboursée) et l'admin choisit : rembourser
--      (overpayment) ou classer sans suite. Interdire en base le reliquat dans un renoncement de l'utilisateur
--      lui-même casserait le backend actuel (il l'écrit d'office) : contrainte à poser avec lui (voir rapport).
--   4. Lot qui ferme les commandes sans être annulé (En transit…) : comme pour l'annulation (v5h), ses
--      factures en attente sans aucun versement et à réservation vivante passent à « annulée » dans la
--      transaction de la transition. Règle unique : batch_accepts_orders(to_status) faux.
--   5. Option retirée d'un lot pour une wishlist figée (lot sorti du brouillon et du sondage) : la
--      configuration revient à la valeur par défaut du menu (0 €) au retrait (BatchOptionValue.enabled =
--      false), ou à l'ouverture des précommandes pour un retrait fait au sondage (au sondage, rien ne change :
--      l'utilisateur voit le choix « non proposé » et corrige lui-même). Exception contrôlée à l'immuabilité :
--      seul ce retour au défaut d'une valeur que le lot ne propose plus est permis
--      (configuration_item_withdrawal_reset) ; chaque ajustement d'une wishlist est journalisé
--      (WishlistOptionWithdrawal, append-only) pour prévenir l'utilisateur. La wishlist reste, sa priorité
--      aussi. Reprise : les wishlists figées qui portent déjà une valeur retirée sont ajustées et journalisées.
-- Données touchées à l'application : seulement la reprise (5), tracée ligne par ligne (ancienne valeur et
-- ancien prix au journal). Rien n'est supprimé.
-- Retour arrière (dans l'esprit) : reposer Order_check et Order_check_refunded_in_full de v5f/v5b (à vérifier
-- sur les données : une facture remboursée en gardant son excédent, ou un classement, les violerait ; les
-- garder alors), la vue order_payment_balance de v5f, BatchStatusTransition_apply de v5h,
-- Wishlist_guard_configuration_frozen de wishlist_configuration_frozen ; DROP des triggers et fonctions
-- ajoutés. Les tables OrderExcessDismissal, WishlistOptionWithdrawal et la colonne contact_email portent des
-- données : les garder (inertes). Les items ramenés au défaut ne sont pas restaurés (le journal le permet).
-- ═════════════════════════════════════════════

-- ─── (1) E-mail du client, figé sur la facture ─────────────

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "contact_email" TEXT;

-- Format raisonnable, sans vérification par envoi : une partie locale, un @, un domaine à au moins deux
-- libellés non vides, aucun espace, 254 caractères au plus (RFC 5321). Casse conservée telle que saisie.
ALTER TABLE "Order" ADD CONSTRAINT "Order_contact_email_check" CHECK (
  "contact_email" IS NULL OR (
    char_length("contact_email") <= 254
    AND "contact_email" ~ '^[^[:space:]@]+@[^[:space:]@.]+(\.[^[:space:]@.]+)+$'));

-- Instantané : à qui l'on écrit pour cette facture. Jamais modifié une fois posé ; une facture antérieure
-- à v5i (sans e-mail) peut en recevoir un, une fois (reprise par l'admin après contact).
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

-- Obligatoire à la création de la facture (pas pour la wishlist). Les factures antérieures n'en ont pas :
-- le contrôle ne vaut qu'à l'insertion (un CHECK NOT VALID bloquerait aussi leurs changements de statut).
CREATE FUNCTION "Order_check_contact_email"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."contact_email" IS NULL THEN
    RAISE EXCEPTION 'An order is created with the contact e-mail of the customer (constraint "Order_contact_email_required")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_contact_email_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_contact_email_required" BEFORE INSERT ON "Order"
FOR EACH ROW EXECUTE FUNCTION "Order_check_contact_email"();
-- Désactivé jusqu'à ce que le backend envoie l'e-mail : la migration suivante fait
-- ALTER TABLE "Order" ENABLE TRIGGER "Order_contact_email_required";
ALTER TABLE "Order" DISABLE TRIGGER "Order_contact_email_required";

-- Dernier e-mail connu d'un utilisateur (pour l'admin et pour préremplir la facture suivante) : celui de
-- sa facture la plus récente qui en porte un. Calculé, jamais stocké : une seule source, la facture.
CREATE VIEW "user_contact_email" AS
SELECT DISTINCT ON (o."user_id")
  o."user_id",
  o."contact_email",
  o."id" AS "order_id",
  o."created_at"
FROM "Order" o
WHERE o."contact_email" IS NOT NULL
ORDER BY o."user_id", o."created_at" DESC, o."id" DESC;

-- ─── (2) Classer sans suite ─────────────

-- CreateTable
CREATE TABLE "OrderExcessDismissal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "sats" BIGINT NOT NULL,
    "network_fee_sats" BIGINT NOT NULL,
    "reason" TEXT,
    "dismissed_by_auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "OrderExcessDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex : une seule fois par facture
CREATE UNIQUE INDEX "OrderExcessDismissal_order_id_key" ON "OrderExcessDismissal"("order_id");

-- AddForeignKey
ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_sats_check" CHECK ("sats" > 0);
ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_network_fee_sats_check" CHECK ("network_fee_sats" > 0);
-- Rendre la somme coûterait au moins autant qu'elle vaut : seulement si elle ne dépasse pas les frais
ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_within_fee_check" CHECK ("sats" <= "network_fee_sats");
ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_reason_check" CHECK (btrim("reason") <> '');
ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_dismissed_by_check" CHECK ("dismissed_by_auth_user_id" > 0);

CREATE TRIGGER "OrderExcessDismissal_append_only"
  BEFORE UPDATE OR DELETE ON "OrderExcessDismissal"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

-- Classement : sous verrou de la facture (comme Payment_apply et les remboursements), la facture est payée,
-- remboursée ou annulée (jamais en attente ou expirée : l'appoint reste possible ou l'utilisateur décide) et
-- `sats` est exactement ce qui reste non affecté (excédent d'une facture payée, sinon reçu − sorti du solde,
-- remboursements non envoyés compris). Un second classement de la même facture : index unique.
CREATE FUNCTION "OrderExcessDismissal_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  debited bigint;
  over_sats bigint;
  unsettled bigint;
BEGIN
  SELECT * INTO o FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- clé étrangère
  END IF;
  IF o."status" NOT IN ('paid', 'refunded', 'cancelled') THEN
    RAISE EXCEPTION 'Order % is %: only the sats left over on a paid, refunded or cancelled order can be dismissed (constraint "OrderExcessDismissal_status")', o."id", o."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderExcessDismissal_status';
  END IF;
  SELECT coalesce(sum("refund_debited_sats"(r)), 0),
         coalesce(sum("refund_debited_sats"(r)) FILTER (WHERE r."kind" = 'overpayment'), 0)
  INTO debited, over_sats
  FROM "Refund" r WHERE r."order_id" = o."id";
  unsettled := CASE WHEN o."status" = 'paid' THEN greatest(o."received_sats" - o."expected_sats" - over_sats, 0)
                    ELSE o."received_sats" - debited END;
  IF NEW."sats" IS DISTINCT FROM unsettled OR unsettled <= 0 THEN
    RAISE EXCEPTION 'Order %: % sats are left over, not % (constraint "OrderExcessDismissal_amount")', o."id", unsettled, NEW."sats"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderExcessDismissal_amount';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OrderExcessDismissal_check" BEFORE INSERT ON "OrderExcessDismissal"
FOR EACH ROW EXECUTE FUNCTION "OrderExcessDismissal_check"();

-- Cohérence de la facture au COMMIT (plafonds avec les remboursements de la même transaction)
CREATE CONSTRAINT TRIGGER "OrderExcessDismissal_order_check" AFTER INSERT ON "OrderExcessDismissal"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_order"();

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

-- Cohérence d'une facture (différé). v5i : les sats classés sans suite sortent du solde comme les
-- remboursements (Order_refunds : remboursés + classés <= reçu ; Refund_overpayment : excédents remboursés
-- + classés <= reçu − attendu). Le reste est inchangé depuis v5f.
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
  -- Plafonds : centimes <= facturé ; sats sortis du solde (brut, frais de l'utilisateur compris) et sats
  -- classés sans suite <= reçu.
  IF s_cents > o."total_amount" OR s_debited + s_dismissed > o."received_sats" THEN
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
  IF o."status" = 'paid' THEN
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

-- ─── (3) Remboursement intégral : l'excédent d'une commande payée peut rester « à traiter » ─────────────
-- Au passage à refunded :
--   * facture jamais acceptée (paid_at NULL : paiement partiel, tardif, après annulation…) : tout ce qui a
--     été reçu est sorti du solde (remboursé, frais de l'utilisateur compris) ou classé sans suite ;
--   * commande payée (paid_at posé : renoncement ou annulation de toute la facture) : le prix payé est
--     entièrement rendu (annulations et rabais, en brut, >= expected_sats). L'excédent éventuel peut partir
--     dans la même transaction (reliquat) ou rester : la facture est alors « à traiter »
--     (order_payment_balance.needs_admin_decision) et l'admin choisit (rembourser ou classer sans suite).
-- Un paiement arrivé ensuite n'est pas refusé : il apparaît dans order_payment_balance (needs_admin_decision).
CREATE OR REPLACE FUNCTION "Order_check_refunded_in_full"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  refunded bigint;
  price_refunded bigint;
  dismissed bigint;
BEGIN
  SELECT * INTO o FROM "Order" WHERE "id" = NEW."id";
  SELECT coalesce(sum("refund_debited_sats"(r)), 0),
         coalesce(sum("refund_debited_sats"(r)) FILTER (WHERE r."kind" <> 'overpayment'), 0)
  INTO refunded, price_refunded
  FROM "Refund" r WHERE r."order_id" = o."id";
  SELECT coalesce(sum("sats"), 0) INTO dismissed FROM "OrderExcessDismissal" WHERE "order_id" = o."id";
  IF o."paid_at" IS NULL AND refunded + dismissed <> o."received_sats" THEN
    RAISE EXCEPTION 'Refunded order %: refunds % sats <> received % sats (constraint "Order_refunded_in_full")', o."id", refunded + dismissed, o."received_sats"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunded_in_full';
  END IF;
  IF o."paid_at" IS NOT NULL AND price_refunded < o."expected_sats" THEN
    RAISE EXCEPTION 'Refunded order %: the price paid (% sats) is not entirely refunded (% sats) (constraint "Order_refunded_in_full")', o."id", o."expected_sats", price_refunded
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunded_in_full';
  END IF;
  RETURN NULL;
END;
$$;

-- Solde de paiement. Colonnes v5f inchangées (ordre, types) ; les sats classés sans suite sortent du solde
-- non affecté (unsettled_sats, refund_due_sats, donc needs_admin_decision, overpayment_unrefunded et
-- needs_admin_attention) ; refunded_sats reste les seuls remboursements. Colonne ajoutée en fin :
-- dismissed_sats (sats classés sans suite, OrderExcessDismissal).
CREATE OR REPLACE VIEW "order_payment_balance" AS
WITH b AS (
  SELECT
    o.*,
    coalesce(r."debited", 0)::bigint AS "debited",
    coalesce(r."over_sats", 0)::bigint AS "over_sats",
    coalesce(r."unsent_sats", 0)::bigint AS "unsent_sats",
    coalesce(r."unsent_without_destination", false) AND o."refund_address" IS NULL AS "address_missing",
    coalesce(dm."sats", 0)::bigint AS "dismissed",
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
), u AS (
  SELECT b.*,
    CASE WHEN b."status" = 'paid' THEN greatest(b."received_sats" - b."expected_sats" - b."over_sats" - b."dismissed", 0)
         ELSE b."received_sats" - b."debited" - b."dismissed" END::bigint AS "unsettled"
  FROM b
), d AS (
  SELECT u.*,
    (u."status" IN ('pending_payment', 'expired') AND u."batch_open" AND u."expires_at" <= now()
     AND u."received_sats" > 0 AND u."received_sats" < u."expected_sats") AS "user_decision",
    (u."unsettled" > 0 AND (u."status" IN ('refunded', 'cancelled')
                            OR (u."status" IN ('pending_payment', 'expired') AND NOT u."batch_open"))) AS "admin_decision",
    (u."status" IN ('pending_payment', 'expired') AND u."batch_open"
     AND u."received_sats" >= u."expected_sats") AS "full_payment",
    (u."status" = 'paid' AND u."unsettled" > 0) AS "excess"
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
  d."dismissed" AS "dismissed_sats"
FROM d;

-- ─── (4) Lot qui ferme les commandes : factures impayées annulées ─────────────
-- BatchStatusTransition_apply de v5h, à l'identique sauf : la condition de l'annulation des factures (toute
-- transition vers un statut qui n'accepte pas de commande : batch_accepts_orders faux, soit cancelled,
-- in_transit, closed… ; sans effet vers draft ou survey, aucune facture n'y existe) et, pour (5), l'ajustement
-- des wishlists qui se figent (batch_reset_withdrawn_choices, défini plus bas : résolu à l'exécution).
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
  -- sans aucun versement sont annulées avec la transition (cancelled_at posé par Order_guard). Le WHERE est
  -- réévalué sous le verrou de la ligne : un versement validé entre-temps exclut la facture (elle reste alors
  -- « à traiter »). Les factures expirées (expires_at passé) n'ont plus rien à annuler (Order_cancel_expired).
  IF NOT coalesce("batch_accepts_orders"(NEW."to_status"), false) THEN
    UPDATE "Order" SET "status" = 'cancelled', "updated_at" = now()
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

-- ─── (5) Option retirée d'un lot : wishlists ramenées au défaut, ajustement journalisé ─────────────

-- CreateTable
CREATE TABLE "WishlistOptionWithdrawal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wishlist_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "withdrawn_value_id" UUID NOT NULL,
    "withdrawn_unit_price" BIGINT NOT NULL,
    "default_value_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "WishlistOptionWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WishlistOptionWithdrawal_user_id_created_at_idx" ON "WishlistOptionWithdrawal"("user_id", "created_at");
CREATE INDEX "WishlistOptionWithdrawal_wishlist_id_idx" ON "WishlistOptionWithdrawal"("wishlist_id");
CREATE INDEX "WishlistOptionWithdrawal_batch_id_idx" ON "WishlistOptionWithdrawal"("batch_id");

-- AddForeignKey
ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_wishlist_id_user_id_batch_id_fkey"
  FOREIGN KEY ("wishlist_id", "user_id", "batch_id") REFERENCES "Wishlist"("id", "user_id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_withdrawn_value_id_option_id_fkey"
  FOREIGN KEY ("withdrawn_value_id", "option_id") REFERENCES "OptionValue"("id", "option_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_default_value_id_option_id_fkey"
  FOREIGN KEY ("default_value_id", "option_id") REFERENCES "OptionValue"("id", "option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_withdrawn_unit_price_check" CHECK ("withdrawn_unit_price" >= 0);
ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_values_check" CHECK ("withdrawn_value_id" <> "default_value_id");

CREATE TRIGGER "WishlistOptionWithdrawal_append_only"
  BEFORE UPDATE OR DELETE ON "WishlistOptionWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

-- Le seul changement permis sur une configuration de wishlist figée : un item dont la valeur n'est plus
-- proposée par le lot (retirée) revient à la valeur par défaut de son menu, gratuite. Même menu, même
-- configuration. Source unique de l'exception (garde d'immuabilité et journal).
CREATE FUNCTION "configuration_item_withdrawal_reset"(o "ConfigurationItem", n "ConfigurationItem") RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT n."configuration_id" = o."configuration_id"
     AND n."model_id" = o."model_id"
     AND n."option_id" = o."option_id"
     AND n."option_value_id" <> o."option_value_id"
     AND n."unit_price" = 0
     AND EXISTS (SELECT 1 FROM "OptionValue" v WHERE v."id" = n."option_value_id" AND v."option_id" = n."option_id" AND v."is_default")
     AND NOT EXISTS (
       SELECT 1 FROM "Configuration" c CROSS JOIN LATERAL "batch_offered_values"(c."batch_id") ov
       WHERE c."id" = o."configuration_id" AND ov."option_value_id" = o."option_value_id")
$$;

-- Garde d'immuabilité (wishlist_configuration_frozen) redéfinie avec deux exceptions :
--   * ConfigurationItem : le retour au défaut d'une valeur retirée (configuration_item_withdrawal_reset) ;
--   * Configuration : la seule date de dernière modification (ConfigurationItem_touch, qui suit ce retour).
CREATE OR REPLACE FUNCTION "Wishlist_guard_configuration_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Branches IF : plpgsql ne résout NEW.<champ> / OLD.<champ> que dans la branche exécutée
  IF TG_TABLE_NAME = 'Configuration' THEN
    IF TG_OP = 'UPDATE'
       AND (NEW."id", NEW."batch_id", NEW."model_id", NEW."base_price", NEW."created_at", NEW."locked_at")
           IS NOT DISTINCT FROM (OLD."id", OLD."batch_id", OLD."model_id", OLD."base_price", OLD."created_at", OLD."locked_at") THEN
      RETURN NEW;
    END IF;
    PERFORM "Wishlist_check_configuration_open"(OLD."id");
  ELSIF TG_TABLE_NAME = 'ConfigurationItem' THEN
    IF TG_OP = 'UPDATE' AND "configuration_item_withdrawal_reset"(OLD, NEW) THEN
      RETURN NEW;
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM "Wishlist_check_configuration_open"(OLD."configuration_id");
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM "Wishlist_check_configuration_open"(NEW."configuration_id");
    END IF;
  ELSIF NEW."configuration_id" IS DISTINCT FROM OLD."configuration_id" THEN -- Wishlist
    PERFORM "Wishlist_check_configuration_open"(OLD."configuration_id");
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Journal : chaque retour au défaut d'une valeur retirée dans la configuration d'une wishlist (retirée ou
-- non, convertie ou non : l'application choisit qui prévenir), quel que soit l'écrivain.
CREATE FUNCTION "ConfigurationItem_log_withdrawal"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "configuration_item_withdrawal_reset"(OLD, NEW) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "WishlistOptionWithdrawal" ("wishlist_id", "user_id", "batch_id", "option_id",
                                          "withdrawn_value_id", "withdrawn_unit_price", "default_value_id")
  SELECT w."id", w."user_id", w."batch_id", NEW."option_id", OLD."option_value_id", OLD."unit_price", NEW."option_value_id"
  FROM "Wishlist" w WHERE w."configuration_id" = NEW."configuration_id";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "ConfigurationItem_log_withdrawal" AFTER UPDATE OF "option_value_id" ON "ConfigurationItem"
FOR EACH ROW WHEN (OLD."option_value_id" IS DISTINCT FROM NEW."option_value_id")
EXECUTE FUNCTION "ConfigurationItem_log_withdrawal"();

-- Statuts où la configuration d'une wishlist est figée et où le lot accepte encore des configurations :
-- précommande à en transit (ni brouillon ni sondage, où l'utilisateur corrige lui-même ; ni clos ni annulé).
CREATE FUNCTION "batch_wishlists_frozen"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st NOT IN ('draft', 'survey', 'closed', 'cancelled')
$$;

-- Ramène au défaut du menu (0 €) chaque choix d'une configuration ouverte du lot (wishlist ; celles des lignes
-- de commande sont verrouillées et gardent leur choix) que le lot ne propose plus. Le défaut est toujours
-- proposé (BatchOptionValue_default_enabled). Renvoie le nombre d'items ajustés.
CREATE FUNCTION "batch_reset_withdrawn_choices"(b uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  UPDATE "ConfigurationItem" ci
  SET "option_value_id" = v."id", "unit_price" = 0
  FROM "Configuration" c, "OptionValue" v
  WHERE c."id" = ci."configuration_id" AND c."batch_id" = b AND c."locked_at" IS NULL
    AND v."option_id" = ci."option_id" AND v."is_default" AND v."id" <> ci."option_value_id"
    AND NOT EXISTS (SELECT 1 FROM "batch_offered_values"(b) ov WHERE ov."option_value_id" = ci."option_value_id");
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Retrait d'une valeur sur un lot dont les wishlists sont figées (ligne insérée ou passée à enabled = false).
-- Le défaut lui-même n'est jamais retiré (BatchOptionValue_default_enabled, différé, nomme l'erreur).
CREATE FUNCTION "BatchOptionValue_reset_withdrawn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "batch_wishlists_frozen"((SELECT "status" FROM "Batch" WHERE "id" = NEW."batch_id")) THEN
    PERFORM "batch_reset_withdrawn_choices"(NEW."batch_id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "BatchOptionValue_withdraw_from_wishlists" AFTER INSERT OR UPDATE OF "enabled" ON "BatchOptionValue"
FOR EACH ROW WHEN (NOT NEW."enabled")
EXECUTE FUNCTION "BatchOptionValue_reset_withdrawn"();

-- Reprise : wishlists figées qui portent déjà une valeur retirée de leur lot. Chaque ajustement est journalisé
-- par ConfigurationItem_log_withdrawal (ancienne valeur et ancien prix).
SELECT "batch_reset_withdrawn_choices"(b."id") FROM "Batch" b WHERE "batch_wishlists_frozen"(b."status");
