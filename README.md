# demo-platform

The hosted platform for interactive product tours. A recorder uploads a tour bundle with an API token, the platform keeps it as a private draft, and once published a visitor clicks through it at `https://tours.example.com/t/<slug>`.

One codebase runs on two targets:

| Target | Database | Files | Entry |
|---|---|---|---|
| Cloudflare Workers | D1 | two R2 buckets (drafts, public) | `src/cloudflare/entry.ts` |
| Container on Node | one SQLite file through `node:sqlite` | two folders on one volume | `src/node/entry.ts` |

The application (`src/app.ts` and everything outside `src/cloudflare/` and `src/node/`) reaches data only through the `Db` and `FileStore` interfaces in `src/ports.ts`, and never imports a platform API.

## Develop

Requires Node 24 or later.

```sh
npm install
npm test            # both targets: npm run test:cf, then npm run test:node
npm run typecheck
```

`npm run test:cf` runs the tests inside the Workers runtime against local D1 and R2. `npm run test:node` runs the same tests against the SQLite and folder adapters, plus tests of the Node adapters' internals. Every test gets an empty database and empty file stores through the `#harness` alias.

### Run locally on the Workers runtime

```sh
npx wrangler dev
curl http://localhost:8787/healthz     # {"ok":true}
```

Put a local setup code, if needed, in `.dev.vars` (ignored by Git) as `SETUP_CODE=...`.

### Run locally on Node

```sh
npm run build
DATA_DIR=./.data node dist/node/entry.js
curl http://localhost:3000/healthz     # {"ok":true}
```

The Node entry reads `DATA_DIR` (required), `PORT` (default 3000), `SETUP_CODE` and `PUBLIC_IMAGE_BASE`, and applies any new files in `migrations/` before it listens.

## Run in a container

The image runs the Node target as user 1001, keeps everything it writes in the `/data` volume (`db.sqlite`, `drafts/`, `public/`), applies new migrations on start, reports health from `/healthz` and closes the database cleanly on `docker stop`. Base image: `node:26.13.1-alpine3.24`.

```sh
docker build -t demo-platform:dev .
docker run --rm -e SETUP_CODE=<at least 16 characters> -v demo-data:/data -p 127.0.0.1:3000:3000 demo-platform:dev
```

The setup code and every other setting are environment variables given at run time; none is built into the image. `.dockerignore` keeps `node_modules`, `.git`, data and env files out of the build context.

`deploy/docker-compose.yml` runs the app behind Caddy (`caddy:2.11.9-alpine`), which ends HTTPS for the domain and is the only service with published ports. Next to it go a `.env` file holding `DOMAIN`, `ACME_EMAIL`, `DATA_DIR` (a host folder owned by id 1001), `APP_IMAGE` and `SETUP_CODE`, and the `caddy/` folder with the Caddyfile. Caddy gets the certificate by itself once the domain's DNS record points at the server and ports 80 and 443 are open.

A consistent copy of the database, while the app keeps running:

```sh
docker compose exec app node dist/node/backup.js /data/db-copy.sqlite    # refuses to overwrite an existing file
```

`npm run test:container` (Bash and a local Docker engine) builds the image and checks it end to end: the user, no setup code in the image, health, migrations, the data surviving a new container on the same volume, a clean stop on SIGTERM, the backup command, and the compose stack with Caddy in front on `localhost` with its internal certificate. It publishes ports on 127.0.0.1 only and removes every container, volume and folder it created, keeping the image. Real certificate issuance needs a public domain and is not part of it.

## Layout

| Path | What it is |
|---|---|
| `src/ports.ts` | `Db`, `FileStore`, `Config`, `Deps` and `checkKey` |
| `src/app.ts` | `createApp(deps)`: routes and error handling |
| `src/auth.ts` | API tokens (only their SHA-256 hash is stored), ids, slugs and the request guard |
| `src/workspaces.ts` | Creating a workspace with its owner and first token |
| `src/cloudflare/` | D1 and R2 adapters and the Worker entry |
| `src/node/` | SQLite and folder adapters, migrations, the HTTP server, the database backup |
| `Dockerfile`, `deploy/` | The container image, the compose stack with Caddy, and its end-to-end check |
| `migrations/` | SQL migrations, one set for both targets |
| `test/contract/` | Adapter contract suites run against both targets |
| `wrangler.jsonc` | Worker bindings; the database id and bucket names are placeholders each install sets |

## Configuration

Nothing in the code is tied to a hostname, account or bucket name. `wrangler.jsonc` holds placeholders, and the setup code is a secret (`wrangler secret put SETUP_CODE`, or an environment variable in the container), never committed.
