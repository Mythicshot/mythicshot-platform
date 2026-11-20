# Changelog

Every merged fix or update gets the next version number (0.1.1, 0.1.2, and so on) and one entry here, newest first.

## 0.1.18 (2026-11-19)

- Guides for switching mail on, accounts and signing in, the dashboard, changing an email address, and what to do when mail does not arrive or someone is locked out.
- When the mail thread cannot start, the log says so in one clear line.
- An update on Cloudflare keeps the `INVITE_CONTACT` setting.

## 0.1.17 (2026-11-19)

- Dashboard, Admin page: the admin sees every account with its workspace's name and storage use, and can set one workspace's storage allowance. The admin never sees anyone's tours or content, and nobody else sees this page.
- A warning before saving an allowance of 0, or one at or below what the workspace already uses.

## 0.1.16 (2026-11-19)

- Dashboard, Account page: your details and the browsers you are signed in on, with sign out for one or for all.
- Changing your email address: the new address gets a link, and the address changes only when you confirm it while signed in. The old address gets a notice.
- The answer is the same whether or not the new address already belongs to an account.
- On a site without mail, the admin can change an account's address with a command on the server, while `RECOVERY_LINKS=on` is set.
- After signing in you land on the Tours page.

## 0.1.15 (2026-11-19)

- Dashboard, Storage page: how much room the workspace uses of its allowance, what takes the room, and the largest tours with a way to delete them.

## 0.1.14 (2026-11-19)

- Dashboard: signed-in people get a bar across the top and a Tours page, with each tour's link to copy, its status and size, and publish, unpublish and delete.
- The list is read again after any change that did not finish, so it never shows a tour that is already gone or offline.

## 0.1.13 (2026-11-19)

- The tour list gives each tour's size. Two new requests give a workspace's ten largest tours and, for the admin, the totals for the whole site.
- Sizes are written one way everywhere. The storage-full message rounds the room needed up and the room left down, so the two never read the same.

## 0.1.12 (2026-11-19)

- Sign-in pages on the app address: enter an email address, get a link, press one button to sign in. There is no password.
- An account page shows who is signed in, how much storage the workspace uses, and every browser that is signed in, with a way to sign out of one or of all.
- When a workspace is over its storage allowance, the account page says so and says what to do.
- A site can show a contact for invites on the sign-in page with the optional `INVITE_CONTACT` (an email address or an https address).

## 0.1.11 (2026-11-19)

- An admin can list accounts with the storage each workspace uses, and set one workspace's storage allowance, through the API. An admin cannot open another workspace's tours or content.

## 0.1.10 (2026-11-19)

- Sign-in by link: a link works once and for 15 minutes, only its hash is stored, and asking for one answers the same whether or not the address has an account.
- Sessions: a browser stays signed in for 30 days of use, in a cookie that scripts cannot read, and every change made from a browser is checked against cross-site requests.
- Mail: the site can send sign-in links through a mail server over TLS (`MAIL_MODE=smtp` and the `SMTP_` settings). Mail is sent from a separate thread so it cannot slow other requests.
- The first admin is made with one command on the server, which prints a sign-in link. Later recovery links are off unless the site sets `RECOVERY_LINKS=on`.
- A script rehearses an update on a copy of a site's data and compares before and after.

## 0.1.9 (2026-11-19)

- Accounts: the database can hold users, workspace memberships, sign-in methods, sessions and an audit log. Existing tours, links and tokens are unchanged.
- Limits on how often sign-in can be asked for, per address, per network and for the whole site.
- A test suite holds every request to its own workspace: one workspace's token or session can never read or change another's.

## 0.1.8 (2026-11-19)

- Storage allowance: a site can set how many bytes each workspace may use, with `STORAGE_ALLOWANCE_BYTES`. It is off unless the site sets it.
- An upload that would take a workspace past its allowance is refused before anything is stored, with a clear message that says how much room is needed and how much is left. Nothing is ever deleted because of an allowance.
- `GET /api/v1/usage` shows what a workspace uses and what its allowance is.
- An upload can say the size of its logo with an optional `logo_bytes`, so an unchanged update of a tour with a logo needs no extra room.
- Two copies of the app starting together during an update no longer trip over a database change.
- With no allowance set, everything works as before.

## 0.1.7 (2026-11-18)

- API documentation: the site has a public page at `/docs` with every request a token can make, a box to try them with your own token, and three guides with commands to copy.
- The API is described in the OpenAPI format, to download as JSON or YAML, so other software can build a client from it. Tests hold the description equal to what the site really answers.
- A token pasted on the page stays in that browser tab only, is sent only to the site itself, and is wiped when you press "Forget token".
- With two addresses, the page lives on the app address; `/docs` on the tours address leads there.

## 0.1.6 (2026-11-18)

- The tour list says for each tour whether changes are waiting to be published, so an app can offer to publish them.

## 0.1.5 (2026-11-18)

- Two addresses: the site can serve tours on one address and keep a second address for the app. With neither set, everything works as before.
- With two addresses, tour pages and pictures are served only on the tours address; a tour link opened on the app address is sent on to the tours address; any other host name is refused.
- A wrong or half-set pair of addresses stops the site from starting instead of half-working, and the health check reports which address is which.
- The install script and the cPanel script can set up and check a second address, and stop with nothing changed when it is not ready. The cPanel script now also notices a site that refuses its own address.
- New sections in the README, the Docker and Cloudflare runbooks and the cPanel guide. Nothing about two addresses has been run on real hosting yet.

## 0.1.4 (2026-11-18)

- Replace a chapter of a tour over the same link: the app sends a fingerprint of each picture and uploads only the ones the site does not have yet.
- Nothing public changes until a publish completes. An update of a draft stays a draft, and an update is not published by itself when another chapter still has unpublished changes.
- Updating a tour's first chapter also updates its cover, theme, logo, buttons and end card. The title and the link never change.
- Pictures that no step uses any more are removed in small steps, never while a publish still needs them.
- A publish that starts just as the draft changes starts again by itself instead of failing.

## 0.1.3 (2026-11-18)

- cPanel shared hosting is a supported route: `npm run package:cpanel` builds one archive to upload, and `cpanel.sh` on the hosting does install, update, backup and status.
- An update takes a backup first, keeps the previous version beside the new one, and prints the commands to go back if the site does not answer afterwards. A cut-off update can be run again.
- The setup code is written to a private settings file and never shown on screen.
- New guide: `docs/hosting/cpanel.md`. The script has been tested against stand-ins only; the steps it automates were done by hand on real hosting.

## 0.1.2 (2026-11-18)

- Tunnel mode: a new tunnel token is tried first and saved only once the tunnel connects. If the change fails or is interrupted, the site is started again on the previous token.
- Changing the token on a machine with no install, or on an install that does not use a tunnel, stops early and says which command to use.
- An install whose tunnel never connected stays marked as unfinished after an update, and the update says what to do.
- Clearer messages when the install script asks for the token again.

## 0.1.1 (2026-11-18)

- Rename a tour: the title changes on the public page, and the link stays the same.
- Delete a tour: it leaves the list and its page goes offline at once; its files are removed in small steps that also fit Cloudflare's free plan.
- The tour list now includes each tour's link, status and dates.
- The site reports its version to a signed-in app.

## 0.1.0 (2026-11-18)

Everything built so far, in the order it was added.

### Core (2026-11-17)

- One codebase for two targets: Cloudflare and a Node server, behind two ports.
- Database schema, API tokens and workspaces.
- Checks on uploaded tour descriptions and images.
- Upload API, the tour list and draft images.
- Publish, unpublish and published images; deleting an already deleted file is not a failure.
- Publishing works in small steps so it fits Cloudflare's free plan.
- The hosted player page for a published tour.

### Setup and hosting (2026-11-17)

- First-run setup wizard.
- Container image and stack with automatic HTTPS.
- Install script for Debian 13 and 12: install, update, backup, status, uninstall.
- README, licence notice and runbooks for Docker and Cloudflare, corrected after a local Cloudflare run.
- Guided Cloudflare setup (`npm run setup:cloudflare`) with explicit confirmations before it takes over an address or existing resources.

### Hosting guides and tunnel (2026-11-18)

- Step-by-step guides for DigitalOcean, AWS Lightsail, Azure, Akamai/Linode, Namecheap VPS and Fly.io, with a Fly.io template.
- The install script can run behind a Cloudflare Tunnel with no ports open.
