# demo-platform

A self-hosted platform for interactive product tours. You record a click-through tour in Mythicshot, it uploads the tour here as a private draft with an API token, and once the tour is published a visitor clicks through it at `https://tours.example.com/t/<slug>`.

All rights reserved: see [LICENSE](LICENSE). The repository is private and no licence to use it is granted yet.

## Two ways to host it

| | Docker on Debian | Cloudflare |
|---|---|---|
| Runs on | One Debian server of yours, behind Caddy for HTTPS | Cloudflare Workers, with D1 and two R2 buckets |
| DNS | Any DNS provider | The domain must be on your Cloudflare account |
| Runbook | [docs/runbook-docker.md](docs/runbook-docker.md) | [docs/runbook-cloudflare.md](docs/runbook-cloudflare.md) |

### Quick start: Docker on Debian

1. Point an A record for `tours.example.com` at the server and open ports 80 and 443 to it.
2. Build the image on a computer with Docker (`docker build -t demo-platform:latest .`), save it with `docker save -o demo-platform.tar demo-platform:latest`, and copy that file and `deploy/install.sh` to the server.
3. On the server, run `sudo bash install.sh`. If it installs Docker first, it then stops and asks for the image: load it with `sudo docker load -i demo-platform.tar` and run `sudo bash install.sh` again.
4. Open `https://tours.example.com/setup` and enter the setup code the script printed.

The full steps, with backup, restore, moving servers and troubleshooting, are in the [Docker runbook](docs/runbook-docker.md).

### Quick start: Cloudflare

1. Have the domain active on your Cloudflare account, then run `npm ci` and `npx wrangler login`.
2. Create the database and both buckets, put their names and id in `wrangler.jsonc`, and apply the migrations.
3. Give the public bucket its own hostname and set `PUBLIC_IMAGE_BASE` to it, add the Worker's hostname as a route, and run `npx wrangler deploy`.
4. Generate a setup code with `openssl rand -hex 16`, store it with `npx wrangler secret put SETUP_CODE`, then open `https://tours.example.com/setup`.

The full steps are in the [Cloudflare runbook](docs/runbook-cloudflare.md).

## Who does what

### Docker on Debian

| What the installer does for you | What is yours to do |
|---|---|
| Installs Docker Engine and the Compose plugin from Docker's apt repository | Register the domain and keep it renewed at the registrar |
| Writes the settings file with a generated setup code, and the stack files | Create the DNS record that points at the server |
| Gets and renews the HTTPS certificate (Caddy) | Open ports 80 and 443 on every firewall or router in front of the server |
| Starts the app and restarts it after a reboot | Keep Debian and Docker patched |
| `update` restarts on new images after a backup; `backup` writes an archive | Build and load new app images; copy every backup off the server and keep it private |
| Never deletes the data, the settings or a backup, except `uninstall --delete-data` after you type the domain | Restore from a backup when needed, by the written procedure |

### Cloudflare

| What the installer does for you | What is yours to do |
|---|---|
| Cloudflare runs the app, stores the data and images, and serves HTTPS | Have the domain on a Cloudflare account and change the nameservers at the registrar |
| Cloudflare creates the DNS records and certificates for the Worker's and the public bucket's hostnames | Create the database and both buckets, and give the public bucket its hostname |
| D1 keeps its own point-in-time history (Time Travel) | Generate and set the setup code as a secret, and deploy |
| | Export the database now and then and keep the export private |
| | Watch the usage against the free plan's limits |

## Connect Mythicshot

The setup wizard's last step shows the server address. In Mythicshot, open Settings › Output › Tour publishing, paste the server address and the API token from the wizard, and press Test connection. The token is shown once, by the wizard; keep it in a password manager.

## Develop

Requires Node 24 or later.

```sh
npm ci
```

```sh
npm test
```

```sh
npm run typecheck
```

`npm test` runs both targets: `npm run test:cf` runs the tests inside the Workers runtime against local D1 and R2, and `npm run test:node` runs the same tests against the SQLite and folder adapters, plus tests of the Node adapters' internals. Every test gets an empty database and empty file stores through the `#harness` alias. `test/docs.test.ts` checks this README and the runbooks: links, the install script's commands and options, the settings they name, and hostnames.

`npm run test:container` (Bash and a local Docker engine) builds the image and checks it end to end, including the compose stack with Caddy in front on `localhost` with its internal certificate. Real certificate issuance needs a public domain and is not part of it.

### Run locally on the Workers runtime

Create the tables in the local database first; without them `/healthz` still answers, but setup and every API route fail. Nothing here touches a Cloudflare account.

```sh
npx wrangler d1 migrations apply demo-platform --local
```

Copy `.dev.vars.example` to `.dev.vars` (ignored by Git) and put a generated code in it, as in step 9 of the [Cloudflare runbook](docs/runbook-cloudflare.md#9-set-the-setup-code). Then start the server.

```sh
npx wrangler dev
```

Then `curl http://localhost:8787/healthz` prints `{"ok":true}` and `/setup` opens the wizard. Leave `PUBLIC_IMAGE_BASE` empty locally: the app then serves published images itself on `/p/<name>` from the local public bucket. The local database and buckets live in `.wrangler/state`; delete that folder to start over.

### Run locally on Node

```sh
npm run build
```

```sh
DATA_DIR=./.data node dist/node/entry.js
```

Then `curl http://localhost:3000/healthz` prints `{"ok":true}`.

## Settings

Nothing in the code is tied to a hostname, account or bucket name.

| Setting | Target | What it is |
|---|---|---|
| `SETUP_CODE` | both | Opens the setup wizard once. At least 16 characters, generated, never committed. A Worker secret on Cloudflare; a line in the root-only `.env` in the container. |
| `PUBLIC_IMAGE_BASE` | both | The address published images are served from, such as `https://images.example.com` on Cloudflare. Empty in the container, where the app serves them itself. |
| `DATA_DIR` | Node | The folder holding `db.sqlite`, `drafts/` and `public/`. Required. In the container it is `/data`. |
| `PORT` | Node | The port the app listens on. Default 3000. |
| `DB`, `DRAFTS`, `PUB` | Cloudflare | The D1 binding and the two R2 bindings in `wrangler.jsonc`. |

The container stack's `.env`, written by `install.sh`, also holds `DOMAIN`, `ACME_EMAIL`, `DATA_DIR` (the folder on the host) and `APP_IMAGE`.

## Layout

| Path | What it is |
|---|---|
| `src/ports.ts` | `Db`, `FileStore`, `Config`, `Deps` and `checkKey` |
| `src/app.ts` | `createApp(deps)`: routes and error handling |
| `src/auth.ts` | API tokens (only their SHA-256 hash is stored), ids, slugs and the request guard |
| `src/setup.ts`, `src/setup/` | The first-run setup wizard |
| `src/cloudflare/` | D1 and R2 adapters and the Worker entry |
| `src/node/` | SQLite and folder adapters, migrations, the HTTP server, the database backup |
| `Dockerfile`, `deploy/` | The container image, the compose stack with Caddy, the install script and their tests |
| `migrations/` | SQL migrations, one set for both targets |
| `docs/` | The two hosting runbooks |
| `test/contract/` | Adapter contract suites run against both targets |
| `wrangler.jsonc` | Worker bindings; the database id and bucket names are placeholders each install sets |

The application (`src/app.ts` and everything outside `src/cloudflare/` and `src/node/`) reaches data only through the `Db` and `FileStore` interfaces in `src/ports.ts`, and never imports a platform API.
