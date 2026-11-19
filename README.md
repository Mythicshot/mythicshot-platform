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

The full steps, with what you need before you start, backup, restore, moving servers and troubleshooting, are in the [Docker runbook](docs/runbook-docker.md). Step-by-step guides for specific providers (DigitalOcean, AWS Lightsail, Azure, Akamai/Linode, Namecheap VPS and Fly.io), and one for shared cPanel hosting without Docker, are in [docs/hosting](docs/hosting/README.md).

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

## API documentation

Every request a token can make is documented on the site itself, at `/docs`: what each request takes and answers, every error code and limit, three guides with commands to copy, and a "Try it" for each request. The page is open to anyone and needs no token to read. A token pasted there to try the calls is kept in that browser tab's memory only: it is never stored, and a reload forgets it.

The same reference as one file, for tools, is the OpenAPI 3.1 description at `/api/v1/openapi.json` and `/api/v1/openapi.yaml`. It names no host: its paths are relative to the address it was fetched from.

With two addresses the page is on the app address, and `/docs` on the tours address sends the browser there; the description answers on both. See [What answers where](#what-answers-where).

The description is written in `src/docs/openapi.ts`, and the tests hold it equal to the routes and to what they really answer; the guides are in `src/docs/guides.ts`, and a test runs every command in them against the real routes. After changing either, or anything under `src/docs/client/`, run the command below and commit the two generated files it writes, `src/docs/site-assets.ts` and `src/docs/viewer-assets.ts`.

```sh
npm run build:docs
```

The reference is shown with Swagger UI, used under the Apache License 2.0. Its files are built into the app, so the page loads nothing from any other site. Its licence notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and every install serves them at `/docs/licences.txt`.

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

The full reference for these requests, with every answer, error code and limit, is the site's own documentation page at `/docs` (see [API documentation](#api-documentation)); this section is the short version.

Every request carries `Authorization: Bearer <token>` and answers `404` for a tour of another workspace.

| Request | Answer |
|---|---|
| `POST /api/v1/tours/<id>/publish` with no body | Starts a publish, or joins the one in progress for the tour if it was built from the current draft; one built from an older draft is cancelled and a new one started. `202 {"status":"in_progress","publish_id":"pub_…","done":12,"total":60}`, or `200` at once for a small tour |
| `POST /api/v1/tours/<id>/publish` with `{"publish_id":"pub_…"}` | Copies the next images (up to 12): `202` as above while more remain; `200 {"slug","url","steps"}` once the new version is live, and the same `200` on any repeat |
| either, when that publish was stopped | `409 publish_cancelled`: the tour was unpublished, the publish failed or was abandoned, or a fresh start replaced it; publish again to start over. `409 publish_busy` means another start of the tour landed at the same moment, or the tour's draft changed twice (chapters uploaded or replaced) while this publish was starting; nothing was written: try again. A single such change does not show: the request starts again from the newer draft by itself |
| `POST /api/v1/tours/<id>/unpublish` | `204` when the tour and all its public images are gone; `202` when the tour is unpublished but images remain to remove, so call again; a publish in progress is cancelled |

A publish works from the draft as it was when the publish started: calls naming it keep driving that version, so a chapter uploaded meanwhile goes out with the next publish, never half of it with this one. `400 empty_tour` and `413 too_large` (more than 400 steps, or a snapshot over 512,000 bytes) come from the first request, before anything is copied.

### The tour API

The full reference for these requests, with every answer, error code and limit, is the site's own documentation page at `/docs` (see [API documentation](#api-documentation)); this section is the short version.

Mythicshot lists, renames and deletes tours with these requests. Each carries `Authorization: Bearer <token>`, acts only inside the token's workspace, and answers `404` for a tour of another workspace.

| Request | Answer |
|---|---|
| `GET /api/v1/me` | `200 {"workspace","version"}`: the workspace's name and the version of the server. With two addresses the answer also has `addresses`, the two host names; see [One address or two](#one-address-or-two) |
| `GET /api/v1/tours` | `200 {"tours":[…]}`, most recently changed first. Each tour has `id`, `title`, `status` (`draft` or `published`), `slug`, `url`, `chapters`, `steps`, `updated_at`, `published_at` (times in milliseconds) and `unpublished_changes`. `url` is the public link as a path, `/t/<slug>`, to put after the server address; it and `published_at` are `null` for a draft. `unpublished_changes` is `true` when the tour is published and its draft holds a chapter upload or update that is not on the public page yet, so publishing it again would change what visitors see, and also when the site cannot tell, which happens only for some tours last published before version 0.1.4; it is `false` for a draft, and for a published tour whose page is up to date (a rename is live at once and never sets it) |
| `PATCH /api/v1/tours/<id>` with `{"title":"New name"}` | `200 {"id","title"}` with the title as saved. The title follows the rule of a tour's title at upload: trimmed, 1 to 200 characters, no control or format characters; otherwise `400 bad_title` with the reason. The slug and the public link stay the same |
| `DELETE /api/v1/tours/<id>` | `200 {"deleted":true}` when nothing of the tour is left; `202 {"status":"in_progress","done":250,"total":601}` (files removed, of how many) when more remain, so call again; `409 publish_busy` while a publish of the tour is in progress; `404` once it is gone, the same answer as for a tour that never existed |

A rename shows on the public page of a published tour at once, without publishing again: the title is the one thing a rename changes in the published copy. A browser that already has the page keeps the old title for up to a minute.

> [!warning] Delete cannot be undone
> A deleted tour's steps, images and public page are gone for good; only a backup taken earlier brings them back.

Delete removes the tour, its chapters and steps, its draft images and logo, its published images (also those a re-publish replaced that were still being served), the draft pictures a chapter replace took out of it that were not removed yet, and any unfinished upload into it. A large tour takes several requests, each removing up to 250 files. From the first request on, the tour is gone from the list, cannot be published or added to, and the server answers `404` for its public page and images; the later requests only remove files. If a request fails or the client stops half-way, send the same request again: it carries on where it stopped. Delete does not stop a publish in progress: let it finish, or unpublish the tour, which stops the publish, then delete. A publish with no progress for 15 minutes no longer counts.

A repeated delete request after the tour is gone answers `404`, and the server cannot tell that from a tour that never existed. A client should treat `404` from a delete request as "gone": the tour is not there, which is what was asked for.

Deleting removes the files from the server; it cannot reach copies that were already handed out. A browser that opened the public page in the last minute may show it once more from its own cache, and images a visitor already downloaded stay in that browser's cache (published images are sent with a one-year cache lifetime, because their names never change). A CDN or caching proxy in front of the server can keep serving both for as long as it holds them; purge it there if that matters. The same holds after an unpublish.

### Replace a chapter

The full reference for these requests, with every answer, error code and limit, is the site's own documentation page at `/docs` (see [API documentation](#api-documentation)); this section is the short version.

Mythicshot updates a tour it published earlier by replacing one chapter over the same link. It uses the upload requests a new tour uses (create, one request per step image, commit, or abort), with the target `replace`. Each carries `Authorization: Bearer <token>` and acts only inside the token's workspace.

A replace changes the draft only. The public page and its images stay exactly as they were until the tour is published again, and a draft stays a draft.

| Request | Answer |
|---|---|
| `POST /api/v1/uploads` with `{"manifest":{…},"target":{"kind":"replace","tour_id":"tour_…","chapter_id":"ch_…"},"sha256":["<64 lowercase hex>",…]}` | `201 {"upload_id":"up_…","steps":14,"have":[1,4,5],"settings":false}`. `sha256` is optional: one SHA-256 per step of the manifest, in order, of the image the client would send. `have` lists the step numbers whose image the chapter already has, so the client does not send them; it is empty without `sha256`. `settings` is `true` when the chapter is the tour's first |
| the same, refused | `404 not_found` with detail `no such tour` (unknown, another workspace's, or not an id) or `no such chapter` (not a chapter of that tour); `400 bad_request` for a `sha256` that is not exactly one 64-character lowercase hex text per step, or that comes with another target; `400 bad_manifest`, `413 too_large`, `413 storage_full` (see [Storage allowance](#storage-allowance)) and `429 too_many_uploads` as for any upload. A server older than 0.1.4 answers `400 bad_target` |
| `PUT /api/v1/uploads/<id>/steps/<n>` with the image | `204`; `409 already_sent` for a step in `have`, or one sent before |
| `PUT /api/v1/uploads/<id>/logo` with the logo | `204` when `settings` is `true` and the manifest names a logo; `404` when the manifest names no logo; `409 logo_not_used` when `settings` is `false` |
| `POST /api/v1/uploads/<id>/commit` | `201 {"tour_id":"tour_…","chapter_id":"ch_…","steps":14,"publish":"ready"}`. The chapter keeps its id, title and position and now has exactly the manifest's steps |
| the same, refused | `409 incomplete` while a step outside `have` (or a logo the upload must carry) has not been sent, and nothing changes; `409 chapter_changed` when another upload replaced the chapter since this one was created, and nothing changes: abort this upload and start again; `404` once the upload was aborted |
| `DELETE /api/v1/uploads/<id>` | `204`. Removes only what this upload stored, never an image the chapter uses |

The server finds the images a chapter already has by a SHA-256 it computed itself when each image was stored, and only when the step's declared type, width, height and byte count match too. A tour uploaded to a server older than 0.1.4 has no such record, so its first replace sends every image.

`publish` in the commit's answer says what publishing the tour would do now:

| `publish` | Meaning |
|---|---|
| `draft` | The tour is not published. Nothing is public and nothing needs publishing |
| `ready` | The tour is published and the only changes that are not public yet are replaces of this chapter (this one, and any before it that were not published, for example because the publish after them failed). Publish it to put the update live |
| `other_changes` | The tour is published and its draft holds more than replaces of this chapter that was never published: a chapter uploaded as a draft, a replace of another chapter that was not published, or, for a tour last published under a server older than 0.1.4, a chapter that was already waiting unpublished when the server was updated (the update to 0.1.4 records a published tour as fully public only when the published copy has every step of the draft; a rename since the last publish does not matter). Publishing would put all of it live, so Mythicshot uploads the update and leaves publishing to you |

When `settings` is `true`, the commit also replaces the tour's theme, zoom, spotlight dim, cover, button, end card, autoplay and logo with the manifest's; a manifest that names no logo removes the tour's. When it is `false`, the tour keeps all of these. A replace never changes the tour's title or its link.

Every request is safe to send again. A repeated create only makes another upload, which is removed by an abort or, left alone, after 24 hours. A repeated commit answers `201` with the same ids and steps, and with `publish` as it stands at that moment; once a later replace of the same chapter has been committed, it answers `404`, because the chapter no longer holds that upload's steps. Images the replace took out of the chapter are deleted from the server right after the commit, or with a later request if a publish of the older draft is still copying them.

## Storage allowance

A workspace can have a storage allowance: a number of bytes it may use. There is none by default, so a site that sets nothing never refuses an upload for storage and behaves as before.

The setting is `STORAGE_ALLOWANCE_BYTES` (see [Settings](#settings)): the allowance of every workspace, in bytes, digits only. A workspace can also carry a number of its own in the database, which then comes before the setting. On Cloudflare the setting is a var in the install's `wrangler.deploy.jsonc`, written as text, such as `"STORAGE_ALLOWANCE_BYTES": "1073741824"`; `npm run setup:cloudflare -- update` keeps it.

| | What |
|---|---|
| Counted | The image of every step of every tour, published or not; each tour's logo; and the room every unfinished upload holds from the moment it is started (all its images as the manifest gives them, and for a logo it carries the `logo_bytes` it was started with, or 200,000 bytes without, until the logo's real size is recorded when the upload is finished) until it is finished, aborted or removed |
| Not counted | The copies of images a published tour serves, so a fully published workspace can hold about twice its count on disk; images that wait to be removed after a delete or a replace; a logo stored by a server older than 0.1.8; the database itself |

`GET /api/v1/usage`, with a token, answers the workspace's own numbers, on either address:

```
{"used_bytes":4700,"allowance_bytes":1073741824,"over":false,"tours":1,"counted":{"pictures":3000,"logos":1000,"uploads_in_progress":700}}
```

`allowance_bytes` is `null` when there is no limit. `over` is `true` when more is used than the allowance.

An upload that would take the workspace over its allowance is refused when it is started, by `POST /api/v1/uploads`, before any image is sent. Nothing is stored and no upload exists afterwards. The answer is `413` with the numbers in bytes and one sentence a program can show as it is:

```
{"error":"storage_full","detail":"this tour needs 14.2 MB of room, but the workspace has 3.10 MB left of its 1.00 GB allowance. Nothing was uploaded. Delete tours you no longer need, or ask the site's admin for more room","used_bytes":1070491238,"allowance_bytes":1073741824,"needed_bytes":14889779}
```

A new tour or a new chapter needs room for all its images. Replacing a chapter needs room only for what its images come to above the chapter's present ones.

An upload that carries a logo (a new tour, or an update of a tour's first chapter, when the manifest names a logo) also needs room for the logo. The create request can say the logo's size with an optional `logo_bytes` beside `manifest` and `target`, a whole number from 1 to 200,000: the upload then needs exactly that much room for the logo, and the logo sent must have exactly that length (`400 bad_image` otherwise). Without `logo_bytes`, an upload that carries a logo needs up to 200,000 bytes of room for it. For an update, only what the logo's room comes to above the size recorded for the tour's present logo is needed; a logo stored by a server older than 0.1.8 has no recorded size and counts as 0, so the first update after it needs room for the whole logo.

So an update that does not grow the chapter works in a full workspace when it carries no logo, or when it gives a `logo_bytes` no larger than the present logo's recorded size. Without `logo_bytes`, an update of a first chapter with a logo needs up to 200,000 bytes free even when nothing changed.

Deleting a tour makes room at once; waiting alone does not. An upload nobody finished keeps its room until it is removed, and it is removed when the workspace next starts an upload once it is more than 24 hours old, not by the clock alone. Until then `GET /api/v1/usage` still counts it.

> [!warning] Lowering an allowance deletes nothing
> A workspace that is over its allowance keeps every tour, link and image: listing, publishing, unpublishing, renaming, deleting and updates that need no room still work, and only new tours, new chapters and updates that need room (a larger chapter, or a logo sent without its size) are refused until tours are deleted or the allowance is raised.

## One address or two

By default the platform serves one address and checks no host name: it answers the same on every name that reaches it. That is one-address mode, and it is all a tour site needs today.

With two addresses the platform knows two host names and the role of each: the tours address, such as `tours.example.com`, where visitors open tours, and the app address, such as `app.example.com`. Two settings turn it on, `TOURS_HOST` and `APP_HOST`, each a host name without `https://` and without a path. Set both for two addresses, or neither for one.

> [!warning] Never run on real hosting
> Nothing about two addresses has been run on real hosting yet: it is checked by this repository's tests only, so turn it on only after a backup and when the site may be down for a while.

### What answers where

| Request | Tours address | App address | Any other host name |
|---|---|---|---|
| A tour page, `/t/<slug>` | Answers | `308` to the same path and query on the tours address | `421` |
| A published picture, `/p/<name>` | Answers | `308`, as for a tour page; the picture itself is never sent from the app address | `421` |
| The token API, `/api/v1/…` | Answers | Answers, the same as on the tours address | `421` |
| The setup wizard, `/setup` and what it loads | Answers | `404` with `{"error":"not_found"}` | `421` |
| The player's script and stylesheet | Answers | `404` with `{"error":"not_found"}` | `421` |
| The documentation page, `/docs` | `308` to `/docs` on the app address, with the same query | Answers | `421` |
| What the documentation page loads, and `/docs/licences.txt` | `404` with `{"error":"not_found"}` | Answers | `421` |
| The API description, `/api/v1/openapi.json` and `/api/v1/openapi.yaml` | Answers | Answers, the same as on the tours address | `421` |
| `/healthz` | Answers, and names the role | Answers, and names the role | Answers, without a role |

A host name that is neither of the two gets an empty `421` on every path except `/healthz`, whether the path exists or not: no body and no content type, so the answer says nothing about the site. The check reads no token and makes no database or storage call.

The redirect is a `308` whose `Location` is `https://` (plain `http://` only when the tours host is a `localhost` name or `127.0.0.1`) plus the configured tours host plus the request's own path and query; nothing in it comes from a header. It is sent with `Cache-Control: no-store`, so a browser does not remember a wrong setting. The documentation page's redirect is built the same way from the configured app host. The app address redirects only tour pages and pictures, and the tours address only `/docs`, which the app address answers itself, so a redirect cannot loop.

`/healthz` answers on every host name, because a container's own health check asks by an internal name. Asked on the tours address it prints `{"ok":true,"address":"tours"}`, on the app address `{"ok":true,"address":"app"}`, and on any other name, or with one address, `{"ok":true}`. The install scripts use this to check that each address reaches the platform under its own name.

`GET /api/v1/me` adds the two host names as configured, without a scheme: `{"workspace":"Acme Tours","version":"…","addresses":{"tours":"tours.example.com","app":"app.example.com"}}`. With one address the key is absent and the answer is as before. The `url` of a tour in the tour list and in the publish answer stays the path `/t/<slug>` on both addresses.

Mythicshot keeps the tours address. The setup wizard is on the tours address only, the server address it shows is that one, and Mythicshot builds every tour link from the server address it was given. Pointed at the app address its uploads would still work, but the links it shows would be on the app address and reach the tour only through the redirect.

The host name is taken from the address the request was sent to: the `Host` header on Node, the request's own address on Cloudflare. No `X-Forwarded-Host`, `Forwarded` or `X-Original-Host` header is read, and there is no setting to trust one, so whatever stands in front of the platform must pass the `Host` header on unchanged. On Node with two addresses, a request whose request line holds a full address instead of a path gets the empty `421` too.

### A pair that cannot be used

One setting without the other, a value that is not a plain host name, or the same name twice (also on two different ports) is never read as one address. On Node the app does not start: it prints one of the lines below and exits with code 1, before it opens the database. A Worker cannot refuse to start, so on Cloudflare every request, `/healthz` included, answers `500` with `{"error":"misconfigured"}`, and the line is in the Worker's log.

```text
TOURS_HOST is set but APP_HOST is not. Set both for two addresses, or neither for one.
APP_HOST is set but TOURS_HOST is not. Set both for two addresses, or neither for one.
TOURS_HOST is not a host name. Write it like tours.example.com, without https:// and without a path.
APP_HOST is not a host name. Write it like app.example.com, without https:// and without a path.
TOURS_HOST and APP_HOST name the same host. Two addresses need two different host names.
```

> [!warning] A wrong name locks the site out
> A well-formed but wrong name in `TOURS_HOST` makes the platform refuse its own address, every tour link and Mythicshot included, until the name is fixed or both settings are removed.

### Turn it on, and go back

| Route | How two addresses are turned on |
|---|---|
| Docker on Debian | `--app-domain=<name>` on a first install, or one `APP_DOMAIN` line added to `.env` by hand on an existing one; the script then checks both addresses by their role. See [Two addresses](docs/runbook-docker.md#two-addresses) in the Docker runbook. |
| Shared cPanel hosting | Two lines added to the settings file by hand, then `cpanel.sh` checks both addresses. See [A second address for the app](docs/hosting/cpanel.md#14-a-second-address-for-the-app) in that guide. |
| Cloudflare | Not yet. The guided setup sets up one address and writes both settings empty; a second address there waits for a later version. See [Two addresses](docs/runbook-cloudflare.md#two-addresses) in the Cloudflare runbook. |
| Node, started by hand | Set `TOURS_HOST` and `APP_HOST` in the environment the app starts with. |

To go back to one address, remove both settings (on Docker, the `APP_DOMAIN` line) and restart the app; each of the three pages above gives the steps. The tours address is the same name before and after, so links to tours that are already out there keep working both ways.

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

`npm run test:cpanel` (Bash and a local Docker engine) tests the shared cPanel hosting script, `deploy/cpanel/cpanel.sh`: it runs `deploy/cpanel/test-cpanel.sh` in a Debian 13 and a Debian 12 container without network, where the script runs against stand-ins for the hosting's commands. No hosting is contacted. It is not part of `npm test`.

`npm run test:node` covers the rest of that route: `test/node-cpanel-app.test.ts` starts the startup file with Node, `test/node-cpanel-package.test.ts` builds the archive and reads it back, and `test/node-cpanel-script.test.ts` runs the one test of the Bash file that needs a real Node, the backup's copy of a database in use. That one needs Bash (on Windows, the one that comes with Git) and is skipped with the reason where there is none.

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
| `TOURS_HOST` | both | Optional, and only together with `APP_HOST`: the host name of the tours address, such as `tours.example.com`, without `https://` and without a path. Both empty or unset (the default) is one address, and no host name is checked. See [One address or two](#one-address-or-two). |
| `APP_HOST` | both | Optional, and only together with `TOURS_HOST`: the host name of the app address, such as `app.example.com`, in the same form. It must be a different name than the tours address. |
| `STORAGE_ALLOWANCE_BYTES` | both | Optional: the storage allowance of a workspace in bytes, digits only, such as `1073741824` for 1 GB. Unset or empty (the default): no limit. See [Storage allowance](#storage-allowance). Any other value stops the start on Node with one line, and on Cloudflare answers 500 `misconfigured` on every path until it is fixed. |
| `SITE_HOST` | both | Optional, for a site on one address only: the host name sign-in links use, such as `tours.example.com`, without `https://` and without a path. Ignored when `APP_HOST` is set, since links then use the app address. It is used for links only, and no request is checked against it. A value that is not a host name never stops the site: it then has no address for links, and no sign-in mail is sent. |
| `INVITE_CONTACT` | both | Optional: who to ask for an invite, an email address such as `hello@example.com` or an `https://` address, shown after "Mythicshot is invite-only for now." on the sign-in page; unset or anything else shows that sentence alone and never stops the site. |
| `MAIL_MODE` | Node | `off` (the default, also when unset) or `smtp`. With `off` the site sends no mail and reads none of the mail settings below. With `smtp` it sends sign-in mails through the mail server those settings name. Mail that is switched on but cannot be used (a mail setting that is missing or malformed, or no address for links from `APP_HOST` or `SITE_HOST`) never stops the site: mail stays off, and the start writes one line that names the setting and never a value. A Cloudflare install sends no mail in this version. |
| `MAIL_FROM` | Node | With `MAIL_MODE=smtp`: the sender's address, such as `no-reply@example.com`, the address alone without a name around it. |
| `SMTP_HOST` | Node | With `MAIL_MODE=smtp`: the host name of the mail server, such as `mail.example.com`, without a port. |
| `SMTP_PORT` | Node | With `MAIL_MODE=smtp`: the mail server's port for SMTP over TLS. Default 465. The connection is encrypted from its first byte on whatever port is given; a port that expects STARTTLS (usually 587) does not work. |
| `SMTP_USER` | Node | With `MAIL_MODE=smtp`: the name the mailbox signs in with, often the same as the sender's address. |
| `SMTP_PASSWORD` | Node | With `MAIL_MODE=smtp`: the mailbox's password. A secret: it belongs in the environment or the settings file only, like `SETUP_CODE`, and the site never writes it to the database, a log or an answer. |
| `CLIENT_ADDRESS_HEADER` | Node | Optional, and only for a site behind a proxy: the name of the header in which the proxy writes the visitor's network address, such as `X-Real-IP`. The last value of that header is then taken as the visitor's address, for rate limits only. Unset (the default): the address of the connection itself, which is right only when visitors connect to the app directly. Behind a proxy the connection is the proxy's: when the proxy hands requests over a local socket or from a private address, as shared hosting and the container stack do, the address is then unknown, and limits per network are not applied (the limits per recipient and on mails sent still are). The header's value must be the bare address, such as `203.0.113.7` or `2001:db8::1`: with a port, in brackets or with a label such as `for=`, it is not taken and the address is unknown. With two proxies in a chain that each add to the header, the last value is the one written by the proxy next to the app, which is the address of the outer proxy, not the visitor's: name a header the outer proxy sets and the inner one passes on unchanged. Set it only to a header your own proxy writes on every request, or a visitor could choose the address. A value that is not a header name, or names a header of which only the first value is kept (`Host`, `From`, `Referer`, `User-Agent`, `Authorization`, `Cookie`, `Content-Type`, `Content-Length` and the like), never stops the site: no visitor's address is then known, and the start writes one line. On Cloudflare the address is the connecting one and this setting is not read. |
| `RECOVERY_LINKS` | Node | Read by the server's admin command only, never by the app or the API: `on` (any case, spaces around it allowed) lets the command print a sign-in link for an account that exists, as a recovery tool; anything else, or unset (the default), is off. Add the line for one run and remove it right after: do not leave it on. The command never reads it from its own environment: through `cpanel.sh admin` it is the settings file's line, and run directly, as in the container, it is what the environment of the container's first process (the app, started from `.env`) says, so the line goes in `.env` and the container is recreated; `docker compose exec -e` does not open it. It keeps the command from being a standing way in; it is no defence against someone who can already change the settings file or the data. |
| `DATA_DIR` | Node | The folder holding `db.sqlite`, `drafts/` and `public/`. Required. In the container it is `/data`. |
| `PORT` | Node | The port the app listens on. Default 3000. |
| `DB`, `DRAFTS`, `PUB` | Cloudflare | The D1 binding and the two R2 bindings in `wrangler.jsonc`; an install's names and id are in its `wrangler.deploy.jsonc`, written by `npm run setup:cloudflare`. |

The container stack's `.env`, written by `install.sh`, also holds `DOMAIN`, `ACME_EMAIL`, `DATA_DIR` (the folder on the host) and `APP_IMAGE`, and for two addresses `APP_DOMAIN`, the app address: the stack then gives the app `TOURS_HOST` (from `DOMAIN`) and `APP_HOST` (from `APP_DOMAIN`) itself, and a `TOURS_HOST` or `APP_HOST` line in that `.env` has no effect.

### The mail settings in a settings file

Mail is off until `MAIL_MODE=smtp` is set together with `MAIL_FROM`, `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` (and `SMTP_PORT` when the mail server does not use 465); a site on one address also needs `SITE_HOST`. The site checks the settings when it starts and does not contact the mail server then: a wrong password, a wrong host name or a wrong port shows only when the first mail is tried.

The site refuses an `SMTP_PASSWORD` that is empty, longer than 255 characters, or holds a control character such as a tab or a line break; mail then stays off and the start says so in one line that names the setting. Any other password is used exactly as the site receives it, spaces at either end included. What the site receives depends on who reads the file:

- **Shared hosting (the settings file beside the app folder).** Each line is a setting's name, `=`, and its value. Spaces at the start and the end of the line are removed, so a value cannot end in a space unless it is quoted. One pair of matching quotes around the whole value, double or single, is removed. Everything else is kept as written: `#`, `=`, `$`, a backslash, spaces inside and quotes inside mean themselves, and nothing is an escape. A line that starts with `#` is a comment, and a setting already present in the app's environment wins over the file. The rule that always works: write the password in double quotes, `SMTP_PASSWORD="<password>"`.
- **The container install (`.env` beside `docker-compose.yml`).** Docker Compose reads this file, by its own rules: in a value without quotes or in double quotes, `$` starts a substitution, and without quotes a `#` after a space starts a comment; a value in single quotes is taken as written. So write the password in single quotes there, `SMTP_PASSWORD='<password>'`, and choose a password without a single quote in it. Restart the stack after a change, and check the result with the admin command's mail check rather than by reading the file.
- **The environment itself (Fly secrets, a process manager).** The value arrives as it was set.

> [!warning] Backups hold the mailbox password
> Every backup the hosting script makes (`backup`, and `update` before it changes anything) holds a copy of the settings file, the mailbox password included: keep each backup as private as the file itself, and change the mailbox password if one leaves your hands.

## Layout

| Path | What it is |
|---|---|
| `src/ports.ts` | `Db`, `FileStore`, `Config`, `Deps` and `checkKey` |
| `src/app.ts` | `createApp(deps)`: routes and error handling |
| `src/auth.ts` | API tokens (only their SHA-256 hash is stored), ids, slugs and the request guard |
| `src/setup.ts`, `src/setup/` | The first-run setup wizard |
| `src/docs/` | The API documentation: the description (`openapi.ts`), the guides, the page and its routes, the page script and stylesheet (`client/`), and the two generated modules |
| `scripts/docs-bundle.ts`, `scripts/build-docs.ts` | Build the two generated modules of the documentation page, `npm run build:docs` |
| `src/cloudflare/` | D1 and R2 adapters and the Worker entry |
| `src/node/` | SQLite and folder adapters, migrations, the HTTP server, the database backup |
| `Dockerfile`, `deploy/` | The container image, the compose stack with Caddy, the install script and their tests |
| `scripts/setup-cloudflare.ts` | The guided Cloudflare setup, `npm run setup:cloudflare` |
| `deploy/cpanel/`, `scripts/package-cpanel.ts` | Shared cPanel hosting: the startup file, the install script and its tests, and the archive builder, `npm run package:cpanel` |
| `migrations/` | SQL migrations, one set for both targets |
| `docs/` | The two hosting runbooks, the hosting guides, and the list of what to check on the documentation page in a browser |
| `test/contract/` | Adapter contract suites run against both targets |
| `wrangler.jsonc` | Worker bindings; the database id and bucket names are placeholders. Each install's own copy is `wrangler.deploy.jsonc`, ignored by Git |

The application (`src/app.ts` and everything outside `src/cloudflare/` and `src/node/`) reaches data only through the `Db` and `FileStore` interfaces in `src/ports.ts`, and never imports a platform API.
