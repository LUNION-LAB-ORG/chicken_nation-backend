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
RUN bun install

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bunx prisma generate
RUN bun run build

# ---------- Runtime stage : Node.js ----------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# OpenSSL nécessaire pour Prisma (libssl)
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma

# Régénérer le client Prisma pour l'OS du runner (debian-openssl-3.0.x).
# L'image builder (Bun, Debian) peut produire une version différente.
RUN npx prisma generate

# tsconfig minimal pour résoudre les imports `src/...` du code compilé.
# baseUrl: './dist' permet à tsconfig-paths de mapper `src/foo` vers `dist/src/foo.js`.
RUN echo '{"compilerOptions":{"baseUrl":"./dist"}}' > tsconfig.json

EXPOSE 3020

CMD ["node", "-r", "tsconfig-paths/register", "dist/src/main.js"]
