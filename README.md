# demo-platform

A self-hosted platform for interactive product tours. You record a click-through tour in Mythicshot, it uploads the tour here as a private draft with an API token, and once the tour is published a visitor clicks through it at `https://tours.example.com/t/<slug>`.

Copyright (c) 2026 Mythicshot, LLC. Licensed under the GNU Affero General Public License, version 3 or later: see [LICENSE](LICENSE).

Every copy that is built to be installed carries the licence and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) unchanged: the container image holds both in `/app`, beside `package.json`, and the shared cPanel archive (`npm run package:cpanel`) holds both at its top level, from where `cpanel.sh` copies them into the app folder and the archive of the app files in each backup.

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

The server can also give Mythicshot a token of its own without copying one, with a pair of codes. Mythicshot asks the server for them (`POST /api/v1/connect/start`, with no credential), shows a short code such as `ABCD-EFGH` and opens the dashboard's Connections page (`/connections`); a person signed in to the site types the short code there, sees the device's name and whether they are on the network Mythicshot asked from, and confirms it, and Mythicshot, which keeps asking with its long secret code, then receives a token for that person's workspace, once, with the username of whoever confirmed. Once it has, the account that confirmed gets one mail at its address naming the computer and the time and linking to the Connections page, so a connection nobody meant to make is noticed; the token's answer is the same whether or not that mail goes. Signing out before Mythicshot collects the token cancels it. The codes live 10 minutes, are never put in an address, and are stored only as digests. Signed-in people list, rename and revoke their workspace's tokens with `GET /api/v1/tokens`, `PATCH /api/v1/tokens/<id>` and `DELETE /api/v1/tokens/<id>`; a token cannot do any of that, and a revoked token is refused from its next request on. The one thing a token can do to tokens is end itself: `DELETE /api/v1/token`, sent with the token alone, revokes exactly that token and nothing else, so an app that disconnects can end its connection on the site too. Only a connection made by signing in from the app can end itself; the setup token answers `409 not_a_connection` and keeps working, since everything set up with it shares it. A token made this way also stops working after 90 days without use, by default (see [How long sign-ins last](#how-long-sign-ins-last)). The dashboard pages for this come in a later version; the requests are described at `/docs`.

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
| `GET /api/v1/me` | `200 {"workspace","workspace_id","account_id","version"}`: the workspace's name and id, the id of the account the credential belongs to, and the version of the server. `account_id` is the signed-in account for a session, and for a token the account it was made for (a new workspace's owner, or the account that confirmed connecting the app), so every token of one account gives the same id; it is `null` for a token no account is recorded for (a first token made by an older version). Both ids are random (`ws_`/`usr_` and 24 hex), never an email or a username, and describe only the caller's own credential. With two addresses the answer also has `addresses`, the two host names; see [One address or two](#one-address-or-two) |
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

Each tour has a viewing setting: `public` (anyone with the link, the default and how every tour worked before 0.1.38), `people` (the addresses on the tour's list, and the workspace's own account) or `me` (the workspace's own account alone). The list holds up to 200 addresses and is kept when the setting moves away from `people`. The workspace's account is matched by its address as it is at the moment of the check, so an email change counts at once.

| Request | Answer |
|---|---|
| `GET /api/v1/tours/<id>/access` | `200 {"access","viewers":[…],"limit":200,"can_restrict","switching"}` to a signed-in session: the setting, the whole list, whether the site can mail (which making a public tour `people` or `me` needs), and `{"done","total"}` while the live pictures move, else `null`. A token gets `{"access","viewers_count","limit","can_restrict","switching"}`: how many addresses, never the addresses |
| `PUT /api/v1/tours/<id>/access` with `{"access":"people","viewers":["ana@example.com"]}`, from a signed-in session (a token is answered `401`) | `200` with the same answer once done. `viewers` replaces the whole list; leave it out to keep the list. A published tour between `public` and the other two answers `202 {"status":"switching","done","total"}` while its pictures move: send the same request until `200`. Refusals: `400 bad_access`, `400 bad_viewer` (names the entry's position, never an address), `400 too_many_viewers`, `409 cannot_restrict` for a public tour on a site without mail, `409 republish_needed`, `409 access_switching` for another setting while a move is under way |

From 0.1.51 Mythicshot can choose the setting when it puts a tour online for the first time: the request that starts a tour's first publish, `POST /api/v1/tours/<id>/publish`, may carry `{"access":"people","viewers":["ana@example.com"]}` (or `"me"`, or `"public"`), checked as the dashboard's change of the setting checks it. The setting and the start of the publish are written together, before any picture is copied, so a tour made `people` or `me` is never public, not for a moment, and its pictures go to the private store only. Only a first publish takes them: a tour that has been published before, also one unpublished since, answers `409 already_published`. One whose setting or list was set in the dashboard answers `409 access_already_set` to a different setting, and to any `viewers` list while it holds one, right or wrong, so a token cannot test guesses of a list: a stated list is compared only when the same token wrote it at the tour's first publish and nobody (no session, no other token) changed the setting or the list since, which lets a request sent again after a lost answer join its own publish. A change to a tour's viewer list made by a version before 0.1.51 running on a database that 0.1.51 has migrated does not end that comparison, so the token that set the list at the tour's first publish could then test guesses of that change, as long as that first publish never finished: do not run an older version against a migrated database while such a publish is unfinished, and after going back to an older version and forward again, save each unpublished restricted tour's setting once in the dashboard, which ends the comparison. `access` alone, the setting the tour has, publishes it as it is set, and is refused with the same `409` if the dashboard changes the setting while the request runs. Nothing changes on any refusal. Changing the setting afterwards stays in the dashboard. `"public"` with no addresses is the same as leaving the fields out, and a publish without them is the same as before. On a site that cannot send mail a restricted setting is refused with `409 cannot_restrict` before anything changes. The audit record writes `tour_access_changed` with `by: token`, `at: creation` and the token's id (`token_id`, never the token).

A client that sends `access` must also send `"pad"`, text of any content that makes the body longer than 1,024 bytes (4,096 for an item's create): a server before 0.1.51 ignores `access` and would publish the tour, or share the item, for anyone with the link, but it refuses a body that long whole with `413` before doing anything. Every version from 0.1.0 to 0.1.50 does so (read from each one's code; the item route came in 0.1.19, and before it there was nothing to create); only builds from before 0.1.0 (version 0.0.0) took a publish body of any length and ignored it. 0.1.51 takes `pad` only with `access`, as text, within its limits of 66,560 and 69,632 bytes; anything else in `pad` is `400 bad_request`, and without `access` the old limits and their `413` stand. Checking the version `GET /api/v1/me` gives, and the `access` echoed in the answer, are second guards; for an item, a `201` without `access` means it is public, and it must be deleted before any part is sent. "Published before" is the tour being published now, or a mark on the tour that unpublish sets and nothing clears (migration 0017, which marks every tour that is published at the update): a tour unpublished by 0.1.50 or earlier left nothing behind and counts as never published.

A restricted tour's published pictures are kept in the private store, never in the public one, so a public bucket domain (`PUBLIC_IMAGE_BASE`) cannot serve them. Changing a published tour between `public` and a restricted setting moves the pictures of the version that is live now, never the draft, and keeps the link. Made restricted, the tour stops being public at the first request, and its public pictures are deleted as they move, also those a re-publish replaced that were still in their grace; a move its client leaves is finished by the workspace's next requests. Made public, it becomes public only once all its pictures are in place, and asking for the setting it still has cancels the move until then. A browser or a CDN that already holds a public picture keeps it for as long as it holds it. While its pictures move, the tour's page answers `404`, as for a tour that does not exist; between `people` and `me`, and for a change of the list, nothing moves. Publishing, unpublishing and deleting work for a restricted tour as for a public one, and a publish keeps its setting. Nothing is mailed to the addresses on the list.

> [!warning] Going back to a version before 0.1.38 is refused once a tour is restricted
> An earlier version does not know the setting; restore the backup taken before the update instead, which loses what was done since.

On cPanel, `cpanel.sh` checks the database before it shows the commands to go back and before an update with `--allow-downgrade` to a version before 0.1.38: while a tour is restricted, or being changed to or from that, it refuses both. When it cannot read the database it refuses too, unless it is given `--no-restricted-tours-checked-by-hand`, which states that someone checked by hand that no tour is restricted and none is being changed (it is used only when the database cannot be read; a tour it can see restricted is refused whatever is given). Going back to 0.1.38 or later is always allowed. On the Docker and Cloudflare routes nothing checks this before an earlier version is started: only the database stands in the way, whose triggers (migration 0014) make an earlier version's publish or rename of a restricted tour fail instead of making it public. The runbooks say how to check by hand.

### Restricted tours: what a visitor sees

A restricted tour keeps its link, `<tours address>/t/<slug>`. A visitor who opens it sees "This tour is shared with specific people" and enters an email address; the page then says that a link is on its way if the tour is shared with that address, the same words for every address, so the page tells nobody who is on the list. The mail holds a link to `<tours address>/view#…`, which works once and for 15 minutes; its page shows the address and the button "Open the tour", and only the press opens it, so a mail scanner that opens the link uses nothing up. The tour then plays as a public one does, with one line under it, "Shared with you, <address> · Not you?". "Not you?" leads to a page of the site that signs this browser out on a press, and the tour's link shows the request for an address again. A browser that proved an address the tour is not shared with sees "This tour is not shared with you" and "Use another address". A tour that is unpublished, of a disabled account, or whose pictures are moving answers as a tour that does not exist.

Every request for the page or a picture checks again whether the address may view the tour, so removing an address from the list, choosing `me`, unpublishing, disabling the account or changing the setting shuts the visitor out at the next click. A restricted tour's page and pictures are never cached (`Cache-Control: private, no-store`) and carry no ETag. Its pictures are served at `/t/<slug>/v/<name>` on the tours address, only to an address that may view the tour, and never from `PUBLIC_IMAGE_BASE`. The page and the "Not you?" sign-out live on the tours address alone; the app and img addresses answer `404`.

A restricted tour cannot be embedded in another site: its page forbids framing (`frame-ancestors 'none'` and `X-Frame-Options: DENY`). Embed a public tour instead.

### Who can view a shared image or clip

Each shared image and clip has the same viewing setting as a tour, from 0.1.47: `public` (anyone with the link, the default, and how every item worked before), `people` (the addresses on the item's list, and the workspace's own account) or `me` (the workspace's own account alone), with a list of up to 200 addresses kept per item. `GET /api/v1/media/<id>/access` reads it (a token gets how many addresses the list holds, `viewers_count`; a signed-in session gets the list), and `PUT /api/v1/media/<id>/access` with `{"access": "people", "viewers": ["ana@example.com"]}` changes it, from a signed-in session on the app address only, as for a tour. The item lists (`GET /api/v1/media`) and `GET /api/v1/media/<id>` answer `access` and `viewers`, the list's size. Making an item restricted needs a site that can send mail (`can_restrict`); an item already restricted stays so without mail. An item of more than 70,000,000 bytes cannot be restricted (`409 too_large_to_restrict`), since its whole file could not be sent in one answer past the check; the default size limits never reach it. From 0.1.51 Mythicshot can choose the setting when it shares an item: the request that creates it, `POST /api/v1/media`, may carry `"access"` and `"viewers"`, checked as the dashboard's change of the setting checks them, and only that request; changing it afterwards stays in the dashboard. The item is created with the setting, so a restricted item is never served to anyone without access: nobody is served it until it is finished, and from then on only an address it may be viewed by. Its link from the commit is the one that works for them, kept apart from the column older versions read, as for any restricted item. What cannot be restricted is refused there before anything exists (`409 cannot_restrict`, `409 too_large_to_restrict`), and the answer adds `access` and `viewers` (how many addresses) after `part_bytes` when the request stated a setting, never otherwise. The audit record writes `media_access_changed` with `by: token`, `at: creation` and the token's id. Send `"pad"` with `access`, as for a tour (above). From 0.1.48 the dashboard's Images and GIFs pages show each item's setting in a "Who can view" column and change it with the Sharing box a tour has ("More", then "Sharing…").

Nothing moves when the setting changes: an item's file was always kept in the private store and served only by the server, so the change holds from the next request. Every request for a restricted item's page, file, download or preview picture checks again, from the database, whether the browser proved, on the address for images and clips (the img address, else the tours address), an address the item may be viewed by now: removing an address, choosing `me`, deleting the item or disabling the account shuts the visitor out at the next request. An answer already being sent is not cut off, but a player's next range request is refused. A browser that proved no address gets "This image is shared with specific people" (or "This clip …"), enters an email address and gets a link to `<media address>/s/view#…`, which works once and for 15 minutes; a browser whose address may not view it gets "This image is not shared with you". The same mail limits as a tour's apply, shared with the tours' requests: an address, a network, a workspace and the site get no more viewer mail from the two together than from either. Link previews in chat apps get the same page asking for an address, with nothing of the item.

The proof of an address for images and clips is a viewer session of its own (the cookie `__Host-dp_media_viewer`, its own tables): a person who proved an address for a tour proves it once more for an image, and signing out of one leaves the other, also where both live on one address. A restricted item's answers are never cached (`Cache-Control: private, no-store`) and carry no ETag, cannot be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) or used by another site's page (`Cross-Origin-Resource-Policy: same-origin`), so it cannot be embedded. What someone saved while the item was public stays saved: restricting protects it from then on. No cache answers for a public item without asking the site either: a public item's page, file, download and preview are sent with `Cache-Control: no-cache` and an ETag, so a cache that held it cannot keep serving it once it is restricted; only a copy stored under 0.1.46 or earlier can live up to an hour after the update.

> [!warning] A CDN or proxy rule that overrides the site's cache headers defeats restricting
> A rule in front of the site that keeps answers for a lifetime of its own, such as a "cache everything" rule, would go on serving an item after it is restricted: no such rule may cover `/i/` and `/r/`.

> [!warning] Going back to a version before 0.1.47 is refused once an item is restricted
> An earlier version does not know the setting; restore the backup taken before the update instead, which loses what was done since.

A version before 0.1.47 looks an item up by the column that holds its link, so a restricted item's link is kept in another column while it is restricted, and such a version answers it as a link that does not exist; but it would still hand the item's owner a link of its own that does work. On cPanel, `cpanel.sh` refuses to go back below 0.1.47 while an item is restricted, as for tours below 0.1.38, and `--no-restricted-items-checked-by-hand` states that someone checked by hand when the database cannot be read. On the Docker and Cloudflare routes nothing checks it: before going back, check by hand that no row of the `media` table has an `access` other than `public` (the runbooks give the one-line command); any such row means restore, not go back. An older version also cannot fully delete an item whose list of addresses holds one, whether the item is restricted now or was before (the list is kept when an item goes back to public): its delete stops serving the item and removes its files, but answers `500 cleanup_pending` every time and leaves the item's row, which 0.1.47 or later removes at the workspace's next share or when the delete is sent again.

> [!warning] What a visitor has seen cannot be taken back
> Removing an address stops the next request, but pictures and text a visitor already saw may still be on their screen, in a screenshot or in a copy they made.

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

### Reorder or remove a tour's chapters

From 0.1.55 a tour's chapters can be put in another order, and any but the last removed, from the dashboard's Chapters box ("More", then "Chapters…" on the Tours page) or with two requests, which take a token or a signed-in session like rename and delete:

| Request | Answer |
|---|---|
| `GET /api/v1/tours/<id>/chapters` | `200 {"revision":4,"chapters":[{"id":"ch_…","title":"…","position":0,"steps":14,"pictures":14,"uploaded_at":1800000000000},…]}` in the order visitors see them. `pictures` counts the picture files the chapter's steps use; `uploaded_at` is when it was last uploaded (a new chapter or a replace), or `null` when that is not known: before 0.1.55, which is so for every chapter but the one a tour was made with, and (from 0.1.56) after a replace made by any earlier version, 0.1.55 included, run on the updated database, until 0.1.56 or later replaces the chapter again |
| `PUT /api/v1/tours/<id>/chapters` with `{"revision":4,"chapters":["ch_…","ch_…"]}` | `200` with the chapters as they are now and the next revision. The list is the ids to keep, in their new order; a chapter of the tour not in it is removed, with its steps and its pictures, for good. A list that changes nothing changes nothing |
| the same, refused | `409 tour_changed` when someone uploaded, replaced or changed the chapters since the revision was read (read them again); `404 not_found` with detail `no such chapter` for an id that is not a chapter of this tour, and `no such tour` for another workspace's tour, as for an unknown one; `400 last_chapter` for an empty list (delete the tour instead), `400 too_many_chapters` past 400 ids (from 0.1.56 a tour has at most 400 chapters: a new chapter for a tour that has 400 is refused at its upload with `409 too_many_chapters`, and a tour that got more before then is brought down to 400 by one change that removes the rest), `400 bad_request` for an id listed twice or a body of another shape. Nothing changes on any refusal |

The change is one batch: positions are numbered from 0 again, the removed chapters' steps and rows go, and their pictures are deleted by the clean-up a replace uses (files first, then rows, and not while a publish of an older draft still copies from them). It changes the draft only: the public page stays as it was until the tour is published again, and the tour list says `unpublished_changes`, as after a replace. The tour keeps its title, link, settings and logo whichever chapter comes first; from then on a replace of the new first chapter carries the settings and one of the former first does not. A replace still being uploaded for a removed chapter, or for the first chapter before or after when another one becomes first, is cancelled and its files removed: its next request answers `404`, and one that was being started at that moment answers `409 chapter_changed`. Migration 0019 adds `chapter.uploaded_at` (nullable; older builds never name it, and going back needs nothing). Migration 0020 (0.1.56) adds one trigger that empties a chapter's `uploaded_at` whenever its revision changes, which only a replace does, so after this update a replace made by any earlier version, 0.1.55 included (whose time is emptied right after it writes it), leaves the chapter with no date until 0.1.56 or later replaces it again, rather than the date of the pictures it replaced; this version dates its own replaces in a later statement of the same batch. It changes no row when it runs, and going back needs nothing.

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

### The low storage mail

A workspace with an allowance gets at most two mails each time it fills up, at its own account's address (its oldest account, the one the removal warnings go to): one when it uses 80% of its allowance ("Your Mythicshot storage is 81% full"), and one when it uses all of it ("Your Mythicshot storage is full"). A workspace that goes from under 80% straight to 100% or more gets only the second. Neither comes again until the workspace uses less than 70% of its allowance; then both can come again. A site or workspace without an allowance (or with an allowance of 0), a workspace that is read-only (a trial that is over, an ended subscription) and an account that is disabled or being removed never get it. It goes to that one address and to no one else, and holds nothing of another workspace.

Each mail has a plain-text part and a designed part with the Storage page's numbers (what is used, what is left, and what tours, GIFs and images take, written as the Storage page writes them), a button to the Storage page and, for a workspace on its trial on a site with billing, a link to the Subscribe page. Its two pictures (the mark and the name) travel inside the mail, so opening it makes no request to any server; it has no tracking and no remote font. The line about a subscription is left out when the workspace's allowance is already 5 GB or more. Its links start with the site's own address (`APP_HOST`, or `SITE_HOST` on one address); without one, the mail says where to go in words. `MAIL_FOOTER` (see [Settings](#settings)) adds one line at its foot, such as the company that runs the site; without it there is none.

A workspace is checked after the answer to each request that changes what it uses (a finished upload, image or clip, a deleted tour, image or clip, a removed chapter, an admin's new allowance), so a mail goes out within seconds, and the request never waits on it or fails because of it. Each mail is recorded once the mail server took it (under a digest of the address, never the address, with the audit row `storage_mail_sent`), and never sent twice for one filling-up. With mail off, or when the mail server refuses it, nothing is recorded and the server's admin command `storage-sweep` sends it later:

```sh
./cpanel.sh admin storage-sweep             # on shared hosting, with the settings file
node dist/node/admin.js storage-sweep       # beside the app, with the app's settings in the environment
node dist/node/admin.js storage-sweep --dry-run
```

Run it once a day, with or without billing, for instance with the crontab entry `27 4 * * * /home/you/cpanel.sh admin storage-sweep >> /home/you/storage-sweep-output 2>&1`. It also finds workspaces whose allowance changed through billing (a trial that subscribed), and arms the mails again for those below 70%. It prints counts only and sends at most 50 mails a run; `--dry-run` sends and writes nothing. A mail that was handed to the mail server and then failed (it may have arrived), or whose sending was cut off by a stop of the server, is never sent again by itself for that filling-up: every run of the sweep lists such a workspace by its id once its claim is an hour old, and the admin clears it with `storage-sweep --clear-claim <workspace id>` (recorded as `storage_mail_claim_cleared`), so the next check or sweep sends it if it is still due. A workspace that drops below 70% clears it too.

On Cloudflare the same sweep runs in the Worker's scheduled handler, beside the billing sweep, when an install adds a cron trigger; since a Worker sends no mail in this version, it sends nothing there, and no request asks for a check.

## Billing (optional)

A site can charge for its workspaces with one paid plan, Mythicshot Essentials, sold through Stripe. Billing is off unless all four Stripe settings are present: `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` and `STRIPE_PUBLISHABLE_KEY` (see [Settings](#settings)). With none of them there is no billing at all: no billing route exists (each answers the app's own 404), no screen mentions it, no trial or plan limit applies and nothing is ever read-only, so a self-hosted site without them is exactly as before. Some but not all of the four stop the start, with a line that names the missing ones: the Node server does not start and the Worker answers `misconfigured`. So does a setting that is present but not of its shape (`rk_` or `sk_`, `whsec_`, `price_`, `pk_`), and a pair of keys of two modes: `STRIPE_API_KEY` and `STRIPE_PUBLISHABLE_KEY` must both be test keys (`rk_test_` or `sk_test_` with `pk_test_`) or both live keys (`rk_live_` or `sk_live_` with `pk_live_`). No line ever holds a value. Billing also needs the site's own https address, `APP_HOST` (with `TOURS_HOST`) or `SITE_HOST` on one address: Stripe sends people back there, never to the address a request names. Without it the start stops the same way. The one exception is a run on your own computer against a Stripe sandbox: with both keys test keys, an address of exactly `localhost` or `127.0.0.1` (any port) over http is taken for Stripe's return addresses, and nothing else is relaxed; a live key never gets it.

With billing on:

- A workspace made while billing is on is on a trial: 100 MB for 90 days from its creation, with no card asked for. After 90 days it is read-only, its links come down, and its content is removed after three warning mails, only where removal is switched on (see [Removal after 90 days](#removal-after-90-days)).
- A subscribed workspace (Stripe says `active`, `trialing`, or `past_due` while Stripe retries a failed renewal) has 5 GB (5 GiB, 5,368,709,120 bytes).
- When a subscription that once went live ends (`canceled`, `unpaid`) the workspace is read-only at once: its tours, images and clips can be viewed, downloaded and deleted, and who may view can be narrowed, but an upload, a publish, a rename or a change that widens who may view is refused with `402 subscription_ended`. A subscription Stripe no longer has (after a data-deletion request) counts as ended. A subscription whose first payment never completed (`incomplete`, or `incomplete_expired` once Stripe gives up on it after a day) never went live: since 0.1.62 the workspace simply stays on its trial, with the trial's allowance, writes, links, mails and removal day counted from its creation (0.1.57 to 0.1.59 made it read-only at once).
- Every workspace made while billing is off (all of them before 0.1.57, and all that a site without the settings makes) is exempt, also if billing is switched on later, and so is the admin's own: they keep the site's default allowance and see nothing of billing. An exempt workspace that subscribes anyway (its Subscribe page is at `/billing/subscribe`) gets the plan like any other while it pays.
- An allowance the admin set by hand is always the size. A workspace that has never had a subscription and has such an allowance is exempt too; once it has had one, its end makes it read-only like any other.
- A subscription the site thinks is live, whose paid period ended more than 3 days ago without a renewal on record, is read back from Stripe before it is trusted, at most once a minute per workspace; while Stripe cannot be reached the workspace is read-only for writes (nothing is taken down). When Stripe confirms it live with that old period end, it is trusted for a day and the audit record says so once.
- Deleting an account on the Admin page records the delete first (from then on the account cannot be enabled), then cancels its workspace's subscription at Stripe (any that is not already `canceled` or `incomplete_expired`), at once and without a refund, voids its open invoices, and closes every checkout of it that has not expired (one that turns out paid has its subscription cancelled too). When Stripe gives no definite answer, nothing is deleted and the delete can be sent again.
- Disabling an account does not cancel its subscription: a disable can be undone, so Stripe keeps charging while it is disabled. Only deleting the account cancels it.
- The Admin page's summary request (`GET /api/v1/admin/summary`) also answers `billing_problems`: how many paid checkouts no workspace stored, second paid subscriptions of one workspace, and paid checkouts that named a workspace's checkout but not its reference or its customer the audit record holds, and the newest of them. Each is money taken without access: it needs a look in Stripe, and a refund by hand where one is due.
- The requests to billing are counted per workspace: 20 checkouts, 30 visits to Stripe's own page and 60 checks of a checkout an hour, and 600 reads of the billing state an hour.
- The record of the checkouts the site made is kept until 7 days after each expired, then cleared by the workspace's own housekeeping.
- An answer of Stripe that the site refuses for its shape is never only "the payment service did not answer": it writes one audit row, `billing_answer_refused`, naming the call and the field (never the value), counted in `billing_problems`.
- The dashboard shows a notice at the top of each page when one applies, a Billing section on the Account page, a Subscribe page where Stripe's own payment form opens inside the dashboard, and the page Stripe sends a person back to. Card details never reach the site. Manage subscription opens Stripe's own page for changing the card or cancelling.

### Removal after 90 days

With billing on, a trial that ends without a subscription, and a subscription that ends, start a clock. Nothing of this applies to an exempt workspace (every one made while billing was off), the admin's own, one with an allowance the admin set by hand (also after it had a subscription), the workspace the site was set up with, or a workspace with more than one account: they are never mailed, taken down or removed, and their dashboard shows no removal date.

- **Links come down.** A trial's published tours, shared images and clips stop answering visitors the moment the trial ends; an ended subscription's 30 days after it ended. A visitor gets exactly what an unpublished tour or a deleted item answers, so nothing new is revealed. Nothing is changed or deleted: a subscription makes them answer again at once. This is decided on every request from the workspace's stored state, in the lookup each public route already makes, so it costs no call more. On a site with a public bucket address (`PUBLIC_IMAGE_BASE` set), links coming down hides the pages; the pictures stay reachable at their addresses until removal or unpublish, since they never pass through the app.
- **The removal day** is the first full UTC day after the 90 days: for a trial, 90 days after the account was made; for an ended subscription, 90 days after it ended. The dashboard's Billing section and notices show that day, the same one the sweep acts on, in UTC.
- **Three warning mails** go to the account's own address, 30 days, 7 days and 1 day before the removal day, in the approved words, with a link to the Subscribe page and to the Account page. Each is recorded once the mail server took it (which mail, when, and for which removal day, under a digest of the address, never the address), and never sent twice for the same day. With mail off, or when the mail server refuses, nothing is recorded and the next sweep tries again. One sweep sends at most 50 warning mails, to the workspaces due longest first; the rest go at the next sweep. A mail whose sending was handed over and then failed (it may have arrived) is never sent again by itself: the sweep lists that workspace's id, and the admin clears it with `billing-sweep --clear-claim <workspace id>` (recorded as `billing_warning_claim_cleared`) so the next sweep sends it. A mail sent late names a later day: the removal never comes before a day a mail named. When the removal day moves (the workspace subscribed and its subscription ended again), or the account's address changes, the warnings start over.
- **Removal is off unless the setting `BILLING_REMOVAL=on` is present** (see [Settings](#settings)). Without it, mails go out and links come down, but nothing is ever removed.
- **The trial notice** at the top of the dashboard reads "Trial: N days left. You're using X of 100 MB. On <date> your content is permanently removed unless you subscribe. You can download everything from your Account page.", with the workspace's removal day. Like the other notices and the mails, it states the policy's date whatever `BILLING_REMOVAL` says: the setting only holds the removal itself back, and the warnings are what it needs first. "Account page" in that sentence, in the other notices and in the mails leads to the "Download all my data" card (`/account#h-data`).

With `BILLING_REMOVAL=on`, a workspace's tours, images, clips and their files are removed and its account is closed only when all of these hold, each checked at the moment of removal:

1. Billing is on and the workspace is on the clock (not exempt, not the admin's, not made before billing, no allowance set by hand, not the site's own, exactly one account), and that account is active and no admin.
2. Its removal day has come, and the 90 days have passed.
3. All three warnings for this removal day were taken by the mail server: the first at least 29 days ago, the last at least 20 hours ago. A warning whose sending was never confirmed holds the removal back until the admin clears it.
4. The account's address is the one the warnings went to.
5. Stripe, asked right then, gives a definite answer: a trial with no customer at Stripe needs no question; a subscription on record must not be live, and not `incomplete` (a first payment in progress, which Stripe resolves by itself: the sweep waits and asks again at the next run, and never cancels it). One that is over (`canceled`, `incomplete_expired`) is fine as it is; any other (`unpaid`, `paused`) is cancelled at Stripe first, at once and without proration, and nothing is removed until Stripe answers `canceled`. Then its open invoices are voided, so none stays payable; a void that fails holds the removal. Every checkout record of the workspace is asked at Stripe, at most 10 a run (more wait for the next run): one Stripe confirms expired is cleared, and so is one Stripe says was paid whose subscription is the one on the workspace's record (its notice linked it); one Stripe says was paid for any other subscription (its notice never reached the site) holds the removal for good, is linked to the workspace as its notice would have, and is shown among the billing problems (`billing_checkout_paid_unlinked`, once per checkout); any other answer holds. A record is never cleared on its age alone, here or by any other housekeeping. No answer, a timeout, a 404, a permission error or anything unexpected removes nothing; a live subscription is stored as Stripe says and removes nothing.
6. No download of the workspace ("Download all my data") is in progress: a download address asked for and not opened yet, or a download not ended. It is asked before the start and before every pass, and holds the removal while it lasts, but for at most 24 hours from the first time it held this removal day's removal; after that only a download being sent at that very moment holds it. While a removal is recorded, the download requests refuse with `409 deleting` (an account being removed cannot sign in anyway).
7. The sweep has started fewer than 5 removals in this run and 20 in the last 24 hours, and no other sweep is running (a second one exits at once; the sweep renews its lock before each workspace and between the passes of a long removal, and stops if it lost it).
8. The server's clock and Stripe's (the time on a Stripe answer of the same run, or one request for the price when a trial needs no other) are less than an hour apart; otherwise nothing is removed in that run, and the sweep says to check the server's time.

A removal starts by disabling the account (it cannot sign in, its tokens are refused, nothing of it is served) and recording the removal, in one step that changes nothing if anything changed meanwhile. It then removes everything in the same steps as an admin's delete. Before every pass the workspace is read again, and Stripe asked again: if its subscription went live (an unpaid invoice paid after all), a checkout was made after the removal started or is still open, or the workspace left the clock (an allowance set by hand, an admin, another account), the removal stops for good before anything is cancelled or deleted. The account stays disabled with its removal recorded, the audit record gets `billing_removal_stopped` with the reason (shown among the billing problems on the Admin page), and no sweep continues it. What the admin does then, by hand:

1. Look the customer up in Stripe: whether the subscription is live, and whether money was taken (an invoice paid, a checkout completed).
2. If money was taken for content that was already partly removed, refund it by hand in Stripe, as far as is fair.
3. Then either undo the removal (`POST /api/v1/admin/accounts/<id>/undo-removal`, which for a stopped removal works even after files went, answers `{"restored": false, "files_removed": <n>}`, and clears the warning mails) and enable the account, or finish it with the delete, which cancels the subscription and voids its open invoices first. Subscribe is refused while a removal is recorded. Stopped half-way for any other reason (a store that failed, the call budget), it leaves nothing reachable, and the next sweep finishes it. An admin's undo that lands while a removal is asking Stripe is honoured: nothing is removed. The audit record gets `billing_warning_sent` for each mail, then `account_disabled`, `billing_removal_started` (with counts), `billing_removal_step` (the files left), `account_deleted` (under the sweep's own all-zero id) and `billing_removal_finished`, with ids and counts only. Nothing of another workspace is ever touched.

### The billing sweep

Nothing runs on a timer inside the app. The mails and removals are done by the server's admin command `billing-sweep`, which no request to the site can start:

```sh
./cpanel.sh admin billing-sweep             # on shared hosting, with the settings file
node dist/node/admin.js billing-sweep       # beside the app, with the app's settings in the environment
node dist/node/admin.js billing-sweep --dry-run
```

It prints a few lines of counts: the warnings sent and those to try again, and the removals started and finished, held back, or over the cap. `--dry-run` sends, writes and removes nothing (not even an audit row) and lists the workspaces it would remove, by id; on a site with a public bucket address it also says that pictures stay reachable when links come down. Run it once a day. A daily entry in the server account's crontab, such as

```
17 4 * * * /home/you/cpanel.sh admin billing-sweep >> /home/you/billing-sweep-output 2>&1
```

runs it at 04:17 every day; the site creates no such entry itself. Without billing it says so and does nothing.

On the Worker target the same sweep is a scheduled handler, within one invocation's call budget (a large removal is finished over several runs). It is not wired: the Worker's configuration has no cron trigger, and since this target sends no mail yet, no warning can be recorded there, so nothing would ever be removed.

### Register the listener in Stripe

The site switches a workspace on and off from Stripe's signed notices. In Stripe's dashboard, under Developers, Webhooks, add an endpoint with the address `https://<app address>/api/v1/billing/webhook` (on a site with one address, that address), and choose these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created` and `radar.early_fraud_warning.created`. Stripe then shows the endpoint's signing secret (`whsec_...`): that is `STRIPE_WEBHOOK_SECRET`. The restricted key needs to write Checkout Sessions, customer portal sessions and subscriptions (to cancel one when its account is deleted) and to read subscriptions, Checkout Sessions and charges. Prices: read is recommended: with it the site checks at its start (on Cloudflare, on its first request) that the key belongs to the account that owns `STRIPE_PRICE_ID`, and a price Stripe says does not exist stops the start; without it the Admin page's summary request says `billing_price: "could_not_check"` and the site runs.

The listener accepts nothing without a valid `Stripe-Signature` made in the last five minutes, takes each notice once, and never trusts a notice about who paid: a completed checkout is matched only by the checkout ids the site recorded when Subscribe was pressed, every later notice only by the Stripe customer and subscription on the workspace's own record, and the subscription's state is always read back from Stripe before it is stored, only while the record is still as it was read. If Stripe cannot be read, or the record changed meanwhile, nothing changes and the listener answers 500, so Stripe sends the notice again. A checkout lives from 32 to 33 minutes, and the one shown last is replaced only once Stripe confirms it expired. A notice of a subscription that is not linked to a workspace is held back (answered 500, for Stripe to send again) only while it may be one a checkout's notice will link: the subscription was made in the last 2 hours and, for a customer the site does not know, a checkout of the site was made before it and had not expired more than 10 minutes before it. Every other one is taken at once.

The Subscribe page is the one page whose Content-Security-Policy allows Stripe's script, frames and connections (`js.stripe.com`, `checkout.stripe.com`, `api.stripe.com`, pictures from `*.stripe.com`); every other page keeps its own.

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

`GET /api/v1/me` adds the two host names as configured, without a scheme: `{"workspace":"Acme Tours","workspace_id":"ws_…","account_id":"usr_…","version":"…","addresses":{"tours":"tours.example.com","app":"app.example.com"}}`. With one address the key is absent and the answer is as before. The `url` of a tour in the tour list and in the publish answer stays the path `/t/<slug>` on both addresses.

Mythicshot keeps the tours address. The setup wizard is on the tours address only, the server address it shows is that one, and Mythicshot builds every tour link from the server address it was given. Pointed at the app address its uploads would still work, but the links it shows would be on the app address and reach the tour only through the redirect.

The host name is taken from the address the request was sent to: the `Host` header on Node, the request's own address on Cloudflare. No `X-Forwarded-Host`, `Forwarded` or `X-Original-Host` header is read, and there is no setting to trust one, so whatever stands in front of the platform must pass the `Host` header on unchanged. On Node with two addresses, a request whose request line holds a full address instead of a path gets the empty `421` too.

### An optional third address for images and clips

Beside the two addresses an install can add a third, the img address, such as `img.example.com`, with one more setting, `IMG_HOST`. It is optional: without it, shared images and clips answer on the tours address, and everything else answers exactly as described above whether the img address is set or not. The img address exists only beside the other two, never on its own and never on one address.

The img address answers shared images and clips and `/healthz` and nothing else: every other path there, the token API, the session, the sign-in pages and the dashboard included, answers `404` with `{"error":"not_found"}`, and nothing redirects to it or from it. No session cookie is taken or set there, and no token is taken there either. Asked on it, `/healthz` prints `{"ok":true,"address":"img"}`. The pages and files a shared link opens are `/i/<link id>` for an image and `/r/<link id>` for a clip, the file itself at the same address with its extension (`.png`, `.jpg`, `.gif` or `.mp4`), `/download` and `/preview` after the link id, and the pages' own stylesheet and script under `/s/`. A deleted, unfinished or unknown item, and one of a disabled account, answers one "This link no longer works" page. From 0.1.47 an item's page, file, download and preview are sent with `Cache-Control: no-cache`: a browser or a shared cache may keep a copy, but must ask the site before it uses it again, so a deleted, restricted or disabled item is not served from a cache. A copy a shared cache stored under 0.1.46 or earlier may still be served for up to an hour after the update, and a page for up to a minute; a browser that already loaded a file still has it. With one address, shared files are served on the same address as the dashboard, protected only by their fixed type and the `nosniff` and `sandbox` headers, so a hosted service should set `IMG_HOST`, with the two other addresses, to give them an address of their own.

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

The optional third address is added the same way on each route, after the two work: on shared cPanel hosting one more subdomain and one more line, `IMG_HOST`, in the settings file (see [An optional third address for images and clips](docs/hosting/cpanel.md#an-optional-third-address-for-images-and-clips) in that guide); on Cloudflare, like the other two, not yet with the guided setup; on Docker on Debian `--img-domain=<name>` beside `--app-domain` on a first install, or one `IMG_HOST` line added to `.env` by hand on an existing one, after which the script adds the name to Caddy and checks all three addresses by their role (see [A third address for images and clips](docs/runbook-docker.md#a-third-address-for-images-and-clips)); started by hand, `IMG_HOST` in the same environment. To go back, remove the `IMG_HOST` line and restart (on Docker, run `install.sh install` again): shared images and clips then answer on the tours address again.

To go back to one address, remove both settings (on Docker, the `APP_DOMAIN` line) and restart the app; each of the three pages above gives the steps. The tours address is the same name before and after, so links to tours that are already out there keep working both ways.

## Accounts and signing in

People sign in to the site in a browser to use [the dashboard](#the-dashboard). With two addresses the sign-in page and the dashboard are on the app address; with one address they are on that address. Mythicshot does not sign in: it keeps using its API token.

### Signing in by link

There is no password. The sign-in page, `/signin`, asks for an email address and mails a link to it. Its answer is the same for every address ("If <address> has an account, a sign-in link is on its way."), so the page cannot be used to find out who has an account.

A link is mailed only when all of these hold: the address belongs to an active account, the site has an admin (see [The first admin](#the-first-admin)), mail is set up (see [Mail](#mail)), and the address has not asked too often. Each address gets at most 3 links in 15 minutes and 10 a day; past that the page answers as always and nothing is sent. One network may ask 10 times in 15 minutes and is then told to wait, but only where the site knows the visitor's network address (see `CLIENT_ADDRESS_HEADER` in [Settings](#settings)). The whole site sends at most 100 sign-in mails an hour.

A link works once and for 15 minutes. Opening it shows a "Sign in" button, and only pressing the button signs in, so a mail program that opens links to check them uses nothing up. After the press the browser lands on the dashboard's Tours page, `/tours`. A newer link does not cancel an older one: each works until it is used or its 15 minutes are over.

### Sessions

A session ends 30 days after it was last used, so a browser in use every day stays signed in, and in any case 90 days after its sign-in, however active it is; the browser then signs in again. Only a digest of the session's cookie is stored.

### How long sign-ins last

Three optional settings, each a whole number of days, decide when a sign-in has to be made again. They are read when a request is made, from the times the database already holds, so a changed setting applies at once to every session and connection that exists, and an update needs no data change for them. `0` or `off` switches one off.

| Setting | What ends | Default |
|---|---|---|
| `SESSION_MAX_DAYS` | A browser session, this long after its sign-in, however active it is | 90 |
| `CONNECTION_IDLE_DAYS` | A connection made by signing in from Mythicshot, after this long without use | 90 |
| `CONNECTION_MAX_DAYS` | A connection made by signing in from Mythicshot, this long after it was made, however active it is | off |

A session or connection past its limit is refused exactly as a signed-out session or a disconnected computer is, so Mythicshot shows its "Sign in" state. A connection in regular use never lapses: each request it makes counts as a use. The setup token and the first token of a workspace are never touched. The Connections page says under each connection from Mythicshot when it expires ("Expires 20 Feb 2027 unless it is used", or "Expires 20 Feb 2027" when its age limit comes first), and a lapsed one stays listed as "Expired 20 Feb 2027. Sign in again from Mythicshot." until it is disconnected; the Account page says when each session ends. The API gives the same in `GET /api/v1/tokens` (`expires_at`, `expired`), `GET /api/v1/sessions` and `GET /api/v1/session` (`ends_at`, and the three limits in `limits`).

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

A tour can be shared with a list of email addresses instead of everyone with its link. A visitor then proves an address on the tours address (with one address, on that address) and gets no account: the tour's page asks for the address, the site mails a link that works once and for 15 minutes, and pressing the button on the page the link opens makes this browser a viewer of that address for 30 days of use, never longer than 180 days. The viewer's cookie, `__Host-dp_viewer`, is its own: it is never an account's session, opens nothing of the dashboard or the API, and an account's session is never a viewer. Asking for a link answers the same whatever the tour or the address, and a link goes only to an address the tour's own list holds. One address gets at most 3 viewer links in 15 minutes and 5 a day however many tours or networks ask, and at most 2 for one tour in 15 minutes. The tours of one workspace get at most 30 viewer mails an hour, on a cap of their own apart from sign-in's, so one workspace can never use up the mail of another; the whole site sends at most 1000 an hour, a backstop against a fault. Anyone who knows an address can use up that address's viewer links for the day by asking for them, which delays that person and nothing more. Disabling or deleting an account does not end the viewer sessions of the same address: a viewer is an address, not the account, and each tour decides by its own list. The requests are described at `/docs`; what a visitor sees is in "Restricted tours: what a visitor sees" above.

## The site's terms

A site can ask everyone who signs in to agree to its terms before they use the dashboard. Terms belong to each site: a site that has published none asks nothing of anyone, and everything works as before.

### Publish terms

Write the terms in a plain-text file (not HTML) and publish it with the server command, beside the running app:

```sh
node dist/node/admin.js terms publish terms.txt
```

On cPanel this is `./cpanel.sh admin terms publish terms.txt` ([the cPanel guide](docs/hosting/cpanel.md#publish-the-sites-terms)); with Docker the file is handed over on standard input, `docker compose exec -T app node dist/node/admin.js terms publish - < terms.txt` ([the Docker runbook](docs/runbook-docker.md#publish-the-sites-terms)). `terms list` lists every version published, oldest first, with how many accounts agreed to each, and `terms show <id>` prints one exactly as it was published. On Cloudflare there is no server command yet, as for the other admin commands, so terms cannot be published there yet ([the Cloudflare runbook](docs/runbook-cloudflare.md)).

The file format, with a full example, is [docs/terms-example.txt](docs/terms-example.txt). Line by line: `title:` and `version:` (free text, such as a date), up to three `link: <label> | <https address>` lines, `main points:` followed by 1 to 12 lines starting with `- ` (each at most 300 characters), then `terms:` followed by the full terms (at most 200,000 bytes), where a line starting with `# ` is a heading, lines starting with `- ` are a list, and other lines are text, joined into a paragraph until a blank line. There is no markup: everything is shown as text, and the only links are the `link:` lines, each an https address with a host name, no user name or password and no `#` part. A file that breaks a rule is refused with one line that names the line, such as `line 4: this main point is empty.`; the same content as a version already published is refused too.

Each version is kept exactly as it was published, so there is a record of what each person agreed to: a version is never changed or deleted, and publishing new terms adds a version.

### Who is asked, and when

Right after someone accepts an invite, and at the next sign-in or dashboard request of every existing account, the admin's too, the dashboard shows the terms screen: the title, the main points (a summary), the full terms in a box that scrolls, the links, and "Sign out" and "I agree". Until the account agrees to the current version, its session reaches nothing but that screen, the terms it agreed to before, and signing out: every dashboard page goes to the screen, and every API request made with the session answers `403 terms_required` and does nothing. That includes the page that approves connecting a computer. "Sign out" ends the session and leaves the account as it is. When the site publishes new terms, the screen comes back at each account's next request, with the new version; the older agreement stays on record. If newer terms are published while someone reads the screen, their "I agree" records nothing and the screen shows the new version.

The server command is never held back, so a site whose admin has not agreed can always publish new terms.

### What is stored

For each agreement, the account, the version and the date and time, and nothing else: no network address and no browser, as the site stores neither on accounts. The audit record gets `terms_agreed` with the account's and the version's ids. The Account page says "You agreed to the terms of <version> on <date>." with "Read them", which opens that version read-only; the Admin page and the admin API's list of accounts give each account's version and date, or "Not yet". On the Admin page the Terms column shows on a site that has published terms; an account that agreed only to an older version reads "Not yet", with "Agreed to <older version> on <date>" under it, and the API marks each agreement `current` or not and names the site's `current_terms`. Deleting an account removes its agreements; the audit rows stay, ids only, as for everything else.

### What the terms leave alone

Connected computers keep working: an API token is never held back by the terms, whatever the account's state, and every request made with a token answers exactly as before. Connecting a computer needs a signed-in browser, so nobody connects one without having agreed once; after the terms change, a computer already connected is not cut off. Visitors of shared tours, images and clips never see the terms: nothing on the tours address or the address for images changes, and viewer sessions are not affected.

### Accepted, and said here

- A request that the terms hold back still records that the session was used, as every session request does.
- A computer whose connection was approved before new terms were published can still collect it within the code's 10 minutes.
- Two publishes at the same moment: one wins, and the other prints one line saying so and changes nothing.
- On a site without terms nothing visible changes, but the dashboard's static files and the admin API's list of accounts (`terms: null` on each account, `current_terms: null`) differ from before.

## The dashboard

The dashboard is the set of pages a signed-in person uses on the app address (or the one address). `/` sends a signed-in browser to the Tours page and anyone else to the sign-in page. Tours are recorded, edited and renamed in Mythicshot; the dashboard lists them, shares them, publishes and unpublishes them, and deletes them. Images and GIFs are shared from Mythicshot too; the dashboard lists them, shares their links, sets who can view them and deletes them.

| Page | What it does |
|---|---|
| Images, `/images` | Lists the workspace's shared images, newest first, each with its preview, size, width and height, type, who can view it and the day it was shared. "Copy link", "Open" and "More", which holds "Sharing…" (the Sharing box a tour has, to choose who can view the image) and "Delete"; "Show more" past the first 50. Delete asks first and cannot be undone; the copy on the computer is not touched |
| GIFs, `/gifs` | The same for shared clips (GIFs and MP4s), with each clip's length in seconds |
| Tours, `/tours` | Lists the workspace's tours, most recently changed first, each with its steps, size, the day it changed and whether it is published or has changes waiting. "Copy link" and "Open" for a published tour; "Publish", "Publish changes", "Unpublish" and "Delete"; "Chapters…" opens the Chapters box, to move chapters up and down or remove them, saved together with "Save changes". Delete asks first and cannot be undone; the recording on the computer is not touched |
| Storage, `/storage` | What the workspace uses: against its allowance with a bar when it has one, with its numbers of images, GIFs and tours; what takes the room (tours, GIFs, images, logos, uploads in progress); and its largest items of every kind, each marked Tour, Image or GIF, with "Delete". A workspace over its allowance sees a warning |
| Account, `/account` | The username, the email address and the workspace, and on a site with terms the version agreed to (see [The site's terms](#the-sites-terms)); with `DOWNLOAD_URL` set, a card "Mythicshot for Windows" linking to the app's download page (see [The app's download page](#the-apps-download-page)); "Download all my data" (see [Download all my data](#download-all-my-data)); where the account is signed in, with the sign-outs of [Sessions](#sessions); and, on a site whose mail is on, changing the email address (see [Changing an email address](#changing-an-email-address)). The username cannot be changed in this version |
| Admin, `/admin` | For the site's admin only: inviting people and the open invites, every account and its storage, and each account's "More" menu: its workspace's allowance, disabling or enabling it, and deleting a disabled one. The tab is shown only to the admin, and everyone else gets "not found" from the routes behind it |

### The app's download page

The desktop app is downloaded from a public page of its own, on another site. The optional setting `DOWNLOAD_URL` names that page, and the dashboard then points signed-in people to it: the Account page shows a card, "Mythicshot for Windows", with "Get the installer from the download page. It shows the latest version and its checksum." and a button "Open the download page"; and the welcome a new account sees on the Connections page ends with "Not installed yet? Get Mythicshot from the download page.", where "the download page" is the link. Both links open in a new tab and send no referrer. `GET /api/v1/session` carries the address as `download_url` (null without it), and the pages check it again before they use it. Without the setting, or with a value it cannot use, neither shows and the pages are as before; a value it cannot use never stops the site, and the start says so in one line that names the setting and not the value. The address rule is in [Settings](#settings).

### Download all my data

The Account page has a card, "Download all my data", in every billing state and whether billing is on or off, also for a workspace that is read-only because its trial or its subscription ended, and whether or not the account has agreed to the site's current terms. A disabled account cannot sign in, and so cannot download. Its Download button gives one zip file, `mythicshot-data.zip`, of everything in the workspace:

- `README.txt` and `account.json`: what is in the zip, for a person and for a program. For each tour, image and clip: its title, when it was made and last changed (for an image or clip, when it was shared), whether it is published and its link (a full address on the tours address, or for an image or clip on the image address when there is one, from the settings; with one address and no `SITE_HOST`, the path), who may view it (anyone with the link, the people listed, with their addresses, or only you) and its size; and the account's email address and username and the workspace's name. Nothing of any other account or workspace, and no token, session, key or audit record.
- `tours/<name>/`: one folder per tour, with `index.html`, the tour as a click-through page that opens by double-click, from disk, with no server and no network; `tour.json`, its chapters, steps and settings; and `pictures/`, its step pictures and its logo. The page and the data are the tour's draft, what was last saved, also for a published tour.
- `images/` and `clips/`: every shared image, GIF and MP4 as it was shared.

Names in the zip are made from titles: plain lower-case letters, digits and hyphens, never a name Windows keeps for a device, made unique within their folder. The zip is written as the browser takes it, with the pictures stored as they are (they are compressed already), so the server never holds it whole; files of 4 GiB or more, and zips of 65,535 files or more, use ZIP64.

Only the signed-in browser can download, not a token and not a connected computer. The button posts to `/api/v1/account/data` (with the dashboard's anti-forgery header, from the site's own page), which answers the address of the file, `/api/v1/account/data/<ticket>`, good once, for that browser session, for one minute; the browser then saves it as a plain download. An address that cannot be followed (used, expired, or for a workspace grown past the limit below) answers the dashboard's sentence "Something went wrong. Try again in a moment." as plain text, which the browser shows and does not save. The button stays disabled until the download has ended: the page asks `/api/v1/account/data` every 3 seconds whether it is still going. One download of a workspace runs at a time, a workspace may ask 5 times an hour, and each download started writes the audit row `data_exported`. A download whose browser takes nothing for 5 minutes, or that is still going after 6 hours, is stopped. The three requests are the Account page's own and are left out of the API description.

On the Node server a download has no size limit beyond the disk. On Cloudflare a request may make at most 40 storage and database calls (see `src/budget.ts`), and every stored file is one: a step picture, a logo, or a 2,000,000-byte part of a shared image or clip. So a download there holds at most 35 stored files, and a workspace with more is refused with `409 too_large_to_export` before anything is sent, never cut short; the Account page then says "Something went wrong. Try again in a moment."

### The brand and the home page

Every dashboard page starts its top bar with the product's mark beside the name "Mythicshot", and the sign-in pages and the invite page show them the same way above their heading. The mark is the brand's small mark (the d20 with its gold lens face), the app's own file `/dash/mark.svg`; the name is the wordmark, "MYTHICSHOT" in the brand's Cinzel drawn as a picture, gold on dark grounds and ink on light ones (`/dash/wordmark-dark.png`, `/dash/wordmark-light.png`), picked by the visitor's colour scheme with a `<picture>` and no script. All three are served on the app address (or the one address) like the dashboard's stylesheet, with a picture's policy (`default-src 'none'; sandbox`), so the pages still load nothing from another site. The wordmark's alt text is "Mythicshot", which a screen reader reads and a browser shows if the picture cannot load. The optional setting `HOME_URL` names the site's home page: the mark and the name are then one link to it, in the same tab, and the link's name for a screen reader is "Mythicshot". Without it the mark and the name are not a link. The pages a visitor of someone else's tour, image or clip sees on the tours and img addresses keep the name alone, with no mark and no link. The address rule is in [Settings](#settings).

### The look

The pages follow the Mythicshot brand, so the platform looks like the same product as the desktop app and the front page: violet-tinted neutrals, purple for the main button with white text, gold links and focus ring on dark grounds and bronze on light ones, orange caution boxes with a warning sign and an edge, teal for done, 8 px corners on buttons and fields and 12 px on cards and dialogs, and pills only for tags and chips. Both colour schemes follow the visitor's system setting. Every colour is one of the brand's tokens, written once in `src/brand-tokens.ts`; every stylesheet starts with them (`src/brand-css.ts`) and writes no colour of its own, which `test/brand-tokens.test.ts` checks, together with the contrast of every pair of colours the pages use.

Text is set in Manrope, served by the site itself from an address that names its content (`/fonts/manrope.<hash>.ttf`, on every address), with its licence beside it (`/fonts/manrope-OFL.txt`); each page's Content-Security-Policy allows `font-src 'self'` for this and nothing wider. Until the font has loaded, the system font is used. No other font is served: the name beside the mark is a picture, drawn by `python scripts/build-wordmark.py` (Python with Pillow) from the Cinzel file in `scripts/wordmark/`, the same bytes on every run.

Every page has a browser-tab icon made from the mark: `/favicon.svg` and `/favicon.ico` answer on every address. The platform's own pages (the dashboard, the sign-in and invite pages, the setup wizard and the API documentation) link both; the pages that show what people publish keep their markup as it was, and the browser asks `/favicon.ico` by itself. A tour's own look is the author's and is not restyled: nothing inside the stage changes (the picture, its frame and shadow, the missing-picture placeholder, the hotspot, the card, the always-on button and the progress bar), nor the tour's accent, card style, logo or backdrop, the automatic backdrop included. Only what surrounds the stage follows the brand: the top and bottom bars, the chapter menu, the end card's frame and the not-found page. The files are in `src/brand-files/`; after changing a mark run `node scripts/build-icons.ts`, and after changing any file there `npm run build:brand`.

A self-hosted copy keeps the product's name and brand: there is no setting for them.

When you update to 0.1.65: `token` became a reserved username (it is a path of the API now), checked only when an account is made. Sign in as the admin, open the Admin page (`/admin`) and check that no account is called `token`. Such an account keeps working, as a username never appears in a link, but write to its owner if you want the name back.

When you update to 0.1.54: `favicon` and `fonts` became reserved usernames (they are top-level paths of the site now), and reserved names are checked only when an account is made. No server command lists usernames, so sign in as the admin, open the Admin page (`/admin`, which lists every account's username) and check that no account is called `favicon` or `fonts`. Such an account keeps working, as a username never appears in a link, but write to its owner if you want the name back.

### What the admin sees

The Admin page shows one line for the whole site (the number of accounts, what all workspaces use together, and the standard allowance) and one row per account: its username, email address, status and whether it is the admin, its workspace's name, its number of tours, the bytes it uses, its allowance, the day it joined, and on a site with terms the version of them it agreed to last and when ("Not yet" without one). It never shows a tour's title, link, pictures or anything else in a workspace, and it has no way into one: the admin's own session reaches other workspaces only through these figures. The page says so itself: "You see totals only. What is in another person's workspace is never shown here."

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
| `POST /api/v1/admin/accounts/<id>/undo-removal` | Only while a delete has removed nothing yet, as when Stripe never gave a definite answer to its cancel: the delete's record goes, and the account stays disabled and can be enabled again. What the delete already did at Stripe is not undone. `409 not_deleting` when no delete is recorded, `409 removal_started` once it has begun removing (send the delete again to finish it). It refuses once any file or row of the workspace has been removed, except for a removal the billing sweep stopped, which it undoes anyway: nothing removed is restored, and the answer is `200 {"restored": false, "files_removed": <n>}`. Undoing a removal the billing sweep started also clears the workspace's warning mails, so they start over if the account is enabled again. Recorded as `account_removal_undone`. The Admin page has no button for it yet |
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

The Node target sends three kinds of mail: sign-in links, the link and notice of an email change, and a notice to the account that confirmed a new connection of Mythicshot once Mythicshot has collected its token (at most 5 a day per account and 30 an hour for the site, apart from sign-in's limit). Mail is off until it is switched on. A Cloudflare install sends no mail in this version. Since 0.1.66 it also sends [the low storage mail](#the-low-storage-mail).

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

## Files on R2

The Node site keeps its files in the data folder's `drafts/` and `public/` folders unless the settings file says `FILE_STORE=r2`. With it, the files are kept in two Cloudflare R2 buckets instead, reached through R2's S3-compatible API at the account's address under `r2.cloudflarestorage.com`, with requests the site signs itself. Drafts, shared images and clips, and restricted tours' pictures go to the private bucket (`R2_PRIVATE_BUCKET`); only public tours' pictures go to the public one (`R2_PUBLIC_BUCKET`). The code that decides which file goes where is the same as on disk, and the site refuses to start with one bucket for both. Files still travel through the app on every upload and every view. A Cloudflare install always keeps its files in R2 and does not read these settings.

The key is an R2 API token limited to the two buckets with "Object Read & Write" ([R2's page on tokens](https://developers.cloudflare.com/r2/api/tokens/)). Its access key id and secret go in the settings file as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, beside `R2_ACCOUNT_ID` and the two bucket names; the five go together or not at all (see [Settings](#settings)).

Both commands below are the server's admin command: `./cpanel.sh admin <command>` on shared hosting ([the cPanel guide](docs/hosting/cpanel.md#keep-the-files-on-r2)), `docker compose exec app node dist/node/admin.js <command>` in the container ([the Docker runbook](docs/runbook-docker.md#keep-the-files-on-r2)), with the settings written in the settings file or `.env` like every other setting.

### The changeover

1. Update to this version or a later one. Nothing changes yet: without `FILE_STORE` the files stay on disk.
2. Make the two buckets and the token, and type the five R2 settings into the settings file yourself. The site checks their shape at its next start and stops with one line naming any it cannot use, but keeps the files on disk.
3. Check the key and the buckets: `./cpanel.sh admin r2-check` on shared hosting, `node dist/node/admin.js r2-check` beside the app. It writes one small file under `r2-check/` in each bucket, reads it back, compares it and deletes it, and prints one line per bucket and a verdict, `R2 check passed: both buckets can be written, read and deleted with this key.`, or which step failed and why. Run it again until it passes.
4. Stop the app, then copy the files: `./cpanel.sh admin files-copy --from disk --to r2 --app-is-stopped`. It copies every file with its type and cache line, the private ones to the private bucket and the public ones to the public bucket, reads each copy back and compares its size and SHA-256, leaves a file that is already the same alone, and removes from the buckets anything the folders do not hold. It prints counts only, such as `private files: 46 copied, 0 already there, 0 removed, 0 failed.`, and ends with `Done: every file at the destination is the source's, checked by size and SHA-256.` A run that ends otherwise can simply be run again. `--dry-run` counts what it would do and changes nothing.
5. Add the line `FILE_STORE=r2` to the settings file and start the app.
6. Check a public tour, a restricted tour, a shared image, an upload, a delete and the data download.

The stop in step 4 is deliberate, and the command refuses to copy without `--app-is-stopped`: a copy made while the site is live can leave a file deleted in the middle of it, or the picture of a tour made restricted in the middle of it, behind at the destination, in the public bucket included. The folders on disk are not touched by the switch and stay as the way back.

### The way back

Stop the app, run `./cpanel.sh admin files-copy --from r2 --to disk --app-is-stopped`, which makes the two folders hold exactly what the two buckets hold, set `FILE_STORE=disk` (or remove the line), and start the app. Only then go back to a version before 0.1.71, which knows only files on disk: while the settings file says `FILE_STORE=r2`, `cpanel.sh update` refuses to install one and says so.

> [!warning] Update backups no longer hold the files after the switch
> With `FILE_STORE=r2` the backup `cpanel.sh` takes before each update, and `backup` itself, hold the database, the app files and the settings file only, and say so; R2 has no bin to recover a deleted file from, so keep a second copy of the buckets.

> [!warning] A restored database and the buckets can disagree
> Restoring an older database after files were deleted from R2 leaves tours pointing at pictures that are gone; the way back is the reverse copy and `FILE_STORE=disk`, not a database restore.

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
| `PUBLIC_IMAGE_BASE` | both | Empty (the default on both targets): the app serves published images itself on `/p/<name>`. Optionally, on Cloudflare, the address of the public bucket's own custom domain, such as `https://images.example.com`; the pictures then never pass through the app, so a disabled account's pictures stay reachable (see [Disabling and deleting an account](#disabling-and-deleting-an-account)), and on a site with billing, links coming down hides the pages, but the pictures stay reachable at their addresses until removal or unpublish (see [Removal after 90 days](#removal-after-90-days)). |
| `TOURS_HOST` | both | Optional, and only together with `APP_HOST`: the host name of the tours address, such as `tours.example.com`, without `https://` and without a path. Both empty or unset (the default) is one address, and no host name is checked. See [One address or two](#one-address-or-two). |
| `APP_HOST` | both | Optional, and only together with `TOURS_HOST`: the host name of the app address, such as `app.example.com`, in the same form. It must be a different name than the tours address. |
| `IMG_HOST` | both | Optional, and only beside both `TOURS_HOST` and `APP_HOST`: the host name of a third address for shared images and clips, such as `img.example.com`, in the same form and a name of its own. Unset or empty (the default): they answer on the tours address. It is not `PUBLIC_IMAGE_BASE`, which is about published tour pictures. See [An optional third address for images and clips](#an-optional-third-address-for-images-and-clips). |
| `STORAGE_ALLOWANCE_BYTES` | both | Optional: the storage allowance of a workspace in bytes, digits only, such as `1073741824` for 1 GB. Unset or empty (the default): no limit. See [Storage allowance](#storage-allowance). Any other value stops the start on Node with one line, and on Cloudflare answers 500 `misconfigured` on every path until it is fixed. |
| `SITE_HOST` | both | Optional, for a site on one address only: the host name sign-in links use, such as `tours.example.com`, without `https://` and without a path. Ignored when `APP_HOST` is set, since links then use the app address. It is used for links only, and no request is checked against it. A value that is not a host name never stops the site: it then has no address for links, and no sign-in mail is sent. |
| `INVITE_CONTACT` | both | Optional: who to ask for an invite, an email address such as `hello@example.com` or an `https://` address, shown after "Mythicshot is invite-only for now." on the sign-in page; unset or anything else shows that sentence alone and never stops the site. On Cloudflare it is a var in the install's `wrangler.deploy.jsonc`, which `npm run setup:cloudflare -- update` keeps. See [Who to ask for an invite](#who-to-ask-for-an-invite). |
| `DOWNLOAD_URL` | both | Optional: the address of the public page the desktop app is downloaded from, such as `https://downloads.example.com/mythicshot/`. It must be `https://`, a plain host name, an optional port and a path (a query is allowed), with no user name or password and no `#` part, at most 300 characters. Set, the dashboard's Account page shows a card linking to it and the Connections page's welcome ends with a link to it; unset or empty (the default), neither shows. Any other value never stops the site: the link is left out and the start writes one line, `download page: off, because DOWNLOAD_URL is not a usable https address. The site runs; the dashboard shows no download link.`, which never holds the value (on Cloudflare, once per instance, on its first request). On Cloudflare it is a var in the install's `wrangler.deploy.jsonc`, which `npm run setup:cloudflare -- update` keeps. See [The app's download page](#the-apps-download-page). |
| `HOME_URL` | both | Optional: the site's home page, such as `https://www.example.com/`. Set, the product's mark and name at the top of the dashboard, the sign-in pages and the invite page are one link to it, opening in the same tab; unset or empty (the default), the mark shows beside the name and neither is a link. It must be `https://`, a plain host name, an optional port and a path (a query is allowed), or `http://` only on `localhost`, a `*.localhost` name or `127.0.0.1`; with no user name or password and no `#` part, at most 300 characters. Any other value never stops the site: the mark and the name are then no link, and the start writes one line, `home page: off, because HOME_URL is not a usable address. The site runs; the logo is not a link.` (on Cloudflare once per instance). On Cloudflare it is a var in the install's `wrangler.deploy.jsonc`, which `npm run setup:cloudflare -- update` keeps. See [The brand and the home page](#the-brand-and-the-home-page). |
| `SESSION_MAX_DAYS` | both | Optional: a browser session ends this many days after its sign-in, however active it is: a whole number from 1 to 3650, or `0` or `off` (any case) for no such limit. Unset or empty: 90. See [How long sign-ins last](#how-long-sign-ins-last). Any other value never stops the site: 90 applies and the start writes one line, `sign-in lifetimes: SESSION_MAX_DAYS is not a whole number of days from 1 to 3650, 0 or off, so the default of 90 days applies. The site runs.`, which never holds the value (on Cloudflare, once per instance, on its first request). On Cloudflare it is a var in the install's `wrangler.deploy.jsonc`, which `npm run setup:cloudflare -- update` keeps. |
| `CONNECTION_IDLE_DAYS` | both | Optional: a connection made by signing in from Mythicshot (a token of kind `sign_in`) stops working after this many days without use, counted from its last use, or from when it was made when it was never used. The same values as `SESSION_MAX_DAYS`; unset or empty: 90. A value that cannot be used gives 90 and the line `sign-in lifetimes: CONNECTION_IDLE_DAYS is not a whole number of days from 1 to 3650, 0 or off, so the default of 90 days applies. The site runs.`. The setup token is never touched. |
| `CONNECTION_MAX_DAYS` | both | Optional: a connection made by signing in from Mythicshot stops working this many days after it was made, however active it is. The same values as `SESSION_MAX_DAYS`; unset or empty: off. A value that cannot be used leaves it off, with the line `sign-in lifetimes: CONNECTION_MAX_DAYS is not a whole number of days from 1 to 3650, 0 or off, so the default, no limit, applies. The site runs.`. The setup token is never touched. |
| `STRIPE_API_KEY` | both | Optional, one of the four [billing](#billing-optional) settings, which go together or not at all: a Stripe restricted key (`rk_...`; a secret key, `sk_...`, is taken too). A secret, like `SETUP_CODE`: a Worker secret on Cloudflare, a line in the settings file on Node; never logged, answered or stored. |
| `STRIPE_WEBHOOK_SECRET` | both | Optional, with the other three: the signing secret of the listener's address in Stripe (`whsec_...`). A secret, like `STRIPE_API_KEY`. |
| `STRIPE_PRICE_ID` | both | Optional, with the other three: the id of the plan's monthly price in Stripe (`price_...`). |
| `STRIPE_PUBLISHABLE_KEY` | both | Optional, with the other three: Stripe's publishable key (`pk_...`), which is public: the Subscribe page hands it to Stripe's form in the browser. |
| `MAIL_MODE` | Node | `off` (the default, also when unset) or `smtp`. With `off` the site sends no mail and reads none of the mail settings below. With `smtp` it sends sign-in mails through the mail server those settings name. Mail that is switched on but cannot be used (a mail setting that is missing or malformed, or no address for links from `APP_HOST` or `SITE_HOST`) never stops the site: mail stays off, and the start writes one line that names the setting and never a value. A Cloudflare install sends no mail in this version. |
| `MAIL_FOOTER` | Node | Optional: one line at the foot of a designed mail ([the low storage mail](#the-low-storage-mail)), such as `Example Co · Sometown`, shown as written, at most 200 characters. Unset or empty (the default): no such line. A value with a line break, or longer, is left out and never stops the site. On a tunnel install set up before 0.1.66, run `sudo bash install.sh install` once before it takes effect: `update` does not rewrite the stack file. |
| `MAIL_FROM` | Node | With `MAIL_MODE=smtp`: the sender's address, such as `no-reply@example.com`, the address alone without a name around it. |
| `SMTP_HOST` | Node | With `MAIL_MODE=smtp`: the host name of the mail server, such as `mail.example.com`, without a port. |
| `SMTP_PORT` | Node | With `MAIL_MODE=smtp`: the mail server's port for SMTP over TLS. Default 465. The connection is encrypted from its first byte on whatever port is given; a port that expects STARTTLS (usually 587) does not work. |
| `SMTP_USER` | Node | With `MAIL_MODE=smtp`: the name the mailbox signs in with, often the same as the sender's address. |
| `SMTP_PASSWORD` | Node | With `MAIL_MODE=smtp`: the mailbox's password. A secret: it belongs in the environment or the settings file only, like `SETUP_CODE`, and the site never writes it to the database, a log or an answer. |
| `CLIENT_ADDRESS_HEADER` | Node | Optional, and only for a site behind a proxy: the name of the header in which the proxy writes the visitor's network address, such as `X-Real-IP`. The last value of that header is then taken as the visitor's address, for rate limits only. Unset (the default): the address of the connection itself, which is right only when visitors connect to the app directly. Behind a proxy the connection is the proxy's: when the proxy hands requests over a local socket or from a private address, as shared hosting and the container stack do, the address is then unknown, and limits per network are not applied (the limits per recipient and on mails sent still are). The header's value must be the bare address, such as `203.0.113.7` or `2001:db8::1`: with a port, in brackets or with a label such as `for=`, it is not taken and the address is unknown. With two proxies in a chain that each add to the header, the last value is the one written by the proxy next to the app, which is the address of the outer proxy, not the visitor's: name a header the outer proxy sets and the inner one passes on unchanged. Set it only to a header your own proxy writes on every request, or a visitor could choose the address. A value that is not a header name, or names a header of which only the first value is kept (`Host`, `From`, `Referer`, `User-Agent`, `Authorization`, `Cookie`, `Content-Type`, `Content-Length` and the like), never stops the site: no visitor's address is then known, and the start writes one line. Without this setting behind a proxy, the limits per network on signing in and on connecting Mythicshot cannot tell visitors apart: while it is unset, the first request that comes from a private or local address, or over a local socket, makes the server write one line, `client address: requests come from a private or local address, which is how a proxy in front of the app looks; set CLIENT_ADDRESS_HEADER to the header your proxy writes the visitor's address in, or the limits per network (signing in, connecting the app) cannot tell visitors apart`, once until it restarts; nothing else changes. On Cloudflare the address is the connecting one and this setting is not read. |
| `RECOVERY_LINKS` | Node | Read by the server's admin command only, never by the app or the API: `on` (any case, spaces around it allowed) lets the command print a sign-in link for an account that exists, as a recovery tool; anything else, or unset (the default), is off. Add the line for one run and remove it right after: do not leave it on. The command never reads it from its own environment: through `cpanel.sh admin` it is the settings file's line, and run directly, as in the container, it is what the environment of the container's first process (the app, started from `.env`) says, so the line goes in `.env` and the container is recreated; `docker compose exec -e` does not open it. It keeps the command from being a standing way in; it is no defence against someone who can already change the settings file or the data. |
| `BILLING_REMOVAL` | Node, Cloudflare | Read by the billing sweep only (the admin command `billing-sweep`, and the Worker's scheduled handler), never by the app: `on` (any case, spaces around it allowed) lets the sweep remove the content of workspaces whose removal is due (see [Removal after 90 days](#removal-after-90-days)); anything else, or unset (the default), is off, and nothing is ever removed. Through `cpanel.sh admin` it is the settings file's line. |
| `FILE_STORE` | Node | Where the Node site keeps its files: `disk` (the default, also when unset or empty), the `drafts/` and `public/` folders of `DATA_DIR`; or `r2`, two R2 buckets named by the five settings below, which are then all required. Any other value stops the start with one line. See [Files on R2](#files-on-r2). On Cloudflare the files are always in the two R2 bindings and this setting is not read. |
| `R2_ACCOUNT_ID` | Node | Optional, one of the five R2 settings, which go together or not at all: the Cloudflare account id, 32 characters `0`-`9` and `a`-`f`. The five may be written while `FILE_STORE` is `disk`, so the key can be typed in and checked with `r2-check` before the switch; they are then checked all the same, and a half-filled set or a value of the wrong shape stops the start with one line that names the setting and never its value. |
| `R2_ACCESS_KEY_ID` | Node | Optional, with the other four: the access key id of an R2 API token limited to the two buckets with "Object Read & Write", up to 128 printable characters without spaces. |
| `R2_SECRET_ACCESS_KEY` | Node | Optional, with the other four: that token's secret access key, up to 256 printable characters without spaces. A secret, like `SETUP_CODE`: a line in the settings file only; the site never logs it, answers it, puts it in an error or writes it to a file. |
| `R2_PRIVATE_BUCKET` | Node | Optional, with the other four: the bucket for drafts, shared images and clips, and restricted tours' pictures. An R2 bucket name: 3 to 63 lowercase letters, digits and hyphens, beginning and ending with a letter or digit. |
| `R2_PUBLIC_BUCKET` | Node | Optional, with the other four: the bucket for public tours' pictures only, of the same shape, and never the same bucket as `R2_PRIVATE_BUCKET`: the site refuses to start with one bucket for both. |
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
