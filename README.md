# Boutique de mineurs — Les Chauffagistes

Boutique et backoffice (Next.js App Router, PostgreSQL, Prisma). Règles du projet : `rules.md` ; métier : `specs.md` ; données : `schema.dbml` ; API : `docs/api.md` ; avancement : `docs/roadmap.md`.

## Développement

Prérequis : Node 20+, Docker.

```bash
cp .env.example .env     # puis renseigner BACKOFFICE_USER_IDS, etc.
npm install
npm run db:up            # Postgres 17 de dev (port 5440) + base de test jetable (port 5441)
npm run db:migrate       # applique les migrations sur la base de dev (et régénère le client)
npm run db:seed          # données de dev
npm run dev              # http://localhost:3000
```

Autres commandes base : `db:generate` (client Prisma dans `prisma/generated`), `db:reset` (efface et rejoue migrations + seed), `db:down` (arrête les conteneurs ; le volume de dev est conservé).

### Tests

```bash
npm test                 # unitaires + intégration
npm run test:unit        # Vitest, sans base (src/**/*.test.ts, tests/unit/)
npm run test:integration # Vitest sur la base de test réelle (tests/integration/)
npm run typecheck && npm run lint
npm run test:coverage    # unitaires + intégration avec couverture (rapport dans coverage/)
npm run e2e              # Playwright
```

`npm run e2e` exige aussi `npm run db:up` : il crée la base `shop_e2e` sur le conteneur de test, y applique migrations et seed, puis lance `next dev` sur le port 3100 avec un secret JWT et une whitelist de test (`e2e/support/env.ts`). L'authentification est simulée par un cookie `access_token` signé avec ce secret (`e2e/support/auth.ts`), sans contournement dans l'application.

Les dossiers `e2e/customer/` et `e2e/logistician/` contiennent les scénarios d'exploration laissés par les testeurs (journaux sans assertion, attentes de plusieurs dizaines de minutes en temps réel, serveur propre dans `serve.sh`) : ils ne sont **pas** lancés par `npm run e2e` (`testIgnore` dans `playwright.config.ts`) et sont exclus de `tsc` et d'ESLint. Les scénarios stables sont promus dans `e2e/*.spec.ts` ; les expirations se jouent en antidatant la base (`e2e/support/db.ts`), jamais en attendant.

Next.js refuse deux `next dev` dans le même dossier (verrou `.next/dev`) : si un serveur de dev tourne déjà, `npm run e2e` échoue au démarrage. Arrêtez-le, ou lancez l'app des parcours vous-même (mêmes variables que `e2e/support/env.ts`, port 3100, depuis une autre copie du dépôt) et passez `E2E_BASE_URL=http://localhost:3100 npm run e2e`.

Les tests d'intégration exigent `npm run db:up`. Ils appliquent les migrations sur `DATABASE_URL_TEST` (`prisma migrate deploy`) puis vident toutes les tables avant chaque test via `tests/integration/db.ts` (`prisma`, `resetDatabase`). Pas de mock de Prisma pour les invariants. Le helper refuse toute base dont le nom ne finit pas par `_test`.
