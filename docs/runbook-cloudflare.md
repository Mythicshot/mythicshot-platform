# Runbook: Cloudflare

> [!WARNING]
> Draft: this runbook has not yet been run end to end on a real Cloudflare account. It is written from the code in this repository and from Cloudflare's documentation. Steps that could not be confirmed from either are marked **Unconfirmed**.

This runbook puts the platform on Cloudflare Workers, with its database in D1 and its images in two R2 buckets. Cloudflare runs the app, stores the data and serves HTTPS. One command, `npm run setup:cloudflare`, does the setting up for you: it asks two questions and does the rest. You do not need a domain to start.

Examples use `tours.example.com` for your own address, `images.example.com` for the optional separate images address, and `demo-platform.<your-account>.workers.dev` for Cloudflare's free address. Put your own in their place.

## Contents

- [What you need before you start](#what-you-need-before-you-start)
- [Quick path](#quick-path)
- [What the command does](#what-the-command-does)
- [Your address](#your-address)
- [Two addresses](#two-addresses)
- [Published images](#published-images)
- [The setup wizard and Mythicshot](#the-setup-wizard-and-mythicshot)
- [Manual setup, step by step](#manual-setup-step-by-step)
- [Update](#update)
- [Back up and restore](#back-up-and-restore)
- [If the setup wizard's answer was lost](#if-the-setup-wizards-answer-was-lost)
- [Removal](#removal)
- [Costs](#costs)
- [Accounts and mail](#accounts-and-mail)
- [Troubleshooting by symptom](#troubleshooting-by-symptom)
- [Pages this runbook relies on](#pages-this-runbook-relies-on)

## What you need before you start

1. A Cloudflare account. The Free plan is enough to start. R2 has to be enabled once in the dashboard (R2 object storage) before Wrangler can list or create buckets: on an account without it, Wrangler's bucket list stops with "Please enable R2 through the Cloudflare Dashboard" (code 10042), and the command then says what to do. **Unconfirmed:** whether enabling R2 asks for a payment method is not stated on the pages read.
2. A computer (Windows, macOS or Linux) with Node 24 or later and a copy of this repository. Nothing else needs installing: Wrangler, Cloudflare's command-line tool, comes with the repository's packages.
3. A domain is optional. Without one, the platform runs on Cloudflare's free `workers.dev` address, and you can add your own address later without moving any data. To use your own address, its domain must be active on your Cloudflare account (see [Your address](#your-address)).
4. About 15 minutes, most of it Wrangler signing in and deploying. Moving a domain's DNS to Cloudflare takes longer: the registrar's nameserver change can take hours to be seen. **Unconfirmed:** the timing is an estimate, not measured on a real account.

## Quick path

1. In the repository's folder, install the packages.

```sh
npm ci
```

2. Sign Wrangler in to your Cloudflare account. It opens a browser to sign in. On a computer without a browser, add `--device` and open the address it prints on another device.

```sh
npx wrangler login
```

3. Run the guided setup and answer its questions: a name for the install (press Enter for `demo-platform`), and the address: "I don't have a domain yet" (Cloudflare's free address) or your own, such as `tours.example.com`. For your own address it asks you to type the hostname once, to confirm that whatever it points to today will be replaced. Before changing anything it shows the plan and the account it will use.

```sh
npm run setup:cloudflare
```

4. At the end it prints the setup wizard's address and the setup code, once. Open the address, enter the code and follow the wizard (see [The setup wizard and Mythicshot](#the-setup-wizard-and-mythicshot)).

To see first what it would do without changing anything, run it with `--dry-run`. If it stops half-way, fix what it reports and run the same command again: it picks up where it stopped.

```sh
npm run setup:cloudflare -- --dry-run
```

> [!WARNING]
> The setup code is printed once and stored nowhere on your computer. Keep it until you finish the wizard; there is no limit on wrong guesses, so never share it.

## What the command does

It says each step before doing it, and every step can be run again: it looks first and reuses what it finds.

| Step | What happens | On a second run |
|---|---|---|
| 1 | Checks Node 24 or later and that Wrangler is installed | Same |
| 2 | Checks Wrangler is signed in (`npx wrangler whoami`) to exactly one account, and names that account in its plan (an email address in the name is hidden). If not signed in, or the login can use several accounts and `CLOUDFLARE_ACCOUNT_ID` does not choose one, it says what to do and stops before anything else | Same |
| 3 | Asks for the name and the address | Keeps the answers of the first run |
| 3a | If a database, bucket or Worker with that name already exists and this checkout has not set it up, lists what it found and stops unless you confirm with `--adopt-existing` or by typing the name; `--yes` is not enough | Not asked: the install is this checkout's |
| 3b | For a new own address, warns that whatever the hostname has today will be replaced (see [Your address](#your-address)) and stops unless you confirm with `--replace-existing-domain` or by typing the hostname; `--yes` is not enough | Asked again only when the address differs from the one in `wrangler.deploy.jsonc`. An address counts as confirmed once it is in that file, so a route added there by hand is never asked about |
| 4 | Creates the D1 database (named after the install) if it does not exist, then writes `wrangler.deploy.jsonc` (step 5), then creates the buckets `<name>-drafts` and `<name>-public` if they do not exist. Neither bucket gets public access | Reuses them and says so; it never recreates or deletes one |
| 5 | Writes `wrangler.deploy.jsonc`: your install's Wrangler settings, built from `wrangler.jsonc` with your names, database id and address. Git ignores it; it holds no secret | Skipped when nothing changed |
| 6 | Applies the migrations to the remote database | Skipped when all are applied |
| 7 | Deploys the Worker. Until a deploy succeeds, a new own address is recorded in `wrangler.deploy.jsonc` as confirmed but not attached yet, also across runs that stop earlier. If Wrangler reports that it could not attach the address, the command takes it out again (back to the address attached before, if any) and says what to do, so the next run is not stuck. On any other failure it keeps the address, shows Wrangler's error, and the next run tries again | Skipped when nothing changed and no address is waiting to be attached |
| 8 | Generates a setup code (32 hex characters from Node's cryptographic random source) and stores it as the Worker secret `SETUP_CODE`, handing it to Wrangler on standard input so it never shows in the process list or a file | Kept and not shown again |
| 9 | Prints the setup wizard's address and the setup code | Prints the address only |

It never deletes a database, bucket, Worker or secret. Two things it does replace, each only after the confirmation above: the code of a same-named Worker it adopts, and whatever DNS record or Worker domain a new own address had. Removing an install is a manual procedure (see [Removal](#removal)).

### Modes and options

Run them as `npm run setup:cloudflare -- <mode> <options>`; the `--` passes the words on to the command.

| Command | What it does |
|---|---|
| `npm run setup:cloudflare` | Sets up, or completes a setup that stopped half-way |
| `npm run setup:cloudflare -- status` | Shows what exists on the account, whether migrations are pending and whether the setup code is set. Changes nothing |
| `npm run setup:cloudflare -- update` | Refreshes `wrangler.deploy.jsonc` from the repository's `wrangler.jsonc`, applies new migrations, then deploys. Never touches the setup code or the data |
| `npm run setup:cloudflare -- --dry-run` | Makes only reading calls and prints every changing command instead. Works with `update` too |
| `npm run setup:cloudflare -- --yes` | Takes the defaults instead of asking; needed when there is no terminal to ask in |
| `npm run setup:cloudflare -- --name tours` | Names the install `tours` instead of `demo-platform` (lowercase letters, digits and hyphens, 3 to 56 characters) |
| `npm run setup:cloudflare -- --domain tours.example.com` | Uses your own address, on a domain active on this account |
| `npm run setup:cloudflare -- --no-domain` | Uses only the free `workers.dev` address |
| `npm run setup:cloudflare -- --domain tours.example.com --replace-existing-domain` | Confirms that the new address may replace the DNS record or Worker domain it has today (instead of typing the hostname at the prompt) |
| `npm run setup:cloudflare -- --adopt-existing` | Confirms taking over a database, bucket or Worker that already has the install's name (instead of typing the name at the prompt) |
| `npm run setup:cloudflare -- --new-setup-code` | Replaces the setup code; for when it was lost before setup was finished |
| `npm run setup:cloudflare -- --help` | Shows the modes and options |

One checkout holds one install. For a second install, use a second copy of the repository with a different name, such as `npm run setup:cloudflare -- --name tours-two`. With the same name, the second copy would find the first install's database, buckets and Worker, and the command stops there instead of taking them over.

If your login can use several Cloudflare accounts, the command stops and lists them. Choose one by setting `CLOUDFLARE_ACCOUNT_ID` to its id (on the account's overview page in the dashboard) for the command; Wrangler reads the same setting. An `account_id` written into `wrangler.jsonc` takes precedence over it in Wrangler, so the command uses and names that account instead, and stops if the two disagree, if that account is not one your login can use, or if `wrangler.jsonc` and `wrangler.deploy.jsonc` set different values. On macOS or Linux, put `CLOUDFLARE_ACCOUNT_ID=<account id>` in front of the command; in PowerShell, run `$env:CLOUDFLARE_ACCOUNT_ID = "<account id>"` first.

## Your address

### Start without a domain

Each Cloudflare account can have one `workers.dev` subdomain, and a Worker can be deployed there without any domain of yours. Its address is `https://<worker name>.<your account subdomain>.workers.dev`, such as `https://demo-platform.<your-account>.workers.dev` ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)). In the guided command this is the first choice, "I don't have a domain yet".

Limits Cloudflare states for it, on the same page:

- It is meant for personal or hobby projects; Cloudflare recommends a route or custom domain for production.
- Cloudflare's Browser Integrity Check is always on for `workers.dev` and cannot be turned off. It can refuse some automated clients that send a default library User-Agent, before the app runs (error 1010). `scripts/publish.ts` sends its own User-Agent for this reason. **Unconfirmed:** whether Mythicshot's requests pass it.
- The Worker's name, which is the install's name, must be 63 characters or fewer.

An account that has never deployed a Worker may not have registered its subdomain yet. **Unconfirmed:** in that case Wrangler's deploy asks to register one (this is read from Wrangler's source, not seen on an account), and the guided command runs Wrangler without a terminal for it to ask in, so the deploy stops with Wrangler's message. Register the subdomain in the dashboard under Workers & Pages, then run the same command again.

With one address, which is what this runbook sets up, nothing in the app depends on the address: the setup wizard checks that a request comes from the same host it was opened on, whatever that host is; the published-tour page allows images only from its own address; and the wizard shows the address it was opened on as the server address for Mythicshot. The test suite runs all of this against `tours.example.com`, and the same pages were seen working under `wrangler dev` on `localhost`.

### Add your domain later

When your domain is active on the account, run the command again with it:

```sh
npm run setup:cloudflare -- --domain tours.example.com
```

Because the address is new, the command first warns what attaching it replaces and asks you to type the hostname (or pass `--replace-existing-domain`). It then adds the address to `wrangler.deploy.jsonc` and deploys; Cloudflare creates the DNS record and the certificate ([Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). The database, the buckets, the setup code and every tour stay as they are. What changes for you: the server address in Mythicshot's settings (Settings › Output › Tour publishing), and the address you share for published tours. The `workers.dev` address keeps answering, so links already shared keep working. **Unconfirmed:** that both addresses answer at once has not been seen on a real account.

> [!WARNING]
> Attaching an address takes it over: if the hostname already has a DNS record (a website, a mail service, anything) or is another Worker's custom domain, the deploy points it at this platform instead, without asking again. Wrangler run without a terminal does this, and the command cannot look the hostname up first, so it makes you confirm. Check the domain's DNS records in the dashboard before you confirm, and use a hostname nothing else uses, such as `tours.example.com`.

### Your domain is already on Cloudflare

Choose "My own address" in the command, or pass `--domain tours.example.com`. After the takeover warning above and your confirmation, the command attaches it as a Workers Custom Domain, which needs an active zone on the account ([Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). The certificate can take a few minutes after the first deploy.

### Your domain is registered elsewhere

A Workers Custom Domain needs an active Cloudflare zone, and the pages read describe no way to point a domain run elsewhere at a `workers.dev` address. When you answer that the domain is not on Cloudflare yet, the command explains the options below, sets the platform up on the free `workers.dev` address so you can start using it, and tells you the command to run once the domain is ready. These are the two ways Cloudflare's documentation gives:

1. **Move the domain's DNS to Cloudflare** (Free plan). The domain stays registered where it is; only its nameservers change. Add the domain under Domains in the dashboard, pick a plan, review the DNS records it found, then change the nameservers at your registrar to the two Cloudflare gives you ([Onboard a domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/)). Once it shows as active, run `npm run setup:cloudflare -- --domain tours.example.com`.
2. **Keep your DNS where it is, with a partial (CNAME) setup.** Cloudflare proxies chosen hostnames while your DNS provider stays in charge, and you add a CNAME record for each at your provider. It is only available on the Business and Enterprise plans ([Partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)). **Unconfirmed:** the Custom Domains page does not say whether a Custom Domain works on a partial zone; the [Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/) page runs a Worker on a hostname that has a proxied DNS record, which on a partial zone you would set up by hand.

For someone who already has a different domain on Cloudflare, there is a third, advanced way: Cloudflare for SaaS lets a hostname on a domain run elsewhere point by CNAME at a zone on your account, with 100 such hostnames included on every plan, and a Worker can serve them ([Get started](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/), [plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/), [Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)). The command does not set this up. **Unconfirmed:** it has not been tried with this app.

> [!WARNING]
> If the domain uses DNSSEC, turn it off at the registrar before changing nameservers, or the domain can become unreachable.

## Two addresses

The platform can serve two host names in two roles, a tours address such as `tours.example.com` and an app address such as `app.example.com`; what each answers is in [One address or two](../README.md#one-address-or-two) in the README. On Cloudflare the two names are two vars of the Worker, `TOURS_HOST` and `APP_HOST`, beside `PUBLIC_IMAGE_BASE` in `wrangler.jsonc`. Both are empty there, which is one address: the Worker checks no host name and answers on your own address and on the `workers.dev` address alike, as the rest of this runbook describes.

**Unconfirmed:** nothing in this section has been run on a real Cloudflare account. It is written from the Worker's code and from the tests of the guided command, which run against a stand-in for Wrangler.

Two addresses on Cloudflare wait for a later version. The guided command sets up one address: on a new install it writes both empty into `wrangler.deploy.jsonc`, it has no option for a second domain, and it attaches one custom domain only. A second `routes` entry added to that file by hand stops it with "wrangler.deploy.jsonc has routes this command did not write; it handles one custom domain only." So the app address cannot be attached with this command yet, and until it can, leave both vars empty.

```jsonc
"vars": { "PUBLIC_IMAGE_BASE": "", "TOURS_HOST": "", "APP_HOST": "" }
```

The command never sets, checks or shows the two vars, but it keeps a pair that was set by hand in `wrangler.deploy.jsonc`: `update`, and a later run of the setup, write both values back exactly as they found them. What such a pair does is the Worker's own behaviour.

| The two vars | What the Worker answers |
|---|---|
| Both empty (what the command writes) | One address: every host name is answered, the `workers.dev` address included |
| Both set, to two different host names | The two names in their roles, as in the README. Every other host name, the `workers.dev` address included, gets an empty answer with status 421 on every path except `/healthz` |
| One without the other, a value that is not a plain host name, or the same name twice | Every request, `/healthz` included, answers `500` with `{"error":"misconfigured"}` until the pair is corrected or emptied |

A Worker cannot refuse to start, which is why a pair that cannot be used closes every path instead. Each such request logs one fixed line after `hosts: `, naming the var and never its value; `npx wrangler tail --config wrangler.deploy.jsonc` shows it, and the README lists the lines.

> [!WARNING]
> Setting the two vars by hand can take the whole site down at the next deploy: a pair that cannot be used answers 500 everywhere, and a pair that can be used refuses the `workers.dev` address and every name that is not one of the two.

A third var, `IMG_HOST`, is optional: the host name of an address for shared images and clips, such as `img.example.com`, only beside both of the other two, as in [An optional third address for images and clips](../README.md#an-optional-third-address-for-images-and-clips) in the README. Without it, images and clips answer on the tours address. It is not in `wrangler.jsonc` and not the same as `PUBLIC_IMAGE_BASE` below. Like the other two it waits for a later version of the guided command, which attaches no third domain; the command keeps a value set by hand, and on its own or naming the same host as another var it answers `500` everywhere, as in the table above.

To go back to one address, set both vars to an empty string in `wrangler.deploy.jsonc`, as in the block above, remove an `IMG_HOST` var if there is one, and deploy with the update command. With both empty the command writes them empty again, and the Worker answers on every address as before.

```sh
npm run setup:cloudflare -- update
```

**How to tell it worked:** `/healthz` prints `{"ok":true}` on your own address and on the `workers.dev` address.

## Published images

By default the app serves published images itself on `/p/<name>`, reading them from the public bucket through the Worker's own binding (`PUBLIC_IMAGE_BASE` is empty). That is the same code on Workers as under `wrangler dev` and in the container, so there is one address only: no second address for images, no header rule, and no public access on either bucket. The app sends each image with `X-Content-Type-Options: nosniff` and a sandboxing Content-Security-Policy, and only serves names of images that are published.

The cost: each image a visitor's browser loads is one Worker request, plus one database read and one bucket read. Viewing a tour costs about one request for the page, two for the player's script and stylesheet, and one per image. The Free plan allows 100,000 Worker requests a day ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)); past that, requests fail with error 1027 until the limit resets at midnight UTC ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). So a tour of 20 images uses about 23 requests the first time a visitor opens it, or roughly 4,000 first views a day on the Free plan. Images are sent as cacheable for a year, so a visitor's browser does not ask for them again. The Workers Paid plan includes 10 million requests a month, at a minimum of 5 US dollars a month for the account, with additional requests at 0.30 US dollars per million (same pricing page).

### Optional later step: a separate address for images

For heavier use, the public bucket can serve images itself on an address of its own, so image views stop counting as Worker requests. This needs a domain on the account. The bucket's `r2.dev` address is rate-limited and meant for development only, so do not use it.

1. In the dashboard, open R2 object storage, then Overview, and select the public bucket (`demo-platform-public`).
2. Select Settings. Under Custom Domains, select Add.
3. Enter `images.example.com` and select Continue.
4. Review the DNS record it will add, then select Connect Domain. The status changes from Initializing to Active within a few minutes. The hostname must be on a zone in the same Cloudflare account as the bucket ([R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)).
5. On the zone of `images.example.com`, add a response header transform rule that matches that hostname and sets these two headers on every response, the same ones the app sends when it serves images itself:

```text
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; sandbox
```

6. In `wrangler.deploy.jsonc`, set `PUBLIC_IMAGE_BASE` under `vars` to that address, with no slash at the end, then run `npm run setup:cloudflare -- update`. The command keeps this value from then on.

```jsonc
"vars": { "PUBLIC_IMAGE_BASE": "https://images.example.com" }
```

The published-tour page builds each image address as `PUBLIC_IMAGE_BASE` plus `/p/<name>`, which is the object's key in the bucket, and its Content-Security-Policy allows images only from that origin. The value must be an `https://` address; anything else blocks every image.

> [!WARNING]
> Never give the drafts bucket public access or a custom domain: drafts must only be reachable with the API token.

**Unconfirmed:** the dashboard path for the transform rule, and whether the zone's cache keeps serving an image after unpublish deletes it (images are sent with `Cache-Control: public, max-age=31536000, immutable`). This step can only be checked on a real deploy.

## The setup wizard and Mythicshot

1. Open the setup wizard at the address the command printed, such as `https://tours.example.com/setup`. Open it on the address Mythicshot will use: the wizard shows the address it was opened on as the server address.
2. **Step 1 of 4:** enter the setup code and press Continue.
3. **Step 2:** enter a workspace name (1 to 80 characters) and the owner's email, and press Continue.
4. **Step 3:** the API token is shown once. Copy it into your password manager, tick "I've saved the token", and press Continue.
5. **Step 4:** in Mythicshot, open Settings › Output › Tour publishing, paste the server address and the token, and press Test connection. The wizard changes to "Mythicshot is connected." Press Finish.

After that, every setup address answers "not found", and the setup code opens nothing.

> [!WARNING]
> The API token works like a password: anyone holding it can upload to and unpublish every tour in the workspace.

**How to tell it worked:** opening `/setup` again shows `{"error":"not_found"}`.

## Manual setup, step by step

For people who prefer to run each step themselves. The guided command runs these same commands; `npm run setup:cloudflare -- --dry-run` prints them with your names filled in. Run them in the repository's folder after `npm ci`.

### M1. Sign Wrangler in

```sh
npx wrangler login
```

**How to tell it worked:** `npx wrangler whoami` shows your account.

### M2. Create the database

```sh
npx wrangler d1 create demo-platform
```

It prints the new database's id.

### M3. Create the two buckets

Drafts and published images live in separate buckets, so a draft can never be reached by a public address. Bucket names may use lowercase letters, digits and hyphens, 3 to 63 characters.

```sh
npx wrangler r2 bucket create demo-platform-drafts
```

```sh
npx wrangler r2 bucket create demo-platform-public
```

**How to tell it worked:** both buckets appear under R2 object storage in the dashboard.

### M4. Write your install's settings

Copy `wrangler.jsonc` to `wrangler.deploy.jsonc` (Git ignores it), and in the copy:

1. Replace the placeholder `database_id` (`00000000-0000-0000-0000-000000000000`) with the id from M2. If you chose another name than `demo-platform`, change `name`, `database_name` and both `bucket_name` values to match.
2. Add `"workers_dev": true`, so the free address stays on.
3. Only with your own domain, already active on the account: add a `routes` entry beside `vars`.

```jsonc
"routes": [{ "pattern": "tours.example.com", "custom_domain": true }]
```

The repository's `wrangler.jsonc` keeps its placeholders; it is also what `wrangler dev` and the tests use. Every command below names your copy with `--config`.

### M5. Apply the migrations

```sh
npx wrangler d1 migrations apply demo-platform --remote --config wrangler.deploy.jsonc
```

**How to tell it worked:** it lists `0001_init.sql`, `0002_guide_cards.sql`, `0003_publish.sql` and `0004_publish_steps.sql` as applied. Running it again says there is nothing to apply.

### M6. Deploy

```sh
npx wrangler deploy --config wrangler.deploy.jsonc
```

It prints the Worker's `workers.dev` address. Until the setup code is set in the next step, `/setup` answers `{"error":"not_found"}`. That is on purpose: setup stays closed without a code.

**How to tell it worked:** `curl https://tours.example.com/healthz` (or the `workers.dev` address) prints `{"ok":true}`. A new custom domain's certificate can take a few minutes.

### M7. Set the setup code

The setup code lets the first person who has it claim the platform. Generate it; never invent one. Any of these prints 32 random hex characters:

```sh
openssl rand -hex 16
```

```sh
node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))"
```

Then store it as a secret. Wrangler asks for the value; paste the code there, not on the command line, so it stays out of your shell history. This deploys a new version of the Worker at once.

```sh
npx wrangler secret put SETUP_CODE --config wrangler.deploy.jsonc
```

Keep the code only until you finish the wizard. Neither Wrangler nor the dashboard shows a secret's value again.

> [!WARNING]
> There is no limit on wrong guesses on Cloudflare, so a short or made-up code can be guessed and the platform claimed: always use a generated one.

**How to tell it worked:** `/setup` now shows "Set up your tour site". Go on with [The setup wizard and Mythicshot](#the-setup-wizard-and-mythicshot).

## Update

1. Get the new version of the repository. Your `wrangler.deploy.jsonc` is not part of it and stays.
2. Install its packages.

```sh
npm ci
```

3. Run the update. It refreshes `wrangler.deploy.jsonc` from the new `wrangler.jsonc` (keeping your name, database id, address and `PUBLIC_IMAGE_BASE`, and the vars `TOURS_HOST`, `APP_HOST`, `STORAGE_ALLOWANCE_BYTES`, `SITE_HOST`, `INVITE_CONTACT`, `DOWNLOAD_URL`, `SESSION_MAX_DAYS`, `CONNECTION_IDLE_DAYS` and `CONNECTION_MAX_DAYS` when they were set by hand), applies any new migrations, then deploys. Add `--dry-run` to see the commands first. **Unconfirmed:** migrating before deploying assumes each migration only adds to the schema, which holds for the migrations so far.

```sh
npm run setup:cloudflare -- update
```

By hand, the same is `npx wrangler d1 migrations apply demo-platform --remote --config wrangler.deploy.jsonc` and then `npx wrangler deploy --config wrangler.deploy.jsonc`.

**How to tell it worked:** `/healthz` prints `{"ok":true}` and Mythicshot's Test connection works.

Shared images and clips: from 0.1.47 their pages and files are sent with `Cache-Control: no-cache`, so a cache in front of the site (a tunnel's or a CDN's edge, a proxy) asks the site before it serves one again, and restricting, deleting or disabling an item takes effect at the next request on the site. A copy such a cache stored under 0.1.46 or earlier can still be served for up to an hour after the update (a page for up to a minute); purge the cache after the update if an item must stop being seen at once. A browser that already loaded a file keeps it.

> [!WARNING]
> A CDN or proxy rule in front of the site that overrides its cache headers, such as a "cache everything" rule with a lifetime of its own, would go on serving an image or clip after it is restricted. No such rule may cover `/i/` and `/r/`.

### Going back to an earlier version

Going back to a version before 0.1.38 is refused once a tour is restricted: on cPanel, `cpanel.sh` refuses it (unless `--no-restricted-tours-checked-by-hand` states that someone checked by hand, and only when it cannot read the database). On this route nothing checks it for you before you deploy an earlier version: only the database stands in the way, whose triggers make an earlier version's publish or rename of a restricted tour fail instead of making it public. Version 0.1.38 brings who may view a tour. A version before it does not know that setting, so once any tour has been made `people` or `me`, or is being changed to or from that, never deploy an earlier version on the same database: it could show that tour to anyone.

> [!WARNING]
> Do not go back to an earlier version once a tour is restricted; restore the backup taken before the update instead, which loses everything done on the site since it was taken.

Find out first with `npx wrangler d1 execute demo-platform --remote --config wrangler.deploy.jsonc --command "SELECT (SELECT count(*) FROM tour WHERE access <> 'public') + (SELECT count(*) FROM access_switch) AS n"`: anything but `0` means restore (see [Back up and restore](#back-up-and-restore)), not go back. Restoring brings back the tours, links, accounts and settings as they were when the backup was taken; everything done since is lost.

The same holds for a version before 0.1.47 once a shared image or clip is restricted to people or to its owner: such a version does not know who may view an item, answers a restricted item's link as one that does not exist, and could show the item to anyone through another link it would give its owner. On this route nothing checks it for you: before you deploy a version below 0.1.47, count the shared items whose setting is not `public` with `npx wrangler d1 execute demo-platform --remote --config wrangler.deploy.jsonc --command "SELECT count(*) AS n FROM media WHERE access <> 'public'"`: anything but `0` means restore, not go back. An older version also cannot fully delete an item whose list of addresses holds one, whether the item is restricted now or was before (the list is kept when an item goes back to public): its delete stops serving the item and removes its files, but answers `500 cleanup_pending` every time and leaves the item's row, which 0.1.47 or later removes at the workspace's next share or when the delete is sent again.

## Back up and restore

| What | Where |
|---|---|
| Workspaces, owners, token hashes, tours, chapters and steps | The D1 database `demo-platform` |
| Draft images | The R2 bucket `demo-platform-drafts` |
| Published images | The R2 bucket `demo-platform-public` |
| The setup code | The Worker's secret `SETUP_CODE` |
| Your install's names, database id and address | `wrangler.deploy.jsonc` in your checkout; keep a copy |

Export the database to a SQL file:

```sh
npx wrangler d1 export demo-platform --remote --output demo-platform.sql --config wrangler.deploy.jsonc
```

> [!WARNING]
> The export holds the owner's email and the token hashes: keep it as private as a password, and store it off your computer too.

An export blocks other requests to the database while it runs, so run it when nobody is uploading.

D1 also keeps its own history, called Time Travel: 7 days on the Free plan and 30 days on the Workers Paid plan. Restoring to a point in time uses `npx wrangler d1 time-travel restore demo-platform --timestamp=<unix time> --config wrangler.deploy.jsonc`.

> [!WARNING]
> A Time Travel restore overwrites the whole database in place; export it first.

To restore an export into a new, empty database, create the database (M2), put its id in `wrangler.deploy.jsonc`, and run the export file against it with `npx wrangler d1 execute demo-platform --remote --file demo-platform.sql --config wrangler.deploy.jsonc` instead of applying the migrations. **Unconfirmed:** this restore has not been tried.

**Unconfirmed:** the Cloudflare pages read for this runbook describe no command that downloads a whole R2 bucket, so backing up the images is not covered here yet.

## If the setup wizard's answer was lost

### The setup code was lost before anyone used it

Run the command again with `--new-setup-code`. It replaces the secret and prints the new code once; the old one stops working.

```sh
npm run setup:cloudflare -- --new-setup-code
```

### The token was lost before anyone saved it

If the wizard saved the workspace but the token never reached you (the page was closed or the connection dropped after step 2), setup is closed and nobody holds a token. These steps clear the half-finished setup so the wizard can run again. They delete nothing once the token has been used, a tour or upload exists, or there is more than one workspace.

What they remove is everything of that half-finished site: the workspace, its token and its owner's account. From the version with sign-in on, that can include the first admin's account with its sessions and sign-in codes, so the site has no admin again until one is made after the new setup. This is the only way back to the setup step, and no tour can be lost by it, because the steps do nothing once a tour or an upload exists.

Use the SQL on this page, not the SQL of an older copy of this runbook. On a database this version has updated, the older SQL fails at `DELETE FROM user`, and can leave the token deleted with setup still closed; the SQL below also clears that state.

1. Save this as `reset-setup.sql` in the repository's folder.

```sql
DELETE FROM api_token WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token WHERE last_used_at IS NOT NULL);
DELETE FROM signin_code WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
DELETE FROM session WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
DELETE FROM signin_method WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
DELETE FROM membership WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
DELETE FROM user WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
DELETE FROM setup WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
DELETE FROM workspace WHERE (SELECT count(*) FROM workspace) = 1 AND NOT EXISTS (SELECT 1 FROM tour) AND NOT EXISTS (SELECT 1 FROM upload) AND NOT EXISTS (SELECT 1 FROM api_token);
SELECT count(*) AS workspaces FROM workspace;
```

2. Export the database first, as in [Back up and restore](#back-up-and-restore).
3. Run the file against the database. The SQL is checked by this repository's tests on both targets; running it through Wrangler is **Unconfirmed**.

```sh
npx wrangler d1 execute demo-platform --remote --file reset-setup.sql --config wrangler.deploy.jsonc
```

The last result shows `workspaces` as 0 when setup was cleared. A 1 means one of the conditions above held and nothing was deleted.

4. Set a new setup code, because the old one may have been seen.

```sh
npm run setup:cloudflare -- --new-setup-code
```

5. Run the wizard again from [The setup wizard and Mythicshot](#the-setup-wizard-and-mythicshot).

## Removal

The guided command never deletes a database, bucket, Worker or secret. Removing an install is done by hand, in this order, and cannot be undone.

> [!WARNING]
> Deleting the database or a bucket destroys every workspace, tour and image in it for good: export the database first, as in [Back up and restore](#back-up-and-restore).

1. Delete the Worker, which takes the platform offline at every address. **Unconfirmed:** whether this also removes its custom domain's DNS record has not been checked.

```sh
npx wrangler delete --config wrangler.deploy.jsonc
```

2. Delete the database.

```sh
npx wrangler d1 delete demo-platform
```

3. Delete both buckets. **Unconfirmed:** whether a bucket that still holds objects can be deleted this way; if Wrangler refuses, empty it in the dashboard first.

```sh
npx wrangler r2 bucket delete demo-platform-drafts
```

```sh
npx wrangler r2 bucket delete demo-platform-public
```

4. If you used your own domain: deleting a Custom Domain does not delete its certificate, which you remove by hand ([Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). If you set up a separate images address, remove it and its transform rule too.
5. Delete `wrangler.deploy.jsonc` from your checkout.

## Costs

Cloudflare's [Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/) lists the Free plan's limits: 100,000 Worker requests a day, and for D1 5 million rows read and 100,000 rows written a day with 5 GB of storage. The [R2 pricing page](https://developers.cloudflare.com/r2/pricing/) lists R2's monthly free tier: 10 GB-month of storage, 1 million Class A and 10 million Class B operations, and no charge for egress. With images served by the app (the default), every image view counts as a Worker request: see [Published images](#published-images).

> [!WARNING]
> Use above the free amounts is billed on paid plans; check both pricing pages before you rely on the free tier.

### Clean-up without a scheduled trigger

A publish that is abandoned half-way leaves images it already copied, recorded as pending and not served. Nothing needs to be scheduled to remove them: after 15 minutes without progress, the workspace's next publish, unpublish, tour list or upload (the recorder lists tours each time it opens its picker) retires them and deletes them, a page at a time, together with replaced images whose grace period has passed. A Cron Trigger is optional; this app does not define one, and adding one only makes the clean-up independent of traffic.

### Per-request limits on the Free plan

Cloudflare's [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) gives the Free plan 50 subrequests and 10 ms of CPU time per request, and counts every call to R2 or D1 as a subrequest. The [D1 limits page](https://developers.cloudflare.com/d1/platform/limits/) allows 50 queries per Worker invocation on the Free plan and counts a batch as one query.

The app keeps every request at or under 40 database and storage calls, and the test suite drives each route to its worst case to check it. Publishing is the only job that needs more, so it runs over several requests of at most 12 images each: a 400-step tour takes 34 requests, and `scripts/publish.ts` makes them for you (see [Publish a tour](../README.md#publish-a-tour)). Unpublish and the clean-up of replaced images also work a page at a time. Each call of a publish refreshes one heartbeat row and marks only the images it copied, so a 400-step publish writes about 1,700 rows in all (D1's free amount is counted in rows written). A request that goes over 40 calls anyway logs `budget: a POST request made … calls`, which `npx wrangler tail --config wrangler.deploy.jsonc` shows.

The CPU limit has not been measured on Cloudflare. In plain Node on a desktop computer, the app's own CPU time for the heaviest requests was about 6 to 8 ms for the first request of a 400-step publish with a snapshot near its 512,000-byte cap, 5 to 8 ms for the page of such a tour, and 5 to 13 ms for an upload whose manifest is at its 262,144-byte cap (the higher figure on a cold start); every other request measured under 3 ms. Workers run on different hardware, so treat these as estimates, and keep tours well under the caps if a request is refused for CPU.

The API documentation page (`/docs`, see [API documentation](../README.md#api-documentation)) is built into the Worker, viewer included, which makes the Worker's script about 2,276,000 bytes, or 574,000 bytes compressed with gzip (measured by bundling the Worker's entry file with esbuild, minified; `test/node-docs-build.test.ts` prints the figure and fails above 1,000,000 compressed). The [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) gives the size a Worker may have after compression on each plan; check the figure there before the first deploy of this version.

**Unconfirmed:** whether the Free plan's 10 ms of CPU time allows the first answer of the viewer's script. That file is 1,685,697 bytes, and the Worker turns it into bytes once, on the first request for it after a start, then keeps them: in plain Node on a desktop computer that first answer took about 20 ms and every later one about 0.5 ms; the page itself took under 2 ms the first time. A browser asks for the file once and then keeps it for a year, so the request is rare. If Cloudflare refuses it for CPU (error 1102 on `/docs/viewer.<hash>.js`, and a documentation page without its reference), the rest of the site is not affected: say so before changing anything, since the way out is to serve these files as static assets, which is not built.

**Unconfirmed:** the Worker's startup time. With the viewer built in, every cold start parses a script of about 2.3 MB before it answers anything, and that is true for a tour page and an API request as much as for the documentation page. It has not been measured on Cloudflare: at the first deploy of this version, check that the deploy is accepted (Cloudflare refuses a Worker whose startup takes too long; the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) gives the time allowed) and that the first tour page after a quiet period opens as quickly as before. If either this or the CPU limit above is hit, the follow-up is the same: serve the documentation page's four files (the viewer's script and stylesheet, and the page's own two) as static assets instead of from the Worker's script.

## Accounts and mail

The database of a Cloudflare install holds accounts as the Node target's does: the setup wizard makes the owner's. But in this version a Worker sends no mail, whatever mail vars it is given, and the server command that makes the first admin, prints recovery links, changes an address and reads the audit record runs on the Node target only. So a Cloudflare install has no admin, its sign-in page sends no link, and nobody can sign in to its dashboard. Mythicshot, the API tokens, tours, publishing and the storage allowance work as before. How accounts behave where they can be used is in [Accounts and signing in](../README.md#accounts-and-signing-in) in the README.

What that means for the operator's usual tasks:

| Task | On Cloudflare in this version |
|---|---|
| Mail does not arrive | None is sent: a Worker has no mailer. Nothing needs fixing, and Mythicshot is not affected |
| Someone is locked out | Nobody can sign in to the dashboard here. Mythicshot keeps working with its token |
| An account's address is wrong | There is no command to change it here. Nothing on a Cloudflare install uses the address yet, since no mail is sent and nobody signs in |
| A workspace is over its allowance | Delete tours with Mythicshot or the API (see [The tour API](../README.md#the-tour-api)), or raise or remove the `STORAGE_ALLOWANCE_BYTES` var in `wrangler.deploy.jsonc` and run `npm run setup:cloudflare -- update`, which keeps the var. A workspace's own allowance is set on the dashboard's Admin page, which needs an admin, so it cannot be set here |
| Read the audit record | It stays empty: everything it records needs an admin or a sign-in |

The var `INVITE_CONTACT`, who to ask for an invite, works here: the sign-in page shows it, and `update` keeps it, as it keeps `SITE_HOST` and `STORAGE_ALLOWANCE_BYTES`. So does the var `DOWNLOAD_URL`, the `https://` address of the page the desktop app is downloaded from, which the dashboard's Account and Connections pages link to: add it by hand to `vars` in `wrangler.deploy.jsonc`, such as `"DOWNLOAD_URL": "https://downloads.example.com/mythicshot/"`, and run `npm run setup:cloudflare -- update`. A value that cannot be used closes nothing: the link is left out, and the Worker's log shows `download page: off, because DOWNLOAD_URL is not a usable https address.` once per instance. The three sign-in lifetimes, `SESSION_MAX_DAYS`, `CONNECTION_IDLE_DAYS` and `CONNECTION_MAX_DAYS`, are kept the same way, each a whole number of days from 1 to 3650 or `"off"`, such as `"CONNECTION_MAX_DAYS": "365"`; a value that cannot be used closes nothing, the default applies and the Worker's log names the setting once per instance. Nobody can sign in on this install in this version, so they change nothing yet, and the setup token is never touched by them. Their meaning is in [Settings](../README.md#settings) in the README.

## Troubleshooting by symptom

| Symptom | Likely cause | What to do |
|---|---|---|
| The command says Wrangler is not signed in | No `wrangler login` yet on this computer, or it expired | Run `npx wrangler login`, then the same command again. |
| `wrangler login` cannot reach its callback | Signing in on a remote machine | Use `npx wrangler login --device`. |
| The deploy stops asking for a `workers.dev` subdomain | The account has none registered yet | Register one in the dashboard under Workers & Pages, then run the command again. |
| The deploy fails and the command says Cloudflare would not attach the address | Most often, the domain is not an active zone on this account | The command has already taken the address out of `wrangler.deploy.jsonc`. Run the same command again to finish on the address you had before (or `workers.dev`), and run it with `--domain` again once the zone is active. |
| The deploy fails for another reason while a new address waits | A network problem, an unregistered `workers.dev` subdomain, or anything else Wrangler reports | The address stays confirmed but not attached. Fix what Wrangler reported and run the same command again; `--no-domain` gives up on the address. |
| The command stops about `account_id` | `wrangler.jsonc` or `wrangler.deploy.jsonc` sets an `account_id` that conflicts with `CLOUDFLARE_ACCOUNT_ID`, with the other file, or with your login | Remove the hand-added `account_id`, or make the values agree. |
| The command stops asking for `--replace-existing-domain` or `--adopt-existing` | A new own address, or a same-named database, bucket or Worker, needs a confirmation `--yes` does not give | Read what it printed; pass the flag only if you accept it, or choose another hostname or `--name`. |
| The command stops listing several accounts | The login can use more than one account | Set `CLOUDFLARE_ACCOUNT_ID` to the one to use, as in [Modes and options](#modes-and-options). |
| Something that was at the hostname stopped working after you attached it | Attaching an address replaces its DNS record or Worker domain | Choose another hostname with `--domain`, then restore the old record in the dashboard's DNS settings. |
| "Please enable R2 through the Cloudflare Dashboard" (code 10042) | R2 is not enabled on the account yet | In the dashboard, open R2 object storage and enable it, then run the command again. |
| The command stopped half-way | A Cloudflare call failed | Fix what it reported and run the same command again; it reuses what was made. |
| Requests fail with a database or bucket error | The migrations were not applied, or `wrangler.deploy.jsonc` was edited by hand | Run `npm run setup:cloudflare -- status`, then the setup again. |
| A script or the recorder gets error 1010 on the `workers.dev` address | The Browser Integrity Check refused its User-Agent | Use your own domain, or a client that sends a descriptive User-Agent. |
| Visitors get error 1027 | The Free plan's 100,000 requests a day are used up | Wait for midnight UTC, move to the Workers Paid plan, or serve images from [a separate address](#optional-later-step-a-separate-address-for-images). |
| `/setup` shows `{"error":"not_found"}` before anyone finished it | `SETUP_CODE` is not set or is shorter than 16 characters | Run `npm run setup:cloudflare -- status`; set a code with `--new-setup-code`. |
| `/setup` shows `{"error":"not_found"}` and nobody holds the token | The claim was saved but its answer was lost | See [The token was lost](#the-token-was-lost-before-anyone-saved-it). |
| "That setup code isn't right." | The code typed differs from the secret | Secrets cannot be read back: run the command with `--new-setup-code`. |
| "This site has already been set up." | Someone finished setup first | If nobody holds the token, see [The token was lost](#the-token-was-lost-before-anyone-saved-it). |
| The images address stays Initializing | Not yet connected | In the bucket list, use the menu next to the bucket and choose Retry connection. |
| Every address answers `{"error":"misconfigured"}` with status 500, `/healthz` included | `TOURS_HOST` and `APP_HOST` in `wrangler.deploy.jsonc` are a pair the Worker cannot use | Empty both, then run `npm run setup:cloudflare -- update` ([Two addresses](#two-addresses)). |
| The `workers.dev` address shows an empty page with status 421 while your own address works | Both vars are set, and with two addresses every other host name is refused | To have one address again, empty both vars ([Two addresses](#two-addresses)). |

## Pages this runbook relies on

- [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), for the free address, its format and its limits.
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), for attaching your own address, the CNAME restriction and the certificate left behind.
- [Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), for running a Worker on a proxied hostname.
- [Onboard a domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/), for moving a domain's DNS to Cloudflare and the DNSSEC warning.
- [Partial (CNAME) setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/), for keeping DNS elsewhere and its plan requirement.
- [Cloudflare for SaaS: get started](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/), [its plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) and [Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/), for the advanced third way.
- [Wrangler general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/), for `wrangler login` and `wrangler whoami`.
- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), for creating the database, applying migrations, running SQL and exporting.
- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/), for exports and running SQL files.
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), for its history and restoring.
- [Create R2 buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/), for the command and the naming rules.
- [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/), for the optional images address and the `r2.dev` limits.
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and [Workers Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/), for `wrangler secret put` (including piped input), `wrangler secret list` and `wrangler deploy`.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/), for the free amounts and the paid plan.
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), for the daily request limit, error 1027, and the subrequests, CPU time and queries allowed per request.

The guided command is [scripts/setup-cloudflare.ts](../scripts/setup-cloudflare.ts), the repository's Worker settings are in [wrangler.jsonc](../wrangler.jsonc), and the migrations in [migrations/](../migrations/).
