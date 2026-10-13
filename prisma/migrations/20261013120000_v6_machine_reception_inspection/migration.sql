-- ═════════════════════════════════════════════
-- v6 : jalon 5, réception des machines, contrôle, attribution (2026-10-13).
-- Sources : specs.md (« Confirmer la réception d'un lot », « Passer en phase de packaging »), rules.md (jalon 5 :
-- génération des machines du lot, numéros de série, état fonctionnel, état des hashboards, attribution), roadmap
-- (« Machines défectueuses et surplus », « Workflow »), revue logistique du 2026-10-06 (§5.2, transitions M1 à M15).
--
--   1. Génération des machines : à l'entrée en « Attente de réception » (seul chemin vers le Contrôle), la
--      transition du lot crée une machine `expected` par place du lot (Batch.quantity), sans doublon après un
--      retour arrière. Ensuite le nombre de machines d'un lot ne dépasse jamais sa quantité (Machine_batch_quantity)
--      et la quantité ne change plus (Batch_quantity_frozen ; le domaine la figeait déjà dès l'Attente de réception).
--   2. Statuts d'une machine : ils ne changent QUE par l'insertion d'une ligne du journal append-only
--      MachineStatusChange (qui, quand, de quoi vers quoi, motif), comme BatchStatusTransition pour le lot. La base
--      vérifie le statut courant (from_*), le couple autorisé (machine_transition_allowed), le statut du lot, et pose
--      elle-même les dates (received_at, shipped_at, delivered_at : horloge de la base).
--   3. Contrôle : état fonctionnel saisi seulement sur une machine reçue et en main, lot au Contrôle ou après ;
--      jamais de retour à `unknown` ; correction (ok ↔ degraded ↔ faulty) avec motif. Cohérence avec les
--      hashboards (Machine_hashboards, différé) : `ok` = toutes les hashboards du modèle contrôlées `ok` ; une
--      hashboard `degraded` ou `dead` => machine `degraded` ou `faulty`. Hashboard : index < Model.hashboard_qtt,
--      jamais supprimée, auteur et date de la dernière saisie.
--   4. Machine morte (faulty) : retirée du stock dès qu'elle est marquée (batch_written_off, tant qu'elle n'est pas
--      la machine d'une ligne active), jamais préparée ni expédiée (CHECK existant), mise au rebut (`scrapped`)
--      seulement si faulty (Machine_scrapped_faulty), terminal. Conséquence : quand une machine meurt sur un lot
--      plein, le COMMIT est refusé (Batch_stock) tant que la ligne en trop n'est pas remboursée dans la même
--      transaction. La base garantit donc « jamais plus de commandes payées que de machines utilisables » ; l'ordre
--      (paiement le plus récent d'abord) est donné par la fonction batch_surplus_lines (source unique du domaine).
--   5. Attribution (OrderLineAssignment_apply redéfini) : machine reçue, en main, CONTRÔLÉE et fonctionnelle (ok,
--      ou degraded avec motif : décision du technicien tracée) ; lot au Contrôle, Tuning, Packaging ou En transit ;
--      remplacement ou retrait avec motif ; jamais pour une machine remise au transporteur ou livrée. Verrous :
--      ligne, puis machines (par id), puis lot.
--   6. Machine jamais supprimée (Machine_no_delete) ; lot clos ou annulé : machines figées (Machine_batch_frozen).
--   7. Vue batch_machine_summary (compteurs du lot pour le backoffice et les conditions de transition).
-- Ordre des verrous (inchangé, complété) : facture(s) → ligne(s) → machine(s) → lot. Les triggers de cette migration
-- prennent la machine puis le lot (Batch_lock) ; une opération qui touche aussi des factures (remboursement du
-- surplus) les verrouille AVANT de toucher une machine.
-- Données touchées à l'application : génération des machines manquantes des lots déjà en Attente de réception à En
-- transit (aucune sur une base neuve). Rien n'est supprimé ni réécrit. La migration refuse de s'appliquer si des
-- hashboards existent déjà (aucune route ne les écrivait : leur auteur serait inconnu).
-- Retour arrière (dans l'esprit) : reposer BatchStatusTransition_apply de v5l, OrderLineAssignment_apply et
-- batch_written_off d'init, le trigger Machine_stock d'init ; DROP des triggers, fonctions, CHECK et de la vue créés
-- ici. Garder la table MachineStatusChange et les colonnes ajoutées (elles portent l'historique) ; les machines
-- générées restent (elles sont `expected`, sans effet sur le stock).
-- ═════════════════════════════════════════════

-- ─── Colonnes et table ─────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "HashboardStatus") THEN
    RAISE EXCEPTION 'v6: HashboardStatus already has rows whose author is unknown; set checked_by_auth_user_id by hand before migrating';
  END IF;
END;
$$;

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp();

-- AlterTable
ALTER TABLE "HashboardStatus" ADD COLUMN "checked_by_auth_user_id" BIGINT NOT NULL,
ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp();

-- CreateTable
CREATE TABLE "MachineStatusChange" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "from_logistical" "machine_logistical_status" NOT NULL,
    "to_logistical" "machine_logistical_status" NOT NULL,
    "from_functional" "machine_functional_status" NOT NULL,
    "to_functional" "machine_functional_status" NOT NULL,
    "note" TEXT,
    "changed_by_auth_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "MachineStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MachineStatusChange_machine_id_created_at_idx" ON "MachineStatusChange"("machine_id", "created_at");

-- CreateIndex
CREATE INDEX "MachineStatusChange_batch_id_created_at_idx" ON "MachineStatusChange"("batch_id", "created_at");

-- AddForeignKey
ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_machine_id_batch_id_fkey" FOREIGN KEY ("machine_id", "batch_id") REFERENCES "Machine"("id", "batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Raw SQL ─────────────

-- Machine dans les mains de la boutique (ni attendue, ni manquante, ni partie, ni au rebut) : seul état où l'on
-- contrôle, monte, attribue.
CREATE FUNCTION "machine_in_hand"(s "machine_logistical_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT s IN ('in_stock', 'in_preparation', 'ready')
$$;

-- Transitions logistiques autorisées (revue logistique §5.2). Un même statut (f = t) n'est pas une transition :
-- une ligne du journal qui ne change que l'état fonctionnel garde le statut logistique.
--   M1 expected → in_stock (reçue)            M2 expected → missing (jamais reçue, motif)
--   M3 missing → in_stock (retrouvée, motif)  M4 in_stock → in_preparation (montage)
--   M5 in_stock → ready                       M6 in_preparation → ready
--   M7 in_preparation → in_stock (motif)      M8 in_stock → scrapped (morte, motif ; faulty exigé)
--   M9 ready → in_transit (lot en Packaging ou En transit)
--   M10 in_transit → delivered                M11 in_transit → lost (motif)
--   M12 in_transit → returned (motif)         M13 returned → in_stock (motif, à recontrôler)
--   M14 ready → in_stock (motif)              M15 lost → in_stock (retrouvée, motif)
-- Terminaux : delivered, scrapped. Aucun retour vers expected.
CREATE FUNCTION "machine_transition_allowed"(f "machine_logistical_status", t "machine_logistical_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT f = t OR (f::text || '>' || t::text) IN (
    'expected>in_stock', 'expected>missing', 'missing>in_stock',
    'in_stock>in_preparation', 'in_stock>ready', 'in_stock>scrapped',
    'in_preparation>ready', 'in_preparation>in_stock',
    'ready>in_transit', 'ready>in_stock',
    'in_transit>delivered', 'in_transit>lost', 'in_transit>returned',
    'returned>in_stock', 'lost>in_stock')
$$;

-- Motif obligatoire : sortie du flux (manquante, au rebut, perdue, retournée), retour arrière, et correction d'un
-- état fonctionnel déjà saisi (ok ↔ degraded ↔ faulty).
CREATE FUNCTION "machine_change_needs_note"(
  fl "machine_logistical_status", tl "machine_logistical_status",
  ff "machine_functional_status", tf "machine_functional_status") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (fl <> tl AND (tl IN ('missing', 'scrapped', 'lost', 'returned')
                        OR (fl::text || '>' || tl::text) IN (
                          'missing>in_stock', 'in_preparation>in_stock', 'ready>in_stock',
                          'returned>in_stock', 'lost>in_stock')))
      OR (ff <> 'unknown' AND tf <> ff)
$$;

ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_changed_by_check" CHECK ("changed_by_auth_user_id" > 0);
ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_note_check" CHECK (btrim("note") <> '');
ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_changed_check"
  CHECK (("from_logistical", "from_functional") IS DISTINCT FROM ("to_logistical", "to_functional"));
ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_allowed_check"
  CHECK ("machine_transition_allowed"("from_logistical", "to_logistical"));
ALTER TABLE "MachineStatusChange" ADD CONSTRAINT "MachineStatusChange_note_required_check"
  CHECK ("note" IS NOT NULL
         OR NOT "machine_change_needs_note"("from_logistical", "to_logistical", "from_functional", "to_functional"));

-- Machine : un état fonctionnel saisi suppose une machine reçue ; une machine au rebut est morte.
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_checked_received_check"
  CHECK ("functional_status" = 'unknown' OR "logistical_status" NOT IN ('expected', 'missing'));
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_scrapped_faulty_check"
  CHECK ("logistical_status" <> 'scrapped' OR "functional_status" = 'faulty');
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_psu_serial_check" CHECK (btrim("psu_serial") <> '');

-- Hashboard : une ligne = une hashboard contrôlée (l'absence de ligne vaut « non contrôlée »).
ALTER TABLE "HashboardStatus" ADD CONSTRAINT "HashboardStatus_checked_check" CHECK ("status" <> 'not_checked');
ALTER TABLE "HashboardStatus" ADD CONSTRAINT "HashboardStatus_checked_by_check" CHECK ("checked_by_auth_user_id" > 0);

-- Motif d'attribution non vide s'il est donné (obligatoire pour un remplacement, un retrait, une machine degraded).
ALTER TABLE "OrderLineAssignment" ADD CONSTRAINT "OrderLineAssignment_reason_check" CHECK (btrim("reason") <> '');

-- ─── (1) Génération des machines ─────────────

-- Reprise : lots déjà en Attente de réception à En transit (bases de dev ; aucun sur une base neuve). Écrite avant
-- les nouveaux triggers de "Machine" (insertion brute, machines expected sans effet sur le stock).
DO $$
DECLARE
  n integer;
  over integer;
BEGIN
  INSERT INTO "Machine" ("model_id", "batch_id")
  SELECT b."model_id", b."id"
  FROM "Batch" b
  CROSS JOIN LATERAL generate_series(1, b."quantity" - (SELECT count(*)::integer FROM "Machine" m WHERE m."batch_id" = b."id"))
  WHERE b."status" IN ('awaiting_reception', 'inspection', 'tuning', 'packaging', 'in_transit');
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT count(*) INTO over FROM "Batch" b
  WHERE (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id") > b."quantity";
  RAISE NOTICE 'v6: % expected machine(s) generated; % batch(es) with more machines than quantity (left as is)', n, over;
END;
$$;

-- BatchStatusTransition_apply de v5l, à l'identique sauf la génération des machines à l'entrée en Attente de
-- réception (après le changement de statut : les machines naissent dans un lot qui les attend).
CREATE OR REPLACE FUNCTION "BatchStatusTransition_apply"() RETURNS trigger
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
  -- (v5h, étendu en v5i) Lot qui n'accepte plus de commande (annulé, en transit…) : les factures en attente
  -- sans aucun versement sont annulées avec la transition (cancelled_at posé par Order_guard ; v5l : cause
  -- batch_closed). Le WHERE est réévalué sous le verrou de la ligne : un versement validé entre-temps, ou une
  -- annulation par le client validée juste avant (cause user conservée), exclut la facture. Les factures
  -- expirées (expires_at passé) n'ont plus rien à annuler (Order_cancel_expired).
  IF NOT coalesce("batch_accepts_orders"(NEW."to_status"), false) THEN
    UPDATE "Order" SET "status" = 'cancelled', "cancel_reason" = 'batch_closed', "updated_at" = now()
    WHERE "batch_id" = NEW."batch_id" AND "status" = 'pending_payment'
      AND "received_sats" = 0 AND "expires_at" > now();
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
    INSERT INTO "ConfigurationItem" ("configuration_id", "model_id", "option_id", "option_value_id", "unit_price")
    SELECT c."id", c."model_id", bo."option_id", v."id", 0
    FROM "Configuration" c
    JOIN "BatchOption" bo ON bo."batch_id" = c."batch_id" AND NOT bo."hidden"
    JOIN "OptionValue" v ON v."option_id" = bo."option_id" AND v."is_default"
    WHERE c."batch_id" = NEW."batch_id" AND c."locked_at" IS NULL
    ON CONFLICT DO NOTHING;
  END IF;
  -- (v5i) Les wishlists se figent (sortie du brouillon ou du sondage vers la précommande, ou directement vers
  -- Commande en cours) : un choix retiré au sondage revient au défaut, ajustement journalisé. Le lot a encore
  -- son ancien statut ici : la garde d'immuabilité laisse faire, l'instantané de publication est déjà pris.
  IF NEW."from_status" IN ('draft', 'survey') AND "batch_wishlists_frozen"(NEW."to_status") THEN
    PERFORM "batch_reset_withdrawn_choices"(NEW."batch_id");
  END IF;
  UPDATE "Batch" SET "status" = NEW."to_status", "updated_at" = now() WHERE "id" = NEW."batch_id";
  -- (v6) Attente de réception : une machine attendue par place du lot (rien de plus après un retour arrière
  -- inspection → awaiting_reception : on ne crée que ce qui manque).
  IF NEW."to_status" = 'awaiting_reception' THEN
    INSERT INTO "Machine" ("model_id", "batch_id")
    SELECT b."model_id", b."id"
    FROM "Batch" b
    CROSS JOIN LATERAL generate_series(1, b."quantity" - (SELECT count(*)::integer FROM "Machine" m WHERE m."batch_id" = b."id"))
    WHERE b."id" = NEW."batch_id";
  END IF;
  RETURN NEW;
END;
$$;

-- Quantité figée dès que les machines existent (le domaine la fige dès l'Attente de réception).
CREATE FUNCTION "Batch_guard_quantity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."quantity" IS DISTINCT FROM OLD."quantity"
     AND EXISTS (SELECT 1 FROM "Machine" WHERE "batch_id" = OLD."id") THEN
    RAISE EXCEPTION 'Batch % has machines: its quantity is frozen (constraint "Batch_quantity_frozen")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Batch_quantity_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Batch_guard_quantity"
  BEFORE UPDATE OF "quantity" ON "Batch"
  FOR EACH ROW EXECUTE FUNCTION "Batch_guard_quantity"();

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

-- ─── (2) Machine : écritures directes, statuts via le journal ─────────────

-- Insertion : machine attendue (expected, unknown, sans date), lot attendant ses machines, jamais plus que sa
-- quantité (sous verrou du lot). Mise à jour : identité et date de création immuables ; statuts et dates de
-- réception / expédition / livraison seulement par MachineStatusChange (trigger imbriqué) ; numéros de série
-- figés une fois la machine partie ; lot clos ou annulé : rien ne bouge. updated_at : horloge de la base.
CREATE FUNCTION "Machine_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bst "batch_status";
  q integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Machine % is never deleted (constraint "Machine_no_delete")', OLD."id"
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'Machine_no_delete';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."logistical_status" <> 'expected' OR NEW."functional_status" <> 'unknown'
       OR NEW."received_at" IS NOT NULL OR NEW."shipped_at" IS NOT NULL OR NEW."delivered_at" IS NOT NULL THEN
      RAISE EXCEPTION 'A new machine is expected, unchecked and undated (constraint "Machine_new")'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_new';
    END IF;
    q := "Batch_lock"(NEW."batch_id");
    SELECT "status" INTO bst FROM "Batch" WHERE "id" = NEW."batch_id";
    IF bst NOT IN ('awaiting_reception', 'inspection', 'tuning', 'packaging', 'in_transit') THEN
      RAISE EXCEPTION 'Batch % is %: machines exist from awaiting_reception to in_transit (constraint "Machine_batch_status")', NEW."batch_id", bst
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_batch_status';
    END IF;
    IF (SELECT count(*) FROM "Machine" WHERE "batch_id" = NEW."batch_id") >= q THEN
      RAISE EXCEPTION 'Batch % already has its % machines (constraint "Machine_batch_quantity")', NEW."batch_id", q
        USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_batch_quantity';
    END IF;
    NEW."created_at" := clock_timestamp();
    NEW."updated_at" := NEW."created_at";
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."model_id", NEW."batch_id", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."model_id", OLD."batch_id", OLD."created_at") THEN
    RAISE EXCEPTION 'Machine % keeps its id, model, batch and creation date (constraint "Machine_immutable")', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_immutable';
  END IF;
  IF (NEW."logistical_status", NEW."functional_status", NEW."received_at", NEW."shipped_at", NEW."delivered_at")
     IS DISTINCT FROM (OLD."logistical_status", OLD."functional_status", OLD."received_at", OLD."shipped_at", OLD."delivered_at")
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Machine statuses and dates change only by inserting a MachineStatusChange (constraint "Machine_status_via_change")'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'Machine_status_via_change';
  END IF;
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = OLD."batch_id";
  IF bst IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Batch % is %: its machines are frozen (constraint "Machine_batch_frozen")', OLD."batch_id", bst
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

-- Journal des statuts : l'insertion vérifie l'état courant (sous verrou de la machine), le couple autorisé (CHECK),
-- le statut du lot (sous verrou du lot), puis applique les statuts et les dates. Ordre des verrous : machine, lot.
CREATE FUNCTION "MachineStatusChange_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m "Machine"%ROWTYPE;
  bst "batch_status";
  ts timestamptz := clock_timestamp();
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
  PERFORM "Batch_lock"(NEW."batch_id");
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = NEW."batch_id";
  IF bst NOT IN ('awaiting_reception', 'inspection', 'tuning', 'packaging', 'in_transit') THEN
    RAISE EXCEPTION 'Batch % is %: machine statuses change from awaiting_reception to in_transit (constraint "MachineStatusChange_batch_status")', NEW."batch_id", bst
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_batch_status';
  END IF;
  IF NEW."to_logistical" = 'in_transit' AND NEW."from_logistical" <> 'in_transit' AND bst NOT IN ('packaging', 'in_transit') THEN
    RAISE EXCEPTION 'Batch % is %: machines are handed to the carrier from packaging on (constraint "MachineStatusChange_batch_status")', NEW."batch_id", bst
      USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_batch_status';
  END IF;
  -- Contrôle : sur une machine en main, lot au Contrôle ou après ; jamais de retour à « non contrôlée »
  IF NEW."to_functional" <> NEW."from_functional" THEN
    IF NEW."to_functional" = 'unknown' THEN
      RAISE EXCEPTION 'Machine % was checked: it never goes back to unknown (constraint "MachineStatusChange_functional")', NEW."machine_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_functional';
    END IF;
    IF NOT "machine_in_hand"(NEW."to_logistical") OR bst = 'awaiting_reception' THEN
      RAISE EXCEPTION 'Machine % is checked only when received and in hand, batch under inspection or later (constraint "MachineStatusChange_functional")', NEW."machine_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'MachineStatusChange_functional';
    END IF;
  END IF;
  UPDATE "Machine" SET
    "logistical_status" = NEW."to_logistical",
    "functional_status" = NEW."to_functional",
    "received_at" = CASE WHEN NEW."from_logistical" IN ('expected', 'missing') AND NEW."to_logistical" = 'in_stock'
                         THEN coalesce("received_at", ts) ELSE "received_at" END,
    "shipped_at" = CASE WHEN NEW."to_logistical" = 'in_transit' AND NEW."from_logistical" <> 'in_transit'
                        THEN ts ELSE "shipped_at" END,
    "delivered_at" = CASE WHEN NEW."to_logistical" = 'delivered' AND NEW."from_logistical" <> 'delivered'
                          THEN ts ELSE "delivered_at" END
  WHERE "id" = NEW."machine_id";
  NEW."created_at" := ts;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MachineStatusChange_apply"
  BEFORE INSERT ON "MachineStatusChange"
  FOR EACH ROW EXECUTE FUNCTION "MachineStatusChange_apply"();

CREATE TRIGGER "MachineStatusChange_append_only"
  BEFORE UPDATE OR DELETE ON "MachineStatusChange"
  FOR EACH ROW EXECUTE FUNCTION "raise_append_only"();

-- ─── (3) Hashboards et cohérence du contrôle ─────────────

-- Saisie d'une hashboard : index du modèle, machine en main au Contrôle ou après (verrous : machine, lot), jamais
-- supprimée, machine et index immuables. Auteur obligatoire (colonne NOT NULL), date posée par la base.
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
  IF NOT "machine_in_hand"(m."logistical_status") OR bst NOT IN ('inspection', 'tuning', 'packaging', 'in_transit') THEN
    RAISE EXCEPTION 'Machine % is checked only when received and in hand, batch under inspection or later (constraint "HashboardStatus_machine_in_hand")', m."id"
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

-- ─── (4) Machine morte retirée du stock ─────────────

-- Machines sorties du stock : missing / scrapped / lost, et (v6) toute machine faulty, tant qu'elles ne sont pas la
-- machine d'une ligne active (comptée alors une fois, par sa ligne, jusqu'au remplacement ou au remboursement).
CREATE OR REPLACE FUNCTION "batch_written_off"(b uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM "Machine" m
  WHERE m."batch_id" = b
    AND (m."logistical_status" IN ('missing', 'scrapped', 'lost') OR m."functional_status" = 'faulty')
    AND NOT EXISTS (SELECT 1 FROM "batch_active_lines"(b) a WHERE a."machine_id" = m."id")
$$;

-- L'état fonctionnel compte désormais dans le stock : contrôle différé aussi sur son changement.
DROP TRIGGER "Machine_stock" ON "Machine";
CREATE CONSTRAINT TRIGGER "Machine_stock" AFTER INSERT OR UPDATE OF "logistical_status", "functional_status" ON "Machine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trg_check_stock"();

-- Commandes payées en trop par rapport aux machines utilisables (roadmap, « Machines défectueuses et surplus » :
-- les dernières commandes en trop sont remboursées, paiement le plus récent d'abord). Lignes actives classées
-- par paiement (Order.paid_at, puis facture, puis rang dans la facture) ; sont « en trop » celles dont le rang
-- dépasse la capacité = quantity − machines inutilisables (batch_unusable_machines : manquantes, au rebut, perdues
-- ou mortes, attribuées ou non) − `extra` (machines que l'on s'apprête à rendre inutilisables, ex. une machine qu'on
-- va marquer faulty). Renvoyées de la plus récente à la plus ancienne. Les factures en
-- attente (réservations) ne sont pas comptées : ce ne sont pas des commandes payées ; Batch_stock les compte
-- toujours au COMMIT. Source unique de l'ordre pour le domaine ; ne verrouille pas.
CREATE FUNCTION "batch_unusable_machines"(b uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM "Machine" m
  WHERE m."batch_id" = b
    AND (m."logistical_status" IN ('missing', 'scrapped', 'lost') OR m."functional_status" = 'faulty')
$$;

CREATE FUNCTION "batch_surplus_lines"(b uuid, extra integer DEFAULT 0)
RETURNS TABLE ("line_id" uuid, "order_id" uuid, "user_id" uuid, "paid_at" timestamptz, "position" integer,
               "machine_id" uuid, "rank" integer)
LANGUAGE sql STABLE AS $$
  WITH ranked AS (
    SELECT l."id", l."order_id", o."user_id", o."paid_at", l."position", l."machine_id",
      (row_number() OVER (ORDER BY o."paid_at", o."id", l."position"))::integer AS "rank"
    FROM "OrderLine" l JOIN "Order" o ON o."id" = l."order_id"
    WHERE l."batch_id" = b AND l."refund_id" IS NULL AND o."status" = 'paid')
  SELECT r."id", r."order_id", r."user_id", r."paid_at", r."position", r."machine_id", r."rank"
  FROM ranked r, "Batch" ba
  WHERE ba."id" = b AND r."rank" > ba."quantity" - "batch_unusable_machines"(b) - coalesce(extra, 0)
  ORDER BY r."rank" DESC
$$;

-- ─── (5) Attribution ─────────────

-- Attribution, remplacement, retrait (journal OrderLineAssignment). Verrous : ligne, machines (ancienne et
-- nouvelle, par id), lot. Conditions :
--   ligne active d'une facture payée (OrderLineAssignment_active_line) ; changement réel (OrderLineAssignment_changed) ;
--   lot au Contrôle, Tuning, Packaging ou En transit (OrderLineAssignment_batch_status) ;
--   remplacement ou retrait : motif (OrderLineAssignment_reason) ; jamais d'une machine remise au transporteur ou
--   livrée (OrderLineAssignment_shipped) ;
--   nouvelle machine : reçue et en main, CONTRÔLÉE et fonctionnelle, ok ou degraded (OrderLineAssignment_machine_assignable) ;
--   degraded : motif, décision du technicien tracée (OrderLineAssignment_degraded_reason).
-- Une machine n'est la machine que d'une ligne non remboursée (index unique partiel existant).
CREATE OR REPLACE FUNCTION "OrderLineAssignment_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur uuid;
  active boolean;
  bst "batch_status";
  old_m "Machine"%ROWTYPE;
  new_m "Machine"%ROWTYPE;
BEGIN
  SELECT l."machine_id", (l."refund_id" IS NULL AND o."status" = 'paid') INTO cur, active
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
  SELECT "status" INTO bst FROM "Batch" WHERE "id" = NEW."batch_id";
  IF bst NOT IN ('inspection', 'tuning', 'packaging', 'in_transit') THEN
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
    IF NOT "machine_in_hand"(new_m."logistical_status") OR new_m."functional_status" NOT IN ('ok', 'degraded') THEN
      RAISE EXCEPTION 'Machine % is not assignable: it must be received, in hand, checked and working (constraint "OrderLineAssignment_machine_assignable")', NEW."machine_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_machine_assignable';
    END IF;
    IF new_m."functional_status" = 'degraded' AND NEW."reason" IS NULL THEN
      RAISE EXCEPTION 'Machine % has a defective hashboard: assigning it needs a reason (constraint "OrderLineAssignment_degraded_reason")', NEW."machine_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'OrderLineAssignment_degraded_reason';
    END IF;
  END IF;
  UPDATE "OrderLine" SET "machine_id" = NEW."machine_id" WHERE "id" = NEW."order_line_id";
  NEW."created_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- ─── (7) Compteurs du lot ─────────────

-- Vue batch_machine_summary : une ligne par lot (0 partout avant l'Attente de réception). Calculée à la lecture.
--   machines, expected, received (ni expected ni missing), in_hand (machine_in_hand), unchecked (en main, unknown),
--   ok / degraded / faulty (état fonctionnel, toutes machines ; faulty compte aussi les machines au rebut),
--   missing, scrapped, lost, returned, in_transit, delivered ;
--   written_off = batch_written_off ; paid_lines = lignes actives ; assigned_lines (avec machine) ; unassigned_lines ;
--   lines_to_replace = lignes actives dont la machine est faulty ou lost (à remplacer, ou ligne en trop à rembourser) ;
--   degraded_lines = lignes actives dont la machine est degraded (décision du technicien tracée) ;
--   free_machines = en main, ok ou degraded, machine d'aucune ligne active ; free_ok_machines = parmi elles, ok ;
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
  b."quantity",
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
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'in_transit')::integer AS "in_transit",
  (SELECT count(*) FROM "Machine" m WHERE m."batch_id" = b."id" AND m."logistical_status" = 'delivered')::integer AS "delivered",
  "batch_written_off"(b."id") AS "written_off",
  "batch_unusable_machines"(b."id") AS "unusable",
  (SELECT count(*) FROM active a WHERE a."batch_id" = b."id")::integer AS "paid_lines",
  (SELECT count(*) FROM active a WHERE a."batch_id" = b."id" AND a."machine_id" IS NOT NULL)::integer AS "assigned_lines",
  (SELECT count(*) FROM active a WHERE a."batch_id" = b."id" AND a."machine_id" IS NULL)::integer AS "unassigned_lines",
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
  (SELECT count(*) FROM "batch_surplus_lines"(b."id"))::integer AS "surplus_lines"
FROM "Batch" b;
