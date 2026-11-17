# Runbook: Docker on Debian

> [!WARNING]
> Draft: this runbook has not yet been run end to end on a real server. It is written from the code in this repository and from the vendors' documentation. Steps that could not be confirmed from either are marked **Unconfirmed**.

This runbook puts the platform on one Debian server with any DNS provider. `install.sh` installs Docker, writes the settings, starts the app behind Caddy and gets the HTTPS certificate. The DNS record, the firewall, the domain itself, backups kept off the server and keeping Debian patched stay yours.

Examples use `tours.example.com` for the platform's address, `203.0.113.10` and `2001:db8::10` for the server's addresses, and `you` for your login on the server. Put your own in their place.

## Contents

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
- [Troubleshooting by symptom](#troubleshooting-by-symptom)
- [Pages this runbook relies on](#pages-this-runbook-relies-on)

## 1. What to have ready

1. A server running Debian 13 "trixie", the [current stable release](https://www.debian.org/releases/). Debian 12 "bookworm" also works: the script prints a notice and goes on. Any other system is refused unless you add `--force`.
2. A public IPv4 address for the server, or a router in front of it that can forward ports to it. A public IPv6 address is optional.
3. A domain name and a login at the company that runs its DNS. You need one hostname for the platform, such as `tours.example.com`.
4. Root access over SSH: a login with `sudo`, or the root account itself. If you log in as root, leave out `sudo` in the commands below.
5. A computer with Docker and a copy of this repository. The app image is not published anywhere yet, so you build it yourself in [step 4](#4-build-the-app-image-and-copy-it-to-the-server).

Nothing else may listen on ports 80 and 443 on the server. The script checks this and stops if something does.

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
| `Domain name for the platform (for example tours.example.com):` | The hostname from [step 2](#2-create-the-dns-record). Lowercase letters, digits, hyphens and dots; no IP address. |
| `Email for the certificate authority (expiry notices):` | An address that reaches you. Caddy gives it to the certificate authority as the contact for the certificate. |
| `Data folder, new or empty [/opt/demo-platform/data]:` | Press Enter for the default. Any other folder must be new or empty and outside the system folders, such as `/srv/demo-platform`. |
| `Continue? [y/N]` | Type `y` after checking the summary it shows. `--yes` answers this for you. |

### What it does

In this order, saying each step before doing it:

1. Refuses to run unless it is root on Debian 13 or 12 (any system with `--force`).
2. Asks the questions above. On a later run it reads the answers from `/opt/demo-platform/.env` and asks nothing.
3. Checks Docker: it stops if Docker is a snap, if Compose is older than 2.20.0 or if the Docker daemon does not answer. When Docker is installed, it also checks that the app image is on the server, and tries to pull it if not.
4. Checks that nothing else listens on ports 80 and 443, and whether the domain points at this server.
5. Only if `docker compose version` failed in step 3: stops if Debian's own Docker packages are installed, otherwise installs Docker Engine and the Compose plugin from [Docker's apt repository](https://docs.docker.com/engine/install/debian/), checking the repository key's fingerprint first, and then checks the app image.
6. Creates `/opt/demo-platform` (root only) with `caddy/` and `backups/` inside, and the data folder, owned by id 1001 with mode 700. Existing folders are left as they are.
7. Writes `/opt/demo-platform/.env` (mode 600, root only) only if it does not exist yet: `DOMAIN`, `ACME_EMAIL`, `DATA_DIR`, `APP_IMAGE` and a new `SETUP_CODE` of 32 random hex characters.
8. Writes `docker-compose.yml` and `caddy/Caddyfile`. A file that already exists and differs is first saved as `<name>.bak-<date>-<time>`.
9. Starts the stack and waits up to 120 seconds for the app to report healthy.

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
| `sudo bash install.sh update` | Back up, pull newer images and restart. See [step 8](#8-update). |
| `sudo bash install.sh backup` | Write a backup archive. See [step 9](#9-back-up-and-restore). |
| `sudo bash install.sh status` | Show the containers, the app's health check and the data folder's size. |
| `sudo bash install.sh uninstall` | Stop and remove the containers. See [step 11](#11-uninstall). |

| Option | What it does |
|---|---|
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

## 9. Back up and restore

### Back up

```sh
sudo bash install.sh backup
```

It makes a consistent copy of the database inside the running app container, then writes `/opt/demo-platform/backups/demo-platform-<date>-<time>.tar.gz` (mode 600) holding `db.sqlite`, `drafts/` and `public/`. It never removes an older backup, so delete old ones yourself when the disk fills.

The archive does not hold `.env` or the certificate. Neither is needed to restore: `install.sh` writes a new `.env` on a new server, and Caddy gets a new certificate.

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
| The settings, with the setup code | `/opt/demo-platform/.env` |
| The backups | `/opt/demo-platform/backups` |
| The stack file, the Caddyfile and any `.bak-*` copies | `/opt/demo-platform` |
| The certificate and its key, and Caddy's settings | `/opt/demo-platform/caddy-data` and `/opt/demo-platform/caddy-config` |
| The app and Caddy images | Docker's image store |
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

## Pages this runbook relies on

- [Debian releases](https://www.debian.org/releases/), for the current stable and oldstable releases.
- [Install Docker Engine on Debian](https://docs.docker.com/engine/install/debian/), for the supported releases, the apt repository, the conflicting packages, the firewall warning and uninstalling.
- [docker image save](https://docs.docker.com/reference/cli/docker/image/save/) and [docker image load](https://docs.docker.com/reference/cli/docker/image/load/), for moving the image as a file.
- [docker buildx build](https://docs.docker.com/reference/cli/docker/buildx/build/), for building for another architecture.
- [docker compose down](https://docs.docker.com/reference/cli/docker/compose/down/), for what uninstall removes.
- [Caddy: Automatic HTTPS](https://caddyserver.com/docs/automatic-https), for what the certificate needs and how failures are retried.

The script itself is [deploy/install.sh](../deploy/install.sh), and the stack it writes is [deploy/docker-compose.yml](../deploy/docker-compose.yml) with [deploy/caddy/Caddyfile](../deploy/caddy/Caddyfile).
