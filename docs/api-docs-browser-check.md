# Browser check of the API documentation page

The tests cannot open a browser, so this list is what a person looks at before the page is called done. Run the site locally as the [README](../README.md#run-locally-on-node) says (`npm run build`, then `DATA_DIR=./.data node dist/node/entry.js` with a generated `SETUP_CODE` set), finish `/setup` once to get a test token, and open `http://localhost:3000/docs` with the developer tools open.

> [!warning] Use a test token only
> Use the token of a local test install, never one of a real site: after "Execute" the viewer shows the request it sent, token included.

## Loading

- [ ] The page draws completely: the header with the version and the two download links, "Get connected", the token box, the first command, the three guide links, the reference with the groups Tours, Uploads, Workspace and Server, the three guides, the footer.
- [ ] The console shows no error and no policy violation ("Refused to …" or "Content Security Policy").
- [ ] The network panel shows only requests to this site: the page, two style sheets, two scripts and `/api/v1/openapi.json`; one request for the viewer stylesheet's source map, answering 404, is expected with the developer tools open.
- [ ] No request carries a `Cookie` header and no answer has `Set-Cookie`.
- [ ] The JSON and YAML links download the description, and "Licence notices" opens the notices.
- [ ] Every command shows `http://localhost:3000` in place of `https://YOUR-SITE`, and "Copy" puts that command on the clipboard and reads "Copied" for a moment.

## The policy

- [ ] The page's policy no longer allows inline style attributes (`style-src-attr 'unsafe-inline'` was taken out on trial): through the loading check and every "Try it" below, the console stays clean and nothing of the viewer looks broken (open a request, its schemas, an answer, a picture); if not, note what broke and put the directive back in `src/docs/page.ts` and in the test that pins the policy.

## The viewer's parts

- [ ] The viewer's own title block (title, version, the long introduction) is not shown.
- [ ] The viewer's own bar with the servers list and the green "Authorize" button is not shown.
- [ ] Nothing else of the viewer is missing: every request can be opened, shows its description, its parameters, its answers with their schemas, and "Try it out".
- [ ] No request shows a lock button: the viewer's own token dialog lives in the hidden bar, so the button would do nothing, and the token box is the one way to give a token.

## The token box

- [ ] Text that is not a token ("hello") gives "That does not look like a token. A token starts with dp_ and is 43 characters long." and sends no request.
- [ ] A well-formed token the server does not know (`dp_` and forty zeros) gives "The server does not know this token. Check that you pasted all of it." and empties the field.
- [ ] The test token gives "Checking…", then "Connected to <workspace>. The calls on this page now use this token.", empties the field and shows "Forget token"; the one request it sent is `GET /api/v1/me` with no cookie.
- [ ] With the server stopped, "Use token" gives "The server could not be reached. Try again."
- [ ] The Enter key in the field does what "Use token" does.
- [ ] The browser does not offer to save the token as a password, or, if it does, note which browser.

## Try it

- [ ] Without a token: `GET /api/v1/me`, "Try it out", "Execute" answers 401 with `{"error":"unauthorized"}`.
- [ ] With the token in use: the same answers 200 with the workspace's name and the version, and the request shown carries `Authorization: Bearer` with the token.
- [ ] `GET /healthz` under Server answers 200 with and without a token, and the request shown carries no `Authorization` header.
- [ ] `GET /api/v1/tours` answers 200; a draft step's image (`GET /api/v1/tours/{id}/steps/{step_id}/image`, ids from an uploaded tour) shows the picture.
- [ ] Every "Execute" request in the network panel goes to this site, without a `Cookie` header.
- [ ] "Forget token" says "Token forgotten." and draws the reference afresh: every request is closed again, no answer or command from before is shown anywhere, the console reports nothing, and the next "Execute" on `GET /api/v1/me` answers 401.
- [ ] The same fresh reference appears when a second token is put in with "Use token" while one is in use, and when that second one is not a token or is not known to the server.
- [ ] After all of it, the Application panel shows nothing of this site in local storage, session storage, IndexedDB or cookies.
- [ ] A reload forgets the token: "Execute" on `GET /api/v1/me` answers 401 again.

## The guides

- [ ] Each of the three guide links jumps to its guide, and the address then ends in `#guide-upload-and-publish`, `#guide-update-a-tour` or `#guide-errors-and-limits`.
- [ ] Opening the page directly on each of those three addresses ends at that guide once the reference has drawn, not above it.
- [ ] Opening a request in the reference changes the address to the viewer's own fragment (such as `#/Workspace/getMe`), and a reload opens that request again.
- [ ] The table of error codes and the list of limits read well and fit their column.

## Phone width

- [ ] At 375 pixels wide the page has no sideways scroll outside the error table and the viewer's own wide parts; long commands wrap inside their box.
- [ ] The token field, "Use token" and "Forget token" stay usable and do not overlap.
- [ ] The reference stays usable: a request opens, and "Try it out" and "Execute" can be reached.

## Dark and light

- [ ] With the system set to light: dark text on a white page, and the viewer in its light look.
- [ ] With the system set to dark: the page and the viewer are both dark with one background colour and no white band or box between them; text, links, the token box, the commands, the status lines in green and red, and the error table are all readable.
- [ ] Switching the system setting while the page is open switches both at once.
- [ ] In dark, open one request and check the viewer's own parts are readable too: parameters, schemas, the answer, the command shown after "Execute".

## Keyboard only

- [ ] Tab goes through the page in reading order: the download links, the token field, "Use token", the copy button, the guide links, the reference, the guides' copy buttons, the footer link.
- [ ] Every stop shows a visible focus ring, in light and in dark.
- [ ] A request in the reference can be opened, tried and executed with the keyboard alone.
- [ ] After "Forget token" the focus is in the token field.

## Two addresses

- [ ] With two local addresses set as the README's [Turn it on, and go back](../README.md#turn-it-on-and-go-back) says, `/docs` on the tours address ends on `/docs` of the app address, and the page works there as above.
