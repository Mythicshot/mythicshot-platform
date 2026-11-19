# Runbook: Docker on Debian

> [!WARNING]
> Draft: this runbook has not yet been run end to end on a real server. It is written from the code in this repository and from the vendors' documentation. Steps that could not be confirmed from either are marked **Unconfirmed**.

This runbook puts the platform on one Debian server with any DNS provider. `install.sh` installs Docker, writes the settings, starts the app behind Caddy and gets the HTTPS certificate. The DNS record, the firewall, the domain itself, backups kept off the server and keeping Debian patched stay yours.

There are two routes to the server, chosen when you install. The direct route, steps 1 to 6 below, needs ports 80 and 443 open to the server. The tunnel route needs no open port at all, which suits a server at home behind a router: it is described in [Behind a Cloudflare Tunnel](#behind-a-cloudflare-tunnel) and replaces steps 2, 3 and 6.

Examples use `tours.example.com` for the platform's address, `203.0.113.10` and `2001:db8::10` for the server's addresses, and `you` for your login on the server. The optional second address of [Two addresses](#two-addresses) is `app.example.com`. Put your own in their place.

## Contents

- [What you need before you start](#what-you-need-before-you-start)
- [1. What to have ready](#1-what-to-have-ready)
- [2. Create the DNS record](#2-create-the-dns-record)
- [3. Open ports 80 and 443](#3-open-ports-80-and-443)
- [4. Build the app image and copy it to the server](#4-build-the-app-image-and-copy-it-to-the-server)
- [5. Run install.sh](#5-run-installsh)
- [6. The HTTPS certificate](#6-the-https-certificate)
- [7. The setup wizard and Mythicshot](#7-the-setup-wizard-and-mythicshot)
- [8. Update](#8-update)
- [9. Back up and restore](#9-back-up-and-restore)
- [10. Move to a new server](#10-move-to-a-new-server)
- [11. Uninstall](#11-uninstall)
- [Behind a Cloudflare Tunnel](#behind-a-cloudflare-tunnel)
- [Two addresses](#two-addresses)
- [Troubleshooting by symptom](#troubleshooting-by-symptom)
- [Pages this runbook relies on](#pages-this-runbook-relies-on)

## What you need before you start

1. A server running Debian 13 or 12 that you can log in to over SSH with `sudo`, with a public IPv4 address or a router that can forward ports to it. [Step 1](#1-what-to-have-ready) has the details.
2. A domain is required: one hostname for the platform, such as `tours.example.com`, at any DNS provider, where you can add an A record. Unlike the Cloudflare route, there is no free address to start on.
3. A computer with Docker and a copy of this repository, to build the app image.
4. About 30 minutes, plus however long your DNS provider takes to publish the new record. **Unconfirmed:** the timing is an estimate, not measured on a real server.

## 1. What to have ready

1. A server running Debian 13 "trixie", the [current stable release](https://www.debian.org/releases/). Debian 12 "bookworm" also works: the script prints a notice and goes on. Any other system is refused unless you add `--force`.
2. A public IPv4 address for the server, or a router in front of it that can forward ports to it. A public IPv6 address is optional.
3. A domain name and a login at the company that runs its DNS. You need one hostname for the platform, such as `tours.example.com`.
4. Root access over SSH: a login with `sudo`, or the root account itself. If you log in as root, leave out `sudo` in the commands below.
5. A computer with Docker and a copy of this repository. The app image is not published anywhere yet, so you build it yourself in [step 4](#4-build-the-app-image-and-copy-it-to-the-server).

Nothing else may listen on ports 80 and 443 on the server. The script checks this and stops if something does.

Items 2 and 3 and the two ports are for the direct route. For the tunnel route, read [What to have ready for the tunnel](#what-to-have-ready-for-the-tunnel) instead.

**How to tell it worked:** on the server, this prints a line naming Debian GNU/Linux 13 (trixie), or 12 (bookworm).

```sh
grep PRETTY_NAME /etc/os-release
```

## 2. Create the DNS record

1. On the server, list its addresses.

```sh
ip -o addr show scope global
```

2. At your DNS provider, create an A record for the hostname that points at the server's public IPv4 address.

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `tours` (the part before your domain) | `203.0.113.10` | the provider's default |
| AAAA (only if the server has a public IPv6 address) | `tours` | `2001:db8::10` | the provider's default |

3. If the server only has private addresses (such as `192.168.1.20`), it is behind a router. Point the A record at the router's public address instead, and forward the ports in [step 3](#3-open-ports-80-and-443) on the router to the server.

> [!WARNING]
> Create the AAAA record only if ports 80 and 443 are open over IPv6 too. A wrong AAAA record can stop the certificate from being issued.

**How to tell it worked:** on the server, this prints the address you entered. A new record can take a few minutes, or up to its TTL, to show up.

```sh
getent ahosts tours.example.com
```

`install.sh` runs the same check. If the record is missing or wrong, it prints the record to create and goes on; the certificate is issued as soon as the record works.

## 3. Open ports 80 and 443

Open these to the server on every firewall in front of it: your hosting provider's firewall, a router's port forwarding, or both.

| Port | Protocol | Why |
|---|---|---|
| 80 | TCP | The certificate authority checks the server here |
| 443 | TCP | HTTPS |
| 443 | UDP | HTTP/3, optional |

The script cannot see a firewall outside the server, so it cannot check this step.

> [!WARNING]
> Docker's page warns that ports a container publishes bypass the rules of a firewall running on the server itself, so a rule there does not keep ports 80 and 443 closed.

**How to tell it worked:** after [step 5](#5-run-installsh), the check in [step 6](#6-the-https-certificate) works from another network, such as a phone off Wi-Fi.

## 4. Build the app image and copy it to the server

Do this on your computer, in the folder holding this repository.

1. Find the server's architecture. On the server, this prints `amd64` or `arm64`.

```sh
dpkg --print-architecture
```

2. Build the image. When your computer has the same architecture as the server:

```sh
docker build -t demo-platform:latest .
```

When the server's architecture differs, build for it instead (here for `amd64`). **Unconfirmed:** this needs your Docker to run the other architecture's build steps under emulation; [Docker's build page](https://docs.docker.com/reference/cli/docker/buildx/build/) says it uses emulation when it is set up, and has you check with `docker buildx inspect --bootstrap`.

```sh
docker buildx build --platform linux/amd64 --load -t demo-platform:latest .
```

3. Save the image to a file.

```sh
docker save -o demo-platform.tar demo-platform:latest
```

4. Copy the image file and the install script to your home folder on the server.

```sh
scp demo-platform.tar deploy/install.sh you@203.0.113.10:
```

**How to tell it worked:** on the server, `ls` in your home folder shows `demo-platform.tar` and `install.sh`.

## 5. Run install.sh

1. Read the script before you run it as root. It explains its safety rules at the top.

```sh
less install.sh
```

2. If you like, see every command it would run without changing anything. A dry run asks the same questions.

```sh
sudo bash install.sh --dry-run
```

3. If Docker is not on the server yet, run the script once to install it. It asks its questions, installs Docker from Docker's own apt repository, and then stops with "the app image demo-platform:latest is not on this server and could not be pulled; nothing was written". That is expected: Docker stays installed and nothing of the platform is written yet. If Docker is already installed, skip this.

```sh
sudo bash install.sh
```

4. Load the image you copied.

```sh
sudo docker load -i demo-platform.tar
```

5. Run the script.

```sh
sudo bash install.sh
```

### What it asks

Each question allows three tries.

| Prompt | What to answer |
|---|---|
| `How do visitors reach this server?` then `Choice [1]:` | Press Enter, or type `1`, for the direct route of steps 1 to 6. Type `2` for the tunnel route. `--direct` or `--tunnel` answers this for you. |
| `Domain name for the platform (for example tours.example.com):` | The hostname from [step 2](#2-create-the-dns-record). Lowercase letters, digits, hyphens and dots; no IP address. |
| `Email for the certificate authority (expiry notices):` | Direct route only. An address that reaches you. Caddy gives it to the certificate authority as the contact for the certificate. |
| `Tunnel token from the Cloudflare dashboard (what you paste is not shown):` | Tunnel route only. See [Run install.sh with --tunnel](#run-installsh-with---tunnel). |
| `Data folder, new or empty [/opt/demo-platform/data]:` | Press Enter for the default. Any other folder must be new or empty and outside the system folders, such as `/srv/demo-platform`. |
| `Continue? [y/N]` | Type `y` after checking the summary it shows. `--yes` answers this for you. |

### What it does

In this order, saying each step before doing it:

1. Refuses to run unless it is root on Debian 13 or 12 (any system with `--force`).
2. Asks the questions above. On a later run it reads the answers from `/opt/demo-platform/.env` and asks nothing.
3. Checks Docker: it stops if Docker is a snap, if Compose is older than 2.20.0 or if the Docker daemon does not answer. When Docker is installed, it also checks that the app image is on the server, and tries to pull it if not.
4. Checks that nothing else listens on ports 80 and 443, and whether the domain points at this server. The tunnel route skips both checks, because it publishes no port and its DNS record is managed at Cloudflare.
5. Only if `docker compose version` failed in step 3: stops if Debian's own Docker packages are installed, otherwise installs Docker Engine and the Compose plugin from [Docker's apt repository](https://docs.docker.com/engine/install/debian/), checking the repository key's fingerprint first, and then checks the app image.
6. Creates `/opt/demo-platform` (root only) with `caddy/` and `backups/` inside, and the data folder, owned by id 1001 with mode 700. Existing folders are left as they are.
7. Writes `/opt/demo-platform/.env` (mode 600, root only) only if it does not exist yet: `DOMAIN`, `ACME_EMAIL`, `DATA_DIR`, `APP_IMAGE` and a new `SETUP_CODE` of 32 random hex characters. On the tunnel route it writes `DEPLOY_MODE=tunnel` and `TUNNEL_TOKEN` instead of `ACME_EMAIL`. With `--app-domain=<name>` it also writes `APP_DOMAIN`.
8. Writes `docker-compose.yml` and `caddy/Caddyfile`, in the form for the route and for the one or two addresses recorded in `.env`. A file that already exists and differs is first saved as `<name>.bak-<date>-<time>`.
9. Starts the stack and waits up to 120 seconds for the app to report healthy and, on the tunnel route, for the tunnel to connect to Cloudflare.

If a run fails, it puts back the files it replaced and removes the files it created. It never removes the data folder, `.env` or a backup.

### What it prints

At the end of the first run:

```text
The platform is running at https://tours.example.com

  Open:        https://tours.example.com/setup
  Setup code:  <your setup code>
```

This is the only time the setup code is printed. Later runs say it did not change.

> [!WARNING]
> Whoever enters the setup code first becomes the owner of the platform, so keep it private until you have finished [step 7](#7-the-setup-wizard-and-mythicshot).

### Running it again

`sudo bash install.sh` is safe to run again. It reads `.env`, asks nothing, keeps the setup code and the data, rewrites the stack files only if they changed, and starts anything that is not running.

To use an image with another name than `demo-platform:latest`, set `APP_IMAGE` on the first run, from a root shell (`sudo -i`):

```sh
APP_IMAGE=demo-platform:v2 bash install.sh
```

### Commands and options

| Command | What it does |
|---|---|
| `sudo bash install.sh install` | Install or repair. The default when no command is given. |
| `sudo bash install.sh update` | Back up, pull newer images and restart. See [step 8](#8-update). With [two addresses](#two-addresses) it then checks both. |
| `sudo bash install.sh backup` | Write a backup archive. See [step 9](#9-back-up-and-restore). |
| `sudo bash install.sh status` | Show the containers, the app's health check and the data folder's size. With [two addresses](#two-addresses) it also asks each address for its role, and ends with exit code 1 when one reports the wrong role. |
| `sudo bash install.sh uninstall` | Stop and remove the containers. See [step 11](#11-uninstall). |

| Option | What it does |
|---|---|
| `--tunnel` | Only with `install`: use the tunnel route. See [Behind a Cloudflare Tunnel](#behind-a-cloudflare-tunnel). |
| `--direct` | Only with `install`: use the direct route without being asked. |
| `--new-token` | Only with `install`, on a tunnel install: ask for the tunnel token again and replace it once the new one has connected. See [The tunnel token](#the-tunnel-token). |
| `--app-domain=<name>` | Only with `install`: a second address, for the app, as in `--app-domain=app.example.com`. The domain asked for stays the address of the tours. It is taken on a first install only; an existing install adds one line to `.env` by hand. See [Two addresses](#two-addresses). |
| `--dry-run` | Print every command and file write without doing any. |
| `--yes` or `-y` | Answer "continue?" questions with yes. It never skips the typed domain name that `--delete-data` asks for. |
| `--force` | Try on a system other than Debian 13 or 12. |
| `--delete-data` | Only with `uninstall`: also delete the data folder, after you type the domain name. |
| `--help` or `-h` | Print the usage text. |

**How to tell it worked:** this shows both containers running and the app `healthy`.

```sh
sudo bash install.sh status
```

## 6. The HTTPS certificate

Caddy, the front server in the stack, gets the certificate and renews it by itself, as described on [Caddy's automatic HTTPS page](https://caddyserver.com/docs/automatic-https). It needs three things: the domain's A (or AAAA) record points at the server, ports 80 and 443 reach it from outside, and its certificate folder survives restarts (the stack keeps it in `/opt/demo-platform/caddy-data`).

If an attempt fails, Caddy tries again on its own, waiting longer each time, up to one day between tries. It also sends one week of HSTS, so browsers keep to HTTPS for the platform's address.

**How to tell it worked:** from your computer, this prints `{"ok":true}` without a certificate error.

```sh
curl https://tours.example.com/healthz
```

When it does not work:

1. Check the record with `getent ahosts tours.example.com` on the server, as in [step 2](#2-create-the-dns-record).
2. Check the ports from another network, as in [step 3](#3-open-ports-80-and-443).
3. Read Caddy's log. Open a root shell first, because `/opt/demo-platform` is readable by root only.

```sh
sudo -i
```

```sh
cd /opt/demo-platform
```

```sh
docker compose logs caddy
```

> [!WARNING]
> Never delete `/opt/demo-platform/caddy-data`: it holds the certificate's private key, and getting many new certificates in a row runs into the certificate authority's rate limits.

## 7. The setup wizard and Mythicshot

1. Open `https://tours.example.com/setup` in a browser.
2. **Step 1 of 4:** enter the setup code the installer printed, and press Continue. "That setup code isn't right." means it does not match `SETUP_CODE` in `.env`.
3. **Step 2:** enter a workspace name (1 to 80 characters) and the owner's email, and press Continue.
4. **Step 3:** the API token is shown once. Copy it into your password manager, tick "I've saved the token", and press Continue.
5. **Step 4:** in Mythicshot, open Settings › Output › Tour publishing, paste the server address and the token, and press Test connection. The wizard changes to "Mythicshot is connected." Press Finish.

After that, every setup address answers "not found". That is on purpose: setup can be done once.

> [!WARNING]
> The API token works like a password: anyone holding it can upload to and unpublish every tour in the workspace.

**How to tell it worked:** opening `https://tours.example.com/setup` again shows `{"error":"not_found"}`.

### The setup code

The installer generates the setup code. Never invent one yourself: if you ever need a new code, generate it, for example with `openssl rand -hex 16` (in Debian's `openssl` package). The app refuses a code shorter than 16 characters and then keeps setup closed.

To see the code again, from a root shell in `/opt/demo-platform`:

```sh
grep '^SETUP_CODE=' .env
```

### If the token was lost before anyone saved it

If the wizard saved the workspace but the token never reached you (the page was closed or the connection dropped after step 2), setup is closed and nobody holds a token. These steps clear the half-finished setup so the wizard can run again. They delete nothing once the token has been used, a tour or upload exists, or there is more than one workspace.

What they remove is everything of that half-finished site: the workspace, its token and its owner's account. From the version with sign-in on, that can include the first admin's account with its sessions and sign-in codes, so the site has no admin again until one is made after the new setup. This is the only way back to the setup step, and no tour can be lost by it, because the steps do nothing once a tour or an upload exists.

Use the SQL on this page, not the SQL of an older copy of this runbook. On a database this version has updated, the older SQL fails at `DELETE FROM user`, and can leave the token deleted with setup still closed; the SQL below also clears that state.

1. Open a root shell and go to the install folder.

```sh
sudo -i
```

```sh
cd /opt/demo-platform
```

2. Create `/root/reset-setup.sql` with exactly this content.

```sh
nano /root/reset-setup.sql
```

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

3. Back up first, as in [step 9](#9-back-up-and-restore).

```sh
bash /home/you/install.sh backup
```

4. Run the file against the database inside the app container. The image has no database tool, so this uses Node's built-in SQLite module. **Unconfirmed in the container:** the same command was checked with Node against a local database file, and the SQL is checked by this repository's tests on both targets.

```sh
docker compose exec -T app node -e 'const fs = process.getBuiltinModule("node:fs"); const { DatabaseSync } = process.getBuiltinModule("node:sqlite"); const db = new DatabaseSync("/data/db.sqlite", { timeout: 5000 }); db.exec(fs.readFileSync(0, "utf8")); console.log(db.prepare("SELECT count(*) AS workspaces FROM workspace").get()); db.close();' < /root/reset-setup.sql
```

It prints `[Object: null prototype] { workspaces: 0 }` when setup was cleared. `{ workspaces: 1 }` at the end means one of the conditions above held and nothing was deleted.

5. Give the install a new setup code, because the old one may have been seen. This generates it and writes it to `.env`. If `openssl` is missing, install it first with `apt-get install openssl`.

```sh
sed -i "s/^SETUP_CODE=.*/SETUP_CODE=$(openssl rand -hex 16)/" .env
```

6. Restart the app with the new code, and read it.

```sh
docker compose up -d --force-recreate --wait app
```

```sh
grep '^SETUP_CODE=' .env
```

7. Run the wizard again from [step 7](#7-the-setup-wizard-and-mythicshot).

## 8. Update

The app image is loaded by hand, so `update` does not pull it: load the new image first.

1. On your computer, build and save the new image as in [step 4](#4-build-the-app-image-and-copy-it-to-the-server), and copy `demo-platform.tar` to the server.
2. Load it on the server.

```sh
sudo docker load -i demo-platform.tar
```

3. Run the update. It pulls a newer Caddy image if the stack file names one, writes a backup, then restarts on the new images and waits for the app to report healthy. It changes no file. The app applies any new database migrations as it starts.

```sh
sudo bash install.sh update
```

To also pick up a newer stack file or Caddyfile, copy the new `install.sh` to the server and run `sudo bash install.sh` again. It saves each changed file as `.bak-<date>-<time>` before replacing it.

Keeping Debian and Docker patched is yours to do, for example with `apt-get update` and `apt-get upgrade`.

**How to tell it worked:** the run ends with `==> Updated`, and `sudo bash install.sh status` shows the app `healthy`.

### Make yourself the admin

From the version with accounts on, people sign in in a browser with a link instead of a password. An updated site keeps working exactly as before, its tours, links and tokens unchanged, and nobody can sign in until the site has an admin. The admin is made once, by a command run in the app container, with the settings the app itself runs with; there is no web page for it, and the setup code plays no part in it.

1. From a root shell in `/opt/demo-platform`, run the command with your own email address and the username you want. The account that set up the site becomes the admin, with that address in place of the one typed in the setup wizard.

```sh
docker compose exec app node dist/node/admin.js first-admin --email you@example.com --username yourname
```

It prints `The admin account "yourname" was created.`, says that your tours, their links and your tokens stay exactly as they are, and ends with `Open this link within 15 minutes to sign in:` and a link on the app address, or on the one address with `SITE_HOST` set in `.env`; without either it prints only the part after the address, for you to put your site's address in front of.

2. Open the link in your browser. It works once and for 15 minutes. Run the command again and it says `This site already has an admin. Nothing was changed.`

3. For a new link at any time, for instance while mail is not set up, ask for one by address. It is printed here only, never mailed and never logged.

```sh
docker compose exec app node dist/node/admin.js signin-link --email you@example.com
```

The command also has `mail-check`, which says whether mail is set up without showing any setting, and `audit`, which shows the last sign-ins and admin changes; `--help` lists them. It runs beside the app without a restart, changes only the database, and applies no database update itself.

> [!WARNING]
> Never open the database with the server's `sqlite3` tool: an older one cannot read the platform's tables, so use the app's own commands, which run on the app's Node.js.

## 9. Back up and restore

### Back up

```sh
sudo bash install.sh backup
```

It makes a consistent copy of the database inside the running app container, then writes `/opt/demo-platform/backups/demo-platform-<date>-<time>.tar.gz` (mode 600) holding `db.sqlite`, `drafts/` and `public/`. It never removes an older backup, so delete old ones yourself when the disk fills.

The archive does not hold `.env` or the certificate. Neither is needed to restore: `install.sh` writes a new `.env` on a new server, and Caddy gets a new certificate. Because `.env` is left out, no backup archive holds the setup code or, on the tunnel route, the tunnel token.

> [!WARNING]
> A backup on the same server is lost with the server: copy every archive somewhere else.

> [!WARNING]
> A backup holds the owner's email, the token hashes and every draft image: keep it as private as a password.

### Copy a backup off the server

1. On the server, copy the archive to your home folder and make it yours (use the real file name).

```sh
sudo install -m 600 -o you /opt/demo-platform/backups/demo-platform-20261117-093000.tar.gz /home/you/
```

2. On your computer, fetch it.

```sh
scp you@203.0.113.10:demo-platform-20261117-093000.tar.gz .
```

3. On the server, remove the copy in your home folder.

```sh
rm /home/you/demo-platform-20261117-093000.tar.gz
```

### Restore

**Unconfirmed:** this procedure follows from how `install.sh` writes the archive and how the stack mounts the data folder, and has not yet been run on a server. The commands assume the default data folder `/opt/demo-platform/data`; use `DATA_DIR` from `.env` if yours differs.

1. Open a root shell and go to the install folder.

```sh
sudo -i
```

```sh
cd /opt/demo-platform
```

2. Stop the stack.

```sh
docker compose stop
```

3. Move the current data folder aside. Nothing is deleted: it stays as `data-before-restore`.

```sh
mv /opt/demo-platform/data /opt/demo-platform/data-before-restore
```

4. Create an empty data folder owned by id 1001.

```sh
install -d -m 0700 -o 1001 -g 1001 /opt/demo-platform/data
```

5. Unpack the archive into it (use the real file name).

```sh
tar -xzf /opt/demo-platform/backups/demo-platform-20261117-093000.tar.gz -C /opt/demo-platform/data
```

6. Make sure every file belongs to id 1001.

```sh
chown -R 1001:1001 /opt/demo-platform/data
```

7. Start the stack again on the restored folder.

```sh
docker compose up -d --force-recreate --wait
```

**How to tell it worked:** `sudo bash install.sh status` shows the app `healthy`, and Mythicshot's Test connection works with the token from before. Once you are sure, delete `data-before-restore` yourself.

## 10. Move to a new server

1. On the old server, make a backup and copy it off, as in [step 9](#9-back-up-and-restore).
2. Prepare the new server with [step 1](#1-what-to-have-ready), open its ports as in [step 3](#3-open-ports-80-and-443), and copy the image and the script to it as in [step 4](#4-build-the-app-image-and-copy-it-to-the-server).
3. Run `sudo bash install.sh` on the new server with the same domain name, as in [step 5](#5-run-installsh). It warns that the domain points at another server and goes on. Its setup code is never used, because the restored database already has a workspace.
4. Copy the backup archive to the new server's `/opt/demo-platform/backups/` and restore it, as in [step 9](#9-back-up-and-restore).
5. Change the A (and AAAA) record to the new server's address.
6. **Unconfirmed:** Caddy may be waiting between retries after its failed attempts while the record still pointed at the old server. Restarting it makes it try again now, from a root shell in `/opt/demo-platform`:

```sh
docker compose restart caddy
```

7. When `curl https://tours.example.com/healthz` answers from the new server and Mythicshot connects, uninstall the old server as in [step 11](#11-uninstall).

Lowering the record's TTL a day before the move makes the change reach everyone sooner.

## 11. Uninstall

```sh
sudo bash install.sh uninstall
```

It asks "Stop and remove the containers? [y/N]" (`--yes` answers for you) and runs `docker compose down --remove-orphans`, which removes the containers and the stack's network. It then prints where the data, the settings and the backups are.

What stays on the server:

| What | Where |
|---|---|
| The data folder: database, drafts and published images | `/opt/demo-platform/data`, or the folder you chose |
| The settings, with the setup code and, on the tunnel route, the tunnel token | `/opt/demo-platform/.env` |
| The backups | `/opt/demo-platform/backups` |
| The stack file, the Caddyfile and any `.bak-*` copies | `/opt/demo-platform` |
| The certificate and its key, and Caddy's settings | `/opt/demo-platform/caddy-data` and `/opt/demo-platform/caddy-config` |
| The app and Caddy images, and the cloudflared image on the tunnel route | Docker's image store |
| Docker itself, its apt source and key | as installed by Docker's packages |

Run `sudo bash install.sh` again to start the platform on the same data.

To also delete the data folder, add `--delete-data`. The script then asks you to type the domain name, and `--yes` does not skip that. It refuses if the folder holds anything the platform did not make.

```sh
sudo bash install.sh uninstall --delete-data
```

> [!WARNING]
> `--delete-data` permanently removes every tour, image and token on the server; make and copy off a backup first.

To start again from scratch after deleting the data, move the old settings aside first, or the script keeps asking for the deleted folder:

```sh
sudo mv /opt/demo-platform/.env /opt/demo-platform/.env.old
```

To remove Docker too, follow the uninstall section of [Docker's Debian page](https://docs.docker.com/engine/install/debian/).

## Behind a Cloudflare Tunnel

Use this route when the server cannot take connections from the internet: a server at home, behind a router you cannot or do not want to forward ports on. A small program in the stack, cloudflared, connects out from the server to Cloudflare, and visitors reach the platform through that connection. It replaces [step 2](#2-create-the-dns-record), [step 3](#3-open-ports-80-and-443) and [step 6](#6-the-https-certificate); every other step stays as written.

**Unconfirmed:** this route has not yet been run against a real tunnel. The stack, with a made-up token and no way out to the internet, is checked by this repository's tests; the parts that need Cloudflare are listed under [What is not yet confirmed](#what-is-not-yet-confirmed).

| | Direct route | Tunnel route |
|---|---|---|
| Ports open to the server | 80 and 443 | none |
| Ports the stack publishes on the server | 80 and 443 | none |
| HTTPS certificate | Caddy gets it on the server | Cloudflare's, at its edge; none on the server |
| DNS record | an A record you create, at any DNS provider | managed at Cloudflare, which must run the domain's DNS |
| Containers | app, caddy | app, caddy, cloudflared |
| Secrets in `.env` | the setup code | the setup code and the tunnel token |

### What to have ready for the tunnel

1. Items 1, 4 and 5 of [step 1](#1-what-to-have-ready): the Debian server, root access, and a computer to build the image on.
2. A Cloudflare account with your domain added to it, so that Cloudflare runs the domain's DNS. [Cloudflare's tunnel page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) names this as the prerequisite for a published application.
3. Outbound connections from the server to Cloudflare on port 7844, TCP and UDP, as [Cloudflare's firewall page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/) lists. A home router normally allows this already. No inbound port is needed.

**How to tell it worked:** the domain shows as active in Cloudflare's dashboard, and on the server `grep PRETTY_NAME /etc/os-release` names Debian 13 or 12.

### Create the tunnel and copy its token

These are the steps of [Cloudflare's tunnel page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) as read on 2026-11-17; the dashboard's wording may have changed since.

1. In Cloudflare's dashboard, go to Networking › Tunnels and select Create a tunnel.
2. Enter a name for the tunnel, such as `tours`, and select Create Tunnel.
3. The dashboard shows an installation command for the operating system you pick. Do not run it: `install.sh` runs cloudflared for you. The command ends in one long word that starts with `eyJ`. That word is the tunnel token.
4. Copy the token into your password manager. To see it again later, [Cloudflare's token page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/) says to open the tunnel, and on its Overview tab select Add a replica, which shows the installation command again.

> [!WARNING]
> The tunnel token works like a password: Cloudflare's page says anyone who has it can run the tunnel, and so receive the visitors meant for your platform. Never paste it into a chat, a ticket or a command line.

**How to tell it worked:** the tunnel is listed under Networking › Tunnels. It shows as not connected until [the installer has run](#run-installsh-with---tunnel).

### Add the published application

1. Go to Networking › Tunnels and select your tunnel.
2. On the Routes tab, select Add route, then choose Published application.
3. Enter the subdomain, such as `tours`, and pick your domain from the Domain list, so that the hostname reads `tours.example.com`.
4. In Service URL, enter exactly this:

```text
http://caddy:80
```

5. Select Add route.

The service URL is an address inside the stack, not on your network: `caddy` is the name of the stack's front server on the stack's own private network, where cloudflared runs too. It is plain HTTP on purpose; see [How the tunnel route is wired](#how-the-tunnel-route-is-wired). The installer prints the same hostname and service URL at the end of every run.

Leave the route's other settings as they are. In particular leave HTTP Host Header empty: the platform's setup wizard needs the hostname the visitor typed.

**Unconfirmed:** Cloudflare's pages do not say in words that adding the published application also creates the hostname's DNS record. If `tours.example.com` does not resolve afterwards, create the record by hand as [Cloudflare's DNS page for tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/) describes.

**How to tell it worked:** the route is listed on the tunnel's Routes tab with the hostname and the service URL above.

### Run install.sh with --tunnel

1. Build the image and copy it and the script to the server, as in [step 4](#4-build-the-app-image-and-copy-it-to-the-server).
2. Follow [step 5](#5-run-installsh), adding `--tunnel` to each run of the script.

```sh
sudo bash install.sh install --tunnel
```

3. At `Domain name for the platform`, enter the hostname of the published application, such as `tours.example.com`. It must be the same name: the stack answers for that hostname only.
4. At `Tunnel token from the Cloudflare dashboard (what you paste is not shown):`, paste the token and press Enter. Nothing appears while you paste. Pasting the whole installation command works too: the script keeps its last word. If what you paste has a line break in it, the script takes none of it, says so and asks again; paste the token as one line.
5. Answer the data folder question and `Continue?` as on the direct route.

The script checks only the token's shape: one word of 100 to 2,048 letters, digits and `+ / - _ =` that starts with `eyJ`. Whether Cloudflare accepts it shows when the stack starts. The script never prints the token, never puts it on a command line and writes it to `/opt/demo-platform/.env` only.

If Docker was not installed yet, the first run installs it and stops, as [step 5](#5-run-installsh) describes. Nothing is written by that run, so the next run asks its questions, the token included, again.

### If the tunnel does not connect

A token of the right shape can still be wrong: cut off, from a deleted tunnel, or refreshed since you copied it. The run then fails after showing cloudflared's log lines and what they mean. Run the script again, without any option:

```sh
sudo bash install.sh
```

Until the tunnel has connected once, every run asks for the token again and nothing else: paste the right one, or press Enter to keep the one already stored when the token was not the cause. A token in the `TUNNEL_TOKEN` environment variable is taken instead of asking. The run starts by saying so: `The last install here did not finish: its tunnel never connected to Cloudflare, so the site cannot be reached yet`.

While the tunnel has never connected there is no working token to protect, so the token you give is saved to `.env` before the stack starts and cloudflared always runs on the token `.env` holds. If it does not connect, the message ends with the command to run next. If you give no usable answer, `.env` is left as it was.

The script marks this state with the file `/opt/demo-platform/.tunnel-pending`. Only an install run whose tunnel connects removes it. `sudo bash install.sh update` leaves the file where it is, whether or not the update itself works: it says at the start that the install was never finished, and its last line, `this install is still not finished`, repeats that `sudo bash install.sh install` is the command that finishes it.

By the time cloudflared fails, the app has usually started and written its database, so the failed run keeps `/opt/demo-platform/.env` and the data folder. The setup code in it has not been shown to anyone: it is printed once, at the end of the first run whose tunnel connects.

To skip the token prompt, for example when a script feeds the other answers, put the token in the `TUNNEL_TOKEN` environment variable of the root shell that runs the installer. Read it at a hidden prompt so that it reaches neither the screen nor the shell's history, and remove it afterwards.

```sh
sudo -i
```

```sh
read -rs TUNNEL_TOKEN
```

```sh
export TUNNEL_TOKEN
```

```sh
bash /home/you/install.sh install --tunnel
```

```sh
unset TUNNEL_TOKEN
```

> [!WARNING]
> Do not type the token after `TUNNEL_TOKEN=` on a command line: the line stays in the shell's history and shows in the server's process list while it runs.

### What the tunnel route prints

At the end of the first run whose tunnel connects:

```text
The platform is running and its tunnel is connected to Cloudflare.

In Cloudflare's dashboard, the tunnel needs one published application (skip this if it is there already):
  Hostname:     tours.example.com
  Service URL:  http://caddy:80
No port is published on this server; it is reached only through the tunnel, at https://tours.example.com

  Open:        https://tours.example.com/setup
  Setup code:  <your setup code>
```

The setup code is printed this once, as on the direct route. The token is never printed. Go on with [step 7](#7-the-setup-wizard-and-mythicshot).

**How to tell it worked:** on the server, this shows three containers and both the app and the tunnel `healthy`. For the tunnel, healthy means cloudflared holds a connection to Cloudflare.

```sh
sudo bash install.sh status
```

From your computer, this prints `{"ok":true}`.

```sh
curl https://tours.example.com/healthz
```

On the server, this prints nothing, because nothing listens on ports 80 and 443.

```sh
sudo ss -Hltn 'sport = :80 or sport = :443'
```

### How the tunnel route is wired

A request travels: visitor, over HTTPS, to Cloudflare; down the tunnel to cloudflared; over plain HTTP to Caddy at `caddy:80`; to the app at `app:3000`. The last two hops never leave the stack's private network on the server, and no container publishes a port.

cloudflared talks to Caddy and not straight to the app, for three reasons.

1. The hostname check stays in the stack. Caddy answers only for the hostname in `DOMAIN` (with [two addresses](#two-addresses), also for the one in `APP_DOMAIN`), as it does on the direct route. A request for any other hostname the tunnel is given does not reach the app.
2. The same headers are set on both routes. Caddy adds the one-week HSTS header, so browsers keep to HTTPS for the platform's address. It also sends a visitor who arrived at Cloudflare over plain HTTP on to HTTPS, using the `X-Forwarded-Proto` header that, by [Cloudflare's headers page](https://developers.cloudflare.com/fundamentals/reference/http-headers/), Cloudflare sets itself and overwrites if a visitor sent one.
3. The app is the same on both routes. It has exactly one neighbour, Caddy, and needs no setting that says which route is in use.

The hop from cloudflared to Caddy is plain HTTP because it stays inside one machine: a certificate there would protect nothing, and with no open port Caddy could not get one from a certificate authority anyway. Caddy's automatic HTTPS is switched off on this route.

What the app sees:

- The `Host` header is the hostname the visitor typed. cloudflared replaces it only when a route's HTTP Host Header setting is filled in, which [Cloudflare's origin settings page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/) lists as empty by default, and Caddy passes it on unchanged. The setup wizard's same-origin check compares it with the page's own address, so it keeps working. With [two addresses](#two-addresses), the `Host` header is also the one thing that decides which of the two a request is for.
- No forwarded address, scheme or host name is trusted, because the app still reads none: not `X-Forwarded-For`, not `X-Forwarded-Proto`, not `X-Forwarded-Host`, `Forwarded` or `X-Original-Host`, not Cloudflare's own visitor-address header. It sets no cookies and builds no links from such headers; the one address it builds with two addresses, the redirect from the app address to the tours address, takes its host name from the settings. A visitor who forges one of them gains nothing. Caddy, as on the direct route, does not trust the forwarded headers it receives and writes its own for the app.

The tunnel token reaches cloudflared as the `TUNNEL_TOKEN` environment variable, which [Cloudflare's run parameters page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/run-parameters/) gives as the variable for the token. Docker Compose fills it in from `.env` when it starts the container. The token is not in `docker-compose.yml`, not on cloudflared's command line, which is `tunnel --no-autoupdate --metrics 127.0.0.1:20241 run`, and not in the environment of the app or of Caddy. `--no-autoupdate` is the same page's parameter that stops cloudflared from updating itself: the image is pinned by its digest, and [step 8](#8-update) is how it changes.

### The tunnel token

| Where | Holds the token? |
|---|---|
| `/opt/demo-platform/.env` (mode 600, root only) | Yes. It is the only file that does. |
| The cloudflared container's environment, which `docker inspect` shows to root | Yes |
| `docker-compose.yml`, the Caddyfile and their `.bak-*` copies | No |
| Backup archives in `/opt/demo-platform/backups` | No: `.env` is not in them |
| The script's output, a dry run's output and `sudo bash install.sh status` | No |
| cloudflared's log lines, as the script shows them when a start fails | No: the script masks the token in them before printing |

> [!WARNING]
> Anyone who can read `/opt/demo-platform/.env`, or run `docker` on the server, can read the token. Keep both to root, and never copy `.env` into a backup, a ticket or a repository.

Because no backup holds the token, keep it in your password manager, or read it from the dashboard again as in [Create the tunnel and copy its token](#create-the-tunnel-and-copy-its-token).

To replace the token on a working install, for example after refreshing it in the dashboard, run the installer with `--new-token`. [Cloudflare's token page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/) says that after a refresh cloudflared can no longer make new connections with the old token.

```sh
sudo bash install.sh install --new-token
```

It asks for the token at the same hidden prompt, with the same shape check (Enter keeps the stored one), or takes it from the `TUNNEL_TOKEN` environment variable. It then restarts cloudflared with the new token while `.env` still holds the old one, and waits up to 120 seconds for the tunnel to connect.

> [!WARNING]
> Trying a new token restarts the tunnel, so the site cannot be reached for a moment, and for up to about two minutes if the new token is wrong.

Only once the tunnel has connected does the script rewrite the `TUNNEL_TOKEN` line of `.env`, and it does so at once, before any later step of the run. It keeps no copy of the old file, and the setup code and every other setting stay as they are. The new file is written next to `.env` with the same mode, 600, and takes its place in one step.

If the tunnel does not connect with the new token, or the run is stopped before the token is saved (Ctrl-C, a closed terminal, a failed step), the new token is not saved. `.env` still holds the previous token, and the script prints `the new token was not saved` with the command to try again. The site is started again on the previous token; it was out of reach while the new one was tried. If the platform was not running before the run, for example after `uninstall`, it is stopped again instead. No answer, or three answers that are not tokens, changes nothing and restarts nothing.

A token that was refreshed in the dashboard no longer makes new connections, so if the old token was refreshed, the site stays out of reach after a failed try until a run with the current token succeeds.

A run that is killed outright can leave a file named `.env.new.` and six more characters next to `.env`. The next run removes it without reading it.

`--new-token` needs a tunnel install to work on. On a server with no install it stops before asking anything, with `nothing is installed on this machine` and the command that installs in tunnel mode, `sudo bash install.sh install --tunnel`. On a direct install it stops the same way and says the install is not in tunnel mode.

Without `--new-token`, a run on an install whose tunnel has connected never changes the token, whatever the environment holds.

When you [move to a new server](#10-move-to-a-new-server) on the tunnel route, there is no DNS record to change: install on the new server with the same token and hostname, and restore the backup. Uninstall the old server before you start the new one. While both run, they are two copies of one tunnel, and [Cloudflare's page on tunnel replicas](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/) says a request goes to the geographically closest one, so visitors would land on either server.

After [uninstalling](#11-uninstall), the tunnel and its route stay in your Cloudflare account, and the token in `.env` still runs the tunnel. Delete the tunnel in the dashboard when you no longer need it.

### Switch between the direct and the tunnel route

The route is recorded in `/opt/demo-platform/.env`: the line `DEPLOY_MODE=tunnel` means the tunnel route, and no such line means the direct route. Every later run, and `update`, `backup`, `status` and `uninstall`, read it from there, so `--tunnel` is needed only on the first install.

The script never switches an existing install by itself. `--tunnel` on a direct install, or `--direct` on a tunnel install, stops with the steps below and changes nothing. The switch changes what is open to the internet, so it is done by hand. The data, the setup code, the API token and the backups are all kept.

From direct to tunnel:

1. Create the tunnel and its published application, as in the sections above.
2. Stop the stack. The data folder, `.env` and the backups stay.

```sh
sudo bash install.sh uninstall
```

3. Open a root shell and edit `.env`.

```sh
sudo -i
```

```sh
nano /opt/demo-platform/.env
```

4. Add these two lines, with your token in place of the placeholder, and save. The `ACME_EMAIL` line may stay; the tunnel route ignores it.

```text
DEPLOY_MODE=tunnel
TUNNEL_TOKEN=<your tunnel token>
```

5. Start the platform. The script saves the old stack file and Caddyfile as `.bak-<date>-<time>` and writes the tunnel ones.

```sh
bash /home/you/install.sh install
```

6. Close ports 80 and 443 on the firewall or router, and remove the old A record if Cloudflare did not replace it. The certificate in `/opt/demo-platform/caddy-data` is no longer used.

From tunnel to direct:

1. Do [step 2](#2-create-the-dns-record) and [step 3](#3-open-ports-80-and-443) for the server.
2. Stop the stack with `sudo bash install.sh uninstall`.
3. In a root shell, edit `/opt/demo-platform/.env`: remove the `DEPLOY_MODE` and `TUNNEL_TOKEN` lines, and add a line `ACME_EMAIL=admin@example.com` with your own address if there is none.
4. Run `bash /home/you/install.sh install`. It checks the ports and the DNS record again, as on a first direct install.
5. Delete the tunnel in Cloudflare's dashboard, so the token you removed opens nothing.

If you edit `.env` while the stack is still running, the script stops with "the running stack was written for" the other route and changes nothing. Put `.env` back as it was, run the uninstall, and make the edit again.

**How to tell it worked:** `sudo bash install.sh status` shows the containers of the new route, three with cloudflared or two without, and `curl https://tours.example.com/healthz` prints `{"ok":true}`.

### What is not yet confirmed

Each of these needs a real tunnel, which the tests in this repository do not have.

1. **Unconfirmed:** that cloudflared connects with a real token and turns `healthy`. Its health check is cloudflared's own `ready` command, which was seen to fail while nothing is connected; that it succeeds once connected is from cloudflared's source code.
2. **Unconfirmed:** that a request arrives at Caddy with the visitor's `Host` header. This follows from Cloudflare's origin settings page and from cloudflared's source code. The tests send such a request to `caddy:80` themselves and the wizard's check passes.
3. **Unconfirmed:** that the `X-Forwarded-Proto` header Cloudflare sets reaches Caddy through the tunnel, so that a visitor on plain HTTP is sent on to HTTPS. If it does not, such a visitor is served over plain HTTP between the browser and Cloudflare.
4. **Unconfirmed:** the words Cloudflare adds when it refuses a well-formed token. The script recognises cloudflared's own line, `Register tunnel error from server side`, and shows whatever follows it.
5. **Unconfirmed:** the dashboard steps, which are taken from Cloudflare's pages and not from a session in the dashboard.

## Two addresses

The platform can answer on two names instead of one: the address of the tours, `tours.example.com`, and a second address for the app, `app.example.com`. This is optional, and every step above sets up one address. What each address answers is in [One address or two](../README.md#one-address-or-two) in the README: tours and their pictures on the tours address only, the token API on both, and an empty answer with status 421 for any other name.

**Unconfirmed:** nothing in this section has been run on a real server or against a real tunnel. The script's part is checked by this repository's tests with a stand-in for Docker, and the app's part by tests that send requests under both names.

On this route the second address is one setting: the line `APP_DOMAIN` in `/opt/demo-platform/.env`. `DOMAIN` stays what it is and is from then on the address of the tours. From the two, the stack gives the app its own settings, `TOURS_HOST` and `APP_HOST`, and the Caddyfile the script writes answers for both names. A `TOURS_HOST` or `APP_HOST` line written into `.env` by hand has no effect, and the script warns about it: "has a TOURS_HOST or APP_HOST line, which has no effect on an install made by this script".

> [!WARNING]
> Never change the `DOMAIN` line to make room for a second address: it is the name every published tour link and Mythicshot use, and the app address is always the new name.

The way the stack file derives the two settings was checked on Docker Compose 5.5.1, not on the oldest version the script accepts, so the script checks it itself on whatever Compose is installed. It validates the new stack file before it replaces anything, then has Compose fill the file in and looks at what the app would get as `TOURS_HOST` and `APP_HOST`: both empty with one address, the two names with two. A Compose that cannot read the file, or fills the two settings in differently, stops the run with nothing changed and says "This version of Docker Compose does not read the two-address settings in the stack file the way this script expects"; update Docker Compose and run `install` again.

### What to have ready for two addresses

1. A version of the platform that knows two addresses: the app image and `install.sh` from the same, current copy of this repository. An older app ignores the two settings, and the script's check then fails.
2. A second hostname that nothing else uses, such as `app.example.com`.
3. On the direct route, a DNS record for it that points at the same server, created as in [step 2](#2-create-the-dns-record). The open ports stay the same two, and Caddy gets a certificate for each name by itself, as in [step 6](#6-the-https-certificate).

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `app` (the part before your domain) | `203.0.113.10` | the provider's default |
| AAAA (only if the server has a public IPv6 address) | `app` | `2001:db8::10` | the provider's default |

4. On the tunnel route, no DNS record of your own: add a second published application to the same tunnel instead, as in [Add the published application](#add-the-published-application), with the subdomain `app` and the same service URL, `http://caddy:80`. The tunnel then has a published application for each of the two names.

> [!WARNING]
> On the tunnel route, leave HTTP Host Header empty on both published applications: a name filled in there reaches the platform in place of the one the visitor typed, and that address is then refused or answered in the wrong role.

**How to tell it worked:** on the direct route, `getent ahosts app.example.com` on the server prints the server's address. On the tunnel route, the tunnel's Routes tab lists both hostnames with the same service URL.

### On a first install

Follow [step 5](#5-run-installsh) and add the option to every run of the script.

```sh
sudo bash install.sh install --app-domain=app.example.com
```

On the tunnel route, add it beside `--tunnel`.

```sh
sudo bash install.sh install --tunnel --app-domain=app.example.com
```

1. Answer `Domain name for the platform` with the tours address, `tours.example.com`, as before. The option names the other one.
2. The option must be a hostname in lowercase that differs from the tours address. Otherwise the script stops before it writes anything, for example with "the app address must be a different name than the tours address". With any command but `install` it stops with `--app-domain goes only with install`.
3. Check the summary before `Continue?`: it shows both names.

The script then writes `APP_DOMAIN` into the new `.env`, checks the DNS record of both names on the direct route, writes the Caddyfile for two addresses, starts the stack and checks both addresses, as described under [The check of both addresses](#the-check-of-both-addresses). After the usual closing lines it prints one more.

```text
Tours are at https://tours.example.com; the app address is https://app.example.com. Mythicshot keeps using https://tours.example.com.
```

On the tunnel route the closing lines name both hostnames, under "the tunnel needs two published applications, one for each address".

Open the setup wizard on the tours address, `https://tours.example.com/setup`, and give Mythicshot that address, as in [step 7](#7-the-setup-wizard-and-mythicshot). The wizard is not on the app address.

### On an install that has one address today

The script never rewrites an existing `.env`. Given `--app-domain=app.example.com` on an existing install, it stops with nothing changed and names the line to add: "this install's .env does not hold APP_DOMAIN=app.example.com, and install.sh does not change that file. To add the second address, add that line to /opt/demo-platform/.env as root, then run: sudo bash install.sh install". So the line is added by hand, in this order. Steps 1 to 3 change nothing about how the site answers.

1. Update to the current version first, still with one address: load the new image and run `sudo bash install.sh update` with the new `install.sh`, as in [step 8](#8-update), and see that `sudo bash install.sh status` shows the app `healthy`.
2. Create the DNS record or the second published application, as in [What to have ready for two addresses](#what-to-have-ready-for-two-addresses).
3. Make a backup, as in [step 9](#9-back-up-and-restore).

```sh
sudo bash install.sh backup
```

4. Open a root shell and edit `.env`.

```sh
sudo -i
```

```sh
nano /opt/demo-platform/.env
```

5. Add this one line, with your own name in lowercase, and save. Change nothing else.

```text
APP_DOMAIN=app.example.com
```

> [!WARNING]
> Step 6 restarts the app and Caddy, so the site does not answer for a moment; do it when that is acceptable, and check both addresses right after it.

6. Run the install again. It reads the line, saves the old Caddyfile (and the stack file, if it is an older one) as `.bak-<date>-<time>`, writes the one for two addresses, starts the app with its two settings, restarts Caddy and checks both addresses.

```sh
bash /home/you/install.sh install
```

If the line holds something that cannot be a second address, the run stops first, with `has an APP_DOMAIN that is not a valid host name or is the same as DOMAIN`, and nothing is changed. If the start fails after `APP_DOMAIN` was added by hand, the script puts the old Caddyfile back but never changes `.env`, so remove the `APP_DOMAIN` line (or put the earlier one back) and run `install` again.

`sudo bash install.sh update` writes no file, so it never moves an install between one address and two. When `.env` and the Caddyfile disagree, it stops with nothing changed, saying either "but the Caddyfile here was written for one address, and update does not rewrite it" or "but the Caddyfile here was written for two addresses, and update does not rewrite it". Run `sudo bash install.sh install`, which writes the Caddyfile that matches `.env`.

### The check of both addresses

After every start, by `install` and by `update`, the script asks each address for `/healthz` through whatever is in front of the platform and requires the role the platform reports to be that address's own. When it passes, it says `tours.example.com is the platform's tours address` and `app.example.com is the platform's app address`.

| What the script says | What it means | What to do |
|---|---|---|
| `answered, but the platform running here is older than two addresses` | The address answered without any role: the app is from before two addresses, or the request reached it under a name that is neither of the two | Load the current image and run `sudo bash install.sh update`. If it is current already, something in front of the platform changes the `Host` header: see the row below. |
| `answered, but the platform does not see it as its` tours address, or its app address | The address answered in the other role | Check `DOMAIN` and `APP_DOMAIN` in `.env`, "and that nothing in front of the platform changes the Host header." On the tunnel route, check that each published application has its own hostname and an empty HTTP Host Header. |
| `was not asked` | Direct route only: the name does not resolve to an address of this server, not yet or because the server is behind a router | A warning, not a failure. Open the address in a browser and look for the role yourself. |
| `did not answer` | The certificate for the name is not there yet, or the tunnel has no published application for it | A warning, not a failure. Check the ports or the route, then run `sudo bash install.sh status`. |

A wrong role ends the run with exit code 1. Nothing is undone: the install stays as it is, and a first install has printed its setup code before the check. `sudo bash install.sh status` repeats the check, asking each address once, and ends with exit code 1 on a wrong role too. Without `curl` on the server the script asks nothing and says so.

**How to tell it worked:** from your computer, this prints `{"ok":true,"address":"tours"}`.

```sh
curl https://tours.example.com/healthz
```

And this prints `{"ok":true,"address":"app"}`.

```sh
curl https://app.example.com/healthz
```

### Go back to one address

1. In a root shell, open `/opt/demo-platform/.env` in an editor, remove the `APP_DOMAIN` line and save, as in steps 4 and 5 above.
2. Leave the root shell with `exit` and run the install again. It saves the Caddyfile for two addresses as `.bak-<date>-<time>`, writes the one for one address and starts the app without its two settings, so it answers on every name that reaches it, as before.

```sh
sudo bash install.sh install
```

3. Remove the DNS record or the published application of `app.example.com` when you no longer want it. Its certificate in `/opt/demo-platform/caddy-data` is then no longer used.

The tours address is the same name before and after, so tour links that are already out there and Mythicshot keep working both ways.

**How to tell it worked:** `curl https://tours.example.com/healthz` prints `{"ok":true}` again, without an address, and `sudo bash install.sh status` shows no app address.

### Two addresses on the other routes

The server guides in [docs/hosting](hosting/README.md) install through this runbook, so this section holds for them as it is. The [Fly.io guide](hosting/fly.md) does not use `install.sh`, and its steps for two addresses wait for a later version. Shared cPanel hosting has its own steps, in [A second address for the app](hosting/cpanel.md#14-a-second-address-for-the-app), and so has Cloudflare, in [Two addresses](runbook-cloudflare.md#two-addresses) of that runbook.

## Troubleshooting by symptom

| Symptom | Likely cause | What to do |
|---|---|---|
| `ERROR: this needs root` | Run without `sudo` | Run `sudo bash install.sh`. |
| `ERROR: this system is ... Use --force to try anyway.` | Not Debian 13 or 12 | Use Debian 13. `--force` tries anyway, untested. |
| `Docker is installed as a snap` | A snap of Docker cannot use `/opt/demo-platform` | Remove the snap (its images and containers go with it) and run the script again. |
| `these packages conflict with Docker's own` | Debian's own Docker packages are installed | Remove the packages it names, as Docker's page says, and run again. |
| `Docker Compose ... is too old` | Compose older than 2.20.0 | Update Docker from Docker's apt repository. |
| `Docker is installed but its daemon does not answer` | The Docker service is stopped | `sudo systemctl start docker`, then run again. |
| `the app image demo-platform:latest is not on this server` | The image was not loaded | Load it with `sudo docker load -i demo-platform.tar` ([step 4](#4-build-the-app-image-and-copy-it-to-the-server)). |
| `another program is listening on the ports above` | Another web server holds port 80 or 443 | Stop it or move it to other ports, then run again. |
| `does not resolve yet` or `is not an address of this server` | The DNS record is missing, wrong or not visible yet | Fix the record ([step 2](#2-create-the-dns-record)). The install goes on and the certificate follows. |
| `another run of this script is in progress` | Two runs at once | Wait for the other run to finish. |
| `the data folder ... recorded in .env is missing` | The disk holding it is not mounted, or it was deleted | Mount it. To start over with an empty platform, move `.env` aside as in [step 11](#11-uninstall). |
| `the platform did not start` | The app or Caddy failed to start | The script prints the app's last log lines. From a root shell in `/opt/demo-platform`, `docker compose logs app` shows more. |
| The app log says `data folder /data is missing or not writable` | The data folder is not owned by id 1001 | `sudo chown -R 1001:1001 /opt/demo-platform/data`, then `sudo bash install.sh`. |
| The browser shows a certificate error | Caddy has no certificate yet | Check [step 6](#6-the-https-certificate). |
| `/setup` shows `{"error":"not_found"}` | Setup is already finished, or the code is missing or too short | If nobody holds the token, see [If the token was lost](#if-the-token-was-lost-before-anyone-saved-it). |
| "That setup code isn't right." | The code typed differs from `SETUP_CODE` | Read it again with `grep '^SETUP_CODE=' .env` ([step 7](#the-setup-code)). |
| "This site has already been set up." | Someone finished setup first, possibly in another tab | If nobody holds the token, see [If the token was lost](#if-the-token-was-lost-before-anyone-saved-it). |
| "Something went wrong. Try again." on a setup step | The page's address differs from the one the browser sent, or the server failed | Open the wizard on `https://tours.example.com/setup` itself, not through another address. |
| Mythicshot's Test connection fails | Wrong address or token, or no certificate yet | Check the address is `https://tours.example.com`, then the token, then [step 6](#6-the-https-certificate). |
| `this install is in direct mode` or `this install is in tunnel mode` | `--tunnel` or `--direct` was given against the route recorded in `.env` | Leave the option out, or switch by hand: [Switch between the direct and the tunnel route](#switch-between-the-direct-and-the-tunnel-route). |
| `the running stack was written for` the other mode | `.env` was edited to the other route while the stack runs | Put `.env` back as it was, run `sudo bash install.sh uninstall`, make the edit again, then run `sudo bash install.sh`. |
| `that is not a tunnel token` | What was pasted is not one word starting with `eyJ` | Copy the token again, to its very end ([Create the tunnel and copy its token](#create-the-tunnel-and-copy-its-token)). |
| Tunnel route: `cloudflared could not read the token`, after its log line `Provided Tunnel token is not valid.` | The token has the right shape but is cut off or altered | Copy it again from the dashboard. If the tunnel has never connected, run `sudo bash install.sh` again: it asks for the token again ([If the tunnel does not connect](#if-the-tunnel-does-not-connect)). On an install that worked before, run `sudo bash install.sh install --new-token`. |
| Tunnel route: `Cloudflare refused the tunnel's registration` | The tunnel was deleted, or its token was refreshed after you copied it | Copy the current token from the tunnel's page, then as in the row above: run the script again, with `--new-token` if the install worked before. |
| `what was pasted had more than one line` | The token was copied with a line break in it | Paste it as one line. Nothing of the paste was kept or shown. |
| `--new-token is for an install in tunnel mode` | `--new-token` on a direct install | Leave the option out. Nothing was changed. |
| `nothing is installed on this machine` | `--new-token` on a server that has no install | Nothing was changed. Install first: `sudo bash install.sh install --tunnel`. |
| `the new token was not saved` | With `--new-token`, the tunnel did not connect on the new token, or the run was stopped before it had | The site is started again on the previous token, which is still in `.env`; it was out of reach while the new one was tried. Copy the current token from the tunnel's page and run `sudo bash install.sh install --new-token` again ([The tunnel token](#the-tunnel-token)). |
| `this install is still not finished`, at the end of `update` | The tunnel had never connected when the platform was installed | Run `sudo bash install.sh install`: it asks for the token again and prints the setup code once the tunnel connects ([If the tunnel does not connect](#if-the-tunnel-does-not-connect)). |
| Tunnel route: `cloudflared could not reach Cloudflare` | Outbound port 7844 or DNS is blocked on the server's network | Allow outbound TCP and UDP port 7844 ([What to have ready for the tunnel](#what-to-have-ready-for-the-tunnel)), then run again. |
| Tunnel route: the tunnel is `healthy` but the address shows a Cloudflare error page | The tunnel has no published application for the hostname, or its service URL is wrong | Check the route: hostname `tours.example.com`, service URL `http://caddy:80` ([Add the published application](#add-the-published-application)). |
| Tunnel route: the address shows an empty page | The hostname of the published application differs from `DOMAIN` in `.env` or, for the second of two addresses, from `APP_DOMAIN` | Make the two the same: change the route's hostname in the dashboard to the one in `.env`. |
| `this install's .env does not hold APP_DOMAIN=app.example.com` | `--app-domain=<name>` was given on an existing install, whose `.env` the script never rewrites | Nothing was changed. Add the line by hand: [On an install that has one address today](#on-an-install-that-has-one-address-today). |
| `has an APP_DOMAIN that is not a valid host name or is the same as DOMAIN` | The `APP_DOMAIN` line in `.env` is mistyped, or names the tours address | Nothing was changed. Correct the line, or remove it for one address, then run `sudo bash install.sh`. |
| A warning that `.env` has a `TOURS_HOST` or `APP_HOST` line | The line was added by hand; on this route it has no effect | Remove it. The second address is the `APP_DOMAIN` line only ([Two addresses](#two-addresses)). |
| `the Caddyfile here was written for` one address, or for two addresses, at the start of `update` | `.env` and the Caddyfile disagree about the second address, and `update` writes no file | Nothing was changed. Run `sudo bash install.sh install`. |
| `the platform running here is older than two addresses` | The app image is from before two addresses, or the `Host` header is changed on the way | See [The check of both addresses](#the-check-of-both-addresses). |
| `the platform does not see it as its` tours or app address | An address reaches the platform under the other name | See [The check of both addresses](#the-check-of-both-addresses). |
| With two addresses, `/setup` on the app address shows `{"error":"not_found"}` | The setup wizard is on the tours address only | Open `https://tours.example.com/setup`. |

## Pages this runbook relies on

- [Debian releases](https://www.debian.org/releases/), for the current stable and oldstable releases.
- [Install Docker Engine on Debian](https://docs.docker.com/engine/install/debian/), for the supported releases, the apt repository, the conflicting packages, the firewall warning and uninstalling.
- [docker image save](https://docs.docker.com/reference/cli/docker/image/save/) and [docker image load](https://docs.docker.com/reference/cli/docker/image/load/), for moving the image as a file.
- [docker buildx build](https://docs.docker.com/reference/cli/docker/buildx/build/), for building for another architecture.
- [docker compose down](https://docs.docker.com/reference/cli/docker/compose/down/), for what uninstall removes.
- [Caddy: Automatic HTTPS](https://caddyserver.com/docs/automatic-https), for what the certificate needs and how failures are retried.
- [Cloudflare: Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/), for creating the tunnel, the installation command that holds the token, and adding a published application with its service URL.
- [Cloudflare: Tunnel permissions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/), for what the token allows, where the dashboard shows it again and what refreshing it does.
- [Cloudflare: Run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/run-parameters/), for the token's environment variable, `--no-autoupdate` and `--metrics`.
- [Cloudflare: Origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/), for the HTTP Host Header setting and its empty default.
- [Cloudflare: Tunnel with firewall](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/), for outbound port 7844 and needing no inbound port.
- [Cloudflare: Tunnel availability](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/), for how requests are shared between two copies of one tunnel.
- [Cloudflare: DNS records for tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/), for creating the hostname's record by hand.
- [Cloudflare: HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/), for the forwarded headers Cloudflare sets and which of them it overwrites.

The script itself is [deploy/install.sh](../deploy/install.sh), and the stack it writes is [deploy/docker-compose.yml](../deploy/docker-compose.yml) with [deploy/caddy/Caddyfile](../deploy/caddy/Caddyfile) on the direct route, or [deploy/tunnel/docker-compose.yml](../deploy/tunnel/docker-compose.yml) with [deploy/tunnel/caddy/Caddyfile](../deploy/tunnel/caddy/Caddyfile) on the tunnel route. With two addresses the Caddyfile is [deploy/caddy/Caddyfile.two](../deploy/caddy/Caddyfile.two) or [deploy/tunnel/caddy/Caddyfile.two](../deploy/tunnel/caddy/Caddyfile.two) instead.
