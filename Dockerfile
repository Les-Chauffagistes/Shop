# syntax=docker/dockerfile:1
#
# Image agnostique de l'environnement : aucune variable d'exécution n'est nécessaire au build
# (pas de --build-arg), aucune n'est figée dans l'image. Voir docs/deploy.md.
#
# Aucun paquet privé (@chauffagistes/*) ni registre privé : le secret BuildKit `npmrc` que fournit
# la CI n'est pas utilisé. S'il le devenait, ajouter `--mount=type=secret,id=npmrc,target=/root/.npmrc`
# sur le `npm ci` du stage `deps`.

# Node 24 : LTS active ; Next.js 16 exige Node >= 20.9.
FROM node:24-bookworm-slim AS base
WORKDIR /app

# --- Dépendances (dev comprises) pour construire ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- Build : client Prisma, application (sortie standalone), validateur de configuration ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/ est vide (non suivi par git) : le créer pour la copie vers l'image finale
RUN mkdir -p public \
 && npx prisma generate \
 && npm run build \
 && npx esbuild docker/check-config.ts --bundle --platform=node --format=esm --outfile=.next/check-config.mjs

# --- CLI Prisma de production : même version que package-lock.json, pour `migrate deploy` ---
FROM base AS migrate-cli
WORKDIR /opt/migrate
COPY package-lock.json /tmp/package-lock.json
RUN V=$(node -p "require('/tmp/package-lock.json').packages['node_modules/prisma'].version") \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --save-exact "prisma@$V"
COPY prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations

# --- Image finale (cible par défaut) ---
FROM base AS runner
# openssl : requis par le moteur de migration de Prisma.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=migrate-cli --chown=node:node /opt/migrate /opt/migrate
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/check-config.mjs ./check-config.mjs
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
