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

The server can also give Mythicshot a token of its own without copying one, with a pair of codes. Mythicshot asks the server for them (`POST /api/v1/connect/start`, with no credential), shows a short code such as `ABCD-EFGH` and opens the dashboard's Connections page (`/connections`); a person signed in to the site types the short code there, sees the device's name and whether they are on the network Mythicshot asked from, and confirms it, and Mythicshot, which keeps asking with its long secret code, then receives a token for that person's workspace, once, with the username of whoever confirmed. Once it has, the account that confirmed gets one mail at its address naming the computer and the time and linking to the Connections page, so a connection nobody meant to make is noticed; the token's answer is the same whether or not that mail goes. Signing out before Mythicshot collects the token cancels it. The codes live 10 minutes, are never put in an address, and are stored only as digests. Signed-in people list, rename and revoke their workspace's tokens with `GET /api/v1/tokens`, `PATCH /api/v1/tokens/<id>` and `DELETE /api/v1/tokens/<id>`; a token cannot do any of that, and a revoked token is refused from its next request on. The dashboard pages for this come in a later version; the requests are described at `/docs`.

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
| `GET /api/v1/tours` | `200 {"tours":[…]}`, most recently changed first. Each tour has `id`, `title`, `status` (`draft` or `published`), `slug`, `url`, `chapters`, `steps`, `bytes` (its size: its steps' images and its logo, counted as `GET /api/v1/usage` counts them), `updated_at`, `published_at` (times in milliseconds) and `unpublished_changes`. `url` is the public link as a path, `/t/<slug>`, to put after the server address; it and `published_at` are `null` for a draft. `unpublished_changes` is `true` when the tour is published and its draft holds a chapter upload or update that is not on the public page yet, so publishing it again would change what visitors see, and also when the site cannot tell, which happens only for some tours last published before version 0.1.4; it is `false` for a draft, and for a published tour whose page is up to date (a rename is live at once and never sets it) |
| `PATCH /api/v1/tours/<id>` with `{"title":"New name"}` | `200 {"id","title"}` with the title as saved. The title follows the rule of a tour's title at upload: trimmed, 1 to 200 characters, no control or format characters; otherwise `400 bad_title` with the reason. The slug and the public link stay the same |
| `DELETE /api/v1/tours/<id>` | `200 {"deleted":true}` when nothing of the tour is left; `202 {"status":"in_progress","done":250,"total":601}` (files removed, of how many) when more remain, so call again; `409 publish_busy` while a publish of the tour is in progress; `404` once it is gone, the same answer as for a tour that never existed |

A rename shows on the public page of a published tour at once, without publishing again: the title is the one thing a rename changes in the published copy. A browser that already has the page keeps the old title for up to a minute.

> [!warning] Delete cannot be undone
> A deleted tour's steps, images and public page are gone for good; only a backup taken earlier brings them back.

Delete removes the tour, its chapters and steps, its draft images and logo, its published images (also those a re-publish replaced that were still being served), the draft pictures a chapter replace took out of it that were not removed yet, and any unfinished upload into it. A large tour takes several requests, each removing up to 250 files. From the first request on, the tour is gone from the list, cannot be published or added to, and the server answers `404` for its public page and images; the later requests only remove files. If a request fails or the client stops half-way, send the same request again: it carries on where it stopped. Delete does not stop a publish in progress: let it finish, or unpublish the tour, which stops the publish, then delete. A publish with no progress for 15 minutes no longer counts.

A repeated delete request after the tour is gone answers `404`, and the server cannot tell that from a tour that never existed. A client should treat `404` from a delete request as "gone": the tour is not there, which is what was asked for.

Deleting removes the files from the server; it cannot reach copies that were already handed out. A browser that opened the public page in the last minute may show it once more from its own cache, and images a visitor already downloaded stay in that browser's cache (published images are sent with a one-year cache lifetime, because their names never change). A CDN or caching proxy in front of the server can keep serving both for as long as it holds them; purge it there if that matters. The same holds after an unpublish.

### Who may view a tour

Each tour has a viewing setting: `public` (anyone with the link, the default and how every tour worked before 0.1.36), `people` (the addresses on the tour's list, and the workspace's own account) or `me` (the workspace's own account alone). The list holds up to 200 addresses and is kept when the setting moves away from `people`. The workspace's account is matched by its address as it is at the moment of the check, so an email change counts at once.

| Request | Answer |
|---|---|
| `GET /api/v1/tours/<id>/access` | `200 {"access","viewers":[…],"limit":200,"can_restrict","switching"}` to a signed-in session: the setting, the whole list, whether the site can mail (which making a public tour `people` or `me` needs), and `{"done","total"}` while the live pictures move, else `null`. A token gets `{"access","viewers_count","limit","can_restrict","switching"}`: how many addresses, never the addresses |
| `PUT /api/v1/tours/<id>/access` with `{"access":"people","viewers":["ana@example.com"]}`, from a signed-in session (a token is answered `401`) | `200` with the same answer once done. `viewers` replaces the whole list; leave it out to keep the list. A published tour between `public` and the other two answers `202 {"status":"switching","done","total"}` while its pictures move: send the same request until `200`. Refusals: `400 bad_access`, `400 bad_viewer` (names the entry's position, never an address), `400 too_many_viewers`, `409 cannot_restrict` for a public tour on a site without mail, `409 republish_needed`, `409 access_switching` for another setting while a move is under way |

A restricted tour's published pictures are kept in the private store, never in the public one, so a public bucket domain (`PUBLIC_IMAGE_BASE`) cannot serve them. Changing a published tour between `public` and a restricted setting moves the pictures of the version that is live now, never the draft, and keeps the link. Made restricted, the tour stops being public at the first request, and its public pictures are deleted as they move, also those a re-publish replaced that were still in their grace; a move its client leaves is finished by the workspace's next requests. Made public, it becomes public only once all its pictures are in place, and asking for the setting it still has cancels the move until then. A browser or a CDN that already holds a public picture keeps it for as long as it holds it. In this version the page that checks a visitor's address is not there yet, so a restricted tour's page answers `404` to everyone; between `people` and `me`, and for a change of the list, nothing moves. Publishing, unpublishing and deleting work for a restricted tour as for a public one, and a publish keeps its setting. Nothing is mailed to the addresses on the list.

> [!warning] Going back to a version before 0.1.38 is refused once a tour is restricted
> An earlier version does not know the setting; restore the backup taken before the update instead, which loses what was done since.

On cPanel, `cpanel.sh` checks the database before it shows the commands to go back and before an update with `--allow-downgrade` to a version before 0.1.38: while a tour is restricted, or being changed to or from that, it refuses both. When it cannot read the database it refuses too, unless it is given `--no-restricted-tours-checked-by-hand`, which states that someone checked by hand that no tour is restricted and none is being changed (it is used only when the database cannot be read; a tour it can see restricted is refused whatever is given). Going back to 0.1.38 or later is always allowed. On the Docker and Cloudflare routes nothing checks this before an earlier version is started: only the database stands in the way, whose triggers (migration 0014) make an earlier version's publish or rename of a restricted tour fail instead of making it public. The runbooks say how to check by hand.

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
| Counted | The image of every step of every tour, published or not; each tour's logo; the room every unfinished upload holds from the moment it is started (all its images as the manifest gives them, and for a logo it carries the `logo_bytes` it was started with, or 200,000 bytes without, until the logo's real size is recorded when the upload is finished) until it is finished, aborted or removed; and every shared image and clip with its preview and any send of a part or preview that is not current (one under way, replaced or cut off), from the moment it is started until its files are gone after a delete |
| Not counted | The copies of images a published tour serves, so a fully published workspace can hold about twice its count on disk; images that wait to be removed after a delete or a replace; a logo stored by a server older than 0.1.8; the database itself |

`GET /api/v1/usage`, with a token, answers the workspace's own numbers, on either address:

```
{"used_bytes":4700,"allowance_bytes":1073741824,"over":false,"tours":1,"images":0,"gifs":0,"counted":{"pictures":3000,"logos":1000,"uploads_in_progress":700,"images":0,"gifs":0}}
```

`allowance_bytes` is `null` when there is no limit. `over` is `true` when more is used than the allowance. `images` and `gifs` count the shared images and clips (GIFs and MP4s) that are online. In `counted`, `images` and `gifs` are the bytes of the items of each kind in every state, each with its preview and any send that is not current: an item counts from the moment it is started, so one still being sent is counted there (not in `uploads_in_progress`, which holds tour uploads only), and one being deleted counts until its files are gone. The five numbers of `counted` add up to `used_bytes`.

The `bytes` of a workspace's tours in `GET /api/v1/tours` add up to `pictures` plus `logos`; `used_bytes` is that plus `uploads_in_progress`, which belongs to no tour yet, plus `images` and `gifs`, the shared items. `GET /api/v1/usage/largest` answers the workspace's ten largest tours, largest first, as `{"tours":[{"id","title","bytes"}]}`, and beside them `"largest":[{"kind","id","title","bytes"}]`: the ten largest things of every kind together, where `kind` is `tour`, `image` or `gif` and an item without a title has `null`. An entry's `bytes` is what deleting it frees. It lists an item still being sent, which takes room, but not one being deleted already.

The site's admin also has `GET /api/v1/admin/summary`, with the admin's session only: `{"accounts","used_bytes","standard_allowance_bytes"}`, the number of accounts, what all workspaces use together, and the allowance from the server's settings (`null` when none is set). Anyone else gets `404`.

An upload that would take the workspace over its allowance is refused when it is started, by `POST /api/v1/uploads`, before any image is sent. Nothing is stored and no upload exists afterwards. The answer is `413` with the numbers in bytes and one sentence a program can show as it is:

```
{"error":"storage_full","detail":"this tour needs 14.2 MB of room, but the workspace has 3.1 MB left of its 1 GB allowance. Nothing was uploaded. Delete tours you no longer need, or ask the site's admin for more room","used_bytes":1070491238,"allowance_bytes":1073741824,"needed_bytes":14889779}
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

> [!warning] Not tried on real hosting
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

### An optional third address for images and clips

Beside the two addresses an install can add a third, the img address, such as `img.example.com`, with one more setting, `IMG_HOST`. It is optional: without it, shared images and clips answer on the tours address, and everything else answers exactly as described above whether the img address is set or not. The img address exists only beside the other two, never on its own and never on one address.

The img address answers shared images and clips and `/healthz` and nothing else: every other path there, the token API, the session, the sign-in pages and the dashboard included, answers `404` with `{"error":"not_found"}`, and nothing redirects to it or from it. No session cookie is taken or set there, and no token is taken there either. Asked on it, `/healthz` prints `{"ok":true,"address":"img"}`. The pages and files a shared link opens are `/i/<link id>` for an image and `/r/<link id>` for a clip, the file itself at the same address with its extension (`.png`, `.jpg`, `.gif` or `.mp4`), `/download` and `/preview` after the link id, and the pages' own stylesheet and script under `/s/`. A deleted, unfinished or unknown item, and one of a disabled account, answers one "This link no longer works" page. Files and previews may stay in browser and shared caches for up to an hour after an item is deleted or its account disabled, and pages for up to a minute. With one address, shared files are served on the same address as the dashboard, protected only by their fixed type and the `nosniff` and `sandbox` headers, so a hosted service should set `IMG_HOST`, with the two other addresses, to give them an address of their own.

> [!warning] Not tried on real hosting
> The third address has not been run on real hosting either: it is checked by this repository's tests only.

### A pair that cannot be used

One setting without the other, `IMG_HOST` without both of them, a value that is not a plain host name, or the same name twice (also on two different ports) is never read as one address. On Node the app does not start: it prints one of the lines below and exits with code 1, before it opens the database. A Worker cannot refuse to start, so on Cloudflare every request, `/healthz` included, answers `500` with `{"error":"misconfigured"}`, and the line is in the Worker's log.

```text
TOURS_HOST is set but APP_HOST is not. Set both for two addresses, or neither for one.
APP_HOST is set but TOURS_HOST is not. Set both for two addresses, or neither for one.
TOURS_HOST is not a host name. Write it like tours.example.com, without https:// and without a path.
APP_HOST is not a host name. Write it like app.example.com, without https:// and without a path.
TOURS_HOST and APP_HOST name the same host. Two addresses need two different host names.
```

`IMG_HOST` gives the same kinds of line, such as these:

```text
IMG_HOST is set but TOURS_HOST and APP_HOST are not. IMG_HOST is an extra address beside those two: set them too, or leave IMG_HOST empty.
IMG_HOST is not a host name. Write it like img.example.com, without https:// and without a path.
TOURS_HOST and IMG_HOST name the same host. Two addresses need two different host names.
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

The optional third address is added the same way on each route, after the two work: on shared cPanel hosting one more subdomain and one more line, `IMG_HOST`, in the settings file (see [An optional third address for images and clips](docs/hosting/cpanel.md#an-optional-third-address-for-images-and-clips) in that guide); on Cloudflare, like the other two, not yet with the guided setup; on Docker not yet, because `install.sh` does not add a third name to Caddy (see [A third address for images and clips](docs/runbook-docker.md#a-third-address-for-images-and-clips)); started by hand, `IMG_HOST` in the same environment. To go back, remove the `IMG_HOST` line and restart: shared images and clips then answer on the tours address again.

To go back to one address, remove both settings (on Docker, the `APP_DOMAIN` line) and restart the app; each of the three pages above gives the steps. The tours address is the same name before and after, so links to tours that are already out there keep working both ways.

## Accounts and signing in

People sign in to the site in a browser to use [the dashboard](#the-dashboard). With two addresses the sign-in page and the dashboard are on the app address; with one address they are on that address. Mythicshot does not sign in: it keeps using its API token.

### Signing in by link

There is no password. The sign-in page, `/signin`, asks for an email address and mails a link to it. Its answer is the same for every address ("If <address> has an account, a sign-in link is on its way."), so the page cannot be used to find out who has an account.

A link is mailed only when all of these hold: the address belongs to an active account, the site has an admin (see [The first admin](#the-first-admin)), mail is set up (see [Mail](#mail)), and the address has not asked too often. Each address gets at most 3 links in 15 minutes and 10 a day; past that the page answers as always and nothing is sent. One network may ask 10 times in 15 minutes and is then told to wait, but only where the site knows the visitor's network address (see `CLIENT_ADDRESS_HEADER` in [Settings](#settings)). The whole site sends at most 100 sign-in mails an hour.

A link works once and for 15 minutes. Opening it shows a "Sign in" button, and only pressing the button signs in, so a mail program that opens links to check them uses nothing up. After the press the browser lands on the dashboard's Tours page, `/tours`. A newer link does not cancel an older one: each works until it is used or its 15 minutes are over.

### Sessions

A session ends 30 days after it was last used, so a browser in use every day stays signed in. Only a digest of the session's cookie is stored.

Sessions end on the Account page of the dashboard, which lists where the account is signed in. "Sign out" ends this browser's session, the "Sign out" beside another session ends that one, and "Sign out everywhere" ends every session of the account. None of them touches an API token: Mythicshot keeps working.

### The first admin

A site has no admin until somebody with access to the server makes one, and until then no sign-in link is sent or accepted, so an updated site works as it did before accounts: its tours, their links and its tokens stay as they are. The admin is made once, with the server command `first-admin`, which also prints a first sign-in link, so the first sign-in needs no mail. The steps are in each hosting guide: [Make yourself the admin](docs/hosting/cpanel.md#15-make-yourself-the-admin) for shared cPanel hosting, and [Make yourself the admin](docs/runbook-docker.md#make-yourself-the-admin) for Docker.

A Cloudflare install has no server command, so an admin cannot be made there and nobody can sign in on it in this version. Its tokens, tours and storage allowance work as before.

### Recovery links

When someone cannot get a mailed link, because mail is off or does not arrive, the server command `signin-link` prints one for an account that exists. It is a recovery tool, off unless the settings hold `RECOVERY_LINKS=on`, and it is turned on for one run only:

1. Add the line `RECOVERY_LINKS=on` to the settings: the settings file on shared hosting, or `.env` on Docker, where the app container is then recreated so that it sees the line.
2. Run `signin-link --email <address>`. It prints `Open this link within 15 minutes to sign in:`, the link, and `Remove the line RECOVERY_LINKS=on from the settings file now.` Nothing is mailed.
3. Remove the line again (on Docker, recreate the container once more).

Without the line the command makes nothing and says so. When the account cannot be given a link (the text is not an address, nobody has it, the account may not sign in, or the site has no admin), it says `No link was made. Check the address, and that the site has an admin.` Other failures have sentences of their own: `The database is from an older version. Update the site first.`, `The database is busy. Try again in a moment.`, `There is no database in the data folder yet. Start the site once, then run this again.`, `DATA_DIR is not set, so the site's data is not known. Nothing was changed.`, `The command stopped on an unexpected error.`, or the app's own line for a host or allowance setting it would refuse to start with, such as `STORAGE_ALLOWANCE_BYTES is not a number of bytes. Write digits only, such as 1073741824, or leave it out for no limit.`

With neither two addresses nor `SITE_HOST` set, the command does not know the site's address, so it prints `No address for sign-in links is set, so the link is shown without one. Set APP_HOST and TOURS_HOST, or SITE_HOST.` and `Open your site's address followed by:`, then only the part of the link after the address, `/signin/link#c=…`, to put the site's address in front of.

Each printed link is recorded in the audit record as `signin_link_printed`. The exact commands for each hosting kind are in the guides linked under [The first admin](#the-first-admin).

> [!warning] A printed link is a key for 15 minutes
> Whoever opens it first is signed in as that account: hand it only to its owner, by a way nobody else reads.

### Inviting people

The site's admin invites a person by email address on the Admin page, in the card "Invite someone", or through the API (`POST /api/v1/admin/invites`). The page lists the open invites, and those that ran out with an amber "Ran out" tag, each with "Resend" (a fresh link at once, no question) and "Cancel" (which asks first). The person gets a mail with a link that works once and for 7 days; inviting the same address again, or resending, sends a new link and the older one stops working. The link opens the page `/invite`, which shows the invited address and asks for a username; opening it makes nothing. Pressing "Create my account" makes the account, an empty workspace of its own with the site's standard allowance, and signs that browser in, on the dashboard's Connections page with a welcome. An address that already has an account cannot be invited. Sending an invite needs mail: on a site whose mail is off it is refused and nothing is stored. When a mail cannot be handed over, the invite stays and the admin is told to resend it. An admin sends at most 20 invites an hour, resends included, the site sends at most 30 invite mails an hour, on a cap of their own apart from sign-in's, and holds at most 100 open invites (one that ran out does not count); one that ran out is listed until it is cancelled or replaced, and removed 30 days later. The requests are described at `/docs`.

### Who to ask for an invite

Until the invite pages come, the sign-in page says "Mythicshot is invite-only for now." The optional setting `INVITE_CONTACT` adds who to ask: an email address, shown after "Ask for an invite:" as a mail link, or an `https://` address, shown as the link "Ask for an invite". Anything else, unset included, shows the sentence alone and never stops the site. It goes where the other settings go: the settings file, `.env`, or on Cloudflare a var in `wrangler.deploy.jsonc`, which `npm run setup:cloudflare -- update` keeps. On Cloudflare a change takes effect with the next `npm run setup:cloudflare -- update` or deploy.

### Visitors of a shared tour

A tour can be shared with a list of email addresses instead of everyone with its link. A visitor then proves an address on the tours address (with one address, on that address) and gets no account: the tour's page asks for the address, the site mails a link that works once and for 15 minutes, and pressing the button on the page the link opens makes this browser a viewer of that address for 30 days of use, never longer than 180 days. The viewer's cookie, `__Host-dp_viewer`, is its own: it is never an account's session, opens nothing of the dashboard or the API, and an account's session is never a viewer. Asking for a link answers the same whatever the tour or the address, and a link goes only to an address the tour's own list holds. One address gets at most 3 viewer links in 15 minutes and 5 a day however many tours or networks ask, and at most 2 for one tour in 15 minutes. The tours of one workspace get at most 30 viewer mails an hour, on a cap of their own apart from sign-in's, so one workspace can never use up the mail of another; the whole site sends at most 1000 an hour, a backstop against a fault. Anyone who knows an address can use up that address's viewer links for the day by asking for them, which delays that person and nothing more. Disabling or deleting an account does not end the viewer sessions of the same address: a viewer is an address, not the account, and each tour decides by its own list. The requests are described at `/docs`; the pages and the setting that restricts a tour come in later versions.

## The dashboard

The dashboard is the set of pages a signed-in person uses on the app address (or the one address). `/` sends a signed-in browser to the Tours page and anyone else to the sign-in page. Tours are recorded, edited and renamed in Mythicshot; the dashboard lists them, shares them, publishes and unpublishes them, and deletes them. Images and GIFs are shared from Mythicshot too; the dashboard lists them, shares their links and deletes them.

| Page | What it does |
|---|---|
| Images, `/images` | Lists the workspace's shared images, newest first, each with its preview, size, width and height, type and the day it was shared. "Copy link", "Open" and "Delete"; "Show more" past the first 50. Delete asks first and cannot be undone; the copy on the computer is not touched |
| GIFs, `/gifs` | The same for shared clips (GIFs and MP4s), with each clip's length in seconds |
| Tours, `/tours` | Lists the workspace's tours, most recently changed first, each with its steps, size, the day it changed and whether it is published or has changes waiting. "Copy link" and "Open" for a published tour; "Publish", "Publish changes", "Unpublish" and "Delete". Delete asks first and cannot be undone; the recording on the computer is not touched |
| Storage, `/storage` | What the workspace uses: against its allowance with a bar when it has one, with its numbers of images, GIFs and tours; what takes the room (tours, GIFs, images, logos, uploads in progress); and its largest items of every kind, each marked Tour, Image or GIF, with "Delete". A workspace over its allowance sees a warning |
| Account, `/account` | The username, the email address and the workspace; where the account is signed in, with the sign-outs of [Sessions](#sessions); and, on a site whose mail is on, changing the email address (see [Changing an email address](#changing-an-email-address)). The username cannot be changed in this version |
| Admin, `/admin` | For the site's admin only: inviting people and the open invites, every account and its storage, and each account's "More" menu: its workspace's allowance, disabling or enabling it, and deleting a disabled one. The tab is shown only to the admin, and everyone else gets "not found" from the routes behind it |

### What the admin sees

The Admin page shows one line for the whole site (the number of accounts, what all workspaces use together, and the standard allowance) and one row per account: its username, email address, status and whether it is the admin, its workspace's name, its number of tours, the bytes it uses, its allowance and the day it joined. It never shows a tour's title, link, pictures or anything else in a workspace, and it has no way into one: the admin's own session reaches other workspaces only through these figures. The page says so itself: "You see totals only. What is in another person's workspace is never shown here."

### Allowances

The standard allowance is the setting `STORAGE_ALLOWANCE_BYTES` (see [Storage allowance](#storage-allowance)); without it there is no limit. It is changed in the settings and takes effect when the app restarts, or on Cloudflare at the next deploy.

> [!warning] A mistyped standard allowance takes the site down
> A value that is not whole digits stops the Node app from starting, and on Cloudflare every request answers 500 `misconfigured`, until it is corrected or removed.

The admin sets one workspace's own allowance with "Set allowance" on its row, in the question "Storage allowance for" and the workspace's name. The field takes a number with `B`, `KB`, `MB` or `GB` after it (in any case, `byte` and `bytes` too, or nothing for bytes), counted 1,024 to the next unit, such as `500 MB`, `10 GB` or `1.5 GB`. A fraction is written with a point, never a comma, and is rounded to the nearest byte; bytes themselves take none, and `TB` or any other unit is refused with "Write a size such as 500 MB or 10 GB." An empty field goes back to the standard allowance.

An allowance that leaves the workspace no room is taken only after a warning, and the button then reads "Save anyway"; nothing is deleted either way. Below what the workspace uses the warning is "That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under" and the size; at exactly what it uses, "That is exactly what this workspace uses. Nothing is deleted, but its new uploads are refused until it is under" and the size; at 0, "An allowance of 0 refuses every upload from this workspace." An empty field is judged by the standard allowance it stands for. Every change is recorded in the audit record as `allowance_set`, with the old and the new number of bytes.

### Over the allowance

A workspace is over its allowance when it uses more than the allowance; using exactly the allowance is not over. Being over deletes and unpublishes nothing: its tours, links and pictures stay online, and listing, publishing, unpublishing, renaming and deleting work. Only uploads that need room are refused, as described in [Storage allowance](#storage-allowance), until tours are deleted or the allowance is raised. The Storage page then shows "You are over your storage allowance. New uploads are refused until you delete tours or get more room.", and the Admin page marks the row.

### Disabling and deleting an account

The admin can disable, enable and delete another account on the Admin page, from the account's "More" menu, or through the admin API. An admin cannot do any of the three to their own account (the page does not offer them on the admin's own row), and the site's last active admin cannot be disabled or deleted.

On the page, "Disable" asks first and says what stops; "Enable" asks nothing. "Delete" is offered only for a disabled account: it shows what goes (tours, images and GIFs, connected computers, the storage freed) and works only once the username is typed exactly (the email address, for an account without one). A large workspace shows its progress while the page sends the delete again. Keep the page open; when it is interrupted, the account stays listed with a "Deleting" tag, and "Delete" on it finishes the job (the page asks for the username again after it is reloaded).

| Request | What it does |
|---|---|
| `POST /api/v1/admin/accounts/<id>/disable` | The account cannot sign in. At once, every session of it ends, its unused sign-in links and its open email change stop working, and every token of its workspace is refused (the tokens are kept, not revoked). A request to connect Mythicshot that it confirmed can no longer be collected. Its tour pages, published pictures (also those a re-publish replaced, during their grace) and shared images and clips answer exactly as ones that never existed. Nothing is deleted. Recorded as `account_disabled` |
| `POST /api/v1/admin/accounts/<id>/enable` | The account can sign in again, and nothing else changes: its tours, pictures, items and tokens work as before. The person signs in again for the dashboard. Recorded as `account_enabled` |
| `GET /api/v1/admin/accounts/<id>/removal` | What a delete would remove: the username and address, the number of tours, of shared images and clips, of connected computers (tokens not revoked), and the bytes it uses |
| `DELETE /api/v1/admin/accounts/<id>` with `{"username": "<its username>"}` | Only for a disabled account. Removes the account and everything of its workspace: tours with their draft and published pictures, unfinished uploads, shared items, tokens, requests to connect, sessions, sign-in links and the workspace. An account with no username is confirmed with its email address instead, exactly as the list shows it. Recorded as `account_deleted`, with the ids of the admin, the workspace and the account only |

A delete of a large workspace takes several requests, each within the call budget a request may make: the answer is `202` with how many files are removed out of how many until it is `200`. A delete that is stopped at any point leaves the account disabled and listed (the list says `deleting`), and sending it again finishes it; until then it cannot be enabled. Files always go before the rows that name them, so a delete that is asked again to the end leaves nothing behind. As with deleting a tour, a request cut off in a narrow window, in the middle of a store's delete of a page of files, can leave a file in the store that no row names any more. Afterwards the email address and the username are free for a new account. Invites to its address are removed, and invites it sent stay valid. The rows the audit record already holds about the account stay.

Only an account alone in its workspace can be deleted: a delete removes the whole workspace, so one that another account belongs to is refused (`409 shared_workspace`). Every workspace has one account in this version. Disabling an account hides its whole workspace, which matters only once a workspace can have several members.

Deleting, like disabling, cannot take back pictures already held in browsers or caches (for up to a year) or served from a bucket's own domain until their files are gone.

The account the site was set up with (the owner of the workspace the setup wizard made) cannot be deleted: the site needs that record. It can be disabled.

> [!warning] Disabling stops new fetches only
> A tour page may stay in a browser's or a cache's copy for up to a minute and a published picture for up to a year, since its address never changes; disabling stops every new request, not those copies.

With `PUBLIC_IMAGE_BASE` set to a public bucket's own domain (possible on Cloudflare), published pictures are fetched from the bucket and never reach the app, so disabling an account cannot stop them: they stay reachable at their addresses, for anyone who has one, until the tour is unpublished or the account is deleted. Tour pages and shared items are always served by the app and are stopped either way. Leave `PUBLIC_IMAGE_BASE` empty if a disabled account's pictures must stop at once.

## Changing an email address

On a site whose mail is on, a signed-in person changes their own address on the Account page:

1. Beside "Email address" they press "Change", type the new address under "New email address" and press "Send the link". The page then says "Check" and the new address, and "Open the link we sent there to finish. It works once and for 15 minutes. Until then you keep signing in with" and the present address.
2. The site mails the new address, with the subject `Confirm your new Mythicshot email address`. The mail reads `Open this link to make this the email address of your Mythicshot account:`, then the link, then `It works once and for 15 minutes, and you need to be signed in to that Mythicshot account when you open it. Until you confirm it there, nothing changes. If you did not ask for this, ignore this mail.` It names neither the account nor its present address.
3. The link opens the page "Confirm your new email address", with "Press the button to make this your Mythicshot email address." and a "Confirm" button. Opening the link changes nothing, so a mail program that opens links to check them does no harm; only pressing "Confirm", within 15 minutes, changes the address. The page then says "Your email address is now" and the new address, and "Sign-in links go to this address from now on. We sent a notice to" and the old one.
4. The person must be signed in to that account when they press it. In a browser that is not signed in, the page says "Sign in first" and "Sign in with your current email address, then open the link from your mail again."; the link is not carried across the sign-in, so they open it from the mail once more afterwards. A link that was used, ran out, was replaced or belongs to another account gives "This link no longer works. Ask for a new one from your account page." and "If you have more than one account, sign in to the one that asked for the change and open the link again."
5. The old address is sent a notice, with the subject `Your Mythicshot email address was changed`. It reads `The email address of the Mythicshot account "<username>" was changed to n…@example.com.`, with the new address mostly hidden as shown (for an account without a username, `The email address of your Mythicshot account was changed to …`), then `If this was you, there is nothing to do.` and `If it was not, answer this mail or contact the person who runs this site.` It asks nothing.

The old address is told so that a change its owner did not make does not go unnoticed. It is not asked to approve, so that a person who has lost the old mailbox can still change it; the change already needs a session of that account and the new mailbox.

The page answers the same whether the new address is free, belongs to another account or is the account's own, so it cannot be used to find out who has an account. For an address another account has, no link is mailed and its owner is sent nothing. Asking again replaces the earlier request, whose link then no longer works; a link also works only once. The change ends the account's open sign-in links, which went to the old address, and keeps its sessions signed in.

| Limit | Counted per | At most |
|---|---|---|
| Change requests | Account | 3 in 15 minutes, 10 a day |
| Change requests for the same new address | Account and address | 2 in 15 minutes, 5 a day |
| Change requests for one address | Address, from all accounts together | 6 in 15 minutes, 20 a day |
| Tries of a link's code | Account | 20 in 15 minutes |
| Email-change mails | The whole site | 30 an hour, apart from the 100 sign-in mails |

Over any of the first four, the page says "Too many requests. Wait a few minutes and try again." Over the site's hourly number, the page answers as always and no link is sent. A day is counted from midnight UTC, and the other periods also start at fixed times rather than at the first request.

The new address a person typed is kept in the database, even after its link was used or ran out, until the same account asks for a change again and the new request takes its place.

### While mail is off

A site whose mail is off cannot mail the link, so the Account page shows no "Change" button but the line "This site cannot send mail, so an email address cannot be changed here.", and the request answers with that same sentence. The server command `change-email --username <name> --email <address>` changes an address at once instead. It is behind the same `RECOVERY_LINKS=on` line as recovery links, turned on for one run in the same way, and it sends no mail at all: neither the old nor the new address is told. It also ends the account's open sign-in links and any email change the account had asked for, records `email_changed_on_server` in the audit record, and keeps the account's sessions signed in. It works the same on a site whose mail is on. The steps for shared hosting are in [Change an address on the server](docs/hosting/cpanel.md#change-an-address-on-the-server).

## Mail

The Node target sends three kinds of mail: sign-in links, the link and notice of an email change, and a notice to the account that confirmed a new connection of Mythicshot once Mythicshot has collected its token (at most 5 a day per account and 30 an hour for the site, apart from sign-in's limit). Mail is off until it is switched on. A Cloudflare install sends no mail in this version.

### Switch mail on

These lines switch it on, with the sender's address, the mail server's host name and the mailbox's sign-in. The mail server must take SMTP over TLS from the first byte, which is port 465 unless `SMTP_PORT` says another.

```text
MAIL_MODE=smtp
MAIL_FROM=no-reply@example.com
SMTP_HOST=mail.example.com
SMTP_USER=no-reply@example.com
SMTP_PASSWORD="<password>"
```

On one address the site also needs `SITE_HOST`, the host name its links use, such as `SITE_HOST=tours.example.com`; with two addresses links use the app address. Each setting is explained in [Settings](#settings).

| Hosting | Where the lines go | Then |
|---|---|---|
| Shared cPanel hosting | The settings file beside the app folder | Restart the app; see [Send sign-in mail](docs/hosting/cpanel.md#16-send-sign-in-mail) |
| Docker on Debian | `.env` in `/opt/demo-platform` | Recreate the app container; see [Mail](docs/runbook-docker.md#mail) in the Docker runbook |
| Node started by hand, or Fly | The environment the app starts with | Restart the app |
| Cloudflare | Nowhere: a Worker sends no mail in this version | |

Recovery links and `change-email` need the recovery line, and the command reads it from only two places: through `cpanel.sh admin`, from the settings file; run as its own file, from the environment of process 1, and only when process 1 is the app's own server (`node dist/node/entry.js`), as it is in the container. Anywhere else, such as Node started by hand or a container whose first process is not the app, both are refused, so switch mail on there before relying on sign-in. `first-admin` is not affected.

The site's owner types the mailbox password into the file themselves, in an editor on the server. It never goes into a chat, a ticket, a command line or a file anyone else reads. How each kind of file treats quotes, `#` and `$` in a password is in [The mail settings in a settings file](#the-mail-settings-in-a-settings-file): in the settings file of shared hosting write it in double quotes, and in Docker's `.env` in single quotes.

> [!warning] The mailbox password is a secret
> Anyone who reads it can send mail as your sender address: keep it in the settings only, and change it if it was ever pasted anywhere else.

### Check it

The server command `mail-check` says whether the site would send mail, without showing any setting: `./cpanel.sh admin mail-check` on shared hosting, `docker compose exec app node dist/node/admin.js mail-check` on Docker. It reads the settings the way the command reads them (through `cpanel.sh admin`, from the settings file only, whereas the app lets a setting already in its environment win) and contacts nothing, so it cannot see a wrong password, host name or port. It prints one line:

| Line | Exit code | Meaning |
|---|---|---|
| `Mail is set to SMTP: host, port, user, password and sender are set.` | 0 | Mail is on |
| `Mail is off.` | 0 | Mail is off by choice |
| `Mail is off because <SETTING> is missing or not usable.` | 1 | Mail is switched on but that setting must be fixed; mail stays off |
| `Mail is off because no address for sign-in links is set. Set APP_HOST and TOURS_HOST, or SITE_HOST.` | 1 | Mail is switched on but links would have no address |
| The app's own line for a host or allowance setting it would refuse to start with, such as `TOURS_HOST is set but APP_HOST is not. Set both for two addresses, or neither for one.` | 1 | The site would not start; nothing about mail is said |
| `That is not an email address.` | 1 | What follows `--send-to` is not an address; nothing is sent |

With `--send-to <address>` it also sends one real test mail to that address, straight to the mail server rather than through the mail thread, with the subject "Test mail from" and the site's host name. It then says `A test mail was handed to the mail server for <address>.` and exits with 0, or says `The mail server did not take the test mail (<reason>).`, with one of the reasons `connect`, `tls`, `auth`, `refused`, `timeout` or `unknown`, and exits with 1. While mail is off it sends nothing and exits with 1. A test mail that was handed over can still be dropped later, by the mail server or the recipient's.

### What the site does while mail is off

The sign-in page answers exactly as it does with mail on, and says a link is on its way, but no link is sent: the admin prints one with a [recovery link](#recovery-links) instead. The Account page does not offer an email change (see [While mail is off](#while-mail-is-off) under the email change). When mail is switched on but cannot be used, the site still starts, mail stays off, and the start writes one line that names the setting and never a value, such as `mail: off, because SMTP_PORT is missing or not usable. The site runs; sign-in mails are not sent.`

### Mail records

Receiving mail servers trust a sender's domain by three DNS records: SPF lists the servers that may send its mail, DKIM publishes the key each mail is signed with, and DMARC says what to do with a mail that fails those checks. Get the exact records from whoever runs the mailbox and add them before mail is switched on: without them sign-in mails may be put in spam or refused.

## Security notes

- **The site does not say who has an account.** Asking for a sign-in link answers with the same status, body and headers whether or not the address has an account, after the same database work in the same order; everything only an account gets (its code, its audit row and its mail) is done after the answer, and the mail is sent from a separate thread so it cannot slow the next request. Asking for an email change does the same for addresses that are free and taken, and every refusal of an admin route is the same "not found".
- **One small timing difference is accepted.** For an address with an account the answer can come back very slightly later. Telling the two apart would take about 900 tries for one address, while an address gets at most 10 links a day before nothing more is sent to it, and every one of those 10 is a mail in the account's mailbox.
- **Links are single use and short-lived.** A sign-in link and an email-change link each work once and for 15 minutes. Their code travels after the `#` of the link, which a browser sends to no server, so it reaches no server log and no referrer, and the page a link opens removes it from the address bar before anything else.
- **Tokens, codes and session cookies are stored as digests.** API tokens, sign-in codes, email-change codes, the device codes of connecting Mythicshot and session cookies are kept as SHA-256 digests only. The short codes a person types to connect Mythicshot are kept as an HMAC-SHA256 under a random key the install makes for itself, so a copy of the database cannot be read back with a table made in advance for every install. The mailbox password and the setup code are different: they are in the settings file in plain text, and in every backup of it. No code, cookie, token, digest, mail password or email address is written to a log line, an error or the audit record.
- **Workspaces are kept apart by access rules, not by encryption.** Every request is resolved to one workspace and reads and writes only its rows, and the tests try every route with another workspace's ids; the admin's routes are the one exception, and they answer each account's name, address and figures and its workspace's name, never what a workspace holds. The operator of the server can still read the whole database and every stored picture: the data is not encrypted against them.
- **The rate limits can be used against an address.** Anyone can use up an address's sign-in links (3 in 15 minutes, 10 a day) by asking for them, so its owner gets no link until the period ends; the admin can print a [recovery link](#recovery-links) meanwhile. A few accounts that work together can likewise use up the email-change requests for one address, or the site's 30 email-change mails an hour. The counters do not list the addresses asked for; account addresses themselves are stored in plain text.

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
| `PUBLIC_IMAGE_BASE` | both | Empty (the default on both targets): the app serves published images itself on `/p/<name>`. Optionally, on Cloudflare, the address of the public bucket's own custom domain, such as `https://images.example.com`; the pictures then never pass through the app, so a disabled account's pictures stay reachable (see [Disabling and deleting an account](#disabling-and-deleting-an-account)). |
| `TOURS_HOST` | both | Optional, and only together with `APP_HOST`: the host name of the tours address, such as `tours.example.com`, without `https://` and without a path. Both empty or unset (the default) is one address, and no host name is checked. See [One address or two](#one-address-or-two). |
| `APP_HOST` | both | Optional, and only together with `TOURS_HOST`: the host name of the app address, such as `app.example.com`, in the same form. It must be a different name than the tours address. |
| `IMG_HOST` | both | Optional, and only beside both `TOURS_HOST` and `APP_HOST`: the host name of a third address for shared images and clips, such as `img.example.com`, in the same form and a name of its own. Unset or empty (the default): they answer on the tours address. It is not `PUBLIC_IMAGE_BASE`, which is about published tour pictures. See [An optional third address for images and clips](#an-optional-third-address-for-images-and-clips). |
| `STORAGE_ALLOWANCE_BYTES` | both | Optional: the storage allowance of a workspace in bytes, digits only, such as `1073741824` for 1 GB. Unset or empty (the default): no limit. See [Storage allowance](#storage-allowance). Any other value stops the start on Node with one line, and on Cloudflare answers 500 `misconfigured` on every path until it is fixed. |
| `SITE_HOST` | both | Optional, for a site on one address only: the host name sign-in links use, such as `tours.example.com`, without `https://` and without a path. Ignored when `APP_HOST` is set, since links then use the app address. It is used for links only, and no request is checked against it. A value that is not a host name never stops the site: it then has no address for links, and no sign-in mail is sent. |
| `INVITE_CONTACT` | both | Optional: who to ask for an invite, an email address such as `hello@example.com` or an `https://` address, shown after "Mythicshot is invite-only for now." on the sign-in page; unset or anything else shows that sentence alone and never stops the site. On Cloudflare it is a var in the install's `wrangler.deploy.jsonc`, which `npm run setup:cloudflare -- update` keeps. See [Who to ask for an invite](#who-to-ask-for-an-invite). |
| `MAIL_MODE` | Node | `off` (the default, also when unset) or `smtp`. With `off` the site sends no mail and reads none of the mail settings below. With `smtp` it sends sign-in mails through the mail server those settings name. Mail that is switched on but cannot be used (a mail setting that is missing or malformed, or no address for links from `APP_HOST` or `SITE_HOST`) never stops the site: mail stays off, and the start writes one line that names the setting and never a value. A Cloudflare install sends no mail in this version. |
| `MAIL_FROM` | Node | With `MAIL_MODE=smtp`: the sender's address, such as `no-reply@example.com`, the address alone without a name around it. |
| `SMTP_HOST` | Node | With `MAIL_MODE=smtp`: the host name of the mail server, such as `mail.example.com`, without a port. |
| `SMTP_PORT` | Node | With `MAIL_MODE=smtp`: the mail server's port for SMTP over TLS. Default 465. The connection is encrypted from its first byte on whatever port is given; a port that expects STARTTLS (usually 587) does not work. |
| `SMTP_USER` | Node | With `MAIL_MODE=smtp`: the name the mailbox signs in with, often the same as the sender's address. |
| `SMTP_PASSWORD` | Node | With `MAIL_MODE=smtp`: the mailbox's password. A secret: it belongs in the environment or the settings file only, like `SETUP_CODE`, and the site never writes it to the database, a log or an answer. |
| `CLIENT_ADDRESS_HEADER` | Node | Optional, and only for a site behind a proxy: the name of the header in which the proxy writes the visitor's network address, such as `X-Real-IP`. The last value of that header is then taken as the visitor's address, for rate limits only. Unset (the default): the address of the connection itself, which is right only when visitors connect to the app directly. Behind a proxy the connection is the proxy's: when the proxy hands requests over a local socket or from a private address, as shared hosting and the container stack do, the address is then unknown, and limits per network are not applied (the limits per recipient and on mails sent still are). The header's value must be the bare address, such as `203.0.113.7` or `2001:db8::1`: with a port, in brackets or with a label such as `for=`, it is not taken and the address is unknown. With two proxies in a chain that each add to the header, the last value is the one written by the proxy next to the app, which is the address of the outer proxy, not the visitor's: name a header the outer proxy sets and the inner one passes on unchanged. Set it only to a header your own proxy writes on every request, or a visitor could choose the address. A value that is not a header name, or names a header of which only the first value is kept (`Host`, `From`, `Referer`, `User-Agent`, `Authorization`, `Cookie`, `Content-Type`, `Content-Length` and the like), never stops the site: no visitor's address is then known, and the start writes one line. Without this setting behind a proxy, the limits per network on signing in and on connecting Mythicshot cannot tell visitors apart: while it is unset, the first request that comes from a private or local address, or over a local socket, makes the server write one line, `client address: requests come from a private or local address, which is how a proxy in front of the app looks; set CLIENT_ADDRESS_HEADER to the header your proxy writes the visitor's address in, or the limits per network (signing in, connecting the app) cannot tell visitors apart`, once until it restarts; nothing else changes. On Cloudflare the address is the connecting one and this setting is not read. |
| `RECOVERY_LINKS` | Node | Read by the server's admin command only, never by the app or the API: `on` (any case, spaces around it allowed) lets the command print a sign-in link for an account that exists, as a recovery tool; anything else, or unset (the default), is off. Add the line for one run and remove it right after: do not leave it on. The command never reads it from its own environment: through `cpanel.sh admin` it is the settings file's line, and run directly, as in the container, it is what the environment of the container's first process (the app, started from `.env`) says, so the line goes in `.env` and the container is recreated; `docker compose exec -e` does not open it. It keeps the command from being a standing way in; it is no defence against someone who can already change the settings file or the data. |
| `DATA_DIR` | Node | The folder holding `db.sqlite`, `drafts/` and `public/`. Required. In the container it is `/data`. |
| `PORT` | Node | The port the app listens on. Default 3000. |
| `DB`, `DRAFTS`, `PUB` | Cloudflare | The D1 binding and the two R2 bindings in `wrangler.jsonc`; an install's names and id are in its `wrangler.deploy.jsonc`, written by `npm run setup:cloudflare`. |

The container stack's `.env`, written by `install.sh`, also holds `DOMAIN`, `ACME_EMAIL`, `DATA_DIR` (the folder on the host) and `APP_IMAGE`, and for two addresses `APP_DOMAIN`, the app address: the stack then gives the app `TOURS_HOST` (from `DOMAIN`) and `APP_HOST` (from `APP_DOMAIN`) itself, and a `TOURS_HOST` or `APP_HOST` line in that `.env` has no effect.

### The mail settings in a settings file

Mail is off until `MAIL_MODE=smtp` is set together with `MAIL_FROM`, `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` (and `SMTP_PORT` when the mail server does not use 465); a site on one address also needs `SITE_HOST`. The site checks the settings when it starts and does not contact the mail server then: a wrong password, a wrong host name or a wrong port shows only when the first mail is tried.

The Node site sends each mail from a separate thread of its own process, made when the first mail is sent, so the site's answers to requests never wait on a mail server. Mails go one at a time; up to 16 more wait their turn, and a mail beyond that, or one that has waited 30 seconds, is not sent and the log says so in one line (`mail: a sign-in mail could not be sent (refused)`). If that thread fails, it is made again for the next mail, at most five times a minute. A thread that cannot start is said in its own line, `mail: the mail thread could not start (<reason>); no mail was sent`, with one of three reasons in the brackets: `it could not be made`, `it was started 5 times in the last minute`, or `it stopped before it was ready` (as when its file is missing from the build), such as `mail: the mail thread could not start (it stopped before it was ready); no mail was sent`. It comes before the line of the mail it could not send. The thread is started with an empty environment and none of the app's Node.js options, so a `NODE_OPTIONS` value given to the app (such as `--require`) does not reach the thread that sends mail; what Node.js reads once for the whole process when it starts, such as extra trusted certificates, does. On a stop, a mail on its way gets the time left before the stop's deadline and is then cut off; it is never sent a second time. The admin command's mail check sends its test mail directly, without the thread.

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
| `src/connect.ts`, `src/tokens.ts` | Connecting Mythicshot with a pair of codes, and the workspace's token list |
| `src/docs/` | The API documentation: the description (`openapi.ts`), the guides, the page and its routes, the page script and stylesheet (`client/`), and the two generated modules |
| `scripts/docs-bundle.ts`, `scripts/build-docs.ts` | Build the two generated modules of the documentation page, `npm run build:docs` |
| `src/cloudflare/` | D1 and R2 adapters and the Worker entry |
| `src/node/` | SQLite and folder adapters, migrations, the HTTP server, the database backup |
| `Dockerfile`, `deploy/` | The container image, the compose stack with Caddy, the install script and their tests |
| `scripts/setup-cloudflare.ts` | The guided Cloudflare setup, `npm run setup:cloudflare` |
| `deploy/cpanel/`, `scripts/package-cpanel.ts` | Shared cPanel hosting: the startup file, the install script and its tests, and the archive builder, `npm run package:cpanel` |
| `migrations/` | SQL migrations, one set for both targets |
| `docs/` | The two hosting runbooks, the hosting guides, and the lists of what to check in a browser: the documentation page, the sign-in pages and the dashboard |
| `test/contract/` | Adapter contract suites run against both targets |
| `wrangler.jsonc` | Worker bindings; the database id and bucket names are placeholders. Each install's own copy is `wrangler.deploy.jsonc`, ignored by Git |

The application (`src/app.ts` and everything outside `src/cloudflare/` and `src/node/`) reaches data only through the `Db` and `FileStore` interfaces in `src/ports.ts`, and never imports a platform API.
