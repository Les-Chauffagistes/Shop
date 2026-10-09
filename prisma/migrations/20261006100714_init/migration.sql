-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "option_kind" AS ENUM ('toggle', 'choice');

-- CreateEnum
CREATE TYPE "batch_status" AS ENUM ('draft', 'survey', 'preorder', 'ordering', 'awaiting_reception', 'inspection', 'tuning', 'packaging', 'in_transit', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "part_order_status" AS ENUM ('ordering', 'awaiting_delivery', 'delivered');

-- CreateEnum
CREATE TYPE "machine_functional_status" AS ENUM ('unknown', 'ok', 'degraded', 'faulty');

-- CreateEnum
CREATE TYPE "machine_logistical_status" AS ENUM ('expected', 'in_stock', 'in_preparation', 'ready', 'in_transit', 'delivered', 'missing', 'lost', 'returned', 'scrapped');

-- CreateEnum
CREATE TYPE "hashboard_status" AS ENUM ('not_checked', 'ok', 'degraded', 'dead');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('pending_payment', 'paid', 'expired', 'refunded');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('bitcoin');

-- CreateTable
CREATE TABLE "Model" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "hashrate" BIGINT NOT NULL,
    "hashboard_qtt" INTEGER NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "model_id" UUID NOT NULL,
    "status" "batch_status" NOT NULL DEFAULT 'draft',
    "quantity" INTEGER NOT NULL,
    "purchase_price" BIGINT NOT NULL,
    "resale_unit_price" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchStatusTransition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "from_status" "batch_status",
    "to_status" "batch_status" NOT NULL,
    "changed_by_auth_user_id" BIGINT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "BatchStatusTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Option" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "model_id" UUID NOT NULL,
    "kind" "option_kind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionValue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "option_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "price" BIGINT NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OptionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchOption" (
    "batch_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BatchOption_pkey" PRIMARY KEY ("batch_id","option_id")
);

-- CreateTable
CREATE TABLE "BatchOptionValue" (
    "batch_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "option_value_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "price_override" BIGINT,
    "max_qty" INTEGER,

    CONSTRAINT "BatchOptionValue_pkey" PRIMARY KEY ("batch_id","option_value_id")
);

-- CreateTable
CREATE TABLE "Part" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "reference" TEXT,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionValuePart" (
    "option_value_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OptionValuePart_pkey" PRIMARY KEY ("option_value_id","part_id")
);

-- CreateTable
CREATE TABLE "BatchPartOrder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "status" "part_order_status" NOT NULL DEFAULT 'ordering',
    "ordered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchPartOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Machine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "model_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "serial" TEXT,
    "psu_serial" TEXT,
    "functional_status" "machine_functional_status" NOT NULL DEFAULT 'unknown',
    "logistical_status" "machine_logistical_status" NOT NULL DEFAULT 'expected',
    "note" TEXT,
    "received_at" TIMESTAMPTZ(6),
    "carrier" TEXT,
    "tracking_number" TEXT,
    "tracking_url" TEXT,
    "shipped_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HashboardStatus" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "status" "hashboard_status" NOT NULL,

    CONSTRAINT "HashboardStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "company" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "postal_code" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "phone" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Configuration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "base_price" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),

    CONSTRAINT "Configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigurationItem" (
    "configuration_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "option_value_id" UUID NOT NULL,
    "unit_price" BIGINT NOT NULL,

    CONSTRAINT "ConfigurationItem_pkey" PRIMARY KEY ("configuration_id","option_id")
);

-- CreateTable
CREATE TABLE "Wishlist" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "configuration_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "Wishlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "billing_address_id" UUID NOT NULL,
    "shipping_address_id" UUID NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'pending_payment',
    "total_amount" BIGINT NOT NULL,
    "payment_method" "payment_method" NOT NULL DEFAULT 'bitcoin',
    "payment_address" TEXT,
    "payment_reference" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '00:30:00'::interval),
    "paid_at" TIMESTAMPTZ(6),
    "received_sats" BIGINT,
    "expired_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "configuration_id" UUID NOT NULL,
    "wishlist_id" UUID,
    "amount" BIGINT NOT NULL,
    "machine_id" UUID,
    "refund_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_line_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "machine_id" UUID,
    "changed_by_auth_user_id" BIGINT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "OrderLineAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "amount_sats" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "destination_address" TEXT,
    "reference" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Batch_status_idx" ON "Batch"("status");

-- CreateIndex
CREATE INDEX "Batch_model_id_idx" ON "Batch"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_id_model_id_key" ON "Batch"("id", "model_id");

-- CreateIndex
CREATE INDEX "BatchStatusTransition_batch_id_created_at_idx" ON "BatchStatusTransition"("batch_id", "created_at");

-- CreateIndex
CREATE INDEX "BatchStatusTransition_batch_id_to_status_created_at_idx" ON "BatchStatusTransition"("batch_id", "to_status", "created_at");

-- CreateIndex
CREATE INDEX "Option_model_id_position_idx" ON "Option"("model_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Option_id_model_id_key" ON "Option"("id", "model_id");

-- CreateIndex
CREATE INDEX "OptionValue_option_id_position_idx" ON "OptionValue"("option_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_id_option_id_key" ON "OptionValue"("id", "option_id");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_one_default_per_option" ON "OptionValue"("option_id") WHERE (is_default);

-- CreateIndex
CREATE UNIQUE INDEX "BatchPartOrder_batch_id_part_id_key" ON "BatchPartOrder"("batch_id", "part_id");

-- CreateIndex
CREATE INDEX "Machine_batch_id_logistical_status_idx" ON "Machine"("batch_id", "logistical_status");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_id_batch_id_key" ON "Machine"("id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_model_id_serial_key" ON "Machine"("model_id", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "HashboardStatus_machine_id_index_key" ON "HashboardStatus"("machine_id", "index");

-- CreateIndex
CREATE UNIQUE INDEX "User_auth_user_id_key" ON "User"("auth_user_id");

-- CreateIndex
CREATE INDEX "Address_user_id_idx" ON "Address"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Address_id_user_id_key" ON "Address"("id", "user_id");

-- CreateIndex
CREATE INDEX "Configuration_batch_id_idx" ON "Configuration"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "Configuration_id_batch_id_key" ON "Configuration"("id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "Configuration_id_model_id_key" ON "Configuration"("id", "model_id");

-- CreateIndex
CREATE INDEX "ConfigurationItem_option_value_id_idx" ON "ConfigurationItem"("option_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "Wishlist_configuration_id_key" ON "Wishlist"("configuration_id");

-- CreateIndex
CREATE INDEX "Wishlist_batch_id_user_id_idx" ON "Wishlist"("batch_id", "user_id");

-- CreateIndex
CREATE INDEX "Wishlist_user_id_idx" ON "Wishlist"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Wishlist_configuration_id_batch_id_key" ON "Wishlist"("configuration_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "Wishlist_id_user_id_batch_id_key" ON "Wishlist"("id", "user_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_payment_address_key" ON "Order"("payment_address");

-- CreateIndex
CREATE INDEX "Order_batch_id_status_idx" ON "Order"("batch_id", "status");

-- CreateIndex
CREATE INDEX "Order_user_id_idx" ON "Order"("user_id");

-- CreateIndex
CREATE INDEX "Order_batch_id_paid_at_idx" ON "Order"("batch_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "Order_id_user_id_batch_id_key" ON "Order"("id", "user_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_configuration_id_key" ON "OrderLine"("configuration_id");

-- CreateIndex
CREATE INDEX "OrderLine_order_id_idx" ON "OrderLine"("order_id");

-- CreateIndex
CREATE INDEX "OrderLine_batch_id_idx" ON "OrderLine"("batch_id");

-- CreateIndex
CREATE INDEX "OrderLine_wishlist_id_idx" ON "OrderLine"("wishlist_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_configuration_id_batch_id_key" ON "OrderLine"("configuration_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_id_batch_id_key" ON "OrderLine"("id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_machine_id_active_key" ON "OrderLine"("machine_id") WHERE (refund_id IS NULL);

-- CreateIndex
CREATE INDEX "OrderLineAssignment_order_line_id_created_at_idx" ON "OrderLineAssignment"("order_line_id", "created_at");

-- CreateIndex
CREATE INDEX "OrderLineAssignment_machine_id_idx" ON "OrderLineAssignment"("machine_id");

-- CreateIndex
CREATE INDEX "Refund_order_id_idx" ON "Refund"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_id_order_id_key" ON "Refund"("id", "order_id");

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "Model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchStatusTransition" ADD CONSTRAINT "BatchStatusTransition_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Option" ADD CONSTRAINT "Option_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "Model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionValue" ADD CONSTRAINT "OptionValue_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "Option"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchOption" ADD CONSTRAINT "BatchOption_batch_id_model_id_fkey" FOREIGN KEY ("batch_id", "model_id") REFERENCES "Batch"("id", "model_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchOption" ADD CONSTRAINT "BatchOption_option_id_model_id_fkey" FOREIGN KEY ("option_id", "model_id") REFERENCES "Option"("id", "model_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchOptionValue" ADD CONSTRAINT "BatchOptionValue_batch_id_model_id_fkey" FOREIGN KEY ("batch_id", "model_id") REFERENCES "Batch"("id", "model_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchOptionValue" ADD CONSTRAINT "BatchOptionValue_option_id_model_id_fkey" FOREIGN KEY ("option_id", "model_id") REFERENCES "Option"("id", "model_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchOptionValue" ADD CONSTRAINT "BatchOptionValue_option_value_id_option_id_fkey" FOREIGN KEY ("option_value_id", "option_id") REFERENCES "OptionValue"("id", "option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionValuePart" ADD CONSTRAINT "OptionValuePart_option_value_id_fkey" FOREIGN KEY ("option_value_id") REFERENCES "OptionValue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionValuePart" ADD CONSTRAINT "OptionValuePart_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchPartOrder" ADD CONSTRAINT "BatchPartOrder_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchPartOrder" ADD CONSTRAINT "BatchPartOrder_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_batch_id_model_id_fkey" FOREIGN KEY ("batch_id", "model_id") REFERENCES "Batch"("id", "model_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashboardStatus" ADD CONSTRAINT "HashboardStatus_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Configuration" ADD CONSTRAINT "Configuration_batch_id_model_id_fkey" FOREIGN KEY ("batch_id", "model_id") REFERENCES "Batch"("id", "model_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigurationItem" ADD CONSTRAINT "ConfigurationItem_configuration_id_model_id_fkey" FOREIGN KEY ("configuration_id", "model_id") REFERENCES "Configuration"("id", "model_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigurationItem" ADD CONSTRAINT "ConfigurationItem_option_id_model_id_fkey" FOREIGN KEY ("option_id", "model_id") REFERENCES "Option"("id", "model_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigurationItem" ADD CONSTRAINT "ConfigurationItem_option_value_id_option_id_fkey" FOREIGN KEY ("option_value_id", "option_id") REFERENCES "OptionValue"("id", "option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_configuration_id_batch_id_fkey" FOREIGN KEY ("configuration_id", "batch_id") REFERENCES "Configuration"("id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_billing_address_id_user_id_fkey" FOREIGN KEY ("billing_address_id", "user_id") REFERENCES "Address"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shipping_address_id_user_id_fkey" FOREIGN KEY ("shipping_address_id", "user_id") REFERENCES "Address"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_order_id_user_id_batch_id_fkey" FOREIGN KEY ("order_id", "user_id", "batch_id") REFERENCES "Order"("id", "user_id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_configuration_id_batch_id_fkey" FOREIGN KEY ("configuration_id", "batch_id") REFERENCES "Configuration"("id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_wishlist_id_user_id_batch_id_fkey" FOREIGN KEY ("wishlist_id", "user_id", "batch_id") REFERENCES "Wishlist"("id", "user_id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_machine_id_batch_id_fkey" FOREIGN KEY ("machine_id", "batch_id") REFERENCES "Machine"("id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_refund_id_order_id_fkey" FOREIGN KEY ("refund_id", "order_id") REFERENCES "Refund"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_order_line_id_batch_id_fkey" FOREIGN KEY ("order_line_id", "batch_id") REFERENCES "OrderLine"("id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_machine_id_batch_id_fkey" FOREIGN KEY ("machine_id", "batch_id") REFERENCES "Machine"("id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═════════════════════════════════════════════
-- Raw SQL : invariants non exprimables en Prisma (voir schema.dbml)
-- Prisma ne gère ni les CHECK ni les triggers : ils ne génèrent pas de drift,
-- mais toute migration future qui recrée une table doit les reporter.
-- Les triggers « différés » s'évaluent au COMMIT : une opération en plusieurs
-- requêtes (remplacement, annulation + remboursement…) se fait dans UNE transaction.
-- ═════════════════════════════════════════════

-- ─── CHECK ────────────────────────────────────

-- Catalogue
ALTER TABLE "Model" ADD CONSTRAINT "Model_hashrate_check" CHECK ("hashrate" > 0);
ALTER TABLE "Model" ADD CONSTRAINT "Model_hashboard_qtt_check" CHECK ("hashboard_qtt" > 0);
ALTER TABLE "OptionValue" ADD CONSTRAINT "OptionValue_price_check" CHECK ("price" >= 0);
-- La valeur par défaut est la machine « brute » : gratuite (roadmap, « Options par défaut »).
-- Pas de pièce non plus : trigger différé OptionValue_default_no_parts.
ALTER TABLE "OptionValue" ADD CONSTRAINT "OptionValue_default_free_check" CHECK (NOT "is_default" OR "price" = 0);
ALTER TABLE "OptionValuePart" ADD CONSTRAINT "OptionValuePart_qty_check" CHECK ("qty" > 0);

-- Lots
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_purchase_price_check" CHECK ("purchase_price" >= 0);
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_resale_unit_price_check" CHECK ("resale_unit_price" >= 0);
-- Prix de revente requis pour publier (sondage) et pour toute étape suivante
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_resale_unit_price_required_check"
  CHECK ("status" IN ('draft', 'cancelled') OR "resale_unit_price" IS NOT NULL);
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "BatchOptionValue" ADD CONSTRAINT "BatchOptionValue_price_override_check" CHECK ("price_override" >= 0);
ALTER TABLE "BatchOptionValue" ADD CONSTRAINT "BatchOptionValue_max_qty_check" CHECK ("max_qty" >= 0);

-- Matériel d'options
ALTER TABLE "BatchPartOrder" ADD CONSTRAINT "BatchPartOrder_qty_check" CHECK ("qty" > 0);
ALTER TABLE "BatchPartOrder" ADD CONSTRAINT "BatchPartOrder_delivered_at_check"
  CHECK (("status" = 'delivered') = ("delivered_at" IS NOT NULL));

-- Machines
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_serial_check" CHECK (btrim("serial") <> '');
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_tracking_url_check" CHECK ("tracking_url" ~* '^https?://');
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_received_at_check"
  CHECK ("logistical_status" IN ('expected', 'missing') OR "received_at" IS NOT NULL);
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_shipped_at_check"
  CHECK ("logistical_status" NOT IN ('in_transit', 'delivered', 'lost') OR "shipped_at" IS NOT NULL);
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_delivered_at_check"
  CHECK ("logistical_status" <> 'delivered' OR "delivered_at" IS NOT NULL);
-- Une machine morte ou non contrôlée n'est ni montée, ni prête, ni expédiée
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_functional_before_prepare_check"
  CHECK ("logistical_status" NOT IN ('in_preparation', 'ready', 'in_transit')
         OR "functional_status" IN ('ok', 'degraded'));
ALTER TABLE "HashboardStatus" ADD CONSTRAINT "HashboardStatus_index_check" CHECK ("index" >= 0);

-- Utilisateurs (identifiants auth-service : auth.users.id, BIGINT auto-incrémenté)
ALTER TABLE "User" ADD CONSTRAINT "User_auth_user_id_check" CHECK ("auth_user_id" > 0);
ALTER TABLE "BatchStatusTransition" ADD CONSTRAINT "BatchStatusTransition_changed_by_check" CHECK ("changed_by_auth_user_id" > 0);
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_changed_by_check" CHECK ("changed_by_auth_user_id" > 0);
ALTER TABLE "Address" ADD CONSTRAINT "Address_country_check" CHECK ("country" ~ '^[A-Z]{2}$');

-- Configurations
ALTER TABLE "Configuration" ADD CONSTRAINT "Configuration_base_price_check" CHECK ("base_price" >= 0);
ALTER TABLE "ConfigurationItem" ADD CONSTRAINT "ConfigurationItem_unit_price_check" CHECK ("unit_price" >= 0);

-- Commandes et paiement
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_amount_check" CHECK ("total_amount" > 0);
-- Réservation : une facture en attente réserve le stock 30 minutes au plus (roadmap,
-- « Réservation et paiement tardif »). L'horloge de référence est celle de la base :
-- expires_at vaut par défaut now() + 30 min (à omettre côté application), ne peut pas
-- dépasser now() + 30 min à l'insertion et est immuable ensuite (Order_guard).
ALTER TABLE "Order" ADD CONSTRAINT "Order_expires_at_check" CHECK ("expires_at" > "created_at");
-- paid_at = réception du paiement (y compris un paiement tardif ensuite remboursé) ;
-- received_sats = montant BTC reçu, renvoyé tel quel en cas de remboursement intégral.
ALTER TABLE "Order" ADD CONSTRAINT "Order_received_sats_check" CHECK ("received_sats" > 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_received_check"
  CHECK (("paid_at" IS NULL) = ("received_sats" IS NULL));
ALTER TABLE "Order" ADD CONSTRAINT "Order_status_dates_check" CHECK (
  CASE "status"
    WHEN 'pending_payment' THEN "paid_at" IS NULL AND "expired_at" IS NULL AND "refunded_at" IS NULL
    WHEN 'expired'         THEN "paid_at" IS NULL AND "expired_at" IS NOT NULL AND "refunded_at" IS NULL
    WHEN 'paid'            THEN "paid_at" IS NOT NULL AND "refunded_at" IS NULL
    WHEN 'refunded'        THEN "paid_at" IS NOT NULL AND "refunded_at" IS NOT NULL
  END);
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_address_check"
  CHECK ("paid_at" IS NULL OR "payment_address" IS NOT NULL);
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check" CHECK ("amount" > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_sats_check" CHECK ("amount_sats" > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_reason_check" CHECK (btrim("reason") <> '');
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_sent_check"
  CHECK ("sent_at" IS NULL OR ("reference" IS NOT NULL AND "destination_address" IS NOT NULL));

-- ─── Utilitaires ──────────────────────────────
-- Convention : toute erreur métier levée par un trigger porte son nom de contrainte
-- dans le message, sous la forme `(constraint "Nom")`. PrismaPg ne transmet pas le
-- champ CONSTRAINT des erreurs 23514/23001 ; src/server/errors.ts (pgFailureOf) lit le message.

CREATE FUNCTION "raise_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (constraint "%_append_only")', TG_TABLE_NAME, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Verrou de lot : UPDATE sans effet de la ligne Batch. Sérialise les contrôles de stock
-- concurrents : en READ COMMITTED la transaction suivante attend puis relit les données
-- validées ; en REPEATABLE READ / SERIALIZABLE elle échoue (erreur de sérialisation, à rejouer).
-- Ne touche que updated_at : ne déclenche pas les triggers « UPDATE OF status/quantity ».
CREATE FUNCTION "Batch_lock"(b uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE q integer;
BEGIN
  UPDATE "Batch" SET "updated_at" = "updated_at" WHERE "id" = b RETURNING "quantity" INTO q;
  RETURN q;
END;
$$;

-- ─── Options : défaut brut, menus et valeurs d'un lot ───
-- Décisions Hugo 2026-10-06 (roadmap, « Options par défaut et menus masqués », « Prix, devise
-- et menus ajoutés ») :
--   * la valeur par défaut d'un menu est la machine « brute » : gratuite partout (CHECK
--     OptionValue_default_free_check, pas de dérogation non nulle, unit_price 0) et sans pièce ;
--   * un lot peut masquer un menu (BatchOption.hidden) : le défaut s'applique d'office ;
--   * menus et valeurs d'un lot = catalogue vivant tant qu'il est en brouillon, puis INSTANTANÉ
--     pris à la publication (sortie de draft, hors annulation) : BatchOption reçoit une ligne par
--     menu du modèle, BatchOptionValue une ligne par valeur de ces menus. Un menu ou une valeur
--     créés ensuite ne s'appliquent pas au lot (défaut implicite pour un menu). Proposer plus tard
--     une nouvelle valeur sur un lot publié = insérer sa ligne BatchOptionValue (décision admin) ;
--   * prix et menu d'une valeur figés tant qu'elle est proposée par un lot en cours (survey à
--     in_transit) : on passe par BatchOptionValue.price_override.
-- Dans une Configuration, un menu sans item vaut sa valeur par défaut (gratuite, sans pièce) ;
-- un menu masqué ou non applicable n'a jamais d'item.

-- Statuts d'un lot qui figent le prix et le menu des valeurs qu'il propose : de nouvelles
-- configurations peuvent encore y être créées (wishlist au sondage, commandes ensuite).
-- Brouillon : catalogue vivant ; clos / annulé : plus aucune configuration possible.
CREATE FUNCTION "batch_catalog_frozen"(st "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT st NOT IN ('draft', 'closed', 'cancelled')
$$;

-- Verrou partagé sur les lots d'un modèle : attend une publication concurrente (BatchStatusTransition_apply
-- prend la ligne Batch FOR UPDATE) puis laisse la requête suivante relire le statut validé.
-- FOR KEY SHARE ne bloque pas Batch_lock (UPDATE hors clé) : pas d'interblocage avec le stock.
CREATE FUNCTION "model_lock_batches"(m uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "Batch" WHERE "model_id" = m FOR KEY SHARE;
END;
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

-- Défaut sans pièce (différé : on peut changer de défaut puis retirer les pièces, ou l'inverse).
-- Vérifié à l'ajout d'une pièce et quand une valeur devient le défaut. Le verrou FOR SHARE sur
-- la valeur sérialise « ajouter une pièce » et « devenir le défaut » concurrents.
CREATE FUNCTION "OptionValue_check_default_parts"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  vid uuid;
BEGIN
  IF TG_TABLE_NAME = 'OptionValue' THEN vid := NEW."id"; ELSE vid := NEW."option_value_id"; END IF;
  PERFORM 1 FROM "OptionValue" WHERE "id" = vid FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM "OptionValue" v JOIN "OptionValuePart" p ON p."option_value_id" = v."id"
    WHERE v."id" = vid AND v."is_default"
  ) THEN
    RAISE EXCEPTION 'Default option value % has parts: the default is the bare machine (constraint "OptionValue_default_no_parts")', vid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OptionValue_default_no_parts';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "OptionValue_default_no_parts"
  AFTER INSERT OR UPDATE OF "is_default" ON "OptionValue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."is_default") EXECUTE FUNCTION "OptionValue_check_default_parts"();

CREATE CONSTRAINT TRIGGER "OptionValuePart_default_no_parts"
  AFTER INSERT OR UPDATE OF "option_value_id" ON "OptionValuePart"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "OptionValue_check_default_parts"();

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

-- Réglages de valeurs (BatchOptionValue) d'un lot publié : ce sont les lignes de l'instantané.
-- Jamais supprimées (une suppression retirerait la valeur en silence : enabled = false pour la
-- retirer) ; une ligne ajoutée après publication propose une valeur créée depuis, seulement dans
-- un menu applicable au lot. Ce qui est modifiable selon le statut reste dans le domaine
-- (EDITABLE_FIELDS). FOR KEY SHARE : attend une publication concurrente.
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

-- ─── Statut du lot : piloté par le journal des transitions ───

-- Transitions autorisées (revue logistique §5.1, T1 à T18, avec closed comme statut terminal).
-- Aucun retour vers draft / survey une fois la précommande ouverte (décision Hugo 2026-10-06) :
-- seul survey>draft revient en arrière avant l'ouverture.
-- Les conditions métier (seuils, machines contrôlées…) restent dans la fonction de domaine.
CREATE FUNCTION "batch_transition_allowed"(f "batch_status", t "batch_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN f IS NULL THEN t = 'draft'
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

ALTER TABLE "BatchStatusTransition" ADD CONSTRAINT "BatchStatusTransition_allowed_check"
  CHECK ("batch_transition_allowed"("from_status", "to_status"));

-- Insérer une transition : vérifie from_status = statut courant, applique to_status au lot.
-- Publication (sortie de draft, hors annulation) : instantané des menus (BatchOption) et des
-- valeurs (BatchOptionValue) du modèle, en complétant les réglages du brouillon. Pris avant le
-- changement de statut (les gardes de ces tables l'autorisent encore), sous le verrou du lot.
-- Re-publication après survey > draft : complète de même (ON CONFLICT DO NOTHING).
CREATE FUNCTION "BatchStatusTransition_apply"() RETURNS trigger
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
  END IF;
  UPDATE "Batch" SET "status" = NEW."to_status", "updated_at" = now() WHERE "id" = NEW."batch_id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BatchStatusTransition_apply"
  BEFORE INSERT ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "BatchStatusTransition_apply"();

CREATE TRIGGER "BatchStatusTransition_append_only"
  BEFORE UPDATE OR DELETE ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

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

-- ─── Stock du lot (différé, sous verrou du lot) ───
-- Consomment une place de Batch.quantity :
--   * chaque ligne non remboursée d'une commande paid ;
--   * chaque ligne d'une facture pending_payment NON EXPIRÉE (expires_at > now()) :
--     réservation de 30 minutes (roadmap, « Réservation et paiement tardif »). L'expiration
--     se lit sur l'horloge, sans job : passé expires_at, la place est libérée même si le
--     statut est encore pending_payment. now() = début de la transaction : une transaction
--     longue voit une réservation vivante un peu plus longtemps (sens prudent) ;
--   * chaque machine missing / scrapped / lost non rattachée à une ligne active
--     (machine morte retirée du stock ; une machine perdue encore rattachée à sa
--     ligne n'est comptée qu'une fois, jusqu'au remplacement ou remboursement).
-- Le temps ne fait que libérer des places : l'invariant vérifié au COMMIT reste vrai ensuite.
-- Paiement tardif (facture expirée, puis paid) : la ligne compte de nouveau, le contrôle
-- refuse le COMMIT s'il n'y a plus de place (Batch_stock) ; on rembourse alors (refunded).

-- Lignes actives (payées) d'un lot : non remboursées, commande paid. Machines et attributions.
CREATE FUNCTION "batch_active_lines"(b uuid)
RETURNS TABLE ("id" uuid, "machine_id" uuid, "configuration_id" uuid)
LANGUAGE sql STABLE AS $$
  SELECT l."id", l."machine_id", l."configuration_id"
  FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
  WHERE l."batch_id" = b AND l."refund_id" IS NULL AND o."status" = 'paid'
$$;

-- Lignes qui consomment le stock : lignes actives + réservations vivantes.
-- `plus` : une facture impayée comptée en plus, comme si elle était payée (Order_fits_stock).
CREATE FUNCTION "batch_stock_lines"(b uuid, plus uuid DEFAULT NULL)
RETURNS TABLE ("id" uuid, "configuration_id" uuid)
LANGUAGE sql STABLE AS $$
  SELECT l."id", l."configuration_id"
  FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
  WHERE l."batch_id" = b
    AND ((l."refund_id" IS NULL
          AND (o."status" = 'paid' OR (o."status" = 'pending_payment' AND o."expires_at" > now())))
         OR o."id" = plus)
$$;

-- Machines sorties du stock : missing / scrapped / lost non rattachées à une ligne active
-- (machine morte retirée du stock ; une machine perdue encore rattachée à sa ligne n'est
-- comptée qu'une fois, par sa ligne).
CREATE FUNCTION "batch_written_off"(b uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM "Machine" m
  WHERE m."batch_id" = b
    AND m."logistical_status" IN ('missing', 'scrapped', 'lost')
    AND NOT EXISTS (SELECT 1 FROM "batch_active_lines"(b) a WHERE a."machine_id" = m."id")
$$;

-- Stock disponible d'un lot : quantity − lignes payées et réservées − machines sorties du stock.
-- Négatif = survendu (impossible après un COMMIT, Batch_stock). NULL si le lot n'existe pas.
-- `plus` : comme batch_stock_lines. Source unique de la règle : trigger de stock ET domaine
-- (compteur availableStock, refus de baisser quantity). Ne verrouille pas.
CREATE FUNCTION "batch_available_stock"(b uuid, plus uuid DEFAULT NULL) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT ba."quantity" - (SELECT count(*)::integer FROM "batch_stock_lines"(b, plus)) - "batch_written_off"(b)
  FROM "Batch" ba WHERE ba."id" = b
$$;

-- Lignes payées + réservées portant chaque valeur d'option (comptage de max_qty).
-- Source unique : trigger de stock ET domaine (compteur used, refus de baisser max_qty).
CREATE FUNCTION "batch_option_usage"(b uuid, plus uuid DEFAULT NULL)
RETURNS TABLE ("option_value_id" uuid, "used" integer)
LANGUAGE sql STABLE AS $$
  SELECT ci."option_value_id", count(*)::integer
  FROM "ConfigurationItem" ci
  JOIN "batch_stock_lines"(b, plus) s ON s."configuration_id" = ci."configuration_id"
  GROUP BY ci."option_value_id"
$$;

-- Contrainte de stock violée par le lot (NULL si aucune) : Batch_stock ou
-- BatchOptionValue_max_qty_stock (lignes payées + réservées portant la valeur <= max_qty).
-- Ne verrouille pas : appeler après "Batch_lock".
CREATE FUNCTION "batch_stock_violation"(b uuid, plus uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  available integer;
BEGIN
  available := "batch_available_stock"(b, plus);
  IF available IS NULL THEN RETURN NULL; END IF;
  IF available < 0 THEN
    RETURN 'Batch_stock';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "BatchOptionValue" bov
    JOIN "batch_option_usage"(b, plus) u ON u."option_value_id" = bov."option_value_id"
    WHERE bov."batch_id" = b AND bov."max_qty" IS NOT NULL AND u."used" > bov."max_qty"
  ) THEN
    RETURN 'BatchOptionValue_max_qty_stock';
  END IF;
  RETURN NULL;
END;
$$;

-- Pour le domaine (webhook de paiement) : la facture impayée oid tiendrait-elle dans le stock
-- si elle était payée maintenant ? Verrouille le lot jusqu'à la fin de la transaction :
-- appeler dans la transaction qui passe ensuite la facture à paid ou refunded.
CREATE FUNCTION "Order_fits_stock"(oid uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  b uuid;
BEGIN
  SELECT "batch_id" INTO b FROM "Order" WHERE "id" = oid;
  IF b IS NULL THEN RETURN NULL; END IF;
  PERFORM "Batch_lock"(b);
  RETURN "batch_stock_violation"(b, oid) IS NULL;
END;
$$;

CREATE FUNCTION "Batch_check_stock"(b uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  q integer;
  v text;
BEGIN
  q := "Batch_lock"(b);
  IF q IS NULL THEN RETURN; END IF;

  v := "batch_stock_violation"(b);
  IF v = 'Batch_stock' THEN
    RAISE EXCEPTION 'Batch % oversold: paid and reserved lines + machines out of stock > quantity % (constraint "Batch_stock")', b, q
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Batch_stock';
  ELSIF v IS NOT NULL THEN
    RAISE EXCEPTION 'Batch %: an option value is sold or reserved beyond its max_qty (constraint "BatchOptionValue_max_qty_stock")', b
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchOptionValue_max_qty_stock';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "batch_active_lines"(b) a JOIN "Machine" m ON m."id" = a."machine_id"
    WHERE m."logistical_status" IN ('expected', 'missing', 'scrapped')
  ) THEN
    RAISE EXCEPTION 'Batch %: an expected, missing or scrapped machine is assigned to an active line (constraint "OrderLine_machine_usable")', b
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_machine_usable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Machine" m
    WHERE m."batch_id" = b AND m."logistical_status" = 'in_transit'
      AND NOT EXISTS (SELECT 1 FROM "batch_active_lines"(b) a WHERE a."machine_id" = m."id")
  ) THEN
    RAISE EXCEPTION 'Batch %: a machine in transit is not assigned to an active line (constraint "Machine_shipped_assigned")', b
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_shipped_assigned';
  END IF;
END;
$$;

CREATE FUNCTION "trg_check_stock"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Batch' THEN
    PERFORM "Batch_check_stock"(NEW."id");
  ELSE
    PERFORM "Batch_check_stock"(NEW."batch_id");
  END IF;
  RETURN NULL;
END;
$$;

-- Une réservation naît avec ses lignes (OrderLine_stock) ; un paiement tardif est un
-- changement de statut (Order_stock).
CREATE CONSTRAINT TRIGGER "Batch_stock" AFTER UPDATE OF "quantity" ON "Batch"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();
CREATE CONSTRAINT TRIGGER "Order_stock" AFTER UPDATE OF "status" ON "Order"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();
CREATE CONSTRAINT TRIGGER "OrderLine_stock" AFTER INSERT OR UPDATE OF "refund_id", "machine_id" ON "OrderLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();
CREATE CONSTRAINT TRIGGER "Machine_stock" AFTER INSERT OR UPDATE OF "logistical_status" ON "Machine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();
CREATE CONSTRAINT TRIGGER "BatchOptionValue_stock" AFTER INSERT OR UPDATE OF "max_qty" ON "BatchOptionValue"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();

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
-- (BatchStatusTransition_apply prend la ligne FOR UPDATE) puis relit le statut validé.
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

-- ─── Commandes ───

-- Création : lot publié et pas encore clos. Transitions de statut de la facture :
--   pending_payment > paid       paiement reçu (réservation vivante, ou tardif s'il reste de la place : Order_stock)
--   pending_payment > expired    seulement une fois expires_at dépassé (statut d'affichage : le stock lit l'horloge)
--   pending_payment > refunded   paiement tardif sans place, ou lot clos / abandonné
--   expired > paid | refunded    idem, après expiration
--   paid > refunded              annulation, surplus de commandes (les dernières payées d'abord)
-- Un paiement reçu sur une facture expirée ne peut être refusé (refunded) que si la facture
-- ne tient plus dans le stock ou si le lot n'accepte plus de commande : remboursement intégral.
CREATE FUNCTION "Order_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bst "batch_status";
BEGIN
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = NEW."batch_id";

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending_payment' THEN
      RAISE EXCEPTION 'An order is created as pending_payment (constraint "Order_created_pending")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_created_pending';
    END IF;
    IF NEW."expires_at" > now() + interval '30 minutes' THEN
      RAISE EXCEPTION 'An order reserves stock for 30 minutes at most (constraint "Order_reservation_length")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_reservation_length';
    END IF;
    IF bst IN ('draft', 'survey', 'closed', 'cancelled') THEN
      RAISE EXCEPTION 'Batch % does not accept orders in its current status (constraint "Order_batch_open")', NEW."batch_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_batch_open';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."user_id", NEW."batch_id", NEW."payment_method", NEW."created_at", NEW."expires_at")
     IS DISTINCT FROM (OLD."user_id", OLD."batch_id", OLD."payment_method", OLD."created_at", OLD."expires_at")
     OR (NEW."total_amount" <> OLD."total_amount" AND OLD."status" <> 'pending_payment')
     OR (OLD."paid_at" IS NOT NULL AND (NEW."payment_address", NEW."paid_at", NEW."received_sats")
         IS DISTINCT FROM (OLD."payment_address", OLD."paid_at", OLD."received_sats")) THEN
    RAISE EXCEPTION 'Order %: immutable field changed (constraint "Order_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_immutable';
  END IF;

  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) NOT IN (
    'pending_payment>paid', 'pending_payment>expired', 'pending_payment>refunded',
    'expired>paid', 'expired>refunded', 'paid>refunded'
  ) THEN
    RAISE EXCEPTION 'Order %: transition % -> % not allowed (constraint "Order_status_transition")', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_status_transition';
  END IF;
  IF NEW."status" = 'expired' AND OLD."expires_at" > now() THEN
    RAISE EXCEPTION 'Order % has not expired yet (constraint "Order_expired_early")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_expired_early';
  END IF;
  IF NEW."status" = 'paid' AND bst IN ('draft', 'survey', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'Batch % does not accept orders in its current status (constraint "Order_batch_open")', NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_batch_open';
  END IF;
  IF NEW."status" = 'refunded' AND OLD."status" IN ('pending_payment', 'expired')
     AND bst NOT IN ('closed', 'cancelled')
     AND (OLD."expires_at" > now() OR "Order_fits_stock"(OLD."id")) THEN
    RAISE EXCEPTION 'Order %: a payment received while stock remains must be accepted (constraint "Order_late_payment_refund")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_late_payment_refund';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_guard"
  BEFORE INSERT OR UPDATE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION "Order_guard"();

-- Lignes : ajout/suppression tant que la facture est en attente ; ensuite seuls
-- machine_id (via OrderLineAssignment) et refund_id (une fois) évoluent.
-- L'insertion verrouille la configuration.
CREATE FUNCTION "OrderLine_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st "order_status";
BEGIN
  IF TG_OP IN ('INSERT', 'DELETE') THEN
    SELECT "status" INTO st FROM "Order"
    WHERE "id" = CASE TG_OP WHEN 'INSERT' THEN NEW."order_id" ELSE OLD."order_id" END;
    IF st IS DISTINCT FROM 'pending_payment' THEN
      RAISE EXCEPTION 'Order lines can only be added or removed while the order is pending_payment (constraint "OrderLine_frozen")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_frozen';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF NEW."machine_id" IS NOT NULL OR NEW."refund_id" IS NOT NULL THEN
      RAISE EXCEPTION 'A new order line has no machine and no refund (constraint "OrderLine_new")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_new';
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

  IF (NEW."order_id", NEW."user_id", NEW."batch_id", NEW."configuration_id", NEW."wishlist_id", NEW."amount", NEW."created_at")
     IS DISTINCT FROM (OLD."order_id", OLD."user_id", OLD."batch_id", OLD."configuration_id", OLD."wishlist_id", OLD."amount", OLD."created_at") THEN
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

CREATE TRIGGER "OrderLine_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "OrderLine"
  FOR EACH ROW EXECUTE FUNCTION "OrderLine_guard"();

-- Attribution / remplacement : la nouvelle machine est reçue et pas morte ; la ligne est active.
CREATE FUNCTION "OrderLineAssignment_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
    WHERE l."id" = NEW."order_line_id" AND l."refund_id" IS NULL AND o."status" = 'paid'
  ) THEN
    RAISE EXCEPTION 'Only an active line of a paid order can be assigned a machine (constraint "OrderLineAssignment_active_line")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_active_line';
  END IF;
  IF NEW."machine_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Machine" WHERE "id" = NEW."machine_id"
      AND "logistical_status" IN ('in_stock', 'in_preparation', 'ready')
      AND "functional_status" <> 'faulty'
  ) THEN
    RAISE EXCEPTION 'Machine % is not assignable, must be received and not faulty (constraint "OrderLineAssignment_machine_assignable")', NEW."machine_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_machine_assignable';
  END IF;
  UPDATE "OrderLine" SET "machine_id" = NEW."machine_id" WHERE "id" = NEW."order_line_id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OrderLineAssignment_apply"
  BEFORE INSERT ON "OrderLineAssignment"
  FOR EACH ROW EXECUTE FUNCTION "OrderLineAssignment_apply"();

CREATE TRIGGER "OrderLineAssignment_append_only"
  BEFORE UPDATE OR DELETE ON "OrderLineAssignment"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

-- Cohérence d'une commande (différé) : lignes, total, statut, remboursements, wishlists.
CREATE FUNCTION "Order_check"(oid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  o "Order"%ROWTYPE;
  n_lines integer;
  n_active integer;
  s_lines bigint;
  s_refunds bigint;
  s_refund_sats bigint;
BEGIN
  SELECT * INTO o FROM "Order" WHERE "id" = oid;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM "Batch_lock"(o."batch_id"); -- conversion concurrente d'une même wishlist

  SELECT count(*), count(*) FILTER (WHERE "refund_id" IS NULL), coalesce(sum("amount"), 0)
  INTO n_lines, n_active, s_lines
  FROM "OrderLine" WHERE "order_id" = oid;
  SELECT coalesce(sum("amount"), 0), coalesce(sum("amount_sats"), 0) INTO s_refunds, s_refund_sats
  FROM "Refund" WHERE "order_id" = oid;

  IF n_lines = 0 THEN
    RAISE EXCEPTION 'Order % has no line (constraint "Order_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_lines';
  END IF;
  IF s_lines <> o."total_amount" THEN
    RAISE EXCEPTION 'Order %: total_amount % <> sum of lines % (constraint "Order_total")', oid, o."total_amount", s_lines
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_total';
  END IF;
  IF o."status" IN ('pending_payment', 'expired') AND (
       n_active <> n_lines OR s_refunds > 0
       OR EXISTS (SELECT 1 FROM "OrderLine" WHERE "order_id" = oid AND "machine_id" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Unpaid order % cannot have refunds or assigned machines (constraint "Order_status_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_status_lines';
  END IF;
  IF o."status" = 'paid' AND n_active = 0 THEN
    RAISE EXCEPTION 'Order %: every line is refunded, status must be refunded (constraint "Order_status_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_status_lines';
  END IF;
  IF o."status" = 'refunded' AND n_active > 0 THEN
    RAISE EXCEPTION 'Refunded order % still has active lines (constraint "Order_status_lines")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_status_lines';
  END IF;
  IF s_refunds > o."total_amount" OR s_refund_sats > coalesce(o."received_sats", 0) THEN
    RAISE EXCEPTION 'Order %: refunds exceed what was paid (constraint "Order_refunds")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunds';
  END IF;
  -- Remboursement intégral : la somme BTC reçue est renvoyée telle quelle (pas de conversion)
  IF o."status" = 'refunded' AND s_refund_sats <> o."received_sats" THEN
    RAISE EXCEPTION 'Refunded order %: refunds % sats <> received % sats (constraint "Order_refunded_in_full")', oid, s_refund_sats, o."received_sats"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunded_in_full';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Refund" r
    WHERE r."order_id" = oid
      AND r."amount" < (SELECT coalesce(sum(l."amount"), 0) FROM "OrderLine" l WHERE l."refund_id" = r."id")
  ) THEN
    RAISE EXCEPTION 'Order %: a refund is smaller than the lines it cancels (constraint "Order_refunds")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Order_refunds';
  END IF;
  -- Prix de ligne = prix de sa configuration (snapshot)
  IF EXISTS (
    SELECT 1 FROM "OrderLine" l JOIN "Configuration" c ON c."id" = l."configuration_id"
    WHERE l."order_id" = oid
      AND l."amount" <> c."base_price"
        + (SELECT coalesce(sum(ci."unit_price"), 0) FROM "ConfigurationItem" ci WHERE ci."configuration_id" = c."id")
  ) THEN
    RAISE EXCEPTION 'Order %: a line amount differs from its configuration price (constraint "OrderLine_amount")', oid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_amount';
  END IF;
  -- Une wishlist est convertie en au plus une ligne active payée
  IF o."status" = 'paid' AND EXISTS (
    SELECT 1 FROM "OrderLine" l
    WHERE l."order_id" = oid AND l."refund_id" IS NULL AND l."wishlist_id" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "OrderLine" l2 JOIN "Order" o2 ON o2."id" = l2."order_id"
        WHERE l2."wishlist_id" = l."wishlist_id" AND l2."id" <> l."id"
          AND l2."refund_id" IS NULL AND o2."status" = 'paid')
  ) THEN
    RAISE EXCEPTION 'Order %: a wishlist is already converted by another paid line (constraint "OrderLine_wishlist_converted_once")', oid
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'OrderLine_wishlist_converted_once';
  END IF;
END;
$$;

CREATE FUNCTION "trg_check_order"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Order' THEN
    PERFORM "Order_check"(NEW."id");
  ELSE
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM "Order_check"(OLD."order_id"); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM "Order_check"(NEW."order_id"); END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_check" AFTER INSERT OR UPDATE ON "Order"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_order"();
CREATE CONSTRAINT TRIGGER "OrderLine_order_check" AFTER INSERT OR UPDATE OR DELETE ON "OrderLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_order"();
CREATE CONSTRAINT TRIGGER "Refund_order_check" AFTER INSERT OR UPDATE OR DELETE ON "Refund"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_order"();

-- Remboursement : jamais supprimé ; montants figés une fois envoyé. Commande : Order_check.
CREATE FUNCTION "Refund_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund is never deleted (constraint "Refund_append_only")'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'Refund_append_only';
  END IF;
  IF NEW."order_id" <> OLD."order_id"
     OR (OLD."sent_at" IS NOT NULL AND (NEW."amount", NEW."amount_sats") IS DISTINCT FROM (OLD."amount", OLD."amount_sats")) THEN
    RAISE EXCEPTION 'Refund %: immutable field changed (constraint "Refund_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Refund_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Refund_guard"
  BEFORE UPDATE OR DELETE ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION "Refund_guard"();

-- ─── Adresses : figées dès qu'une commande les référence ───
CREATE FUNCTION "Address_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."user_id", NEW."full_name", NEW."company", NEW."line1", NEW."line2", NEW."postal_code", NEW."city", NEW."country", NEW."phone")
     IS DISTINCT FROM (OLD."user_id", OLD."full_name", OLD."company", OLD."line1", OLD."line2", OLD."postal_code", OLD."city", OLD."country", OLD."phone")
     AND EXISTS (SELECT 1 FROM "Order" WHERE "billing_address_id" = OLD."id" OR "shipping_address_id" = OLD."id") THEN
    RAISE EXCEPTION 'Address % is used by an order: create a new address and archive this one (constraint "Address_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Address_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Address_guard"
  BEFORE UPDATE ON "Address"
  FOR EACH ROW EXECUTE FUNCTION "Address_guard"();
