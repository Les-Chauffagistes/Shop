-- ═════════════════════════════════════════════
-- Remboursements (Refund), adresse de remboursement d'une facture et son journal, solde de paiement.
-- Décisions Hugo, roadmap (jalon 4, « Jalon L », docs/legal-cadrage.md).
--   * Nature (kind : annulation de lignes, rabais, excédent) et motif (cause) figés à la création. Qui
--     paie les frais réseau se déduit du motif par UNE fonction, refund_cause_fee_payer(cause) :
--       boutique     : shop_stock (souci de stock, surplus, lot abandonné), shop_defective_machine,
--                      late_payment_no_room, discount, admin_other, user_renounce (renoncement) ;
--       utilisateur  : partial_payment (paiement partiel, choix de l'utilisateur ou remboursement par
--                      l'admin sans réponse), overpayment (excédent de paiement).
--   * Prorata et plafonds sur le BRUT (sats sortis du solde = versé + frais à la charge de
--     l'utilisateur, refund_debited_sats) ; l'utilisateur reçoit brut − frais (> 0).
--   * Aucune décision automatique quand le montant ne dépasse pas les frais ; un excédent non remboursé,
--     un versement après remboursement intégral ou annulation, ou sur un lot fermé aux commandes est
--     « à traiter » par l'admin (order_payment_balance).
--   * Renoncement de l'utilisateur à une commande payée tant que le lot est au plus en Précommande ;
--     l'admin l'enregistre à toute étape, à sa demande.
--   * Adresse de remboursement obligatoire pour toute nouvelle facture, remplaçable tant qu'aucun
--     remboursement n'est envoyé, jamais effacée, jamais une adresse de paiement de la boutique. Adresse
--     effective d'un remboursement non envoyé = coalesce(Refund.destination_address (choix explicite de
--     l'admin), Order.refund_address). Chaque écriture est journalisée (OrderRefundAddressChange, ajout
--     seul) avec l'acteur déclaré par la transaction (declare_actor, common).
--   * Envoi : sent_at (horloge de la base), reference (txid), sent_by_auth_user_id (admin ; NULL = service
--     de paiement) ; l'adresse inscrite doit être l'adresse effective lue sous verrou de la facture ;
--     ensuite le remboursement est figé. Les remboursements à envoyer : vue refunds_to_send.
--   * Vente manuelle payée hors chaîne (jalon R5, décisions Hugo 2026-11-11) : même Refund, au moyen de la facture
--     (method recopié, clé étrangère composite). Décidé par l'admin, en euros seulement (amount, au plus ce qui a été
--     reçu : Order_refunds), sans sats, sans frais réseau ni adresse ; les motifs propres à la chaîne (paiement
--     partiel, excédent, paiement tardif) et le renoncement (hors périmètre) sont exclus. L'envoi (argent rendu)
--     s'enregistre comme un remboursement Bitcoin : référence libre obligatoire, sent_at posé par la base, admin.
--     Un remboursement hors chaîne non envoyé est « à traiter » (order_payment_balance.offchain_refund_unsent).
-- ═════════════════════════════════════════════

-- ─── Contraintes CHECK et index hors Prisma ───

-- Order
-- Adresse de remboursement. Format : alphanumérique (base58 ou bech32), 26 à 100 caractères ; jamais l'adresse de paiement de la facture
ALTER TABLE "Order" ADD CONSTRAINT "Order_refund_address_check"
  CHECK ("refund_address" IS NULL OR ("refund_address" ~ '^[A-Za-z0-9]{26,100}$' AND "refund_address" <> "payment_address"));

-- Refund
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_sats_check" CHECK ("amount_sats" > 0);

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_reason_check" CHECK (btrim("reason") <> '');

-- Envoyé : référence (txid, ou référence libre hors chaîne) et, en Bitcoin, l'adresse de destination
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_sent_check"
  CHECK ("sent_at" IS NULL OR ("reference" IS NOT NULL AND ("destination_address" IS NOT NULL OR "method" = 'offchain')));

-- Moyen de la facture (recopié par Refund_guard) :
--   bitcoin  : montant versé en sats ;
--   offchain : euros seulement, sans frais (payeur : la boutique) ni adresse, décidé par l'admin ; ni excédent ni
--              motif propre à la chaîne ou au renoncement.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_method_check" CHECK (coalesce(
  CASE "method"
    WHEN 'bitcoin'  THEN "amount_sats" IS NOT NULL
    WHEN 'offchain' THEN "amount_sats" IS NULL AND "network_fee_sats" IS NULL AND "destination_address" IS NULL
                         AND "network_fee_payer" = 'shop' AND "initiated_by" = 'admin' AND "kind" <> 'overpayment'
                         AND "cause" NOT IN ('partial_payment', 'late_payment_no_room', 'overpayment', 'user_renounce')
  END, false));

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check" CHECK ("amount" >= 0);

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_kind_check" CHECK (("kind" = 'overpayment') = ("amount" = 0));

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_network_fee_sats_check" CHECK ("network_fee_sats" >= 0);

-- Un remboursement décidé par l'admin trace son identifiant.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_admin_traced_check"
  CHECK (("initiated_by" = 'admin') = ("created_by_auth_user_id" IS NOT NULL)
         AND ("created_by_auth_user_id" IS NULL OR "created_by_auth_user_id" > 0));

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_sent_by_check"
  CHECK ("sent_by_auth_user_id" IS NULL OR ("sent_by_auth_user_id" > 0 AND "sent_at" IS NOT NULL));

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_reference_check"
  CHECK ("reference" IS NULL OR btrim("reference") <> '');

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_destination_address_check"
  CHECK ("destination_address" IS NULL OR "destination_address" ~ '^[A-Za-z0-9]{26,100}$');

-- Frais à la charge de l'utilisateur : montant des frais connu (déduit de ce qu'il reçoit).
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_fee_payer_check" CHECK (
  "network_fee_payer" = 'shop' OR "network_fee_sats" IS NOT NULL);

-- Frais portés par une seule ligne : le reliquat d'excédent d'une annulation de toute la facture part
-- dans le même envoi que l'annulation, qui porte les frais ; il n'en porte aucun à la charge de l'utilisateur.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_fee_single_line_check" CHECK (
  NOT ("kind" = 'overpayment' AND "cause" <> 'overpayment' AND "network_fee_payer" = 'user')
  OR "network_fee_sats" = 0);

-- Motif, nature et initiateur compatibles. Motif overpayment (excédent) : décision de l'admin seulement ; un
-- utilisateur qui renonce lui-même n'écrit qu'une annulation (l'excédent reste « à traiter », l'admin peut
-- le joindre).
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_cause_check" CHECK (
  CASE "cause"
    WHEN 'user_renounce'          THEN ("initiated_by" = 'user' AND "kind" = 'cancellation')
                                    OR ("initiated_by" = 'admin' AND "kind" IN ('cancellation', 'overpayment'))
    WHEN 'partial_payment'        THEN "initiated_by" IN ('user', 'admin') AND "kind" = 'cancellation'
    WHEN 'late_payment_no_room'   THEN "initiated_by" IN ('system', 'admin') AND "kind" = 'cancellation'
    WHEN 'overpayment'            THEN "initiated_by" = 'admin' AND "kind" = 'overpayment'
    WHEN 'discount'               THEN "initiated_by" = 'admin' AND "kind" = 'discount'
    WHEN 'shop_stock'             THEN "initiated_by" IN ('admin', 'system') AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'shop_defective_machine' THEN "initiated_by" = 'admin' AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'admin_other'            THEN "initiated_by" = 'admin' AND "kind" IN ('cancellation', 'overpayment')
  END);

-- OrderRefundAddressChange
ALTER TABLE "OrderRefundAddressChange" ADD CONSTRAINT "OrderRefundAddressChange_actor_auth_user_id_check"
  CHECK ("actor_auth_user_id" > 0);

ALTER TABLE "OrderRefundAddressChange" ADD CONSTRAINT "OrderRefundAddressChange_changed_check"
  CHECK ("old_address" IS DISTINCT FROM "new_address");

-- ─── Qui paie les frais réseau ───

-- Source unique de la règle « qui paie les frais réseau d'un remboursement », lue à la création d'un
-- remboursement (Refund_cause_fee_payer). Pour inverser un défaut, redéfinir cette fonction dans une
-- migration : seuls les remboursements créés ensuite sont concernés (payeur immuable, Refund_immutable).
-- Pas de ELSE : un motif ajouté sans être classé ici est refusé (NULL ≠ payeur).
CREATE FUNCTION "refund_cause_fee_payer"(c "refund_cause") RETURNS "refund_fee_payer"
LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE c
    WHEN 'shop_stock'             THEN 'shop'  -- la boutique annule : stock, surplus, lot abandonné
    WHEN 'shop_defective_machine' THEN 'shop'  -- la boutique annule : machine défectueuse
    WHEN 'late_payment_no_room'   THEN 'shop'  -- paiement tardif complet, plus de place
    WHEN 'discount'               THEN 'shop'  -- rabais décidé par l'admin
    WHEN 'admin_other'            THEN 'shop'  -- autre annulation ou remboursement décidé par l'admin
    WHEN 'user_renounce'          THEN 'shop'  -- l'utilisateur renonce à sa commande payée (droit de rétractation)
    WHEN 'partial_payment'        THEN 'user'  -- remboursement d'un paiement partiel (choix ou sans réponse)
    WHEN 'overpayment'            THEN 'user'  -- excédent de paiement
  END)::"refund_fee_payer"
$$;

-- Sats sortis du solde d'une facture par un remboursement : ce que reçoit l'utilisateur, plus les
-- frais réseau quand ils sont à sa charge (déduits de ce qu'il a avancé). Frais à la charge de la
-- boutique : tracés à part, jamais déduits. Source unique pour Order_check, Order_refunded_in_full
-- et order_payment_balance. Remboursement hors chaîne : 0 (il sort des centimes, Refund.amount).
CREATE FUNCTION "refund_debited_sats"(r "Refund") RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(r."amount_sats", 0) + CASE WHEN r."network_fee_payer" = 'user' THEN coalesce(r."network_fee_sats", 0) ELSE 0 END
$$;

-- Sats BRUTS d'un remboursement partiel (annulation de lignes, rabais) de `amount` centimes sur une facture
-- Bitcoin payée (NULL pour une vente hors chaîne : on y rend `amount` centimes, reçu = total) : prorata de expected_sats arrondi au sat le plus proche sur le cumul, moins le brut déjà sorti du
-- solde par les annulations et rabais (refund_debited_sats). Frais à la charge de l'utilisateur : il reçoit
-- ce brut moins les frais (amount_sats = brut − network_fee_sats > 0).
CREATE FUNCTION "refund_prorata_sats"(oid uuid, amount bigint) RETURNS bigint
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

-- Adresse de paiement d'une facture de la boutique (supervisée : un envoi y serait compté comme un paiement).
CREATE FUNCTION "bitcoin_address_is_ours"(addr text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "Order" WHERE "payment_address" = addr)
$$;

-- ─── Remboursements ───

-- Remboursement : jamais supprimé ; facture, nature, motif, payeur des frais, initiateur et date de
-- création figés ; une fois envoyé, tout est figé (les frais à la charge de l'utilisateur et amount_sats
-- s'ajustent jusqu'à l'envoi). Jamais vers une adresse de paiement de la boutique.
CREATE FUNCTION "Refund_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_address text;
  effective text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund is never deleted (constraint "Refund_append_only")'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'Refund_append_only';
  END IF;
  -- Moyen : celui de la facture (valeur fournie remplacée ; facture inconnue : clé étrangère)
  IF TG_OP = 'INSERT' THEN
    NEW."method" := coalesce((SELECT "payment_method" FROM "Order" WHERE "id" = NEW."order_id"), NEW."method");
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."order_id", NEW."kind", NEW."cause", NEW."network_fee_payer", NEW."initiated_by", NEW."created_by_auth_user_id", NEW."created_at", NEW."method")
       IS DISTINCT FROM (OLD."order_id", OLD."kind", OLD."cause", OLD."network_fee_payer", OLD."initiated_by", OLD."created_by_auth_user_id", OLD."created_at", OLD."method") THEN
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

CREATE TRIGGER "Refund_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Refund"
FOR EACH ROW EXECUTE FUNCTION "Refund_guard"();

-- Règles du motif à la création : payeur des frais (refund_cause_fee_payer), traitement automatique
-- au-dessus des frais, conditions d'un remboursement de paiement partiel ou de paiement tardif sans place.
CREATE FUNCTION "Refund_check_cause"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  bst "batch_status";
BEGIN
  -- Payeur des frais = celui du motif, lu à la création (inverser un défaut ne touche pas l'existant)
  IF NEW."network_fee_payer" IS DISTINCT FROM "refund_cause_fee_payer"(NEW."cause") THEN
    RAISE EXCEPTION 'Refund of order %: cause % charges network fees to %, not % (constraint "Refund_cause_fee_payer")',
      NEW."order_id", NEW."cause", coalesce("refund_cause_fee_payer"(NEW."cause")::text, '(unclassified)'), NEW."network_fee_payer"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_cause_fee_payer';
  END IF;

  -- Le traitement automatique ne décide rien quand le montant ne dépasse pas les frais : frais connus,
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

-- Ce que l'utilisateur a versé doit couvrir les frais réseau à sa charge : sinon pas de
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

-- Renoncement (cause user_renounce) : facture payée ; quand l'utilisateur renonce lui-même, palette au plus en
-- Précommande, jamais un lot de stock (batch_allows_user_renunciation). L'admin l'enregistre à toute étape, à la
-- demande de l'utilisateur.
CREATE FUNCTION "Refund_check_renounce"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  bk "batch_kind";
  bst "batch_status";
BEGIN
  IF NEW."cause" <> 'user_renounce' THEN
    RETURN NEW;
  END IF;
  -- Ordre des verrous : facture, puis lot (comme Payment_apply puis Order_fits_stock)
  SELECT * INTO o FROM "Order" WHERE "id" = NEW."order_id" FOR NO KEY UPDATE;
  IF o."status" <> 'paid' THEN
    RAISE EXCEPTION 'Order % is %: a renunciation cancels only a paid order (constraint "Refund_user_renounce_paid")', NEW."order_id", o."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_renounce_paid';
  END IF;
  IF NEW."initiated_by" <> 'user' THEN
    RETURN NEW;  -- l'admin, à la demande de l'utilisateur : à toute étape
  END IF;
  -- Verrou du lot (comme Batch_lock) : une transition de statut (FOR UPDATE du lot) attend ce renoncement,
  -- et un renoncement qui suit une transition validée lit le nouveau statut.
  UPDATE "Batch" SET "updated_at" = "updated_at" WHERE "id" = o."batch_id" RETURNING "kind", "status" INTO bk, bst;
  IF NOT "batch_allows_user_renunciation"(bk, bst) THEN
    RAISE EXCEPTION '% batch % is %: the user asks an admin to cancel (constraint "Refund_user_renounce_window")', bk, o."batch_id", bst
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_renounce_window';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Refund_user_renounce" BEFORE INSERT ON "Refund"
FOR EACH ROW EXECUTE FUNCTION "Refund_check_renounce"();

-- Remboursement intégral : l'excédent d'une commande payée peut rester « à traiter ». Au passage à refunded :
--   * facture jamais acceptée (paid_at NULL : paiement partiel, tardif, après annulation…) : tout ce qui a
--     été reçu est sorti du solde (remboursé, frais de l'utilisateur compris) ou classé sans suite ;
--   * commande payée (paid_at posé : renoncement ou annulation de toute la facture) : le prix payé est
--     entièrement rendu (annulations et rabais, en brut, >= expected_sats ; hors chaîne, en centimes,
--     >= total_amount). L'excédent éventuel peut partir
--     dans la même transaction (reliquat) ou rester : la facture est alors « à traiter »
--     (order_payment_balance.needs_admin_decision) et l'admin choisit (rembourser ou classer sans suite).
-- Un paiement arrivé ensuite n'est pas refusé : il apparaît dans order_payment_balance (needs_admin_decision).
CREATE FUNCTION "Order_check_refunded_in_full"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  refunded bigint;
  price_refunded bigint;
  cents_refunded bigint;
  dismissed bigint;
BEGIN
  SELECT * INTO o FROM "Order" WHERE "id" = NEW."id";
  SELECT coalesce(sum("refund_debited_sats"(r)), 0),
         coalesce(sum("refund_debited_sats"(r)) FILTER (WHERE r."kind" <> 'overpayment'), 0),
         coalesce(sum(r."amount"), 0)
  INTO refunded, price_refunded, cents_refunded
  FROM "Refund" r WHERE r."order_id" = o."id";
  IF o."payment_method" = 'offchain' THEN
    IF cents_refunded < o."received_cents" THEN
      RAISE EXCEPTION 'Refunded order %: the price paid (% cents) is not entirely refunded (% cents) (constraint "Order_refunded_in_full")', o."id", o."received_cents", cents_refunded
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunded_in_full';
    END IF;
    RETURN NULL;
  END IF;
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

CREATE CONSTRAINT TRIGGER "Order_refunded_in_full"
  AFTER UPDATE OF "status" ON "Order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'refunded' AND OLD."status" <> 'refunded')
  EXECUTE FUNCTION "Order_check_refunded_in_full"();

-- ─── Adresse de remboursement de la facture ───

-- Modifiable tant qu'aucun remboursement de la facture n'est envoyé ; jamais une adresse de paiement
-- de la boutique (le CHECK Order_refund_address_check couvre la sienne).
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

-- Nouvelle facture Bitcoin : adresse exigée (hors chaîne : jamais d'adresse, Order_method_check). Adresse donnée :
-- remplaçable, jamais effacée. Une facture plus ancienne
-- sans adresse peut en recevoir une (NULL → adresse), ou rester sans (aucune écriture de la colonne) ; son
-- remboursement sans adresse reste « à traiter » (order_payment_balance.refund_address_missing).
CREATE FUNCTION "Order_check_refund_address_required"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."payment_method" = 'bitcoin' AND NEW."refund_address" IS NULL AND (TG_OP = 'INSERT' OR OLD."refund_address" IS NOT NULL) THEN
    RAISE EXCEPTION 'Order %: a refund address is required, it can be replaced but not removed (constraint "Order_refund_address_required")', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refund_address_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_refund_address_required" BEFORE INSERT OR UPDATE OF "refund_address" ON "Order"
FOR EACH ROW EXECUTE FUNCTION "Order_check_refund_address_required"();

-- Journal des changements d'adresse : en ajout seul.
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

-- ─── Vues ───

-- Remboursements créés mais pas encore envoyés, les plus anciens d'abord (index Refund_unsent_created_at_idx), des
-- deux moyens (method). Bitcoin : amount_sats à envoyer ; destination_address = adresse effective : celle choisie
-- par l'admin sur le remboursement, sinon celle de la facture ; destination_source = 'refund' | 'order' | NULL ;
-- address_missing : contacter l'utilisateur. Hors chaîne : amount (centimes) à rendre, sans adresse (address_missing
-- faux, destination NULL).
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
  r."method" = 'bitcoin' AND coalesce(r."destination_address", o."refund_address") IS NULL AS "address_missing",
  r."created_at",
  r."cause",
  r."method",
  r."amount"
FROM "Refund" r
JOIN "Order" o ON o."id" = r."order_id"
WHERE r."sent_at" IS NULL;

-- Solde de paiement d'une facture (calculé à la lecture, jamais stocké) :
--   refunded_sats           sats sortis du solde par les remboursements (versés + frais à la charge de
--                           l'utilisateur ; l'excédent remboursé compté brut) ;
--   outstanding_sats        appoint attendu (facture en attente ou expirée) ;
--   refund_due_sats         excédent non affecté d'une facture payée ;
--   awaiting_decision       paiement complet sur une facture en attente ou expirée d'un lot ouvert aux
--                           commandes : à accepter (paid) s'il reste de la place, sinon à rembourser
--                           (Order_fits_stock), sans intervention humaine ;
--   awaiting_user_decision  facture expirée partiellement payée d'un lot ouvert : l'utilisateur choisit
--                           l'appoint ou le remboursement (frais à sa charge) ;
--   needs_admin_decision    sats reçus non affectés sur une facture remboursée, annulée, ou impayée d'un
--                           lot fermé aux commandes : « à traiter », pas de remboursement automatique ;
--   unsettled_sats          sats reçus non affectés : excédent pour une facture payée, sinon reçu − sorti
--                           du solde ; les sats classés sans suite en sont retirés ;
--   user_refund_allowed     l'utilisateur peut demander le remboursement de ce qu'il a avancé, frais à sa
--                           charge (le montant doit aussi couvrir les frais, Refund_user_net_positive) ;
--   needs_admin_attention   « à traiter » au backoffice : needs_admin_decision, awaiting_user_decision
--                           (l'admin contacte l'utilisateur), awaiting_decision (paiement complet resté sans
--                           traitement automatique, notamment sur une réservation vivante qui ne tient plus
--                           dans le stock), refund_address_missing, overpayment_unrefunded ou
--                           offchain_refund_unsent ;
--   abandoned_at            order_abandoned_at (abandon compté par le délai et le plafond) ;
--   fits_stock              pour awaiting_decision : la facture tiendrait dans le stock (lot et max_qty des
--                           options) si elle était payée maintenant (batch_stock_violation, sans verrou) ;
--                           NULL sinon ;
--   unsent_refund_sats      sats des remboursements créés mais pas encore envoyés ;
--   refund_address_missing  un remboursement non envoyé n'a pas d'adresse effective : contacter l'utilisateur ;
--   user_renounce_allowed   facture Bitcoin payée d'une palette au plus en Précommande (jamais un lot de stock ni une
--                           vente hors chaîne) : l'utilisateur peut y renoncer ;
--   overpayment_unrefunded  facture payée dont l'excédent n'est pas (entièrement) remboursé : l'admin décide ;
--   dismissed_sats          sats classés sans suite (OrderExcessDismissal) ;
--   payment_method          moyen de la facture. Vente hors chaîne (offchain) : colonnes en sats à 0 (expected_sats
--                           NULL), aucun drapeau propre à la chaîne ; ses montants sont en centimes :
--   received_cents          centimes encaissés (Order.received_cents) ;
--   refunded_cents          centimes remboursés (Refund.amount des remboursements hors chaîne, envoyés ou non) ;
--   unsent_refund_cents     centimes des remboursements hors chaîne décidés mais pas encore rendus ;
--   offchain_refund_unsent  un remboursement hors chaîne attend d'être rendu (« à traiter » : l'admin rend l'argent
--                           puis enregistre l'envoi, aucun service ne le fait à sa place) ;
--   full_payment_hold       (R4b) facture Bitcoin en attente ou expirée dont tout est payé (reçu >= attendu,
--                           outstanding_sats = 0) mais pas acceptée : rien à payer, la boutique décide. Raison :
--                           'settling' (lot ouvert, la facture tient : acceptation automatique en cours, awaiting_decision) ;
--                           'no_room' (lot ouvert, plus de place : fits_stock faux, remboursée par la boutique, frais à
--                           sa charge, une fois la réservation terminée ; une réservation vivante garde toujours sa
--                           place, Batch_stock) ; 'batch_closed' (lot fermé aux commandes : needs_admin_decision, l'admin
--                           accepte ou rembourse). NULL sinon. Toujours « à traiter » (needs_admin_attention).
-- Versements d'une facture remboursée, toutes à 0 / faux sauf pour une facture remboursée (status =
-- refunded, seule à avoir refunded_at ; dates comparées prises par la base sous le verrou de la facture) :
--   received_after_refund_sats = somme des Payment.amount_sats dont received_at > refunded_at (versements
--     appliqués après le passage à refunded ; historique, même s'ils ont été traités depuis) ;
--   surplus_left_sats = sats reçus AVANT le remboursement intégral et toujours non affectés :
--     greatest(reçu − received_after_refund_sats − sortis du solde (refunded_sats, brut) − classés sans suite, 0).
--     Non nul seulement pour une commande payée puis annulée en entier (paid_at posé) dont l'excédent est resté
--     (Order_refunded_in_full) ; toujours 0 pour une facture jamais acceptée (tout le reçu est sorti du
--     solde au passage à refunded) ;
--   paid_after_refund_sats = unsettled_sats − surplus_left_sats : part non affectée qui vient des versements
--     arrivés après le remboursement intégral ;
--   surplus_left = surplus_left_sats > 0 ; paid_after_refund = paid_after_refund_sats > 0 (drapeaux) ;
--   surplus_left_sats + paid_after_refund_sats = unsettled_sats pour une facture remboursée.
-- Convention d'imputation (seul cas où les montants ne disent pas tout) : un remboursement ou un classement fait
-- APRÈS le passage à refunded éteint d'abord le surplus resté (le plus ancien), puis les versements tardifs.
CREATE VIEW "order_payment_balance" AS
WITH b AS (
  SELECT
    o.*,
    coalesce(r."debited", 0)::bigint AS "debited",
    coalesce(r."over_sats", 0)::bigint AS "over_sats",
    coalesce(r."unsent_sats", 0)::bigint AS "unsent_sats",
    coalesce(r."unsent_without_destination", false) AND o."refund_address" IS NULL AS "address_missing",
    coalesce(r."refunded_cents", 0)::bigint AS "refunded_cents",
    coalesce(r."unsent_cents", 0)::bigint AS "unsent_cents",
    coalesce(r."offchain_unsent", false) AS "offchain_unsent",
    coalesce(dm."sats", 0)::bigint AS "dismissed",
    coalesce(pa."sats", 0)::bigint AS "after_refund",
    coalesce("batch_accepts_orders"(ba."status"), false) AS "batch_open",
    "batch_allows_user_renunciation"(ba."kind", ba."status") AS "renounce_window",
    "order_abandoned_at"(o) AS "abandoned"
  FROM "Order" o
  JOIN "Batch" ba ON ba."id" = o."batch_id"
  LEFT JOIN (
    SELECT rf."order_id", sum("refund_debited_sats"(rf)) AS "debited",
           sum("refund_debited_sats"(rf)) FILTER (WHERE rf."kind" = 'overpayment') AS "over_sats",
           sum(rf."amount_sats") FILTER (WHERE rf."sent_at" IS NULL) AS "unsent_sats",
           bool_or(rf."sent_at" IS NULL AND rf."destination_address" IS NULL AND rf."method" = 'bitcoin') AS "unsent_without_destination",
           sum(rf."amount") FILTER (WHERE rf."method" = 'offchain') AS "refunded_cents",
           sum(rf."amount") FILTER (WHERE rf."method" = 'offchain' AND rf."sent_at" IS NULL) AS "unsent_cents",
           bool_or(rf."method" = 'offchain' AND rf."sent_at" IS NULL) AS "offchain_unsent"
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
    CASE WHEN b."payment_method" = 'offchain' THEN 0
         WHEN b."status" = 'paid' THEN greatest(b."received_sats" - b."expected_sats" - b."over_sats" - b."dismissed", 0)
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
), e AS (
  SELECT d.*,
    CASE WHEN d."full_payment" THEN "batch_stock_violation"(d."batch_id", d."id") IS NULL END AS "fits"
  FROM d
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
  (d."admin_decision" OR d."user_decision" OR d."full_payment" OR d."address_missing" OR d."excess"
   OR d."offchain_unsent") AS "needs_admin_attention",
  d."abandoned" AS "abandoned_at",
  d."fits" AS "fits_stock",
  d."unsent_sats" AS "unsent_refund_sats",
  d."address_missing" AS "refund_address_missing",
  (d."status" = 'paid' AND d."payment_method" = 'bitcoin' AND d."renounce_window") AS "user_renounce_allowed",
  d."excess" AS "overpayment_unrefunded",
  d."dismissed" AS "dismissed_sats",
  d."after_refund" AS "received_after_refund_sats",
  d."surplus" AS "surplus_left_sats",
  d."late" AS "paid_after_refund_sats",
  (d."surplus" > 0) AS "surplus_left",
  (d."late" > 0) AS "paid_after_refund",
  d."payment_method",
  d."received_cents",
  d."refunded_cents",
  d."unsent_cents" AS "unsent_refund_cents",
  d."offchain_unsent" AS "offchain_refund_unsent",
  CASE WHEN d."payment_method" = 'bitcoin' AND d."status" IN ('pending_payment', 'expired')
            AND d."received_sats" >= d."expected_sats"
       THEN CASE WHEN NOT d."batch_open" THEN 'batch_closed'
                 WHEN d."fits" THEN 'settling'
                 ELSE 'no_room' END
  END AS "full_payment_hold"
FROM e d;
