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
| `REHEARSE_MODE` | `one` (the default) or `two`. With `two`, both builds run with the two addresses `tours.example.com` and `app.example.com`. `--mode one` or `--mode two` does the same |

Nothing else of your environment reaches the builds: no mail settings and no setup code. Each build runs on `127.0.0.1` only, on a free port, and no request goes anywhere else.

## What it checks

1. The old build on the copy: the health of each address, then for each token the workspace, the tour list and the usage (when the build has it), every listed tour's page and every picture on it.
2. The new build on the same copy, which applies the pending database changes as it starts. Every answer must be the same to the byte, except the `date` header and the version number in the workspace answer. A route the old build did not have, the usage, is checked against a sum the command makes from the database itself.
3. Every file of both image stores, every row the old tables had in the columns they had, the new account tables with one membership and one sign-in method per account and no admin, the database's own two checks, and the list of applied changes.
4. The way back: the old build again, on the changed copy, must answer as it did before the update.
5. Two new builds started at the same moment on a fresh copy: both start, and each database change is applied once.

The report is one line per check, PASS or FAIL with counts, and ends with `RESULT: PASS` or `RESULT: FAIL`. It never holds a token, an email address or a name from the data. The command exits with status 1 when a check fails.

## What it does not prove

It does not test the hosting: not how the hosting starts the app, not its file system and not its version of Node.js. It proves only what the given data holds; a kind of tour the site does not have is not tried.

## Synthetic data

`node scripts/rehearse-fixture.ts <empty folder>` builds 0.1.7, 0.1.8 and this checkout from Git without the network, runs each released build on a new data folder, and writes a site through its own routes: the setup wizard, tours with several chapters and a logo, published, unpublished, renamed, replaced and deleted, and an unfinished upload. It prints the command to run next.
