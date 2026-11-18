-- ═════════════════════════════════════════════
-- Base commune : conventions, utilitaires, réglages de la boutique.
--
-- Organisation de l'historique (un fichier par domaine, appliqués dans l'ordre) :
--   tables          types, tables, index et clés étrangères gérés par Prisma (généré depuis
--                   schema.prisma, colonnes dans l'ordre de la base) ;
--   common          ce fichier ;
--   catalog         modèles, menus d'options, valeurs, pièces ;
--   batches         lots : machine à états, menus et valeurs d'un lot, transition de statut ;
--   configurations  configurations et wishlists (gel, retrait d'une valeur) ;
--   orders          utilisateurs, adresses, factures, lignes, paiements, priorité, blocages ;
--   stock           capacité d'un lot (grossiste ou stock), vendabilité d'une machine, pas de survente ;
--   refunds         remboursements, adresse de remboursement, solde de paiement ;
--   parts           stock commun des pièces d'options, commandes de matériel ;
--   machines        machines, contrôle, hashboards, réassorts, transferts, attribution.
-- Chaque fonction, trigger, vue et contrainte n'y est défini qu'une fois. Tant qu'aucune base durable
-- n'a appliqué l'historique (décision Hugo, refonte machines / stock), une évolution modifie directement
-- la définition dans son fichier de domaine (pas de CREATE OR REPLACE empilé).
--
-- Raw SQL : invariants non exprimables en Prisma (voir schema.dbml).
-- Prisma ne gère ni les CHECK ni les triggers : ils ne génèrent pas de drift,
-- mais toute migration future qui recrée une table doit les reporter.
-- Les triggers « différés » s'évaluent au COMMIT : une opération en plusieurs
-- requêtes (remplacement, annulation + remboursement…) se fait dans UNE transaction.
--
-- Convention : toute erreur métier levée par un trigger porte son nom de contrainte
-- dans le message, sous la forme `(constraint "Nom")`. PrismaPg ne transmet pas le
-- champ CONSTRAINT des erreurs 23514/23001 ; src/server/errors.ts (pgFailureOf) lit le message.
-- ═════════════════════════════════════════════

-- ─── Réglages de la boutique (ShopSettings) ───
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_single_row_check" CHECK ("id" = 1);

ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_wishlist_max_check"
  CHECK ("wishlist_max_per_user_per_batch" BETWEEN 1 AND 1000);

ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_order_max_lines_check"
  CHECK ("order_max_lines" BETWEEN 1 AND 1000);

ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_cooldown_check"
  CHECK ("abandoned_order_cooldown_minutes" BETWEEN 0 AND 1440);

ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_abandoned_limit_check"
  CHECK ("abandoned_order_limit" BETWEEN 1 AND 100);

ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_abandoned_window_check"
  CHECK ("abandoned_order_window_hours" BETWEEN 1 AND 720);

ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_block_duration_check"
  CHECK ("order_block_duration_hours" BETWEEN 1 AND 720);

-- ─── Utilitaires ──────────────────────────────

-- Triggers des tables en ajout seul (journaux) : toute modification ou suppression est refusée.
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
-- Renvoie false si le lot n'existe pas.
CREATE FUNCTION "Batch_lock"(b uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Batch" SET "updated_at" = "updated_at" WHERE "id" = b;
  RETURN FOUND;
END;
$$;

-- Verrou partagé sur les lots d'un modèle : attend une publication concurrente (BatchStatusTransition_check
-- prend la ligne Batch FOR UPDATE) puis laisse la requête suivante relire le statut validé.
-- FOR KEY SHARE ne bloque pas Batch_lock (UPDATE hors clé) : pas d'interblocage avec le stock.
CREATE FUNCTION "model_lock_batches"(m uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "Batch" WHERE "model_id" = m FOR KEY SHARE;
END;
$$;

-- Triggers des tables dont les lignes ne sont jamais supprimées (factures, réglages).
CREATE FUNCTION "raise_never_deleted"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is never deleted (constraint "%_no_delete")', TG_TABLE_NAME, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Réglages de la boutique (une ligne, créée en fin de ce fichier, jamais supprimée).
CREATE FUNCTION "shop_settings"() RETURNS "ShopSettings"
LANGUAGE plpgsql STABLE AS $$
DECLARE
  s "ShopSettings";
BEGIN
  SELECT * INTO s FROM "ShopSettings" WHERE "id" = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ShopSettings row is missing (constraint "ShopSettings_required")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ShopSettings_required';
  END IF;
  RETURN s;
END;
$$;

-- Journal des changements d'adresse de remboursement (OrderRefundAddressChange, voir refunds).
-- Déclare l'acteur de la transaction en cours (portée : la transaction, set_config local) : à appeler
-- avant toute écriture de Order.refund_address. user : l'utilisateur de la facture ; admin : identifiant de
-- l'admin (whitelist). Renvoie true (lisible par $queryRaw, contrairement à void).
CREATE FUNCTION "declare_actor"(kind "actor_kind", auth_user_id bigint) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  IF kind IS NULL OR auth_user_id IS NULL OR auth_user_id <= 0 THEN
    RAISE EXCEPTION 'declare_actor: actor kind and a positive auth user id are required (constraint "OrderRefundAddressChange_actor")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderRefundAddressChange_actor';
  END IF;
  PERFORM set_config('shop.actor_kind', kind::text, true);
  PERFORM set_config('shop.actor_auth_user_id', auth_user_id::text, true);
  RETURN true;
END;
$$;

CREATE TRIGGER "ShopSettings_no_delete"
  BEFORE DELETE ON "ShopSettings"
  FOR EACH ROW EXECUTE FUNCTION "raise_never_deleted"();

-- La ligne unique des réglages (ShopSettings_single_row_check, jamais supprimée).
INSERT INTO "ShopSettings" DEFAULT VALUES;
