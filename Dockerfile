# syntax=docker/dockerfile:1

# ── Base: dependencies shared by both runtime images ────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
# openssl is required by Prisma's query engine on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/ai/package.json packages/ai/
COPY packages/crawler/package.json packages/crawler/
COPY packages/seo-engine/package.json packages/seo-engine/
COPY packages/integrations/package.json packages/integrations/
COPY packages/agents/package.json packages/agents/
COPY packages/queue/package.json packages/queue/
RUN npm ci --no-audit --no-fund

# ── Builder: generate the Prisma client and build Next.js ──────────────────
FROM deps AS builder
WORKDIR /app
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
# Next.js needs a DATABASE_URL present at build time for type generation only;
# it never connects during the build.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV AUTH_SECRET="build-time-placeholder-not-used-at-runtime"
ENV ENCRYPTION_KEY="YnVpbGQtdGltZS1wbGFjZWhvbGRlci0zMmJ5dGVzIQ=="
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @seo/web

# ── Web runtime ────────────────────────────────────────────────────────────
FROM node:22-slim AS web
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app /app
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@seo/web"]

# ── Worker runtime ─────────────────────────────────────────────────────────
# Includes Chromium so optional JS rendering works. Set ENABLE_JS_RENDERING=true
# to use it; HTTP crawling (the default) does not need the browser.
FROM node:22-slim AS worker
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=builder /app /app
RUN npx playwright install --with-deps chromium || \
    echo "Playwright browser install failed — JS rendering will report as unavailable, HTTP crawling still works."
CMD ["npm", "run", "start", "--workspace", "@seo/worker"]
