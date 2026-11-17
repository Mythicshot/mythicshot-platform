# syntax=docker/dockerfile:1
#
# The platform on Node, for the container target. Build: docker build -t demo-platform:dev .
# Every setting, the setup code included, arrives as an environment variable at run
# time; nothing secret is copied into any layer.

# node:26.13.1-alpine3.24, pinned by the digest of its multi-platform index.
ARG NODE_IMAGE=node@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

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

# The Node runtime without npm, its bundled packages, the C headers or the entrypoint
# script; nothing uses them at run time. Removing files in a later layer would not
# shrink the image, so the runner copies this trimmed file system as one layer.
FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/include /usr/local/bin/docker-entrypoint.sh \
 && addgroup -S -g 1001 app \
 && adduser -S -D -H -u 1001 -G app -s /sbin/nologin app \
 && mkdir /data \
 && chown 1001:1001 /data

# The runner holds only dist/, migrations/, package.json (for "type": "module") and the
# production node_modules. The wizard's page is served from dist/; a public/ folder is
# added here once the app has one.
FROM scratch AS runner
COPY --from=runtime / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_VERSION=26.13.1 \
    NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
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
