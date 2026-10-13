# Déploiement (Docker Swarm)

L'image est **la même pour tous les environnements** : aucune variable, aucun secret ni valeur de secours n'est figé dans l'image, et le build n'exige aucune variable (la CI construit avec `context: .`, sans build-args). Tout vient de l'exécution. Le stack file à copier dans `les-chauffagistes/deploy` est `docs/deploy/miner-shop.staging.yml`.

## Image

`Dockerfile` multi-stage : `deps` (npm ci), `build` (client Prisma, `next build` en sortie `standalone`, validateur de configuration), `migrate-cli` (CLI Prisma de la version du lockfile), `runner` (dernier stage, **celui qu'on déploie** : `build-target` vide). Node 24 (LTS), utilisateur `node` non root, port 3000. Le secret BuildKit `npmrc` fourni par la CI n'est pas utilisé (aucun paquet privé) ; `pipindex` non plus.

`NODE_ENV=production` n'est pas une variable de déploiement mais le mode d'exécution : `docker/entrypoint.sh` l'impose au démarrage (jamais dans l'image, jamais lu de l'extérieur). Ne pas copier `NODE_ENV: staging` des gabarits.

## Démarrage : configuration, migration, application

`docker/entrypoint.sh` (`set -eu`) :
1. résout les secrets `<VAR>_FILE` (voir ci-dessous) ;
2. valide la configuration (même schéma que l'application, `src/server/config.ts`) : invalide, le conteneur s'arrête (code 1) avec « Configuration invalide : … », avant de toucher la base ;
3. `prisma migrate deploy` (depuis `/opt/migrate`, avec `prisma.config.ts` et `prisma/migrations`) : en cas d'échec le conteneur s'arrête, l'application ne démarre pas ;
4. `exec node server.js` sur `0.0.0.0:$PORT` (défaut 3000) : l'application reçoit les signaux.

Pas de seed en déploiement. Plusieurs réplicas ne se marchent pas dessus (verrou consultatif de Prisma), mais en staging : 1 réplica, `stop-first`.

## Variables et secrets

| Variable | Statut | Notes |
|---|---|---|
| `DATABASE_URL` | requise, **secret** | `postgresql://utilisateur:motdepasse@db:5432/base` ; le mot de passe contient le secret : un secret contenant l'URL entière |
| `JWT_SECRET` | requise, **secret** | même valeur que le `JWT_SECRET` d'auth-service back, 32 caractères minimum (secret Swarm existant `auth_staging_jwt_secret`) |
| `PUBLIC_URL` | requise (production) | URL publique de la boutique, identique à l'hôte Traefik |
| `AUTH_API_URL` | requise | auth-service back, ex. `https://api.auth.staging.chauffagistes-btc.fr` |
| `AUTH_FRONT_URL` | requise | auth-service front (page de connexion) |
| `BACKOFFICE_USER_IDS` | requise (peut être vide) | identifiants `users.id` du service d'auth, séparés par des virgules |
| `PAYMENT_WEBHOOK_SECRET` | facultative, **secret** | 32 caractères minimum ; vide = point d'entrée `POST /api/internal/payments` fermé (404) |
| `PAYMENT_BTC_PRICE_EUR_CENTS` | facultative | taux du paiement simulé (défaut 9000000) |
| `PAYMENT_REFUND_NETWORK_FEE_SATS` | facultative | frais réseau d'un remboursement (défaut 2000) |
| `PORT` | facultative | défaut 3000 |

**Secrets Swarm** : pour `DATABASE_URL`, `JWT_SECRET` et `PAYMENT_WEBHOOK_SECRET`, définir `<VAR>_FILE=/run/secrets/<cible>` au lieu de `<VAR>` (les deux ensemble : échec). Le fichier est lu une fois au démarrage, fin de ligne retirée. Le code applicatif et `prisma.config.ts` ne lisent que `process.env` : la résolution se fait uniquement dans l'entrypoint.

## Healthcheck

`GET /api/health` : 200 `{"status":"ok"}` si la base répond (délai 3 s), sinon 503. L'image n'a ni curl ni wget : le stack file utilise `node -e fetch(...)` avec `start_period: 60s` (les migrations précèdent l'écoute).

## Ordre de déploiement (première fois)

1. Créer les secrets sur le manager (ci-dessous) et le sous-domaine DNS.
2. Vérifier que `SameSite=Lax` d'auth-service est déployé (le cookie `access_token` doit accompagner la navigation vers la boutique).
3. Copier le stack file dans `stacks/staging/miner-shop.yml`, remplacer les placeholders, fixer le tag `sha-<7>` de l'image publiée par la CI.
4. Committer sur `develop` du dépôt deploy : la base démarre, puis l'application migre et écoute. Surveiller `docker service logs miner-shop-staging_app`.

Un déploiement ultérieur : changer le tag. Les migrations s'appliquent seules ; un rollback d'image **ne défait pas** les migrations (écrire des migrations compatibles avec la version précédente, ou restaurer la base).

## Secrets à créer (sur le manager Swarm, une seule fois)

```bash
DB_PW=$(openssl rand -hex 24)   # hex : sans caractère à encoder dans l'URL
printf '%s' "$DB_PW" | docker secret create miner_shop_staging_db_password -
printf 'postgresql://miner_shop:%s@db:5432/miner_shop' "$DB_PW" | docker secret create miner_shop_staging_database_url -
unset DB_PW
openssl rand -hex 32 | tr -d '\n' | docker secret create miner_shop_staging_payment_webhook_secret -
# JWT : réutilise auth_staging_jwt_secret (déjà créé pour auth-service back) ; rien à créer.
```

## À ne PAS faire

- Pas de `prisma db seed` : les données de démonstration n'ont rien à faire en staging ni en production.
- Pas de `prisma migrate reset` ni `npm run db:reset` : efface la base.
- Pas de `prisma migrate dev` en déploiement ; ne pas modifier une migration déjà appliquée (créer la suivante).
- Ne pas mettre `DATABASE_URL`, `JWT_SECRET` ou `PAYMENT_WEBHOOK_SECRET` en clair dans le stack file ni dans les build-args.
- Ne pas pousser `NODE_ENV: staging`.
- Une migration en échec (`_prisma_migrations` avec `finished_at` nul) bloque les démarrages suivants : corriger, puis `prisma migrate resolve` à la main depuis un conteneur, jamais en effaçant la base.
