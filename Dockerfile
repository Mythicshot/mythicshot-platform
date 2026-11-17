# syntax=docker/dockerfile:1
#
# The platform on Node, for the container target. Build: docker build -t demo-platform:dev .
# Every setting, the setup code included, arrives as an environment variable at run
# time; nothing secret is copied into any layer.

ARG NODE_IMAGE=node:26.13.1-alpine3.24

# Compile TypeScript to dist/. Install scripts are skipped: the compiler needs none,
# and the Workers-runtime dev dependencies have no use here.
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build:node

# Production dependencies only.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# The runner holds only dist/, migrations/, package.json (for "type": "module") and the
# production node_modules. The wizard's page is served from dist/; a public/ folder is
# added here once the app has one.
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
RUN addgroup -S -g 1001 app \
 && adduser -S -D -H -u 1001 -G app -s /sbin/nologin app \
 && mkdir /data \
 && chown 1001:1001 /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations

# /data is the only path the app writes to: db.sqlite, drafts/ and public/.
VOLUME ["/data"]
USER 1001:1001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]

# Node runs as PID 1 and handles SIGTERM itself (src/node/entry.ts): it stops taking
# requests, finishes open ones and closes the database before exiting.
CMD ["node", "dist/node/entry.js"]
