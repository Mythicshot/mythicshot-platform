# Changelog

Every merged fix or update gets the next version number (0.1.1, 0.1.2, and so on) and one entry here, newest first.

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
