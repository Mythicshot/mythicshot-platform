# Changelog

Every merged fix or update gets the next version number (0.1.1, 0.1.2, and so on) and one entry here, newest first.

## 0.1.43 (2026-11-20)

- The Tours page shows who can view each tour, in a new "Who can view" column between Status and Size: "Anyone with the link" for a public tour, an amber tag for a restricted one ("4 people", "1 person", "Nobody yet" for an empty list, or "Only me"), and a dash for a tour that is not published, which has nothing to share yet. On a phone the setting joins the line under the title. When a published tour is restricted, a line under the table says that opening it asks for an email address too, since the dashboard's sign-in does not carry over to the tours address.
- A published tour's "More" starts with "Sharing…", which reads the tour's setting and opens the Sharing box: "Anyone with the link", "Only people I choose" and "Only me" as real radio buttons, and for the middle one the list as chips, each with a remove button, and a field whose "Add" (or Enter, which never saves) takes one address or many separated by commas, spaces, semicolons or lines, in lower case and once each. An entry that is not shaped like an address refuses the whole paste and is named; the list stops at 200. "Cancel" forgets the edits and sends nothing; "Save" sends the setting and the whole list to the tour whose box is open.
- Making a public tour restricted, or a restricted one public, asks first in the same box, with the approved words and, going restricted, the warning that pictures already opened may stay in browsers. Its button works only after a moment, so a double click on "Save" cannot press it. Between "Only people I choose" and "Only me", and for a change of the list, it saves at once.
- While the pictures move the box shows "Moving the pictures, <done> of <total>. Keep this page open." with a bar, and sends the very same request again after a short pause. A lost answer or `500 access_failed` is sent again, at most three times in a row; any refusal stops it at once, with its own sentence, and so does leaving the page; it never sends more than 5000 requests. However it ends, the list is read again, and the setting too unless the last answer was the final one, so a lost answer is decided by what the site reports and the row shows what is true.
- A move that stopped is shown when "Sharing…" is opened again, by the direction the site reports for it: for a move to restricted, "Keep it restricted" finishes it; for a move to public, "Keep it restricted" cancels it and "Make public" asks first, then finishes it. Since the site finishes a move to restricted by itself and cancels a move to public that made no progress for 15 minutes, the box reads the setting when it opens and again before it sends anything; when the tour is no longer as the box shows it, nothing is sent and the box shows it as it is now ("The tour changed while this was being saved. Press Save again." when there were edits).
- A tour whose pictures cannot be moved says "This tour's pictures could not be moved. Unpublish it, publish it again from Mythicshot, then set who can view it."
- The button that confirms a change between public and restricted is inert for a moment after the question appears, so a double click on "Save" cannot press it; meanwhile it stays in the Tab order and a screen reader reads it as unavailable, while the focus starts on the button that keeps the tour as it is.
- Before it sends anything, the box also compares the list the site has now with the one it read: when another tab or person changed it, nothing is sent and the box shows the site's list with "The tour changed while this was being saved. Press Save again.", so a removal made elsewhere is never undone. Whenever the box shows a setting other than the one just confirmed it says so; a move that changed direction meanwhile says "This tour changed meanwhile. It is shown as it is now: choose again." A move stopped by leaving the page, or after the most requests, shows only the stopped move, never "Something went wrong". The warning that a public tour cannot be restricted again on a site without mail also shows on the "Make public" question and with a stopped move. "Keep it restricted" never sends a public setting.
- This work was numbered 0.1.41 before its review; it is released as 0.1.43.
- This branch now carries the reworked access API of 0.1.38 (the direction of a move in `switching` and in each `202`, a stalled move to public cancelled by the site, a move to restricted carried on in the background, and the list given to a signed-in session only).
- On a site that cannot send mail, a public tour can only stay public: the restricted options are greyed out with the approved warning. A tour that is restricted already keeps its setting, can move between the two restricted ones and have its list changed, and can be made public, with a line saying it cannot be restricted again here.
- The dashboard's in-page questions can give the Tab key their own order and go back a step on Escape instead of closing; nothing changes for the other pages.

## 0.1.42 (2026-11-20)

- `cpanel.sh update` checks for restricted tours before it installs any version older than 0.1.38, whatever is installed: also when the installed version cannot be read, and when the archive is the same version as the installed one. An app that never started (no database) and a first install are not checked, as before.
- An update that was cut off now records in its marker the version that ran before it (`PREVIOUS=`). Resumed and failing again, it offers the way back to that version, and checks for restricted tours before it shows the commands; a marker without the line counts as an unknown version, and the check is made.
- A request and the workspace's housekeeping moving the same tour at once no longer answer `409 republish_needed` by mistake: only a picture whose source is really gone counts. Send the request again and the move goes on.
- When a picture's source is really gone in a move to restricted, the tour's remaining public pictures are removed at once, by the request or by housekeeping (within its call allowance), so nothing of the tour stays in the public store; the tour stays restricted and unavailable until it is unpublished and published again.

## 0.1.39 (2026-11-20)

- A new optional setting on both targets, `DOWNLOAD_URL`: the address of the public page the desktop app is downloaded from. It must be `https://`, a plain host name, an optional port and a path (a query is allowed), with no user name or password and no `#` part, at most 300 characters; the https check is the one `INVITE_CONTACT` already used, with this stricter shape on top. Unset or empty, nothing changes. A value that cannot be used never stops the site: the link is left out and the start writes one line that names the setting and never the value (on Cloudflare once per instance, on its first request).
- `GET /api/v1/session` gains `download_url`, the configured address or null. Only an added field; the API description says what it is.
- The Account page shows a card "Mythicshot for Windows" above "Where you are signed in", with "Get the installer from the download page. It shows the latest version and its checksum." and the button-styled link "Open the download page", only when the session names a usable address. The Connections page's welcome of a new account then ends with "Not installed yet? Get Mythicshot from the download page.", the last three words the link. Both open in a new tab with no opener and no referrer. The pages check the address again with the server's own shape before they link to it, so an address that does not pass shows nothing. Without the setting both pages read as before. The pages' policy is unchanged.
- Wired where the other optional settings are: the Node settings, the Worker's vars (kept by `npm run setup:cloudflare -- update`), the cPanel startup file, the container stacks, the README's settings table and the three hosting guides, which say how to add it.

## 0.1.38 (2026-11-20)

- Who may view a tour, through the API. Each tour has a setting, `public` (anyone with the link: every tour so far, and the default), `people` (the addresses on the tour's list, and the workspace's own account) or `me` (the workspace's own account alone), and a list of up to 200 addresses, written as sign-in writes an address (trimmed, lowercase) and kept when the setting moves away from `people`. `GET /api/v1/tours/<id>/access` answers the setting, the whole list, the limit, whether the site can mail, and the progress of a move; `PUT /api/v1/tours/<id>/access` with `{"access": …, "viewers": […]}` changes the setting and, with `viewers`, replaces the whole list. Reading takes a token or a session, and only a session reads the addresses: a token gets `viewers_count` in place of `viewers`. Changing takes a signed-in session only, on the app address, with its anti-forgery header, so a token that leaked can neither read the list nor make a restricted tour public (a token is answered `401`).
- A restricted tour's published pictures live in the private store, never in the public one, so a public bucket domain cannot serve them. Publishing a restricted tour writes its pictures there directly; unpublishing and deleting remove them.
- Changing a published tour between `public` and `people` or `me` moves the pictures of the version that is live now, never the draft, under the same link, in steps: the answer is `202 {"status":"switching","done","total"}` and the client sends the same request until `200`. Made restricted, the tour stops being served publicly at the first request, also the pictures a re-publish replaced that were still in their grace, and its public pictures are deleted as they move, each batch's right after it is copied, not kept for a grace period. A move to restricted that its client leaves is finished by the workspace's next tour lists and unpublishes, four pictures each, once it has made no progress for a minute (a run that fails waits another minute); a move to public left for fifteen minutes is cancelled by them, and the tour stays restricted. No request goes over its call budget for it: only those with room do this work. Made public, it is served only once every picture is in place, and until then asking for the setting it still has cancels the move and removes the public copies made so far. Each step can be interrupted and is continued by sending the request again; a published version that cannot be moved, or one of whose pictures is gone, answers `409 republish_needed`: unpublish the tour (which ends the move and removes its pictures) and publish it again. Unpublish and delete stop a move; a publish waits for it (`409 access_switching`). Between `people` and `me`, and for a change of the list, nothing moves. A change between `public` and the others cancels a publish in progress of an unpublished tour.
- On a site that cannot send mail, a public tour cannot be made `people` or `me` (`409 cannot_restrict`), since nobody could get a link; a tour that is restricted already stays so, can still move between `people` and `me`, and its list can still be changed.
- In this version nobody can view a restricted tour yet: its page and its pictures answer as a tour that does not exist, byte for byte. The page that lets a visitor prove an address comes in a later version.
- The tour list and the publish answers gain `access` and `viewers` (the number of addresses on the list, never the addresses).
- Refusals with their own codes: `bad_access`, `bad_viewer` (it names the entry's position, never an address), `too_many_viewers`, `cannot_restrict`, `access_switching`, `switch_cancelled`, `access_busy`, `access_failed` and `republish_needed`. The API description and its guide to error codes describe them.
- The audit record has a new event, `tour_access_changed`, with the two settings and the list's sizes, never an address.
- An earlier version serves nothing of a restricted tour even so: its published text is kept where no earlier version reads it (`snapshot.private_data`), with a stub in its place that every earlier version's page answers as not found, and its pictures under names no earlier version's picture route serves. The tests run 0.1.35's own page and picture lookups against restricted tours and tours moving either way. And the database itself refuses, by triggers, a public picture or published text for a restricted tour, so an earlier version's publish or rename of one fails instead of making it public.
- This branch's work was numbered 0.1.36 before the viewer sign-in of 0.1.37 was merged under it; it is released as 0.1.38.
- Upgrading: this version needs its database change (migration 0014: the setting, every existing tour public, the list and the record of a move) before it serves. The Node server applies it when it starts, before it answers, and `npm run setup:cloudflare -- update` applies it before it deploys. Do not go back to an earlier version once any tour has been made `people` or `me`, or is being changed to or from that: restore the backup taken before the update instead, which loses everything done on the site since that backup. `cpanel.sh` checks the database before it shows the commands to go back and before an update with `--allow-downgrade` to a version before 0.1.38, and refuses both while such a tour exists, or when it cannot read the database unless `--no-restricted-tours-checked-by-hand` states that someone checked by hand; going back to 0.1.38 or later is allowed. On the Docker and Cloudflare routes only the database's triggers stand in the way; their runbooks say how to check by hand. `npm run rehearse:upgrade` now restricts one tour on its scratch copy and checks that the old build serves nothing of it.

## 0.1.37 (2026-11-20)

- A visitor can prove an email address on the tours address (with one address, on that address), for tours that will be shared with a list of addresses. No account is made. `POST /api/v1/view/request` with the address and the tour's slug answers the same `202 {"ok":true}` for every tour and address, a malformed address included, after the same database work, and mails a link only when the tour is shared with that address. In this version no tour can be restricted yet, so no viewer link is ever sent; the setting and the pages come in later versions.
- The mail, in the approved words: "Your link to a Mythicshot tour", with the link `<tours address>/view#dpv_…` from the settings, never from the request. It works once and for 15 minutes. `POST /api/v1/view/check` shows the address and the tour without using the code; `POST /api/v1/view/complete` turns it into a viewer session. Used, expired and unknown codes get the one `404 view_link_invalid`, and of two completions of one code only one wins.
- The viewer session is a cookie of its own, `__Host-dp_viewer` (host-only, Secure, HttpOnly, SameSite=Lax), set and read on the tours address alone, and stored only as a digest. It lasts 30 days after its last use, written at most once a day, and never more than 180 days. It is never an account's session, and an account's session is never a viewer: no route of the dashboard or the API reads it, and a request that carries a token beside it proves nothing. A new completion replaces the browser's viewer session; `POST /api/v1/view/signout` ends it on the server and clears the cookie; `GET /api/v1/view/session` answers the proved address.
- Limits, each in a bucket of its own: one address gets at most 3 viewer links in 15 minutes and 5 a day however many tours or networks ask (any workspace owner can put a stranger's address on a list, so this bounds the mail an uninvolved person gets), and at most 2 for one tour in 15 minutes; a network asks at most 10 times in 15 minutes and tries codes at most 20 times. Anyone who knows an address can use up its viewer links for the day, which delays that person and nothing more.
- The viewer mail is capped per workspace of the tour: 30 an hour, counted only for a mail about to be sent, under an opaque key the tour's access setting gives for its workspace. A workspace's owner can fill only their own workspace's count, so whether their own mails still go says nothing about whether an address is on another workspace's list, and no workspace can use up the viewer mail of the others. A site-wide backstop of 1000 an hour only stops a fault from sending without end. Neither cap is ever told to the requester: the answer is the same `202`, after the same database calls.
- All five requests must come from a page of the tours address, the three with a body as JSON, so another site can neither complete a code into a visitor's browser nor sign it out; a token is refused with `400 credentials_not_allowed`.
- Disabling or deleting an account does not end the viewer sessions of the same address: a viewer is an address, not the account.
- The audit record has two new events, `viewer_link_sent` and `viewer_signin`, each with its own id alone. The username `view` is now reserved.
- The API description gains a "Viewers" section and the viewer cookie as a security scheme of its own; the guide to error codes gains `view_link_invalid`.
- Upgrading: this version needs its database change (migration 0015: the viewer_code and viewer_session tables) before it serves. The Node server applies it when it starts, before it answers, and `npm run setup:cloudflare -- update` applies it before it deploys.

## 0.1.35 (2026-11-20)

- The Admin page invites people. The card "Invite someone" takes an address and sends the invite; the page says it is on its way and until which day the link works, or, in plain words, that the address already has an account, does not look like an address, cannot be mailed from this site, or that 100 invites are open already. When the mail could not be sent the invite stays and the page says to press Resend. After too many invites in a short time, "Send invite" and every "Resend" rest for as long as the site says.
- "Open invites" lists the invites, newest first, with the day each was sent and the day it works until, or an amber "Ran out" tag. "Resend" sends a fresh link at once and the earlier one stops working; "Cancel" asks first. On a phone each invite is a card.
- Each account row has one "More" menu instead of its button: "Set allowance", then "Disable" or "Enable", then "Delete" for a disabled account. The admin's own row offers only "Set allowance", and an account whose delete has started shows an amber "Deleting" tag and offers only "Delete", to finish it.
- "Disable" asks first and says what stops and that nothing is deleted; "Enable" asks nothing. "Delete" shows what goes (tours, images and GIFs, connected computers, the storage freed) and works only once the username is typed exactly (the email address for an account without one). A large delete shows its progress while the page sends it again; a refusal stops it at once, and a store that keeps failing or answers that keep getting lost stop it after three tries in a row. An interrupted delete is finished from the same row; the page remembers the typed name until it is reloaded, never in storage.
- When an answer is lost on the way, the page reads the list again and says what is true: a disabled or enabled account by its status, a cancelled or resent invite by whether it is still listed and its dates, a deleted account by whether it is still listed.
- The page's heading is "Admin", with the accounts in a card of their own, and its line under the table reads "You see totals only. What is in another person's workspace is never shown here."
- The dashboard's shared script hands each page the account's own id, so the Admin page knows the admin's own row.
- The accounts table has a "Joined" column, the day each account was made, with the year; the delete question's empty field shows the username to type, muted.
- A delete in progress stops when the page is left: nothing more is sent before or after the next pause, so a page brought back from the browser's back/forward cache never carries on by itself; it shows the interruption, and the admin presses "Delete account" to go on. Reaching the loop's call limit says "This is taking longer than expected. Open Delete again to carry on."
- Opening Delete again fills in the name and goes straight on only when the list just read marks the account as being deleted and the name was confirmed on this page; otherwise it asks again with an empty field.
- A Resend whose answer was lost says the invite is no longer open only when the list read again is whole (fewer than 100 invites), as Cancel does; otherwise it says it went wrong.
- Version notes: the old cursor of the list of accounts, an account id alone, was what versions before 0.1.33 gave (the API description and the code said 0.1.30, a number whose work was released in 0.1.33). The changelog gains short entries for 0.1.29 and 0.1.30, whose work came out as part of 0.1.32 and 0.1.33.

## 0.1.34 (2026-11-20)

- The page an invite's link opens, `/invite`, on the app address. It takes the code from the part of the address after `#` and removes it from the address bar before it does anything else, then looks the invite up (`POST /api/v1/invite/check`, the code in the body) and asks "Choose your username", saying "You were invited as <address>." with the address in bold, so a person who was forwarded someone else's invite notices. Opening the link makes nothing: the account is made only when the person presses "Create my account" (or Enter in the field), with one request however often it is pressed, and the browser then lands on the Connections page, signed in.
- The username is checked in the page by the site's rule, in small letters only: a capital, an underscore or markup is refused without a request ("Use 3 to 30 lowercase letters, digits and hyphens, starting with a letter."), and shown as typed. A name that is taken or that the site holds back says so under the field, and the invite keeps working.
- One page, "This invite no longer works", for every invite that cannot be used: no code or a malformed one in the address (nothing is asked), and an invite that is unknown, used, cancelled, replaced or expired, or whose address has an account by now. A reload lands there too, since the code left the address when the page first opened, so the page also says "If you reloaded this page, open the link in your mail again." A browser that is signed in already, a second tab right after the invite was used included, gets "You are already signed in", with a way to the dashboard and nothing that acts on that account. Too many tries say how many minutes to wait; when the site cannot be reached, "Try again" asks again with the code the page still holds, so the mail is not needed again.
- The code is never put in an address, a store, a log or the page: it is only sent in the two requests' bodies. The page holds no data and makes no database call, and is served with the sign-in pages' headers and stylesheet.
- Connections page: a new account is welcomed above the heading, "Welcome, <username>. Your workspace is ready. Connect Mythicshot on your computer to start sharing: …", when it has no computer connected and nothing in its workspace yet (read from the usage the page asks for). It goes away once a computer is connected.
- `POST /api/v1/invite/accept` decides a dead invite before it looks at the username: a used, cancelled, replaced, expired or made-up code answers the one `404 invite_invalid` whatever the username, a malformed or reserved one included, and an address that has an account by now answers `409 has_account` before the username is judged. A reserved username now has its own code, `400 reserved_username`, instead of `bad_username` with another sentence; the API description and its guide to error codes say so. A refused accept still never uses up the invite.
- The dashboard's browser check has a part for accepting an invite in two browsers, with the forwarded-link check and a used link.

## 0.1.33 (2026-11-20)

- Admin API: disabling, enabling and deleting an account. `POST /api/v1/admin/accounts/<id>/disable` ends every session of the account at once, spends its unused sign-in links and its open email change, and refuses every token of its workspace while it is disabled (the tokens are kept, and work again once it is enabled); a request to connect Mythicshot that it confirmed can no longer be collected. `POST /api/v1/admin/accounts/<id>/enable` changes the status back and nothing else; the person signs in again. Both answer 204, also for an account already in that state. The Admin page's buttons come in a later version.
- A disabled account's tour pages, published pictures (also those a re-publish replaced, during their grace) and shared images and clips answer exactly as ones that never existed, byte for byte. The tour page and the picture route check this inside the one database lookup they already made, so neither makes a call more. A copy a browser or a cache already holds is not taken back (a page for up to a minute, a picture for up to a year), and with `PUBLIC_IMAGE_BASE` set to a public bucket's own domain the app cannot stop published pictures at all; the README and the API description say so.
- `GET /api/v1/admin/accounts/<id>/removal` answers what a delete would remove: the username and email address, the tours, the shared images and clips, the connected computers and the bytes used.
- `DELETE /api/v1/admin/accounts/<id>` with `{"username": ...}` (an account without one is confirmed with its email address) deletes a disabled account and everything of its workspace in bounded steps, each request within the call budget: `202` with the files removed out of how many, then `200`. Files go before the rows that name them, and the account, its membership and its workspace go last, in one batch, so a delete stopped anywhere leaves a disabled, listed account that is finished by asking again; meanwhile it cannot be enabled. Afterwards its address and username are free again.
- Refusals with their own codes: `own_account`, `last_admin`, `not_disabled`, `deleting` (enabling an account whose delete has started), `username_mismatch`, `shared_workspace` for an account whose workspace another account belongs to (a delete removes the whole workspace, so it is only for an account alone in its own; every workspace has one account in this version), and `site_owner` for the account whose workspace the site was set up with, which cannot be deleted.
- A delete removes invites to the account's address and keeps the invites it sent valid, with no sender named, so their mail and their page show no inviter.
- The admin's list of accounts pages by an opaque cursor that carries the last account's creation time and id, so an account deleted between two pages no longer cuts the list short. `next` is that cursor; an account id alone, as earlier versions gave, now answers `400 bad_cursor` (before, any malformed cursor was `400 bad_request`). The Admin page sends `next` back as it is.
- The admin's list of accounts adds `deleting`: true while a delete of the account has started and not finished.
- The audit record has three new events: `account_disabled`, `account_enabled` and `account_deleted`, each with ids alone.
- Setting a workspace's allowance no longer records a change when the workspace was deleted at that moment.
- Upgrading: this version needs its database change (migration 0013: a table for a delete in progress) before it serves, because the list of accounts reads it. The Node server applies it when it starts, before it answers, and `npm run setup:cloudflare -- update` applies it before it deploys.

## 0.1.32 (2026-11-20)

- Invites, through the API. The site's admin invites an address with `POST /api/v1/admin/invites` (`{"email": …}`), lists the invites that are open or ran out with `GET /api/v1/admin/invites`, sends one again with a new link with `POST /api/v1/admin/invites/<id>/resend`, and cancels one with `DELETE /api/v1/admin/invites/<id>`. Only an admin's session reaches them; anyone else, any token included, gets the one 404 every admin route answers. The Admin page's invite box and the page the link opens come in a later version.
- The invite mail, "You are invited to Mythicshot", names the admin who sent it by username (or says "You are invited" without a name), and holds a link to `/invite` with a single-use code after the `#`, so it reaches no server log. The link works once and for 7 days, and the mail gives the last day in UTC. The code is stored only as a digest and is only ever sent in a request body.
- Inviting an address again, or resending, gives the same invite a new link, and the older link stops working at once. An address that already has an account is refused (`has_account`). An invite that ran out stays listed until it is cancelled or replaced, and is removed 30 days later.
- The page the link opens calls `POST /api/v1/invite/check` (the invited address, the inviter's username and the last day) and `POST /api/v1/invite/accept` with the chosen username, which makes the account, an empty workspace of its own named after the username with the site's standard allowance, and a session, all together or not at all, and sets the session cookie as finishing a sign-in does. Of two accepts of one invite only one makes an account, and of two people who choose one username at once only one gets it. A refused accept (`bad_username`, `username_taken`, `has_account`) leaves the invite working. Every code that cannot be used, whether unknown, used, cancelled, replaced or expired, gets the one `404 invite_invalid`. Both requests take no credential: a token is refused (`credentials_not_allowed`), and a browser signed in to any account is refused with `409 signed_in` rather than switched to another account.
- Sending an invite needs mail: on a site whose mail is off it is refused (`mail_off`) and nothing is stored; the list and cancelling still work. The mail is sent before the answer: when it cannot be handed over, the invite stays and the answer is `502 mail_failed`, and resending it tries again.
- Limits: an admin sends at most 20 invites an hour, resends included; the site sends at most 30 invite mails an hour, on a cap of their own apart from sign-in's, and holds at most 100 open invites (`too_many_invites`); invites that ran out do not count, and the list shows at most 100, every open one first. A network looks up and accepts invites at most 30 times in 15 minutes, and callers whose network is not known share a bound of their own.
- The audit record has four new events: an invite sent, resent, cancelled and accepted. None holds a code or an address.
- The API description describes the six requests, and its guide to error codes names the new codes.
- Upgrading: this version needs its database change (migration 0012: the invite table). The Node server applies it when it starts, before it answers, and `npm run setup:cloudflare -- update` applies it before it deploys.

## 0.1.31 (2026-11-20)

- A mail when a new computer is connected: once Mythicshot has collected its token, the account that confirmed the request gets one plain-text mail at its address as it is then, "A computer was connected to your Mythicshot account", naming the computer in quotes and the day and time in UTC, saying that it can publish, change and delete everything in the workspace, and linking to the dashboard's Connections page to disconnect it. Without an address for links the last line says, in words, to open the Connections page of the dashboard and disconnect it there.
- The computer's name stays on its one line in the mail whatever it holds: a character that could end or hide a line becomes U+FFFD, so it can add no header or line, even though the API already refuses such names. It is also made inert in the mail, so it can neither pass for the site's own words nor become a link: every quotation mark becomes an apostrophe, `://` becomes `:/ /`, `www.` becomes `www .` and an at sign becomes ` at `. Then the name is cut at 60 characters. The dashboard still shows names as they are.
- Only the collection that made the token sends it, after the database has kept the token: a collection that fails, or the second of two at once, sends nothing, so there is one mail per token. It goes after the answer, and the answer is the same whether mail is off, the mail server refuses, the mail waits or a limit is reached. A site without mail, as every Cloudflare install in this version, makes no call for it.
- Limits of its own, apart from sign-in's and email change's: 5 such mails a day per account, and 30 an hour for the site. A mail that is not sent (over a limit, an address that cannot be used, a mail server that refuses) is never tried again and is one new audit event, `connection_mail_not_sent`, with the request and a word for why, never the address.
- The README, the API description and the Docker runbook's audit table say so.

## 0.1.30 (2026-11-20)

- This number's work, disabling, enabling and deleting an account, was released as part of 0.1.33 (see there). No release carries 0.1.30 itself.

## 0.1.29 (2026-11-20)

- This number's work, inviting people, was released as part of 0.1.32 (see there). No release carries 0.1.29 itself.

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
