-- ═════════════════════════════════════════════
-- Configurations et wishlists.
--   * Configuration complète : un item pour chaque menu visible de son lot (batch_menus, non masqué)
--     qui a une valeur par défaut, y compris « Sans » à 0 €. Un menu masqué ou non applicable n'a pas
--     d'item (ConfigurationItem_guard) : son défaut vaut implicitement. Différé : configuration et
--     items se créent dans la même transaction.
--   * Une configuration de ligne de commande est verrouillée (locked_at) puis immuable ; ses prix
--     sont des instantanés voulus (base_price, unit_price).
--   * Wishlist : créée pendant le sondage seulement, plafonnée par utilisateur et par lot, figée dès
--     la précommande, non retirable une fois convertie en commande payée.
--   * Option retirée d'un lot (BatchOptionValue.enabled = false) tant que le lot vit (pas clos ni
--     annulé) : les configurations ouvertes qui portaient la valeur reviennent au défaut du menu
--     (0 €), seule exception à l'immuabilité des wishlists figées ; le journal WishlistOptionWithdrawal
--     (ajout seul) prévient les wishlists ni retirées ni converties. La wishlist reste, sa priorité aussi.
-- ═════════════════════════════════════════════

-- ─── Contraintes CHECK et index hors Prisma ───

-- Configuration
ALTER TABLE "Configuration" ADD CONSTRAINT "Configuration_base_price_check" CHECK ("base_price" >= 0);

-- ConfigurationItem
ALTER TABLE "ConfigurationItem" ADD CONSTRAINT "ConfigurationItem_unit_price_check" CHECK ("unit_price" >= 0);

-- WishlistOptionWithdrawal
ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_withdrawn_unit_price_check" CHECK ("withdrawn_unit_price" >= 0);

ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_values_check" CHECK ("withdrawn_value_id" <> "default_value_id");

-- ─── Configuration : verrouillée par la ligne de commande, puis immuable ───
CREATE FUNCTION "Configuration_guard_locked"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."locked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'Configuration % is locked (constraint "Configuration_locked")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Configuration_locked';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "Configuration_guard_locked"
  BEFORE UPDATE OR DELETE ON "Configuration"
  FOR EACH ROW EXECUTE FUNCTION "Configuration_guard_locked"();

-- Items : pas de modification après verrouillage. Un item n'existe que pour un menu applicable
-- au lot et non masqué (sinon : défaut implicite, pas d'item), avec une valeur proposée par le lot
-- (batch_offered_values) ; la valeur par défaut y est gratuite. FOR KEY SHARE sur le lot : attend
-- un masquage concurrent (BatchOption_guard, FOR UPDATE) puis relit les réglages validés.
CREATE FUNCTION "ConfigurationItem_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cid uuid := CASE TG_OP WHEN 'DELETE' THEN OLD."configuration_id" ELSE NEW."configuration_id" END;
  bid uuid;
  menu_hidden boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM "Configuration" WHERE "id" = cid AND "locked_at" IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND EXISTS (
       SELECT 1 FROM "Configuration" WHERE "id" = OLD."configuration_id" AND "locked_at" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Configuration % is locked (constraint "Configuration_locked")', cid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Configuration_locked';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT "batch_id" INTO bid FROM "Configuration" WHERE "id" = NEW."configuration_id";
  PERFORM 1 FROM "Batch" WHERE "id" = bid FOR KEY SHARE;
  SELECT m."hidden" INTO menu_hidden FROM "batch_menus"(bid) m WHERE m."option_id" = NEW."option_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Menu % does not apply to this batch, it was added after publication (constraint "ConfigurationItem_option_applicable")', NEW."option_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ConfigurationItem_option_applicable';
  END IF;
  IF menu_hidden THEN
    RAISE EXCEPTION 'Menu % is hidden on this batch: its default applies, no item (constraint "ConfigurationItem_option_hidden")', NEW."option_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ConfigurationItem_option_hidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "batch_offered_values"(bid) o WHERE o."option_value_id" = NEW."option_value_id") THEN
    RAISE EXCEPTION 'Option value % is not offered on this batch (withdrawn, or added after publication) (constraint "ConfigurationItem_value_enabled")', NEW."option_value_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ConfigurationItem_value_enabled';
  END IF;
  IF NEW."unit_price" <> 0 AND EXISTS (SELECT 1 FROM "OptionValue" WHERE "id" = NEW."option_value_id" AND "is_default") THEN
    RAISE EXCEPTION 'Default option value % is free (constraint "ConfigurationItem_default_free")', NEW."option_value_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ConfigurationItem_default_free';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ConfigurationItem_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ConfigurationItem"
  FOR EACH ROW EXECUTE FUNCTION "ConfigurationItem_guard"();

-- ─── Wishlist ───

-- Une wishlist ne pointe pas sur une configuration de commande (verrouillée).
CREATE FUNCTION "Wishlist_guard_configuration"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Configuration" WHERE "id" = NEW."configuration_id" AND "locked_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'Configuration % belongs to an order line (constraint "Wishlist_configuration_unlocked")', NEW."configuration_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Wishlist_configuration_unlocked';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Wishlist_guard_configuration"
  BEFORE INSERT OR UPDATE OF "configuration_id" ON "Wishlist"
  FOR EACH ROW EXECUTE FUNCTION "Wishlist_guard_configuration"();

-- Wishlist créée (ou réactivée, ou déplacée) uniquement pendant le sondage du lot
-- (décision Hugo 2026-10-06). FOR SHARE : attend une transition de statut concurrente
-- (BatchStatusTransition_check prend la ligne FOR UPDATE) puis relit le statut validé.
-- Le retrait (cancelled_at) reste possible à tout moment.
CREATE FUNCTION "Wishlist_guard_batch"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st "batch_status";
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."batch_id" = OLD."batch_id"
     AND NOT (OLD."cancelled_at" IS NOT NULL AND NEW."cancelled_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  SELECT "status" INTO st FROM "Batch" WHERE "id" = NEW."batch_id" FOR SHARE;
  IF st IS DISTINCT FROM 'survey' THEN
    RAISE EXCEPTION 'Batch % is not in survey: wishlists are closed (constraint "Wishlist_batch_survey")', NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Wishlist_batch_survey';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Wishlist_guard_batch"
  BEFORE INSERT OR UPDATE OF "batch_id", "cancelled_at" ON "Wishlist"
  FOR EACH ROW EXECUTE FUNCTION "Wishlist_guard_batch"();

-- ─── Configuration vivante ───
-- Wishlist non retirée, ou ligne de commande non remboursée (facture en attente, expirée
-- payable en retard, ou payée). Sert au verrou du changement de défaut.
-- Prix d'une configuration (instantané) : prix de base + prix des valeurs choisies, centimes. NULL : configuration
-- inconnue. Source unique du prix d'une ligne de commande (OrderLine_amount, create_manual_sale).
CREATE FUNCTION "configuration_price"(cid uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT c."base_price" + (SELECT coalesce(sum(ci."unit_price"), 0) FROM "ConfigurationItem" ci WHERE ci."configuration_id" = c."id")
  FROM "Configuration" c WHERE c."id" = cid
$$;

CREATE FUNCTION "configuration_live"(cid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "Wishlist" WHERE "configuration_id" = cid AND "cancelled_at" IS NULL)
      OR EXISTS (SELECT 1 FROM "OrderLine" WHERE "configuration_id" = cid AND "refund_id" IS NULL)
$$;

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

-- Configuration d'une wishlist figée dès la précommande (décision Hugo 2026-10-07, roadmap
-- « Décisions du jalon 3 ») : modifiable seulement avant l'ouverture des précommandes, le retrait
-- (Wishlist.cancelled_at) restant possible à tout moment.
--
-- Garde de la base : une configuration référencée par une wishlist (retirée ou non) ne change
-- plus (Configuration, ConfigurationItem, Wishlist.configuration_id) dès que son lot a quitté
-- draft / survey. Aucun retour vers draft ou survey après la précommande
-- (batch_transition_allowed) : « draft ou survey » équivaut à « avant la précommande ».
--
-- Brouillon permis en base (l'application, elle, refuse à l'utilisateur toute modification en
-- brouillon : lot dépublié). Les règles de la base qui écrivent dans les configurations de
-- wishlists le font toutes en brouillon ou au sondage :
--   * masquer / démasquer un menu (BatchOption_sync_choices) : draft, survey (hidden figé ensuite) ;
--   * complétion à la (re)publication (BatchStatusTransition_snapshot_options, sortie de draft) : items écrits
--     avant le changement de statut, le lot est encore draft ;
--   * le changement de défaut (OptionValue_default_change_locked) n'écrit jamais, il refuse.
-- Seule écriture permise après : le retour au défaut d'une valeur retirée
-- (configuration_item_withdrawal_reset, exception de Wishlist_guard_configuration_frozen).
--
-- Verrou partagé du lot (FOR KEY SHARE) : attend une transition concurrente (FOR UPDATE dans
-- BatchStatusTransition_check) puis relit le statut validé ; une modification validée avant
-- l'ouverture des précommandes reste, une modification qui arrive après est refusée.
CREATE FUNCTION "Wishlist_check_configuration_open"(cid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  st "batch_status";
BEGIN
  SELECT b."status" INTO st
  FROM "Wishlist" w JOIN "Batch" b ON b."id" = w."batch_id"
  WHERE w."configuration_id" = cid
  FOR KEY SHARE OF b;
  IF FOUND AND st NOT IN ('draft', 'survey') THEN
    RAISE EXCEPTION 'Configuration % belongs to a wishlist of a batch in status %: frozen since preorders opened (constraint "Wishlist_configuration_frozen")', cid, st
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Wishlist_configuration_frozen';
  END IF;
END;
$$;

-- Une wishlist convertie en commande payée ne se retire pas (décision Hugo 2026-10-07, roadmap
-- « Décisions du jalon 3 ») : on renonce à la machine par l'annulation de la commande (jalon 4).
-- Convertie = référencée par une ligne non remboursée d'une commande payée (OrderLine_wishlist_converted_once).
--
-- Garde de la base, en plus de l'application (src/server/wishlists.ts) : tout écrivain du retrait
-- (route, backoffice, script) est couvert.
--
-- Concurrence : la conversion (passage de la facture à paid) prend le verrou du lot au COMMIT
-- (Order_check > Batch_lock, FOR NO KEY UPDATE). Le retrait prend le même lot FOR SHARE, qui entre
-- en conflit avec lui, puis relit les lignes payées (nouvel instantané par instruction en
-- READ COMMITTED) :
--   * conversion validée d'abord : le retrait attend son COMMIT, voit la ligne payée et est refusé ;
--   * retrait validé d'abord : la conversion attend, puis passe (un paiement reçu doit être accepté,
--     Order_late_payment_refund) ; la wishlist n'était pas convertie au moment du retrait.
-- Ordre des verrous du retrait : wishlist (FOR NO KEY UPDATE, application) puis lot (FOR SHARE).
-- Aucun chemin ne verrouille le lot puis la ligne Wishlist en mode conflictuel (la clé étrangère
-- d'OrderLine ne prend que FOR KEY SHARE) : pas d'interblocage.
-- Seul le passage actif > retiré est contrôlé ; une wishlist déjà retirée n'est pas touchée.
CREATE FUNCTION "Wishlist_guard_converted"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."cancelled_at" IS NULL AND NEW."cancelled_at" IS NOT NULL THEN
    PERFORM 1 FROM "Batch" WHERE "id" = NEW."batch_id" FOR SHARE;
    IF EXISTS (
      SELECT 1 FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
      WHERE l."wishlist_id" = NEW."id" AND l."refund_id" IS NULL AND o."status" = 'paid'
    ) THEN
      RAISE EXCEPTION 'Wishlist % is converted into a paid order: cancel the order instead (constraint "Wishlist_converted")', NEW."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Wishlist_converted';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Wishlist_guard_converted"
  BEFORE UPDATE OF "cancelled_at" ON "Wishlist"
  FOR EACH ROW EXECUTE FUNCTION "Wishlist_guard_converted"();

-- ─── Wishlist : plafond par utilisateur et par lot ───
-- Wishlists non retirées d'un utilisateur sur un lot <= least(ShopSettings.wishlist_max_per_user_per_batch,
-- Batch.quantity), à la création ou à la réactivation. Verrou de l'utilisateur (FOR NO KEY UPDATE,
-- comme src/server/wishlists.ts) : deux créations simultanées se suivent. Nommé pour s'exécuter
-- avant Wishlist_guard_batch (ordre alphabétique) : utilisateur, puis lot, comme les factures.
CREATE FUNCTION "Wishlist_check_cap"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  n integer;
BEGIN
  IF NEW."cancelled_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."batch_id" = OLD."batch_id" AND NEW."user_id" = OLD."user_id"
     AND OLD."cancelled_at" IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "User" WHERE "id" = NEW."user_id" FOR NO KEY UPDATE;
  SELECT least(("shop_settings"())."wishlist_max_per_user_per_batch", b."quantity") INTO cap
  FROM "Batch" b WHERE b."id" = NEW."batch_id";
  SELECT count(*) INTO n FROM "Wishlist"
  WHERE "user_id" = NEW."user_id" AND "batch_id" = NEW."batch_id" AND "cancelled_at" IS NULL AND "id" <> NEW."id";
  IF n + 1 > cap THEN
    RAISE EXCEPTION 'User % already has % wishlists on batch % (cap %) (constraint "Wishlist_cap")', NEW."user_id", n, NEW."batch_id", cap
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Wishlist_cap';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Wishlist_cap"
  BEFORE INSERT OR UPDATE OF "batch_id", "user_id", "cancelled_at" ON "Wishlist"
  FOR EACH ROW EXECUTE FUNCTION "Wishlist_check_cap"();

-- ─── Configuration : date de dernière modification ───
-- updated_at suit tout changement de choix : item ajouté, modifié ou retiré (choix de
-- l'utilisateur, masquage d'un menu, complétion à la publication) et prix de base. Une
-- configuration verrouillée (ligne de commande) ne change plus. Une seule écriture par transaction.
CREATE FUNCTION "Configuration_set_updated_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."base_price" IS DISTINCT FROM OLD."base_price" THEN
    NEW."updated_at" := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Configuration_set_updated_at"
  BEFORE UPDATE OF "base_price" ON "Configuration"
  FOR EACH ROW EXECUTE FUNCTION "Configuration_set_updated_at"();

CREATE FUNCTION "ConfigurationItem_touch"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Configuration" SET "updated_at" = now()
  WHERE "id" IN (
      CASE TG_OP WHEN 'INSERT' THEN NULL ELSE OLD."configuration_id" END,
      CASE TG_OP WHEN 'DELETE' THEN NULL ELSE NEW."configuration_id" END)
    AND "locked_at" IS NULL AND "updated_at" < now();
  RETURN NULL;
END;
$$;

CREATE TRIGGER "ConfigurationItem_touch"
  AFTER INSERT OR UPDATE OR DELETE ON "ConfigurationItem"
  FOR EACH ROW EXECUTE FUNCTION "ConfigurationItem_touch"();

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

-- Garde d'immuabilité (Wishlist_check_configuration_open), avec deux exceptions :
--   * ConfigurationItem : le retour au défaut d'une valeur retirée (configuration_item_withdrawal_reset) ;
--   * Configuration : la seule date de dernière modification (ConfigurationItem_touch, qui suit ce retour).
CREATE FUNCTION "Wishlist_guard_configuration_frozen"() RETURNS trigger
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

CREATE TRIGGER "Configuration_wishlist_frozen"
  BEFORE UPDATE OR DELETE ON "Configuration"
  FOR EACH ROW EXECUTE FUNCTION "Wishlist_guard_configuration_frozen"();

CREATE TRIGGER "ConfigurationItem_wishlist_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "ConfigurationItem"
  FOR EACH ROW EXECUTE FUNCTION "Wishlist_guard_configuration_frozen"();

CREATE TRIGGER "Wishlist_configuration_frozen"
  BEFORE UPDATE OF "configuration_id" ON "Wishlist"
  FOR EACH ROW EXECUTE FUNCTION "Wishlist_guard_configuration_frozen"();

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

-- ─── Option retirée : ajustement immédiat, avertissement aux seules wishlists vivantes ───

-- Statuts où un retrait ajuste tout de suite les configurations ouvertes du lot : tant que le lot vit.
CREATE FUNCTION "batch_withdrawal_applies"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st NOT IN ('closed', 'cancelled')
$$;

-- Retrait d'une valeur (ligne insérée ou passée à enabled = false). Le défaut lui-même n'est jamais
-- retiré (BatchOptionValue_default_enabled, différé, nomme l'erreur).
CREATE FUNCTION "BatchOptionValue_reset_withdrawn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "batch_withdrawal_applies"((SELECT "status" FROM "Batch" WHERE "id" = NEW."batch_id")) THEN
    PERFORM "batch_reset_withdrawn_choices"(NEW."batch_id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "BatchOptionValue_withdraw_from_wishlists" AFTER INSERT OR UPDATE OF "enabled" ON "BatchOptionValue"
FOR EACH ROW WHEN (NOT NEW."enabled")
EXECUTE FUNCTION "BatchOptionValue_reset_withdrawn"();

-- Journal : chaque retour au défaut d'une valeur retirée, quel que soit l'écrivain, seulement pour une
-- wishlist à prévenir, ni retirée ni convertie (ligne non remboursée d'une commande
-- payée). Les autres configurations ouvertes sont ajustées sans avertissement.
CREATE FUNCTION "ConfigurationItem_log_withdrawal"() RETURNS trigger
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

CREATE TRIGGER "ConfigurationItem_log_withdrawal" AFTER UPDATE OF "option_value_id" ON "ConfigurationItem"
FOR EACH ROW WHEN (OLD."option_value_id" IS DISTINCT FROM NEW."option_value_id")
EXECUTE FUNCTION "ConfigurationItem_log_withdrawal"();

-- Journal des ajustements : en ajout seul.
CREATE TRIGGER "WishlistOptionWithdrawal_append_only"
  BEFORE UPDATE OR DELETE ON "WishlistOptionWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();
