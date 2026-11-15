-- ═════════════════════════════════════════════
-- Lots : statut piloté par le journal des transitions (BatchStatusTransition), menus et valeurs
-- d'options propres au lot (BatchOption, BatchOptionValue), fonctions de statut lues par les autres
-- domaines (commandes acceptées, visibilité publique, renoncement).
-- Deux types de lot (Batch.kind, immuable ; refonte machines / stock, jalon R2) :
--   * wholesale : palette achetée en gros, avec son cycle de vie (sondage, précommande… clôture) ; on y vend
--     exactement les machines du lot (quantity), même avant leur arrivée ;
--   * stock     : lot permanent, un par modèle (Batch_one_stock_per_model), sans quantité ni prix d'achat ; on y
--     vend les machines en main, contrôlées et vendables (capacité : fichier stock). Statuts : draft (en pause,
--     catalogue vivant) et on_sale (en vente). Alimenté par les réassorts (StockRestock), les transferts depuis
--     une palette (MachineTransfer, clôture comprise) et les machines reçues en plus d'une palette (machines).
-- Une transition de statut passe par six triggers à responsabilité unique, déclenchés dans l'ordre de leur nom
-- (BEFORE INSERT sur BatchStatusTransition) :
--   1_check            machine à états : statut courant (sous verrou du lot), couple autorisé pour le type,
--                      annulation refusée tant qu'une facture est payée (ce fichier) ;
--   2_cancel_orders    lot qui ferme les commandes : factures en attente sans versement annulées (ce fichier) ;
--   3_snapshot_options publication : instantané des menus et des valeurs (ce fichier) ;
--   4_set_status       écrit le statut du lot (ce fichier) ;
--   5_generate_machines entrée en Attente de réception : machines attendues (fichier machines) ;
--   6_close_to_stock   clôture d'une palette : invendus en main transférés au lot de stock (fichier machines).
-- ═════════════════════════════════════════════

-- ─── Contraintes CHECK et index hors Prisma ───

-- Batch
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_quantity_check" CHECK ("quantity" > 0);

ALTER TABLE "Batch" ADD CONSTRAINT "Batch_purchase_price_check" CHECK ("purchase_price" >= 0);

-- Quantité et prix d'achat : ceux de la palette ; un lot de stock n'en a pas (réassorts : StockRestock).
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_kind_check" CHECK (
  CASE "kind"
    WHEN 'wholesale' THEN "quantity" IS NOT NULL AND "purchase_price" IS NOT NULL
    ELSE "quantity" IS NULL AND "purchase_price" IS NULL
  END);

-- Statuts d'un type : on_sale est réservé au lot de stock, qui n'a que draft (en pause) et on_sale.
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_kind_status_check" CHECK (
  CASE "kind"
    WHEN 'stock' THEN "status" IN ('draft', 'on_sale')
    ELSE "status" <> 'on_sale'
  END);

ALTER TABLE "Batch" ADD CONSTRAINT "Batch_resale_unit_price_check" CHECK ("resale_unit_price" >= 0);

-- Prix de revente requis pour publier (sondage) et pour toute étape suivante
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_resale_unit_price_required_check"
  CHECK ("status" IN ('draft', 'cancelled') OR "resale_unit_price" IS NOT NULL);

ALTER TABLE "Batch" ADD CONSTRAINT "Batch_name_check" CHECK (btrim("name") <> '');

-- BatchOptionValue
ALTER TABLE "BatchOptionValue" ADD CONSTRAINT "BatchOptionValue_price_override_check" CHECK ("price_override" >= 0);

ALTER TABLE "BatchOptionValue" ADD CONSTRAINT "BatchOptionValue_max_qty_check" CHECK ("max_qty" >= 0);

-- BatchStatusTransition
ALTER TABLE "BatchStatusTransition" ADD CONSTRAINT "BatchStatusTransition_changed_by_check" CHECK ("changed_by_auth_user_id" > 0);

-- ─── Options : défaut brut, menus et valeurs d'un lot ───
-- Décisions Hugo 2026-10-06 (roadmap, « Options par défaut et menus masqués », « Prix, devise
-- et menus ajoutés ») :
--   * la valeur par défaut d'un menu est la machine « brute » : gratuite partout (CHECK
--     OptionValue_default_free_check, pas de dérogation non nulle, unit_price 0) ;
--   * un lot peut masquer un menu (BatchOption.hidden) : le défaut s'applique d'office ;
--   * menus et valeurs d'un lot = catalogue vivant tant qu'il est en brouillon, puis INSTANTANÉ
--     pris à la publication (sortie de draft, hors annulation) : BatchOption reçoit une ligne par
--     menu du modèle, BatchOptionValue une ligne par valeur de ces menus. Un menu ou une valeur
--     créés ensuite ne s'appliquent pas au lot (défaut implicite pour un menu). Proposer plus tard
--     une nouvelle valeur sur un lot publié = insérer sa ligne BatchOptionValue (décision admin) ;
--   * prix et menu d'une valeur figés tant qu'elle est proposée par un lot en cours (survey à
--     in_transit) : on passe par BatchOptionValue.price_override.
-- Une Configuration porte un item par menu visible de son lot, défaut compris (voir configurations) ;
-- un menu masqué ou non applicable n'a jamais d'item : son défaut vaut implicitement.

-- Statuts d'un lot qui figent le prix et le menu des valeurs qu'il propose : de nouvelles
-- configurations peuvent encore y être créées (wishlist au sondage, commandes ensuite ; lot de stock en
-- vente). Brouillon (dont un lot de stock en pause) : catalogue vivant ; clos / annulé : plus aucune
-- configuration possible. Un lot de stock en vente fige donc en permanence les prix catalogue de ses
-- valeurs : on passe par BatchOptionValue.price_override (les instantanés protègent les factures).
CREATE FUNCTION "batch_catalog_frozen"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st IN ('survey', 'preorder', 'ordering', 'awaiting_reception', 'inspection', 'tuning', 'packaging', 'in_transit',
                'on_sale')
$$;

-- Menus applicables à un lot. Brouillon : tous les menus du modèle (catalogue vivant), avec le
-- réglage hidden s'il existe. Publié : l'instantané BatchOption. hidden = menu masqué.
CREATE FUNCTION "batch_menus"(b uuid)
RETURNS TABLE ("option_id" uuid, "hidden" boolean)
LANGUAGE sql STABLE AS $$
  SELECT o."id", coalesce(bo."hidden", false)
  FROM "Batch" ba
  JOIN "Option" o ON o."model_id" = ba."model_id"
  LEFT JOIN "BatchOption" bo ON bo."batch_id" = ba."id" AND bo."option_id" = o."id"
  WHERE ba."id" = b AND (ba."status" = 'draft' OR bo."option_id" IS NOT NULL)
$$;

-- Valeurs proposées au choix sur un lot, avec leur prix effectif : menu applicable et non masqué ;
-- brouillon : valeur non retirée (absence de ligne = proposée) ; publié : valeur de l'instantané
-- (ligne BatchOptionValue) non retirée. Un menu masqué n'a aucune valeur au choix.
CREATE FUNCTION "batch_offered_values"(b uuid)
RETURNS TABLE ("option_id" uuid, "option_value_id" uuid, "price" bigint)
LANGUAGE sql STABLE AS $$
  SELECT v."option_id", v."id", coalesce(bov."price_override", v."price")
  FROM "Batch" ba
  JOIN "batch_menus"(b) m ON NOT m."hidden"
  JOIN "OptionValue" v ON v."option_id" = m."option_id"
  LEFT JOIN "BatchOptionValue" bov ON bov."batch_id" = ba."id" AND bov."option_value_id" = v."id"
  WHERE ba."id" = b AND coalesce(bov."enabled", ba."status" = 'draft')
$$;

-- Le défaut d'un menu, sur chaque lot :
--   * n'est jamais retiré (enabled = false) ;
--   * fait partie de l'instantané d'un lot publié où son menu s'applique (une valeur créée après
--     la publication ne peut donc devenir le défaut que si l'admin la propose d'abord sur ce lot) ;
--   * n'a pas de dérogation de prix non nulle (le défaut est gratuit).
-- Vérifié des deux côtés (réglage du lot, changement de défaut au catalogue), en différé.
CREATE FUNCTION "BatchOptionValue_check_default"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  vid uuid;
BEGIN
  -- Branches IF : plpgsql ne résout NEW.<champ> que dans la branche exécutée
  IF TG_TABLE_NAME = 'OptionValue' THEN vid := NEW."id"; ELSE vid := NEW."option_value_id"; END IF;
  IF NOT EXISTS (SELECT 1 FROM "OptionValue" WHERE "id" = vid AND "is_default") THEN
    RETURN NULL;
  END IF;
  PERFORM "model_lock_batches"(o."model_id")
  FROM "OptionValue" v JOIN "Option" o ON o."id" = v."option_id" WHERE v."id" = vid;

  IF EXISTS (
    SELECT 1 FROM "BatchOptionValue" bov
    JOIN "OptionValue" v ON v."id" = bov."option_value_id"
    WHERE bov."option_value_id" = vid AND v."is_default" AND NOT bov."enabled"
  ) THEN
    RAISE EXCEPTION 'Default option value % cannot be withdrawn from a batch (constraint "BatchOptionValue_default_enabled")', vid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOptionValue_default_enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "OptionValue" v
    JOIN "BatchOption" bo ON bo."option_id" = v."option_id"
    JOIN "Batch" b ON b."id" = bo."batch_id"
    WHERE v."id" = vid AND v."is_default" AND b."status" <> 'draft'
      AND NOT EXISTS (SELECT 1 FROM "BatchOptionValue" bov WHERE bov."batch_id" = b."id" AND bov."option_value_id" = vid)
  ) THEN
    RAISE EXCEPTION 'Default option value % is not offered on a published batch of its menu (constraint "BatchOptionValue_default_enabled")', vid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOptionValue_default_enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "BatchOptionValue" bov
    JOIN "OptionValue" v ON v."id" = bov."option_value_id"
    WHERE bov."option_value_id" = vid AND v."is_default" AND bov."price_override" <> 0
  ) THEN
    RAISE EXCEPTION 'Default option value % is free: no price override (constraint "BatchOptionValue_default_free")', vid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOptionValue_default_free';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "BatchOptionValue_default_enabled"
  AFTER INSERT OR UPDATE OF "enabled", "option_value_id", "price_override" ON "BatchOptionValue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "BatchOptionValue_check_default"();

CREATE CONSTRAINT TRIGGER "OptionValue_default_enabled"
  AFTER INSERT OR UPDATE OF "is_default" ON "OptionValue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."is_default") EXECUTE FUNCTION "BatchOptionValue_check_default"();

-- Menus d'un lot (BatchOption). Lignes ajoutées ou retirées seulement en brouillon (ensuite :
-- instantané de publication) ; hidden modifiable en brouillon et au sondage seulement : dès la
-- précommande, des configurations sont payées et figées, masquer ou démasquer un menu traiterait
-- différemment deux clients du même lot. Verrouille le lot (FOR UPDATE) : sérialise avec
-- ConfigurationItem_guard (FOR KEY SHARE) pour BatchOption_hidden_chosen.
CREATE FUNCTION "BatchOption_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st "batch_status";
BEGIN
  SELECT "status" INTO st FROM "Batch"
  WHERE "id" = CASE TG_OP WHEN 'DELETE' THEN OLD."batch_id" ELSE NEW."batch_id" END
  FOR UPDATE;
  IF NOT FOUND THEN -- suppression du lot en cascade
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF st <> 'draft' AND (TG_OP <> 'UPDATE'
     OR (NEW."batch_id", NEW."model_id", NEW."option_id") IS DISTINCT FROM (OLD."batch_id", OLD."model_id", OLD."option_id")) THEN
    RAISE EXCEPTION 'Menus of a published batch are fixed at publication (constraint "BatchOption_snapshot")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOption_snapshot';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."hidden" IS DISTINCT FROM OLD."hidden" AND st NOT IN ('draft', 'survey') THEN
    RAISE EXCEPTION 'A menu is hidden or shown only while the batch is draft or survey (constraint "BatchOption_hidden_locked")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOption_hidden_locked';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "BatchOption_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "BatchOption"
  FOR EACH ROW EXECUTE FUNCTION "BatchOption_guard"();

-- Menu masqué : aucune configuration du lot n'a d'item dans ce menu (différé : masquer et
-- effacer les choix des wishlists dans la même transaction).
CREATE FUNCTION "BatchOption_check_hidden"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BatchOption" bo
    JOIN "Configuration" c ON c."batch_id" = bo."batch_id"
    JOIN "ConfigurationItem" ci ON ci."configuration_id" = c."id" AND ci."option_id" = bo."option_id"
    WHERE bo."batch_id" = NEW."batch_id" AND bo."option_id" = NEW."option_id" AND bo."hidden"
  ) THEN
    RAISE EXCEPTION 'Menu % is hidden on batch % but a configuration has a choice in it (constraint "BatchOption_hidden_chosen")', NEW."option_id", NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOption_hidden_chosen';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "BatchOption_hidden_chosen"
  AFTER INSERT OR UPDATE OF "hidden" ON "BatchOption"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."hidden") EXECUTE FUNCTION "BatchOption_check_hidden"();

-- ─── Statut du lot : piloté par le journal des transitions ───

-- Transitions autorisées, par type de lot.
-- Palette (revue logistique §5.1, T1 à T18, avec closed comme statut terminal) : aucun retour vers draft /
-- survey une fois la précommande ouverte (décision Hugo 2026-10-06) ; seul survey>draft revient en arrière
-- avant l'ouverture.
-- Stock (refonte, décision Hugo 2026-11-10) : mise en vente et pause, sans fin (draft ↔ on_sale).
-- Création (f NULL) : vers draft seulement. Les conditions métier (seuils, machines contrôlées…) restent dans
-- la fonction de domaine.
CREATE FUNCTION "batch_transition_allowed"(k "batch_kind", f "batch_status", t "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN f IS NULL THEN t = 'draft'
    WHEN k = 'stock' THEN (f::text || '>' || t::text) IN ('draft>on_sale', 'on_sale>draft')
    ELSE (f::text || '>' || t::text) IN (
      'draft>survey', 'draft>preorder', 'draft>ordering', 'draft>cancelled',
      'survey>preorder', 'survey>draft', 'survey>cancelled',
      'preorder>ordering', 'preorder>cancelled',
      'ordering>awaiting_reception', 'ordering>cancelled',
      'awaiting_reception>inspection', 'awaiting_reception>cancelled',
      'inspection>tuning', 'inspection>packaging', 'inspection>awaiting_reception',
      'tuning>packaging', 'tuning>inspection',
      'packaging>in_transit', 'packaging>tuning', 'packaging>inspection',
      'in_transit>closed')
  END
$$;

-- Batch.status : naît draft, ne change que via BatchStatusTransition (trigger imbriqué).
CREATE FUNCTION "Batch_guard_status"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' THEN
      RAISE EXCEPTION 'A batch is created as draft (constraint "Batch_status_guard")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Batch_status_guard';
    END IF;
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Batch.status changes only by inserting a BatchStatusTransition (constraint "Batch_status_guard")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Batch_status_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Batch_guard_status"
  BEFORE INSERT OR UPDATE OF "status" ON "Batch"
  FOR EACH ROW EXECUTE FUNCTION "Batch_guard_status"();

-- Batch.kind : fixé à la création (le type décide des transitions, de la capacité et des machines).
CREATE FUNCTION "Batch_guard_kind"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'Batch % keeps its kind (constraint "Batch_kind_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Batch_kind_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Batch_guard_kind"
  BEFORE UPDATE OF "kind" ON "Batch"
  FOR EACH ROW EXECUTE FUNCTION "Batch_guard_kind"();

-- Réglages de valeurs (BatchOptionValue) d'un lot publié : ce sont les lignes de l'instantané.
-- Jamais supprimées (une suppression retirerait la valeur en silence : enabled = false pour la
-- retirer). « Proposer sur ce lot » une valeur créée après publication = insérer sa ligne :
-- seulement sur un lot qui accepte encore des configurations et dans un menu
-- applicable au lot (survey à in_transit, ou lot de stock en vente : batch_catalog_frozen). Ce qui est
-- modifiable selon le statut reste dans le domaine (EDITABLE_FIELDS).
-- FOR KEY SHARE : attend une publication concurrente.
CREATE FUNCTION "BatchOptionValue_guard"() RETURNS trigger
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

CREATE TRIGGER "BatchOptionValue_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "BatchOptionValue"
  FOR EACH ROW EXECUTE FUNCTION "BatchOptionValue_guard"();

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

-- ─── Fonctions de statut lues par les autres domaines ───

-- Commandes acceptées (création d'une facture, passage à paid) : palette de la Précommande au Packaging
-- inclus ; lot de stock en vente (on_sale). En transit : machines remises au transporteur, plus de commande
-- (décision par défaut, à confirmer par Hugo). C'est la seule source de la règle (triggers Order_guard, vue
-- order_payment_balance, batch_is_public, src/server/shop.ts).
CREATE FUNCTION "batch_accepts_orders"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st IN ('preorder', 'ordering', 'awaiting_reception', 'inspection', 'tuning', 'packaging', 'on_sale')
$$;

-- Visibilité publique : sondage + commandes ouvertes (un lot en transit ou un lot de stock en pause n'est plus listé).
CREATE FUNCTION "batch_is_public"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st = 'survey' OR "batch_accepts_orders"(st)
$$;

-- Journée de priorité à l'ouverture des précommandes. Fin : première ouverture des précommandes + 1 jour, pour un lot passé par le sondage et qui a au
-- moins une wishlist active. Plus tôt si toutes les wishlists actives sont converties (ligne non
-- remboursée d'une facture payée) : à la dernière conversion (paid_at), jamais avant l'ouverture.
-- NULL : pas de priorité (lot ouvert sans sondage, aucune wishlist active, toutes retirées, ou
-- précommandes pas encore ouvertes). Calculée à la lecture : si une conversion est remboursée pendant
-- la journée, la priorité reprend jusqu'à la fin prévue.
CREATE FUNCTION "batch_priority_ends_at"(b uuid) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN op."at" IS NULL OR ws."n" = 0 THEN NULL
    WHEN ws."n_converted" = ws."n" THEN least(op."at" + interval '1 day', greatest(op."at", ws."last_converted"))
    ELSE op."at" + interval '1 day'
  END
  FROM (
    SELECT min(p."created_at") AS "at"
    FROM "BatchStatusTransition" p
    WHERE p."batch_id" = b AND p."to_status" = 'preorder'
      AND EXISTS (SELECT 1 FROM "BatchStatusTransition" s WHERE s."batch_id" = b AND s."to_status" = 'survey')
  ) op,
  (
    SELECT count(*) AS "n", count(c."at") AS "n_converted", max(c."at") AS "last_converted"
    FROM "Wishlist" w
    CROSS JOIN LATERAL (
      SELECT max(o."paid_at") AS "at"
      FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
      WHERE l."wishlist_id" = w."id" AND l."refund_id" IS NULL AND o."status" = 'paid'
    ) c
    WHERE w."batch_id" = b AND w."cancelled_at" IS NULL
  ) ws
$$;

-- Lots où l'utilisateur renonce lui-même à une commande payée : palette jusqu'à Précommande incluse. Une seule
-- fonction à modifier pour déplacer la limite. Lot de stock : jamais, en vente comme en pause (rétractation sur le
-- stock hors périmètre de la refonte ; l'admin peut toujours enregistrer un renoncement).
CREATE FUNCTION "batch_allows_user_renunciation"(k "batch_kind", st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT k = 'wholesale' AND st IN ('draft', 'survey', 'preorder')
$$;

-- ─── Transition de statut ───
-- Six triggers BEFORE INSERT, dans l'ordre de leur nom (voir l'en-tête). Les quatre premiers sont ici, les deux
-- derniers (machines) dans le fichier machines.

-- 1. Machine à états. Verrouille le lot (FOR UPDATE) jusqu'à la fin de la transaction : toute écriture qui lit le
-- statut sous verrou partagé (FOR KEY SHARE / FOR SHARE) attend la transition. Vérifie, dans cet ordre :
--   * création (from_status NULL) : seulement pour un nouveau brouillon, une seule fois ; sinon from_status est le
--     statut courant (BatchStatusTransition_current) ;
--   * couple autorisé pour le type du lot (BatchStatusTransition_allowed_check, batch_transition_allowed) ;
--   * annulation : refusée tant qu'une facture est payée, rembourser d'abord (roadmap, décisions Paiement).
CREATE FUNCTION "BatchStatusTransition_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b "Batch"%ROWTYPE;
BEGIN
  SELECT * INTO b FROM "Batch" WHERE "id" = NEW."batch_id" FOR UPDATE;
  IF NEW."from_status" IS NULL THEN
    IF b."status" <> 'draft' OR EXISTS (SELECT 1 FROM "BatchStatusTransition" WHERE "batch_id" = NEW."batch_id") THEN
      RAISE EXCEPTION 'Creation transition only for a new draft batch % (constraint "BatchStatusTransition_current")', NEW."batch_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_current';
    END IF;
  ELSIF b."status" IS DISTINCT FROM NEW."from_status" THEN
    RAISE EXCEPTION 'Batch % is %, not % (constraint "BatchStatusTransition_current")', NEW."batch_id", b."status", NEW."from_status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_current';
  END IF;
  IF NOT "batch_transition_allowed"(b."kind", NEW."from_status", NEW."to_status") THEN
    RAISE EXCEPTION 'Transition % > % is not allowed for a % batch (constraint "BatchStatusTransition_allowed_check")',
      NEW."from_status", NEW."to_status", b."kind"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_allowed_check';
  END IF;
  IF NEW."to_status" = 'cancelled' AND EXISTS (
    SELECT 1 FROM "Order" WHERE "batch_id" = NEW."batch_id" AND "status" = 'paid'
  ) THEN
    RAISE EXCEPTION 'Batch % has paid orders: refund them before cancelling (constraint "BatchStatusTransition_cancel_refunded")', NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_cancel_refunded';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BatchStatusTransition_1_check"
  BEFORE INSERT ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "BatchStatusTransition_check"();

-- 2. Lot qui n'accepte plus de commande (batch_accepts_orders faux : annulé, en transit, clos, lot de stock mis en
-- pause) : ses factures en attente sans aucun versement et à réservation vivante passent à « annulée », cause
-- batch_closed (seul écrivain de cette cause, Order_cancel_reason_batch_closed ; cancelled_at posé par
-- Order_guard). Une facture n'est jamais supprimée et son adresse de paiement reste supervisée : un versement reçu
-- ensuite reste « à traiter » pour l'admin (order_payment_balance.needs_admin_decision). Le WHERE est réévalué sous
-- le verrou de la ligne : un versement validé entre-temps (facture partiellement payée, qui reste « à traiter »),
-- ou une annulation par le client validée juste avant (cause user conservée), exclut la facture. Les factures
-- expirées (expires_at passé) n'ont plus rien à annuler (Order_cancel_expired).
CREATE FUNCTION "BatchStatusTransition_cancel_orders"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."from_status" IS NOT NULL AND NOT coalesce("batch_accepts_orders"(NEW."to_status"), false) THEN
    UPDATE "Order" SET "status" = 'cancelled', "cancel_reason" = 'batch_closed', "updated_at" = now()
    WHERE "batch_id" = NEW."batch_id" AND "status" = 'pending_payment'
      AND "received_sats" = 0 AND "received_cents" = 0 AND "expires_at" > now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BatchStatusTransition_2_cancel_orders"
  BEFORE INSERT ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "BatchStatusTransition_cancel_orders"();

-- 3. Publication (sortie de draft, hors annulation) : instantané des menus (BatchOption) et des valeurs
-- (BatchOptionValue) du modèle, en complétant les réglages du brouillon ; les configurations ouvertes (wishlists
-- restées après un retour survey > draft) reçoivent le défaut des menus visibles qui leur manquent. Pris avant le
-- changement de statut (les gardes de ces tables l'autorisent encore). Re-publication après survey > draft, ou
-- remise en vente d'un lot de stock en pause : complète de même (ON CONFLICT DO NOTHING).
CREATE FUNCTION "BatchStatusTransition_snapshot_options"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BatchStatusTransition_3_snapshot_options"
  BEFORE INSERT ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "BatchStatusTransition_snapshot_options"();

-- 4. Applique to_status au lot (trigger imbriqué : Batch_guard_status le permet).
CREATE FUNCTION "BatchStatusTransition_set_status"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."from_status" IS NOT NULL THEN
    UPDATE "Batch" SET "status" = NEW."to_status", "updated_at" = now() WHERE "id" = NEW."batch_id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BatchStatusTransition_4_set_status"
  BEFORE INSERT ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "BatchStatusTransition_set_status"();

-- Journal des transitions : en ajout seul.
CREATE TRIGGER "BatchStatusTransition_append_only"
  BEFORE UPDATE OR DELETE ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();
