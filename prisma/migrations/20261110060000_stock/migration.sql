-- ═════════════════════════════════════════════
-- Stock d'un lot : pas de survente, contrôlé par la base au COMMIT, sous verrou du lot (Batch_lock).
-- Une seule source SQL, lue aussi par le domaine (src/server/shop.ts, batches.ts, orders.ts).
-- ═════════════════════════════════════════════

-- ─── Capacité d'un lot (batch_capacity), une seule règle pour les deux types ───
-- Palette (wholesale) : on vend exactement les machines du lot, même avant leur arrivée :
--   quantity − machines transférées vers le stock (MachineTransfer depuis le lot) − machines sorties du stock
--   (batch_written_off : missing / scrapped / lost ou faulty, hors machine d'une ligne active, comptée alors une
--   fois par sa ligne jusqu'au remplacement ou au remboursement). Sans transfert : la formule d'avant la refonte.
-- Lot de stock : on ne vend que ce qu'on a, contrôlé :
--   machines du lot vendables (machine_sellable : en main, ok, chaque hashboard contrôlée ok depuis la dernière
--   entrée en main) + machines des lignes actives du lot (en vie ou non, comptées par leur ligne jusqu'au
--   remplacement ou au remboursement, même règle que written_off). Une machine degraded, non contrôlée, à
--   recontrôler (retour, retrouvée) ou partie sans ligne active n'est pas vendable.
-- Consomment une place (batch_stock_lines), pour les deux types :
--   * chaque ligne non remboursée d'une commande paid ;
--   * chaque ligne d'une facture pending_payment NON EXPIRÉE (expires_at > now()) :
--     réservation de 30 minutes (roadmap, « Réservation et paiement tardif »). L'expiration
--     se lit sur l'horloge, sans job : passé expires_at, la place est libérée même si le
--     statut est encore pending_payment. now() = début de la transaction : une transaction
--     longue voit une réservation vivante un peu plus longtemps (sens prudent).
-- Le temps ne fait que libérer des places : l'invariant vérifié au COMMIT reste vrai ensuite.
-- Paiement tardif (facture expirée, puis paid) : la ligne compte de nouveau, le contrôle
-- refuse le COMMIT s'il n'y a plus de place (Batch_stock) ; on rembourse alors (refunded).

-- Machine dans les mains de la boutique (ni attendue, ni manquante, ni partie, ni au rebut) : seul état où l'on
-- contrôle, monte, attribue, vend depuis le stock.
CREATE FUNCTION "machine_in_hand"(s "machine_logistical_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT s IN ('in_stock', 'in_preparation', 'ready')
$$;

-- Machine vendable depuis un lot de stock (décisions Hugo 2026-11-10) : en main, ok (jamais degraded, qui exige
-- l'acceptation explicite du client), et contrôle complet depuis sa dernière entrée en main : chaque hashboard du
-- modèle saisie ok après in_hand_since (HashboardStatus.updated_at, horloge de la base). ok implique déjà des
-- hashboards ok (Machine_hashboards) ; la date impose le recontrôle d'une machine retournée ou retrouvée.
CREATE FUNCTION "machine_sellable"(m "Machine") RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT "machine_in_hand"(m."logistical_status") AND m."functional_status" = 'ok'
     AND (SELECT count(*) FROM "HashboardStatus" h
          WHERE h."machine_id" = m."id" AND h."status" = 'ok' AND h."updated_at" >= m."in_hand_since")
         = (SELECT mo."hashboard_qtt" FROM "Model" mo WHERE mo."id" = m."model_id")
$$;

-- Lignes actives (payées) d'un lot : non remboursées, commande paid. Machines et attributions.
CREATE FUNCTION "batch_active_lines"(b uuid)
RETURNS TABLE ("id" uuid, "machine_id" uuid, "configuration_id" uuid)
LANGUAGE sql STABLE AS $$
  SELECT l."id", l."machine_id", l."configuration_id"
  FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
  WHERE l."batch_id" = b AND l."refund_id" IS NULL AND o."status" = 'paid'
$$;

-- Lignes qui consomment le stock : lignes non remboursées des factures qui occupent le stock
-- (order_holds_stock : payées ou réservations vivantes).
-- `plus` : une facture impayée comptée en plus, comme si elle était payée (Order_fits_stock).
CREATE FUNCTION "batch_stock_lines"(b uuid, plus uuid DEFAULT NULL)
RETURNS TABLE ("id" uuid, "configuration_id" uuid)
LANGUAGE sql STABLE AS $$
  SELECT l."id", l."configuration_id"
  FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
  WHERE l."batch_id" = b
    AND ((l."refund_id" IS NULL AND "order_holds_stock"(o."status", o."expires_at"))
         OR o."id" = plus)
$$;

-- Machines sorties du stock : missing / scrapped / lost, et toute machine faulty, tant qu'elles ne sont pas la
-- machine d'une ligne active (comptée alors une fois, par sa ligne, jusqu'au remplacement ou au remboursement).
CREATE FUNCTION "batch_written_off"(b uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM "Machine" m
  WHERE m."batch_id" = b
    AND (m."logistical_status" IN ('missing', 'scrapped', 'lost') OR m."functional_status" = 'faulty')
    AND NOT EXISTS (SELECT 1 FROM "batch_active_lines"(b) a WHERE a."machine_id" = m."id")
$$;

-- Machines sorties d'une palette vers le lot de stock (journal MachineTransfer).
CREATE FUNCTION "batch_transferred_out"(b uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM "MachineTransfer" t WHERE t."from_batch_id" = b
$$;

-- Capacité d'un lot (voir l'en-tête) ; NULL si le lot n'existe pas.
CREATE FUNCTION "batch_capacity"(b uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE ba."kind"
    WHEN 'wholesale' THEN ba."quantity" - "batch_transferred_out"(b) - "batch_written_off"(b)
    ELSE (SELECT count(*)::integer FROM "Machine" m
          WHERE m."batch_id" = b
            AND ("machine_sellable"(m) OR EXISTS (SELECT 1 FROM "batch_active_lines"(b) a WHERE a."machine_id" = m."id")))
  END
  FROM "Batch" ba WHERE ba."id" = b
$$;

-- Stock disponible d'un lot : capacité − lignes payées et réservées.
-- Négatif = survendu (impossible après un COMMIT, Batch_stock). NULL si le lot n'existe pas.
-- `plus` : comme batch_stock_lines. Source unique de la règle : trigger de stock ET domaine
-- (compteur availableStock, refus de baisser quantity). Ne verrouille pas.
CREATE FUNCTION "batch_available_stock"(b uuid, plus uuid DEFAULT NULL) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT "batch_capacity"(b) - (SELECT count(*)::integer FROM "batch_stock_lines"(b, plus))
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
  v text;
BEGIN
  IF NOT "Batch_lock"(b) THEN RETURN; END IF;

  v := "batch_stock_violation"(b);
  IF v = 'Batch_stock' THEN
    RAISE EXCEPTION 'Batch % oversold: paid and reserved lines > capacity % (constraint "Batch_stock")', b, "batch_capacity"(b)
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

  -- Complète le trigger d'attribution (OrderLineAssignment_machine_in_batch) : la machine d'une ligne active
  -- appartient au lot de la ligne, quel que soit le chemin qui a changé l'une ou l'autre.
  IF EXISTS (
    SELECT 1 FROM "batch_active_lines"(b) a JOIN "Machine" m ON m."id" = a."machine_id"
    WHERE m."batch_id" <> b
  ) THEN
    RAISE EXCEPTION 'Batch %: the machine of an active line belongs to another batch (constraint "OrderLine_machine_in_batch")', b
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLine_machine_in_batch';
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

-- Machine qui change de lot d'appartenance (ou transfert) : les deux lots sont contrôlés, dans l'ordre des id (verrous).
CREATE FUNCTION "trg_check_stock"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Branches IF : plpgsql ne résout NEW.<champ> / OLD.<champ> que dans la branche exécutée
  IF TG_TABLE_NAME = 'Batch' THEN
    PERFORM "Batch_check_stock"(NEW."id");
  ELSIF TG_TABLE_NAME = 'MachineTransfer' THEN
    PERFORM "Batch_check_stock"(x) FROM unnest(ARRAY[NEW."from_batch_id", NEW."to_batch_id"]) x ORDER BY x;
  ELSIF TG_TABLE_NAME = 'Machine' AND TG_OP = 'UPDATE' AND OLD."batch_id" <> NEW."batch_id" THEN
    PERFORM "Batch_check_stock"(x) FROM unnest(ARRAY[OLD."batch_id", NEW."batch_id"]) x ORDER BY x;
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

CREATE CONSTRAINT TRIGGER "BatchOptionValue_stock" AFTER INSERT OR UPDATE OF "max_qty" ON "BatchOptionValue"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();

-- Vendabilité (lot de stock) : statuts, entrée en main (recontrôle exigé), appartenance. Une saisie de hashboard ne
-- fait qu'ajouter de la vendabilité (une hashboard défectueuse change l'état fonctionnel : Machine_hashboards).
CREATE CONSTRAINT TRIGGER "Machine_stock" AFTER INSERT OR UPDATE OF "logistical_status", "functional_status", "in_hand_since", "batch_id" ON "Machine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();

-- Journaux du stock : un transfert contrôle la palette et le lot de stock ; un réassort, son lot de stock.
CREATE CONSTRAINT TRIGGER "MachineTransfer_stock" AFTER INSERT ON "MachineTransfer"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();

CREATE CONSTRAINT TRIGGER "StockRestock_stock" AFTER INSERT ON "StockRestock"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();
