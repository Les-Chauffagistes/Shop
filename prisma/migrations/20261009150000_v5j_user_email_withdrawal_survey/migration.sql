-- ═════════════════════════════════════════════
-- v5j : décisions de Hugo du 2026-10-09 sur les questions de la v5i.
--   1. E-mail : donnée du profil de l'utilisateur (User.email, modifiable par lui, même format que
--      Order.contact_email, pas d'unicité). Order.contact_email reste l'instantané figé de l'adresse utilisée pour
--      la facture. À la création d'une facture sans e-mail fourni, la base copie celui du profil ; sans e-mail ni
--      fourni ni au profil : refus (Order_contact_email_required). Le trigger reste DÉSACTIVÉ jusqu'au backend
--      (migration v5k) : seule sa fonction change ici. Mémoriser sur le profil un e-mail saisi à la commande est
--      l'affaire du backend (même transaction). Vue user_contact_email supprimée : le dernier e-mail connu est
--      User.email (reprise : profils vides remplis avec l'e-mail de leur dernière facture).
--   2. Versement après un classement sans suite : rien d'automatique ; il reste « à traiter » (vérifié par les tests).
--      Correctif : OrderExcessDismissal_check retire les sats déjà classés du non-affecté (message juste).
--   3. Annulation de toute une commande payée par la boutique : l'excédent reste « à traiter », quelle que soit la
--      cause (inchangé depuis v5i : Order_refunded_in_full ne dépend pas du motif ; vérifié par les tests).
--   4. Option retirée d'un lot : ajustement IMMÉDIAT à tout statut où le lot vit encore (brouillon, sondage,
--      précommande à en transit ; pas clos ni annulé). Les configurations ouvertes qui portaient la valeur reviennent
--      au défaut du menu ; le journal WishlistOptionWithdrawal ne prévient que les wishlists non retirées et non
--      converties (ligne active d'une commande payée). L'immuabilité des wishlists figées reste pour tout autre
--      changement (exception v5i inchangée).
-- Données touchées : reprise (1) des profils sans e-mail ; reprise (4) des wishlists du sondage et du brouillon qui
-- portent une valeur retirée (journalisées comme en v5i). Rien n'est supprimé, hors la vue user_contact_email.
-- Retour arrière (dans l'esprit) : recréer la vue user_contact_email de v5i ; reposer Order_check_contact_email,
-- BatchOptionValue_reset_withdrawn et ConfigurationItem_log_withdrawal de v5i ; DROP de batch_withdrawal_applies ;
-- la colonne User.email porte des données : la garder (inerte).
-- ═════════════════════════════════════════════

-- ─── (1) E-mail du profil ─────────────

-- AlterTable
ALTER TABLE "User" ADD COLUMN "email" TEXT;

-- Même format que Order.contact_email (Order_contact_email_check)
ALTER TABLE "User" ADD CONSTRAINT "User_email_check" CHECK (
  "email" IS NULL OR (
    char_length("email") <= 254
    AND "email" ~ '^[^[:space:]@]+@[^[:space:]@.]+(\.[^[:space:]@.]+)+$'));

-- Reprise : profil sans e-mail = e-mail de la dernière facture qui en porte un (même source que l'ancienne vue)
UPDATE "User" u SET "email" = last."contact_email"
FROM (
  SELECT DISTINCT ON (o."user_id") o."user_id", o."contact_email"
  FROM "Order" o WHERE o."contact_email" IS NOT NULL
  ORDER BY o."user_id", o."created_at" DESC, o."id" DESC
) last
WHERE last."user_id" = u."id" AND u."email" IS NULL;

DROP VIEW "user_contact_email";

-- Création d'une facture : instantané fourni, sinon copié du profil ; aucun des deux : refus. Trigger
-- Order_contact_email_required (v5i) toujours désactivé : la migration v5k l'active avec le backend.
CREATE OR REPLACE FUNCTION "Order_check_contact_email"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."contact_email" IS NULL THEN
    SELECT "email" INTO NEW."contact_email" FROM "User" WHERE "id" = NEW."user_id";
  END IF;
  IF NEW."contact_email" IS NULL THEN
    RAISE EXCEPTION 'An order is created with the contact e-mail of the customer, given or from the profile (constraint "Order_contact_email_required")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_contact_email_required';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── (2) Versement après un classement : rien d'automatique ─────────────
-- OrderExcessDismissal_check (v5i) calculait le non-affecté sans retirer un classement déjà fait : un second essai
-- après un nouveau versement était refusé avec un montant faux (OrderExcessDismissal_amount). Il retire désormais
-- les sats déjà classés (comme order_payment_balance) ; le second classement reste refusé par l'index unique.
CREATE OR REPLACE FUNCTION "OrderExcessDismissal_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  debited bigint;
  over_sats bigint;
  dismissed bigint;
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
  SELECT coalesce(sum("sats"), 0) INTO dismissed FROM "OrderExcessDismissal" WHERE "order_id" = o."id";
  unsettled := CASE WHEN o."status" = 'paid' THEN greatest(o."received_sats" - o."expected_sats" - over_sats - dismissed, 0)
                    ELSE o."received_sats" - debited - dismissed END;
  IF NEW."sats" IS DISTINCT FROM unsettled OR unsettled <= 0 THEN
    RAISE EXCEPTION 'Order %: % sats are left over, not % (constraint "OrderExcessDismissal_amount")', o."id", unsettled, NEW."sats"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderExcessDismissal_amount';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── (4) Option retirée : ajustement immédiat, avertissement aux seules wishlists vivantes ─────────────

-- Statuts où un retrait ajuste tout de suite les configurations ouvertes du lot : tant que le lot vit.
CREATE FUNCTION "batch_withdrawal_applies"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st NOT IN ('closed', 'cancelled')
$$;

CREATE OR REPLACE FUNCTION "BatchOptionValue_reset_withdrawn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "batch_withdrawal_applies"((SELECT "status" FROM "Batch" WHERE "id" = NEW."batch_id")) THEN
    PERFORM "batch_reset_withdrawn_choices"(NEW."batch_id");
  END IF;
  RETURN NULL;
END;
$$;

-- Journal : seulement pour une wishlist à prévenir, ni retirée ni convertie (ligne non remboursée d'une commande
-- payée). Les autres configurations ouvertes sont ajustées sans avertissement.
CREATE OR REPLACE FUNCTION "ConfigurationItem_log_withdrawal"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "configuration_item_withdrawal_reset"(OLD, NEW) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "WishlistOptionWithdrawal" ("wishlist_id", "user_id", "batch_id", "option_id",
                                          "withdrawn_value_id", "withdrawn_unit_price", "default_value_id")
  SELECT w."id", w."user_id", w."batch_id", NEW."option_id", OLD."option_value_id", OLD."unit_price", NEW."option_value_id"
  FROM "Wishlist" w
  WHERE w."configuration_id" = NEW."configuration_id" AND w."cancelled_at" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
      WHERE l."wishlist_id" = w."id" AND l."refund_id" IS NULL AND o."status" = 'paid');
  RETURN NULL;
END;
$$;

-- Reprise : lots au brouillon ou au sondage dont des wishlists portent une valeur retirée (les lots figés ont été
-- repris en v5i).
SELECT "batch_reset_withdrawn_choices"(b."id") FROM "Batch" b
WHERE "batch_withdrawal_applies"(b."status") AND NOT "batch_wishlists_frozen"(b."status");
