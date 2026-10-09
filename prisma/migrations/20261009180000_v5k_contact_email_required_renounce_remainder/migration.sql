-- ═════════════════════════════════════════════
-- v5k : contraintes finales des décisions de Hugo du 2026-10-09, livrées avec le backend (SQL du rapport
-- db-designer v5i/v5j).
--   1. E-mail de contact obligatoire à la création d'une facture : le trigger Order_contact_email_required
--      (v5i, redéfini en v5j : instantané fourni, sinon copié de User.email, sinon refus) était créé
--      désactivé ; il est activé. Le backend résout l'e-mail avant d'écrire (422 contact_email_required) et
--      mémorise sur le profil un e-mail saisi qui en diffère, dans la même transaction.
--   2. Reliquat d'excédent d'un renoncement : l'utilisateur qui renonce lui-même n'écrit plus jamais de
--      remboursement d'excédent (`user_renounce` + `initiated_by = 'user'` : `cancellation` seulement).
--      L'excédent reste « à traiter » ; l'admin peut encore, s'il le choisit, le joindre (`overpayment`,
--      initiateur admin). Posé NOT VALID : les reliquats écrits avant restent lisibles, seules les nouvelles
--      écritures sont contrôlées.
-- Aucune donnée supprimée ni réécrite. Les factures existantes sans e-mail ne sont pas touchées (le trigger
-- ne s'applique qu'à l'insertion).
-- Retour arrière (dans l'esprit) : ALTER TABLE "Order" DISABLE TRIGGER "Order_contact_email_required" ;
-- reposer Refund_cause_check de v5h.
-- ═════════════════════════════════════════════

ALTER TABLE "Order" ENABLE TRIGGER "Order_contact_email_required";

ALTER TABLE "Refund" DROP CONSTRAINT "Refund_cause_check";
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
  END) NOT VALID;
