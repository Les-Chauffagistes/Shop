-- batch_part_needs.delivered_qty : kits effectivement reçus pour le lot (somme des réceptions
-- rattachées à ses commandes), et non la quantité commandée des commandes livrées. Une commande
-- livrée avec 3 kits reçus sur 6 commandés compte 3. Mêmes colonnes, mêmes types : les vues qui en
-- dépendent (part_stock_pressure) ne bougent pas.
CREATE OR REPLACE VIEW "batch_part_needs" AS
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
