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

## Layout

| Path | What it is |
|---|---|
| `src/ports.ts` | `Db`, `FileStore`, `Config`, `Deps` and `checkKey` |
| `src/app.ts` | `createApp(deps)`: routes and error handling |
| `src/auth.ts` | API tokens (only their SHA-256 hash is stored), ids, slugs and the request guard |
| `src/workspaces.ts` | Creating a workspace with its owner and first token |
| `src/cloudflare/` | D1 and R2 adapters and the Worker entry |
| `src/node/` | SQLite and folder adapters, migrations, the HTTP server |
| `migrations/` | SQL migrations, one set for both targets |
| `test/contract/` | Adapter contract suites run against both targets |
| `wrangler.jsonc` | Worker bindings; the database id and bucket names are placeholders each install sets |

## Configuration

Nothing in the code is tied to a hostname, account or bucket name. `wrangler.jsonc` holds placeholders, and the setup code is a secret (`wrangler secret put SETUP_CODE`, or an environment variable in the container), never committed.
