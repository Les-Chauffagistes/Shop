-- ═════════════════════════════════════════════
-- Types, tables, index et clés étrangères gérés par Prisma.
-- Généré par `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`, colonnes
-- remises dans l'ordre de la base historique (Prisma ignore cet ordre). Tout le reste (CHECK, index sur
-- expression, fonctions, triggers, vues, ligne ShopSettings) est dans les fichiers de domaine suivants.
--
-- Dates de création posées par l'horloge de la base : Order.created_at et OrderLine.created_at valent
-- transaction_timestamp() (= now(), début de transaction, la même base que expires_at : created_at +
-- 30 min = expires_at) ; écrit ainsi plutôt que now(), que Prisma lirait comme @default(now()) calculé
-- côté client. Refund.created_at, Payment.received_at, les journaux : clock_timestamp() (ordonne plusieurs
-- écritures d'une même transaction). Côté Prisma : @default(dbgenerated(…)). Une valeur fournie reste
-- acceptée (tests et seed antidatent) sauf là où un trigger la remplace.
-- OrderLine.position a un défaut sans signification (le trigger OrderLine_guard le remplace toujours) :
-- il rend la colonne facultative pour Prisma.
-- ═════════════════════════════════════════════

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "option_kind" AS ENUM ('toggle', 'choice');

-- CreateEnum
CREATE TYPE "batch_status" AS ENUM ('draft', 'survey', 'preorder', 'ordering', 'awaiting_reception', 'inspection', 'tuning', 'packaging', 'in_transit', 'closed', 'cancelled', 'on_sale');

-- CreateEnum
CREATE TYPE "batch_kind" AS ENUM ('wholesale', 'stock');

-- CreateEnum
CREATE TYPE "part_order_status" AS ENUM ('ordering', 'awaiting_delivery', 'delivered');

-- CreateEnum
CREATE TYPE "part_movement_kind" AS ENUM ('reception', 'adjustment', 'kit_mounted');

-- CreateEnum
CREATE TYPE "machine_functional_status" AS ENUM ('unknown', 'ok', 'degraded', 'faulty');

-- CreateEnum
CREATE TYPE "machine_logistical_status" AS ENUM ('expected', 'in_stock', 'in_preparation', 'ready', 'in_transit', 'delivered', 'missing', 'lost', 'returned', 'scrapped');

-- CreateEnum
CREATE TYPE "hashboard_status" AS ENUM ('not_checked', 'ok', 'degraded', 'dead');

-- CreateEnum
CREATE TYPE "machine_transfer_reason" AS ENUM ('batch_closed', 'admin');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('pending_payment', 'paid', 'expired', 'refunded', 'cancelled');

-- CreateEnum
CREATE TYPE "order_cancel_reason" AS ENUM ('user', 'batch_closed', 'admin');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('bitcoin', 'offchain');

-- CreateEnum
CREATE TYPE "order_channel" AS ENUM ('online', 'manual');

-- CreateEnum
CREATE TYPE "offchain_means" AS ENUM ('cash', 'bank_transfer', 'other');

-- CreateEnum
CREATE TYPE "refund_kind" AS ENUM ('cancellation', 'discount', 'overpayment');

-- CreateEnum
CREATE TYPE "refund_fee_payer" AS ENUM ('shop', 'user');

-- CreateEnum
CREATE TYPE "refund_initiator" AS ENUM ('user', 'admin', 'system');

-- CreateEnum
CREATE TYPE "refund_cause" AS ENUM ('shop_stock', 'shop_defective_machine', 'user_renounce', 'partial_payment', 'late_payment_no_room', 'overpayment', 'discount', 'admin_other');

-- CreateEnum
CREATE TYPE "actor_kind" AS ENUM ('user', 'admin');

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
    "kind" "batch_kind" NOT NULL DEFAULT 'wholesale',
    "status" "batch_status" NOT NULL DEFAULT 'draft',
    "quantity" INTEGER,
    "purchase_price" BIGINT,
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

-- CreateTable
CREATE TABLE "Machine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "model_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "origin_batch_id" UUID,
    "restock_id" UUID,
    "custom_number" INTEGER NOT NULL DEFAULT 1,
    "serial" TEXT,
    "psu_serial" TEXT,
    "functional_status" "machine_functional_status" NOT NULL DEFAULT 'unknown',
    "logistical_status" "machine_logistical_status" NOT NULL DEFAULT 'expected',
    "note" TEXT,
    "received_at" TIMESTAMPTZ(6),
    "in_hand_since" TIMESTAMPTZ(6),
    "shipped_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "carrier" TEXT,
    "tracking_number" TEXT,
    "tracking_url" TEXT,
    "shipped_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockRestock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "model_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "purchase_price" BIGINT NOT NULL,
    "note" TEXT,
    "created_by_auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "StockRestock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineTransfer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "from_batch_id" UUID NOT NULL,
    "to_batch_id" UUID NOT NULL,
    "reason" "machine_transfer_reason" NOT NULL,
    "note" TEXT,
    "changed_by_auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "MachineTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HashboardStatus" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "status" "hashboard_status" NOT NULL,
    "checked_by_auth_user_id" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "HashboardStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineMounting" (
    "machine_id" UUID NOT NULL,
    "option_value_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "MachineMounting_pkey" PRIMARY KEY ("machine_id","option_value_id")
);

-- CreateTable
CREATE TABLE "MachineStatusChange" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "from_logistical" "machine_logistical_status" NOT NULL,
    "to_logistical" "machine_logistical_status" NOT NULL,
    "from_functional" "machine_functional_status" NOT NULL,
    "to_functional" "machine_functional_status" NOT NULL,
    "note" TEXT,
    "changed_by_auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "MachineStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email" TEXT,
    "pseudo" TEXT,

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
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),
    "locked_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),

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
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),
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
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '00:30:00'::interval),
    "paid_at" TIMESTAMPTZ(6),
    "received_sats" BIGINT NOT NULL DEFAULT 0,
    "expired_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_sats" BIGINT,
    "cancelled_at" TIMESTAMPTZ(6),
    "refund_address" TEXT,
    "contact_email" TEXT,
    "cancel_reason" "order_cancel_reason",
    "channel" "order_channel" NOT NULL DEFAULT 'online',
    "created_by_auth_user_id" BIGINT,
    "manual_reason" TEXT,
    "received_cents" BIGINT NOT NULL DEFAULT 0,

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
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_line_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "machine_id" UUID,
    "changed_by_auth_user_id" BIGINT,
    "reason" TEXT,
    "degraded_accepted_by_user_id" UUID,
    "degraded_accepted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "OrderLineAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineRefundCause" (
    "case_code" TEXT NOT NULL,
    "cause" "refund_cause" NOT NULL,

    CONSTRAINT "MachineRefundCause_pkey" PRIMARY KEY ("case_code")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "amount_sats" BIGINT,
    "txid" TEXT,
    "vout" INTEGER,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "method" "payment_method" NOT NULL DEFAULT 'bitcoin',
    "amount_cents" BIGINT,
    "offchain_means" "offchain_means",
    "reference" TEXT,
    "recorded_by_auth_user_id" BIGINT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "amount_sats" BIGINT,
    "reason" TEXT NOT NULL,
    "destination_address" TEXT,
    "reference" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "sent_at" TIMESTAMPTZ(6),
    "kind" "refund_kind" NOT NULL,
    "network_fee_sats" BIGINT,
    "network_fee_payer" "refund_fee_payer" NOT NULL DEFAULT 'shop',
    "initiated_by" "refund_initiator" NOT NULL,
    "created_by_auth_user_id" BIGINT,
    "sent_by_auth_user_id" BIGINT,
    "cause" "refund_cause" NOT NULL,
    "method" "payment_method" NOT NULL DEFAULT 'bitcoin',

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "wishlist_max_per_user_per_batch" INTEGER NOT NULL DEFAULT 5,
    "order_max_lines" INTEGER NOT NULL DEFAULT 10,
    "abandoned_order_cooldown_minutes" INTEGER NOT NULL DEFAULT 5,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "abandoned_order_limit" INTEGER NOT NULL DEFAULT 3,
    "abandoned_order_window_hours" INTEGER NOT NULL DEFAULT 720,
    "order_block_duration_hours" INTEGER NOT NULL DEFAULT 72,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderBlockRelease" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "released_by_auth_user_id" BIGINT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "OrderBlockRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRefundAddressChange" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "old_address" TEXT,
    "new_address" TEXT,
    "actor" "actor_kind" NOT NULL,
    "actor_auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "OrderRefundAddressChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderExcessDismissal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "sats" BIGINT NOT NULL,
    "network_fee_sats" BIGINT NOT NULL,
    "reason" TEXT,
    "dismissed_by_auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "OrderExcessDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WishlistOptionWithdrawal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wishlist_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "withdrawn_value_id" UUID NOT NULL,
    "withdrawn_unit_price" BIGINT NOT NULL,
    "default_value_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "WishlistOptionWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Batch_status_idx" ON "Batch"("status");

-- CreateIndex
CREATE INDEX "Batch_model_id_idx" ON "Batch"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_id_model_id_key" ON "Batch"("id", "model_id");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_one_stock_per_model" ON "Batch"("model_id") WHERE (kind = 'stock'::batch_kind);

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
CREATE INDEX "BatchPartOrder_part_id_status_idx" ON "BatchPartOrder"("part_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BatchPartOrder_batch_id_part_id_key" ON "BatchPartOrder"("batch_id", "part_id");

-- CreateIndex
CREATE UNIQUE INDEX "BatchPartOrder_id_part_id_key" ON "BatchPartOrder"("id", "part_id");

-- CreateIndex
CREATE INDEX "PartStockMovement_part_id_created_at_idx" ON "PartStockMovement"("part_id", "created_at");

-- CreateIndex
CREATE INDEX "PartStockMovement_batch_id_part_id_idx" ON "PartStockMovement"("batch_id", "part_id");

-- CreateIndex
CREATE INDEX "PartStockMovement_machine_id_idx" ON "PartStockMovement"("machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "PartStockMovement_batch_part_order_id_part_id_key" ON "PartStockMovement"("batch_part_order_id", "part_id");

-- CreateIndex
CREATE INDEX "Machine_batch_id_logistical_status_functional_status_idx" ON "Machine"("batch_id", "logistical_status", "functional_status");

-- CreateIndex
CREATE INDEX "Machine_origin_batch_id_idx" ON "Machine"("origin_batch_id");

-- CreateIndex
CREATE INDEX "Machine_restock_id_idx" ON "Machine"("restock_id");

-- CreateIndex
CREATE INDEX "StockRestock_batch_id_created_at_idx" ON "StockRestock"("batch_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "StockRestock_id_model_id_key" ON "StockRestock"("id", "model_id");

-- CreateIndex
CREATE INDEX "MachineTransfer_machine_id_created_at_idx" ON "MachineTransfer"("machine_id", "created_at");

-- CreateIndex
CREATE INDEX "MachineTransfer_from_batch_id_idx" ON "MachineTransfer"("from_batch_id");

-- CreateIndex
CREATE INDEX "MachineTransfer_to_batch_id_idx" ON "MachineTransfer"("to_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_model_id_serial_key" ON "Machine"("model_id", "serial");

-- CreateIndex
CREATE INDEX "MachineMounting_option_value_id_idx" ON "MachineMounting"("option_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "HashboardStatus_machine_id_index_key" ON "HashboardStatus"("machine_id", "index");

-- CreateIndex
CREATE INDEX "MachineStatusChange_machine_id_created_at_idx" ON "MachineStatusChange"("machine_id", "created_at");

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
CREATE INDEX "Order_user_id_batch_id_expires_at_idx" ON "Order"("user_id", "batch_id", "expires_at");

-- CreateIndex
CREATE INDEX "Order_batch_id_paid_at_idx" ON "Order"("batch_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "Order_id_user_id_batch_id_key" ON "Order"("id", "user_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_id_payment_method_key" ON "Order"("id", "payment_method");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_configuration_id_key" ON "OrderLine"("configuration_id");

-- CreateIndex
CREATE INDEX "OrderLine_batch_id_idx" ON "OrderLine"("batch_id");

-- CreateIndex
CREATE INDEX "OrderLine_wishlist_id_idx" ON "OrderLine"("wishlist_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_configuration_id_batch_id_key" ON "OrderLine"("configuration_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_id_batch_id_key" ON "OrderLine"("id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_order_id_position_key" ON "OrderLine"("order_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_order_id_wishlist_id_key" ON "OrderLine"("order_id", "wishlist_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_machine_id_active_key" ON "OrderLine"("machine_id") WHERE (refund_id IS NULL);

-- CreateIndex
CREATE INDEX "OrderLineAssignment_order_line_id_created_at_idx" ON "OrderLineAssignment"("order_line_id", "created_at");

-- CreateIndex
CREATE INDEX "OrderLineAssignment_machine_id_idx" ON "OrderLineAssignment"("machine_id");

-- CreateIndex
CREATE INDEX "OrderLineAssignment_degraded_accepted_by_user_id_idx" ON "OrderLineAssignment"("degraded_accepted_by_user_id");

-- CreateIndex
CREATE INDEX "Payment_order_id_received_at_idx" ON "Payment"("order_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_txid_vout_key" ON "Payment"("txid", "vout");

-- CreateIndex
CREATE INDEX "Refund_order_id_idx" ON "Refund"("order_id");

-- CreateIndex
CREATE INDEX "Refund_unsent_created_at_idx" ON "Refund"("created_at") WHERE (sent_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_id_order_id_key" ON "Refund"("id", "order_id");

-- CreateIndex
CREATE INDEX "OrderBlockRelease_user_id_batch_id_created_at_idx" ON "OrderBlockRelease"("user_id", "batch_id", "created_at");

-- CreateIndex
CREATE INDEX "OrderBlockRelease_batch_id_idx" ON "OrderBlockRelease"("batch_id");

-- CreateIndex
CREATE INDEX "OrderRefundAddressChange_order_id_created_at_idx" ON "OrderRefundAddressChange"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "OrderExcessDismissal_order_id_key" ON "OrderExcessDismissal"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_order_id_key" ON "Shipment"("order_id");

-- CreateIndex
CREATE INDEX "WishlistOptionWithdrawal_user_id_created_at_idx" ON "WishlistOptionWithdrawal"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "WishlistOptionWithdrawal_wishlist_id_idx" ON "WishlistOptionWithdrawal"("wishlist_id");

-- CreateIndex
CREATE INDEX "WishlistOptionWithdrawal_batch_id_idx" ON "WishlistOptionWithdrawal"("batch_id");

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
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_batch_part_order_id_part_id_fkey" FOREIGN KEY ("batch_part_order_id", "part_id") REFERENCES "BatchPartOrder"("id", "part_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartStockMovement" ADD CONSTRAINT "PartStockMovement_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_batch_id_model_id_fkey" FOREIGN KEY ("batch_id", "model_id") REFERENCES "Batch"("id", "model_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_origin_batch_id_model_id_fkey" FOREIGN KEY ("origin_batch_id", "model_id") REFERENCES "Batch"("id", "model_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_restock_id_model_id_fkey" FOREIGN KEY ("restock_id", "model_id") REFERENCES "StockRestock"("id", "model_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockRestock" ADD CONSTRAINT "StockRestock_batch_id_model_id_fkey" FOREIGN KEY ("batch_id", "model_id") REFERENCES "Batch"("id", "model_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineTransfer" ADD CONSTRAINT "MachineTransfer_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineTransfer" ADD CONSTRAINT "MachineTransfer_from_batch_id_fkey" FOREIGN KEY ("from_batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineTransfer" ADD CONSTRAINT "MachineTransfer_to_batch_id_fkey" FOREIGN KEY ("to_batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineMounting" ADD CONSTRAINT "MachineMounting_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineMounting" ADD CONSTRAINT "MachineMounting_option_value_id_fkey" FOREIGN KEY ("option_value_id") REFERENCES "OptionValue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashboardStatus" ADD CONSTRAINT "HashboardStatus_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_refund_id_order_id_fkey" FOREIGN KEY ("refund_id", "order_id") REFERENCES "Refund"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_order_line_id_batch_id_fkey" FOREIGN KEY ("order_line_id", "batch_id") REFERENCES "OrderLine"("id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_degraded_accepted_by_user_id_fkey" FOREIGN KEY ("degraded_accepted_by_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_order_id_method_fkey" FOREIGN KEY ("order_id", "method") REFERENCES "Order"("id", "payment_method") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_order_id_method_fkey" FOREIGN KEY ("order_id", "method") REFERENCES "Order"("id", "payment_method") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderBlockRelease" ADD CONSTRAINT "OrderBlockRelease_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderBlockRelease" ADD CONSTRAINT "OrderBlockRelease_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRefundAddressChange" ADD CONSTRAINT "OrderRefundAddressChange_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderExcessDismissal" ADD CONSTRAINT "OrderExcessDismissal_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_wishlist_id_user_id_batch_id_fkey" FOREIGN KEY ("wishlist_id", "user_id", "batch_id") REFERENCES "Wishlist"("id", "user_id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_withdrawn_value_id_option_id_fkey" FOREIGN KEY ("withdrawn_value_id", "option_id") REFERENCES "OptionValue"("id", "option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistOptionWithdrawal" ADD CONSTRAINT "WishlistOptionWithdrawal_default_value_id_option_id_fkey" FOREIGN KEY ("default_value_id", "option_id") REFERENCES "OptionValue"("id", "option_id") ON DELETE RESTRICT ON UPDATE CASCADE;
