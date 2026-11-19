# Browser check of the sign-in pages

The tests run the pages' script against a stand-in document, and against the real app in the same process, but they cannot open a browser. This list is what a person goes through by hand before the pages are called done: once in Chrome and once in Firefox, each with the developer tools open. Write down for each step whether it passed, and for anything that did not, what the page showed.

Chrome and Firefox treat `http://localhost` as a secure address and keep the session cookie, which is marked `Secure` and named with the `__Host-` prefix. Another browser may refuse that cookie on plain `http://localhost`: signing in then lands on `/account` and goes straight back to `/signin`. That is the browser, not the site; note it if you try one.

> [!warning] Use a scratch site only
> Everything here runs on `localhost` with a scratch data folder inside the computer's temporary folder. The link tool in step 4 refuses anything else; never point any of these commands at a real site's data folder.

## Set up

1. Build: `npm run build`.
2. In a first terminal, make a scratch data folder inside the temporary folder and a setup code, and show both. Keep the two lines it prints: the folder is needed in the second terminal, the code in the wizard.

   ```sh
   export DATA_DIR="$(node -p "require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'signin-check-'))")"
   export SETUP_CODE="$(openssl rand -hex 16)"
   export SITE_HOST=localhost:3000
   echo "DATA_DIR=$DATA_DIR"
   echo "SETUP_CODE=$SETUP_CODE"
   ```

3. Start the site in the same terminal. The server listens on every network interface of the machine, so do this on a machine whose firewall keeps port 3000 to itself.

   ```sh
   node dist/node/entry.js
   ```

   Open `http://localhost:3000/setup`, type the setup code shown in step 2, finish the wizard with the owner email `owner@example.com`, and keep the token it shows (a test token of this scratch site only).
4. In a second terminal, set the same folder and address, and make the owner the admin. The command prints the first sign-in link; keep it for "The link page".

   ```sh
   export DATA_DIR="<the folder step 2 printed>"
   export SITE_HOST=localhost:3000
   node dist/node/admin.js first-admin --email owner@example.com --username checker
   ```

   Mail is off on this site, so the sign-in page never sends a mail. Every further link comes from the test tool `scripts/local-signin-link.ts`, run in this second terminal. It is not part of the site and not in any package; it prints a link only when the link address is `localhost`, a `.localhost` name or `127.0.0.1` and the data folder is inside the temporary folder, and refuses everything else:

   ```sh
   node scripts/local-signin-link.ts --email owner@example.com
   ```

## Ask for a link

- [ ] `http://localhost:3000/signin` shows the card with the small line "Mythicshot", the heading "Sign in", the lead, the field "Email address" with the placeholder `you@example.com`, the button "Send me a sign-in link" and the line "Mythicshot is invite-only for now." with nothing after it (no `INVITE_CONTACT` is set). The cursor is in the field.
- [ ] Restart the server with `INVITE_CONTACT=hello@example.com`: the line reads "Mythicshot is invite-only for now. Ask for an invite: hello@example.com", the address can be selected and is a mail link. With `INVITE_CONTACT=https://example.com/invite` it reads "Mythicshot is invite-only for now. Ask for an invite", a link to that address. With `INVITE_CONTACT=javascript:alert(1)` the sentence stands alone and the site starts as usual. Restart without the setting afterwards.
- [ ] The console shows no error and no policy violation ("Refused to …" or "Content Security Policy"); the network panel shows only requests to `localhost:3000`: the page, its stylesheet and its script (both under `/signin/`) and `GET /api/v1/session` (answering 401).
- [ ] In the network panel, the page's answer has these headers: `content-security-policy: default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `cache-control: no-store`, `x-content-type-options: nosniff` and `cross-origin-opener-policy: same-origin`. The stylesheet, the script, `/signin/link` and `/account` carry the same six.
- [ ] "name" and an empty field each give "That does not look like an email address." under the field, with no request in the network panel, and the field is marked as wrong. The button does not move when the message appears.
- [ ] `owner@example.com` shows "Sending…" on the button for a moment, then "Check your mail" with "If owner@example.com has an account, a sign-in link is on its way. It works once and for 15 minutes." The request was `POST /api/v1/signin/request` with the body `{"email":"owner@example.com"}`, `content-type: application/json` and `Origin: http://localhost:3000`.
- [ ] `nobody@example.com` gives exactly the same screen: the page does not say whether an address has an account.
- [ ] An address holding markup, such as `x<b>bold</b>@example.com`, appears as typed, angle brackets included, never in bold.
- [ ] "try another address" goes back to the form with the cursor in the field, without loading the page again.
- [ ] Eleven requests within 15 minutes from this machine are not limited (a loopback address is no network to count), so "Too many requests. Wait a few minutes and try again." cannot be seen here; note that it was not checked by hand.
- [ ] With the server stopped, the button gives "Something went wrong. Try again in a moment." and comes back. Start the server again.

## A slow network

Set the network panel's throttling to its slowest preset ("Slow 3G" or "GPRS") for these, and back to none afterwards.

- [ ] On `/signin`, "Send me a sign-in link" reads "Sending…" and cannot be pressed while the request runs; pressing it again, and pressing Enter in the field, sends no second request.
- [ ] On the link page, "Sign in" reads "Signing in…" and a second press sends nothing.
- [ ] On `/account`, nothing of the account shows until it has all arrived, and then everything shows at once. A row's "Sign out", "Sign out" and "Sign out everywhere" each read "Signing out…" while their request runs, and a second press sends nothing.

## The link page

- [ ] Open the link from "Set up" step 4. The address bar shows `http://localhost:3000/signin/link` with no `#c=…` once the page has loaded, and the page shows "Finish signing in", "Press the button to sign in on this browser.", the button "Sign in" and "You stay signed in here for 30 days of use. If you did not ask for this link, close this page: nothing happens."
- [ ] The network panel shows no request to `/api/v1` before the press, and no request anywhere carries the code in its address or in a `Referer` header.
- [ ] Pressing "Sign in" shows "Signing in…", sends one `POST /api/v1/signin/complete` with the body `{"code":"dpl_…"}` and `Origin: http://localhost:3000`, and lands on `/account`. The answer's `Set-Cookie` is `__Host-dp_session=…; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000`.
- [ ] The Back button from `/account` never shows the link page with its code: the account page took the link page's place in the history, so Back goes to whatever was open before the link (or does nothing in a new tab). A long press on Back (the tab's own list) shows no address with `#c=` in it. Reloading `/account` keeps you signed in.
- [ ] After signing in, open the browser's own history page (Chrome: `chrome://history`; Firefox: Library › History) and write down exactly what it lists for the link: the address with `#c=…`, the address without it, or nothing. The page cannot take back what the browser recorded when it opened the link; the code is spent by then, and an unused one expires in 15 minutes, but the result decides whether the guide should say so.
- [ ] Open a new link, and before pressing, reload the page: it shows "This sign-in link no longer works" with no request, because the code left the address bar when the page first loaded. That link still works once if opened again from the terminal.
- [ ] Opening the same link again, in this browser or the other one, and pressing "Sign in" gives "This sign-in link no longer works", "A link works once and for 15 minutes. Ask for a new one and use the newest mail." and "Send me a new link", which goes to `/signin`.
- [ ] `http://localhost:3000/signin/link` with nothing after it, and with `#c=abc`, shows the same "This sign-in link no longer works" at once, with no request.
- [ ] An expired link: print a new one with the test tool, wait 16 minutes, open it and press "Sign in": "This sign-in link no longer works".

## The account page

- [ ] While `/account` waits for its first answer, and while it sends a visitor who is not signed in away, the tab's title is "Mythicshot"; once the account has arrived it is "Signed in".
- [ ] `/account` shows "Signed in as checker", `owner@example.com` under it, the label "Storage" with a line such as "0 bytes used · 0 tours" and no bar under the label (no allowance is set yet, so there is nothing to fill), the hint "Tours and their pictures count. Deleting a tour frees its space within a few minutes.", the label "Where you are signed in" with one row "This browser" before the browser and system and "since" today's day and month, the buttons "Sign out" and "Sign out everywhere" side by side, and "Tours are managed from Mythicshot for now. A dashboard is coming to this page."
- [ ] Sign in in the other browser too (a new link from the test tool). Reloading the account page in the first browser shows a second row with the other browser's name, "last used" with today's day and month, and a "Sign out" link.
- [ ] That "Sign out" link shows "Signing out…", sends `DELETE /api/v1/sessions/ses_…` with an `X-Csrf-Token` header and `Origin: http://localhost:3000`, and the row disappears. In the other browser, reloading `/account` goes to `/signin`.
- [ ] `/account` in a private window (nobody signed in) goes straight to `/signin`, and `/signin` while signed in goes straight to `/account`.

## Storage under, at and over the allowance

This needs one uploaded tour. With Mythicshot: connect it to this site with the wizard's token (Settings › Output › Tour publishing) and upload a tour; if it will not connect to an `http://localhost` address, use the site's own documentation page instead, `http://localhost:3000/docs`, whose guide "Upload and publish a tour" uploads one with the token and `curl`, no app needed.

Read the usage with `curl -s -H "Authorization: Bearer <token>" http://localhost:3000/api/v1/usage` and note `used_bytes`. Then stop the server in the first terminal and start it again each time with one more setting, such as `STORAGE_ALLOWANCE_BYTES=123456 node dist/node/entry.js`, and reload `/account` (the session survives the restart):

- [ ] No `STORAGE_ALLOWANCE_BYTES`: "<used> used · 1 tour" and no bar.
- [ ] `STORAGE_ALLOWANCE_BYTES` set to twice `used_bytes`: "<used> of <allowance> used · 1 tour" and the bar half full in the site's green.
- [ ] Set to exactly `used_bytes`: the bar full, still green.
- [ ] Set to `used_bytes` minus 1: the bar full in the warning colour (amber), and under the line "You are over your storage allowance. New uploads are refused until you delete tours or get more room." in the same colour. Under or at the allowance that sentence is not there.
- [ ] Sizes have at most one decimal and no trailing `.0`, counted 1024 to the next unit: `512 KB`, `14.2 MB`, `1.2 GB`, `5 GB`.

## Signing out

- [ ] "Sign out" shows "Signing out…", sends `POST /api/v1/signout` with an `X-Csrf-Token` header and `Origin: http://localhost:3000`, and lands on `/signin`; the answer clears the cookie (`Max-Age=0`). The other browser's session still works: its `/account` loads.
- [ ] Sign in again in this browser. "Sign out everywhere" sends `POST /api/v1/signout/everywhere` with an `X-Csrf-Token` header and `Origin: http://localhost:3000` and lands on `/signin`; in the other browser, reloading `/account` now goes to `/signin` too.
- [ ] After all of it, the Application (Storage) panel shows nothing of this site in local storage, session storage or IndexedDB, and the only cookie it ever had was `__Host-dp_session`.

## Keyboard, phone width and colours

- [ ] Every page works with the keyboard alone: Tab reaches the field, each button and each link in order, each shows a visible focus ring, and Enter in the email field sends the form.
- [ ] With a screen reader (or the accessibility panel), the messages under the field and on the account page are announced when they appear, and each row's "Sign out" names that row's browser.
- [ ] At 320 pixels wide (the developer tools' device mode) every page fits without a sideways scroll, a long email address wraps inside the card, and the two sign-out buttons stack when they do not fit side by side.
- [ ] With the system set to dark, every page is dark, with readable text and a visible focus ring; set to light, light.
- [ ] With JavaScript switched off, each page shows "This page needs JavaScript." under "Mythicshot"; the sign-in form sends nothing anywhere.

## Two addresses (optional)

The same pages on a site with two addresses. Chrome and Firefox send every name ending in `.localhost` to this computer; if yours does not, skip this part and note it. The repository's docs tests allow only placeholder host names in a guide, so the two names are described here rather than written out: for the tours address the word tours, and for the app address the word app, each followed by `.localhost:3000`.

1. Stop the server, unset `SITE_HOST` in both terminals, and set `TOURS_HOST` and `APP_HOST` to those two names in both. Make a new scratch folder and setup code as in step 2, and start the server.
2. The wizard is on the tours address only: open `/setup` there and finish it. Make the admin and print a link in the second terminal as in step 4; the link now names the app address.

- [ ] `/signin`, `/signin/link` and `/account` on the tours address answer `{"error":"not_found"}`; on the app address they work as above.
- [ ] Signing in through the printed link works, and the cookie is kept for the app address only: the tours address's own pages carry no `Cookie` header in the network panel.

## Afterwards

- [ ] Stop the server and remove each scratch data folder printed in step 2 (and in "Two addresses").
