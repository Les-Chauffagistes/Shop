-- CreateEnum
CREATE TYPE "part_movement_kind" AS ENUM ('reception', 'adjustment', 'kit_mounted');

-- CreateTable
CREATE TABLE "PartStockMovement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "part_id" UUID NOT NULL,
    "kind" "part_movement_kind" NOT NULL,
    "qty" INTEGER NOT NULL,
    "batch_part_order_id" UUID,
    "batch_id" UUID,
    "machine_id" UUID,
    "note" TEXT,
    "created_by_auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "PartStockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartStockMovement_part_id_created_at_idx" ON "PartStockMovement"("part_id", "created_at");

-- CreateIndex
CREATE INDEX "PartStockMovement_batch_id_part_id_idx" ON "PartStockMovement"("batch_id", "part_id");

-- CreateIndex
CREATE INDEX "PartStockMovement_machine_id_idx" ON "PartStockMovement"("machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "PartStockMovement_batch_part_order_id_part_id_key" ON "PartStockMovement"("batch_part_order_id", "part_id");

-- CreateIndex
CREATE INDEX "BatchPartOrder_part_id_status_idx" ON "BatchPartOrder"("part_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BatchPartOrder_id_part_id_key" ON "BatchPartOrder"("id", "part_id");

-- AddForeignKey
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_batch_part_order_id_part_id_fkey" FOREIGN KEY ("batch_part_order_id", "part_id") REFERENCES "BatchPartOrder"("id", "part_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_machine_id_batch_id_fkey" FOREIGN KEY ("machine_id", "batch_id") REFERENCES "Machine"("id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════
-- Raw SQL v4 (décisions Hugo 2026-10-07, roadmap « Décisions sur le schéma v4 ») :
--   * stock commun des produits d'options (Part) : journal PartStockMovement, lien avec
--     BatchPartOrder, vues de besoin et de pression calculées à la lecture ;
--   * configuration complète : un item par menu visible du lot, « Sans » compris ;
--   * menu Avec/Sans : deux valeurs, défaut « Sans » figé ;
--   * règle « défaut sans pièce » supprimée (« défaut gratuit » conservée) ;
--   * changement de défaut refusé s'il modifie une wishlist ou une commande vivante ;
--   * masquer / démasquer un menu ramène les choix ouverts à la valeur par défaut ;
--   * « Proposer sur ce lot » une valeur après publication : lot de survey à in_transit.
-- Convention inchangée : chaque erreur de trigger porte `(constraint "Nom")` dans son message.
-- Aucune donnée supprimée : les configurations existantes sont complétées par le défaut (0 €).
-- ═════════════════════════════════════════════

-- ─── Contrôle préalable des données existantes (échec explicite plutôt que perte) ───
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Option" o
    WHERE o."kind" = 'toggle' AND (SELECT count(*) FROM "OptionValue" v WHERE v."option_id" = o."id") <> 2
  ) THEN
    RAISE EXCEPTION 'v4: a toggle menu does not have exactly two values; fix the catalogue before migrating';
  END IF;
END;
$$;

-- ─── Règle « défaut sans pièce » supprimée (le défaut n'a rien à acheter) ───
DROP TRIGGER "OptionValue_default_no_parts" ON "OptionValue";
DROP TRIGGER "OptionValuePart_default_no_parts" ON "OptionValuePart";
DROP FUNCTION "OptionValue_check_default_parts"();

-- ─── Menu Avec/Sans (toggle) ───
-- Exactement deux valeurs ; le défaut (« Sans », gratuit par OptionValue_default_free_check)
-- ne change jamais : « Avec » ne peut pas devenir le défaut. Le type d'un menu qui a des
-- valeurs est figé (sinon un choice deviendrait un toggle sans ces garanties).
CREATE FUNCTION "Option_check_toggle"(oid uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Option" WHERE "id" = oid AND "kind" = 'toggle')
     AND (SELECT count(*) FROM "OptionValue" WHERE "option_id" = oid) <> 2 THEN
    RAISE EXCEPTION 'Toggle menu % must have exactly two values, "Sans" (default) and "Avec" (constraint "OptionValue_toggle_two_values")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OptionValue_toggle_two_values';
  END IF;
END;
$$;

CREATE FUNCTION "trg_check_toggle"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Option' THEN
    PERFORM "Option_check_toggle"(NEW."id");
  ELSE
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM "Option_check_toggle"(OLD."option_id"); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM "Option_check_toggle"(NEW."option_id"); END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Différés : menu et valeurs se créent (ou se suppriment) dans une même transaction.
CREATE CONSTRAINT TRIGGER "Option_toggle_two_values"
  AFTER INSERT OR UPDATE OF "kind" ON "Option"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "trg_check_toggle"();
CREATE CONSTRAINT TRIGGER "OptionValue_toggle_two_values"
  AFTER INSERT OR UPDATE OF "option_id" OR DELETE ON "OptionValue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "trg_check_toggle"();

CREATE FUNCTION "OptionValue_guard_toggle_default"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Option" WHERE "id" = OLD."option_id" AND "kind" = 'toggle') THEN
    RAISE EXCEPTION 'The default of a toggle menu is always "Sans": "Avec" can never be the default (constraint "OptionValue_toggle_default_fixed")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OptionValue_toggle_default_fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OptionValue_toggle_default_fixed"
  BEFORE UPDATE OF "is_default" ON "OptionValue"
  FOR EACH ROW WHEN (OLD."is_default" IS DISTINCT FROM NEW."is_default")
  EXECUTE FUNCTION "OptionValue_guard_toggle_default"();

CREATE FUNCTION "Option_guard_kind"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "OptionValue" WHERE "option_id" = OLD."id") THEN
    RAISE EXCEPTION 'Menu % has values: its kind is fixed (constraint "Option_kind_fixed")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Option_kind_fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Option_kind_fixed"
  BEFORE UPDATE OF "kind" ON "Option"
  FOR EACH ROW WHEN (OLD."kind" IS DISTINCT FROM NEW."kind")
  EXECUTE FUNCTION "Option_guard_kind"();

-- ─── Configuration vivante ───
-- Wishlist non retirée, ou ligne de commande non remboursée (facture en attente, expirée
-- payable en retard, ou payée). Sert au verrou du changement de défaut.
CREATE FUNCTION "configuration_live"(cid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "Wishlist" WHERE "configuration_id" = cid AND "cancelled_at" IS NULL)
      OR EXISTS (SELECT 1 FROM "OrderLine" WHERE "configuration_id" = cid AND "refund_id" IS NULL)
$$;

-- ─── Changement de la valeur par défaut d'un menu ───
-- Autorisé seulement s'il ne change ni une wishlist ni une commande existante (décision
-- 2026-10-07). Une configuration complète porte le défaut en clair dans chaque menu visible :
-- elle n'est touchée que si
--   (a) elle n'a pas d'item dans ce menu (menu masqué sur son lot, ou ajouté après la
--       publication) : son défaut implicite changerait ;
--   (b) elle a choisi, à un prix non nul, la valeur qui devient le défaut (gratuit).
-- Ne comptent que les configurations vivantes des lots non clos ni annulés (comme le prix
-- figé). Différé : on retire l'ancien défaut puis on désigne le nouveau dans la transaction.
CREATE FUNCTION "OptionValue_check_default_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  oid uuid := OLD."option_id";
  m uuid;
  new_default uuid;
BEGIN
  SELECT "model_id" INTO m FROM "Option" WHERE "id" = oid;
  IF NOT FOUND THEN RETURN NULL; END IF; -- menu supprimé
  SELECT "id" INTO new_default FROM "OptionValue" WHERE "option_id" = oid AND "is_default";
  IF new_default IS NULL OR new_default = OLD."id" THEN
    RETURN NULL; -- pas de défaut (OptionValue_default_required le signale) ou défaut inchangé
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Configuration" c JOIN "Batch" b ON b."id" = c."batch_id"
    WHERE b."model_id" = m AND b."status" NOT IN ('closed', 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM "ConfigurationItem" ci WHERE ci."configuration_id" = c."id" AND ci."option_id" = oid)
      AND "configuration_live"(c."id")
  ) OR EXISTS (
    SELECT 1 FROM "ConfigurationItem" ci
    JOIN "Configuration" c ON c."id" = ci."configuration_id"
    JOIN "Batch" b ON b."id" = c."batch_id"
    WHERE ci."option_value_id" = new_default AND ci."unit_price" <> 0
      AND b."status" NOT IN ('closed', 'cancelled')
      AND "configuration_live"(c."id")
  ) THEN
    RAISE EXCEPTION 'Changing the default of menu % would change an existing wishlist or order (constraint "OptionValue_default_change_locked")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OptionValue_default_change_locked';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "OptionValue_default_change_locked"
  AFTER UPDATE OF "is_default", "option_id" OR DELETE ON "OptionValue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."is_default")
  EXECUTE FUNCTION "OptionValue_check_default_change"();

-- ─── « Proposer sur ce lot » une valeur après publication ───
-- Insérer sa ligne BatchOptionValue : seulement sur un lot qui accepte encore des
-- configurations (survey à in_transit) et dans un menu applicable au lot.
CREATE OR REPLACE FUNCTION "BatchOptionValue_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st "batch_status";
BEGIN
  SELECT "status" INTO st FROM "Batch"
  WHERE "id" = CASE TG_OP WHEN 'DELETE' THEN OLD."batch_id" ELSE NEW."batch_id" END
  FOR KEY SHARE;
  IF NOT FOUND OR st = 'draft' THEN -- suppression du lot en cascade, ou catalogue vivant
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND (NEW."batch_id", NEW."model_id", NEW."option_id", NEW."option_value_id")
         IS DISTINCT FROM (OLD."batch_id", OLD."model_id", OLD."option_id", OLD."option_value_id")) THEN
    RAISE EXCEPTION 'Option value settings of a published batch are never removed: set enabled = false (constraint "BatchOptionValue_snapshot")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOptionValue_snapshot';
  END IF;
  IF TG_OP = 'INSERT' AND NOT "batch_catalog_frozen"(st) THEN
    RAISE EXCEPTION 'Batch % is % : no option value can be offered any more (constraint "BatchOptionValue_batch_open")', NEW."batch_id", st
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOptionValue_batch_open';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM "BatchOption" WHERE "batch_id" = NEW."batch_id" AND "option_id" = NEW."option_id"
  ) THEN
    RAISE EXCEPTION 'Menu % does not apply to published batch % (constraint "BatchOptionValue_option_applicable")', NEW."option_id", NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOptionValue_option_applicable';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- ─── Configuration complète ───
-- Une configuration porte un item pour chaque menu visible de son lot (batch_menus, non
-- masqué) qui a une valeur par défaut, y compris « Sans » à 0 €. Un menu masqué ou non
-- applicable n'a pas d'item (ConfigurationItem_guard) : son défaut vaut implicitement.
-- Différé : configuration et items se créent dans la même transaction.

-- Backfill : complète les configurations existantes avec le défaut (0 €). Les configurations
-- verrouillées (lignes de commande) le reçoivent aussi : le montant de ligne est inchangé.
ALTER TABLE "ConfigurationItem" DISABLE TRIGGER "ConfigurationItem_guard";
INSERT INTO "ConfigurationItem" ("configuration_id", "model_id", "option_id", "option_value_id", "unit_price")
SELECT c."id", c."model_id", m."option_id", v."id", 0
FROM "Configuration" c
CROSS JOIN LATERAL "batch_menus"(c."batch_id") m
JOIN "OptionValue" v ON v."option_id" = m."option_id" AND v."is_default"
WHERE NOT m."hidden"
  AND NOT EXISTS (SELECT 1 FROM "ConfigurationItem" ci WHERE ci."configuration_id" = c."id" AND ci."option_id" = m."option_id");
ALTER TABLE "ConfigurationItem" ENABLE TRIGGER "ConfigurationItem_guard";

CREATE FUNCTION "Configuration_check_complete"(cid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  b uuid;
  missing uuid;
BEGIN
  SELECT "batch_id" INTO b FROM "Configuration" WHERE "id" = cid;
  IF NOT FOUND THEN RETURN; END IF; -- configuration supprimée
  SELECT m."option_id" INTO missing
  FROM "batch_menus"(b) m
  WHERE NOT m."hidden"
    AND EXISTS (SELECT 1 FROM "OptionValue" v WHERE v."option_id" = m."option_id" AND v."is_default")
    AND NOT EXISTS (SELECT 1 FROM "ConfigurationItem" ci WHERE ci."configuration_id" = cid AND ci."option_id" = m."option_id")
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Configuration % has no choice for visible menu % (its default included) (constraint "Configuration_complete")', cid, missing
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Configuration_complete';
  END IF;
END;
$$;

CREATE FUNCTION "trg_check_configuration_complete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Configuration' THEN
    PERFORM "Configuration_check_complete"(NEW."id");
  ELSE
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM "Configuration_check_complete"(OLD."configuration_id"); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM "Configuration_check_complete"(NEW."configuration_id"); END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Configuration_complete"
  AFTER INSERT ON "Configuration"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "trg_check_configuration_complete"();
CREATE CONSTRAINT TRIGGER "ConfigurationItem_complete"
  AFTER INSERT OR UPDATE OR DELETE ON "ConfigurationItem"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "trg_check_configuration_complete"();

-- ─── Masquer / démasquer un menu (brouillon, sondage) ───
-- Masquer : les choix des configurations ouvertes (wishlists) dans ce menu sont supprimés,
-- le défaut s'applique d'office (l'avertissement à l'admin est du ressort de l'application,
-- qui compte les choix concernés avant). Démasquer, ou retirer un réglage masqué en
-- brouillon : chaque configuration ouverte reçoit le défaut (0 €). Les configurations
-- verrouillées n'existent pas avant la précommande (hidden figé ensuite : BatchOption_hidden_locked).
-- Les nouvelles lectures de ConfigurationItem prennent un instantané frais (READ COMMITTED) :
-- un choix validé pendant l'attente du verrou du lot est bien supprimé.
CREATE FUNCTION "BatchOption_sync_choices"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b uuid := CASE TG_OP WHEN 'DELETE' THEN OLD."batch_id" ELSE NEW."batch_id" END;
  o uuid := CASE TG_OP WHEN 'DELETE' THEN OLD."option_id" ELSE NEW."option_id" END;
  st "batch_status";
  visible boolean;
  def uuid;
BEGIN
  SELECT "status" INTO st FROM "Batch" WHERE "id" = b;
  IF NOT FOUND OR st NOT IN ('draft', 'survey') THEN
    RETURN NULL; -- suppression du lot en cascade ; hors brouillon/sondage, hidden est figé
  END IF;
  SELECT NOT m."hidden" INTO visible FROM "batch_menus"(b) m WHERE m."option_id" = o;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF visible THEN
    SELECT "id" INTO def FROM "OptionValue" WHERE "option_id" = o AND "is_default";
    IF def IS NOT NULL THEN
      INSERT INTO "ConfigurationItem" ("configuration_id", "model_id", "option_id", "option_value_id", "unit_price")
      SELECT c."id", c."model_id", o, def, 0
      FROM "Configuration" c
      WHERE c."batch_id" = b AND c."locked_at" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "ConfigurationItem" ci WHERE ci."configuration_id" = c."id" AND ci."option_id" = o);
    END IF;
  ELSE
    DELETE FROM "ConfigurationItem" ci
    USING "Configuration" c
    WHERE c."id" = ci."configuration_id" AND c."batch_id" = b AND c."locked_at" IS NULL AND ci."option_id" = o;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "BatchOption_sync_choices"
  AFTER INSERT OR UPDATE OF "hidden" OR DELETE ON "BatchOption"
  FOR EACH ROW EXECUTE FUNCTION "BatchOption_sync_choices"();

-- ─── Publication : instantané des menus et valeurs, configurations complétées ───
-- Ajout v4 : à la (re)publication, les configurations ouvertes du lot (wishlists restées après
-- un retour survey > draft) reçoivent le défaut des menus visibles qui leur manquent.
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

-- ─── Stock du lot : une seule définition de « la facture occupe le stock » ───
-- Payée, ou en attente non expirée (réservation de 30 min, horloge de la base). Utilisée par
-- le trigger de stock (batch_stock_lines) et par la demande ferme en produits d'options.
CREATE FUNCTION "order_holds_stock"(st "order_status", expires timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT st = 'paid' OR (st = 'pending_payment' AND expires > now())
$$;

CREATE OR REPLACE FUNCTION "batch_stock_lines"(b uuid, plus uuid DEFAULT NULL)
RETURNS TABLE ("id" uuid, "configuration_id" uuid)
LANGUAGE sql STABLE AS $$
  SELECT l."id", l."configuration_id"
  FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
  WHERE l."batch_id" = b
    AND ((l."refund_id" IS NULL AND "order_holds_stock"(o."status", o."expires_at"))
         OR o."id" = plus)
$$;

-- ─── Produits d'options : commandes de lot et stock commun ───

-- CHECK du journal de stock
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_kind_check" CHECK (
  CASE "kind"
    WHEN 'reception'   THEN "qty" > 0 AND "batch_id" IS NULL AND "machine_id" IS NULL
    WHEN 'adjustment'  THEN "qty" <> 0 AND "batch_part_order_id" IS NULL AND "batch_id" IS NULL
                            AND "machine_id" IS NULL AND btrim(coalesce("note", '')) <> ''
    WHEN 'kit_mounted' THEN "qty" < 0 AND "batch_part_order_id" IS NULL AND "batch_id" IS NOT NULL
  END);
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_created_by_check" CHECK ("created_by_auth_user_id" > 0);

CREATE TRIGGER "PartStockMovement_append_only"
  BEFORE UPDATE OR DELETE ON "PartStockMovement"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

-- Kit monté : le produit équipe une valeur d'option du modèle du lot (lot absent : CHECK).
CREATE FUNCTION "PartStockMovement_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'kit_mounted' AND NEW."batch_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Batch" b
    JOIN "Option" o ON o."model_id" = b."model_id"
    JOIN "OptionValue" v ON v."option_id" = o."id"
    JOIN "OptionValuePart" p ON p."option_value_id" = v."id"
    WHERE b."id" = NEW."batch_id" AND p."part_id" = NEW."part_id"
  ) THEN
    RAISE EXCEPTION 'Part % is not used by any option of the model of batch % (constraint "PartStockMovement_kit_model")', NEW."part_id", NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'PartStockMovement_kit_model';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PartStockMovement_guard"
  BEFORE INSERT ON "PartStockMovement"
  FOR EACH ROW EXECUTE FUNCTION "PartStockMovement_guard"();

-- Stock physique jamais négatif (différé, sous verrou du produit). FOR NO KEY UPDATE : ne
-- bloque pas les clés étrangères (FOR KEY SHARE) prises par les insertions concurrentes,
-- donc pas d'interblocage ; la transaction suivante attend puis relit le journal validé.
CREATE FUNCTION "Part_check_stock"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  on_hand bigint;
BEGIN
  PERFORM 1 FROM "Part" WHERE "id" = NEW."part_id" FOR NO KEY UPDATE;
  SELECT coalesce(sum("qty"), 0) INTO on_hand FROM "PartStockMovement" WHERE "part_id" = NEW."part_id";
  IF on_hand < 0 THEN
    RAISE EXCEPTION 'Part % stock would be negative (%) (constraint "Part_stock_non_negative")', NEW."part_id", on_hand
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Part_stock_non_negative';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Part_stock_non_negative"
  AFTER INSERT ON "PartStockMovement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."qty" < 0)
  EXECUTE FUNCTION "Part_check_stock"();

-- Commande de produit d'option pour un lot : statut qui avance seulement
-- (ordering > awaiting_delivery > delivered, ordering > delivered permis) ; lot et produit
-- figés ; quantité figée une fois livrée.
CREATE FUNCTION "BatchPartOrder_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."batch_id", NEW."part_id") IS DISTINCT FROM (OLD."batch_id", OLD."part_id")
     OR (OLD."status" = 'delivered' AND NEW."qty" <> OLD."qty") THEN
    RAISE EXCEPTION 'BatchPartOrder %: batch and part are fixed, quantity is fixed once delivered (constraint "BatchPartOrder_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchPartOrder_immutable';
  END IF;
  IF NEW."status" <> OLD."status"
     AND (OLD."status"::text || '>' || NEW."status"::text) NOT IN (
       'ordering>awaiting_delivery', 'ordering>delivered', 'awaiting_delivery>delivered') THEN
    RAISE EXCEPTION 'BatchPartOrder %: transition % -> % not allowed (constraint "BatchPartOrder_status_transition")', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchPartOrder_status_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BatchPartOrder_guard"
  BEFORE UPDATE ON "BatchPartOrder"
  FOR EACH ROW EXECUTE FUNCTION "BatchPartOrder_guard"();

-- Livrée ⇔ réception enregistrée dans le stock commun (même transaction, différé).
CREATE FUNCTION "BatchPartOrder_check_reception"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  oid uuid;
BEGIN
  IF TG_TABLE_NAME = 'BatchPartOrder' THEN oid := NEW."id"; ELSE oid := NEW."batch_part_order_id"; END IF;
  IF EXISTS (
    SELECT 1 FROM "BatchPartOrder" o
    WHERE o."id" = oid
      AND (o."status" = 'delivered') <> EXISTS (SELECT 1 FROM "PartStockMovement" m WHERE m."batch_part_order_id" = o."id")
  ) THEN
    RAISE EXCEPTION 'BatchPartOrder %: delivered if and only if its reception is in the stock journal (constraint "BatchPartOrder_reception")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchPartOrder_reception';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "BatchPartOrder_reception"
  AFTER INSERT OR UPDATE OF "status" ON "BatchPartOrder"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "BatchPartOrder_check_reception"();
CREATE CONSTRAINT TRIGGER "PartStockMovement_reception"
  AFTER INSERT ON "PartStockMovement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."batch_part_order_id" IS NOT NULL)
  EXECUTE FUNCTION "BatchPartOrder_check_reception"();

-- ─── Vues de stock d'options (calculées à la lecture, jamais stockées) ───

-- Stock commun par produit : physique (journal), commandé, en attente de livraison.
CREATE VIEW "part_stock" AS
SELECT
  p."id" AS "part_id",
  coalesce((SELECT sum(m."qty") FROM "PartStockMovement" m WHERE m."part_id" = p."id"), 0)::integer AS "on_hand",
  coalesce((SELECT sum(o."qty") FROM "BatchPartOrder" o WHERE o."part_id" = p."id" AND o."status" = 'ordering'), 0)::integer AS "ordering_qty",
  coalesce((SELECT sum(o."qty") FROM "BatchPartOrder" o WHERE o."part_id" = p."id" AND o."status" = 'awaiting_delivery'), 0)::integer AS "awaiting_delivery_qty"
FROM "Part" p;

-- Besoin par lot et par produit :
--   firm_qty      demande ferme : lignes payées + factures en attente non expirées (order_holds_stock) ;
--   potential_qty demande potentielle : wishlists non retirées d'un lot au sondage ;
--   mounted_qty   kits déjà montés sur ce lot (sortis du stock) ;
--   remaining_qty demande ferme restant à prélever sur le stock commun (0 pour un lot clos/annulé) ;
--   ordered_qty / delivered_qty  commandes de ce lot (BatchPartOrder) non livrées / livrées.
-- Un menu masqué n'a pas d'item : son défaut, sans produit à acheter, ne crée pas de demande.
CREATE VIEW "batch_part_needs" AS
WITH
  firm AS NOT MATERIALIZED (
    SELECT l."batch_id", p."part_id", sum(p."qty")::integer AS "qty"
    FROM "OrderLine" l
    JOIN "Order" o ON o."id" = l."order_id"
    JOIN "ConfigurationItem" ci ON ci."configuration_id" = l."configuration_id"
    JOIN "OptionValuePart" p ON p."option_value_id" = ci."option_value_id"
    WHERE l."refund_id" IS NULL AND "order_holds_stock"(o."status", o."expires_at")
    GROUP BY l."batch_id", p."part_id"),
  potential AS NOT MATERIALIZED (
    SELECT w."batch_id", p."part_id", sum(p."qty")::integer AS "qty"
    FROM "Wishlist" w
    JOIN "Batch" b ON b."id" = w."batch_id" AND b."status" = 'survey'
    JOIN "ConfigurationItem" ci ON ci."configuration_id" = w."configuration_id"
    JOIN "OptionValuePart" p ON p."option_value_id" = ci."option_value_id"
    WHERE w."cancelled_at" IS NULL
    GROUP BY w."batch_id", p."part_id"),
  mounted AS NOT MATERIALIZED (
    SELECT m."batch_id", m."part_id", (-sum(m."qty"))::integer AS "qty"
    FROM "PartStockMovement" m
    WHERE m."kind" = 'kit_mounted'
    GROUP BY m."batch_id", m."part_id"),
  ordered AS NOT MATERIALIZED (
    SELECT o."batch_id", o."part_id",
      coalesce(sum(o."qty") FILTER (WHERE o."status" <> 'delivered'), 0)::integer AS "pending",
      coalesce(sum(o."qty") FILTER (WHERE o."status" = 'delivered'), 0)::integer AS "delivered"
    FROM "BatchPartOrder" o
    GROUP BY o."batch_id", o."part_id"),
  keys AS NOT MATERIALIZED (
    SELECT "batch_id", "part_id" FROM firm
    UNION SELECT "batch_id", "part_id" FROM potential
    UNION SELECT "batch_id", "part_id" FROM mounted
    UNION SELECT "batch_id", "part_id" FROM ordered)
SELECT
  k."batch_id",
  k."part_id",
  b."status" AS "batch_status",
  coalesce(f."qty", 0) AS "firm_qty",
  coalesce(pt."qty", 0) AS "potential_qty",
  coalesce(mo."qty", 0) AS "mounted_qty",
  CASE WHEN b."status" IN ('closed', 'cancelled') THEN 0
       ELSE greatest(coalesce(f."qty", 0) - coalesce(mo."qty", 0), 0) END AS "remaining_qty",
  coalesce(od."pending", 0) AS "ordered_qty",
  coalesce(od."delivered", 0) AS "delivered_qty"
FROM keys k
JOIN "Batch" b ON b."id" = k."batch_id"
LEFT JOIN firm f ON f."batch_id" = k."batch_id" AND f."part_id" = k."part_id"
LEFT JOIN potential pt ON pt."batch_id" = k."batch_id" AND pt."part_id" = k."part_id"
LEFT JOIN mounted mo ON mo."batch_id" = k."batch_id" AND mo."part_id" = k."part_id"
LEFT JOIN ordered od ON od."batch_id" = k."batch_id" AND od."part_id" = k."part_id";

-- Pression par produit (vue d'ensemble et fiche de lot) :
--   firm_demand      somme des remaining_qty des lots (lots qui n'ont pas encore consommé leurs kits) ;
--   potential_demand somme des wishlists des lots au sondage (affichée à part, hors pression) ;
--   pressure         firm_demand / on_hand ; NULL si demande sans stock (pression infinie) ; 0 sans demande ;
--   over_pressure    avertissement : pression > 1 (firm_demand > on_hand) ;
--   shortfall        manque par rapport au stock physique ;
--   to_order         manque restant une fois comptées les commandes en cours et en route.
CREATE VIEW "part_stock_pressure" AS
SELECT
  p."id" AS "part_id",
  p."name",
  p."reference",
  s."on_hand",
  s."ordering_qty",
  s."awaiting_delivery_qty",
  coalesce(n."firm", 0)::integer AS "firm_demand",
  coalesce(n."potential", 0)::integer AS "potential_demand",
  CASE WHEN coalesce(n."firm", 0) = 0 THEN 0::numeric
       WHEN s."on_hand" > 0 THEN round(n."firm"::numeric / s."on_hand", 3)
       ELSE NULL END AS "pressure",
  coalesce(n."firm", 0) > s."on_hand" AS "over_pressure",
  greatest(coalesce(n."firm", 0) - s."on_hand", 0)::integer AS "shortfall",
  greatest(coalesce(n."firm", 0) - s."on_hand" - s."ordering_qty" - s."awaiting_delivery_qty", 0)::integer AS "to_order"
FROM "Part" p
JOIN "part_stock" s ON s."part_id" = p."id"
LEFT JOIN (
  SELECT "part_id", sum("remaining_qty") AS "firm", sum("potential_qty") AS "potential"
  FROM "batch_part_needs"
  GROUP BY "part_id"
) n ON n."part_id" = p."id";
