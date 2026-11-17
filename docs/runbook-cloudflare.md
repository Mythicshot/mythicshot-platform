# Runbook: Cloudflare

> [!WARNING]
> Draft: this runbook has not yet been run end to end on a real Cloudflare account. It is written from the code in this repository and from Cloudflare's documentation. Steps that could not be confirmed from either are marked **Unconfirmed**.

This runbook puts the platform on Cloudflare Workers, with its database in D1 and its images in two R2 buckets. Cloudflare runs the app, stores the data and serves HTTPS. Having the domain on Cloudflare, creating the database and buckets, setting the secret and deploying stay yours.

Examples use `tours.example.com` for the platform's address and `images.example.com` for published images. Put your own hostnames in their place.

## Contents

- [1. What to have ready](#1-what-to-have-ready)
- [2. Sign Wrangler in](#2-sign-wrangler-in)
- [3. Create the database](#3-create-the-database)
- [4. Create the two buckets](#4-create-the-two-buckets)
- [5. Apply the migrations](#5-apply-the-migrations)
- [6. Give the public bucket its hostname](#6-give-the-public-bucket-its-hostname)
- [7. Attach the Worker to its hostname](#7-attach-the-worker-to-its-hostname)
- [8. Deploy](#8-deploy)
- [9. Set the setup code](#9-set-the-setup-code)
- [10. The setup wizard and Mythicshot](#10-the-setup-wizard-and-mythicshot)
- [11. Update](#11-update)
- [12. Where the data lives, and exporting it](#12-where-the-data-lives-and-exporting-it)
- [Costs](#costs)
- [Troubleshooting by symptom](#troubleshooting-by-symptom)
- [Pages this runbook relies on](#pages-this-runbook-relies-on)

## 1. What to have ready

1. A Cloudflare account.
2. Your domain added to that account as a zone, with its status active. Cloudflare's [onboarding page](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/) walks through it: add the domain under Domains, pick a plan, review the DNS records, then change the nameservers at your registrar to the two Cloudflare gives you. Changing nameservers at the registrar is yours to do.
3. A computer with Node 24 or later and a copy of this repository.
4. The repository's packages installed. Run this in the repository's folder.

```sh
npm ci
```

> [!WARNING]
> If the domain uses DNSSEC, turn it off at the registrar before changing nameservers, or the domain can become unreachable.

**How to tell it worked:** in the Cloudflare dashboard the domain shows as active, and `npx wrangler --version` prints a version.

## 2. Sign Wrangler in

Wrangler is Cloudflare's command-line tool; it comes with the repository's packages.

```sh
npx wrangler login
```

It opens a browser to sign in. On a computer without a browser, add `--device` and open the address it prints on another device.

**How to tell it worked:** this shows your account.

```sh
npx wrangler whoami
```

## 3. Create the database

```sh
npx wrangler d1 create demo-platform
```

It prints the new database's id. In `wrangler.jsonc`, replace the placeholder `database_id` (`00000000-0000-0000-0000-000000000000`) with it. If you chose another name than `demo-platform`, change `database_name` to match.

`wrangler.jsonc` in the repository holds placeholders; your edited copy is your install's settings. Keep it with you and out of commits to the shared repository.

**How to tell it worked:** `wrangler.jsonc` holds your database id.

## 4. Create the two buckets

Drafts and published images live in separate buckets, so a draft can never be reached by a public address. Bucket names may use lowercase letters, digits and hyphens, 3 to 63 characters, and must match `bucket_name` in `wrangler.jsonc`.

```sh
npx wrangler r2 bucket create demo-platform-drafts
```

```sh
npx wrangler r2 bucket create demo-platform-public
```

> [!WARNING]
> Never give the drafts bucket public access or a custom domain: drafts must only be reachable with the API token.

**How to tell it worked:** both buckets appear under R2 object storage in the dashboard.

## 5. Apply the migrations

This creates the tables in the database. It asks you to confirm.

```sh
npx wrangler d1 migrations apply demo-platform --remote
```

**How to tell it worked:** it lists `0001_init.sql` and `0002_guide_cards.sql` as applied. Running it again says there is nothing to apply.

## 6. Give the public bucket its hostname

Published tours load their images from the public bucket through a hostname of your own. The bucket's `r2.dev` address is rate-limited and meant for development only, so do not use it.

1. In the dashboard, open R2 object storage, then Overview, and select `demo-platform-public`.
2. Select Settings. Under Custom Domains, select Add.
3. Enter `images.example.com` and select Continue.
4. Review the DNS record it will add, then select Connect Domain. The status changes from Initializing to Active within a few minutes.
5. In `wrangler.jsonc`, set `PUBLIC_IMAGE_BASE` under `vars` to that address, with no slash at the end:

```jsonc
"vars": { "PUBLIC_IMAGE_BASE": "https://images.example.com" }
```

The hostname must be on a zone in the same Cloudflare account as the bucket.

**Unconfirmed:** the app reads `PUBLIC_IMAGE_BASE` today, but the published-tour pages that use it are still being built, so this step cannot be checked end to end yet.

**How to tell it worked:** the custom domain shows as Active in the bucket's settings.

## 7. Attach the Worker to its hostname

Add a `routes` entry to `wrangler.jsonc`, beside `vars`:

```jsonc
"routes": [{ "pattern": "tours.example.com", "custom_domain": true }]
```

Cloudflare creates the DNS record and the certificate for it when you deploy. The hostname must not already have a CNAME record; delete one first if it does.

**How to tell it worked:** it takes effect in the next step.

## 8. Deploy

```sh
npx wrangler deploy
```

**How to tell it worked:** this prints `{"ok":true}`. The certificate can take a few minutes after the first deploy.

```sh
curl https://tours.example.com/healthz
```

Until the setup code is set in the next step, `https://tours.example.com/setup` answers `{"error":"not_found"}`. That is on purpose: setup stays closed without a code.

## 9. Set the setup code

The setup code lets the first person who has it claim the platform. Generate it; never invent one. Any of these prints 32 random hex characters:

```sh
openssl rand -hex 16
```

```sh
node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))"
```

Then store it as a secret. Wrangler asks for the value; paste the code there, not on the command line, so it stays out of your shell history. This deploys a new version of the Worker at once.

```sh
npx wrangler secret put SETUP_CODE
```

Keep the code only until you finish the wizard. Neither Wrangler nor the dashboard shows a secret's value again.

> [!WARNING]
> There is no limit on wrong guesses on Cloudflare, so a short or made-up code can be guessed and the platform claimed: always use a generated one.

**How to tell it worked:** `https://tours.example.com/setup` now shows "Set up your tour site".

## 10. The setup wizard and Mythicshot

1. Open `https://tours.example.com/setup`. Use the hostname from [step 7](#7-attach-the-worker-to-its-hostname): the wizard shows the address it was opened on as the server address for Mythicshot.
2. **Step 1 of 4:** enter the setup code and press Continue.
3. **Step 2:** enter a workspace name (1 to 80 characters) and the owner's email, and press Continue.
4. **Step 3:** the API token is shown once. Copy it into your password manager, tick "I've saved the token", and press Continue.
5. **Step 4:** in Mythicshot, open Settings › Output › Tour publishing, paste the server address and the token, and press Test connection. The wizard changes to "Mythicshot is connected." Press Finish.

After that, every setup address answers "not found", and the setup code opens nothing.

> [!WARNING]
> The API token works like a password: anyone holding it can upload to and unpublish every tour in the workspace.

**How to tell it worked:** opening `https://tours.example.com/setup` again shows `{"error":"not_found"}`.

### If the token was lost before anyone saved it

If the wizard saved the workspace but the token never reached you (the page was closed or the connection dropped after step 2), setup is closed and nobody holds a token. These steps clear the half-finished setup so the wizard can run again. They delete nothing once the token has been used, a tour or upload exists, or there is more than one workspace.

1. Save this as `reset-setup.sql` in the repository's folder.

```sql
DELETE FROM api_token WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token WHERE last_used_at IS NOT NULL);
DELETE FROM user WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
DELETE FROM setup WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
DELETE FROM workspace WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
SELECT count(*) AS workspaces FROM workspace;
```

2. Export the database first, as in [step 12](#12-where-the-data-lives-and-exporting-it).
3. Run the file against the database. The SQL is checked by this repository's tests on both targets; running it through Wrangler is **Unconfirmed**.

```sh
npx wrangler d1 execute demo-platform --remote --file reset-setup.sql
```

The last result shows `workspaces` as 0 when setup was cleared. A 1 means one of the conditions above held and nothing was deleted.

4. Set a new setup code, generated as in [step 9](#9-set-the-setup-code), because the old one may have been seen.

```sh
npx wrangler secret put SETUP_CODE
```

5. Run the wizard again from [step 10](#10-the-setup-wizard-and-mythicshot).

## 11. Update

1. Get the new version of the repository, keeping your edited `wrangler.jsonc`.
2. Install its packages.

```sh
npm ci
```

3. Apply any new migrations before deploying. **Unconfirmed:** this order assumes each migration only adds to the schema, which holds for the migrations so far.

```sh
npx wrangler d1 migrations apply demo-platform --remote
```

4. Deploy.

```sh
npx wrangler deploy
```

**How to tell it worked:** `curl https://tours.example.com/healthz` prints `{"ok":true}` and Mythicshot's Test connection works.

## 12. Where the data lives, and exporting it

| What | Where |
|---|---|
| Workspaces, owners, token hashes, tours, chapters and steps | The D1 database `demo-platform` |
| Draft images | The R2 bucket `demo-platform-drafts` |
| Published images | The R2 bucket `demo-platform-public` |
| The setup code | The Worker's secret `SETUP_CODE` |

Export the database to a SQL file:

```sh
npx wrangler d1 export demo-platform --remote --output demo-platform.sql
```

> [!WARNING]
> The export holds the owner's email and the token hashes: keep it as private as a password, and store it off your computer too.

An export blocks other requests to the database while it runs, so run it when nobody is uploading.

D1 also keeps its own history, called Time Travel: 7 days on the Free plan and 30 days on the Workers Paid plan. Restoring to a point in time uses `npx wrangler d1 time-travel restore demo-platform --timestamp=<unix time>`.

> [!WARNING]
> A Time Travel restore overwrites the whole database in place; export it first.

**Unconfirmed:** the Cloudflare pages read for this runbook describe no command that downloads a whole R2 bucket, so exporting the images is not covered here yet.

## Costs

Cloudflare's [Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/) lists the Free plan's limits: 100,000 Worker requests a day, and for D1 5 million rows read and 100,000 rows written a day with 5 GB of storage. The [R2 pricing page](https://developers.cloudflare.com/r2/pricing/) lists R2's monthly free tier: 10 GB-month of storage, 1 million Class A and 10 million Class B operations, and no charge for egress.

> [!WARNING]
> Use above the free amounts is billed on paid plans; check both pricing pages before you rely on the free tier.

**Unconfirmed:** whether R2 asks for a payment method before it can be used is not stated on the pages read.

## Troubleshooting by symptom

| Symptom | Likely cause | What to do |
|---|---|---|
| `wrangler login` cannot reach its callback | Signing in on a remote machine | Use `npx wrangler login --device`. |
| Deploy fails on the custom domain | The hostname already has a CNAME record, or the zone is not active | Delete the CNAME record, or wait for the zone to become active. |
| Requests fail with a database or bucket error | The `database_id` or a `bucket_name` in `wrangler.jsonc` does not match what you created, or the migrations were not applied | Check [step 3](#3-create-the-database), [step 4](#4-create-the-two-buckets) and [step 5](#5-apply-the-migrations), then deploy again. |
| `/setup` shows `{"error":"not_found"}` before anyone finished it | `SETUP_CODE` is not set or is shorter than 16 characters | Set it as in [step 9](#9-set-the-setup-code). |
| `/setup` shows `{"error":"not_found"}` and nobody holds the token | The claim was saved but its answer was lost | See [If the token was lost](#if-the-token-was-lost-before-anyone-saved-it). |
| "That setup code isn't right." | The code typed differs from the secret | Secrets cannot be read back: set a new generated code as in [step 9](#9-set-the-setup-code). |
| "This site has already been set up." | Someone finished setup first | If nobody holds the token, see [If the token was lost](#if-the-token-was-lost-before-anyone-saved-it). |
| The public bucket's custom domain stays Initializing | Not yet connected | In the bucket list, use the menu next to the bucket and choose Retry connection. |

## Pages this runbook relies on

- [Onboard a domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/), for adding the domain and the DNSSEC warning.
- [Wrangler general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/), for `wrangler login` and `wrangler whoami`.
- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), for creating the database, applying migrations, running SQL and exporting.
- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/), for exports and running SQL files.
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), for its history and restoring.
- [Create R2 buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/), for the command and the naming rules.
- [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/), for the custom domain and the `r2.dev` limits.
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), for attaching the Worker to its hostname.
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and [Workers Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/), for `wrangler secret put` and `wrangler deploy`.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/), for the free amounts.

The Worker's settings are in [wrangler.jsonc](../wrangler.jsonc), and the migrations in [migrations/](../migrations/).
