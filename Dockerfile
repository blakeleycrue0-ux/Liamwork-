# ---------- build stage: install production deps (better-sqlite3 may compile) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Toolchain is only needed when no prebuilt binary matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- runtime stage ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATABASE_FILE=/data/web-monitor.sqlite \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

# Default: web dashboard. The crawler process overrides this command.
CMD ["node", "src/server.js"]
