# Host on Fly.io

> [!WARNING]
> Draft: Not yet verified on a real account. This guide is written from Fly.io's documentation and from the code in this repository, and has not yet been run on a real Fly.io account. Steps that could not be confirmed from either are marked **Unconfirmed**.

> [!NOTE]
> The software is not public yet: there is no public repository. You need a copy of this repository from the owner. You do not need Docker: Fly builds the image from the repository's own Dockerfile on its own builders, so no published image is needed either.

Fly.io runs the platform as one small virtual machine, which Fly calls a Machine, with one disk, which Fly calls a volume. Fly serves HTTPS for you. There is no server to log in to or to patch.

Examples use `tours.example.com` for the platform's address and `tours-example` for the app's name on Fly. Put your own in their place.

## Contents

- [1. What you need and what it costs](#1-what-you-need-and-what-it-costs)
- [2. Create the app and its volume](#2-create-the-app-and-its-volume)
- [3. Deploy](#3-deploy)
- [4. Point the domain at the app](#4-point-the-domain-at-the-app)
- [5. Open the setup wizard](#5-open-the-setup-wizard)
- [6. Backups](#6-backups)
- [7. Updates](#7-updates)
- [8. Delete everything to stop paying](#8-delete-everything-to-stop-paying)
- [Why the Machine never sleeps](#why-the-machine-never-sleeps)
- [Pages this guide relies on](#pages-this-guide-relies-on)

## 1. What you need and what it costs

1. A domain name, and a login at the company that runs its DNS. This is usually where you bought the domain.
2. A Fly.io account with a credit card on file. You create it yourself; this guide does not cover sign-up. Without a card the account is on a [free trial](https://docs.fly.io/about/free-trial) whose Machines stop by themselves after 5 minutes, which is of no use here.
3. A copy of this repository, from the owner.
4. Fly's command-line tool, `fly` (also called flyctl). [Fly's install page](https://docs.fly.io/flyctl/install) has one command each for Windows, macOS and Linux.

Prices checked 2026-11-17 on [Fly's pricing page](https://docs.fly.io/about/pricing), in US dollars before tax. Machine prices differ by region; these are the figures the page gives.

| What | Price | Note |
|---|---|---|
| Machine, `shared-cpu-1x` with 512 MB, running all month | [$3.69 a month](https://docs.fly.io/about/pricing) | Billed by the second while it runs |
| Volume, 1 GB | [$0.15 per GB a month](https://docs.fly.io/about/pricing) | Billed whether the Machine runs or not |
| Volume snapshots | [$0.08 per GB a month, first 10 GB free](https://docs.fly.io/about/pricing) | Billed on the data stored |
| Shared IPv4 address and IPv6 addresses | [No charge](https://docs.fly.io/about/pricing) | A dedicated IPv4 address is $2 a month and is not needed |
| HTTPS certificate | [First 10 single-hostname certificates free](https://docs.fly.io/about/pricing) | Then $0.10 a month each |
| Outbound traffic | [$0.02 per GB in North America and Europe](https://docs.fly.io/about/pricing) | More in other regions |
| **Total** | **About $3.84 a month, plus traffic** | Our arithmetic: $3.69 + $0.15 |

**The under-$5 waiver.** Fly has no free tier. [Fly's waiver page](https://docs.fly.io/about/free-waiver) says that if the bill of your personal organization for a month is under $5, you do not pay it. That needs a credit card on file, and it applies only to the personal organization Fly creates when you sign up. A setup as small as this one should stay under $5.

> [!WARNING]
> The waiver is not a cap: a bill of $5 or more is charged in full, and everything on the account counts toward it. A larger volume, more memory or a busy month can take you over.

## 2. Create the app and its volume

Do this on your computer, in the folder holding the repository.

1. Install `fly` with the command for your system from [Fly's install page](https://docs.fly.io/flyctl/install).
2. Log in. [`fly auth login`](https://docs.fly.io/flyctl/cmd/fly_auth_login) opens the browser.

```sh
fly auth login
```

3. Copy the template to the top folder of the repository, next to the `Dockerfile`. The template is [deploy/fly/fly.toml](../../deploy/fly/fly.toml). On Windows, use `copy` instead of `cp`.

```sh
cp deploy/fly/fly.toml fly.toml
```

4. Open the new `fly.toml` in a text editor and change two lines.

| Line | Change it to |
|---|---|
| `app = "tours-example"` | A name of your own. It must be unique on Fly, and it becomes the app's first address, `tours-example.fly.dev`. |
| `primary_region = "iad"` | The code of the [Fly region](https://docs.fly.io/reference/regions) closest to you and your visitors, such as `ams` for Amsterdam. |

Leave every other line as it is. The port, the health check and the place the volume is mounted match what the app expects.

5. Create the app on Fly, with the name you chose. This is [`fly apps create`](https://docs.fly.io/flyctl/cmd/fly_apps_create).

```sh
fly apps create tours-example
```

6. Create the volume, in the same region as in `fly.toml`. Its name must be `data`, the name the template's `[mounts]` section asks for. This is [`fly volumes create`](https://docs.fly.io/flyctl/cmd/fly_volumes_create).

```sh
fly volumes create data --region iad --size 1
```

7. **Unconfirmed:** hand the empty volume to the app's user. The app runs as user id 1001, not as root, and stops at start if it cannot write to `/data`. Fly's pages do not say who owns a new volume. If it is root, the app's log says `data folder /data is missing or not writable`. This one-off command starts a throwaway Machine from the small public `alpine` image, makes user 1001 the owner of the volume, and removes the Machine again. It is harmless if it was not needed. It uses [`fly machine run`](https://docs.fly.io/flyctl/cmd/fly_machine_run) with its documented `--volume` and `--rm` options, but the command as a whole has not been run.

```sh
fly machine run alpine chown 1001:1001 /data --volume data:/data --region iad --rm
```

8. Generate a setup code. Never invent one yourself: the app refuses a code shorter than 16 characters. This prints 32 random characters; `openssl` comes with macOS, Linux and Git for Windows.

```sh
openssl rand -hex 16
```

9. Save the code in your password manager, then store it as a Fly secret. Put your code where the placeholder is. [Fly's secrets page](https://docs.fly.io/apps/secrets) says a secret is kept encrypted and handed to the app as an environment variable when the Machine starts.

```sh
fly secrets set SETUP_CODE=<your setup code>
```

> [!WARNING]
> Whoever enters the setup code first becomes the owner of the platform. Never write it into `fly.toml` or any other file in the repository, and keep it private until you finish [step 5](#5-open-the-setup-wizard). The command above also leaves the code in your terminal's history.

**How to tell it worked:** this lists one volume named `data`, and `fly secrets list` shows `SETUP_CODE` with no value.

```sh
fly volumes list
```

## 3. Deploy

1. Deploy from the folder holding `fly.toml` and the `Dockerfile`. [`fly deploy`](https://docs.fly.io/flyctl/cmd/fly_deploy) builds the image on Fly's builders, creates the Machine, attaches the volume and gives the app its addresses. The first build takes a few minutes.

```sh
fly deploy --ha=false
```

`--ha=false` asks for one Machine and no spare. [Fly's availability page](https://docs.fly.io/apps/app-availability) says an app with a volume gets only one Machine anyway; the option makes sure.

2. Look at the result.

```sh
fly status
```

3. If the Machine does not come up, read the app's log. A healthy start ends with `listening on port 3000`.

```sh
fly logs
```

> [!WARNING]
> Never run more than one Machine. The database is one SQLite file on one volume. A second Machine, from `fly scale count` or `fly machine clone`, gets its own empty volume and its own empty database, and visitors and uploads would land on either at random.

**How to tell it worked:** this prints `{"ok":true}`, with your app's name in the address.

```sh
curl https://tours-example.fly.dev/healthz
```

## 4. Point the domain at the app

1. Tell Fly about your hostname. [`fly certs add`](https://docs.fly.io/flyctl/cmd/fly_certs_add) prepares the certificate and prints the DNS records to create.

```sh
fly certs add tours.example.com
```

2. At the company that runs your domain's DNS, find the page to add DNS records. It is often called DNS, DNS records, Zone editor or Advanced DNS.
3. Create the records Fly printed. [Fly's custom domain page](https://docs.fly.io/networking/custom-domain) gives two ways; use one.

| Way | Type | Name (also called Host) | Value (also called Points to) |
|---|---|---|---|
| Two address records | A | `tours` | The IPv4 address Fly printed |
| | AAAA | `tours` | The IPv6 address Fly printed |
| One alias record | CNAME | `tours` | The `fly.dev` target Fly printed |

If the form wants the full name, type `tours.example.com` with your own domain. Leave the TTL at its default.

4. Save the records, wait a few minutes, and ask Fly to check.

```sh
fly certs check tours.example.com
```

> [!WARNING]
> With address records, create both. Fly's page says it needs an AAAA record that points at your app (or one of two special records it describes) to issue and renew the certificate, so an A record alone is not enough.

If your DNS is at Cloudflare with its proxy switched on for this record, the certificate may not be issued; [Fly's page](https://docs.fly.io/networking/custom-domain) has a section on that.

**How to tell it worked:** this prints `{"ok":true}` without a certificate error.

```sh
curl https://tours.example.com/healthz
```

## 5. Open the setup wizard

1. Open `https://tours.example.com/setup` in a browser. Use your own address, not the `fly.dev` one, so the wizard shows the right server address.
2. Enter the setup code you saved in step 2.
3. Enter a workspace name and the owner's email address.
4. Copy the API token into your password manager. It is shown once.
5. In Mythicshot, open Settings › Output › Tour publishing, paste the server address and the token, and press Test connection.

The [wizard step of the Docker runbook](../runbook-docker.md#7-the-setup-wizard-and-mythicshot) covers each screen. Its commands for a lost code or token are written for the Docker install and do not apply here.

> [!WARNING]
> The API token works like a password: anyone holding it can upload to and unpublish every tour in the workspace.

**How to tell it worked:** opening `https://tours.example.com/setup` again shows `{"error":"not_found"}`. Setup can be done once.

## 6. Backups

**What Fly does by itself.** [Fly's snapshots page](https://docs.fly.io/volumes/snapshots) says Fly takes a snapshot of every volume daily and keeps it for 5 days. You can also take one whenever you like, for example before an update.

1. Find the volume's ID.

```sh
fly volumes list
```

2. Take a snapshot. Put the ID where the placeholder is.

```sh
fly volumes snapshots create <volume id>
```

3. See the snapshots and their sizes.

```sh
fly volumes snapshots list <volume id>
```

To keep the daily snapshots longer, up to 60 days, run `fly volumes update <volume id> --snapshot-retention <days>`, as the same page shows.

> [!WARNING]
> Snapshots are not a full backup. [Fly's volumes page](https://docs.fly.io/volumes/overview) says a volume lives on one physical server, that a single copy of your data is lost if that drive fails, that daily snapshots may miss your latest data, and that snapshots should not be your primary backup.

**Restoring a snapshot.** Fly restores a snapshot into a new volume, with `fly volumes create data --snapshot-id <snapshot id>`, as [the snapshots page](https://docs.fly.io/volumes/snapshots) shows. **Unconfirmed:** moving this app's Machine onto the restored volume has not been worked out or tried. Ask the owner before you rely on it.

**A copy on your own computer. Unconfirmed:** these commands exist in Fly's reference ([`fly ssh console`](https://docs.fly.io/flyctl/cmd/fly_ssh_console) and [`fly ssh sftp get`](https://docs.fly.io/flyctl/cmd/fly_ssh_sftp_get)), but this sequence has not been run. It makes a consistent copy of the database inside the Machine with the app's own backup tool, downloads it with the image folders, and removes the copy.

```sh
fly ssh console -C "env DATA_DIR=/data node /app/dist/node/backup.js /data/backup-copy.sqlite"
```

```sh
fly ssh sftp get /data/backup-copy.sqlite
```

```sh
fly ssh sftp get --recursive /data/drafts
```

```sh
fly ssh sftp get --recursive /data/public
```

```sh
fly ssh console -C "rm /data/backup-copy.sqlite"
```

> [!WARNING]
> A backup holds the owner's email, the token hashes and every draft image: keep it as private as a password.

## 7. Updates

**The platform.** An update is a newer copy of the repository, deployed the same way.

1. Take a snapshot first, as in [step 6](#6-backups).
2. Put your `fly.toml` into the top folder of the newer copy. Keep your own `app` and `primary_region` lines.
3. Deploy. The volume and its data stay; the app applies any database changes as it starts.

```sh
fly deploy --ha=false
```

The platform is down for a short time during a deploy. [Fly's volumes page](https://docs.fly.io/volumes/overview) says an app with one Machine and one volume has downtime whenever you deploy.

**The `fly` tool.** `fly version upgrade` updates it.

**The server.** There is none to patch. Fly runs the hardware, and the operating system inside the image is rebuilt with every deploy.

**How to tell it worked:** `fly status` shows the Machine started with its check passing, and `curl https://tours.example.com/healthz` prints `{"ok":true}`.

## 8. Delete everything to stop paying

1. Download a copy of your data first if you want to keep it, as in [step 6](#6-backups).
2. Destroy the app, with your app's name. [`fly apps destroy`](https://docs.fly.io/flyctl/cmd/fly_apps_destroy) asks you to confirm.

```sh
fly apps destroy tours-example
```

3. Open the Fly dashboard and check that no app, Machine or volume is left, and look at the billing page for the final amount.
4. Remove the records for `tours.example.com` at your DNS company.

> [!WARNING]
> Destroying the app cannot be undone. [Fly's scaling page](https://docs.fly.io/launch/scale-count) says a volume stays until you destroy it or the app it belongs to, so the volume, with every tour and image on it, goes with the app.

## Why the Machine never sleeps

Fly can stop a Machine when no requests arrive and start it again on the next one. [Fly's autostop page](https://docs.fly.io/launch/autostop-autostart) calls this scale to zero, and it is what Fly writes into a new app's `fly.toml` by default. The template turns it off, with `auto_stop_machines = "off"`. The reasons:

1. A stopped Machine makes the next request wait for a cold start, which Fly's page puts at about 2 seconds or more, and this app also opens its database and checks its migrations before it answers.
2. The setup wizard waits on screen while Mythicshot tests the connection, and Mythicshot uploads a tour one image per request. A large tour is published over several requests, and the helper may pause between them. A Machine that stops in the middle would not lose data, because the app closes its database cleanly, but requests that hit a starting Machine can time out and look like failures. This has not been measured, so the template does not take the risk.
3. The saving is small. A stopped Machine saves at most its $3.69 a month, the volume is billed either way, and the whole setup is under the $5 waiver already.

`auto_start_machines = true` stays on for a different case: if the Machine was stopped by hand or after a crash, the next request starts it again. Fly's page recommends setting both options the same way unless there is a reason not to; this is the reason.

## Pages this guide relies on

Opened on 2026-11-17.

- [Fly.io resource pricing](https://docs.fly.io/about/pricing), [free trial](https://docs.fly.io/about/free-trial) and [free waiver](https://docs.fly.io/about/free-waiver), for step 1.
- [App configuration (fly.toml)](https://docs.fly.io/reference/configuration), for every key in the template: `app`, `primary_region`, `kill_signal`, `kill_timeout`, `[env]`, `[http_service]` and its checks, `[mounts]` and `[[vm]]`.
- [Install flyctl](https://docs.fly.io/flyctl/install), [fly auth login](https://docs.fly.io/flyctl/cmd/fly_auth_login), [fly apps create](https://docs.fly.io/flyctl/cmd/fly_apps_create), [fly volumes create](https://docs.fly.io/flyctl/cmd/fly_volumes_create), [fly machine run](https://docs.fly.io/flyctl/cmd/fly_machine_run), [Secrets](https://docs.fly.io/apps/secrets) and [Fly regions](https://docs.fly.io/reference/regions), for step 2.
- [fly deploy](https://docs.fly.io/flyctl/cmd/fly_deploy), [Deploy an app](https://docs.fly.io/launch/deploy) and [App availability](https://docs.fly.io/apps/app-availability), for step 3.
- [Custom domains](https://docs.fly.io/networking/custom-domain) and [fly certs add](https://docs.fly.io/flyctl/cmd/fly_certs_add), for step 4.
- [Volumes overview](https://docs.fly.io/volumes/overview), [Manage volume snapshots](https://docs.fly.io/volumes/snapshots), [fly ssh console](https://docs.fly.io/flyctl/cmd/fly_ssh_console) and [fly ssh sftp get](https://docs.fly.io/flyctl/cmd/fly_ssh_sftp_get), for step 6.
- [Scale the number of Machines](https://docs.fly.io/launch/scale-count) and [fly apps destroy](https://docs.fly.io/flyctl/cmd/fly_apps_destroy), for step 8.
- [Autostop/autostart Machines](https://docs.fly.io/launch/autostop-autostart), for the last section.
- The template is [deploy/fly/fly.toml](../../deploy/fly/fly.toml), and the app's settings come from the [Dockerfile](../../Dockerfile) and [deploy/docker-compose.yml](../../deploy/docker-compose.yml).
