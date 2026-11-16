-- ═════════════════════════════════════════════
-- Machines : génération, réception, contrôle, hashboards, réassorts, transferts vers le stock, attribution aux
-- lignes de commande.
-- Sources : specs.md (« Confirmer la réception d'un lot », « Passer en phase de packaging »), rules.md
-- (jalon 5), roadmap (« Machines défectueuses et surplus », « Workflow »), revue logistique du 2026-10-06
-- (§5.2, transitions M1 à M15), refonte machines / stock (R1 : machine décloisonnée du lot ; R2 : lot de stock,
-- réassorts, transferts, décisions Hugo du 2026-11-10).
--   * Une machine est un objet physique durable, distinct du lot :
--       - son origine, IMMUABLE, exactement une des deux (Machine_origin_check) : origin_batch_id, la palette d'où
--         elle vient, ou restock_id, le réassort qui l'a fait entrer au stock ;
--       - batch_id, le lot auquel elle appartient aujourd'hui (celui dont elle alimente le stock) : changé
--         seulement par le journal des transferts MachineTransfer (palette → lot de stock du même modèle).
--     Trois naissances : dans la palette (origin_batch_id = batch_id, génération à l'Attente de réception, au
--     plus quantity) ; au stock par un réassort (restock_id) ; au stock en plus de la quantité d'une palette
--     (origin_batch_id = la palette, batch_id = le lot de stock, une fois la palette pleine). « Née dans la
--     palette » = elle y est encore ou en est sortie par un transfert (batch_born_machines).
--     Toutes les références vers une machine (OrderLine, OrderLineAssignment, MachineStatusChange,
--     PartStockMovement, MachineTransfer) sont des clés étrangères simples : l'appartenance au lot de la ligne est
--     vérifiée par trigger à l'attribution (OrderLineAssignment_machine_in_batch) et au COMMIT
--     (OrderLine_machine_in_batch, stock) ; un transfert est refusé tant que la machine est sur une ligne active.
--   * Les statuts d'une machine ne dépendent pas du statut de son lot, sauf : un lot annulé fige ses machines
--     (Machine_batch_frozen, MachineStatusChange_batch_status, HashboardStatus_machine_in_hand) ; une palette
--     attribue ses machines du Contrôle à En transit (OrderLineAssignment_batch_status).
--   * Statuts d'une machine : ils ne changent QUE par l'insertion d'une ligne du journal en ajout seul
--     MachineStatusChange (qui, quand, de quoi vers quoi, motif). La base vérifie le statut courant et le
--     couple autorisé, puis pose elle-même les dates de réception, d'entrée en main (in_hand_since),
--     d'expédition, de livraison. Remise au transporteur : seulement la machine d'une ligne active de son lot.
--   * Contrôle : état fonctionnel saisi seulement sur une machine reçue et en main, quel que soit le statut
--     du lot (hors annulé) ; jamais de retour à `unknown` ; correction avec motif ; cohérent avec les hashboards.
--     Vendable depuis le stock : machine_sellable (fichier stock), contrôle complet depuis la dernière entrée en main.
--   * Machine morte (faulty) : retirée de la capacité dès qu'elle est marquée (batch_capacity, stock), jamais
--     préparée ni expédiée, mise au rebut seulement si faulty. Quand une machine meurt sur un lot plein, le
--     COMMIT est refusé (Batch_stock) tant que la ligne en trop n'est pas remboursée dans la même transaction :
--     jamais plus de commandes payées que de machines utilisables ; l'ordre de remboursement est donné par
--     batch_surplus_lines (source unique du domaine).
--   * Machine jamais supprimée ; lot annulé : machines figées.
--   * Jalon 5 bis (décisions de Hugo du 2026-11-16) :
--       - numéro de série obligatoire dès la réception, donc avant tout contrôle de hashboard et avant toute mise
--         « à vendre » ou attribution (Machine_serial_received_check) ;
--       - machine degraded attribuée seulement avec l'acceptation explicite du client, enregistrée (qui, quand) en plus du
--         motif (OrderLineAssignment_degraded_acceptance) ; degraded n'est jamais confondue avec ok (vues) ;
--       - mise au rebut réversible : scrapped → in_stock (M16, motif), tant que la place n'est pas reprise
--         (Machine_scrap_return_place) ;
--       - motif de remboursement par cas : table MachineRefundCause (machine_refund_cause) ;
--       - sortie du Contrôle d'une palette : Tuning et Packaging bloqués tant qu'il reste des machines attendues, des
--         commandes en trop ou des lignes à remplacer ; Packaging bloqué tant qu'une ligne payée n'a pas de machine
--         (BatchStatusTransition_1b_inspection_exit).
-- Ordre des verrous : facture(s) → ligne(s) → machine(s) (par id) → lot(s) (par id). Une opération qui touche aussi
-- des factures (remboursement du surplus) les verrouille AVANT de toucher une machine. La clôture d'une palette
-- (transfert des invendus) verrouille le lot puis ses machines : le domaine verrouille les machines du lot AVANT
-- d'insérer la transition (comme il verrouille les factures en attente avant une annulation).
-- ═════════════════════════════════════════════

-- ─── Contraintes CHECK et index hors Prisma ───

-- Machine
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_serial_check" CHECK (btrim("serial") <> '');

-- Numéro de série obligatoire dès la réception (décision de Hugo, 2026-11-16) : une machine qui n'est ni attendue ni
-- manquante a son numéro. Il est donc posé avant la réception, avant le contrôle des hashboards (machine en main) et
-- avant toute attribution ou mise en vente ; il ne s'efface plus. Même règle pour une machine de stock (réassort).
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_serial_received_check"
  CHECK ("serial" IS NOT NULL OR "logistical_status" IN ('expected', 'missing'));

ALTER TABLE "Machine" ADD CONSTRAINT "Machine_received_at_check"
  CHECK ("logistical_status" IN ('expected', 'missing') OR "received_at" IS NOT NULL);

-- Entrée en main la plus récente (posée par la base) : existe dès la première réception, jamais avant elle.
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_in_hand_since_check"
  CHECK (("received_at" IS NULL) = ("in_hand_since" IS NULL) AND "in_hand_since" >= "received_at");

ALTER TABLE "Machine" ADD CONSTRAINT "Machine_shipped_at_check"
  CHECK ("logistical_status" NOT IN ('in_transit', 'delivered', 'lost') OR "shipped_at" IS NOT NULL);

ALTER TABLE "Machine" ADD CONSTRAINT "Machine_delivered_at_check"
  CHECK ("logistical_status" <> 'delivered' OR "delivered_at" IS NOT NULL);

-- Une machine morte ou non contrôlée n'est ni montée, ni prête, ni expédiée
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_functional_before_prepare_check"
  CHECK ("logistical_status" NOT IN ('in_preparation', 'ready', 'in_transit')
         OR "functional_status" IN ('ok', 'degraded'));

-- Machine : un état fonctionnel saisi suppose une machine reçue ; une machine au rebut est morte.
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_checked_received_check"
  CHECK ("functional_status" = 'unknown' OR "logistical_status" NOT IN ('expected', 'missing'));

ALTER TABLE "Machine" ADD CONSTRAINT "Machine_scrapped_faulty_check"
  CHECK ("logistical_status" <> 'scrapped' OR "functional_status" = 'faulty');

ALTER TABLE "Machine" ADD CONSTRAINT "Machine_psu_serial_check" CHECK (btrim("psu_serial") <> '');

-- Exactement une origine : la palette d'où elle vient, ou le réassort qui l'a fait entrer au stock.
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_origin_check" CHECK (num_nonnulls("origin_batch_id", "restock_id") = 1);

-- Shipment : suivi du colis (lien http/https), livraison jamais avant la remise au transporteur
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tracking_url_check" CHECK ("tracking_url" ~* '^https?://');

ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_delivered_at_check"
  CHECK ("delivered_at" IS NULL OR ("shipped_at" IS NOT NULL AND "delivered_at" >= "shipped_at"));

-- StockRestock
ALTER TABLE "StockRestock" ADD CONSTRAINT "StockRestock_quantity_check" CHECK ("quantity" > 0);

ALTER TABLE "StockRestock" ADD CONSTRAINT "StockRestock_purchase_price_check" CHECK ("purchase_price" >= 0);

ALTER TABLE "StockRestock" ADD CONSTRAINT "StockRestock_note_check" CHECK (btrim("note") <> '');

ALTER TABLE "StockRestock" ADD CONSTRAINT "StockRestock_created_by_check" CHECK ("created_by_auth_user_id" > 0);

-- MachineTransfer
ALTER TABLE "MachineTransfer" ADD CONSTRAINT "MachineTransfer_batches_check" CHECK ("from_batch_id" <> "to_batch_id");

ALTER TABLE "MachineTransfer" ADD CONSTRAINT "MachineTransfer_note_check" CHECK (btrim("note") <> '');

ALTER TABLE "MachineTransfer" ADD CONSTRAINT "MachineTransfer_changed_by_check" CHECK ("changed_by_auth_user_id" > 0);

-- HashboardStatus
ALTER TABLE "HashboardStatus" ADD CONSTRAINT "HashboardStatus_index_check" CHECK ("index" >= 0);

-- Hashboard : une ligne = une hashboard contrôlée (l'absence de ligne vaut « non contrôlée »).
ALTER TABLE "HashboardStatus" ADD CONSTRAINT "HashboardStatus_checked_check" CHECK ("status" <> 'not_checked');

ALTER TABLE "HashboardStatus" ADD CONSTRAINT "HashboardStatus_checked_by_check" CHECK ("checked_by_auth_user_id" > 0);

-- MachineStatusChange
ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_changed_by_check" CHECK ("changed_by_auth_user_id" > 0);

ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_note_check" CHECK (btrim("note") <> '');

ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_changed_check"
  CHECK (("from_logistical", "from_functional") IS DISTINCT FROM ("to_logistical", "to_functional"));

-- OrderLineAssignment
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_changed_by_check" CHECK ("changed_by_auth_user_id" > 0);

-- Motif d'attribution non vide s'il est donné (obligatoire pour un remplacement, un retrait, une machine degraded).
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_reason_check" CHECK (btrim("reason") <> '');

-- Acceptation du client (machine degraded) : qui et quand vont ensemble. Le reste (obligatoire si degraded, client de la
-- ligne, pas dans le futur) est vérifié par OrderLineAssignment_apply.
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_acceptance_check"
  CHECK (("degraded_accepted_by_user_id" IS NULL) = ("degraded_accepted_at" IS NULL));

-- Motif de remboursement par cas de machine : table extensible (une ligne par cas), lue par le domaine avec
-- machine_refund_cause(cas). Cas de départ : faulty (morte) et degraded → shop_defective_machine ; missing (manquante)
-- et lost (perdue en transit) → shop_stock. Seulement un motif à la charge de la boutique. Un nouveau cas s'ajoute par
-- une ligne, sans migration.
ALTER TABLE "MachineRefundCause" ADD CONSTRAINT "MachineRefundCause_case_code_check" CHECK ("case_code" ~ '^[a-z][a-z0-9_]*$');

ALTER TABLE "MachineRefundCause" ADD CONSTRAINT "MachineRefundCause_cause_check"
  CHECK ("cause" IN ('shop_stock', 'shop_defective_machine', 'admin_other'));

INSERT INTO "MachineRefundCause" ("case_code", "cause") VALUES
  ('faulty', 'shop_defective_machine'), ('degraded', 'shop_defective_machine'),
  ('missing', 'shop_stock'), ('lost', 'shop_stock');

-- Motif du remboursement d'une machine pour le cas donné ; NULL si le cas est inconnu (le domaine refuse alors).
CREATE FUNCTION "machine_refund_cause"(c text) RETURNS "refund_cause"
LANGUAGE sql STABLE AS $$
  SELECT "cause" FROM "MachineRefundCause" WHERE "case_code" = c
$$;

-- ─── Statuts d'une machine (machine_in_hand : fichier stock) ───

-- Transitions logistiques autorisées (revue logistique §5.2). Un même statut (f = t) n'est pas une transition :
-- une ligne du journal qui ne change que l'état fonctionnel garde le statut logistique.
--   M1 expected → in_stock (reçue)            M2 expected → missing (jamais reçue, motif)
--   M3 missing → in_stock (retrouvée, motif)  M4 in_stock → in_preparation (montage)
--   M5 in_stock → ready                       M6 in_preparation → ready
--   M7 in_preparation → in_stock (motif)      M8 in_stock → scrapped (morte, motif ; faulty exigé)
--   M9 ready → in_transit (machine d'une ligne active de son lot)
--   M10 in_transit → delivered                M11 in_transit → lost (motif)
--   M12 in_transit → returned (motif)         M13 returned → in_stock (motif, à recontrôler)
--   M14 ready → in_stock (motif)              M15 lost → in_stock (retrouvée, motif)
--   M16 scrapped → in_stock (rebut annulé, motif, à recontrôler ; refusé si la place a été reprise :
--       Machine_scrap_return_place, décision de Hugo du 2026-11-16)
-- Terminal : delivered. Aucun retour vers expected.
CREATE FUNCTION "machine_transition_allowed"(f "machine_logistical_status", t "machine_logistical_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT f = t OR (f::text || '>' || t::text) IN (
    'expected>in_stock', 'expected>missing', 'missing>in_stock',
    'in_stock>in_preparation', 'in_stock>ready', 'in_stock>scrapped',
    'in_preparation>ready', 'in_preparation>in_stock',
    'ready>in_transit', 'ready>in_stock',
    'in_transit>delivered', 'in_transit>lost', 'in_transit>returned',
    'returned>in_stock', 'lost>in_stock', 'scrapped>in_stock')
$$;

ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_allowed_check"
  CHECK ("machine_transition_allowed"("from_logistical", "to_logistical"));

-- Motif obligatoire : sortie du flux (manquante, au rebut, perdue, retournée), retour arrière (dont le rebut annulé), et correction d'un
-- état fonctionnel déjà saisi (ok ↔ degraded ↔ faulty).
CREATE FUNCTION "machine_change_needs_note"(
  fl "machine_logistical_status", tl "machine_logistical_status",
  ff "machine_functional_status", tf "machine_functional_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (fl <> tl AND (tl IN ('missing', 'scrapped', 'lost', 'returned')
                        OR (fl::text || '>' || tl::text) IN (
                          'missing>in_stock', 'in_preparation>in_stock', 'ready>in_stock',
                          'returned>in_stock', 'lost>in_stock', 'scrapped>in_stock')))
      OR (ff <> 'unknown' AND tf <> ff)
$$;

ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_note_required_check"
  CHECK ("note" IS NOT NULL
         OR NOT "machine_change_needs_note"("from_logistical", "to_logistical", "from_functional", "to_functional"));

-- ─── Machine : écritures directes, statuts via le journal ───

-- Machines nées dans une palette : origine = la palette et appartenance initiale = la palette (elle y est encore, ou
-- en est sortie par un transfert). Une machine reçue en plus de la quantité naît directement au stock : non comptée.
CREATE FUNCTION "batch_born_machines"(b uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM "Machine" m
  WHERE m."origin_batch_id" = b
    AND (m."batch_id" = b OR EXISTS (SELECT 1 FROM "MachineTransfer" t WHERE t."machine_id" = m."id" AND t."from_batch_id" = b))
$$;

-- Insertion : machine attendue (expected, unknown, sans date) et origine cohérente, sous verrou des lots concernés
-- (par id) :
--   * née dans une palette (origin_batch_id = batch_id) : palette (Machine_origin), non annulée (Machine_batch_frozen),
--     jamais plus de machines nées dans la palette que sa quantité (Machine_batch_quantity) ;
--   * reçue en plus d'une palette pleine (origin_batch_id = la palette, batch_id = le lot de stock de son modèle) :
--     seulement une fois toutes les machines de la palette nées (Machine_origin) ;
--   * réassort (restock_id) : dans le lot de stock du réassort (Machine_origin), au plus la quantité du réassort
--     (Machine_restock_quantity) ; insérée par le réassort lui-même (StockRestock_generate_machines).
-- Le statut de la palette n'est pas vérifié : la génération à l'Attente de réception est le fait de la transition.
-- Mise à jour : identité, origine et date de création immuables ; lot d'appartenance seulement par MachineTransfer,
-- statuts et dates (réception, entrée en main, expédition, livraison) seulement par MachineStatusChange (triggers
-- imbriqués) ; numéros de série figés une fois la machine partie ; lot annulé : rien ne bouge. updated_at : horloge
-- de la base.
CREATE FUNCTION "Machine_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o "Batch"%ROWTYPE;
  r "StockRestock"%ROWTYPE;
  bst "batch_status";
  born integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Machine % is never deleted (constraint "Machine_no_delete")', OLD."id"
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'Machine_no_delete';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."logistical_status" <> 'expected' OR NEW."functional_status" <> 'unknown'
       OR NEW."received_at" IS NOT NULL OR NEW."in_hand_since" IS NOT NULL
       OR NEW."shipped_at" IS NOT NULL OR NEW."delivered_at" IS NOT NULL THEN
      RAISE EXCEPTION 'A new machine is expected, unchecked and undated (constraint "Machine_new")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_new';
    END IF;
    IF num_nonnulls(NEW."origin_batch_id", NEW."restock_id") <> 1 THEN
      RAISE EXCEPTION 'A machine comes from exactly one palette or one restock (constraint "Machine_origin_check")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_origin_check';
    END IF;
    PERFORM "Batch_lock"(x) FROM unnest(ARRAY[NEW."batch_id", NEW."origin_batch_id"]) x WHERE x IS NOT NULL ORDER BY x;
    IF NEW."restock_id" IS NOT NULL THEN
      SELECT * INTO r FROM "StockRestock" WHERE "id" = NEW."restock_id";
      IF r."batch_id" IS DISTINCT FROM NEW."batch_id" THEN
        RAISE EXCEPTION 'A restocked machine is born in the stock batch of its restock (constraint "Machine_origin")'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_origin';
      END IF;
      IF (SELECT count(*) FROM "Machine" WHERE "restock_id" = NEW."restock_id") >= r."quantity" THEN
        RAISE EXCEPTION 'Restock % already has its % machines (constraint "Machine_restock_quantity")', r."id", r."quantity"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_restock_quantity';
      END IF;
    ELSE
      SELECT * INTO o FROM "Batch" WHERE "id" = NEW."origin_batch_id";
      IF o."kind" IS DISTINCT FROM 'wholesale' THEN
        RAISE EXCEPTION 'The origin batch of a machine is a palette (constraint "Machine_origin")'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_origin';
      END IF;
      IF o."status" = 'cancelled' THEN
        RAISE EXCEPTION 'Batch % is cancelled: its machines are frozen (constraint "Machine_batch_frozen")', o."id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_batch_frozen';
      END IF;
      born := "batch_born_machines"(o."id");
      IF NEW."batch_id" = o."id" THEN
        IF born >= o."quantity" THEN
          RAISE EXCEPTION 'Batch % already has its % machines (constraint "Machine_batch_quantity")', o."id", o."quantity"
            USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_batch_quantity';
        END IF;
      ELSIF NOT EXISTS (SELECT 1 FROM "Batch" WHERE "id" = NEW."batch_id" AND "kind" = 'stock' AND "model_id" = o."model_id") THEN
        RAISE EXCEPTION 'A machine of a palette is born in the palette, or as an extra in the stock batch of its model (constraint "Machine_origin")'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_origin';
      ELSIF born < o."quantity" THEN
        RAISE EXCEPTION 'Batch % has % of its % machines: an extra machine goes to the stock only once the palette is full (constraint "Machine_origin")',
          o."id", born, o."quantity"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_origin';
      END IF;
    END IF;
    NEW."created_at" := clock_timestamp();
    NEW."updated_at" := NEW."created_at";
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."model_id", NEW."origin_batch_id", NEW."restock_id", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."model_id", OLD."origin_batch_id", OLD."restock_id", OLD."created_at")
     OR (NEW."batch_id" IS DISTINCT FROM OLD."batch_id" AND pg_trigger_depth() < 2) THEN
    RAISE EXCEPTION 'Machine % keeps its id, model, origin and creation date; it changes batch only by a MachineTransfer (constraint "Machine_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_immutable';
  END IF;
  IF (NEW."logistical_status", NEW."functional_status", NEW."received_at", NEW."in_hand_since", NEW."shipped_at", NEW."delivered_at")
     IS DISTINCT FROM (OLD."logistical_status", OLD."functional_status", OLD."received_at", OLD."in_hand_since", OLD."shipped_at", OLD."delivered_at")
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Machine statuses and dates change only by inserting a MachineStatusChange (constraint "Machine_status_via_change")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_status_via_change';
  END IF;
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = OLD."batch_id";
  IF bst = 'cancelled' THEN
    RAISE EXCEPTION 'Batch % is cancelled: its machines are frozen (constraint "Machine_batch_frozen")', OLD."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_batch_frozen';
  END IF;
  IF (NEW."serial", NEW."psu_serial") IS DISTINCT FROM (OLD."serial", OLD."psu_serial")
     AND OLD."logistical_status" IN ('in_transit', 'delivered', 'lost', 'scrapped') THEN
    RAISE EXCEPTION 'Machine % has left the shop: its serial numbers are frozen (constraint "Machine_serial_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_serial_frozen';
  END IF;
  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Machine_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "Machine"
  FOR EACH ROW EXECUTE FUNCTION "Machine_guard"();

-- ─── Envoi d'une facture (Shipment, une par facture) ───

-- Un envoi = une facture payée (UNIQUE(order_id)) : transporteur et suivi saisis par l'application, dates posées par la
-- base seule, par MachineStatusChange_apply (niveau de trigger 2) :
--   * shipped_at : la première machine de la facture remise au transporteur (une facture ne part que complète :
--     Shipment_complete, voir plus bas). Jamais recalée : une machine perdue ou retournée après l'expédition n'annule
--     pas l'envoi, le statut de la machine porte l'incident ;
--   * delivered_at : posée une fois, quand une machine de la facture est livrée et qu'aucune machine d'une ligne
--     active n'est plus à acheminer (ni en main, ni en transit : toutes livrées, perdues ou retournées).
-- L'envoi est créé par l'application (transporteur donné d'avance) ou par la base à la première remise. Jamais supprimé.
CREATE FUNCTION "Shipment_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ost "order_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shipment % is never deleted (constraint "Shipment_no_delete")', OLD."id"
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'Shipment_no_delete';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() < 2 AND (NEW."shipped_at" IS NOT NULL OR NEW."delivered_at" IS NOT NULL) THEN
      RAISE EXCEPTION 'A new shipment is undated: its dates are set by the machine status changes (constraint "Shipment_new")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Shipment_new';
    END IF;
    SELECT "status" INTO ost FROM "Order" WHERE "id" = NEW."order_id";
    IF ost IS DISTINCT FROM 'paid' THEN
      RAISE EXCEPTION 'Order % is not paid: it has no shipment (constraint "Shipment_order_paid")', NEW."order_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Shipment_order_paid';
    END IF;
    NEW."created_at" := clock_timestamp();
    NEW."updated_at" := NEW."created_at";
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."order_id", NEW."created_at") IS DISTINCT FROM (OLD."id", OLD."order_id", OLD."created_at") THEN
    RAISE EXCEPTION 'Shipment % keeps its id, order and creation date (constraint "Shipment_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Shipment_immutable';
  END IF;
  IF (NEW."shipped_at", NEW."delivered_at") IS DISTINCT FROM (OLD."shipped_at", OLD."delivered_at")
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Shipment dates change only by inserting a MachineStatusChange (constraint "Shipment_dates_via_change")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Shipment_dates_via_change';
  END IF;
  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Shipment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION "Shipment_guard"();

-- Journal des statuts : l'insertion vérifie l'état courant (sous verrou de la machine), le couple autorisé (CHECK),
-- que le lot d'appartenance n'est pas annulé (sous verrou du lot), puis applique les statuts et les dates. Le statut
-- du lot ne borne rien d'autre : réception, contrôle, préparation et expédition suivent la machine.
--   * entrée en main (expected, missing, returned ou lost → in_stock) : in_hand_since = maintenant ; received_at
--     reste la première réception. Une machine retournée ou retrouvée se recontrôle depuis cette date ;
--   * remise au transporteur (→ in_transit) : machine d'une ligne active (facture payée, non remboursée) de son
--     lot (Machine_shipped_assigned, aussi vérifié au COMMIT par le stock), et seulement si TOUTES les lignes
--     actives de sa facture ont une machine attribuée (Shipment_complete) ; pose Shipment.shipped_at (créé au besoin) ;
--   * livraison, perte ou retour (→ delivered, lost, returned) : pose Shipment.delivered_at s'il y a lieu.
-- Ordre des verrous : machine, lot.
CREATE FUNCTION "MachineStatusChange_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m "Machine"%ROWTYPE;
  bst "batch_status";
  ts timestamptz := clock_timestamp();
  oid uuid;
BEGIN
  -- Mêmes règles que les CHECK de la table, vérifiées AVANT d'écrire la machine (message stable)
  IF (NEW."from_logistical", NEW."from_functional") IS NOT DISTINCT FROM (NEW."to_logistical", NEW."to_functional") THEN
    RAISE EXCEPTION 'A machine status change changes something (constraint "MachineStatusChange_changed_check")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_changed_check';
  END IF;
  IF NOT "machine_transition_allowed"(NEW."from_logistical", NEW."to_logistical") THEN
    RAISE EXCEPTION 'Machine transition % > % is not allowed (constraint "MachineStatusChange_allowed_check")', NEW."from_logistical", NEW."to_logistical"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_allowed_check';
  END IF;
  IF NEW."note" IS NULL AND "machine_change_needs_note"(NEW."from_logistical", NEW."to_logistical", NEW."from_functional", NEW."to_functional") THEN
    RAISE EXCEPTION 'This machine status change needs a note (constraint "MachineStatusChange_note_required_check")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_note_required_check';
  END IF;
  SELECT * INTO m FROM "Machine" WHERE "id" = NEW."machine_id" FOR NO KEY UPDATE;
  IF (m."logistical_status", m."functional_status") IS DISTINCT FROM (NEW."from_logistical", NEW."from_functional") THEN
    RAISE EXCEPTION 'Machine % is %/%, not %/% (constraint "MachineStatusChange_current")', NEW."machine_id",
      m."logistical_status", m."functional_status", NEW."from_logistical", NEW."from_functional"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_current';
  END IF;
  PERFORM "Batch_lock"(m."batch_id");
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = m."batch_id";
  IF bst = 'cancelled' THEN
    RAISE EXCEPTION 'Batch % is cancelled: its machines are frozen (constraint "MachineStatusChange_batch_status")', m."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_batch_status';
  END IF;
  -- Numéro de série obligatoire dès la réception (même règle que le CHECK de la table, message stable)
  IF m."serial" IS NULL AND NEW."to_logistical" NOT IN ('expected', 'missing') THEN
    RAISE EXCEPTION 'Machine % needs its serial number before it is received (constraint "Machine_serial_received_check")', m."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_serial_received_check';
  END IF;
  -- Rebut annulé : la place de la machine ne doit pas avoir été reprise par une ligne payée ou réservée (le lot n'est
  -- pas survendu, voir batch_available_stock). Le COMMIT vérifie la même chose (Batch_stock) ; ce refus est immédiat.
  IF NEW."from_logistical" = 'scrapped' AND NEW."to_logistical" = 'in_stock' AND "batch_available_stock"(m."batch_id") < 0 THEN
    RAISE EXCEPTION 'The place of scrapped machine % has been taken by a paid or reserved line (constraint "Machine_scrap_return_place")', m."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_scrap_return_place';
  END IF;
  -- Facture de la machine (sa ligne active dans son lot), pour l'envoi
  SELECT l."order_id" INTO oid
  FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
  WHERE l."machine_id" = m."id" AND l."batch_id" = m."batch_id" AND l."refund_id" IS NULL AND o."status" = 'paid';
  IF NEW."to_logistical" = 'in_transit' AND NEW."from_logistical" <> 'in_transit' THEN
    IF oid IS NULL THEN
      RAISE EXCEPTION 'Machine % is handed to the carrier only as the machine of an active line of its batch (constraint "Machine_shipped_assigned")', m."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_shipped_assigned';
    END IF;
    IF EXISTS (SELECT 1 FROM "OrderLine" WHERE "order_id" = oid AND "refund_id" IS NULL AND "machine_id" IS NULL) THEN
      RAISE EXCEPTION 'Order % ships only complete: every active line needs its machine (constraint "Shipment_complete")', oid
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Shipment_complete';
    END IF;
  END IF;
  -- Contrôle : sur une machine en main ; jamais de retour à « non contrôlée »
  IF NEW."to_functional" <> NEW."from_functional" THEN
    IF NEW."to_functional" = 'unknown' THEN
      RAISE EXCEPTION 'Machine % was checked: it never goes back to unknown (constraint "MachineStatusChange_functional")', NEW."machine_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_functional';
    END IF;
    IF NOT "machine_in_hand"(NEW."to_logistical") THEN
      RAISE EXCEPTION 'Machine % is checked only when received and in hand (constraint "MachineStatusChange_functional")', NEW."machine_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_functional';
    END IF;
  END IF;
  UPDATE "Machine" SET
    "logistical_status" = NEW."to_logistical",
    "functional_status" = NEW."to_functional",
    "received_at" = CASE WHEN NEW."from_logistical" IN ('expected', 'missing') AND NEW."to_logistical" = 'in_stock'
                         THEN coalesce("received_at", ts) ELSE "received_at" END,
    "in_hand_since" = CASE WHEN NEW."from_logistical" IN ('expected', 'missing', 'returned', 'lost', 'scrapped') AND NEW."to_logistical" = 'in_stock'
                           THEN ts ELSE "in_hand_since" END,
    "shipped_at" = CASE WHEN NEW."to_logistical" = 'in_transit' AND NEW."from_logistical" <> 'in_transit'
                        THEN ts ELSE "shipped_at" END,
    "delivered_at" = CASE WHEN NEW."to_logistical" = 'delivered' AND NEW."from_logistical" <> 'delivered'
                          THEN ts ELSE "delivered_at" END
  WHERE "id" = NEW."machine_id";
  -- Dates de l'envoi, posées par la base (Shipment_guard)
  IF NEW."to_logistical" = 'in_transit' AND NEW."from_logistical" <> 'in_transit' THEN
    INSERT INTO "Shipment" ("order_id") VALUES (oid) ON CONFLICT ("order_id") DO NOTHING;
    UPDATE "Shipment" SET "shipped_at" = ts WHERE "order_id" = oid AND "shipped_at" IS NULL;
  ELSIF NEW."to_logistical" IN ('delivered', 'lost', 'returned') AND NEW."from_logistical" <> NEW."to_logistical" AND oid IS NOT NULL THEN
    UPDATE "Shipment" SET "delivered_at" = ts
    WHERE "order_id" = oid AND "shipped_at" IS NOT NULL AND "delivered_at" IS NULL
      AND EXISTS (SELECT 1 FROM "OrderLine" l JOIN "Machine" x ON x."id" = l."machine_id"
                  WHERE l."order_id" = oid AND l."refund_id" IS NULL AND x."logistical_status" = 'delivered')
      AND NOT EXISTS (SELECT 1 FROM "OrderLine" l JOIN "Machine" x ON x."id" = l."machine_id"
                      WHERE l."order_id" = oid AND l."refund_id" IS NULL
                        AND x."logistical_status" IN ('expected', 'missing', 'in_stock', 'in_preparation', 'ready', 'in_transit'));
  END IF;
  NEW."created_at" := ts;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MachineStatusChange_apply"
  BEFORE INSERT ON "MachineStatusChange"
  FOR EACH ROW EXECUTE FUNCTION "MachineStatusChange_apply"();

-- ─── Hashboards et cohérence du contrôle ───

-- Saisie d'une hashboard : index du modèle, machine en main, lot d'appartenance non annulé (verrous : machine,
-- lot), jamais supprimée, machine et index immuables. Auteur obligatoire (colonne NOT NULL), date posée par la base.
CREATE FUNCTION "HashboardStatus_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m "Machine"%ROWTYPE;
  qtt integer;
  bst "batch_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HashboardStatus is never deleted (constraint "HashboardStatus_no_delete")'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'HashboardStatus_no_delete';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."machine_id", NEW."index") IS DISTINCT FROM (OLD."id", OLD."machine_id", OLD."index") THEN
    RAISE EXCEPTION 'HashboardStatus keeps its machine and index (constraint "HashboardStatus_immutable")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'HashboardStatus_immutable';
  END IF;
  SELECT * INTO m FROM "Machine" WHERE "id" = NEW."machine_id" FOR NO KEY UPDATE;
  SELECT "hashboard_qtt" INTO qtt FROM "Model" WHERE "id" = m."model_id";
  IF NEW."index" >= qtt THEN
    RAISE EXCEPTION 'Hashboard index % out of range: the model has % hashboards (constraint "HashboardStatus_index_range")', NEW."index", qtt
      USING ERRCODE = 'check_violation', CONSTRAINT = 'HashboardStatus_index_range';
  END IF;
  PERFORM "Batch_lock"(m."batch_id");
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = m."batch_id";
  IF NOT "machine_in_hand"(m."logistical_status") OR bst = 'cancelled' THEN
    RAISE EXCEPTION 'Machine % is checked only when received and in hand, batch not cancelled (constraint "HashboardStatus_machine_in_hand")', m."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'HashboardStatus_machine_in_hand';
  END IF;
  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "HashboardStatus_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "HashboardStatus"
  FOR EACH ROW EXECUTE FUNCTION "HashboardStatus_guard"();

-- Cohérence (au COMMIT, l'état fonctionnel et les hashboards se saisissent ensemble) :
--   ok       => chaque hashboard du modèle (0 à hashboard_qtt − 1) est contrôlée ok ;
--   une hashboard degraded ou dead => machine degraded ou faulty (« hashboard défectueuse marquée telle quelle »).
CREATE FUNCTION "machine_check_hashboards"(mid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  fs "machine_functional_status";
  qtt integer;
BEGIN
  SELECT m."functional_status", mo."hashboard_qtt" INTO fs, qtt
  FROM "Machine" m JOIN "Model" mo ON mo."id" = m."model_id" WHERE m."id" = mid;
  IF NOT FOUND THEN RETURN; END IF;
  IF fs = 'ok' AND (SELECT count(*) FROM "HashboardStatus" WHERE "machine_id" = mid AND "status" = 'ok') <> qtt THEN
    RAISE EXCEPTION 'Machine % is ok only when its % hashboards are checked ok (constraint "Machine_hashboards")', mid, qtt
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_hashboards';
  END IF;
  IF fs NOT IN ('degraded', 'faulty') AND EXISTS (
    SELECT 1 FROM "HashboardStatus" WHERE "machine_id" = mid AND "status" IN ('degraded', 'dead')
  ) THEN
    RAISE EXCEPTION 'Machine % has a defective hashboard: it is degraded or faulty (constraint "Machine_hashboards")', mid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_hashboards';
  END IF;
END;
$$;

CREATE FUNCTION "trg_check_machine_hashboards"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Machine' THEN
    PERFORM "machine_check_hashboards"(NEW."id");
  ELSE
    PERFORM "machine_check_hashboards"(NEW."machine_id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Machine_hashboards" AFTER UPDATE OF "functional_status" ON "Machine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_machine_hashboards"();

CREATE CONSTRAINT TRIGGER "HashboardStatus_machine_hashboards" AFTER INSERT OR UPDATE OF "status" ON "HashboardStatus"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_machine_hashboards"();

-- ─── Modèle et lot figés par leurs machines ───

-- Nombre de hashboards figé dès qu'une machine du modèle existe (index des hashboards contrôlées).
CREATE FUNCTION "Model_guard_hashboard_qtt"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."hashboard_qtt" IS DISTINCT FROM OLD."hashboard_qtt"
     AND EXISTS (SELECT 1 FROM "Machine" WHERE "model_id" = OLD."id") THEN
    RAISE EXCEPTION 'Model % has machines: its hashboard count is frozen (constraint "Model_hashboard_qtt_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Model_hashboard_qtt_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Model_guard_hashboard_qtt"
  BEFORE UPDATE OF "hashboard_qtt" ON "Model"
  FOR EACH ROW EXECUTE FUNCTION "Model_guard_hashboard_qtt"();

-- Quantité figée dès qu'une machine vient de la palette (le domaine la fige dès l'Attente de réception).
CREATE FUNCTION "Batch_guard_quantity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."quantity" IS DISTINCT FROM OLD."quantity"
     AND EXISTS (SELECT 1 FROM "Machine" WHERE "origin_batch_id" = OLD."id") THEN
    RAISE EXCEPTION 'Batch % has machines: its quantity is frozen (constraint "Batch_quantity_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Batch_quantity_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Batch_guard_quantity"
  BEFORE UPDATE OF "quantity" ON "Batch"
  FOR EACH ROW EXECUTE FUNCTION "Batch_guard_quantity"();

-- ─── Réassort du lot de stock (StockRestock, journal en ajout seul) ───

-- Un réassort alimente le lot de stock de son modèle (StockRestock_stock_batch) ; date posée par la base.
CREATE FUNCTION "StockRestock_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Batch" WHERE "id" = NEW."batch_id" AND "kind" = 'stock') THEN
    RAISE EXCEPTION 'A restock feeds a stock batch, not batch % (constraint "StockRestock_stock_batch")', NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'StockRestock_stock_batch';
  END IF;
  NEW."created_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "StockRestock_guard"
  BEFORE INSERT ON "StockRestock"
  FOR EACH ROW EXECUTE FUNCTION "StockRestock_guard"();

-- Le réassort crée ses machines attendues dans le lot de stock (après l'insertion : clé étrangère vers le réassort) ;
-- elles passent ensuite par la réception et le contrôle habituels avant d'être vendables (machine_sellable).
CREATE FUNCTION "StockRestock_generate_machines"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "Machine" ("model_id", "batch_id", "restock_id")
  SELECT NEW."model_id", NEW."batch_id", NEW."id" FROM generate_series(1, NEW."quantity");
  RETURN NULL;
END;
$$;

CREATE TRIGGER "StockRestock_generate_machines"
  AFTER INSERT ON "StockRestock"
  FOR EACH ROW EXECUTE FUNCTION "StockRestock_generate_machines"();

CREATE TRIGGER "StockRestock_append_only"
  BEFORE UPDATE OR DELETE ON "StockRestock"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

-- ─── Transfert d'une palette vers le lot de stock (MachineTransfer, journal en ajout seul) ───

-- Seul moyen de changer Machine.batch_id. Sous verrou de la machine, vérifie :
--   * from_batch_id est l'appartenance courante (MachineTransfer_current) ;
--   * sens unique : d'une palette vers le lot de stock du même modèle (MachineTransfer_direction) ;
--   * la machine n'est la machine d'aucune ligne non remboursée, avant comme après la clôture
--     (MachineTransfer_assigned) ;
--   * elle est en main ou retournée (MachineTransfer_machine_in_hand) : ni attendue, ni manquante, ni perdue, ni
--     partie, ni au rebut (historique de la palette) ;
--   * motif batch_closed : posé par la clôture de la palette (palette close, MachineTransfer_reason) ;
-- puis écrit Machine.batch_id (trigger imbriqué : Machine_guard le permet ; palette annulée : Machine_batch_frozen).
-- Les deux lots sont contrôlés au COMMIT (MachineTransfer_stock, Machine_stock) : un transfert avant la clôture
-- n'est permis que si la palette garde de quoi servir ses commandes (batch_capacity).
CREATE FUNCTION "MachineTransfer_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m "Machine"%ROWTYPE;
  f "Batch"%ROWTYPE;
BEGIN
  SELECT * INTO m FROM "Machine" WHERE "id" = NEW."machine_id" FOR NO KEY UPDATE;
  IF m."batch_id" IS DISTINCT FROM NEW."from_batch_id" THEN
    RAISE EXCEPTION 'Machine % belongs to batch %, not % (constraint "MachineTransfer_current")', NEW."machine_id", m."batch_id", NEW."from_batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineTransfer_current';
  END IF;
  SELECT * INTO f FROM "Batch" WHERE "id" = NEW."from_batch_id";
  IF f."kind" <> 'wholesale' OR NOT EXISTS (
    SELECT 1 FROM "Batch" WHERE "id" = NEW."to_batch_id" AND "kind" = 'stock' AND "model_id" = m."model_id"
  ) THEN
    RAISE EXCEPTION 'A machine is transferred only from a palette to the stock batch of its model (constraint "MachineTransfer_direction")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineTransfer_direction';
  END IF;
  IF EXISTS (SELECT 1 FROM "OrderLine" WHERE "machine_id" = m."id" AND "refund_id" IS NULL) THEN
    RAISE EXCEPTION 'Machine % is the machine of an active order line: it stays in its batch (constraint "MachineTransfer_assigned")', m."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineTransfer_assigned';
  END IF;
  IF NOT ("machine_in_hand"(m."logistical_status") OR m."logistical_status" = 'returned') THEN
    RAISE EXCEPTION 'Machine % is %: only a machine in hand or returned is transferred (constraint "MachineTransfer_machine_in_hand")', m."id", m."logistical_status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineTransfer_machine_in_hand';
  END IF;
  IF NEW."reason" = 'batch_closed' AND f."status" <> 'closed' THEN
    RAISE EXCEPTION 'Reason batch_closed is given by the closing of the palette (constraint "MachineTransfer_reason")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineTransfer_reason';
  END IF;
  UPDATE "Machine" SET "batch_id" = NEW."to_batch_id" WHERE "id" = m."id";
  NEW."created_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MachineTransfer_apply"
  BEFORE INSERT ON "MachineTransfer"
  FOR EACH ROW EXECUTE FUNCTION "MachineTransfer_apply"();

CREATE TRIGGER "MachineTransfer_append_only"
  BEFORE UPDATE OR DELETE ON "MachineTransfer"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

-- ─── Transition du lot : effets sur les machines (triggers 5 et 6, voir le fichier batches) ───

-- 5. Entrée en Attente de réception (le statut est déjà écrit) : une machine attendue par place de la palette, née
-- dans la palette. Rien de plus après un retour arrière inspection → awaiting_reception : on ne crée que ce qui
-- manque (batch_born_machines).
CREATE FUNCTION "BatchStatusTransition_generate_machines"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."to_status" = 'awaiting_reception' THEN
    INSERT INTO "Machine" ("model_id", "batch_id", "origin_batch_id")
    SELECT b."model_id", b."id", b."id"
    FROM "Batch" b
    CROSS JOIN LATERAL generate_series(1, b."quantity" - "batch_born_machines"(b."id"))
    WHERE b."id" = NEW."batch_id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BatchStatusTransition_5_generate_machines"
  BEFORE INSERT ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "BatchStatusTransition_generate_machines"();

-- 1b. Sortie du Contrôle d'une palette (décision de Hugo, 2026-11-16 ; verrou du lot déjà pris par le trigger 1, qui a
-- vérifié le couple autorisé) :
--   * inspection → tuning ou packaging, refusée tant que (dans cet ordre) : une machine du lot est encore attendue (ni
--     reçue ni manquante : BatchStatusTransition_inspection_expected) ; une commande payée est en trop
--     (batch_surplus_lines : BatchStatusTransition_inspection_surplus) ; une ligne payée a une machine à remplacer
--     (faulty ou perdue : BatchStatusTransition_inspection_replace) ;
--   * toute transition vers packaging, refusée tant qu'une ligne payée n'a pas de machine
--     (BatchStatusTransition_packaging_unassigned).
-- Les machines libres (non attribuées) ne bloquent jamais : elles partent au stock (clôture ou transfert). Nommé 1b :
-- il passe après le trigger 1 et avant l'écriture du statut (4).
CREATE FUNCTION "BatchStatusTransition_inspection_exit"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."from_status" = 'inspection' AND NEW."to_status" IN ('tuning', 'packaging') THEN
    IF EXISTS (SELECT 1 FROM "Machine" m WHERE m."batch_id" = NEW."batch_id" AND m."logistical_status" = 'expected') THEN
      RAISE EXCEPTION 'Batch % still has expected machines: mark them received or missing first (constraint "BatchStatusTransition_inspection_expected")', NEW."batch_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_inspection_expected';
    END IF;
    IF EXISTS (SELECT 1 FROM "batch_surplus_lines"(NEW."batch_id")) THEN
      RAISE EXCEPTION 'Batch % has paid orders beyond its usable machines: refund them first (constraint "BatchStatusTransition_inspection_surplus")', NEW."batch_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_inspection_surplus';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "batch_active_lines"(NEW."batch_id") a JOIN "Machine" m ON m."id" = a."machine_id"
      WHERE m."functional_status" = 'faulty' OR m."logistical_status" = 'lost'
    ) THEN
      RAISE EXCEPTION 'Batch % has paid lines whose machine is dead or lost: replace it first (constraint "BatchStatusTransition_inspection_replace")', NEW."batch_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_inspection_replace';
    END IF;
  END IF;
  IF NEW."to_status" = 'packaging' AND EXISTS (
    SELECT 1 FROM "batch_active_lines"(NEW."batch_id") a WHERE a."machine_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Batch % has paid lines without a machine: assign them first (constraint "BatchStatusTransition_packaging_unassigned")', NEW."batch_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'BatchStatusTransition_packaging_unassigned';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BatchStatusTransition_1b_inspection_exit"
  BEFORE INSERT ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "BatchStatusTransition_inspection_exit"();

-- Lot de stock d'un modèle, créé en pause (draft, « Stock {modèle} », création journalisée au nom de l'acteur avec
-- la note donnée) s'il n'existe pas encore. Seule définition de la règle : la clôture d'une palette (trigger 6
-- ci-dessous) et le transfert d'invendus par le domaine (src/server/batches.ts, stockBatchOf) l'appellent.
-- Création concurrente : l'index unique Batch_one_stock_per_model départage (ON CONFLICT), le perdant relit le lot
-- créé (nouvel instantané par instruction, READ COMMITTED).
CREATE FUNCTION "stock_batch_of"(model uuid, actor bigint, note text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  s uuid;
BEGIN
  INSERT INTO "Batch" ("name", "model_id", "kind")
  SELECT 'Stock ' || mo."name", mo."id", 'stock' FROM "Model" mo WHERE mo."id" = model
  ON CONFLICT ("model_id") WHERE "kind" = 'stock' DO NOTHING
  RETURNING "id" INTO s;
  IF s IS NOT NULL THEN
    INSERT INTO "BatchStatusTransition" ("batch_id", "from_status", "to_status", "changed_by_auth_user_id", "note")
    VALUES (s, NULL, 'draft', actor, note);
    RETURN s;
  END IF;
  SELECT "id" INTO STRICT s FROM "Batch" WHERE "model_id" = model AND "kind" = 'stock';
  RETURN s;
END;
$$;

-- Machine invendue : en main ou retournée, et machine d'aucune ligne non remboursée. Seule définition : la clôture
-- d'une palette (trigger 6) la transfère au stock, la vue batch_machine_summary la compte (colonne unsold, annoncée
-- par le domaine avant la clôture).
CREATE FUNCTION "machine_unsold"(m "Machine") RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT ("machine_in_hand"(m."logistical_status") OR m."logistical_status" = 'returned')
     AND NOT EXISTS (SELECT 1 FROM "OrderLine" l WHERE l."machine_id" = m."id" AND l."refund_id" IS NULL)
$$;

-- 6. Clôture d'une palette (le statut est déjà écrit) : chaque machine invendue (machine_unsold) part au lot de
-- stock du modèle (MachineTransfer, motif batch_closed) ; aucune
-- machine n'est recréée. Le lot de stock est créé en pause s'il n'existe pas (stock_batch_of). Les machines
-- attendues, manquantes, perdues, au rebut, livrées ou d'une ligne active restent dans la palette (historique).
CREATE FUNCTION "BatchStatusTransition_close_to_stock"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b "Batch"%ROWTYPE;
  s uuid;
BEGIN
  IF NEW."to_status" <> 'closed' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO b FROM "Batch" WHERE "id" = NEW."batch_id";
  IF NOT EXISTS (SELECT 1 FROM "Machine" m WHERE m."batch_id" = b."id" AND "machine_unsold"(m)) THEN
    RETURN NEW;
  END IF;
  s := "stock_batch_of"(b."model_id", NEW."changed_by_auth_user_id", 'Créé à la clôture du lot ' || b."name");
  INSERT INTO "MachineTransfer" ("machine_id", "from_batch_id", "to_batch_id", "reason", "changed_by_auth_user_id")
  SELECT m."id", b."id", s, 'batch_closed', NEW."changed_by_auth_user_id"
  FROM "Machine" m
  WHERE m."batch_id" = b."id" AND "machine_unsold"(m)
  ORDER BY m."id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BatchStatusTransition_6_close_to_stock"
  BEFORE INSERT ON "BatchStatusTransition"
  FOR EACH ROW EXECUTE FUNCTION "BatchStatusTransition_close_to_stock"();

-- ─── Attribution ───

-- Attribution, remplacement, retrait (journal OrderLineAssignment). Verrous : ligne, machines (ancienne et
-- nouvelle, par id), lot. Conditions :
--   ligne active d'une facture payée (OrderLineAssignment_active_line) ; changement réel (OrderLineAssignment_changed) ;
--   palette au Contrôle, Tuning, Packaging ou En transit (OrderLineAssignment_batch_status, règle du flux grossiste) ;
--   lot de stock : à tout statut (en vente ou en pause : les commandes payées se servent quand même) ;
--   nouvelle machine : appartient au lot de la ligne au moment de l'attribution (OrderLineAssignment_machine_in_batch ;
--   la clé étrangère vers la machine est simple, l'appartenance est revérifiée au COMMIT : OrderLine_machine_in_batch) ;
--   remplacement ou retrait : motif (OrderLineAssignment_reason) ; jamais d'une machine remise au transporteur ou
--   livrée (OrderLineAssignment_shipped) ;
--   nouvelle machine, palette : reçue et en main, CONTRÔLÉE et fonctionnelle, ok ou degraded
--   (OrderLineAssignment_machine_assignable) ; degraded : motif, décision du technicien tracée
--   (OrderLineAssignment_degraded_reason), et acceptation explicite du client de la ligne, avec sa date, jamais dans le
--   futur (OrderLineAssignment_degraded_acceptance) ;
--   nouvelle machine, lot de stock : vendable (machine_sellable : ok, contrôle complet depuis la dernière entrée en
--   main ; jamais degraded) (OrderLineAssignment_machine_assignable).
-- Une machine n'est la machine que d'une ligne non remboursée (index unique partiel existant).
CREATE FUNCTION "OrderLineAssignment_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur uuid;
  active boolean;
  line_user uuid;
  bk "batch_kind";
  bst "batch_status";
  old_m "Machine"%ROWTYPE;
  new_m "Machine"%ROWTYPE;
BEGIN
  SELECT l."machine_id", (l."refund_id" IS NULL AND o."status" = 'paid'), l."user_id" INTO cur, active, line_user
  FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
  WHERE l."id" = NEW."order_line_id"
  FOR NO KEY UPDATE OF l;
  IF NOT coalesce(active, false) THEN
    RAISE EXCEPTION 'Only an active line of a paid order can be assigned a machine (constraint "OrderLineAssignment_active_line")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_active_line';
  END IF;
  IF cur IS NOT DISTINCT FROM NEW."machine_id" THEN
    RAISE EXCEPTION 'Order line % already has this machine (constraint "OrderLineAssignment_changed")', NEW."order_line_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_changed';
  END IF;
  PERFORM 1 FROM "Machine" WHERE "id" IN (cur, NEW."machine_id") ORDER BY "id" FOR NO KEY UPDATE;
  PERFORM "Batch_lock"(NEW."batch_id");
  SELECT "kind", "status" INTO bk, bst FROM "Batch" WHERE "id" = NEW."batch_id";
  IF bk = 'wholesale' AND bst NOT IN ('inspection', 'tuning', 'packaging', 'in_transit') THEN
    RAISE EXCEPTION 'Batch % is %: machines are assigned from inspection to in_transit (constraint "OrderLineAssignment_batch_status")', NEW."batch_id", bst
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_batch_status';
  END IF;
  IF cur IS NOT NULL THEN
    IF NEW."reason" IS NULL THEN
      RAISE EXCEPTION 'Replacing or removing the machine of line % needs a reason (constraint "OrderLineAssignment_reason")', NEW."order_line_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_reason';
    END IF;
    SELECT * INTO old_m FROM "Machine" WHERE "id" = cur;
    IF old_m."logistical_status" IN ('in_transit', 'delivered') THEN
      RAISE EXCEPTION 'Machine % is % : it stays on its line (constraint "OrderLineAssignment_shipped")', cur, old_m."logistical_status"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_shipped';
    END IF;
  END IF;
  IF NEW."machine_id" IS NOT NULL THEN
    SELECT * INTO new_m FROM "Machine" WHERE "id" = NEW."machine_id";
    IF new_m."batch_id" <> NEW."batch_id" THEN
      RAISE EXCEPTION 'Machine % belongs to batch %, not to the batch % of the line (constraint "OrderLineAssignment_machine_in_batch")',
        NEW."machine_id", new_m."batch_id", NEW."batch_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_machine_in_batch';
    END IF;
    IF bk = 'stock' AND NOT "machine_sellable"(new_m) THEN
      RAISE EXCEPTION 'Machine % is not sellable from the stock: in hand, ok and fully checked since it came back in hand (constraint "OrderLineAssignment_machine_assignable")', NEW."machine_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_machine_assignable';
    END IF;
    IF NOT "machine_in_hand"(new_m."logistical_status") OR new_m."functional_status" NOT IN ('ok', 'degraded') THEN
      RAISE EXCEPTION 'Machine % is not assignable: it must be received, in hand, checked and working (constraint "OrderLineAssignment_machine_assignable")', NEW."machine_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_machine_assignable';
    END IF;
    IF new_m."functional_status" = 'degraded' AND NEW."reason" IS NULL THEN
      RAISE EXCEPTION 'Machine % has a defective hashboard: assigning it needs a reason (constraint "OrderLineAssignment_degraded_reason")', NEW."machine_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_degraded_reason';
    END IF;
    -- Acceptation explicite du client : obligatoire pour une machine degraded, donnée par le client de la ligne, pas
    -- dans le futur ; refusée pour une machine qui n'est pas degraded (le journal ne doit pas mentir)
    IF new_m."functional_status" = 'degraded' THEN
      IF NEW."degraded_accepted_by_user_id" IS DISTINCT FROM line_user OR NEW."degraded_accepted_at" IS NULL
         OR NEW."degraded_accepted_at" > clock_timestamp() THEN
        RAISE EXCEPTION 'Machine % has a defective hashboard: assigning it needs the explicit acceptance of the customer of the line, given at the latest now (constraint "OrderLineAssignment_degraded_acceptance")', NEW."machine_id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_degraded_acceptance';
      END IF;
    END IF;
  END IF;
  IF NEW."degraded_accepted_by_user_id" IS NOT NULL AND (NEW."machine_id" IS NULL OR new_m."functional_status" <> 'degraded') THEN
    RAISE EXCEPTION 'Only a degraded machine is assigned with the acceptance of the customer (constraint "OrderLineAssignment_degraded_acceptance")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_degraded_acceptance';
  END IF;
  UPDATE "OrderLine" SET "machine_id" = NEW."machine_id" WHERE "id" = NEW."order_line_id";
  NEW."created_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OrderLineAssignment_apply"
  BEFORE INSERT ON "OrderLineAssignment"
  FOR EACH ROW EXECUTE FUNCTION "OrderLineAssignment_apply"();

-- ─── Surplus et compteurs du lot ───

-- Commandes payées en trop par rapport aux machines utilisables (roadmap, « Machines défectueuses et surplus » :
-- les dernières commandes en trop sont remboursées, paiement le plus récent d'abord ; R4b : jamais une commande déjà
-- servie si une autre peut l'être). Sont « en trop » les lignes actives au-delà des machines utilisables − `extra`
-- (machines que l'on s'apprête à rendre inutilisables, ex. une machine qu'on va marquer faulty) :
--   * palette : quantity − transferts vers le stock − machines inutilisables (batch_unusable_machines : manquantes,
--     au rebut, perdues ou mortes, attribuées ou non) ;
--   * lot de stock : machines vendables libres + machines en vie (ni manquante, ni au rebut, ni perdue, ni faulty)
--     des lignes actives.
-- Ordre de remboursement (le premier renvoyé est remboursé d'abord), paiement le plus récent d'abord (Order.paid_at,
-- puis facture, puis rang dans la facture) dans chacun des deux groupes :
--   1. lignes à servir : sans machine, machine morte (à remplacer), ou machine encore en main dont le remboursement
--      rend la place (palette : toute machine en vie ni en transit ni livrée ; lot de stock : machine vendable,
--      machine_sellable) ;
--   2. lignes servies ou dont la machine ne se revend pas : machine en transit ou livrée, et, sur un lot de stock,
--      machine en vie mais pas vendable (degraded, à recontrôler, retournée). Les rembourser ne rend aucune place
--      (lot de stock) ou rend une place sans machine (palette) : jamais avant une ligne du groupe 1. Les comptes font
--      qu'elles ne sont jamais en trop (le manque d'un lot ne dépasse jamais ses lignes du groupe 1) ; l'ordre reste
--      déterministe si cela arrivait.
-- rank = rang de conservation (1 = servie en premier) : en trop ⇔ rank > machines utilisables − extra ; renvoyées de
-- rank décroissant (ordre de remboursement).
-- frees_place : rembourser la ligne augmente batch_available_stock de 1 (ligne sans machine ; lot de stock : machine
-- vendable ; palette : machine en vie). Une ligne dont la machine est morte est en trop sans libérer de place (la
-- machine morte comptait par sa ligne, elle passe alors en machines sorties) : sur un lot survendu avant le COMMIT
-- (batch_available_stock < 0, machine_shortage), seules les lignes frees_place comblent le manque ; le reste est
-- occupé par des factures en attente (réservations).
-- Les factures en attente (réservations) ne sont pas comptées : ce ne sont pas des commandes payées ; Batch_stock les
-- compte toujours au COMMIT. Source unique de l'ordre pour le domaine ; ne verrouille pas.
CREATE FUNCTION "batch_unusable_machines"(b uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM "Machine" m
  WHERE m."batch_id" = b
    AND (m."logistical_status" IN ('missing', 'scrapped', 'lost') OR m."functional_status" = 'faulty')
$$;

CREATE FUNCTION "batch_surplus_lines"(b uuid, extra integer DEFAULT 0)
RETURNS TABLE ("line_id" uuid, "order_id" uuid, "user_id" uuid, "paid_at" timestamptz, "position" integer,
               "machine_id" uuid, "rank" integer, "frees_place" boolean)
LANGUAGE sql STABLE AS $$
  WITH active AS (
    SELECT l."id", l."order_id", o."user_id", o."paid_at", l."position", l."machine_id",
      coalesce(m."logistical_status" IN ('missing', 'scrapped', 'lost') OR m."functional_status" = 'faulty', false) AS "dead",
      coalesce(m."logistical_status" IN ('in_transit', 'delivered'), false) AS "shipped",
      CASE WHEN m."id" IS NULL THEN true
           WHEN m."logistical_status" IN ('missing', 'scrapped', 'lost') OR m."functional_status" = 'faulty' THEN false
           WHEN ba."kind" = 'stock' THEN "machine_sellable"(m)
           ELSE true END AS "frees_place"
    FROM "OrderLine" l
    JOIN "Order" o ON o."id" = l."order_id"
    JOIN "Batch" ba ON ba."id" = l."batch_id"
    LEFT JOIN "Machine" m ON m."id" = l."machine_id"
    WHERE l."batch_id" = b AND l."refund_id" IS NULL AND o."status" = 'paid'
  ), ranked AS (
    SELECT a.*,
      (row_number() OVER (ORDER BY (a."shipped" OR NOT (a."frees_place" OR a."dead")) DESC,
                                   a."paid_at", a."order_id", a."position"))::integer AS "rank"
    FROM active a)
  SELECT r."id", r."order_id", r."user_id", r."paid_at", r."position", r."machine_id", r."rank", r."frees_place"
  FROM ranked r, "Batch" ba
  WHERE ba."id" = b AND r."rank" > CASE ba."kind"
    WHEN 'wholesale' THEN ba."quantity" - "batch_transferred_out"(b) - "batch_unusable_machines"(b)
    ELSE (SELECT count(*)::integer FROM "Machine" m
          WHERE m."batch_id" = b
            AND CASE WHEN EXISTS (SELECT 1 FROM ranked a WHERE a."machine_id" = m."id")
                     THEN m."logistical_status" NOT IN ('missing', 'scrapped', 'lost') AND m."functional_status" <> 'faulty'
                     ELSE "machine_sellable"(m) END)
  END - coalesce(extra, 0)
  ORDER BY r."rank" DESC
$$;

-- Vue batch_machine_summary : une ligne par lot (0 partout avant l'Attente de réception). Calculée à la lecture.
--   kind, quantity (NULL pour un lot de stock), capacity = batch_capacity, transferred_out = machines sorties vers le
--   stock (palette) ;
--   machines (appartenant au lot aujourd'hui), expected, received (ni expected ni missing), in_hand (machine_in_hand), unchecked (en main, unknown),
--   ok / degraded / faulty (état fonctionnel, toutes machines ; faulty compte aussi les machines au rebut),
--   missing, scrapped, lost, returned, in_preparation, in_transit, delivered ; unsold = machine_unsold (partiraient au
--   stock à la clôture d'une palette), dont unsold_degraded (degraded) ;
--   written_off = batch_written_off ; paid_lines = lignes actives ; assigned_lines (avec machine) ; unassigned_lines ;
--   undelivered_lines = lignes actives sans machine ou dont la machine n'est pas livrée ;
--   lines_to_replace = lignes actives dont la machine est faulty ou lost (à remplacer, ou ligne en trop à rembourser) ;
--   ok_lines / degraded_lines = lignes actives dont la machine est ok / degraded (acceptation du client tracée) :
--   assigned_lines = ok_lines + degraded_lines + lignes dont la machine est faulty ou unknown ; une machine degraded
--   n'est jamais comptée comme ok (audit du jalon 5 bis : free_machines mêle ok et degraded, free_ok_machines,
--   sellable_machines et to_recheck ne comptent que ok) ;
--   free_machines = en main, ok ou degraded, machine d'aucune ligne active ; free_ok_machines = parmi elles, ok ;
--   sellable_machines = vendables (machine_sellable) et machine d'aucune ligne active : « disponibles » d'un lot de
--   stock ; to_recheck = en main et ok mais pas vendables (contrôle à refaire depuis la dernière entrée en main) ;
--   unusable = batch_unusable_machines ; surplus_lines = lignes payées au-delà des machines utilisables
--   (batch_surplus_lines) : non nul seulement quand une machine morte ou perdue est encore la machine d'une ligne
--   (Batch_stock refuse le COMMIT dans les autres cas) ; à résoudre par remplacement et remboursement.
CREATE VIEW "batch_machine_summary" AS
WITH active AS NOT MATERIALIZED (
  SELECT l."batch_id", l."id", l."machine_id"
  FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
  WHERE l."refund_id" IS NULL AND o."status" = 'paid')
SELECT
  b."id" AS "batch_id",
  b."status" AS "batch_status",
  b."kind",
  b."quantity",
  "batch_capacity"(b."id") AS "capacity",
  "batch_transferred_out"(b."id") AS "transferred_out",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id")::integer AS "machines",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'expected')::integer AS "expected",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" NOT IN ('expected', 'missing'))::integer AS "received",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND "machine_in_hand"(m."logistical_status"))::integer AS "in_hand",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND "machine_in_hand"(m."logistical_status")
     AND m."functional_status" = 'unknown')::integer AS "unchecked",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."functional_status" = 'ok')::integer AS "ok",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."functional_status" = 'degraded')::integer AS "degraded",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."functional_status" = 'faulty')::integer AS "faulty",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'missing')::integer AS "missing",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'scrapped')::integer AS "scrapped",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'lost')::integer AS "lost",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'returned')::integer AS "returned",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'in_preparation')::integer AS "in_preparation",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'in_transit')::integer AS "in_transit",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'delivered')::integer AS "delivered",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND "machine_unsold"(m))::integer AS "unsold",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND "machine_unsold"(m)
     AND m."functional_status" = 'degraded')::integer AS "unsold_degraded",
  "batch_written_off"(b."id") AS "written_off",
  "batch_unusable_machines"(b."id") AS "unusable",
  (SELECT count(*) FROM active a WHERE a."batch_id" = b."id")::integer AS "paid_lines",
  (SELECT count(*) FROM active a WHERE a."batch_id" = b."id" AND a."machine_id" IS NOT NULL)::integer AS "assigned_lines",
  (SELECT count(*) FROM active a WHERE a."batch_id" = b."id" AND a."machine_id" IS NULL)::integer AS "unassigned_lines",
  (SELECT count(*) FROM active a JOIN "Machine" m ON m."id" = a."machine_id"
     WHERE a."batch_id" = b."id" AND m."functional_status" = 'ok')::integer AS "ok_lines",
  (SELECT count(*) FROM active a LEFT JOIN "Machine" m ON m."id" = a."machine_id"
     WHERE a."batch_id" = b."id" AND (m."id" IS NULL OR m."logistical_status" <> 'delivered'))::integer AS "undelivered_lines",
  (SELECT count(*) FROM active a JOIN "Machine" m ON m."id" = a."machine_id"
     WHERE a."batch_id" = b."id" AND (m."functional_status" = 'faulty' OR m."logistical_status" = 'lost'))::integer AS "lines_to_replace",
  (SELECT count(*) FROM active a JOIN "Machine" m ON m."id" = a."machine_id"
     WHERE a."batch_id" = b."id" AND m."functional_status" = 'degraded')::integer AS "degraded_lines",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND "machine_in_hand"(m."logistical_status")
     AND m."functional_status" IN ('ok', 'degraded')
     AND NOT EXISTS (SELECT 1 FROM active a WHERE a."machine_id" = m."id"))::integer AS "free_machines",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND "machine_in_hand"(m."logistical_status")
     AND m."functional_status" = 'ok'
     AND NOT EXISTS (SELECT 1 FROM active a WHERE a."machine_id" = m."id"))::integer AS "free_ok_machines",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND "machine_sellable"(m)
     AND NOT EXISTS (SELECT 1 FROM active a WHERE a."machine_id" = m."id"))::integer AS "sellable_machines",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND "machine_in_hand"(m."logistical_status")
     AND m."functional_status" = 'ok' AND NOT "machine_sellable"(m))::integer AS "to_recheck",
  (SELECT count(*) FROM "batch_surplus_lines"(b."id"))::integer AS "surplus_lines"
FROM "Batch" b;

-- Vue model_stock_summary : stock par modèle (écran « Stock »), une ligne par modèle qui a un lot de stock ou des
-- machines. Colonnes du lot de stock du modèle (0 s'il n'existe pas), lues dans batch_machine_summary et
-- batch_available_stock (sources uniques) :
--   expected (à recevoir), to_check (en main, jamais contrôlées ou à recontrôler depuis leur retour en main),
--   sellable (vendables, d'aucune ligne active), available (batch_available_stock : vendables ni vendues ni réservées),
--   reserved = sellable − available (retenues par une commande payée sans machine ou une facture en attente),
--   assigned (en main, machine d'une ligne active : à expédier), degraded (en main, degraded, d'aucune ligne active :
--   jamais vendables depuis le stock), faulty (en main, faulty : à mettre au rebut) ;
-- in_palettes : machines invendues (machine_unsold) des palettes du modèle non annulées (transférables au stock), dont
-- in_palettes_degraded (degraded) ; assigned_degraded : parmi assigned, les machines degraded (corrigées ok → degraded
-- après l'attribution : un lot de stock n'attribue jamais une machine degraded).
CREATE VIEW "model_stock_summary" AS
SELECT
  mo."id" AS "model_id",
  s."id" AS "stock_batch_id",
  s."status" AS "stock_batch_status",
  coalesce(ms."expected", 0) AS "expected",
  coalesce(ms."unchecked" + ms."to_recheck", 0) AS "to_check",
  coalesce(ms."sellable_machines", 0) AS "sellable",
  coalesce(av."available", 0) AS "available",
  coalesce(ms."sellable_machines" - av."available", 0) AS "reserved",
  (SELECT count(*) FROM "Machine" m
    WHERE m."batch_id" = s."id" AND "machine_in_hand"(m."logistical_status")
      AND EXISTS (SELECT 1 FROM "batch_active_lines"(s."id") a WHERE a."machine_id" = m."id"))::integer AS "assigned",
  (SELECT count(*) FROM "Machine" m
    WHERE m."batch_id" = s."id" AND "machine_in_hand"(m."logistical_status") AND m."functional_status" = 'degraded'
      AND EXISTS (SELECT 1 FROM "batch_active_lines"(s."id") a WHERE a."machine_id" = m."id"))::integer AS "assigned_degraded",
  (SELECT count(*) FROM "Machine" m
    WHERE m."batch_id" = s."id" AND "machine_in_hand"(m."logistical_status") AND m."functional_status" = 'degraded'
      AND NOT EXISTS (SELECT 1 FROM "batch_active_lines"(s."id") a WHERE a."machine_id" = m."id"))::integer AS "degraded",
  (SELECT count(*) FROM "Machine" m
    WHERE m."batch_id" = s."id" AND "machine_in_hand"(m."logistical_status") AND m."functional_status" = 'faulty')::integer AS "faulty",
  (SELECT count(*) FROM "Machine" m JOIN "Batch" p ON p."id" = m."batch_id"
    WHERE m."model_id" = mo."id" AND p."kind" = 'wholesale' AND p."status" <> 'cancelled' AND "machine_unsold"(m))::integer AS "in_palettes",
  (SELECT count(*) FROM "Machine" m JOIN "Batch" p ON p."id" = m."batch_id"
    WHERE m."model_id" = mo."id" AND p."kind" = 'wholesale' AND p."status" <> 'cancelled' AND "machine_unsold"(m)
      AND m."functional_status" = 'degraded')::integer AS "in_palettes_degraded"
FROM "Model" mo
LEFT JOIN "Batch" s ON s."model_id" = mo."id" AND s."kind" = 'stock'
LEFT JOIN "batch_machine_summary" ms ON ms."batch_id" = s."id"
LEFT JOIN LATERAL (SELECT "batch_available_stock"(s."id") AS "available") av ON true
WHERE s."id" IS NOT NULL OR EXISTS (SELECT 1 FROM "Machine" m WHERE m."model_id" = mo."id");

-- Journaux d'attribution et de statuts : en ajout seul (réassorts et transferts : plus haut).
CREATE TRIGGER "OrderLineAssignment_append_only"
  BEFORE UPDATE OR DELETE ON "OrderLineAssignment"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

CREATE TRIGGER "MachineStatusChange_append_only"
  BEFORE UPDATE OR DELETE ON "MachineStatusChange"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();
