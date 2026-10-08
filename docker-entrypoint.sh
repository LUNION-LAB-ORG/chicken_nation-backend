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
# ⚠️ REPRISE SUR PANNE DE CONNEXION. Neon met la base en veille et son réveil
# dépasse parfois le délai d'attente de Prisma (P1002). Avec `set -e` seul, le
# conteneur mourait là, Docker le relançait, et le cycle recommençait : le
# backend a redémarré 6 fois d'affilée en renvoyant des 502, les 30/09 et
# 02/10, jusqu'à ce que la base se réveille d'elle-même.
#
# On réessaie donc, en doublant l'attente. UNIQUEMENT sur une panne de
# CONNEXION : une migration réellement cassée doit arrêter le conteneur tout de
# suite et bruyamment, pas après deux minutes de tentatives inutiles.
#
# Variables d'env optionnelles :
#   SKIP_MIGRATIONS=true → saute l'étape migration (utile pour un conteneur
#                          secondaire dont on veut être 100% sûr qu'il ne
#                          touchera pas la DB au boot)
#   MIGRATION_ESSAIS=N   → nombre d'essais (6 par défaut, soit ~2 min d'attente
#                          cumulée : 5s + 10s + 20s + 40s + 60s)
# ============================================================================

set -e

MIGRATION_ESSAIS="${MIGRATION_ESSAIS:-6}"

appliquer_migrations() {
  essai=1
  attente=5

  while : ; do
    echo "[entrypoint] Application des migrations Prisma (essai ${essai}/${MIGRATION_ESSAIS})..."

    if sortie="$(npx prisma migrate deploy 2>&1)"; then
      echo "$sortie"
      echo "[entrypoint] Migrations Prisma appliquées."
      return 0
    fi
    echo "$sortie"

    # Seule une panne de CONNEXION se réessaie. Tout le reste (migration
    # invalide, conflit de schéma, droits manquants) est une erreur qui ne
    # passera pas davantage au sixième essai : mieux vaut tomber maintenant,
    # avec le message en clair dans les journaux.
    case "$sortie" in
      *P1001*|*P1002*|*P1017*|*"Can't reach database server"*|*"Timed out fetching a new connection"*)
        ;;
      *)
        echo "[entrypoint] Échec de migration SANS rapport avec la connexion : arrêt immédiat."
        return 1
        ;;
    esac

    if [ "$essai" -ge "$MIGRATION_ESSAIS" ]; then
      echo "[entrypoint] Base toujours injoignable après ${MIGRATION_ESSAIS} essais : arrêt."
      return 1
    fi

    echo "[entrypoint] Base injoignable (réveil Neon ?), nouvel essai dans ${attente}s."
    sleep "$attente"
    essai=$((essai + 1))
    attente=$((attente * 2))
    [ "$attente" -gt 60 ] && attente=60
  done
}

if [ "$SKIP_MIGRATIONS" = "true" ]; then
  echo "[entrypoint] SKIP_MIGRATIONS=true → migrations Prisma sautées."
else
  appliquer_migrations
fi

echo "[entrypoint] Démarrage de l'application Nest..."
exec node -r tsconfig-paths/register dist/src/main.js
