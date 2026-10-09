-- ═════════════════════════════════════════════
-- v5h : décisions de Hugo du 2026-10-09 (revue qualité du jalon 4).
--   1. Lot annulé : ses factures en attente SANS versement passent d'office à « annulée » (la réservation est
--      libérée, la facture n'est plus proposée au paiement). Une facture n'est jamais supprimée et son adresse
--      de paiement reste supervisée : un versement reçu ensuite sur cette adresse reste « à traiter » pour
--      l'admin (order_payment_balance.needs_admin_decision, facture annulée), sans remboursement automatique.
--      Une facture avec un versement partiel n'est pas touchée : elle reste « à traiter » (lot fermé aux
--      commandes). BatchStatusTransition_apply (v4) est redéfinie à l'identique, avec ce seul ajout.
--   2. Excédent de paiement : plus aucun remboursement automatique. Refund_cause_check n'admet plus le motif
--      `overpayment` que pour l'initiateur admin (avant : system ou admin). Le traitement automatique ne crée
--      plus que le remboursement d'un paiement tardif sans place (late_payment_no_room). Contrainte posée NOT
--      VALID : les remboursements automatiques d'excédent déjà créés (bases de dev) restent lisibles ; seules
--      les nouvelles écritures sont contrôlées.
-- Aucune donnée supprimée ni réécrite à l'application de la migration.
-- Retour arrière (dans l'esprit) : reposer BatchStatusTransition_apply de v4 et Refund_cause_check de v5g.
-- ═════════════════════════════════════════════

-- ─── (1) Annulation d'un lot : factures impayées ─────────────

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
  -- (v5h) Annulation : les factures en attente sans aucun versement sont annulées avec le lot (cancelled_at
  -- posé par Order_guard). Le WHERE est réévalué sous le verrou de la ligne : un versement validé entre-temps
  -- exclut la facture (elle reste alors « à traiter »). Les factures expirées (expires_at passé) n'ont plus
  -- rien à annuler (Order_cancel_expired) : elles s'affichent « expirées ».
  IF NEW."to_status" = 'cancelled' THEN
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
  UPDATE "Batch" SET "status" = NEW."to_status", "updated_at" = now() WHERE "id" = NEW."batch_id";
  RETURN NEW;
END;
$$;

-- ─── (2) Excédent : décision de l'admin uniquement ─────────────

ALTER TABLE "Refund" DROP CONSTRAINT "Refund_cause_check";
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_cause_check" CHECK (
  CASE "cause"
    WHEN 'user_renounce'          THEN "initiated_by" IN ('user', 'admin') AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'partial_payment'        THEN "initiated_by" IN ('user', 'admin') AND "kind" = 'cancellation'
    WHEN 'late_payment_no_room'   THEN "initiated_by" IN ('system', 'admin') AND "kind" = 'cancellation'
    WHEN 'overpayment'            THEN "initiated_by" = 'admin' AND "kind" = 'overpayment'
    WHEN 'discount'               THEN "initiated_by" = 'admin' AND "kind" = 'discount'
    WHEN 'shop_stock'             THEN "initiated_by" IN ('admin', 'system') AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'shop_defective_machine' THEN "initiated_by" = 'admin' AND "kind" IN ('cancellation', 'overpayment')
    WHEN 'admin_other'            THEN "initiated_by" = 'admin' AND "kind" IN ('cancellation', 'overpayment')
  END) NOT VALID;
