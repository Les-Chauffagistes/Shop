-- ═════════════════════════════════════════════
-- v5g : annulation par l'admin à la demande de l'utilisateur ; dates de création des configurations et
-- wishlists posées par la base.
--   1. Décision de Hugo (2026-10-08) : l'admin enregistre une annulation à la demande de l'utilisateur
--      (cause user_renounce, frais à la charge de l'utilisateur, refund_cause_fee_payer inchangée) à toute
--      étape, y compris après la Précommande.
--        - Refund_cause_check : user_renounce permis pour l'initiateur user OU admin (l'admin reste tracé par
--          Refund_admin_traced_check, inchangé) ;
--        - Refund_check_renounce : la facture doit toujours être payée (Refund_user_renounce_paid, pour les
--          deux) ; la fenêtre de la Précommande (Refund_user_renounce_window, verrou du lot) n'est imposée
--          que quand l'utilisateur renonce lui-même. Pour l'admin, le lot n'est pas verrouillé : aucune
--          règle ne dépend plus de son statut.
--      Inchangés : Refund_cause_remainder (reliquat d'excédent seulement si toute la facture est remboursée),
--      Refund_fee_single_line_check, Refund_user_net_positive, Refund_cause_fee_payer.
--   2. Configuration.created_at, Configuration.updated_at et Wishlist.created_at : défaut posé par la base
--      (transaction_timestamp(), comme Order v5d) au lieu de l'horloge du client Prisma. updated_at est
--      ensuite avancé par les triggers (now(), même horloge) : created_at <= updated_at dès que les deux
--      viennent de la base. Pas de trigger qui imposerait la valeur : le seed et les tests peuvent antidater.
-- Aucune donnée touchée : un CHECK redéfini (assoupli : toutes les lignes existantes le respectent), une
-- fonction redéfinie, trois défauts de colonnes.
-- Retour arrière (dans l'esprit) : reposer Refund_cause_check et Refund_check_renounce de v5f (à vérifier
-- sur les données : un user_renounce d'initiateur admin créé depuis v5g violerait l'ancien CHECK, le garder
-- alors NOT VALID) ; remettre DEFAULT now() sur les trois colonnes (sans effet sur les données).
-- ═════════════════════════════════════════════

-- ─── (1) Annulation par l'admin à la demande de l'utilisateur ─────────────

ALTER TABLE "Refund" DROP CONSTRAINT "Refund_cause_check";
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_cause_check" CHECK (
  CASE "cause"
    WHEN 'user_renounce'          THEN "initiated_by" IN ('user', 'admin') AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'partial_payment'        THEN "initiated_by" IN ('user', 'admin') AND "kind" = 'cancellation'
    WHEN 'late_payment_no_room'   THEN "initiated_by" IN ('system', 'admin') AND "kind" = 'cancellation'
    WHEN 'overpayment'            THEN "initiated_by" IN ('system', 'admin') AND "kind" = 'overpayment'
    WHEN 'discount'               THEN "initiated_by" = 'admin' AND "kind" = 'discount'
    WHEN 'shop_stock'             THEN "initiated_by" IN ('admin', 'system') AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'shop_defective_machine' THEN "initiated_by" = 'admin' AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'admin_other'            THEN "initiated_by" = 'admin' AND "kind" IN ('cancellation', 'overpayment')
  END);

-- Renoncement (cause user_renounce) : facture payée ; fenêtre de la Précommande seulement quand
-- l'utilisateur renonce lui-même. L'admin l'enregistre à toute étape, à la demande de l'utilisateur.
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
    RAISE EXCEPTION 'Order % is %: a renunciation cancels only a paid order (constraint "Refund_user_renounce_paid")', NEW."order_id", o."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_renounce_paid';
  END IF;
  IF NEW."initiated_by" <> 'user' THEN
    RETURN NEW;  -- l'admin, à la demande de l'utilisateur : à toute étape
  END IF;
  -- Verrou du lot (comme Batch_lock) : une transition de statut (FOR UPDATE du lot) attend ce renoncement,
  -- et un renoncement qui suit une transition validée lit le nouveau statut.
  UPDATE "Batch" SET "updated_at" = "updated_at" WHERE "id" = o."batch_id" RETURNING "status" INTO bst;
  IF NOT "batch_allows_user_renunciation"(bst) THEN
    RAISE EXCEPTION 'Batch % is %: after the preorder phase the user asks an admin to cancel (constraint "Refund_user_renounce_window")', o."batch_id", bst
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_user_renounce_window';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── (2) Dates de création posées par la base ─────────────
-- transaction_timestamp() (= now()) : écrit ainsi pour que Prisma le lise comme dbgenerated et ne
-- renvoie pas l'heure du client (voir v5d).
ALTER TABLE "Configuration" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();
ALTER TABLE "Configuration" ALTER COLUMN "updated_at" SET DEFAULT transaction_timestamp();
ALTER TABLE "Wishlist" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();
