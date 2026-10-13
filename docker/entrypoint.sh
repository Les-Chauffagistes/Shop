#!/bin/sh
# Point d'entrée de l'image : configuration -> migrations -> application.
# Aucune valeur d'environnement n'est figée dans l'image ; tout vient de l'exécution (variables
# d'environnement ou secrets Swarm montés dans /run/secrets).
set -eu

log() { printf '[entrypoint] %s\n' "$*"; }

# Secrets Swarm : VAR_FILE=/run/secrets/<nom> alimente VAR avec le contenu du fichier (fin de ligne
# retirée). Refus si VAR et VAR_FILE sont tous deux définis, pour ne pas choisir en silence.
for name in DATABASE_URL JWT_SECRET PAYMENT_WEBHOOK_SECRET; do
  file=$(printenv "${name}_FILE" || true)
  [ -n "$file" ] || continue
  if [ -n "$(printenv "$name" || true)" ]; then
    log "ERREUR : ${name} et ${name}_FILE sont tous deux définis, n'en garder qu'un."
    exit 1
  fi
  if [ ! -r "$file" ]; then
    log "ERREUR : ${name}_FILE pointe vers un fichier illisible (${file})."
    exit 1
  fi
  value=$(cat "$file")
  export "$name=$value"
  unset "${name}_FILE"
done

# Mode d'exécution de Next.js et de la validation (secrets d'au moins 32 caractères, PUBLIC_URL
# requise) : ce n'est pas un réglage de déploiement, il est donc imposé ici et non lu de l'extérieur.
export NODE_ENV=production

# 1. Configuration : échec franc avant toute migration.
node /app/check-config.mjs

# 2. Migrations (prisma.config.ts lit DATABASE_URL). set -e : un échec arrête le conteneur.
log "Application des migrations (prisma migrate deploy)..."
cd /opt/migrate
node node_modules/prisma/build/index.js migrate deploy
log "Migrations appliquées."

# 3. Application. HOSTNAME est posé par Docker (identifiant du conteneur) : il faut l'écraser
# pour écouter sur toutes les interfaces. PORT : défaut 3000.
cd /app
export HOSTNAME=0.0.0.0
export PORT="${PORT:-3000}"
log "Démarrage de l'application sur ${HOSTNAME}:${PORT}."
exec node server.js
