// The three guides of the documentation page, as data: plain words, the `curl` command of
// each step and the status it answers.
//
// test/docs-guides.test.ts reads every command back out of the page and sends it to the
// real routes, in order, so a guide cannot say something the site does not do. An example
// is a single `curl` command using only -X, -H, -d and --data-binary @<file>, and the
// words in capitals (YOUR_TOKEN, UPLOAD_ID, ...) that its guide's `placeholders` explain.
// The address in every example is GUIDE_ORIGIN; the page script puts the address of the
// site being viewed in its place.
//
// The table of error codes and the list of limits are not written here: they are read
// from the description (src/docs/openapi.ts), so they cannot drift from it. Only the
// one-line meaning of each code is, and a test holds that list equal to the description's.
import type { OpenApiDoc } from "./openapi.ts";

export type GuideExample = { curl: string; expect: number; repeatUntil?: number };
export type GuideStep = { text: string; note?: string; example?: GuideExample };
export type Guide = {
  id: "upload-and-publish" | "update-a-tour" | "errors-and-limits";
  title: string;
  intro: string;
  /** What each word in capitals in this guide's examples stands for. */
  placeholders: readonly (readonly [string, string])[];
  steps: GuideStep[];
  /** Sentences after the steps (and, in the last guide, after its tables). */
  closing?: string[];
};

/** What the HTML carries as the site's address; the page script swaps in `location.origin`. */
export const GUIDE_ORIGIN = "https://YOUR-SITE";

/**
 * Said once under "Get connected" and once in every guide's legend. The examples keep
 * YOUR_TOKEN, which reads plainly; this says how not to leave the real one behind.
 */
export const HISTORY_NOTE = "A token typed into a command stays in your shell's history. Put it in a variable first, with read -rs TOKEN, and write $TOKEN in place of YOUR_TOKEN.";

const AUTH = '-H "Authorization: Bearer YOUR_TOKEN"';
const JSON_BODY = '-H "Content-Type: application/json"';
const PNG_BODY = '-H "Content-Type: image/png"';

const STEP_1 = '{"image":"step-001.png","width":1280,"height":720,"bytes":48213,"click":{"x":50,"y":50},"t_ms":0}';
const STEP_2 = '{"image":"step-002.png","width":1280,"height":720,"bytes":51022,"click":null,"t_ms":1500}';
/** The first guide's manifest: one step, and a cover that names a logo. */
const NEW_MANIFEST = `{"version":3,"generator":"curl","title":"My first tour","steps":[${STEP_1}],"cover":{"title":"My first tour","logo":"logo.png"}}`;
/** The second guide's manifest: the same first step, a second one, and a cover without a logo. */
const REPLACE_MANIFEST = `{"version":3,"generator":"curl","title":"My first tour","steps":[${STEP_1},${STEP_2}],"cover":{"title":"My first tour"}}`;

const TOKEN_WORD = ["YOUR_TOKEN", "your token"] as const;

export const GUIDES: readonly Guide[] = [
  {
    id: "upload-and-publish",
    title: "Upload and publish a tour",
    intro: "A tour is uploaded as a draft in three kinds of request, then published. Nothing is public until the publish finishes.",
    placeholders: [
      TOKEN_WORD,
      ["UPLOAD_ID", "the upload_id from the first answer"],
      ["TOUR_ID", "the tour_id from the answer that finished the upload"],
      ["step-001.png", "a PNG picture of exactly the width, height and bytes the manifest gives"],
      ["logo.png", "a PNG picture"],
    ],
    steps: [
      {
        text: "Start the upload with the tour's manifest. Note the upload_id in the answer.",
        example: { curl: `curl ${GUIDE_ORIGIN}/api/v1/uploads ${AUTH} ${JSON_BODY} -d '{"manifest":${NEW_MANIFEST},"target":{"kind":"new"}}'`, expect: 201 },
      },
      {
        text: "Send each step's image, numbered from 1. The image must have the size and length the manifest gives.",
        example: { curl: `curl -X PUT ${GUIDE_ORIGIN}/api/v1/uploads/UPLOAD_ID/steps/1 ${AUTH} ${PNG_BODY} --data-binary @step-001.png`, expect: 204 },
      },
      {
        text: "If the manifest names a logo, send it too.",
        example: { curl: `curl -X PUT ${GUIDE_ORIGIN}/api/v1/uploads/UPLOAD_ID/logo ${AUTH} ${PNG_BODY} --data-binary @logo.png`, expect: 204 },
      },
      {
        text: "Finish the upload. The answer has the tour_id.",
        example: { curl: `curl -X POST ${GUIDE_ORIGIN}/api/v1/uploads/UPLOAD_ID/commit ${AUTH}`, expect: 201 },
      },
      {
        text: "Publish the tour. A small tour answers 200 at once; a large one answers 202 with a publish_id: send the request again with that id until it answers 200.",
        note: 'To share it with chosen people only, send who may view it with this first request, as JSON with the Content-Type header: {"access":"people","viewers":[their email addresses]}, or {"access":"me"} for your account alone. The tour is then restricted from the start and never public. Only a tour\'s first publish takes it; afterwards change it in the dashboard.',
        example: { curl: `curl -X POST ${GUIDE_ORIGIN}/api/v1/tours/TOUR_ID/publish ${AUTH}`, expect: 200, repeatUntil: 200 },
      },
      { text: "The answer's url is the tour's link, as a path to put after your site's address." },
      {
        text: "To take the tour down again, unpublish it.",
        example: { curl: `curl -X POST ${GUIDE_ORIGIN}/api/v1/tours/TOUR_ID/unpublish ${AUTH}`, expect: 204 },
      },
    ],
  },
  {
    id: "update-a-tour",
    title: "Update a tour over the same link",
    intro: "To change a published tour, replace one of its chapters and publish again. The link and the title stay the same, and visitors see the old version until the publish finishes.",
    placeholders: [
      TOKEN_WORD,
      ["TOUR_ID", "the tour's id"],
      ["CHAPTER_ID", "the chapter_id from the answer that finished the chapter's upload"],
      ["SHA256_OF_STEP_001", "the SHA-256 of step-001.png, as 64 lowercase hex characters, and likewise for SHA256_OF_STEP_002"],
      ["UPLOAD_ID", "the upload_id from this guide's first answer"],
      ["step-002.png", "a PNG picture of exactly the width, height and bytes the manifest gives"],
    ],
    steps: [
      {
        text: "Start an upload that replaces the chapter. With a SHA-256 for each picture, the answer's have lists the steps the site already has, so you do not send them.",
        note: "Replacing a tour's first chapter also replaces the tour's settings and logo with the manifest's; the answer's settings is then true. This example's manifest names no logo, so the tour ends up without one.",
        example: {
          curl: `curl ${GUIDE_ORIGIN}/api/v1/uploads ${AUTH} ${JSON_BODY} -d '{"manifest":${REPLACE_MANIFEST},"target":{"kind":"replace","tour_id":"TOUR_ID","chapter_id":"CHAPTER_ID"},"sha256":["SHA256_OF_STEP_001","SHA256_OF_STEP_002"]}'`,
          expect: 201,
        },
      },
      {
        text: "Send the other steps' images.",
        example: { curl: `curl -X PUT ${GUIDE_ORIGIN}/api/v1/uploads/UPLOAD_ID/steps/2 ${AUTH} ${PNG_BODY} --data-binary @step-002.png`, expect: 204 },
      },
      {
        text: "Finish the upload. The answer's publish says what publishing would do now: draft, ready or other_changes.",
        example: { curl: `curl -X POST ${GUIDE_ORIGIN}/api/v1/uploads/UPLOAD_ID/commit ${AUTH}`, expect: 201 },
      },
      {
        text: "If it says ready, publish the tour as in the first guide.",
        example: { curl: `curl -X POST ${GUIDE_ORIGIN}/api/v1/tours/TOUR_ID/publish ${AUTH}`, expect: 200, repeatUntil: 200 },
      },
      {
        text: "To give up instead, cancel the upload; it removes only what this upload stored.",
        example: { curl: `curl -X DELETE ${GUIDE_ORIGIN}/api/v1/uploads/UPLOAD_ID ${AUTH}`, expect: 204 },
      },
    ],
  },
  {
    id: "errors-and-limits",
    title: "Errors and limits",
    intro: "Every refusal is JSON with an error code and, mostly, a detail in plain words. The codes are stable; the detail text may change.",
    placeholders: [TOKEN_WORD, ["TOUR_ID", "the id of one of your tours"]],
    steps: [
      { text: "A missing or wrong token answers 401.", example: { curl: `curl ${GUIDE_ORIGIN}/api/v1/me`, expect: 401 } },
      {
        text: "Another workspace's tour answers 404, the same as one that does not exist.",
        example: { curl: `curl -X PATCH ${GUIDE_ORIGIN}/api/v1/tours/tour_000000000000000000000000 ${AUTH} ${JSON_BODY} -d '{"title":"A new title"}'`, expect: 404 },
      },
      {
        text: "A body that is not what the request expects answers 400 with the reason.",
        example: { curl: `curl -X PATCH ${GUIDE_ORIGIN}/api/v1/tours/TOUR_ID ${AUTH} ${JSON_BODY} -d '{"title":""}'`, expect: 400 },
      },
    ],
    closing: [
      "Requests that work in steps (publish, unpublish, delete) are safe to send again; send the same request until it answers 200 or 204.",
      "With two addresses, a request to any other host name answers 421 with nothing in it.",
    ],
  },
];

/**
 * What each error code means, in one line. The codes and their statuses come from the
 * description; this only adds the words. A test fails when a code the description has is
 * missing here, or one here is not in the description.
 */
export const CODE_MEANINGS: Readonly<Record<string, string>> = {
  unauthorized: "The token is missing, malformed, unknown or revoked. This answer has no detail.",
  not_found: "Nothing with that id in this workspace, no request waiting under that short code, or no request has that address.",
  bad_request: "The body is not what the request expects.",
  bad_title: "The title breaks the rule for a title; the detail says how.",
  bad_manifest: "The manifest breaks a rule; the detail names the field.",
  bad_target: "The upload's target is missing, or its kind is not new, chapter or replace.",
  bad_image: "The picture sent is not the one the manifest describes; the detail says what differs.",
  empty_tour: "A tour with no steps cannot be published.",
  too_large: "The body, the picture or the tour is over a limit.",
  already_sent: "This step's image, or the logo, was already sent.",
  logo_not_used: "The upload goes into an existing tour, which keeps its logo; do not send one.",
  incomplete: "An image, the logo, or a part of a shared item has not been sent yet, or an item's parts do not add up to its declared bytes; nothing changed.",
  chapter_changed: "Another upload replaced the chapter first; cancel this upload and start again.",
  publish_busy: "A publish of the tour is in progress or just starting; try again.",
  publish_cancelled: "That publish was stopped before it finished; publish again to start over.",
  too_many_uploads: "The workspace has its number of open uploads; finish or cancel one. The retry-after header says how long to wait.",
  too_many_items: "The workspace started, or sent parts or previews of, as many shared items as it may in an hour, or too many sends of one item have not finished. The retry-after header says how long to wait.",
  bad_part: "A part of a shared item does not have the length it must have.",
  bad_media: "Part 0 of a shared item is not a file of the declared type, or its width and height differ from the declared ones.",
  already_online: "The shared item is finished; its parts and preview cannot change any more.",
  superseded: "A part or preview of a shared item did not take its place (it took too long); the item is still open, so send it again.",
  bad_cursor: "The cursor is not one the list gave; start again without it.",
  cleanup_pending: "The tour, item or account is deleted (an account partly), or the tour unpublished, but some files are still to be removed; send the same request again.",
  publish_failed: "The tour could not be published; what was published before is unchanged.",
  bad_email: "The address to send a sign-in link to, the new address of an email change, or the address to invite, is not an email address. This answer has no detail.",
  bad_code: "The code is not in the form of a sign-in code (this answer has no detail), or the link of an email change no longer works: used, expired, replaced by a later one, another account's, or for an address taken since.",
  mail_off: "The site cannot send mail, so an email address cannot be changed there and nobody can be invited.",
  bad_origin: "The request did not come from a page of the site's own address, which signing in, and every change made with a session, needs.",
  bad_csrf: "A change made with a session did not carry that session's anti-forgery value.",
  mixed_credentials: "The request carried both a token and a session. Send one.",
  link_invalid: "The sign-in link has expired or was already used; ask for a new one.",
  rate_limited: "Too many sign-in requests from this network, too many email-change requests for an account or an address, too many requests to connect the app from this network (or too many of them waiting), too many wrong short codes from an account or a network, too many invites from an admin or invite mails from the site, or too many invite look-ups and accepts from this network. The retry-after header says how long to wait.",
  credentials_not_allowed: "The app's requests while it connects take no token and no session cookie, and looking up or accepting an invite, and a visitor's viewer requests, take no token; send none.",
  has_account: "The address already has an account: it cannot be invited, or the invite can no longer make one. Sign in instead.",
  too_many_invites: "The site holds as many open invites as it may; cancel one that is no longer needed.",
  mail_failed: "The invite is stored, but its mail could not be sent; resend it.",
  invite_invalid: "The invite cannot be used: unknown, already used, cancelled, replaced by a newer one, or expired.",
  view_link_invalid: "The viewer link cannot be used: unknown, already used or expired. Ask for a new one on the page of the tour, image or clip.",
  signed_in: "The browser is signed in to an account; sign out before accepting an invite.",
  bad_username: "The username must be 3 to 30 lowercase letters, digits and hyphens, starting with a letter.",
  reserved_username: "The username is one the site holds back, such as a name that reads as staff or as a page of the site; choose another.",
  username_taken: "Another account has that username; choose another.",
  bad_device_name: "The device name must be 1 to 60 characters of text, without control or formatting characters.",
  bad_name: "A token's name must be 1 to 60 characters of text, without control or formatting characters.",
  expired_code: "The device code can give no token: it is unknown, expired, refused or already used. Start again.",
  slow_down: "The app asked for its token again before the interval was up; wait 5 seconds more.",
  bad_allowance: "The storage allowance must be a whole number of bytes from 0 to 9007199254740991, or null for the site's default.",
  own_account: "An admin cannot disable, enable or delete their own account; another admin must.",
  last_admin: "The account is the site's last active admin; the site would be left without one.",
  deleting: "A delete of the account has started, so it cannot be enabled; send the delete again to finish it.",
  not_disabled: "Only a disabled account can be deleted; disable it first.",
  username_mismatch: "The username typed to confirm a delete is not the account's username (or, for an account without one, its email address) exactly.",
  shared_workspace: "Another account belongs to the account's workspace, so deleting it would delete their work too.",
  site_owner: "The account owns the workspace the site was set up with, which cannot be deleted.",
  bad_access: "Who may view a tour, image or clip must be public, people or me; when it is stated with a create or a first publish, viewers must come with it.",
  bad_viewer: "An entry of a list of viewers (a tour's or a shared item's) is not an email address; the detail gives its position, never the address. Nothing was changed.",
  too_many_viewers: "A list of viewers holds at most 200 different addresses. Nothing was changed.",
  cannot_restrict: "The site cannot send mail, so nobody could get a link to view a restricted tour, image or clip: a public one cannot be made people or me there. One that is restricted already stays so, and can still move between people and me.",
  too_large_to_restrict: "The shared item is larger than a restricted item may be on this site (70,000,000 bytes with the default part size), so it stays public. Nothing was changed.",
  already_published: "The tour has been published before (also if it was unpublished since), so who may view it is changed in the dashboard only; publish without access and viewers. Nothing was changed.",
  access_already_set: "Who may view the tour was already set in the dashboard, and differently; publish without access and viewers, or change it in the dashboard. Nothing was changed.",
  access_switching: "The live pictures of the tour are moving because who may view it is being changed; send that change again until it answers 200, then do this.",
  switch_cancelled: "The tour was unpublished or deleted while its pictures moved; send the change again to apply it to the tour as it is now.",
  access_busy: "The tour or item changed while the change of who may view it was decided; send it again.",
  access_failed: "Moving the tour's pictures could not go on just now; send the same request again to continue it.",
  republish_needed: "The tour's published version cannot be moved to the other store as it is; publish the tour again, then send the change of who may view it again.",
  internal: "The server failed; nothing about the failure is given.",
  misconfigured: "On Cloudflare, the two addresses in the settings cannot be used together.",
};

/**
 * Codes any request can answer. The description states them once, in its introduction,
 * not on each request; a test checks the introduction says each with this status.
 */
export const ANY_REQUEST_CODES: Readonly<Record<string, number>> = { internal: 500, misconfigured: 500, mixed_credentials: 400, bad_csrf: 403 };

type Loose = Record<string, any>;

/** Every error code the description has, with the statuses it comes with, by status and then by name (plain order, the same on every runtime). */
export function errorCodes(doc: OpenApiDoc): { code: string; statuses: number[] }[] {
  const seen = new Map<string, Set<number>>();
  const add = (code: string, status: number) => seen.set(code, (seen.get(code) ?? new Set()).add(status));
  const follow = (node: Loose): Loose => {
    let at = node;
    while (typeof at?.$ref === "string") {
      let next: Loose = doc;
      for (const part of at.$ref.slice(2).split("/")) next = next[part];
      at = next;
    }
    return at;
  };
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(item)) {
      for (const [status, response] of Object.entries(op.responses)) {
        if (Number(status) < 400) continue;
        const schema = follow(follow(response as Loose).content?.["application/json"]?.schema ?? {});
        const error = follow(schema.properties?.error ?? {});
        const codes: string[] = Array.isArray(error.enum) ? error.enum : typeof error.const === "string" ? [error.const] : [];
        for (const code of codes) add(code, Number(status));
      }
    }
  }
  for (const [code, status] of Object.entries(ANY_REQUEST_CODES)) add(code, status);
  return [...seen].map(([code, statuses]) => ({ code, statuses: [...statuses].sort((a, b) => a - b) })).sort((a, b) => a.statuses[0] - b.statuses[0] || (a.code < b.code ? -1 : 1));
}

/** The limits as the description states them: the list under "## Limits" in its introduction, one sentence each. */
export function limitLines(doc: OpenApiDoc): string[] {
  const lines = doc.info.description.split("\n");
  const start = lines.indexOf("## Limits");
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) out.push(line.slice(2));
  }
  return out;
}
