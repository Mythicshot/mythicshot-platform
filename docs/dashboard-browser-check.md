# Browser check of the dashboard: the bar, the Tours, Storage and Account pages, and changing an email address

The tests run the dashboard's scripts against a stand-in document, and against the real app in the same process, but they cannot open a browser. This list is what a person goes through by hand before a dashboard page is called done: once in Chrome and once in Firefox, each with the developer tools open. Write down for each step whether it passed, and for anything that did not, what the page showed.

Chrome and Firefox treat `http://localhost` as a secure address and keep the session cookie, which is marked `Secure` and named with the `__Host-` prefix. Another browser may refuse that cookie on plain `http://localhost`: every dashboard page then goes straight back to `/signin`. That is the browser, not the site; note it if you try one.

> [!warning] Use a scratch site only
> Everything here runs on `localhost` with a scratch data folder inside the computer's temporary folder. The link tool refuses anything else; never point any of these commands at a real site's data folder.

## Set up

1. Set up the scratch site, sign in as the admin `checker` and keep the wizard's token, exactly as in "Set up" of [the sign-in pages' check](signin-browser-check.md), steps 1 to 4, using the prefix `dashboard-check-` for the folder.
2. Nobody can be invited in this version, so a scratch site has no second account that is not an admin. What a member sees of the Admin tab is held by the tests; here only the page source is looked at.
3. Upload three tours with the owner's token, as the site's documentation page `http://localhost:3000/docs` shows in its guide "Upload and publish a tour" (or with Mythicshot). Publish two of them. Then upload a new version into one of the two published tours and do not publish it, so that it has changes waiting. Give one tour a title holding markup, such as `<b>bold</b> & "quoted"`.

## The bar

- [ ] `http://localhost:3000/` while signed in lands on `/tours`; in a private window (nobody signed in) it lands on `/signin`. In the network panel the first answer is a `302` with `cache-control: no-store` and no body.
- [ ] The bar across the top shows "Mythicshot", the tabs "Tours", "Storage", "Account" and "Admin" in that order, and the username `checker` on the right (an account without a username shows the word "Account" there, never an email address). "Tours" is marked as the current tab. There is no "Images" or "GIFs" tab.
- [ ] View the page source: the Admin link is in it with `hidden` (the script shows it because `checker` is the admin), the username is not in it, and nothing else names an admin route. In a private window, `view-source:http://localhost:3000/tours` shows the very same text.
- [ ] "Storage" leads to `/storage` (checked below). "Admin" leads to `/admin`, which answers `{"error":"not_found"}` until its page is built. "Account" leads to `/account` (checked below).
- [ ] The console shows no error and no policy violation ("Refused to …" or "Content Security Policy"); the network panel shows only requests to `localhost:3000`: the page, its stylesheet and its two scripts (all three under `/dash/`), and `GET /api/v1/session`, `/api/v1/me`, `/api/v1/tours` and `/api/v1/usage`.
- [ ] The page's answer, the stylesheet and both scripts carry the same six headers as the sign-in pages: `content-security-policy: default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `cache-control: no-store`, `x-content-type-options: nosniff` and `cross-origin-opener-policy: same-origin`.

## The list

- [ ] Under the heading "Tours" the line reads "3 tours in <workspace name> · <size> used", with the size written as everywhere else (at most one decimal, no trailing `.0`, 1024 to the next unit).
- [ ] One row per tour, the most recently changed first. Each row has the title in bold and under it "<n> steps · localhost:3000/t/" and the first four characters of the slug followed by "…" for a published tour (pointing at it shows the whole link), or "<n> steps · no public link" for the other; then its tags, its size and the day it changed, such as "19 Nov".
- [ ] The tags: "Published" in green; "Published" and "Changes waiting" in amber for the tour with a new version; "Not published" in grey.
- [ ] A published tour has "Copy link", "Open" and "More"; the unpublished one has "Publish" and "More".
- [ ] Under the table: "\"Changes waiting\" means Mythicshot uploaded a newer version that visitors do not see yet. \"More\" holds: Publish changes, Unpublish, Delete."
- [ ] The title holding markup shows exactly as typed, angle brackets, ampersand and quotes included, never in bold.

## Copy link and Open

- [ ] "Copy link" reads "Copied" for about two seconds, then "Copy link" again; pasting into the address bar gives `http://localhost:3000/t/<slug>`, which plays the tour.
- [ ] Block the clipboard for the site (Chrome: the lock icon › Site settings › Clipboard › Block) and press "Copy link" again: a field with the whole link appears under the buttons, selected, with the cursor in it, ready for Ctrl+C. Allow the clipboard again afterwards.
- [ ] "Open" opens the public tour in a new tab. In that tab, typing `opener` in the console gives `null`, and the tour's request carries no `Referer` header.

## The More menu

- [ ] "More" on the tour with changes waiting opens a small menu with "Publish changes", "Unpublish" and "Delete" (in red); on the other published tour "Unpublish" and "Delete"; on the unpublished one "Delete" only.
- [ ] A click anywhere else closes the menu; opening another row's menu closes the first.
- [ ] With the keyboard: Tab to "More", Enter opens it with the focus on the first entry, the arrow keys move, Home and End jump, Escape closes it and puts the focus back on "More", and Tab closes it and moves on.

## Changing tours

- [ ] "Publish changes" reads "Publishing…" on "More" while it runs, and afterwards the row has "Published" without "Changes waiting". The requests are `POST /api/v1/tours/tour_…/publish`, the later ones with the body `{"publish_id":"…"}`, each with an `X-Csrf-Token` header and `Origin: http://localhost:3000`.
- [ ] "Unpublish" asks nothing, reads "Unpublishing…", and afterwards the row has "Not published", "no public link" and a "Publish" button with the focus on it. The old link answers 404.
- [ ] "Publish" on that row reads "Publishing…" and brings the same link back.
- [ ] While a change runs, every row's buttons are greyed out and cannot be pressed; they come back when it ends.
- [ ] A publish of a tour with no steps (if you can make one) says "This tour has no steps, so it cannot be published."

## Deleting a tour

- [ ] "Delete" in the menu opens the question in the page, never a browser dialog: "Delete \"<title>\"?", "Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched." and the buttons "Keep it" and "Delete tour". The focus is on "Keep it".
- [ ] Tab and Shift+Tab stay on the two buttons, and the page behind cannot be clicked or reached with Tab. "Keep it", Escape and a click on the dimmed area around the question each close it and put the focus back on that row's "More", with no request sent.
- [ ] "Delete tour" reads "Deleting…", sends `DELETE /api/v1/tours/tour_…` (again while it answers 202) with an `X-Csrf-Token` header, closes the question, and the row is gone, the line under the heading counts one tour fewer, and the focus is on the heading.
- [ ] Delete every tour: the page shows "No tours yet" and "Record a tour in Mythicshot and choose Publish. It shows up here with a link to share." with no table and no hint.

## The Storage page

Do this part twice: first with the server started as in "Set up" (no allowance), then stopped and started again with the setting `STORAGE_ALLOWANCE_BYTES=5368709120` (5 GB) added to the same command. For the over-the-allowance step, restart it once more with `STORAGE_ALLOWANCE_BYTES=1024`.

- [ ] "Storage" in the bar opens `/storage`, marked as the current tab. Under the heading "Storage" is the workspace's name. The network panel shows `GET /api/v1/session`, `/api/v1/usage` and `/api/v1/usage/largest`, and the page, its stylesheet and its two scripts under `/dash/` carry the six headers listed in "The bar".
- [ ] Without an allowance: there is no bar, and the line reads "<size> used · <n> tours" (or "1 tour"), the size written as on the Tours page. Under it: "Tours and their pictures count. Deleting a tour frees its space within a few minutes."
- [ ] With the 5 GB allowance: a bar in green above the line, filled to the share used (a thin sliver for a few megabytes), and the line reads "<size> of 5 GB used · <n> tours". The console shows no policy violation for the bar's width.
- [ ] "What takes the room" lists "Tours", "Logos" and "Uploads in progress" with a size each; the three add up to the size in the line (to within rounding).
- [ ] "Largest tours" lists the tours, largest first, each with a small bar (the first one full, the others in proportion), its size and a red "Delete". The title holding markup shows exactly as typed. Under the table: "All <n> tours are on the Tours page.", where "Tours page" is a link to `/tours` (with one tour: "Your tour is on the Tours page.").
- [ ] With the 1024-byte allowance: the bar is full and amber, and under the line, on an amber background, "You are over your storage allowance. New uploads are refused until you delete tours or get more room.", then "Tours that are already online are not affected." The sentence about what counts is not shown. A published tour's link still plays.
- [ ] "Delete" opens the same question as on the Tours page, with the tour's title, the same sentence and "Keep it" and "Delete tour"; the focus is on "Keep it". Tab and Shift+Tab stay on the two buttons, the bar and the page behind cannot be clicked or reached with Tab, and "Keep it", Escape and a click on the dimmed area each close it and put the focus back on that row's "Delete", with no request sent.
- [ ] "Delete tour" reads "Deleting…", sends `DELETE /api/v1/tours/tour_…` (again while it answers 202) with an `X-Csrf-Token` header, closes the question, and the page reads `/api/v1/usage` and `/api/v1/usage/largest` again: the row is gone, the line counts one tour fewer and a smaller size, and the focus is on the heading.
- [ ] With the server stopped, "Delete tour" gives "Something went wrong. Try again in a moment." in the question, which stays open with its buttons back. Start the server again.
- [ ] Delete every tour: the line reads "0 bytes used · 0 tours" (or "0 bytes of 5 GB used · 0 tours"), "What takes the room" shows "0 bytes" three times, the hint is shown, and there is no "Largest tours" table.
- [ ] At 380 pixels wide and at 320, the small bars in the table are left out, nothing scrolls sideways and a long title wraps; in dark mode the bars and the amber warning are readable.

## The Account page

This part folds in the account page's checks that used to be in [the sign-in pages' check](signin-browser-check.md): the account page is a dashboard page now, and its storage block is the Storage page above. Sign in in the other browser too (a new link from the test tool, as in "Set up" step 4 of the sign-in pages' check).

- [ ] After signing in through a link, the browser lands on `/tours`, not on `/account`. `/signin` while signed in goes straight to `/tours` too; `/account` in a private window (nobody signed in) goes straight to `/signin`.
- [ ] "Account" in the bar opens `/account`, marked as the current tab; the tab's title is "Account". The network panel shows `GET /api/v1/session` and `GET /api/v1/sessions` and nothing else to `/api/v1`, and the page, its stylesheet and its two scripts under `/dash/` carry the six headers listed in "The bar". There is no storage block on this page.
- [ ] Under the heading "Account": "Signed in as checker". The card "Your details" has three rows: "Username" with `checker`, "Email address" with `owner@example.com`, and "Workspace" with the workspace's name.
- [ ] Mail is off on this scratch site, so there is no "Change" button next to the address, and under it the line "This site cannot send mail, so the email address cannot be changed here."
- [ ] The card "Where you are signed in" has a row with the green tag "This browser", the browser and system, such as "Firefox on Windows", and "since" today's day and month; and a row for the other browser with its name, "last used" with today's day and month, and a "Sign out" button. Under them, the buttons "Sign out" and "Sign out everywhere" side by side.
- [ ] Nothing of the account shows until it has all arrived, then everything shows at once (try it with the network panel's throttling at its slowest). Each "Sign out" reads "Signing out…" while its request runs, and a second press sends nothing.
- [ ] The other browser's "Sign out" sends `DELETE /api/v1/sessions/ses_…` with an `X-Csrf-Token` header and `Origin: http://localhost:3000`, and the row disappears with the focus on "Where you are signed in". In the other browser, reloading `/account` goes to `/signin`.
- [ ] With the server stopped, a row's "Sign out" gives "That session could not be ended. Reload the page." and the row stays; "Sign out" and "Sign out everywhere" give "Something went wrong. Try again in a moment." and come back. Start the server again.
- [ ] Sign the other browser in again. "Sign out" greys out both buttons, sends `POST /api/v1/signout` with an `X-Csrf-Token` header and `Origin: http://localhost:3000`, and lands on `/signin`; the answer clears the cookie (`Max-Age=0`). The other browser's `/account` still loads.
- [ ] Sign in again in this browser. "Sign out everywhere" sends `POST /api/v1/signout/everywhere` with an `X-Csrf-Token` header and lands on `/signin`; in the other browser, reloading `/account` now goes to `/signin` too.
- [ ] At 380 pixels wide and at 320, the rows wrap without a sideways scroll, a long email address wraps, and the two sign-out buttons stack when they do not fit side by side. With a screen reader, each row's "Sign out" names that row's browser.

## Changing the email address

The Change button needs a site that can send mail, which this scratch site cannot: `MAIL_MODE=smtp` needs a real mail server over TLS. Do this part only on a test site whose mail works and where you own both test mailboxes; otherwise write down that it was not checked by hand (the tests run the whole change end to end against the real app with a stand-in mailer).

- [ ] "Change" next to the address opens the question "Change your email address" in the page, never a browser dialog: the field "New email address" with the cursor in it, "We send a link to the new address. Your address changes when you open it." and the buttons "Cancel" and "Send the link". The bar and the page behind are dimmed and cannot be clicked or reached with Tab; Tab and Shift+Tab go round the field and the two buttons.
- [ ] "Cancel", Escape and a click on the dimmed area each close it, with no request, and put the focus back on "Change". Opening it again shows an empty field.
- [ ] "name" and an empty field give "That does not look like an email address." under the hint, with no request, and the field is marked as wrong.
- [ ] A new address: "Send the link" reads "Sending…", the field and both buttons are greyed out, Escape and the dimmed area do nothing, and the focus stays in the question. The request is `POST /api/v1/account/email` with the body `{"email":"…"}`, an `X-Csrf-Token` header and the site's `Origin`. Then "Check <new address>" with "Open the link we sent there to finish. It works once and for 15 minutes. Until then you keep signing in with <present address>." and "Done", which has the focus. "Done", Escape and the dimmed area close it with the focus on "Change"; the address on the page has not changed.
- [ ] Ask again with the address of another account on the site, then with this account's own address: the page shows exactly the same "Check …" box each time, and no mail arrives at either.
- [ ] The mail at the new address says "It works once and for 15 minutes, and you need to be signed in to Mythicshot when you open it." and holds one link to `/account/email#c=dpe_…`.
- [ ] With the server stopped, "Send the link" gives "Something went wrong. Try again in a moment." in the question, which stays open with its buttons back. Start the server again.

## The page an email-change link opens

The dead-link and signed-out states can be checked on this scratch site with a made-up code of the right shape: `dpe_` followed by 40 characters from `0-9a-f`.

- [ ] `http://localhost:3000/account/email` with nothing after it, and with `#c=abc`, shows "Confirm your new email address", "This link no longer works. Ask for a new one from your account page." and "Back to your account" (a link to `/account`) at once, with no request to `/api/v1` in the network panel. The "Account" tab is the current one.
- [ ] With `#c=dpe_` and the 40 characters: the address bar shows `http://localhost:3000/account/email` with no `#c=…` once the page has loaded, the page shows "Confirm your new email address", "Press the button to make this your Mythicshot email address." and "Confirm", and the only request so far is `GET /api/v1/session`. No request anywhere carries the code in its address or in a `Referer` header.
- [ ] "Confirm" reads "Confirming…" and sends one `POST /api/v1/account/email/confirm` with the body `{"code":"dpe_…"}`, an `X-Csrf-Token` header and `Origin: http://localhost:3000`; the made-up code gives "This link no longer works. Ask for a new one from your account page." with the link back.
- [ ] Reloading the page after it loaded shows the dead link with no request: the code left the address bar when the page first loaded. A long press on Back shows no address with `#c=` in it.
- [ ] In a private window (nobody signed in), the address with a code shows "Sign in first", "Sign in with your current email address, then open the link from your mail again." and "Sign in", which goes to `/signin`; no confirm request is sent.
- [ ] On a test site with mail (as in "Changing the email address"): opening the mailed link in a browser signed in to this account and pressing "Confirm" shows "Your email address is now <new address>", "Sign-in links go to this address from now on. We sent a notice to <old address>." and "Back to your account", which shows the new address on `/account`. The old mailbox gets "Your Mythicshot email address was changed" with the new address partly hidden. The same link opened again gives the dead link.
- [ ] At 320 pixels wide the box fits without a sideways scroll and a long address wraps; in dark mode it is readable.

## When something fails

- [ ] With the server stopped, any button gives "Something went wrong. Try again in a moment." under the heading line (in the question, for "Delete tour") and comes back. Start the server again.
- [ ] Make a change, and stop the server just after its request was answered (for example with the network panel's throttling at its slowest): the page says "The change was made, but the list could not be loaded again. Reload the page to see it." and keeps the list it had. Start the server again and reload.
- [ ] Sign out in another tab, then press "Unpublish" here: the page goes to `/signin`.
- [ ] Eleven fast requests from this machine are not limited (a loopback address is no network to count), so "Too many requests. Wait a few minutes and try again." cannot be seen here; note that it was not checked by hand.

## Phone width, keyboard and colours

- [ ] At 380 pixels wide, and at 320, in the developer tools' device mode: the bar wraps with "Mythicshot" and the username on the first line and the tabs on the second; each tour is a block with its title, "<n> steps · <size> · <day>", its tags and its buttons on their own lines; the line under the heading leaves out the workspace's name; nothing scrolls sideways, and a long title wraps.
- [ ] On a phone width the More menu opens to the right of its button and stays on the screen.
- [ ] Every control is reachable with Tab in order and shows a visible focus ring. With a screen reader (or the accessibility panel), each "Copy link", "Open", "Publish" and "More" names its tour, the question is announced as a dialog with its title and text, and the messages are announced when they appear.
- [ ] With the system set to dark, the page is dark, with readable text, tags and a visible focus ring; set to light, light.
- [ ] With JavaScript switched off, the page shows "This page needs JavaScript." under the heading, and no data.
- [ ] After all of it, the Application (Storage) panel shows nothing of this site in local storage, session storage or IndexedDB.

## Two addresses (optional)

Set up the site with two addresses as in "Two addresses" of the sign-in pages' check.

- [ ] `/tours`, `/storage`, `/account`, `/account/email`, and the stylesheet and scripts under `/dash/`, on the tours address answer `{"error":"not_found"}`; `/` on the tours address sends the browser to `/` on the app address, which sends it on to `/tours` or `/signin`.
- [ ] On the app address, a published tour's "Open" and "Copy link" use the tours address: `http://` and the tours name, the port, `/t/<slug>`.

## Afterwards

- [ ] Stop the server and remove each scratch data folder made in "Set up" (and in "Two addresses").
