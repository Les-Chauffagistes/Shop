-- ═════════════════════════════════════════════
-- Produits d'options (Part) : stock commun tenu par un journal en ajout seul (PartStockMovement :
-- réception, ajustement, kit monté), commandes de matériel par lot (BatchPartOrder), vues de besoin
-- et de pression calculées à la lecture (décisions Hugo 2026-10-07).
-- ═════════════════════════════════════════════

-- ─── Contraintes CHECK et index hors Prisma ───

-- PartStockMovement
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_kind_check" CHECK (
  CASE "kind"
    WHEN 'reception'   THEN "qty" > 0 AND "batch_id" IS NULL AND "machine_id" IS NULL
    WHEN 'adjustment'  THEN "qty" <> 0 AND "batch_part_order_id" IS NULL AND "batch_id" IS NULL
                            AND "machine_id" IS NULL AND btrim(coalesce("note", '')) <> ''
    WHEN 'kit_mounted' THEN "qty" < 0 AND "batch_part_order_id" IS NULL AND "batch_id" IS NOT NULL
  END);

ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_created_by_check" CHECK ("created_by_auth_user_id" > 0);

-- BatchPartOrder
ALTER TABLE "BatchPartOrder" ADD CONSTRAINT "BatchPartOrder_qty_check" CHECK ("qty" > 0);

ALTER TABLE "BatchPartOrder" ADD CONSTRAINT "BatchPartOrder_delivered_at_check"
  CHECK (("status" = 'delivered') = ("delivered_at" IS NOT NULL));

-- Kit monté : le produit équipe une valeur d'option du modèle du lot (lot absent : CHECK) ; la machine, si elle
-- est donnée, appartient à ce lot au moment du montage (clé étrangère simple vers la machine, appartenance
-- vérifiée ici : PartStockMovement_machine_in_batch ; machine sans lot : refusée par le CHECK de type).
CREATE FUNCTION "PartStockMovement_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."machine_id" IS NOT NULL AND NEW."batch_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Machine" WHERE "id" = NEW."machine_id" AND "batch_id" = NEW."batch_id"
  ) THEN
    RAISE EXCEPTION 'Machine % does not belong to batch % (constraint "PartStockMovement_machine_in_batch")', NEW."machine_id", NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'PartStockMovement_machine_in_batch';
  END IF;
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
--   ordered_qty   commandes de ce lot (BatchPartOrder) non livrées ;
--   delivered_qty kits effectivement reçus pour le lot (somme des réceptions rattachées à ses commandes),
--                 et non la quantité commandée des commandes livrées : 3 kits reçus sur 6 commandés comptent 3.
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
      coalesce(sum(r."qty"), 0)::integer AS "delivered"
    FROM "BatchPartOrder" o
    LEFT JOIN "PartStockMovement" r ON r."batch_part_order_id" = o."id"
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

-- Journal de stock : en ajout seul.
CREATE TRIGGER "PartStockMovement_append_only"
  BEFORE UPDATE OR DELETE ON "PartStockMovement"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();
