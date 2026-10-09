-- Noms uniques du catalogue (décision Hugo 2026-10-07, revue qualité M1), sans tenir compte de la
-- casse ni des espaces de bord : modèle (nom, global), menu (titre, par modèle), valeur (libellé,
-- par menu), produit d'option (nom, global). Index uniques sur expression : seule garde, sûre en
-- concurrence ; l'API traduit chaque violation en 409 avec un code dédié (src/server/errors.ts).
-- Prisma ne sait pas décrire un index sur expression : ils ne figurent qu'ici (et dans schema.dbml).

-- Données existantes : si des doublons existent, la migration échoue avant de créer quoi que ce
-- soit, avec le décompte par table. Les renommer (ou supprimer) puis relancer `migrate deploy`.
-- Requête pour les lister, par exemple pour les modèles :
--   SELECT lower(btrim("name")), array_agg("id") FROM "Model" GROUP BY 1 HAVING count(*) > 1;
DO $$
DECLARE
  report text;
BEGIN
  SELECT string_agg(format('%s : %s nom(s) en double', t, n), ' ; ')
  INTO report
  FROM (
    SELECT 'Model (name)' AS t, count(*) AS n FROM (
      SELECT 1 FROM "Model" GROUP BY lower(btrim("name")) HAVING count(*) > 1) d
    UNION ALL
    SELECT 'Option (model_id, title)', count(*) FROM (
      SELECT 1 FROM "Option" GROUP BY "model_id", lower(btrim("title")) HAVING count(*) > 1) d
    UNION ALL
    SELECT 'OptionValue (option_id, label)', count(*) FROM (
      SELECT 1 FROM "OptionValue" GROUP BY "option_id", lower(btrim("label")) HAVING count(*) > 1) d
    UNION ALL
    SELECT 'Part (name)', count(*) FROM (
      SELECT 1 FROM "Part" GROUP BY lower(btrim("name")) HAVING count(*) > 1) d
  ) s
  WHERE n > 0;
  IF report IS NOT NULL THEN
    RAISE EXCEPTION 'catalog_unique_names : doublons dans le catalogue (casse et espaces de bord ignorés) : %', report
      USING HINT = 'Renommez les doublons puis relancez la migration (voir l''en-tête de la migration).';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "Model_name_ci_key" ON "Model" (lower(btrim("name")));
CREATE UNIQUE INDEX "Option_model_id_title_ci_key" ON "Option" ("model_id", lower(btrim("title")));
CREATE UNIQUE INDEX "OptionValue_option_id_label_ci_key" ON "OptionValue" ("option_id", lower(btrim("label")));
CREATE UNIQUE INDEX "Part_name_ci_key" ON "Part" (lower(btrim("name")));
