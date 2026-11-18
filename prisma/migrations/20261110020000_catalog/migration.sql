-- ═════════════════════════════════════════════
-- Catalogue : modèles de mineur, menus d'options (Option), valeurs (OptionValue), pièces (Part).
-- Les réglages d'un lot sur ce catalogue (dérogations, retraits, instantané) sont dans batches ;
-- la règle « hashboard_qtt figé une fois des machines créées » est dans machines.
-- ═════════════════════════════════════════════

-- ─── Contraintes CHECK et index hors Prisma ───

-- Model
ALTER TABLE "Model" ADD CONSTRAINT "Model_hashrate_check" CHECK ("hashrate" > 0);

ALTER TABLE "Model" ADD CONSTRAINT "Model_hashboard_qtt_check" CHECK ("hashboard_qtt" > 0);

-- OptionValue
ALTER TABLE "OptionValue" ADD CONSTRAINT "OptionValue_price_check" CHECK ("price" >= 0);

-- La valeur par défaut est la machine « brute » : gratuite (roadmap, « Options par défaut »).
ALTER TABLE "OptionValue" ADD CONSTRAINT "OptionValue_default_free_check" CHECK (NOT "is_default" OR "price" = 0);

-- OptionValuePart
ALTER TABLE "OptionValuePart" ADD CONSTRAINT "OptionValuePart_qty_check" CHECK ("qty" > 0);

-- Noms uniques du catalogue (décision Hugo 2026-10-07), sans tenir compte de la casse ni des
-- espaces de bord : modèle (nom, global), menu (titre, par modèle), valeur (libellé, par menu),
-- produit d'option (nom, global). Index uniques sur expression : seule garde, sûre en concurrence ;
-- l'API traduit chaque violation en 409 avec un code dédié (src/server/errors.ts).
-- Prisma ne sait pas décrire un index sur expression : ils ne figurent qu'ici (et dans schema.dbml).
CREATE UNIQUE INDEX "Model_name_ci_key" ON "Model" (lower(btrim("name")));

CREATE UNIQUE INDEX "Option_model_id_title_ci_key" ON "Option" ("model_id", lower(btrim("title")));

CREATE UNIQUE INDEX "OptionValue_option_id_label_ci_key" ON "OptionValue" ("option_id", lower(btrim("label")));

CREATE UNIQUE INDEX "Part_name_ci_key" ON "Part" (lower(btrim("name")));

-- ─── Valeur par défaut d'un menu ───

-- « Au plus un » défaut : index unique partiel OptionValue_one_default_per_option.
-- « Au moins un » : trigger de contrainte différé (permet de changer le défaut
-- ou de créer menu + valeurs dans une même transaction).
CREATE FUNCTION "OptionValue_check_default"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  oid uuid;
BEGIN
  FOREACH oid IN ARRAY (
    CASE TG_OP
      WHEN 'INSERT' THEN ARRAY[NEW."option_id"]
      WHEN 'DELETE' THEN ARRAY[OLD."option_id"]
      ELSE ARRAY[OLD."option_id", NEW."option_id"]
    END
  ) LOOP
    IF EXISTS (SELECT 1 FROM "OptionValue" WHERE "option_id" = oid)
       AND NOT EXISTS (SELECT 1 FROM "OptionValue" WHERE "option_id" = oid AND "is_default") THEN
      RAISE EXCEPTION 'Option % must have exactly one default value (constraint "OptionValue_default_required")', oid
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OptionValue_default_required';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "OptionValue_default_required"
  AFTER INSERT OR UPDATE OF "is_default", "option_id" OR DELETE ON "OptionValue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "OptionValue_check_default"();

-- Prix catalogue et menu d'une valeur figés tant qu'elle est proposée par un lot en cours
-- (ligne BatchOptionValue d'un lot batch_catalog_frozen : l'instantané de publication contient
-- toutes les valeurs). Changer le prix pour ce lot : BatchOptionValue.price_override.
-- Verrou des lots du modèle : une publication concurrente est attendue puis vue.
CREATE FUNCTION "OptionValue_guard_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."price" = OLD."price" AND NEW."option_id" = OLD."option_id" THEN
    RETURN NEW;
  END IF;
  PERFORM "model_lock_batches"(o."model_id")
  FROM "Option" o WHERE o."id" IN (OLD."option_id", NEW."option_id");
  IF EXISTS (
    SELECT 1 FROM "BatchOptionValue" bov JOIN "Batch" b ON b."id" = bov."batch_id"
    WHERE bov."option_value_id" = OLD."id" AND "batch_catalog_frozen"(b."status")
  ) THEN
    IF NEW."option_id" <> OLD."option_id" THEN
      RAISE EXCEPTION 'Option value % is offered by a published batch: its menu is frozen (constraint "OptionValue_option_frozen")', OLD."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OptionValue_option_frozen';
    END IF;
    RAISE EXCEPTION 'Option value % is offered by a published batch: its catalogue price is frozen, use a batch price override (constraint "OptionValue_price_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OptionValue_price_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OptionValue_guard_frozen"
  BEFORE UPDATE OF "price", "option_id" ON "OptionValue"
  FOR EACH ROW EXECUTE FUNCTION "OptionValue_guard_frozen"();

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
