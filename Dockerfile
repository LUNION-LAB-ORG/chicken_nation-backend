# ========================
# Base
# ========================
FROM oven/bun:1.1.0 AS base
WORKDIR /app

# ========================
# Dependencies
# ========================
FROM base AS deps
COPY package.json bun.lockb ./
RUN bun install

# ========================
# Build
# ========================
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma client
RUN bunx prisma generate

# Build NestJS
RUN bun run build

# ========================
# Runner (production)
# ========================
FROM oven/bun:1.1.0-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY prisma ./prisma
COPY package.json ./

EXPOSE 8081

CMD ["bun", "run", "start:prod"]
