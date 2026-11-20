# Host on shared cPanel hosting

> [!WARNING]
> Partly verified. The steps this guide is built on were done by hand on one real shared cPanel account, at one provider. Of the script `cpanel.sh` that now does those steps, the `update` and `status` commands of an earlier version have run once on that account, from an archive unpacked there; `install`, `backup` as a command of its own, the commands to go back and the second address have only been tested on a development computer against stand-ins for the hosting's commands. [What has been run where](#what-has-been-run-where) lists both sides.

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
- [14. A second address for the app](#14-a-second-address-for-the-app)
- [15. Make yourself the admin](#15-make-yourself-the-admin)
- [16. Send sign-in mail](#16-send-sign-in-mail)
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
| `/home/you/apps/tours-data` | The data: `db.sqlite`, `drafts` and `public`. The install writes this path to the settings file as `DATA_DIR`, and every later command reads it from there |
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

If the install stops part-way, do not run it again: it would refuse, because the files are already there. Fix the cause and finish with `./cpanel.sh update` from the same folder.

If an install is already there, the script refuses and points to `update`. An existing data folder or settings file is never replaced: the script keeps it and says so.

Options, for when the defaults do not fit:

| Option | What it does |
|---|---|
| `--app-root <path>` | Another app folder, relative to your home folder. The default is `apps/tours`. The data folder and the settings file are named after it: `apps/demo` gets `apps/demo-data` and `apps/demo-config.env`. The script refuses a folder the web server serves: `public_html`, `www`, or a path that starts with a folder named after a domain. Give the same option to every later command |
| `--node <major>` | Another Node.js version than 24. The platform needs 24 or later |
| `--app-domain <name>` | A second address, for the app, such as `app.example.com`; `--domain` is then the address of the tours. It goes with `update` and `status`, not with `install`, and is remembered after an update whose check passed. See [step 14](#14-a-second-address-for-the-app) |
| `--yes` | Do not ask before starting |
| `--dry-run` | Print what would be done and change nothing |

**How to tell it worked:** the script ends with a line saying the version is installed and answers at `https://tours.example.com`. If it says the health check did not pass, the platform may still be fine: on a new subdomain the certificate is often not ready yet. See [step 8](#8-https), then check again.

The `status` command is how you check at any time. It shows the installed version, the folders, the size of the data folder, the newest backup and the health, and it changes nothing.

```sh
./cpanel.sh status
```

## 6. Read the setup code

The setup code is one line in the settings file. The script does not show it, so that it never ends up in a terminal's scrollback or a support ticket.

1. In cPanel, open **File Manager** and go to the `apps` folder in your home folder.
2. Select the file `tours-config.env` and open it with **View** or **Edit**.
3. Copy what follows `SETUP_CODE=` on that line. Change nothing and close the file without saving.

If you prefer SSH, open the file in a text editor there, such as `nano ~/apps/tours-config.env`, and leave without saving. Do not print the file or the line with a command such as `cat` or `grep`: the code would stay in the terminal's scrollback and in anything that records the session.

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

1. It makes a backup, as in [step 10](#10-backups). If the backup fails, or the database of a platform that has run before is not found, it stops and changes nothing.
2. It copies the new `dist` and `migrations` folders beside the running ones, as `dist.new` and `migrations.new`. The running app is not touched yet.
3. It renames, back to back: the running folders become `dist.old` and `migrations.old`, replacing the copies an earlier, finished update left there, and the new ones take their place.
4. It copies the other new files in, installs the packages, restarts the app and asks the health address. When that answers, it also asks the API's address, without a token and only for the status code, to see that the platform does not refuse its own name.

The data folder and the settings file are not touched. The update must be run from the newly unpacked archive, not from the copy of the script in the app folder.

The script refuses an archive that is older than the installed version, because an older version may not start on a database a newer one has changed. `--allow-downgrade` overrides that; make sure you know why you need it.

The update refuses to start when it does not know the address, because it could not check the result. That is the case once, when the platform was first installed by hand, without this script: add `--domain tours.example.com`. The script remembers it afterwards.

**If an update is cut off,** by Ctrl-C or a dropped SSH connection, the script prints the commands to go back, when it still can. Either way, run the same update again: it notices the unfinished one, keeps `dist.old` and `migrations.old` from before it as the way back, and finishes. Until then, `./cpanel.sh status` says that an update was cut off.

**How to tell it worked:** the script ends with "Updated to version" and the address. If it says the health check did not pass, it prints the commands to go back; see [step 12](#12-roll-back-an-update).

### Rehearse an update on a copy of a backup

Before an update that changes the database, you can try it first on a copy of your own data, on your own computer.

The rehearsal starts the version you run today and the new version on that computer only, one after the other, on a copy of your backup. It checks that the new version shows your token the same tours, pages and pictures, keeps every file and every row, and that the version you run today still works on the changed database, which is your way back. [The command's reference](../rehearse-upgrade.md) lists every check and setting.

> [!WARNING]
> The backup folder holds real data: the owner's email, the token hashes, every image, and the settings file with the setup code and any mailbox password. Keep the copy on your computer as private as the backup itself, and delete it when you are done. The rehearsal copies only `db.sqlite`, `drafts` and `public` into a scratch folder, removes that folder at the end, and never reads the settings file.

1. Make a backup, as in [step 10](#10-backups), and copy the backup folder to a computer with Node.js 24 or later and a copy of this repository.

2. Unpack the version you run today and the new version into two empty folders, for example `~/rehearse/old` and `~/rehearse/new`. The version you run today is `app.tgz` in the backup folder; the new version is the new archive from [step 3](#3-build-the-archive).

3. In each of the two folders, install the packages, as the update does on the hosting.

```sh
cd ~/rehearse/old && npm ci --omit=dev --ignore-scripts
```

```sh
cd ~/rehearse/new && npm ci --omit=dev --ignore-scripts
```

4. In the copy of this repository, put your token in an environment variable without it landing in your shell's history: run the first command, paste the token, press Enter, then run the second.

```sh
read -rs REHEARSE_TOKENS
```

```sh
export REHEARSE_TOKENS
```

5. Run the rehearsal on the backup folder. Put your backup folder's name in place of `tours-<date>-<time>`. If your platform has two addresses, as in [step 14](#14-a-second-address-for-the-app), add `--mode two` at the end.

```sh
npm run rehearse:upgrade -- ~/backups/tours-<date>-<time> ~/rehearse/old ~/rehearse/new
```

6. Read the report. Each check is one line that starts with PASS or FAIL, and the last line is `RESULT: PASS` or `RESULT: FAIL`. The report never shows your token, an email address or a name from your data, so you can pass it on to whoever helps you.

**How to tell it worked:** the last line is `RESULT: PASS`. If any check says FAIL, do not run the update; the indented lines below that check say what differed.

The rehearsal does not test your hosting: not how the hosting starts the app, not its file system and not its version of Node.js. It also proves only what your own data holds; a kind of tour your site does not have yet is not tried.

**After the update that brings accounts,** the site works as before until it has an admin: make yourself the admin as in [step 15](#15-make-yourself-the-admin).

## 10. Backups

1. Make a backup. The installed copy of the script does this; no archive is needed.

```sh
cd ~/apps/tours && ./cpanel.sh backup
```

It writes a new folder, `/home/you/backups/tours-<date>-<time>`, and prints its name. The folder holds:

| In the backup | What it is |
|---|---|
| `db.sqlite` | A consistent copy of the database, made by SQLite itself while the app keeps running and then checked for damage. The app's own Node.js makes it; the `sqlite3` tool is used only where that Node.js is not found |
| `drafts` and `public` | The uploaded and the published images |
| `app.tgz` | The app files as they are now, without the installed packages |
| `tours-config.env` | A copy of the settings file, with the setup code in it |

The script finds the data folder through the `DATA_DIR` line of the settings file. If the settings file is missing, has no such line, or there is no database in that folder, the backup stops and writes nothing. The one exception is a platform that has never started, whose first install did not finish: it has no database yet, and the backup says that it holds none.

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

When the health check fails after an update, the script does not undo anything by itself. It prints the commands that bring the previous version back, with your own paths filled in. Each one is a single line that goes to the app folder itself and does nothing when its work is already done, so you can paste them one by one, and pasting one twice does no harm. They look like this:

```sh
cd '/home/you/apps/tours' && [ -d dist.old ] && rm -rf dist && mv dist.old dist
```

```sh
cd '/home/you/apps/tours' && [ -d migrations.old ] && rm -rf migrations && mv migrations.old migrations
```

```sh
cd '/home/you/apps/tours' && tar -xzf '/home/you/backups/tours-<date>-<time>/app.tgz' package.json package-lock.json app.cjs cpanel.sh VERSION
```

```sh
cd '/home/you/apps/tours' && source '/home/you/nodevenv/apps/tours/24/bin/activate' && npm ci --omit=dev --ignore-scripts
```

```sh
cd '/home/you/apps/tours' && rm -f .cpanel-update && touch tmp/restart.txt
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
| The install stopped part-way, for example at the packages, and running it again says an install is already there | Do not remove anything. When the cause is fixed, finish with `./cpanel.sh update` from the same unpacked archive. The script remembers that the install never finished, so it goes on although there is no database to back up yet, and says so |
| An update or a backup stops, saying there is no database | This install has run before, so it has a database, and the script will not go on without backing it up. It looks in the folder the `DATA_DIR` line of the settings file names: that line points at the wrong folder, or the database was moved or removed. Put the line right, or restore the database as in [step 11](#11-restore-from-a-backup) |
| `./cpanel.sh status` says an update was cut off | Unpack the archive of that update again if needed and run `./cpanel.sh update` from it; see [step 9](#9-updates) |
| The setup wizard says the setup code is not right | Copy the code again from the settings file, without spaces around it, as in [step 6](#6-read-the-setup-code) |
| The script says the platform does not see an address as its tours or its app address | The address answered, but the platform reports no role for it, or the role of the other address. Check that the settings file holds both lines of [step 14](#14-a-second-address-for-the-app), each with the right name, and restart the app. If the lines are right, the name does not reach the app as it was typed: the second name is not attached to this app, or something in front of the app changes the host name. **Unconfirmed:** whether your hosting does that |
| With two addresses, a name shows an empty page with status 421 | The platform then refuses every name but the two in the settings file. Check the spelling of the names after `TOURS_HOST=` and `APP_HOST=`. To go back to one address, see the way back in [step 14](#14-a-second-address-for-the-app) |
| After adding the two lines the app does not start | The app's log names the line that is wrong: both lines must be there, each must hold a plain host name, and the two names must differ. Put them right, or remove both, and restart |
| The script says an address answers its health check but refuses every other request | The settings file holds `TOURS_HOST=` and `APP_HOST=` lines that name other addresses than the one you use. The platform then refuses its own name with status 421, tour links included, while its health address still answers. Correct the names in the two lines, or remove both, and restart |
| The log says `mail: off, because` and the name of a setting | Mail is switched on, but that line of the settings file is missing or not usable, so the platform sends no mail and runs on. Put the line right as in [step 16](#16-send-sign-in-mail), check it with `./cpanel.sh admin mail-check`, and restart |
| The log says `mail: a sign-in mail could not be sent` | The mail was not handed to the mail server; the word in brackets says why. Send a test mail as in [step 16](#16-send-sign-in-mail), step 5, which prints the same word in brackets. `refused` there can also mean that 16 mails were already waiting in the app, one waited 30 seconds, or the app's mail thread stopped while it was on its way; `failed` is any other failure |
| The log says `mail: an email-change mail could not be sent` or `mail: an email-change notice could not be sent` | The link to a new address, or the notice to an old one, was not handed over, for the reason in brackets, as in the row above. The address change itself is not affected: the person asks for the link again |
| The log says `email: the hourly limit of email-change mails was reached; no email-change link was sent` | The site mailed 30 email-change links in this hour. The next hour sends again |
| The log says `mail: the mail thread could not start` | The part of the app that sends mail did not start, so no mail was sent, whatever the mail server would have said. With `it stopped before it was ready` in brackets, the app's files are probably incomplete: update again from a newly unpacked archive, as in [step 9](#9-updates). With `it was started 5 times in the last minute`, the thread keeps stopping: read the log lines before it. With `it could not be made`, Node.js could not make a thread at all, which points at the account running out of memory or processes |

`./cpanel.sh status` shows the installed version, the folders, the size of the data folder, the newest backup and the health in one place. It changes nothing.

## 14. A second address for the app

The platform can answer on two names instead of one: the address of the tours, `tours.example.com`, and a second address for the app, `app.example.com`. This is optional. With one address, which is what the steps above set up, everything works as described there.

| Address | What answers there |
|---|---|
| `tours.example.com`, the tours address | The tours and their pictures, the setup wizard, and the token API that Mythicshot uses |
| `app.example.com`, the app address | The token API. A link to a tour or a picture is sent on to the tours address. The setup wizard is not there |
| Any other name that reaches the app | Nothing: the platform refuses it with an empty answer, status 421 |

> [!WARNING]
> A wrong name in either of the two lines of step 4 makes the platform refuse its own address, tour links included, and one line without the other stops it from starting. Removing both lines and restarting brings one address back.

Do the steps in this order. Steps 0 to 3 change nothing about the addresses; the platform goes over to two addresses with the restart in step 5.

0. First update to a version that has this section, without the `--app-domain` option, as in [step 9](#9-updates), and see that `./cpanel.sh status` shows the health as ok. That update makes a backup before it changes anything, as in [step 10](#10-backups), so the backup to go back to exists before any step below. An older version ignores the two lines of step 4, so a mistake in them would show nothing now and would stop the platform at some later update. Only then go on.
1. Create the subdomain `app.example.com`, as in [step 2](#2-create-the-subdomain). The script creates no domain and changes none; this step and the next are yours.
2. Attach it to the same Node.js app. **Unconfirmed:** whether your hosting lets one Node.js app answer for a second name, and where that is set; this has not been tried on real hosting. One thing to try is to give the new subdomain the same document root as `tours.example.com` when you create it, so that the hosting applies the app's settings to both names. If your hosting has no way to do it, ask your hosting provider and stay with one address.
3. Wait for its certificate, as in [step 8](#8-https). The second name needs one of its own.

**How to tell the first three steps worked:** `https://app.example.com/healthz` opens in a browser without a warning and shows `{"ok":true}`. That is the platform answering on the new name, still with one address. If it shows a page from the hosting instead, the name is not attached to the app yet: do not go on.

4. Add the two lines to the settings file. Open the file in a text editor and add the two lines at the end, with your own names in lowercase, without `https` in front and without a path. Change nothing else, and save.

```sh
nano ~/apps/tours-config.env
```

```text
TOURS_HOST=tours.example.com
APP_HOST=app.example.com
```

5. Restart the app.

```sh
touch ~/apps/tours/tmp/restart.txt
```

6. Check both addresses, right after the restart and before you do anything else. The script asks each one and looks for the role the platform reports for it.

```sh
cd ~/apps/tours && ./cpanel.sh status --app-domain app.example.com
```

**How to tell it worked:** the status shows `health of the tours address: ok` and `health of the app address: ok`. In a browser, `https://tours.example.com/healthz` shows `{"ok":true,"address":"tours"}` and `https://app.example.com/healthz` shows `{"ok":true,"address":"app"}`. If the status says the platform does not see an address as its tours or its app address, see [step 13](#13-troubleshooting).

**Let the script remember it.** The `status` command checks and records nothing. To have every later update and every status check both addresses without the option, run one update with the option, from an unpacked archive as in [step 9](#9-updates); the version that is already installed will do. Before it asks or changes anything, that update asks both addresses for their roles, once each. If either does not report its own, it stops, prints the two lines and changes nothing. Only when it has finished and its check has passed does it write the app address to its own file, `.cpanel-install` in the app folder. It never changes the settings file. Like every update, it replaces `dist.old` with the version it found running, so when that is the version already installed, the copy of the version from before step 0 is then only in the backup that step 0 made.

```sh
./cpanel.sh update --app-domain app.example.com
```

If a later check finds that both addresses answer but one does not report its role, the update says so and prints the two lines again. It then shows no commands to go back, because the new version is not at fault.

**A new install.** The install does not take the option, and says so: the second name can only be attached once the Node.js app exists. Install with one address, as in [step 5](#5-install-the-platform), and then follow the steps above.

**An install that has one address today.** Moving it is the steps above, and their order is what keeps it reachable. Start with step 0: the installed version must know the two lines before they are added. Its update makes the backup, so there is one from before anything was changed; if the installed version already has this section and you skip the update, make a backup yourself before step 1, as in [step 10](#10-backups). Do steps 1 to 3 while the platform runs as it does: they change nothing for the tours address, and until the two lines are there the platform answers on the new name exactly as on the old one. Only then do steps 4 to 6; the restart is a short moment in which the platform does not answer, and step 6 comes right after it. What you give as `--domain` stays `tours.example.com`, the name the tours were published at, so every link that is out there keeps working, and Mythicshot keeps the address it has.

**The way back.** Remove the two lines from the settings file again and restart: the platform answers on one address as before.

```sh
nano ~/apps/tours-config.env
```

```sh
touch ~/apps/tours/tmp/restart.txt
```

If the script has remembered the app address, also remove the line that starts with `APP_DOMAIN=` from its own file, which holds nothing secret, so that it checks one address again. Then check.

```sh
nano ~/apps/tours/.cpanel-install
```

```sh
cd ~/apps/tours && ./cpanel.sh status
```

The subdomain `app.example.com` can stay or be removed in cPanel. With one address the platform answers on every name the hosting sends to it.

## 15. Make yourself the admin

The version with accounts brings sign-in with a link sent instead of a password, and the dashboard behind it. A site that was updated keeps working exactly as before: its tours, their links and its tokens are not changed, and nobody can sign in until the site has an admin. The admin is made once, by a command run on the hosting. There is no web page for it, and the setup code plays no part in it.

1. Update to a version with accounts, as in [step 9](#9-updates), and see that `./cpanel.sh status` shows the health as ok.
2. Run the command from the installed copy of the script, with your own email address and the username you want. The account that set up the site becomes the admin, with that address in place of the one typed in the setup wizard. Should the site's workspace hold several accounts, the oldest of them is the one made admin.

```sh
cd ~/apps/tours && ./cpanel.sh admin --email you@example.com --username yourname
```

It prints this, with your username and a link of your own:

```text
The admin account "yourname" was created.
Your tours, their links and your tokens stay exactly as they are.

Open this link within 15 minutes to sign in:
https://app.example.com/signin/link#…
```

3. Open the link in your browser and press "Sign in". It works once and for 15 minutes; the press lands you on the dashboard's Tours page, `/tours`. With two addresses it is on the app address; with one address it is on the name in a `SITE_HOST=tours.example.com` line of the settings file. Without either, the command prints only the part after the address, `/signin/link#…`, and you put your site's address in front of it.

> [!WARNING]
> The link signs in whoever opens it first, like a password for 15 minutes: open it in your own browser and never paste it into a chat, a ticket or a file.

**How to tell it worked:** the command prints the lines above, ending with the link. If it says `The admin was made, but no link was made. To get one, add the line RECOVERY_LINKS=on to the site's settings file, run the command again with --email alone, then remove the line.`, the admin exists and only the link is missing: get one as described below. Run the first command again and it says `This site already has an admin. Nothing was changed.`: there is only ever one first admin, and the command changes nothing the second time. A username is 3 to 30 lowercase letters, digits and hyphens and starts with a letter; a reserved name such as `admin` is refused with its own sentence, and so is an address that is not one. Nothing is changed when it refuses.

Signing in normally is by a link sent by mail from the sign-in page, and needs no shell. The first admin's link above works once and for 15 minutes; making the admin is a one-time act, and the command is not a standing way in.

**A new sign-in link is a recovery tool.** If the first link was not used in time, or later whenever someone cannot get a mailed link because mail is not set up yet or does not arrive, turn the recovery setting on for one run: add the line `RECOVERY_LINKS=on` to the settings file, run the command with the address alone, then remove the line again. Without the line the command says `Recovery links are off. To get one, add the line RECOVERY_LINKS=on to the site's settings file, run this again, then remove the line.` and makes nothing. With it, the command prints the link here and nowhere else, never mails it, records it in the audit, and ends with `Remove the line RECOVERY_LINKS=on from the settings file now.`

```sh
nano ~/apps/tours-config.env
```

```text
RECOVERY_LINKS=on
```

```sh
cd ~/apps/tours && ./cpanel.sh admin --email you@example.com
```

Then open the settings file again, remove the line and save. The app itself never reads this setting, so it needs no restart either way.

The same command has more uses: `./cpanel.sh admin mail-check` says whether mail is set up without showing any setting (see [step 16](#16-send-sign-in-mail)), `./cpanel.sh admin change-email` changes an account's address while mail is off (see [Change an address on the server](#change-an-address-on-the-server)), `./cpanel.sh admin audit` shows the last sign-ins and admin changes, and `./cpanel.sh admin --help` lists them. Options of the script itself, such as `--app-root` or `--dry-run`, go before the command's own: `./cpanel.sh admin --dry-run first-admin --email you@example.com --username yourname` prints what it would run and runs nothing.

The command runs beside the running app, without a restart, and changes only the database: making the admin is one step that is written whole or not at all, and the link and its record in the audit follow it. It does not apply a database update itself: on a site that was not updated yet it says `The database is from an older version. Update the site first.` and changes nothing. If it says `This site's setup did not finish. Follow "If the setup did not finish" in the hosting guide, then run this again.`, see [If the setup did not finish](#if-the-setup-did-not-finish) below.

Through `./cpanel.sh admin` the command takes its settings from the settings file only: a setting exported in your SSH session, or entered in the environment screen of the hosting's **Setup Node.js App** page, is not seen by it. Run any other way on shared hosting, the recovery setting is off unless someone deliberately fakes the app's own process.

The recovery setting keeps the command from being a standing way in to the site. It is not a defence against someone who already controls the hosting account: whoever can change the settings file or the data folder can change the site directly.

> [!WARNING]
> Never open the database with the hosting's `sqlite3` tool: on many hosting accounts it is older than 3.37 and cannot read the platform's tables, so use only the script and the app, which use the app's own Node.js.

### If the setup did not finish

The command says this when the setup record names a workspace that has no account in it, for example after a manual change to the data or after an older version of the platform, so the site has nobody to make admin. Restoring a backup from before that change is the first choice: restore it as in [step 11](#11-restore-from-a-backup).

Without such a backup, the setup can be started again on an empty database. That is safe only if Mythicshot was never used to upload a tour to this site: the old files are kept, but any tours in them would be missing from the live site until the files are moved back. The steps follow the order of the restore steps:

1. Stop the app: in cPanel, open **Setup Node.js App** and stop the app for `tours.example.com`.
2. Make a backup, as in [step 10](#10-backups).

```sh
cd ~/apps/tours && ./cpanel.sh backup
```

3. Move `db.sqlite`, `db.sqlite-wal` and `db.sqlite-shm` (the last two only when they are there) out of the data folder into a folder of their own, such as `~/apps/tours-data.before-setup`. Nothing is deleted.
4. Start the app again in **Setup Node.js App**. It makes a new, empty database.
5. Open the setup wizard with the setup code from the settings file, as in [step 7](#7-open-the-setup-wizard), then make yourself the admin as above.

## 16. Send sign-in mail

Until mail is set up, the sign-in page answers as usual but sends no link, and an email address cannot be changed from the dashboard. Signing in then works only with links printed by the command of [step 15](#15-make-yourself-the-admin). This step lets the platform send its sign-in mails through a mailbox of yours. The settings themselves are explained in [Mail](../../README.md#mail) in the README.

1. Have a mailbox to send from, such as `no-reply@example.com`, and its password. In cPanel, mailboxes are made on the page for email accounts. You also need the host name of its mail server for sending, such as `mail.example.com`, and the port where that server takes SMTP over TLS from the first byte, usually 465. Your hosting provider's help pages give both. **Unconfirmed:** whether your hosting lets an app send through port 465; ask your hosting provider if the test in step 5 says `connect` or `timeout`.
2. Open the settings file in a text editor and add these lines at the end, with your own values. Type the password yourself, in double quotes. Change nothing else, and save.

```sh
nano ~/apps/tours-config.env
```

```text
MAIL_MODE=smtp
MAIL_FROM=no-reply@example.com
SMTP_HOST=mail.example.com
SMTP_USER=no-reply@example.com
SMTP_PASSWORD="<password>"
SITE_HOST=tours.example.com
```

Add `SMTP_PORT=` and the port only when it is not 465. Leave out the `SITE_HOST` line when the platform has two addresses, as in [step 14](#14-a-second-address-for-the-app): sign-in links then use the app address.

3. Check the lines. The command reads the settings file as it is now, so this works before the restart, and it contacts nothing.

```sh
cd ~/apps/tours && ./cpanel.sh admin mail-check
```

It should say `Mail is set to SMTP: host, port, user, password and sender are set.` If it says `Mail is off because` and a setting's name, that line is missing or not usable: put it right and check again.

4. Restart the app, so that it reads the new lines.

```sh
touch ~/apps/tours/tmp/restart.txt
```

5. Send one test mail to an address of yours. It goes from the command straight to the mail server.

```sh
cd ~/apps/tours && ./cpanel.sh admin mail-check --send-to you@example.com
```

**How to tell it worked:** the command ends with `A test mail was handed to the mail server for you@example.com.` and the mail arrives. Then open `https://tours.example.com/signin` (with two addresses, the app address), type the admin's address and press the button: the sign-in mail arrives within a few minutes. If the command says `The mail server did not take the test mail`, the word in brackets says why: `auth`, the user or the password is wrong; `connect` or `timeout`, the host name or the port, or the hosting does not let the app reach that port; `tls`, the mail server did not prove who it is, and its certificate must match the name in `SMTP_HOST` exactly, so use the host name the certificate is issued for, never an IP address; `refused`, the mail server turned the mail down or broke off the conversation; `unknown`, something else failed. A mail that was handed over but does not arrive is often in the spam folder: see [Mail records](../../README.md#mail-records) in the README.

> [!WARNING]
> Every backup the script makes holds a copy of the settings file, the mailbox password included: keep each backup as private as the file, and change the mailbox password if one leaves your hands.

To switch mail off again, change the first line to `MAIL_MODE=off` and restart as in step 4.

### Change an address on the server

When an account's email address is wrong and mail is off, so it cannot be changed from the dashboard, the command changes it directly. Like a new sign-in link, it works only while the recovery line is in the settings file.

1. Add the line `RECOVERY_LINKS=on` to the settings file, as in [step 15](#15-make-yourself-the-admin).

```sh
nano ~/apps/tours-config.env
```

2. Run the command with the account's username and the new address.

```sh
cd ~/apps/tours && ./cpanel.sh admin change-email --username yourname --email new@example.com
```

It prints `The account "yourname" now signs in with new@example.com.` and `Remove the line RECOVERY_LINKS=on from the settings file now.` Without the line it says `Changing an email address here is off. To do it, add the line RECOVERY_LINKS=on to the site's settings file, run this again, then remove the line.` and changes nothing.

3. Remove the line from the settings file again and save. The app needs no restart either way.

> [!WARNING]
> The command sends no mail, to the old or the new address, and takes effect at once: check the username and the address twice, because a wrong address leaves the account with no way to sign in by mail.

**How to tell it worked:** the command printed the two lines above. The account's open sign-in links stop working, and it signs in with the new address from now on; while mail is off, get it a link as in [step 15](#15-make-yourself-the-admin). When it changes nothing, it says why in one line: `No account has that username. Nothing was changed.`, `That email address belongs to another account. Nothing was changed.`, `That is already the account's email address. Nothing was changed.` or `That is not an email address. Nothing was changed.`

## What has been run where

**Run by hand on real hosting,** on one shared cPanel account at one provider (CloudLinux, with the app run by Passenger):

- Creating the Node.js app with `cloudlinux-selector create`, with the same options the script uses.
- The layout: the app in `apps/tours`, the data in `apps/tours-data`, the settings in `apps/tours-config.env` with mode 600, outside the app folder and the web root.
- A startup file that reads the settings file and then loads the app. The `app.cjs` in the archive is a hardened version of it.
- `npm ci --omit=dev --ignore-scripts` inside the app's Node.js environment, and the restart through `tmp/restart.txt`.
- An update by hand: backing up the database, `drafts`, `public` and the old app files, moving `dist` and `migrations` to `dist.old` and `migrations.old`, unpacking the new ones, installing the packages, restarting and checking `/healthz`.

**Run by the script on real hosting,** once, on that same account, with Bash 4.4 and the version of the script from before the second address:

- The archive from `npm run package:cpanel`, unpacked on the hosting.
- `./cpanel.sh update` with `--domain`, over the install that had been made by hand: first as a dry run, then for real. It made its backup with the app's own Node.js, the consistent copy of the database and the check of that copy included, replaced the app files, `app.cjs` among them, installed the packages inside the app's Node.js environment, restarted the app and passed the health check.
- What `npm ci` does to `node_modules` in the app folder. That hosting keeps it as a link into the app's Node.js environment, and `npm ci` kept the link. Other hosting may differ, so the script still changes nothing about it: it only prints a warning when a link was there before `npm ci` and a plain folder is there after. If you see that warning, check that the app still starts and that its page in **Setup Node.js App** still opens without an error.
- The app's Node.js environment was where the script looks for it, for an app that had been created by hand with the same options.
- `./cpanel.sh status`, from the installed copy.

**Tested only on a development computer,** never on real hosting:

- `./cpanel.sh install`, and `./cpanel.sh backup` run as a command of its own. The script's tests ([deploy/cpanel/test-cpanel.sh](../../deploy/cpanel/test-cpanel.sh)) replace `cloudlinux-selector`, `npm`, `node`, `sqlite3`, `curl` and `touch` with stand-ins that record what would be run.
- The request for the API's status code after a health check that passed. It was added after the run on real hosting.
- The database copy made with the `sqlite3` tool, which is used only where the app's Node.js is not found. It was only run against a stand-in.
- Resuming an update that was cut off, and the commands to go back. Both were run against stand-ins, with the cut made at the points the tests can reach.
- The second address of [step 14](#14-a-second-address-for-the-app): the `--app-domain` option, the check before an update records it, and the check that each address reports its own role. All of it was run against stand-ins only.
- `./cpanel.sh admin` of [step 15](#15-make-yourself-the-admin): the script's part was run against stand-ins, and once with a real Node.js and the real `app.cjs` in front of a stand-in command; the command itself was run against a real database on a development computer only. The backup that refuses a `sqlite3` tool older than 3.37 was run against a stand-in.
- Sending mail, in [step 16](#16-send-sign-in-mail): the mail client and the thread it runs in were run only against a fake mail server on a development computer, and no mail has been sent through this guide's steps on real hosting.
- The restore steps in [step 11](#11-restore-from-a-backup), and the labels of cPanel's pages and buttons throughout, which are written from memory of cPanel and may differ at your provider.

**Not yet confirmed on real hosting,** in the order to check them on the first real install:

1. That `cloudlinux-selector create` answers the way the script expects when it succeeds and when it refuses.
2. That the app's Node.js environment is at `/home/you/nodevenv/apps/tours/24/bin/activate` right after the script creates the app, as it was for the app created by hand.
3. That one Node.js app can answer for a second subdomain, and that the host name reaches the app unchanged. [Step 14](#14-a-second-address-for-the-app) marks the step; the script creates no domain and only checks the result.

The files this guide describes are [deploy/cpanel/cpanel.sh](../../deploy/cpanel/cpanel.sh), [deploy/cpanel/app.cjs](../../deploy/cpanel/app.cjs) and [scripts/package-cpanel.ts](../../scripts/package-cpanel.ts).
