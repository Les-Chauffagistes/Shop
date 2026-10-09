-- ═════════════════════════════════════════════
-- v5b (1/2) : nouvelles valeurs d'énumération, dans une migration à part.
-- PostgreSQL refuse d'utiliser une valeur ajoutée par ALTER TYPE ... ADD VALUE dans la même
-- transaction (« unsafe use of new value ») ; Prisma exécute chaque migration en une transaction
-- implicite. Les règles qui s'en servent sont dans 20261007220100_v5b_orders_rules.
-- Aucune donnée touchée.
-- ═════════════════════════════════════════════

-- Facture en attente impayée annulée par l'utilisateur (libère la réservation immédiatement).
ALTER TYPE "order_status" ADD VALUE 'cancelled';

-- Qui supporte les frais réseau d'un remboursement : la boutique (règle générale) ou l'utilisateur
-- (remboursement demandé d'une facture expirée partiellement payée, décision Hugo 2026-10-07).
CREATE TYPE "refund_fee_payer" AS ENUM ('shop', 'user');
