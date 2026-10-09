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
