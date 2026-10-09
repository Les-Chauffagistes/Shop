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
--   * complétion à la (re)publication (BatchStatusTransition_apply, sortie de draft) : items écrits
--     avant le changement de statut, le lot est encore draft ;
--   * le changement de défaut (OptionValue_default_change_locked) n'écrit jamais, il refuse.
-- Le passage survey > preorder n'écrit aucune configuration.
--
-- Verrou partagé du lot (FOR KEY SHARE) : attend une transition concurrente (FOR UPDATE dans
-- BatchStatusTransition_apply) puis relit le statut validé ; une modification validée avant
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

CREATE FUNCTION "Wishlist_guard_configuration_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Branches IF : plpgsql ne résout NEW.<champ> / OLD.<champ> que dans la branche exécutée
  IF TG_TABLE_NAME = 'Configuration' THEN
    PERFORM "Wishlist_check_configuration_open"(OLD."id");
  ELSIF TG_TABLE_NAME = 'ConfigurationItem' THEN
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
