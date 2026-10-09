-- ═════════════════════════════════════════════
-- v5d : lacunes signalées par backend-dev (jalon 4).
--   1. OrderLine.position : ordre stable des lignes d'une facture, posé par la base à l'insertion
--      (1, 2, 3… dans l'ordre d'insertion, donc celui de la requête), unique par facture, immuable.
--   2. Dates de création posées par l'horloge de la base : Order.created_at et OrderLine.created_at
--      (transaction_timestamp() = now(), comme expires_at : created_at + 30 min = expires_at), Refund.created_at (clock_timestamp(),
--      ordonne plusieurs remboursements d'une même transaction). Côté Prisma : @default(dbgenerated(…)),
--      le client n'envoie plus l'heure de l'hôte. Une valeur fournie reste acceptée (tests et seed antidatent).
--      Payment.received_at et OrderBlockRelease.created_at étaient déjà posés par la base (clock_timestamp()).
--   3. order_payment_balance.needs_admin_attention inclut awaiting_decision (paiement complet resté sans
--      traitement automatique, en particulier sur une réservation vivante qui ne tient plus dans le stock :
--      Order_late_payment_refund interdit alors le remboursement, et Order_fits_stock est faux). Nouvelle
--      colonne fits_stock (en fin de vue) : la facture tiendrait-elle dans le stock si elle était payée
--      maintenant (estimation sans verrou ; la décision reste Order_fits_stock, sous verrou du lot).
-- Aucune donnée supprimée ni réécrite : une colonne ajoutée et remplie (ordre created_at, id existant),
-- des défauts de colonnes changés, un index remplacé par un index unique qui le couvre, une fonction et
-- une vue redéfinies (colonnes existantes inchangées, une ajoutée en fin).
-- ═════════════════════════════════════════════

-- ─── (1) Position des lignes ──────────────────

ALTER TABLE "OrderLine" ADD COLUMN "position" INTEGER;

-- Reprise : ordre déjà servi par l'API (created_at, puis id). OrderLine_guard (version v5b) ne fige pas
-- encore position : la mise à jour passe ; Order_check (différé) revérifie des factures inchangées.
UPDATE "OrderLine" l SET "position" = n."rn"
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "order_id" ORDER BY "created_at", "id")::integer AS "rn"
  FROM "OrderLine"
) n
WHERE n."id" = l."id";

-- Défaut sans signification (le trigger le remplace toujours) : rend la colonne facultative pour Prisma.
ALTER TABLE "OrderLine" ALTER COLUMN "position" SET DEFAULT 0;
ALTER TABLE "OrderLine" ALTER COLUMN "position" SET NOT NULL;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_position_check" CHECK ("position" >= 1);

-- Couvre aussi les recherches par order_id (clé étrangère, lignes d'une facture) : l'ancien index est retiré.
CREATE UNIQUE INDEX "OrderLine_order_id_position_key" ON "OrderLine"("order_id", "position");
DROP INDEX "OrderLine_order_id_idx";

-- OrderLine_guard : identique à v5b, plus
--   * à l'insertion, position := dernière position de la facture + 1 (valeur fournie ignorée). Les lignes
--     de la même instruction déjà insérées sont visibles (trigger BEFORE ROW, comme Order_max_lines) :
--     un createMany numérote dans l'ordre de ses valeurs. Lignes jamais supprimées : pas de trou ;
--   * position immuable (OrderLine_frozen).
CREATE OR REPLACE FUNCTION "OrderLine_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st "order_status";
  quota integer;
  used integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An order line is never deleted: refund it (constraint "OrderLine_no_delete")'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'OrderLine_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO st FROM "Order" WHERE "id" = NEW."order_id";
    IF st IS DISTINCT FROM 'pending_payment' THEN
      RAISE EXCEPTION 'Order lines can only be added while the order is pending_payment (constraint "OrderLine_frozen")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_frozen';
    END IF;
    IF NEW."machine_id" IS NOT NULL OR NEW."refund_id" IS NOT NULL THEN
      RAISE EXCEPTION 'A new order line has no machine and no refund (constraint "OrderLine_new")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_new';
    END IF;
    IF NEW."wishlist_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "Wishlist" WHERE "id" = NEW."wishlist_id" AND "cancelled_at" IS NULL
    ) THEN
      RAISE EXCEPTION 'Wishlist % is withdrawn: it cannot be ordered (constraint "OrderLine_wishlist_live")', NEW."wishlist_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_wishlist_live';
    END IF;
    IF (SELECT count(*) FROM "OrderLine" WHERE "order_id" = NEW."order_id") >= ("shop_settings"())."order_max_lines" THEN
      RAISE EXCEPTION 'Order % has reached the maximum number of machines per order (constraint "Order_max_lines")', NEW."order_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_max_lines';
    END IF;
    NEW."position" := (SELECT coalesce(max("position"), 0) + 1 FROM "OrderLine" WHERE "order_id" = NEW."order_id");
    IF coalesce(now() < "batch_priority_ends_at"(NEW."batch_id"), false) THEN
      quota := "user_priority_quota"(NEW."batch_id", NEW."user_id");
      SELECT count(*) INTO used
      FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
      WHERE l."batch_id" = NEW."batch_id" AND l."user_id" = NEW."user_id" AND l."refund_id" IS NULL
        AND ("order_holds_stock"(o."status", o."expires_at") OR l."order_id" = NEW."order_id");
      IF used >= quota THEN
        RAISE EXCEPTION 'User % has % wishlists on batch %: no more machines during the priority window (constraint "OrderLine_priority_quota")',
          NEW."user_id", quota, NEW."batch_id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_priority_quota';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM "Wishlist" WHERE "configuration_id" = NEW."configuration_id") THEN
      RAISE EXCEPTION 'Configuration % belongs to a wishlist: copy it for the order line (constraint "OrderLine_configuration_own")', NEW."configuration_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_configuration_own';
    END IF;
    UPDATE "Configuration" SET "locked_at" = now()
    WHERE "id" = NEW."configuration_id" AND "locked_at" IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Configuration % is already locked, one configuration per line (constraint "OrderLine_configuration_own")', NEW."configuration_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_configuration_own';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."order_id", NEW."user_id", NEW."batch_id", NEW."configuration_id", NEW."wishlist_id", NEW."amount", NEW."created_at", NEW."position")
     IS DISTINCT FROM (OLD."order_id", OLD."user_id", OLD."batch_id", OLD."configuration_id", OLD."wishlist_id", OLD."amount", OLD."created_at", OLD."position") THEN
    RAISE EXCEPTION 'OrderLine % is immutable (constraint "OrderLine_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_frozen';
  END IF;
  IF OLD."refund_id" IS NOT NULL AND NEW."refund_id" IS DISTINCT FROM OLD."refund_id" THEN
    RAISE EXCEPTION 'OrderLine % is already refunded (constraint "OrderLine_refunded_once")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_refunded_once';
  END IF;
  IF NEW."machine_id" IS DISTINCT FROM OLD."machine_id" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'OrderLine.machine_id changes only by inserting an OrderLineAssignment (constraint "OrderLine_machine_via_assignment")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_machine_via_assignment';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── (2) Dates de création : horloge de la base ───
-- Les défauts SQL existaient (CURRENT_TIMESTAMP) mais Prisma (@default(now())) envoyait l'heure de l'hôte.
-- Order : transaction_timestamp() (= now(), début de transaction), la même base que expires_at
-- (Order_expires_at_check, réservation). Écrit transaction_timestamp() plutôt que now() : Prisma lit
-- un défaut now() comme @default(now()), qu'il calcule côté client.
ALTER TABLE "Order" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();
ALTER TABLE "OrderLine" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();
ALTER TABLE "Refund" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();

-- ─── (3) Solde de paiement ─────────────────────
-- Colonnes existantes inchangées, sauf needs_admin_attention, qui inclut désormais awaiting_decision :
-- un paiement complet non accepté sur un lot ouvert est traité automatiquement juste après son
-- enregistrement ; s'il reste en l'état, c'est que le traitement n'a pas abouti, notamment sur une
-- réservation vivante qui ne tient plus dans le stock (ni acceptation, ni remboursement permis avant
-- l'expiration). Ajoutée en fin :
--   fits_stock  pour awaiting_decision : la facture tiendrait dans le stock (lot et max_qty des options)
--               si elle était payée maintenant (batch_stock_violation, sans verrou) ; NULL sinon.
CREATE OR REPLACE VIEW "order_payment_balance" AS
WITH b AS (
  SELECT
    o.*,
    coalesce(r."debited", 0)::bigint AS "debited",
    coalesce(r."over_sats", 0)::bigint AS "over_sats",
    coalesce("batch_accepts_orders"(ba."status"), false) AS "batch_open",
    "order_abandoned_at"(o) AS "abandoned"
  FROM "Order" o
  JOIN "Batch" ba ON ba."id" = o."batch_id"
  LEFT JOIN (
    SELECT rf."order_id", sum("refund_debited_sats"(rf)) AS "debited",
           sum(rf."amount_sats") FILTER (WHERE rf."kind" = 'overpayment') AS "over_sats"
    FROM "Refund" rf GROUP BY rf."order_id"
  ) r ON r."order_id" = o."id"
), u AS (
  SELECT b.*,
    CASE WHEN b."status" = 'paid' THEN greatest(b."received_sats" - b."expected_sats" - b."over_sats", 0)
         ELSE b."received_sats" - b."debited" END::bigint AS "unsettled"
  FROM b
), d AS (
  SELECT u.*,
    (u."status" IN ('pending_payment', 'expired') AND u."batch_open" AND u."expires_at" <= now()
     AND u."received_sats" > 0 AND u."received_sats" < u."expected_sats") AS "user_decision",
    (u."unsettled" > 0 AND (u."status" IN ('refunded', 'cancelled')
                            OR (u."status" IN ('pending_payment', 'expired') AND NOT u."batch_open"))) AS "admin_decision",
    (u."status" IN ('pending_payment', 'expired') AND u."batch_open"
     AND u."received_sats" >= u."expected_sats") AS "full_payment"
  FROM u
)
SELECT
  d."id" AS "order_id",
  d."batch_id",
  d."user_id",
  d."status",
  d."expected_sats",
  d."received_sats",
  d."debited" AS "refunded_sats",
  CASE WHEN d."status" IN ('pending_payment', 'expired')
       THEN greatest(d."expected_sats" - d."received_sats", 0) ELSE 0 END::bigint AS "outstanding_sats",
  CASE WHEN d."status" = 'paid' THEN d."unsettled" ELSE 0 END::bigint AS "refund_due_sats",
  d."full_payment" AS "awaiting_decision",
  d."user_decision" AS "awaiting_user_decision",
  d."admin_decision" AS "needs_admin_decision",
  d."unsettled" AS "unsettled_sats",
  (d."status" IN ('pending_payment', 'expired') AND d."batch_open"
   AND d."received_sats" > 0 AND d."received_sats" < d."expected_sats") AS "user_refund_allowed",
  (d."admin_decision" OR d."user_decision" OR d."full_payment") AS "needs_admin_attention",
  d."abandoned" AS "abandoned_at",
  CASE WHEN d."full_payment" THEN "batch_stock_violation"(d."batch_id", d."id") IS NULL END AS "fits_stock"
FROM d;
