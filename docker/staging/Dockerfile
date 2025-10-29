FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS prod-deps
COPY package*.json ./
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS deps
COPY package*.json ./
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate && pnpm run build

FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs && \
    chown -R nestjs:nodejs /app && \
    mkdir -p /app/uploads && chown -R nestjs:nodejs /app/uploads

ENV NODE_ENV=production

COPY --chown=nestjs:nodejs --from=builder /app/dist ./dist
COPY --chown=nestjs:nodejs --from=prod-deps /app/node_modules ./node_modules
COPY --chown=nestjs:nodejs --from=builder /app/node_modules/.pnpm/@prisma+client* ./node_modules/.pnpm/
COPY --chown=nestjs:nodejs prisma ./prisma
COPY --chown=nestjs:nodejs package*.json ./
COPY --chown=nestjs:nodejs pnpm-lock.yaml ./

COPY init.sh /usr/local/bin/init.sh
RUN chmod +x /usr/local/bin/init.sh

USER nestjs

EXPOSE 8081

# ENTRYPOINT [ "init.sh" ]
CMD ["node", "dist/src/main"]