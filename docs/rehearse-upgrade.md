# Rehearse an update on a copy of your data

`npm run rehearse:upgrade` tries an update on a copy of a site's data, on your own computer, before the real update runs. The steps for a cPanel backup are in [the cPanel guide](hosting/cpanel.md#rehearse-an-update-on-a-copy-of-a-backup); this page is the reference for the command.

> [!WARNING]
> The data folder holds real data: the owner's email, the token hashes and every image, and a backup folder also holds the settings file with the setup code and any mailbox password. Keep the copy as private as the backup itself and delete it when you are done. The command copies only `db.sqlite`, `drafts` and `public` into a scratch folder, removes that folder at the end, and never reads the settings file.

## The command

```sh
npm run rehearse:upgrade -- <data folder> <old build> <new build>
```

The data folder is a data folder or a backup folder made by `cpanel.sh backup`. It is never written to and never opened by the database: its files are hashed at the start and again at the end, and the report says whether they are unchanged.

Each build is a folder with `dist/node/entry.js`, `migrations` and `package.json`, and its packages installed: an unpacked archive after `npm ci --omit=dev --ignore-scripts`, or a checkout after `npm run build`.

## Settings

| Setting | What it does |
|---|---|
| `REHEARSE_TOKENS` | The tokens whose view of the site is compared, separated by spaces, commas or line ends. At least one is needed. They are never printed or written anywhere |
| `--tokens-file <file>` | Instead of `REHEARSE_TOKENS`: a file with one token per line |
| `REHEARSE_MODE` | `one` (the default), `two` or `three`. With `two`, both builds run with the two addresses `tours.example.com` and `app.example.com`. With `three`, they also get the address for images and clips, `img.example.com` (`IMG_HOST`), as described below. `--mode one`, `--mode two` or `--mode three` does the same |

With `three`, the old build gets the third address only when it knows that address, which came in 0.1.19. The command reads this from the build's own compiled files and does not start the build to find out: the build's list of address roles (`dist/hosts.js`) must name `img`, and its settings (`dist/node/config.js`) must read `IMG_HOST`. An old build that does not know it runs with the two addresses and the new build with three, and the report says so in one line under its first line. A new build that does not know the third address cannot be rehearsed with `three`; the command stops and says to use `two`. Each build is checked for health on every address it has, the third one included, and with two or three addresses its health answer there must name that address's own role (`tours`, `app` or `img`), so a build that was given `IMG_HOST` but does not take it fails to start with a line saying so, never passing as three addresses while it runs with two. With one address the health answer is taken as before. The per-address checks of step 1 below run unchanged on the tours and app addresses, so a build with three addresses is compared with one with two answer by answer.

Nothing else of your environment reaches the builds: no mail settings and no setup code. Each build runs on `127.0.0.1` only, on a free port, and no request goes anywhere else.

Every build, old and new, in every mode and every step, runs with `CLIENT_ADDRESS_HEADER=X-Forwarded-For`, and every request the command sends carries `X-Forwarded-For: 203.0.113.7`, an address set aside for documentation. A real site runs behind a proxy that writes the visitor's address into such a header, and the command stands in for that proxy, so each build sees a known visitor address as it does on the site. Without it, a build from 0.1.26 on would see every request come from `127.0.0.1` and write its one line asking for the setting, which the check of the two new builds would count as an error. Builds older than the setting, such as 0.1.7 and 0.1.8, read neither the setting nor the header, so both change nothing for them.

## What it checks

1. The old build on the copy: the health of each address, then for each token the workspace, the tour list and the usage (when the build has it), every listed tour's page and every picture on it.
2. The new build on the same copy, which applies the pending database changes as it starts. Every answer must be the same to the byte, except the `date` header, the version number in the workspace answer, a JSON answer that only adds fields (below), and a tour's page that names the new build's player files (below). A route the old build did not have, the usage, is checked against a sum the command makes from the database itself.
3. Every file of both image stores, every row the old tables had in the columns they had, the new account tables with one membership and one sign-in method per account and no admin, the database's own two checks, and the list of applied changes.
4. The way back: the old build again, on the changed copy, must answer as it did before the update. Here no added field and no other player file name is allowed: every answer must be the same to the byte but the `date` header.
5. Two new builds started at the same moment on a fresh copy: both start, write nothing to their error output, each database change is applied once, and every answer is the same to the byte as the single new build's but the `date` header, with no answer set aside as new. When either writes an error line, the report names each distinct line once: one of the app's own fixed messages word for word, and any other line only as "an error line that is not one of the known messages" with its length, because it could hold data.

A JSON answer only adds fields when its new body is the old body with new keys in its objects, at any depth: every old key is still there, in the same order, with the same value, and every list has the same length, its items compared one by one under the same rule. Both bodies must also be written exactly as plain JSON writes their values, so a number written another way (`1.0`, `-0`, an integer too large to keep exactly), a repeated key, a byte order mark or a space fails. Every added key must be shaped like a field name: lowercase words joined by underscores, at most 40 characters, with no digit and no capital. An added key of any other shape, such as an item id, a token or a link id, fails the answer, and the report says only that it added a key not shaped like a field name, never the key. Such an answer is allowed in step 2 and counted on its own ("differ only by added fields"), and the report names each added field once per route by its path, such as `images` or `tours[].views`, never with a value. Its `content-length` header may differ; no other header may. A changed or removed value, a value of another type, a list of another length or another status still fails, and an answer that is not JSON must still be the same to the byte.

A tour's page (`/t/<slug>`, an HTML answer) names the player's script and stylesheet by names that hold a hash of their content, such as `/player.<16 hex digits>.js`, so every release that changes the player changes those names in every page. In step 2 only, a page may differ in them: in both pages, the name inside the page's own `<script src="…" defer>` and `<link rel="stylesheet" href="…">` tags, written exactly as the server writes them, is replaced with one fixed stand-in before the bytes are compared. Both pages must then be the same length and the same in every other byte, and each may name each file once at most. Its `etag` header may then differ, since it is a hash of the page, but on each side it must be exactly that page's own, by the server's rule (the first 32 hex digits of the page's SHA-256, in double quotes), so a stale or fixed `etag` for a changed page fails; it may not differ when the pages are otherwise the same to the byte, and no other header may differ. Such a page is counted on its own ("differ only in the player's file names"), and the report never shows the names. A tour's own title and texts are written into the page escaped, so they can never make one of those tags: a title or step that holds text shaped like a player file name is compared byte for byte like the rest of the page, and fails when it changed. A changed picture address, title, step text or status still fails. After the comparison, every player file the new build's tour pages name is asked of the new build itself, on the tours address, and must answer `200` with the script's or the stylesheet's content type; the report gives one line with the counts, and names no file.

The restriction step (the way back with a restricted tour) runs the new build with placeholder mail settings: a mail server on `127.0.0.1` port 9 with the user `rehearsal` and the password `not-a-real-password`, none of them real. Restricting a tour needs a site that can mail, but nothing is mailed by it and no connection is made. When the new build refuses the change, the report names the refusal's error code, such as `cannot_restrict`, and nothing else of the answer.

The report is one line per check, PASS or FAIL with counts, and ends with `RESULT: PASS`, `RESULT: PASS, with N added fields to read above` or `RESULT: FAIL`. It never holds a token, an email address or a name from the data. The command exits with status 1 when a check fails, and with 0 for both kinds of pass.

> [!WARNING]
> When the last line says `with N added fields to read above`, read the `added fields` lines under the answers check before you update. Each names a field the new version adds to an answer. An added field is usually a new feature, but it can also be data that should not be there, such as something of another workspace, and only a person can tell the two apart.

## What it does not prove

It does not test the hosting: not how the hosting starts the app, not its file system and not its version of Node.js. It proves only what the given data holds; a kind of tour the site does not have is not tried.

## Synthetic data

`node scripts/rehearse-fixture.ts <empty folder>` builds 0.1.7, 0.1.8 and this checkout from Git without the network, runs each released build on a new data folder, and writes a site through its own routes: the setup wizard, tours with several chapters and a logo, published, unpublished, renamed, replaced and deleted, and an unfinished upload. It prints the command to run next.
