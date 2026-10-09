-- ═════════════════════════════════════════════
-- v5f : motif des remboursements et frais réseau, journal des adresses de remboursement
-- (décisions de Hugo des 2026-10-07 et 2026-10-08, roadmap « Décisions de Hugo sur les questions de la
-- v5e » et « Tranché par Hugo le 2026-10-08 »).
--   1. Motif d'un remboursement (Refund.cause, enum refund_cause), figé à la création. Qui paie les frais
--      réseau se déduit du motif par UNE fonction, refund_cause_fee_payer(cause) :
--        boutique     : shop_stock (souci de stock, surplus, lot abandonné), shop_defective_machine,
--                       late_payment_no_room, discount, admin_other (autre annulation par l'admin) ;
--        utilisateur  : user_renounce, partial_payment (paiement partiel, choix de l'utilisateur ou
--                       remboursement par l'admin sans réponse), overpayment (excédent de paiement).
--      La règle est contrôlée à l'insertion par un trigger (Refund_cause_fee_payer), pas par un CHECK :
--      inverser un défaut = redéfinir la fonction, sans toucher aux remboursements déjà créés.
--      Refund_initiator_check est remplacé par Refund_cause_check (motif, nature, initiateur).
--   2. Prorata et plafond d'excédent sur le BRUT (sats sortis du solde = versé + frais à la charge de
--      l'utilisateur, refund_debited_sats) : refund_prorata_sats renvoie le brut, l'utilisateur reçoit
--      brut − frais (> 0, Refund_user_net_positive).
--   3. Aucune décision automatique quand le montant ne dépasse pas les frais : un remboursement du
--      traitement automatique (system) doit dépasser ses frais (Refund_system_above_fee). Un excédent non
--      remboursé d'une facture payée est « à traiter » (order_payment_balance.overpayment_unrefunded,
--      compris dans needs_admin_attention) : l'admin décide.
--   4. Frais portés par une seule ligne : le reliquat d'excédent qui accompagne l'annulation de toute la
--      facture (kind = overpayment, motif autre que overpayment) ne porte jamais de frais à la charge de
--      l'utilisateur (Refund_fee_single_line_check) ; celui d'un renoncement n'existe que si la facture passe
--      à refunded (Refund_cause_remainder, différé).
--   5. Journal append-only des changements d'adresse de remboursement (OrderRefundAddressChange), alimenté
--      par trigger ; l'acteur est déclaré par la transaction (declare_actor) : sans déclaration, le
--      changement est refusé (OrderRefundAddressChange_actor).
-- Aucune donnée supprimée : colonne cause ajoutée et reprise (voir plus bas), contraintes et fonctions
-- redéfinies, vues redéfinies (colonnes existantes inchangées, une colonne ajoutée en fin de chacune), une
-- table ajoutée. Les remboursements existants gardent leur payeur de frais (la règle ne vaut qu'à la création).
-- Retour arrière (dans l'esprit) : DROP du trigger Order_refund_address_log, de la table
-- OrderRefundAddressChange et de declare_actor ; recréer les vues, Order_check, refund_prorata_sats,
-- Refund_check_renounce et le trigger Refund_user_fee_allowed (fonction Refund_check_user_fee) de v5e ;
-- DROP du trigger Refund_cause_rules et de ses fonctions ; reposer Refund_initiator_check et
-- Refund_fee_payer_check de v5e (à vérifier sur les données : des remboursements system ou user à frais
-- utilisateur créés depuis v5f le violeraient) ; la colonne cause porte des données : la garder (inerte).
-- ═════════════════════════════════════════════

CREATE TYPE "refund_cause" AS ENUM (
  'shop_stock', 'shop_defective_machine', 'user_renounce', 'partial_payment',
  'late_payment_no_room', 'overpayment', 'discount', 'admin_other');

CREATE TYPE "actor_kind" AS ENUM ('user', 'admin');

-- ─── (1) Qui paie les frais réseau ─────────────

-- Source unique de la règle « qui paie les frais réseau d'un remboursement ». Pour inverser un défaut,
-- redéfinir cette fonction dans une migration : seuls les remboursements créés ensuite sont concernés.
-- Pas de ELSE : un motif ajouté sans être classé ici est refusé (NULL ≠ payeur).
CREATE FUNCTION "refund_cause_fee_payer"(c "refund_cause") RETURNS "refund_fee_payer"
LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE c
    WHEN 'shop_stock'             THEN 'shop'  -- la boutique annule : stock, surplus, lot abandonné
    WHEN 'shop_defective_machine' THEN 'shop'  -- la boutique annule : machine défectueuse
    WHEN 'late_payment_no_room'   THEN 'shop'  -- paiement tardif complet, plus de place
    WHEN 'discount'               THEN 'shop'  -- rabais décidé par l'admin
    WHEN 'admin_other'            THEN 'shop'  -- autre annulation ou remboursement décidé par l'admin
    WHEN 'user_renounce'          THEN 'user'  -- l'utilisateur renonce à sa commande payée
    WHEN 'partial_payment'        THEN 'user'  -- remboursement d'un paiement partiel (choix ou sans réponse)
    WHEN 'overpayment'            THEN 'user'  -- excédent de paiement
  END)::"refund_fee_payer"
$$;

ALTER TABLE "Refund" ADD COLUMN "cause" "refund_cause";

-- Reprise (aucune facture en production) : frais à la charge de l'utilisateur = remboursement d'un paiement
-- partiel (seul cas permis avant v5f) ; initiateur utilisateur, frais boutique = renoncement (v5e) ; rabais ;
-- traitement automatique : excédent ou paiement tardif sans place ; le reste a été décidé par l'admin.
UPDATE "Refund" SET "cause" = CASE
  WHEN "kind" = 'discount' THEN 'discount'
  WHEN "network_fee_payer" = 'user' THEN 'partial_payment'
  WHEN "initiated_by" = 'user' THEN 'user_renounce'
  WHEN "initiated_by" = 'system' AND "kind" = 'overpayment' THEN 'overpayment'
  WHEN "initiated_by" = 'system' THEN 'late_payment_no_room'
  ELSE 'admin_other'
END::"refund_cause";
-- La reprise déclenche les contrôles différés de cohérence (Refund_order_check) : les exécuter maintenant,
-- sinon PostgreSQL refuse l'ALTER TABLE qui suit (« pending trigger events »).
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE "Refund" ALTER COLUMN "cause" SET NOT NULL;

-- Motif, nature et initiateur cohérents (remplace Refund_initiator_check) :
--   user_renounce          l'utilisateur ; ses lignes, ou le reliquat d'excédent quand il renonce à tout ;
--   partial_payment        l'utilisateur ou l'admin ; toutes les lignes d'une facture non acceptée ;
--   late_payment_no_room   traitement automatique ou admin ; toutes les lignes ;
--   overpayment            traitement automatique ou admin ; excédent ;
--   discount               admin seulement ; rabais ;
--   shop_stock             admin ou traitement automatique ; lignes, ou reliquat ;
--   shop_defective_machine, admin_other : admin ; lignes, ou reliquat.
ALTER TABLE "Refund" DROP CONSTRAINT "Refund_initiator_check";
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_cause_check" CHECK (
  CASE "cause"
    WHEN 'user_renounce'          THEN "initiated_by" = 'user' AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'partial_payment'        THEN "initiated_by" IN ('user', 'admin') AND "kind" = 'cancellation'
    WHEN 'late_payment_no_room'   THEN "initiated_by" IN ('system', 'admin') AND "kind" = 'cancellation'
    WHEN 'overpayment'            THEN "initiated_by" IN ('system', 'admin') AND "kind" = 'overpayment'
    WHEN 'discount'               THEN "initiated_by" = 'admin' AND "kind" = 'discount'
    WHEN 'shop_stock'             THEN "initiated_by" IN ('admin', 'system') AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'shop_defective_machine' THEN "initiated_by" = 'admin' AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'admin_other'            THEN "initiated_by" = 'admin' AND "kind" IN ('cancellation', 'overpayment')
  END);

-- Frais à la charge de l'utilisateur : montant connu (déduit de ce qu'il reçoit), quelle que soit la nature.
ALTER TABLE "Refund" DROP CONSTRAINT "Refund_fee_payer_check";
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_fee_payer_check" CHECK (
  "network_fee_payer" = 'shop' OR "network_fee_sats" IS NOT NULL);

-- (4) Frais portés par une seule ligne : le reliquat d'excédent d'une annulation de toute la facture part
-- dans le même envoi que l'annulation, qui porte les frais ; il n'en porte aucun à la charge de l'utilisateur.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_fee_single_line_check" CHECK (
  NOT ("kind" = 'overpayment' AND "cause" <> 'overpayment' AND "network_fee_payer" = 'user')
  OR "network_fee_sats" = 0);

-- ─── Règles à la création d'un remboursement (motif) ─────────────
-- Remplace Refund_user_fee_allowed (v5b à v5e) : les conditions du remboursement d'un paiement partiel
-- dépendent désormais du motif (partial_payment), plus de qui paie les frais.
DROP TRIGGER "Refund_user_fee_allowed" ON "Refund";
DROP FUNCTION "Refund_check_user_fee"();

CREATE FUNCTION "Refund_check_cause"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  bst "batch_status";
BEGIN
  -- (1) Payeur des frais = celui du motif, lu à la création (inverser un défaut ne touche pas l'existant)
  IF NEW."network_fee_payer" IS DISTINCT FROM "refund_cause_fee_payer"(NEW."cause") THEN
    RAISE EXCEPTION 'Refund of order %: cause % charges network fees to %, not % (constraint "Refund_cause_fee_payer")',
      NEW."order_id", NEW."cause", coalesce("refund_cause_fee_payer"(NEW."cause")::text, '(unclassified)'), NEW."network_fee_payer"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_cause_fee_payer';
  END IF;

  -- (3) Le traitement automatique ne décide rien quand le montant ne dépasse pas les frais : frais connus,
  -- et brut > frais (frais boutique : amount_sats est le brut ; frais utilisateur : Refund_user_net_positive).
  IF NEW."initiated_by" = 'system' AND (
       NEW."network_fee_sats" IS NULL
       OR (NEW."network_fee_payer" = 'shop' AND NEW."amount_sats" <= NEW."network_fee_sats")) THEN
    RAISE EXCEPTION 'Order %: an automatic refund must exceed its known network fees, otherwise the admin decides (constraint "Refund_system_above_fee")', NEW."order_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_system_above_fee';
  END IF;

  IF NEW."cause" = 'partial_payment' THEN
    -- Verrou de la ligne Order (comme Payment_apply) : un appoint validé avant est vu ici.
    SELECT * INTO o FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
    SELECT "status" INTO bst FROM "Batch" WHERE "id" = o."batch_id";
    IF NOT (o."status" IN ('pending_payment', 'expired')
            AND o."received_sats" > 0 AND o."received_sats" < o."expected_sats"
            AND coalesce("batch_accepts_orders"(bst), false)) THEN
      RAISE EXCEPTION 'Order %: a partial payment refund needs a partially paid, unaccepted order of an open batch (constraint "Refund_partial_payment_allowed")', NEW."order_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_partial_payment_allowed';
    END IF;
    -- L'admin ne tranche à la place de l'utilisateur qu'une facture dont la réservation est terminée.
    IF NEW."initiated_by" = 'admin' AND o."expires_at" > now() THEN
      RAISE EXCEPTION 'Order %: the reservation is still running, only the user may choose the refund of a partial payment (constraint "Refund_partial_payment_after_expiry")', NEW."order_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_partial_payment_after_expiry';
    END IF;
  ELSIF NEW."cause" = 'late_payment_no_room' THEN
    SELECT * INTO o FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
    IF NOT (o."status" IN ('pending_payment', 'expired', 'cancelled') AND o."received_sats" >= o."expected_sats") THEN
      RAISE EXCEPTION 'Order %: a late payment refund needs a complete payment on an unaccepted order (constraint "Refund_late_payment_full")', NEW."order_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_late_payment_full';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Nom choisi pour passer avant Refund_guard, Refund_user_net_positive et Refund_user_renounce (ordre alphabétique)
CREATE TRIGGER "Refund_cause_rules" BEFORE INSERT ON "Refund"
FOR EACH ROW EXECUTE FUNCTION "Refund_check_cause"();

-- Renoncement : désormais repéré par le motif (avant : initiateur utilisateur et frais boutique).
CREATE OR REPLACE FUNCTION "Refund_check_renounce"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  bst "batch_status";
BEGIN
  IF NEW."cause" <> 'user_renounce' THEN
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

-- Motif immuable (comme la nature, le payeur des frais et l'initiateur)
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
    IF (NEW."order_id", NEW."kind", NEW."cause", NEW."network_fee_payer", NEW."initiated_by", NEW."created_by_auth_user_id", NEW."created_at")
       IS DISTINCT FROM (OLD."order_id", OLD."kind", OLD."cause", OLD."network_fee_payer", OLD."initiated_by", OLD."created_by_auth_user_id", OLD."created_at") THEN
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

-- ─── (2) Prorata et plafonds sur le brut ─────────────

-- Sats BRUTS d'un remboursement partiel (annulation de lignes, rabais) de `amount` centimes sur une facture
-- payée : prorata de expected_sats arrondi au sat le plus proche sur le cumul, moins le brut déjà sorti du
-- solde par les annulations et rabais (refund_debited_sats). Frais à la charge de l'utilisateur : il reçoit
-- ce brut moins les frais (amount_sats = brut − network_fee_sats > 0).
CREATE OR REPLACE FUNCTION "refund_prorata_sats"(oid uuid, amount bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT (round(o."expected_sats"::numeric * (coalesce(r."cents", 0) + amount) / o."total_amount"))::bigint
         - coalesce(r."sats", 0)
  FROM "Order" o
  LEFT JOIN (
    SELECT rf."order_id", sum(rf."amount") AS "cents", sum("refund_debited_sats"(rf)) AS "sats"
    FROM "Refund" rf WHERE rf."order_id" = oid AND rf."kind" <> 'overpayment' GROUP BY rf."order_id"
  ) r ON r."order_id" = o."id"
  WHERE o."id" = oid
$$;

-- Cohérence d'une facture (différé). v5f : prorata (Refund_prorata) et plafond d'excédent
-- (Refund_overpayment) sur le brut ; reliquat d'excédent d'un renoncement seulement pour une facture
-- entièrement remboursée (Refund_cause_remainder). Le reste est inchangé depuis v5b.
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
         coalesce(sum("refund_debited_sats"(r)) FILTER (WHERE r."kind" <> 'overpayment'), 0),
         coalesce(sum("refund_debited_sats"(r)) FILTER (WHERE r."kind" = 'overpayment'), 0),
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
  -- Plafonds : centimes <= facturé ; sats sortis du solde (brut, frais de l'utilisateur compris) <= reçu.
  -- Le reliquat sans frais (Refund_fee_single_line_check) ne fait donc jamais payer les frais deux fois.
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
  -- (4) Reliquat d'excédent d'un renoncement (sans frais : l'annulation les porte) : seulement quand
  -- l'utilisateur renonce à toute la facture. (L'admin peut, lui, rembourser un excédent à tout moment
  -- avec un motif à la charge de la boutique, ex. admin_other.)
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
    IF s_over_sats > o."received_sats" - o."expected_sats" THEN
      RAISE EXCEPTION 'Order %: overpayment refunds (gross) exceed the sats received beyond the expected amount (constraint "Refund_overpayment")', oid
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

-- ─── (5) Journal des changements d'adresse de remboursement ─────────────

-- Déclare l'acteur de la transaction en cours (portée : la transaction, set_config local) : à appeler
-- avant toute écriture de Order.refund_address. user : l'utilisateur de la facture ; admin : identifiant de
-- l'admin (whitelist). Renvoie true (lisible par $queryRaw, contrairement à void).
CREATE FUNCTION "declare_actor"(kind "actor_kind", auth_user_id bigint) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  IF kind IS NULL OR auth_user_id IS NULL OR auth_user_id <= 0 THEN
    RAISE EXCEPTION 'declare_actor: actor kind and a positive auth user id are required (constraint "OrderRefundAddressChange_actor")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderRefundAddressChange_actor';
  END IF;
  PERFORM set_config('shop.actor_kind', kind::text, true);
  PERFORM set_config('shop.actor_auth_user_id', auth_user_id::text, true);
  RETURN true;
END;
$$;

CREATE TABLE "OrderRefundAddressChange" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id" UUID NOT NULL,
  "old_address" TEXT,
  "new_address" TEXT,
  "actor" "actor_kind" NOT NULL,
  "actor_auth_user_id" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT "OrderRefundAddressChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderRefundAddressChange_order_id_created_at_idx" ON "OrderRefundAddressChange"("order_id", "created_at");

ALTER TABLE "OrderRefundAddressChange" ADD CONSTRAINT "OrderRefundAddressChange_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderRefundAddressChange" ADD CONSTRAINT "OrderRefundAddressChange_actor_auth_user_id_check"
  CHECK ("actor_auth_user_id" > 0);
ALTER TABLE "OrderRefundAddressChange" ADD CONSTRAINT "OrderRefundAddressChange_changed_check"
  CHECK ("old_address" IS DISTINCT FROM "new_address");

CREATE FUNCTION "OrderRefundAddressChange_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OrderRefundAddressChange is append-only (constraint "OrderRefundAddressChange_append_only")'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'OrderRefundAddressChange_append_only';
END;
$$;

CREATE TRIGGER "OrderRefundAddressChange_append_only" BEFORE UPDATE OR DELETE ON "OrderRefundAddressChange"
FOR EACH ROW EXECUTE FUNCTION "OrderRefundAddressChange_guard"();

-- Chaque écriture effective de Order.refund_address (saisie à la création, modification, effacement) est
-- journalisée avec l'acteur déclaré par la transaction ; sans déclaration, ou un « user » qui n'est pas
-- l'utilisateur de la facture : refus. Après Order_refund_address (BEFORE) : seules les écritures
-- acceptées sont journalisées ; un changement refusé (adresse figée) n'écrit rien.
CREATE FUNCTION "Order_log_refund_address"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor_text text := nullif(current_setting('shop.actor_kind', true), '');
  actor_id_text text := nullif(current_setting('shop.actor_auth_user_id', true), '');
  owner bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."refund_address" IS NOT DISTINCT FROM OLD."refund_address" THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."refund_address" IS NULL THEN
    RETURN NULL;
  END IF;
  IF actor_text IS NULL OR actor_id_text IS NULL THEN
    RAISE EXCEPTION 'Order %: refund address written without a declared actor (SELECT declare_actor(...) first) (constraint "OrderRefundAddressChange_actor")', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderRefundAddressChange_actor';
  END IF;
  IF actor_text = 'user' THEN
    SELECT "auth_user_id" INTO owner FROM "User" WHERE "id" = NEW."user_id";
    IF owner IS DISTINCT FROM actor_id_text::bigint THEN
      RAISE EXCEPTION 'Order %: the declared user is not the owner of the order (constraint "OrderRefundAddressChange_actor_user")', NEW."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderRefundAddressChange_actor_user';
    END IF;
  END IF;
  INSERT INTO "OrderRefundAddressChange" ("order_id", "old_address", "new_address", "actor", "actor_auth_user_id")
  VALUES (NEW."id", CASE WHEN TG_OP = 'UPDATE' THEN OLD."refund_address" END, NEW."refund_address",
          actor_text::"actor_kind", actor_id_text::bigint);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Order_refund_address_log" AFTER INSERT OR UPDATE OF "refund_address" ON "Order"
FOR EACH ROW EXECUTE FUNCTION "Order_log_refund_address"();

-- ─── Vues ───────────────────────────────────

-- Colonnes v5e inchangées (ordre, types). Changements :
--   refunded_sats, unsettled_sats, refund_due_sats : l'excédent déjà remboursé est compté BRUT (frais à la
--     charge de l'utilisateur compris), comme le plafond Refund_overpayment ;
--   needs_admin_attention inclut overpayment_unrefunded ;
--   overpayment_unrefunded (ajoutée en fin) : facture payée dont l'excédent n'est pas (entièrement)
--     remboursé. Le traitement automatique le rembourse dans la transaction du paiement s'il dépasse les
--     frais ; sinon, ou s'il n'a pas eu lieu, l'admin décide (aucune décision automatique).
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
           sum("refund_debited_sats"(rf)) FILTER (WHERE rf."kind" = 'overpayment') AS "over_sats",
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
  d."excess" AS "overpayment_unrefunded"
FROM d;

-- Colonnes v5e inchangées ; cause ajoutée en fin.
CREATE OR REPLACE VIEW "refunds_to_send" AS
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
  r."created_at",
  r."cause"
FROM "Refund" r
JOIN "Order" o ON o."id" = r."order_id"
WHERE r."sent_at" IS NULL;
