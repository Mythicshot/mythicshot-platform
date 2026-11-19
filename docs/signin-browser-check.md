# Browser check of the sign-in pages

The tests run the pages' script against a stand-in document, and against the real app in the same process, but they cannot open a browser. This list is what a person goes through by hand before the pages are called done: once in a Chromium-based browser and once in Firefox (or Safari), each with the developer tools open. Write down for each step whether it passed, and for anything that did not, what the page showed.

> [!warning] Use a scratch site only
> Everything here runs on `localhost` with a scratch data folder and placeholder addresses. Never run these steps, and never print a link the way step 3 of "Set up" does, against a real site's data folder.

## Set up

1. Build: `npm run build`.
2. Start the site with a scratch data folder, a generated setup code, and `SITE_HOST` so that the sign-in links name this address. The server listens on every network interface of the machine, so do this on a machine whose firewall keeps port 3000 to itself.

   ```sh
   DATA_DIR=./.data-signin SETUP_CODE=$(openssl rand -hex 16) SITE_HOST=localhost:3000 node dist/node/entry.js
   ```

   Open `http://localhost:3000/setup`, finish the wizard with the owner email `owner@example.com`, and keep the token it shows (a test token of this scratch site only).
3. In a second terminal, make the owner the admin. The command prints the first sign-in link; keep it for "The link page".

   ```sh
   DATA_DIR=./.data-signin SITE_HOST=localhost:3000 node dist/node/admin.js first-admin --email owner@example.com --username checker
   ```

   Mail is off on this site, so the sign-in page never sends a mail. Every further link in this list comes from this command, run in the second terminal; it opens the recovery gate for this one run only, and works only because this is a scratch site on your own machine:

   ```sh
   DATA_DIR=./.data-signin SITE_HOST=localhost:3000 node --input-type=module -e "import { main } from './dist/node/admin.js'; await main(['signin-link', '--email', 'owner@example.com'], { recoveryLinks: true });"
   ```

## Ask for a link

- [ ] `http://localhost:3000/signin` shows the card with the small line "Mythicshot", the heading "Sign in", the lead, the field "Email address" with the placeholder `you@example.com`, the button "Send me a sign-in link" and the line "Mythicshot is invite-only for now." The cursor is in the field.
- [ ] The console shows no error and no policy violation ("Refused to …" or "Content Security Policy"); the network panel shows only requests to `localhost:3000`: the page, its stylesheet and its script (both under `/signin/`) and `GET /api/v1/session` (answering 401).
- [ ] "name" and an empty field each give "That does not look like an email address." under the field, with no request in the network panel, and the field is marked as wrong. The button does not move when the message appears.
- [ ] `owner@example.com` shows "Sending…" on the button for a moment, then "Check your mail" with "If owner@example.com has an account, a sign-in link is on its way. It works once and for 15 minutes." The request was `POST /api/v1/signin/request` with the body `{"email":"owner@example.com"}` and `content-type: application/json`.
- [ ] `nobody@example.com` gives exactly the same screen: the page does not say whether an address has an account.
- [ ] An address holding markup, such as `x<b>bold</b>@example.com`, appears as typed, angle brackets included, never in bold.
- [ ] "try another address" goes back to the form with the cursor in the field, without loading the page again.
- [ ] Eleven requests within 15 minutes from this machine are not limited (a loopback address is no network to count), so "Too many requests. Wait a few minutes and try again." cannot be seen here; note that it was not checked by hand.
- [ ] With the server stopped, the button gives "Something went wrong. Try again in a moment." and comes back. Start the server again.

## The link page

- [ ] Open the link from "Set up" step 3. The address bar shows `http://localhost:3000/signin/link` with no `#c=…` once the page has loaded, and the page shows "Finish signing in", "Press the button to sign in on this browser.", the button "Sign in" and "You stay signed in here for 30 days of use. If you did not ask for this link, close this page: nothing happens."
- [ ] The network panel shows no request to `/api/v1` before the press, and no request anywhere carries the code in its address or in a `Referer` header.
- [ ] Pressing "Sign in" shows "Signing in…", sends one `POST /api/v1/signin/complete` with the body `{"code":"dpl_…"}`, and lands on `/account`. The answer's `Set-Cookie` is `__Host-dp_session=…; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000`.
- [ ] The Back button from `/account` never shows the link page with its code: the account page took the link page's place in the history, so Back goes to whatever was open before the link (or does nothing in a new tab). A long press on Back (the tab's own list) shows no address with `#c=` in it. Reloading `/account` keeps you signed in.
- [ ] Open the browser's history page and write down whether it lists the link's address with `#c=…`. The page cannot take back what the browser recorded when it opened the link; the code is spent by then, and an unused one expires in 15 minutes, but the result decides whether the guide should say so.
- [ ] Open a new link, and before pressing, reload the page: it shows "This sign-in link no longer works" with no request, because the code left the address bar when the page first loaded. That link still works once if opened again from the terminal.
- [ ] Opening the same link again, in this browser or the other one, and pressing "Sign in" gives "This sign-in link no longer works", "A link works once and for 15 minutes. Ask for a new one and use the newest mail." and "Send me a new link", which goes to `/signin`.
- [ ] `http://localhost:3000/signin/link` with nothing after it, and with `#c=abc`, shows the same "This sign-in link no longer works" at once, with no request.
- [ ] An expired link: print a new one with the command, wait 16 minutes, open it and press "Sign in": "This sign-in link no longer works".

## The account page

- [ ] `/account` shows "Signed in as checker", `owner@example.com` under it, the label "Storage" with a bar and a line such as "0 bytes used · 0 tours" (no allowance is set yet, so there is no bar), the hint "Tours and their pictures count. Deleting a tour frees its space within a few minutes.", the label "Where you are signed in" with one row "This browser" before the browser and system and "since" today's day and month, the buttons "Sign out" and "Sign out everywhere" side by side, and "Tours are managed from Mythicshot for now. A dashboard is coming to this page."
- [ ] Sign in in the other browser too (a new link from the command). Reloading the account page in the first browser shows a second row with the other browser's name, "last used" with today's day and month, and a "Sign out" link.
- [ ] That "Sign out" link shows "Signing out…", sends `DELETE /api/v1/sessions/ses_…` with an `X-Csrf-Token` header, and the row disappears. In the other browser, reloading `/account` goes to `/signin`.
- [ ] `/account` in a private window (nobody signed in) goes straight to `/signin`, and `/signin` while signed in goes straight to `/account`.

## Storage under, at and over the allowance

Connect Mythicshot to this site with the wizard's token (Settings › Output › Tour publishing) and upload one tour. Read its usage with `curl -s -H "Authorization: Bearer <token>" http://localhost:3000/api/v1/usage` and note `used_bytes`. Then stop the server and start it again as in "Set up" step 2, each time with one more setting, and reload `/account` (the session survives the restart):

- [ ] No `STORAGE_ALLOWANCE_BYTES`: "<used> used · 1 tour" and no bar.
- [ ] `STORAGE_ALLOWANCE_BYTES` set to twice `used_bytes`: "<used> of <allowance> used · 1 tour" and the bar half full in the site's green.
- [ ] Set to exactly `used_bytes`: the bar full, still green.
- [ ] Set to `used_bytes` minus 1: the bar full in the warning colour (amber).
- [ ] The sizes read as Mythicshot and the server write them (`512 KB`, `14.2 MB`, `1.02 GB`).

## Signing out

- [ ] "Sign out" shows "Signing out…", sends `POST /api/v1/signout` with an `X-Csrf-Token` header, and lands on `/signin`; the answer clears the cookie (`Max-Age=0`). The other browser's session still works: its `/account` loads.
- [ ] Sign in again in this browser. "Sign out everywhere" sends `POST /api/v1/signout/everywhere` with an `X-Csrf-Token` header and lands on `/signin`; in the other browser, reloading `/account` now goes to `/signin` too.
- [ ] After all of it, the Application (Storage) panel shows nothing of this site in local storage, session storage or IndexedDB, and the only cookie it ever had was `__Host-dp_session`.

## Keyboard, phone width and colours

- [ ] Every page works with the keyboard alone: Tab reaches the field, each button and each link in order, each shows a visible focus ring, and Enter in the email field sends the form.
- [ ] With a screen reader (or the accessibility panel), the messages under the field and on the account page are announced when they appear, and each row's "Sign out" names that row's browser.
- [ ] At 320 pixels wide (the developer tools' device mode) every page fits without a sideways scroll, a long email address wraps inside the card, and the two sign-out buttons stack when they do not fit side by side.
- [ ] With the system set to dark, every page is dark, with readable text and a visible focus ring; set to light, light.
- [ ] With JavaScript switched off, each page shows "This page needs JavaScript." under "Mythicshot"; the sign-in form sends nothing anywhere.

## Afterwards

- [ ] Stop the server and remove the scratch data folder `./.data-signin`.
