# Changelog

Every merged fix or update gets the next version number (0.1.1, 0.1.2, and so on) and one entry here, newest first.

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
