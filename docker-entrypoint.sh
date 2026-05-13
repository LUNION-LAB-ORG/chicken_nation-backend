#!/bin/sh
# ============================================================================
# Chicken Nation Backend — entrypoint Docker
#
# Lance les migrations Prisma puis démarre l'application Nest.
#
# `prisma migrate deploy` :
#   - applique uniquement les migrations qui n'ont pas encore tourné (idempotent)
#   - utilise un lock SQL natif (_prisma_migrations table) → safe si deux
#     conteneurs démarrent en parallèle (un seul applique, l'autre attend)
#   - ne crée pas de migration, n'effectue pas de drift detection
#
# Variable d'env optionnelle :
#   SKIP_MIGRATIONS=true → saute l'étape migration (utile pour un conteneur
#                          secondaire dont on veut être 100% sûr qu'il ne
#                          touchera pas la DB au boot)
# ============================================================================

set -e

if [ "$SKIP_MIGRATIONS" = "true" ]; then
  echo "[entrypoint] SKIP_MIGRATIONS=true → migrations Prisma sautées."
else
  echo "[entrypoint] Application des migrations Prisma..."
  npx prisma migrate deploy
  echo "[entrypoint] Migrations Prisma appliquées."
fi

echo "[entrypoint] Démarrage de l'application Nest..."
exec node -r tsconfig-paths/register dist/src/main.js
