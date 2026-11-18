# demo-platform

A self-hosted platform for interactive product tours. You record a click-through tour in Mythicshot, it uploads the tour here as a private draft with an API token, and once the tour is published a visitor clicks through it at `https://tours.example.com/t/<slug>`.

All rights reserved: see [LICENSE](LICENSE). The repository is private and no licence to use it is granted yet.

## Two ways to host it

| | Docker on Debian | Cloudflare |
|---|---|---|
| Runs on | One Debian server of yours, behind Caddy for HTTPS | Cloudflare Workers, with D1 and two R2 buckets |
| Address | Your own domain, with any DNS provider | Cloudflare's free `workers.dev` address to start; your own domain once it is active on your Cloudflare account |
| First command | `sudo bash install.sh`, on the server | `npm run setup:cloudflare`, on your computer |
| What it does | Installs Docker, writes the settings with a generated setup code, starts the app and gets the certificate | Creates the database and buckets, writes the settings, deploys and sets a generated setup code |
| Runbook | [docs/runbook-docker.md](docs/runbook-docker.md) | [docs/runbook-cloudflare.md](docs/runbook-cloudflare.md) |

Both guided commands say each step before doing it, are safe to run twice, never delete data, and print the setup code once at the end. On Cloudflare, attaching your own address replaces whatever DNS record that hostname had, so the command asks for a confirmation that `--yes` does not give.

### Quick start: Docker on Debian

1. Point an A record for `tours.example.com` at the server and open ports 80 and 443 to it.
2. Build the image on a computer with Docker (`docker build -t demo-platform:latest .`), save it with `docker save -o demo-platform.tar demo-platform:latest`, and copy that file and `deploy/install.sh` to the server.
3. On the server, run `sudo bash install.sh`. If it installs Docker first, it then stops and asks for the image: load it with `sudo docker load -i demo-platform.tar` and run `sudo bash install.sh` again.
4. Open `https://tours.example.com/setup` and enter the setup code the script printed.

The full steps, with what you need before you start, backup, restore, moving servers and troubleshooting, are in the [Docker runbook](docs/runbook-docker.md). Step-by-step guides for specific providers (DigitalOcean, AWS Lightsail, Azure, Akamai/Linode, Namecheap VPS and Fly.io) are in [docs/hosting](docs/hosting/README.md).

### Quick start: Cloudflare

No domain needed to start: the first choice is Cloudflare's free `workers.dev` address, and you can add your own address later.

1. In a copy of this repository, run `npm ci`, then `npx wrangler login` to sign in to your Cloudflare account.
2. Run `npm run setup:cloudflare` and answer its two questions: a name, and the address (the free address, or your own such as `tours.example.com`).
3. Open the setup wizard at the address it prints and enter the setup code it printed.

Add `--dry-run` (as `npm run setup:cloudflare -- --dry-run`) to see every command first. The full steps, with what you need before you start, using a domain registered elsewhere, the manual steps, update, backup and removal, are in the [Cloudflare runbook](docs/runbook-cloudflare.md).

It is built to run on Cloudflare's Free plan, which allows 50 subrequests and 10 ms of CPU time per request, and counts every D1 and R2 call as a subrequest ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). No request makes more than 40 database and storage calls, which the test suite checks for every route, and a large tour is published over several requests (see [Publish a tour](#publish-a-tour)). The CPU limit has only been estimated: the heaviest requests take about 5 to 8 ms of the app's own CPU in plain Node (see [Costs](docs/runbook-cloudflare.md#costs) in the runbook).

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
| `npm run setup:cloudflare` creates the database and both buckets, or reuses them | Have a Cloudflare account and sign Wrangler in |
| Writes this install's Wrangler settings, applies the migrations and deploys | For your own address: have its domain active on your Cloudflare account |
| Generates the setup code, stores it as a secret and prints it once | Export the database now and then and keep the export private |
| `update` applies new migrations, then deploys; `status` shows what exists | Watch the usage against the free plan's limits |
| Cloudflare runs the app, serves HTTPS, and creates the DNS record and certificate for your own address | Remove an install by hand, by the written procedure |
| Never deletes a database, bucket, Worker or secret; asks before taking over same-named ones or an address in use; D1 keeps its own point-in-time history (Time Travel) | Check what your own address is used for before attaching it: it is taken over |

## Connect Mythicshot

The setup wizard's last step shows the server address. In Mythicshot, open Settings › Output › Tour publishing, paste the server address and the API token from the wizard, and press Test connection. The token is shown once, by the wizard; keep it in a password manager.

## Publish a tour

Mythicshot uploads tours as drafts. To publish one, or take it down again, run the helper with the server address and the tour id; it reads the token from `DEMO_PLATFORM_TOKEN`, or asks for it without echoing it, and never takes it as an argument.

```sh
node scripts/publish.ts https://tours.example.com tour_0123456789abcdef01234567
```

```sh
node scripts/publish.ts https://tours.example.com tour_0123456789abcdef01234567 --unpublish
```

A large tour publishes over several requests, so the helper prints its progress (`Copying images: 24 of 60 done`) and keeps calling until the new version is live. Visitors see the previously published version until the last request. If the helper stops half-way (interrupted, a lost connection, or a 429 or 5xx answer), run the same command again: within 15 minutes it continues the same publish. After 15 minutes without progress, or if a chapter was uploaded to the tour in the meantime, that same run starts a new publish from the current draft and the half-done one is cleaned up. The previously published version is never touched by a publish that did not finish.

### The publish API

Every request carries `Authorization: Bearer <token>` and answers `404` for a tour of another workspace.

| Request | Answer |
|---|---|
| `POST /api/v1/tours/<id>/publish` with no body | Starts a publish, or joins the one in progress for the tour if it was built from the current draft; one built from an older draft is cancelled and a new one started. `202 {"status":"in_progress","publish_id":"pub_…","done":12,"total":60}`, or `200` at once for a small tour |
| `POST /api/v1/tours/<id>/publish` with `{"publish_id":"pub_…"}` | Copies the next images (up to 12): `202` as above while more remain; `200 {"slug","url","steps"}` once the new version is live, and the same `200` on any repeat |
| either, when that publish was stopped | `409 publish_cancelled`: the tour was unpublished, the publish failed or was abandoned, or a fresh start replaced it; publish again to start over. `409 publish_busy` means another start of the tour landed at the same moment: try again |
| `POST /api/v1/tours/<id>/unpublish` | `204` when the tour and all its public images are gone; `202` when the tour is unpublished but images remain to remove, so call again; a publish in progress is cancelled |

A publish works from the draft as it was when the publish started: calls naming it keep driving that version, so a chapter uploaded meanwhile goes out with the next publish, never half of it with this one. `400 empty_tour` and `413 too_large` (more than 400 steps, or a snapshot over 512,000 bytes) come from the first request, before anything is copied.

### The tour API

Mythicshot lists, renames and deletes tours with these requests. Each carries `Authorization: Bearer <token>`, acts only inside the token's workspace, and answers `404` for a tour of another workspace.

| Request | Answer |
|---|---|
| `GET /api/v1/me` | `200 {"workspace","version"}`: the workspace's name and the version of the server |
| `GET /api/v1/tours` | `200 {"tours":[…]}`, most recently changed first. Each tour has `id`, `title`, `status` (`draft` or `published`), `slug`, `url`, `chapters`, `steps`, `updated_at` and `published_at` (times in milliseconds). `url` is the public link as a path, `/t/<slug>`, to put after the server address; it and `published_at` are `null` for a draft |
| `PATCH /api/v1/tours/<id>` with `{"title":"New name"}` | `200 {"id","title"}` with the title as saved. The title follows the rule of a tour's title at upload: trimmed, 1 to 200 characters, no control or format characters; otherwise `400 bad_title` with the reason. The slug and the public link stay the same |
| `DELETE /api/v1/tours/<id>` | `200 {"deleted":true}` when nothing of the tour is left; `202 {"status":"in_progress","done":250,"total":601}` (files removed, of how many) when more remain, so call again; `409 publish_busy` while a publish of the tour is in progress; `404` once it is gone, the same answer as for a tour that never existed |

A rename shows on the public page of a published tour at once, without publishing again: the title is the one thing a rename changes in the published copy. A browser that already has the page keeps the old title for up to a minute.

> [!warning] Delete cannot be undone
> A deleted tour's steps, images and public page are gone for good; only a backup taken earlier brings them back.

Delete removes the tour, its chapters and steps, its draft images and logo, its published images (also those a re-publish replaced that were still being served), and any unfinished upload into it. A large tour takes several requests, each removing up to 250 files. From the first request on, the tour is gone from the list, cannot be published or added to, and the server answers `404` for its public page and images; the later requests only remove files. If a request fails or the client stops half-way, send the same request again: it carries on where it stopped. Delete does not stop a publish in progress: let it finish, or unpublish the tour, which stops the publish, then delete. A publish with no progress for 15 minutes no longer counts.

A repeated delete request after the tour is gone answers `404`, and the server cannot tell that from a tour that never existed. A client should treat `404` from a delete request as "gone": the tour is not there, which is what was asked for.

Deleting removes the files from the server; it cannot reach copies that were already handed out. A browser that opened the public page in the last minute may show it once more from its own cache, and images a visitor already downloaded stay in that browser's cache (published images are sent with a one-year cache lifetime, because their names never change). A CDN or caching proxy in front of the server can keep serving both for as long as it holds them; purge it there if that matters. The same holds after an unpublish.

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

`npm test` runs both targets: `npm run test:cf` runs the tests inside the Workers runtime against local D1 and R2, and `npm run test:node` runs the same tests against the SQLite and folder adapters, plus tests of the Node adapters' internals. Every test gets an empty database and empty file stores through the `#harness` alias. `test/docs.test.ts` checks this README and the runbooks: links, the commands and options of the install script and of `npm run setup:cloudflare`, the settings they name, and hostnames. `test/node-setup-cloudflare.test.ts` runs the guided Cloudflare setup against a recording stand-in for Wrangler, so no Cloudflare account is touched.

`npm run test:container` (Bash and a local Docker engine) builds the image and checks it end to end, including the compose stack with Caddy in front on `localhost` with its internal certificate. Real certificate issuance needs a public domain and is not part of it.

### Run locally on the Workers runtime

Create the tables in the local database first; without them `/healthz` still answers, but setup and every API route fail. Nothing here touches a Cloudflare account.

```sh
npx wrangler d1 migrations apply demo-platform --local
```

Copy `.dev.vars.example` to `.dev.vars` (ignored by Git) and put a generated code in it, as in step M7 of the [Cloudflare runbook](docs/runbook-cloudflare.md#m7-set-the-setup-code). Then start the server.

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
| `PUBLIC_IMAGE_BASE` | both | Empty (the default on both targets): the app serves published images itself on `/p/<name>`. Optionally, on Cloudflare, the address of the public bucket's own custom domain, such as `https://images.example.com`. |
| `DATA_DIR` | Node | The folder holding `db.sqlite`, `drafts/` and `public/`. Required. In the container it is `/data`. |
| `PORT` | Node | The port the app listens on. Default 3000. |
| `DB`, `DRAFTS`, `PUB` | Cloudflare | The D1 binding and the two R2 bindings in `wrangler.jsonc`; an install's names and id are in its `wrangler.deploy.jsonc`, written by `npm run setup:cloudflare`. |

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
| `scripts/setup-cloudflare.ts` | The guided Cloudflare setup, `npm run setup:cloudflare` |
| `migrations/` | SQL migrations, one set for both targets |
| `docs/` | The two hosting runbooks |
| `test/contract/` | Adapter contract suites run against both targets |
| `wrangler.jsonc` | Worker bindings; the database id and bucket names are placeholders. Each install's own copy is `wrangler.deploy.jsonc`, ignored by Git |

The application (`src/app.ts` and everything outside `src/cloudflare/` and `src/node/`) reaches data only through the `Db` and `FileStore` interfaces in `src/ports.ts`, and never imports a platform API.
