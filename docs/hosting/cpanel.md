# Host on shared cPanel hosting

> [!WARNING]
> Partly verified. The steps this guide is built on were done by hand on one real shared cPanel account, at one provider: creating the Node.js app, the folders, the startup file, installing the packages, the restart, an update by hand and the health address. The script `cpanel.sh` that now does those steps, and the archive it comes in, have only been tested on a development computer against stand-ins for the hosting's commands. [What has been run where](#what-has-been-run-where) lists both sides.

> [!NOTE]
> The software is not public yet: there is no published archive and no public repository. You need a copy of this repository from the owner, and a computer with Node.js 24 or later to build the archive from it.

This guide puts the platform on shared hosting with cPanel: no server of your own, no root access and no Docker. It works only where the hosting's cPanel has **Setup Node.js App** (a CloudLinux feature) and gives you SSH access. It is written for any such provider; ask your hosting provider when a label in this guide does not match what you see.

Examples use `tours.example.com` for the platform's address and `you` for your cPanel user name, so your home folder is `/home/you`. Put your own in their place. This guide names no prices: it was not written from any provider's price page.

## Contents

- [1. What you need](#1-what-you-need)
- [2. Create the subdomain](#2-create-the-subdomain)
- [3. Build the archive](#3-build-the-archive)
- [4. Upload and unpack the archive](#4-upload-and-unpack-the-archive)
- [5. Install the platform](#5-install-the-platform)
- [6. Read the setup code](#6-read-the-setup-code)
- [7. Open the setup wizard](#7-open-the-setup-wizard)
- [8. HTTPS](#8-https)
- [9. Updates](#9-updates)
- [10. Backups](#10-backups)
- [11. Restore from a backup](#11-restore-from-a-backup)
- [12. Roll back an update](#12-roll-back-an-update)
- [13. Troubleshooting](#13-troubleshooting)
- [What has been run where](#what-has-been-run-where)

## 1. What you need

1. Shared hosting with cPanel whose **Software** section has **Setup Node.js App**, offering Node.js 24. Not every plan has it. If you cannot find it, ask your hosting provider before going on.
2. SSH access to the hosting account. Many providers switch it on only when asked, and some use a port other than 22; your hosting provider's welcome email or help pages say which.
3. A domain on that hosting account, so you can add a subdomain such as `tours.example.com` to it.
4. A copy of this repository, from the owner.
5. A computer with Node.js 24 or later and npm, to build the archive.

Where things end up on the hosting, with the default settings:

| Path | What it is |
|---|---|
| `/home/you/apps/tours` | The app: `dist`, `migrations`, `package.json`, `package-lock.json`, `app.cjs`, `cpanel.sh` and `VERSION` |
| `/home/you/apps/tours-data` | The data: `db.sqlite`, `drafts` and `public` |
| `/home/you/apps/tours-config.env` | The settings file, holding the data folder and the setup code. Only your account can read it |
| `/home/you/backups` | One folder per backup |

None of these is inside `public_html`, the folder the web server shows to the world. That is on purpose.

## 2. Create the subdomain

1. Sign in to cPanel and open **Domains**.
2. Create a new domain and type `tours.example.com` with your own domain. Older cPanel versions have a separate **Subdomains** page for this.
3. Leave the document root cPanel suggests. The platform does not use it for its own files.
4. Save.

If your domain's DNS is run by another company than your hosting provider, also add a DNS record there that points `tours` at the hosting, as your hosting provider's help pages describe.

**How to tell it worked:** the new name is in the list on the **Domains** page. Opening `http://tours.example.com` in a browser shows an empty listing or a default page from the hosting, not an error from your browser about the name.

## 3. Build the archive

On your own computer, in the folder holding the repository:

1. Install the build tools. This contacts the npm registry.

```sh
npm ci
```

2. Build and package.

```sh
npm run package:cpanel
```

It writes one file, `dist/cpanel/demo-platform-<version>-cpanel.tgz`, where `<version>` is the version in `package.json`. The archive holds the compiled app, the database migrations, `package.json` and `package-lock.json`, the startup file `app.cjs`, the script `cpanel.sh` and a `VERSION` file. It holds no source code, no tests, no settings and no installed packages.

**How to tell it worked:** the last lines name the file it wrote and the number of files in it.

## 4. Upload and unpack the archive

1. Copy the archive to your home folder on the hosting. In cPanel, open **File Manager**, stay in the home folder (`/home/you`), and use **Upload**. From a terminal, `scp` does the same; your hosting provider's help pages give the host name and port for SSH.

> [!WARNING]
> Do not upload or unpack the archive inside `public_html`. Everything in that folder can be downloaded by anyone.

2. Connect to the hosting by SSH, as your hosting provider describes.
3. Make a folder for the unpacked archive and unpack into it. Use your archive's file name.

```sh
mkdir ~/tours-release
```

```sh
tar -xzf ~/demo-platform-<version>-cpanel.tgz -C ~/tours-release
```

**How to tell it worked:** this lists `VERSION`, `app.cjs`, `cpanel.sh`, `dist`, `migrations`, `package-lock.json` and `package.json`.

```sh
ls ~/tours-release
```

## 5. Install the platform

1. Go to the unpacked archive and read the script before you run it.

```sh
cd ~/tours-release
```

```sh
less cpanel.sh
```

2. See what it would do, without changing anything.

```sh
./cpanel.sh install --domain tours.example.com --dry-run
```

3. Run the install. It shows the address and the folders and asks before it starts.

```sh
./cpanel.sh install --domain tours.example.com
```

The script then does what was done by hand on real hosting:

| Step | What happens |
|---|---|
| Create the Node.js app | It runs the hosting's `cloudlinux-selector create` command for Node.js 24, the app folder `apps/tours`, your domain and the startup file `app.cjs`, in production mode |
| Copy the files | The unpacked archive is copied to `/home/you/apps/tours` |
| Data folder | `/home/you/apps/tours-data` is created, closed to other accounts |
| Settings file | `/home/you/apps/tours-config.env` is written with the data folder and a new, random setup code. Only your account can read it |
| Packages | `npm ci --omit=dev --ignore-scripts` runs inside the app's own Node.js environment |
| Restart | The file `tmp/restart.txt` in the app folder is touched, which tells the hosting to restart the app |
| Health | It asks `https://tours.example.com/healthz` and says whether the platform answered |

The script never prints the setup code. At the end it tells you where the settings file is; [step 6](#6-read-the-setup-code) reads the code from it.

If an install is already there, the script refuses and points to `update`. An existing data folder or settings file is never replaced: the script keeps it and says so.

Options, for when the defaults do not fit:

| Option | What it does |
|---|---|
| `--app-root <path>` | Another app folder, relative to your home folder. The default is `apps/tours`. The data folder and the settings file are named after it: `apps/demo` gets `apps/demo-data` and `apps/demo-config.env`. Give the same option to every later command |
| `--node <major>` | Another Node.js version than 24. The platform needs 24 or later |
| `--yes` | Do not ask before starting |
| `--dry-run` | Print what would be done and change nothing |

**How to tell it worked:** the script ends with a line saying the version is installed and answers at `https://tours.example.com`. If it says the health check did not pass, the platform may still be fine: on a new subdomain the certificate is often not ready yet. See [step 8](#8-https), then check again.

```sh
./cpanel.sh status
```

## 6. Read the setup code

The setup code is one line in the settings file. The script does not show it, so that it never ends up in a terminal's scrollback or a support ticket.

1. In cPanel, open **File Manager** and go to the `apps` folder in your home folder.
2. Select the file `tours-config.env` and open it with **View** or **Edit**.
3. Copy what follows `SETUP_CODE=` on that line. Change nothing and close the file without saving.

Over SSH, this prints the same line to your own terminal.

```sh
grep '^SETUP_CODE=' ~/apps/tours-config.env
```

> [!WARNING]
> Whoever enters the setup code first becomes the owner of the platform. Keep it private until you finish [step 7](#7-open-the-setup-wizard), and do not paste it into a chat or a ticket.

## 7. Open the setup wizard

1. Open `https://tours.example.com/setup` in a browser.
2. Enter the setup code from [step 6](#6-read-the-setup-code).
3. Enter a workspace name and the owner's email address.
4. Copy the API token into your password manager. It is shown once.
5. In Mythicshot, open Settings › Output › Tour publishing, paste the server address and the token, and press Test connection.

The [Docker runbook's wizard step](../runbook-docker.md#7-the-setup-wizard-and-mythicshot) describes each screen. Its commands are for the Docker route and do not apply here.

> [!WARNING]
> The API token works like a password: anyone holding it can upload to and unpublish every tour in the workspace.

**How to tell it worked:** from your own computer, this prints `{"ok":true}` without a certificate error.

```sh
curl https://tours.example.com/healthz
```

## 8. HTTPS

The platform does not get a certificate itself on this route. The hosting does: cPanel hosting usually issues a free certificate for every domain and subdomain of the account by itself, some time after the name is created. **Unconfirmed:** how long that takes at your provider; expect anything from minutes to a day.

1. In cPanel, look for a page about the certificates of your domains. It is often called **SSL/TLS Status**.
2. Find `tours.example.com` there. If the page offers to run the automatic certificate check now, do so.
3. Until the certificate is there, browsers warn about the address and the script's health check fails, because it refuses an address without a valid certificate. Nothing is wrong with the platform in that case.
4. Do not enter the setup code over an address your browser warns about. Wait for the certificate.

**How to tell it worked:** `https://tours.example.com/healthz` opens in a browser without a warning and shows `{"ok":true}`, and this reports the health as ok.

```sh
cd ~/apps/tours && ./cpanel.sh status
```

## 9. Updates

An update is a new archive, built from a newer copy of the repository.

1. Build the new archive on your computer, as in [step 3](#3-build-the-archive), and upload it to your home folder, as in [step 4](#4-upload-and-unpack-the-archive).
2. On the hosting, replace the unpacked copy of the previous archive with the new one. The folder `~/tours-release` holds only that copy; the installed app is in `~/apps/tours`.

```sh
rm -rf ~/tours-release
```

```sh
mkdir ~/tours-release
```

```sh
tar -xzf ~/demo-platform-<version>-cpanel.tgz -C ~/tours-release
```

3. Run the update from the new copy. It shows both versions and asks before it starts.

```sh
cd ~/tours-release
```

```sh
./cpanel.sh update
```

What the update does, in this order:

1. It makes a backup, as in [step 10](#10-backups). If the backup fails, it stops and changes nothing.
2. It moves the running `dist` and `migrations` folders to `dist.old` and `migrations.old`, replacing the copies an earlier update left there.
3. It copies the new files in, installs the packages, restarts the app and asks the health address.

The data folder and the settings file are not touched. The update must be run from the newly unpacked archive, not from the copy of the script in the app folder.

The script refuses an archive that is older than the installed version, because an older version may not start on a database a newer one has changed. `--allow-downgrade` overrides that; make sure you know why you need it.

If the platform was first installed by hand, without this script, the first update needs the address once: add `--domain tours.example.com`. The script remembers it afterwards.

**How to tell it worked:** the script ends with "Updated to version" and the address. If it says the health check did not pass, it prints the commands to go back; see [step 12](#12-roll-back-an-update).

## 10. Backups

1. Make a backup. The installed copy of the script does this; no archive is needed.

```sh
cd ~/apps/tours && ./cpanel.sh backup
```

It writes a new folder, `/home/you/backups/tours-<date>-<time>`, and prints its name. The folder holds:

| In the backup | What it is |
|---|---|
| `db.sqlite` | A consistent copy of the database, made by SQLite itself while the app keeps running: with the `sqlite3` tool where the hosting has it, otherwise with the app's own Node.js |
| `drafts` and `public` | The uploaded and the published images |
| `app.tgz` | The app files as they are now, without the installed packages |
| `tours-config.env` | A copy of the settings file, with the setup code in it |

2. Copy the backup folder to your own computer: in cPanel's **File Manager**, compress the folder and download it, or use `scp` from your computer.

> [!WARNING]
> A backup that stays on the hosting is lost with the hosting account. Copy every backup somewhere else, and keep it as private as a password: it holds the owner's email, the token hashes, every draft image and the setup code.

The script never removes a backup. Old ones count against your hosting's disk space, so remove the ones you have copied elsewhere and no longer need.

**Unconfirmed:** what backups your hosting provider makes by itself, how long it keeps them and what a restore from them costs. Do not plan on them.

## 11. Restore from a backup

These steps are written from how the platform stores its data. They have not been run on real hosting.

> [!WARNING]
> A restore puts the data back as it was when the backup was made. Tours, uploads and tokens made after that are gone from the running platform. The steps below keep the current data in a folder of its own, so you can still get at it.

1. Stop the app, so that it does not write while you change its files: in cPanel, open **Setup Node.js App** and stop the app for `tours.example.com`. **Unconfirmed:** the button's label; it may be **Stop App**.
2. Over SSH, move the current data folder aside and make an empty one.

```sh
mv ~/apps/tours-data ~/apps/tours-data.before-restore
```

```sh
mkdir -m 700 ~/apps/tours-data
```

3. Copy the database and the two folders back. Put your backup folder's name in place of `tours-<date>-<time>`. A backup made before the app first ran has no `db.sqlite`, and one made before the first upload has no `drafts` or `public`; skip what is not there.

```sh
cp ~/backups/tours-<date>-<time>/db.sqlite ~/apps/tours-data/db.sqlite
```

```sh
cp -R ~/backups/tours-<date>-<time>/drafts ~/backups/tours-<date>-<time>/public ~/apps/tours-data/
```

4. Only if the settings file is lost too, copy it back and close it to other accounts.

```sh
cp ~/backups/tours-<date>-<time>/tours-config.env ~/apps/tours-config.env
```

```sh
chmod 600 ~/apps/tours-config.env
```

5. Start the app again in **Setup Node.js App**, and check it.

```sh
cd ~/apps/tours && ./cpanel.sh status
```

**How to tell it worked:** the status shows the health as ok, and the tours from the time of the backup are back. When you are sure, remove `~/apps/tours-data.before-restore` yourself.

## 12. Roll back an update

When the health check fails after an update, the script does not undo anything by itself. It prints the commands that bring the previous version back, with your own paths filled in. They look like this:

```sh
cd /home/you/apps/tours
```

```sh
rm -rf dist && mv dist.old dist
```

```sh
rm -rf migrations && mv migrations.old migrations
```

```sh
tar -xzf /home/you/backups/tours-<date>-<time>/app.tgz package.json package-lock.json app.cjs cpanel.sh VERSION
```

```sh
source /home/you/nodevenv/apps/tours/24/bin/activate && npm ci --omit=dev --ignore-scripts
```

```sh
touch /home/you/apps/tours/tmp/restart.txt
```

Use the commands the script printed, not the ones above: yours name the right backup folder. Before you roll back, read [step 13](#13-troubleshooting): a failed health check right after an update is often the certificate or a slow start, not the new version.

> [!WARNING]
> If the new version already changed the database, the previous version may not start on it. Then also restore `db.sqlite` from the backup the update made, as in [step 11](#11-restore-from-a-backup); what was created after that backup is lost.

**How to tell it worked:** this shows the previous version and the health as ok.

```sh
cd ~/apps/tours && ./cpanel.sh status
```

## 13. Troubleshooting

| What you see | What to do |
|---|---|
| The address shows an error page from the hosting instead of the platform | The app did not start. Read the app's log: in cPanel, open **Setup Node.js App** and edit the app; the page lets you set a log file for Passenger, the program that runs the app. Set one in your home folder, restart the app, load the address again and read the file. **Unconfirmed:** the field's label |
| The log says it cannot read the settings file | The line names the path it expects, `/home/you/apps/tours-config.env`. The file must be there, beside the app folder, and be readable by your account. If it is lost, copy it back from a backup as in [step 11](#11-restore-from-a-backup) |
| The log says `DATA_DIR is not set` | The settings file is there but has no `DATA_DIR=` line. It must hold `DATA_DIR=/home/you/apps/tours-data` |
| "Not found" (404) at an address you expected to work | The app answers only on the name it was created for. `https://tours.example.com` works; another name of the same account, or `www.tours.example.com`, shows that other site or a 404 from the hosting. Check the name you typed, and the domain of the app in **Setup Node.js App** |
| The browser warns about the certificate, or the health check says the address did not answer | The hosting has not issued the certificate yet. See [step 8](#8-https) |
| The health check says another site may be answering | The address answered, but not with the platform's reply. The subdomain probably still shows the hosting's default page: check that the Node.js app exists in **Setup Node.js App** and is set to this domain |
| `cloudlinux-selector command was not found` | The hosting has no **Setup Node.js App**, or does not offer its command over SSH. Ask your hosting provider |
| The install says the hosting did not create the Node.js app | The line above it shows the hosting's own answer. Often an app for this folder or domain exists already: remove it in **Setup Node.js App**, or choose another folder with `--app-root`, and run the install again |
| The script says the app's Node.js environment was not found | The app runs on another Node.js version than the script expects. Add `--node` with the version shown in **Setup Node.js App** |
| The setup wizard says the setup code is not right | Copy the code again from the settings file, without spaces around it, as in [step 6](#6-read-the-setup-code) |

`./cpanel.sh status` shows the installed version, the folders, the size of the data folder, the newest backup and the health in one place. It changes nothing.

## What has been run where

**Run by hand on real hosting,** on one shared cPanel account at one provider (CloudLinux, with the app run by Passenger):

- Creating the Node.js app with `cloudlinux-selector create`, with the same options the script uses.
- The layout: the app in `apps/tours`, the data in `apps/tours-data`, the settings in `apps/tours-config.env` with mode 600, outside the app folder and the web root.
- A startup file that reads the settings file and then loads the app. The `app.cjs` in the archive is a hardened version of it.
- `npm ci --omit=dev --ignore-scripts` inside the app's Node.js environment, and the restart through `tmp/restart.txt`.
- An update by hand: backing up the database, `drafts`, `public` and the old app files, moving `dist` and `migrations` to `dist.old` and `migrations.old`, unpacking the new ones, installing the packages, restarting and checking `/healthz`.

**Tested only on a development computer,** never on real hosting:

- The script `cpanel.sh` itself, all four commands. Its tests ([deploy/cpanel/test-cpanel.sh](../../deploy/cpanel/test-cpanel.sh)) replace `cloudlinux-selector`, `npm`, `node`, `sqlite3`, `curl` and `touch` with stand-ins that record what would be run.
- The archive from `npm run package:cpanel`. Its contents are checked by tests; it has not been unpacked on hosting.
- The `app.cjs` in the archive. It is tested by starting it with Node.js, not under Passenger.
- The database copy for backups. The copy made with Node.js was run against a real database in use on a development computer; the copy made with the `sqlite3` tool was only run against a stand-in.
- The restore steps in [step 11](#11-restore-from-a-backup), and the labels of cPanel's pages and buttons throughout, which are written from memory of cPanel and may differ at your provider.

The files this guide describes are [deploy/cpanel/cpanel.sh](../../deploy/cpanel/cpanel.sh), [deploy/cpanel/app.cjs](../../deploy/cpanel/app.cjs) and [scripts/package-cpanel.ts](../../scripts/package-cpanel.ts).
