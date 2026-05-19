# ============================================================================
# Chicken Nation Backend — multi-stage Dockerfile
#
# Stratégie : Bun pour le build (rapide + supporte natif TypeScript/Prisma),
# Node.js pour le runtime (Bun a un bug d'import nommé avec Express CJS).
#
# Le code utilise des imports `src/...` (baseUrl tsconfig). On les résout au
# runtime via `tsconfig-paths/register` + un tsconfig minimal pointant sur dist/.
#
# Variables d'env runtime (cf. .env.example) :
#   - DATABASE_URL, REDIS_HOST, REDIS_PORT, CORS_ORIGINS, etc.
# ============================================================================

# ---------- Build stage : Bun ----------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Skip le download du Chrome bundled de Puppeteer (~300 MB).
# On utilise Chromium système installé dans le runtime stage.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true
RUN bun install

FROM oven/bun:1 AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bunx prisma generate
RUN bun run build

# ---------- Runtime stage : Node.js ----------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# OpenSSL pour Prisma (libssl), Chromium + libs/fonts pour Puppeteer
# (rapport marketing quotidien + génération de PDF de commandes).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssl \
        chromium \
        fonts-liberation \
        libgbm1 \
        libnss3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer utilise Chromium système, pas son Chrome bundled.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Régénérer le client Prisma pour l'OS du runner (debian-openssl-3.0.x).
# L'image builder (Bun, Debian) peut produire une version différente.
RUN npx prisma generate

# tsconfig minimal pour résoudre les imports `src/...` du code compilé.
# baseUrl: './dist' permet à tsconfig-paths de mapper `src/foo` vers `dist/src/foo.js`.
RUN echo '{"compilerOptions":{"baseUrl":"./dist"}}' > tsconfig.json

EXPOSE 3020

# L'entrypoint applique les migrations Prisma puis démarre Nest.
# Idempotent : ne fait rien si toutes les migrations sont déjà appliquées.
# Cf. docker-entrypoint.sh pour les détails (lock SQL natif Prisma, SKIP_MIGRATIONS, etc.).
ENTRYPOINT ["./docker-entrypoint.sh"]
