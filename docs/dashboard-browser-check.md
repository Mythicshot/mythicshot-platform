# Browser check of the dashboard: the bar and the Tours page

The tests run the dashboard's scripts against a stand-in document, and against the real app in the same process, but they cannot open a browser. This list is what a person goes through by hand before the Tours page is called done: once in Chrome and once in Firefox, each with the developer tools open. Write down for each step whether it passed, and for anything that did not, what the page showed.

Chrome and Firefox treat `http://localhost` as a secure address and keep the session cookie, which is marked `Secure` and named with the `__Host-` prefix. Another browser may refuse that cookie on plain `http://localhost`: every dashboard page then goes straight back to `/signin`. That is the browser, not the site; note it if you try one.

> [!warning] Use a scratch site only
> Everything here runs on `localhost` with a scratch data folder inside the computer's temporary folder. The link tool refuses anything else; never point any of these commands at a real site's data folder.

## Set up

1. Set up the scratch site, sign in as the admin `checker` and keep the wizard's token, exactly as in "Set up" of [the sign-in pages' check](signin-browser-check.md), steps 1 to 4, using the prefix `dashboard-check-` for the folder.
2. Nobody can be invited in this version, so a scratch site has no second account that is not an admin. What a member sees of the Admin tab is held by the tests; here only the page source is looked at.
3. Upload three tours with the owner's token, as the site's documentation page `http://localhost:3000/docs` shows in its guide "Upload and publish a tour" (or with Mythicshot). Publish two of them. Then upload a new version into one of the two published tours and do not publish it, so that it has changes waiting. Give one tour a title holding markup, such as `<b>bold</b> & "quoted"`.

## The bar

- [ ] `http://localhost:3000/` while signed in lands on `/tours`; in a private window (nobody signed in) it lands on `/signin`. In the network panel the first answer is a `302` with `cache-control: no-store` and no body.
- [ ] The bar across the top shows "Mythicshot", the tabs "Tours", "Storage", "Account" and "Admin" in that order, and the username `checker` on the right. "Tours" is marked as the current tab. There is no "Images" or "GIFs" tab.
- [ ] View the page source: the Admin link is in it with `hidden` (the script shows it because `checker` is the admin), the username is not in it, and nothing else names an admin route. In a private window, `view-source:http://localhost:3000/tours` shows the very same text.
- [ ] "Storage" and "Admin" lead to `/storage` and `/admin`, which answer `{"error":"not_found"}` until their pages are built. "Account" leads to today's account page.
- [ ] The console shows no error and no policy violation ("Refused to …" or "Content Security Policy"); the network panel shows only requests to `localhost:3000`: the page, its stylesheet and its two scripts (all three under `/dash/`), and `GET /api/v1/session`, `/api/v1/me`, `/api/v1/tours` and `/api/v1/usage`.
- [ ] The page's answer, the stylesheet and both scripts carry the same six headers as the sign-in pages: `content-security-policy: default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `cache-control: no-store`, `x-content-type-options: nosniff` and `cross-origin-opener-policy: same-origin`.

## The list

- [ ] Under the heading "Tours" the line reads "3 tours in <workspace name> · <size> used", with the size written as everywhere else (at most one decimal, no trailing `.0`, 1024 to the next unit).
- [ ] One row per tour, the most recently changed first. Each row has the title in bold and under it "<n> steps · localhost:3000/t/<slug>" for a published tour, or "<n> steps · no public link" for the other; then its tags, its size and the day it changed, such as "19 Nov".
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
- [ ] Each button can be pressed only once while its request runs: a second press, or another row's button, sends nothing.

## Deleting a tour

- [ ] "Delete" in the menu opens the question in the page, never a browser dialog: "Delete \"<title>\"?", "Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched." and the buttons "Keep it" and "Delete tour". The focus is on "Keep it".
- [ ] Tab and Shift+Tab stay on the two buttons. "Keep it" and Escape each close the question and put the focus back on that row's "More", with no request sent.
- [ ] "Delete tour" reads "Deleting…", sends `DELETE /api/v1/tours/tour_…` (again while it answers 202) with an `X-Csrf-Token` header, closes the question, and the row is gone, the line under the heading counts one tour fewer, and the focus is on the heading.
- [ ] Delete every tour: the page shows "No tours yet" and "Record a tour in Mythicshot and choose Publish. It shows up here with a link to share." with no table and no hint.

## When something fails

- [ ] With the server stopped, any button gives "Something went wrong. Try again in a moment." under the heading line (in the question, for "Delete tour") and comes back. Start the server again.
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

- [ ] `/tours`, and the stylesheet and scripts under `/dash/`, on the tours address answer `{"error":"not_found"}`; `/` on the tours address sends the browser to `/` on the app address, which sends it on to `/tours` or `/signin`.
- [ ] On the app address, a published tour's "Open" and "Copy link" use the tours address: `http://` and the tours name, the port, `/t/<slug>`.

## Afterwards

- [ ] Stop the server and remove each scratch data folder made in "Set up" (and in "Two addresses").
