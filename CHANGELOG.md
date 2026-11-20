# Changelog

Every merged fix or update gets the next version number (0.1.1, 0.1.2, and so on) and one entry here, newest first.

## 0.1.32 (2026-11-20)

- Invites, through the API. The site's admin invites an address with `POST /api/v1/admin/invites` (`{"email": …}`), lists the invites that are open or ran out with `GET /api/v1/admin/invites`, sends one again with a new link with `POST /api/v1/admin/invites/<id>/resend`, and cancels one with `DELETE /api/v1/admin/invites/<id>`. Only an admin's session reaches them; anyone else, any token included, gets the one 404 every admin route answers. The Admin page's invite box and the page the link opens come in a later version.
- The invite mail, "You are invited to Mythicshot", names the admin who sent it by username (or says "You are invited" without a name), and holds a link to `/invite` with a single-use code after the `#`, so it reaches no server log. The link works once and for 7 days, and the mail gives the last day in UTC. The code is stored only as a digest and is only ever sent in a request body.
- Inviting an address again, or resending, gives the same invite a new link, and the older link stops working at once. An address that already has an account is refused (`has_account`). An invite that ran out stays listed until it is cancelled or replaced, and is removed 30 days later.
- The page the link opens calls `POST /api/v1/invite/check` (the invited address, the inviter's username and the last day) and `POST /api/v1/invite/accept` with the chosen username, which makes the account, an empty workspace of its own named after the username with the site's standard allowance, and a session, all together or not at all, and sets the session cookie as finishing a sign-in does. Of two accepts of one invite only one makes an account, and of two people who choose one username at once only one gets it. A refused accept (`bad_username`, `username_taken`, `has_account`) leaves the invite working. Every code that cannot be used, whether unknown, used, cancelled, replaced or expired, gets the one `404 invite_invalid`. Both requests take no credential: a token is refused (`credentials_not_allowed`), and a browser signed in to any account is refused with `409 signed_in` rather than switched to another account.
- Sending an invite needs mail: on a site whose mail is off it is refused (`mail_off`) and nothing is stored; the list and cancelling still work. The mail is sent before the answer: when it cannot be handed over, the invite stays and the answer is `502 mail_failed`, and resending it tries again.
- Limits: an admin sends at most 20 invites an hour, resends included; the site sends at most 30 invite mails an hour, on a cap of their own apart from sign-in's, and holds at most 100 invites (`too_many_invites`). A network looks up and accepts invites at most 30 times in 15 minutes, and callers whose network is not known share a bound of their own.
- The audit record has four new events: an invite sent, resent, cancelled and accepted. None holds a code or an address.
- The API description describes the six requests, and its guide to error codes names the new codes.
- Upgrading: this version needs its database change (migration 0012: the invite table). The Node server applies it when it starts, before it answers, and `npm run setup:cloudflare -- update` applies it before it deploys.

## 0.1.31 (2026-11-20)

- A mail when a new computer is connected: once Mythicshot has collected its token, the account that confirmed the request gets one plain-text mail at its address as it is then, "A computer was connected to your Mythicshot account", naming the computer in quotes and the day and time in UTC, saying that it can publish, change and delete everything in the workspace, and linking to the dashboard's Connections page to disconnect it. Without an address for links the last line says, in words, to open the Connections page of the dashboard and disconnect it there.
- The computer's name stays on its one line in the mail whatever it holds: a character that could end or hide a line becomes U+FFFD, so it can add no header or line, even though the API already refuses such names. It is also made inert in the mail, so it can neither pass for the site's own words nor become a link: every quotation mark becomes an apostrophe, `://` becomes `:/ /`, `www.` becomes `www .` and an at sign becomes ` at `. Then the name is cut at 60 characters. The dashboard still shows names as they are.
- Only the collection that made the token sends it, after the database has kept the token: a collection that fails, or the second of two at once, sends nothing, so there is one mail per token. It goes after the answer, and the answer is the same whether mail is off, the mail server refuses, the mail waits or a limit is reached. A site without mail, as every Cloudflare install in this version, makes no call for it.
- Limits of its own, apart from sign-in's and email change's: 5 such mails a day per account, and 30 an hour for the site. A mail that is not sent (over a limit, an address that cannot be used, a mail server that refuses) is never tried again and is one new audit event, `connection_mail_not_sent`, with the request and a word for why, never the address.
- The README, the API description and the Docker runbook's audit table say so.

## 0.1.28 (2026-11-20)

- Upgrade rehearsal: the check of two new builds started at the same moment no longer fails on every update to 0.1.26 or later. Every build now runs with `CLIENT_ADDRESS_HEADER=X-Forwarded-For`, and every request the rehearsal sends carries that header with a documentation address, as behind a site's proxy, so a build no longer writes its line asking for the setting. Builds before the setting (0.1.7, 0.1.8) read neither, so nothing changes for them.
- Upgrade rehearsal: when that check fails, the report names each distinct error line once: one of the app's own fixed messages word for word, any other line only by its length, since it could hold data.

## 0.1.27 (2026-11-20)

- Dashboard, Connections page: a new tab between Storage and Account lists the computers where Mythicshot can publish to the workspace, each with "Signed in from Mythicshot" or "From setup", the day it was connected and the day it was last used ("Today", a date, or "Never"), and "Rename" and "Disconnect". Both ask first, and the list is read again however they end, so it always shows what is true.
- The "Connect Mythicshot" card takes the code Mythicshot shows, in any case, with or without the dash. A code that cannot be one is refused in the page without a request. Continue names the computer and when it asked, and "Connect" or "Not me" settles that same code; closing the question leaves the request alone. After too many codes that did not work, Continue rests for the minutes the server gives. The code is only ever sent in a request body, never in an address, and is not stored.
- After "Connect" the list is read again a few times over about half a minute, until the new computer shows up once Mythicshot has collected its token.
- The question warns in one more line when the request may have come from a different network than the page's (the server also says so when either network is not known).
- When no answer comes back to "Connect" or "Not me", the page looks the code up once: if the request is no longer open the question closes with a note (after "Connect": the computer shows in the list if it was connected, and the list is watched; after "Not me": the code no longer works, and nothing is watched); if it is still open the question stays with the failure, so a second press never meets "does not work" by surprise.
- One question at a time: while a code is being looked up, the rows' "Rename" and "Disconnect" rest, and a lookup's answer never opens its question over another. A held Enter's repeats never press "Continue", "Connect" or "Not me".
- The name in the "Disconnect" question's title is kept apart from the quote marks around it, so right-to-left letters cannot reorder them.
- API description: the routes that take a session alone list the 403 answers `bad_origin` and `bad_csrf` that a change made with a session can get.
- The dashboard's shared script hands a page the answer's retry-after header, and writes a date with the year on request.

## 0.1.26 (2026-11-20)

- Connecting Mythicshot with a pair of codes, through the API. `POST /api/v1/connect/start`, sent with no credential, answers a long secret device code, a short code such as `ABCD-EFGH` and the dashboard's Connections page, `/connections` (on the address from the settings, never from the request). A signed-in person looks the short code up (`POST /api/v1/connect/lookup`, which shows the device's name, when it asked, and `same_network`: whether the person is on the network the app asked from) and confirms it (`POST /api/v1/connect/confirm`) or refuses it (`POST /api/v1/connect/refuse`). Mythicshot asks `POST /api/v1/connect/token` with the device code every 5 seconds and, once confirmed, receives a token for that person's workspace, once, with the confirming account's username (never its email address) so the app can show who connected it. The codes live 10 minutes and are never put in an address: every request takes them in its JSON body, and the lookup, like confirm and refuse, needs the session's anti-forgery header, so no other site can spend a person's wrong tries. The Connections page itself comes in a later version.
- The token is made when Mythicshot collects it, not when the request is confirmed: a confirmed request nobody collects leaves no token, and of two collections at once only one gets it. A request confirmed by an account that is then disabled cannot be collected, nor one whose confirming session has ended since (signed out, signed out everywhere, ended from another browser, or expired).
- Every device code that can give no token, whether unknown, expired, refused, already used or not a device code at all, gets the one answer `410 expired_code`. Asking again within the 5 seconds answers `429 slow_down`. A request that carries a token or a session cookie answers `400 credentials_not_allowed`.
- A network asks for at most 10 pairs of codes in 15 minutes and 40 in a day, has at most 5 waiting at once, and asks for tokens at most 360 times in 15 minutes. An account may try 5 short codes that name no waiting request in 10 minutes, and a network 20; a right code is not counted, and one account's wrong codes never lock another account out.
- The workspace's tokens, for signed-in people: `GET /api/v1/tokens` lists them with their name, when they were made and last used, and how (`setup` or `sign_in`), never any part of a token; `PATCH /api/v1/tokens/<id>` renames one; `DELETE /api/v1/tokens/<id>` revokes one, refused from its next request on. A token can call none of these.
- Node: while `CLIENT_ADDRESS_HEADER` is unset, the first request from a private or local address (the sign of a proxy in front of the app, behind which every visitor looks the same) makes the server write one line naming that setting, once until it restarts. Nothing else changes. The README, the cPanel guide and the Docker runbook say what to set.
- The audit record has five new events: a connection confirmed, refused and collected, a token renamed and a token revoked. None holds a code or a token.
- The API description has a Connections section, and its guide to error codes names the new codes.
- Upgrading: this version needs its database change (migration 0011: the request table, the install's key for the short codes, and a `kind` column on tokens, `setup` for every token there is). The Node server applies it when it starts, before it answers, and `npm run setup:cloudflare -- update` applies it before it deploys.

## 0.1.25 (2026-11-20)

- Dashboard, Images and GIFs pages: when a delete gets no answer, the page asks the item itself. Only the API's own "no such item" answer counts as deleted, not any 404 (one from a proxy, say); an item still online or still being sent, or no answer to that either, shows the failure, and "too many requests" says so in its own sentence. Before, an item that newer items had pushed off the pages shown could be reported deleted while it was still online.
- Dashboard, Storage page: an image's or a GIF's delete that gets no answer is decided the same way, by asking the item, no longer from the list of the largest items. Tour deletes are unchanged.
- Upgrade rehearsal: a JSON answer of the new build that only adds fields is allowed, counted as "differ only by added fields", and each added field is named once per route by its path, never with a value. Both bodies must be written exactly as plain JSON writes their values, and the new one with its added keys taken out must be the old one byte for byte. Every added key must be shaped like a field name (lowercase words joined by underscores, at most 40 characters); one of any other shape, such as an item id or a token, fails the answer and is never printed. A changed or removed value, a changed type or list length, or another status still fails, and an answer that is not JSON must still be the same to the byte. The way back stays strict.
- Upgrade rehearsal: a pass with added fields ends `RESULT: PASS, with N added fields to read above`, still with exit status 0, so that someone reads them before updating: a new field can also be a leak.
- Upgrade rehearsal: `--mode three` (or `REHEARSE_MODE=three`) adds the address for images and clips, `img.example.com`. An old build from before 0.1.19 runs with two addresses and the new one with three, and the report says so. With two or three addresses each address's health answer must name that address's own role, so a build that does not take `IMG_HOST` fails to start instead of passing as three addresses.
- Changelog: the missing 0.1.22 entry, and the 0.1.21 entry and the API description now say that the image and clip sizes are fixed in this version, with no setting to change them. The API description no longer says a setting can change the number of open uploads a workspace may have either: no setting fills it.

## 0.1.24 (2026-11-20)

- Dashboard, Storage page: images and GIFs count beside tours. The line shows how many images, GIFs and tours the workspace has, what takes the room has GIFs and Images rows, and "Largest items" lists all three kinds together, each marked Tour, Image or GIF.
- "Delete" works for every kind on the Storage page. An image or a GIF gets its own question and is removed through the shared items API.
- `GET /api/v1/usage` adds `images` and `gifs` (items online) and, in `counted`, the bytes of images and of GIFs, split from the items' share of `used_bytes`. An item still being sent counts there, and one being deleted until its files are gone. The numbers in `counted` add up to `used_bytes`.
- `GET /api/v1/usage/largest` adds `largest`: the ten largest tours, images and GIFs together, each with its kind. The `tours` list is unchanged.
- The admin's list shows the bytes of images and of GIFs as two totals, and nothing else of anyone's items.
- Dashboard, Images and GIFs pages: the line under the heading shows the whole count and size from the first load ("48 images in <workspace> · 64 MB used"), and again after a delete, even while "Show more" has more to load.

## 0.1.23 (2026-11-20)

- Dashboard, Images and GIFs pages: the workspace's shared images and clips, newest first, each with a small preview, its size, the day it was shared and its link. "Copy link", "Open" and "Delete", and "Show more" past the first 50.
- Delete asks first, and the list is read again afterwards so it always shows what is true.
- The bar now reads Images, GIFs, Tours, Storage, Account and Admin. Signing in still lands on Tours.

## 0.1.22 (2026-11-20)

- This number's work, counting images and GIFs in a workspace's storage, was released as part of 0.1.24.

## 0.1.21 (2026-11-20)

- A shared image or clip has its own page at its link: the picture as large as it fits, or the clip playing in a loop without sound, with its title, size and date, "Open full size" or "Open file", and "Download". The page never says who shared it.
- Chat apps that preview links show the picture and the title.
- A link to an item that was deleted, is not finished, or belongs to a disabled account shows one "This link no longer works" page, the same as a link that never existed.
- Clips can be watched from any point, and a file is read only as far as it is played.
- The most bytes of a shared image or clip stay at their defaults (10 MB and 50 MB): no setting changes them in this version. Should a later version add such a setting, a value above 76,000,000 bytes (38 parts of 2,000,000 bytes) would be refused at start, because a larger file could not be sent in one answer within the limit of storage and database calls a request may make. An item already stored with more parts than that answers "This link no longer works".

## 0.1.20 (2026-11-20)

- Shared items, through the API: a workspace can share a single image (PNG or JPEG, up to 10 MB) or a short clip (GIF or MP4, up to 50 MB). An item is sent in parts of 2,000,000 bytes, with an optional preview picture, and is online once it is finished. It stays until it is deleted.
- The first part is checked against the declared type, and for a PNG, JPEG or GIF against the declared width and height, from the file's own bytes.
- Items count against the workspace's storage allowance from the moment they are started, together with tours and uploads. One that does not fit is refused before anything is sent.
- A workspace starts at most 60 items, sends at most 2,000 parts and 240 previews an hour. An item that is not finished within a day can no longer be finished and is removed.
- Items are kept in the private store and are only ever served through the site. Once an item is online, nothing it serves can change. A deleted item counts toward the allowance until its files are really gone: when a part is still being sent at that moment, the delete answers `cleanup_pending` and is sent again.
- A part or preview whose sending was cut off counts toward the allowance until it is cleaned up, at most four such sends are kept per item, and they are removed five minutes later by the item's next send, its commit, or the next sweep. A send that lost its place on an item that is still open answers 409 `superseded`, so it can be sent again.
- Upgrading: this version needs its database change (migration 0010) before it serves, because reading a workspace's storage use reads the new table. Both ways of installing do this already: the Node server applies new migrations when it starts, before it answers, and `npm run setup:cloudflare -- update` applies them before it deploys.

## 0.1.19 (2026-11-20)

- An optional third address for shared images and clips, set with `IMG_HOST` beside `TOURS_HOST` and `APP_HOST`. Without it they answer on the tours address, and sites with one or two addresses work as before.
- The third address answers only images, clips and the health check, and never takes a sign-in or a token. No image or clip is shared yet: that comes in a later version.
- The cPanel guide, the README and the Cloudflare runbook say how to add it; the Docker installer does not set it up yet.

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
