// The API description: every request a token or a session can make, as one OpenAPI 3.1
// document.
//
// It is a plain object built from the code's own constants (the version, the manifest's
// caps, the publish and upload limits), so those cannot drift from what the server does.
// test/openapi.test.ts holds it equal to the route table: a new route fails that test
// until it is described here or listed, with its reason, in UNDOCUMENTED_ROUTES. The JSON
// and YAML files the server hands out are generated from this module.
//
// It names no host: `servers` is "/", so a tool resolves every path against the address
// it fetched the description from. The one example carries a placeholder address.
import { ACCESS_BODY_BYTES, MAX_VIEWERS } from "../access.ts";
import { ADMIN_PAGE, MAX_ALLOWANCE_BYTES } from "../admin-api.ts";
import { BILLING_PROBLEMS_LISTED } from "../billing.ts";
import { CHAPTERS_BODY_BYTES, MAX_CHAPTERS } from "../chapters.ts";
import { PAGE_CACHE } from "../page.ts";
import { LIMITS } from "../manifest.ts";
import { CLIP_MAX_DURATION_MS, CLIP_MAX_SIDE, DEFAULT_MEDIA_LIMITS, LIST_PAGE, MAX_LOOSE_CLAIMS, MEDIA_MAX_AGE_MS, PART_BYTES, PREVIEW_RULE, TITLE_MAX } from "../media.ts";
import { LIMITS_CONNECT, LIMITS_INVITE, LIMITS_MEDIA, LIMITS_VIEWER } from "../rate.ts";
import { COPY_BATCH, MAX_PUBLISH_STEPS, MAX_SNAPSHOT_BYTES, PUBLIC_CACHE, STALE_PUBLISH_MS } from "../publish.ts";
import { LOGO_RULE, STEP_IMAGE_RULE } from "../sniff.ts";
import { DELETE_FILES_PER_CALL } from "../tours.ts";
import { EMAIL_CHANGE_MS } from "../email-change.ts";
import { DOWNLOAD_URL_MAX } from "../https-address.ts";
import { MAX_LIMIT_DAYS } from "../lifetimes.ts";
import { CONNECT_MS, DEVICE_NAME_MAX, OPEN_PER_NETWORK, POLL_INTERVAL_S, USER_CODE_ALPHABET, VERIFY_PATH } from "../connect.ts";
import { INVITE_KEPT_MS, INVITE_MS, MAX_INVITES } from "../invites.ts";
import { MAX_TOKENS_LISTED } from "../tokens.ts";
import { SESSION_COOKIE, SESSION_MS, SIGNIN_CODE_MS } from "../sessions.ts";
import { DEFAULT_MAX_OPEN_UPLOADS, UPLOAD_MAX_AGE_MS } from "../uploads.ts";
import { LARGEST_TOURS } from "../usage.ts";
import { VERSION } from "../version.ts";
import { MEDIA_VIEWER_COOKIE, VIEWER_CODE_MS, VIEWER_COOKIE, VIEWER_IDLE_MS, VIEWER_MAX_MS } from "../viewers.ts";
import { RESTRICTED_MAX_BYTES } from "../media-access.ts";
import { TERMS_LIMITS } from "../terms.ts";

export type OpenApiParameter = { name: string; in: "path"; required: true; description: string; schema: Record<string, unknown> };
export type OpenApiOperation = {
  tags: [string];
  summary: string;
  description: string;
  operationId: string;
  /**
   * Who may call: empty for a request that needs no credential; the token or the session
   * cookie (either one, never both) for most; the session alone for the session's own requests;
   * the viewer cookie alone for the one request that says which address it proved.
   */
  security: [] | [{ token: [] }, { session: [] }] | [{ session: [] }] | [{ viewer: [] }] | [{ mediaViewer: [] }];
  parameters?: OpenApiParameter[];
  requestBody?: { required: boolean; description?: string; content: Record<string, unknown> };
  responses: Record<string, unknown>;
};
export type OpenApiDoc = {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: [{ url: "/" }];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: { token: { type: "http"; scheme: "bearer" }; session: { type: "apiKey"; in: "cookie"; name: string }; viewer: { type: "apiKey"; in: "cookie"; name: string }; mediaViewer: { type: "apiKey"; in: "cookie"; name: string } };
    schemas: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
};

/** The placeholder address of the example; the documentation page puts its own address in its place. */
const EXAMPLE_ORIGIN = "https://YOUR-SITE";
/** The first request to try, and the only text in the description that carries an address. */
export const GET_STARTED = `curl ${EXAMPLE_ORIGIN}/api/v1/me -H "Authorization: Bearer YOUR_TOKEN"`;

/**
 * The routes the description leaves out, each with its reason, keyed as in the app's
 * route table ("<METHOD> <route path>"). A route is either described or listed here.
 */
export const UNDOCUMENTED_ROUTES: Readonly<Record<string, string>> = {
  "GET /setup": "the setup wizard's own page, used once in a browser, not part of the token API",
  "GET /setup/setup.css": "the setup wizard's own stylesheet",
  "GET /setup/setup.js": "the setup wizard's own script",
  "POST /setup/check": "the setup wizard's own request; it takes the setup code, not a token",
  "POST /setup/claim": "the setup wizard's own request; it takes the setup code, not a token",
  "GET /api/v1/setup/connected": "exists only for the setup wizard's polling while it waits for the first connection",
  "GET /signin": "the sign-in page, for people in a browser; it calls the sign-in requests described here",
  "GET /signin/link": "the page a sign-in link opens, for people in a browser; not part of the API",
  "GET /account": "the dashboard's Account page, for people in a browser; it calls the session and email-change requests described here",
  "GET /signin/signin.css": "the sign-in pages' own stylesheet",
  "GET /signin/signin.js": "the sign-in pages' own script",
  "GET /invite": "the page an invite's link opens, for people in a browser; it calls the invite check and accept requests described here",
  "GET /invite/invite.js": "the invite page's own script",
  "GET /": "sends a browser on to the dashboard or the sign-in page; not part of the API",
  "GET /tours": "the dashboard's Tours page, for people in a browser; it calls the tour requests described here",
  "GET /dash/tours.js": "the Tours page's own script",
  "GET /dash/dash.css": "the dashboard's own stylesheet",
  "GET /dash/dash.js": "the dashboard's shared script",
  "GET /dash/mark.svg": "the product's mark beside the name on the dashboard and the sign-in pages",
  "GET /dash/wordmark-dark.png": "the product's name beside the mark, drawn as a picture for dark grounds",
  "GET /dash/wordmark-light.png": "the product's name beside the mark, drawn as a picture for light grounds",
  "GET /images": "the dashboard's Images page, for people in a browser; it calls the shared item requests described here",
  "GET /dash/images.js": "the Images page's own script",
  "GET /gifs": "the dashboard's GIFs page, for people in a browser; it calls the shared item requests described here",
  "GET /dash/gifs.js": "the GIFs page's own script",
  "GET /storage": "the dashboard's Storage page, for people in a browser; it calls the usage and tour requests described here",
  "GET /dash/storage.js": "the Storage page's own script",
  "GET /connections": "the dashboard's Connections page, for people in a browser; it calls the connect and token requests described here",
  "GET /dash/connections.js": "the Connections page's own script",
  "GET /admin": "the dashboard's Admin page, for the site's admin in a browser; it calls the admin requests described here",
  "GET /dash/admin.js": "the Admin page's own script",
  "GET /dash/account.js": "the Account page's own script",
  "GET /account/email": "the page an email-change link opens, for people in a browser; it calls the email-change confirm request described here",
  "GET /dash/account-email.js": "the email-change link page's own script",
  "GET /terms": "the page that asks a signed-in person to agree to the site's terms, and with ?read shows the terms they agreed to, for people in a browser; it calls the terms requests described here",
  "GET /dash/terms.js": "the terms page's own script",
  "GET /api/v1/billing": "billing's own request for the dashboard's notice, Billing card and return page; a session alone, and it exists only on a site with the Stripe settings",
  "POST /api/v1/billing/checkout": "billing's own request from the dashboard's Subscribe page; a session alone, and it exists only on a site with the Stripe settings",
  "POST /api/v1/billing/portal": "billing's own request from the dashboard's Manage subscription button; a session alone, and it exists only on a site with the Stripe settings",
  "POST /api/v1/billing/webhook": "the address Stripe sends its signed notices to; nothing else may call it, and it exists only on a site with the Stripe settings",
  "GET /billing/subscribe": "the dashboard's Subscribe page, for people in a browser, only on a site with the Stripe settings",
  "GET /dash/billing-subscribe.js": "the Subscribe page's own script",
  "GET /billing/return": "the page Stripe sends a person back to after the checkout, only on a site with the Stripe settings",
  "GET /dash/billing-return.js": "the return page's own script",
  "GET /dash/billing.js": "the dashboard's billing script, loaded on every page of a site with the Stripe settings",
  "GET /t/:slug": "the public tour page, for visitors; not part of the token API",
  "GET /p/:name": "a published picture, for visitors; not part of the token API",
  "GET /t/:slug/v/:name": "a restricted tour's picture, for a visitor whose browser proved an address the tour may be viewed by; not part of the token API",
  "GET /view": "the page a viewer link opens, for people in a browser; it calls the viewer check and complete requests described here",
  "GET /view/signout/:slug": "the page \"Not you?\" under a restricted tour leads to, for people in a browser; it calls the viewer sign-out request described here",
  "GET /view/view.js": "the viewer pages' own script",
  "GET /view/view.css": "the viewer pages' own stylesheet",
  "GET /view/shared.css": "the stylesheet of the line under a restricted tour",
  "GET /i/:name": "the public page of a shared image, or the image file itself, for visitors; not part of the token API",
  "GET /i/:name/download": "a shared image's file to save, for visitors; not part of the token API",
  "GET /i/:name/preview": "a shared image's preview picture, for link previews; not part of the token API",
  "GET /r/:name": "the public page of a shared clip, or the clip file itself, for visitors; not part of the token API",
  "GET /r/:name/download": "a shared clip's file to save, for visitors; not part of the token API",
  "GET /r/:name/preview": "a shared clip's preview picture, for link previews and the clip's poster; not part of the token API",
  "GET /s/share.css": "the shared-item pages' own stylesheet",
  "GET /s/share.js": "the shared-item pages' own script",
  "GET /i/:name/signout": "the page \"Not you?\" under a restricted image leads to, for people in a browser; it calls the media viewer sign-out request described here",
  "GET /r/:name/signout": "the page \"Not you?\" under a restricted clip leads to, for people in a browser; it calls the media viewer sign-out request described here",
  "GET /s/view": "the page a viewer link for an image or clip opens, for people in a browser; it calls the media viewer check and complete requests described here",
  "GET /s/view.js": "the media viewer pages' own script",
  "GET /s/view.css": "the media viewer pages' own stylesheet",
  "GET /s/shared.css": "the stylesheet of the line under a restricted image or clip",
  "GET /:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}": "the tour player's own files, loaded by the tour page",
  "GET /docs": "the documentation page itself",
  "GET /docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}": "the documentation page's own files",
  "GET /docs/licences.txt": "the licence notices of the documentation page's viewer",
  "GET /favicon.svg": "the browser tab's icon, the product's small mark, a fixed file",
  "GET /favicon.ico": "the browser tab's icon in the older format, a fixed file",
  "GET /fonts/:file{manrope(?:\\.[0-9a-f]{16})?\\.ttf}": "the pages' text font, Manrope, a fixed file",
  "GET /fonts/manrope-OFL.txt": "the licence of the pages' text font, fixed text",
  "GET /api/v1/openapi.json": "this description itself, as JSON",
  "GET /api/v1/openapi.yaml": "this description itself, as YAML",
};

/** The description's operations as route table keys, such as "GET /api/v1/tours/:id". */
export function routeKeys(doc: OpenApiDoc): string[] {
  const keys: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) keys.push(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`);
  }
  return keys;
}

/** A whole number with its digits in groups of three, the same on every runtime. */
function n(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const orNull = (schema: Schema): Schema => ({ oneOf: [schema, { type: "null" }] });
const json = (schema: Schema) => ({ "application/json": { schema } });
const answer = (description: string, schema: Schema) => ({ description, content: json(schema) });
const empty = (description: string) => ({ description });
/** A refusal: `{"error","detail"}` with one of the given codes. */
const refusalSchema = (...codes: string[]): Schema => ({
  type: "object",
  required: ["error", "detail"],
  properties: { error: { type: "string", enum: codes }, detail: { type: "string" } },
  additionalProperties: false,
});
const refusal = (description: string, ...codes: string[]) => answer(description, refusalSchema(...codes));
const object = (required: string[], properties: Record<string, Schema>, description?: string): Schema => ({
  type: "object",
  ...(description === undefined ? {} : { description }),
  required,
  properties,
  additionalProperties: false,
});
/** A request's object: the server reads the named fields and ignores any other. */
const input = (required: string[], properties: Record<string, Schema>, description?: string): Schema => ({
  type: "object",
  ...(description === undefined ? {} : { description }),
  required,
  properties,
});
const text = (maxLength: number, description: string, minLength = 0): Schema => ({ type: "string", ...(minLength > 0 ? { minLength } : {}), maxLength, description });
const percent = (description: string): Schema => ({ type: "number", minimum: 0, maximum: 100, description });
const colour = (description: string): Schema => ({ type: "string", pattern: "^#[0-9A-Fa-f]{6}$", description });
const whole = (description: string, minimum = 0): Schema => ({ type: "integer", minimum, description });
/** One sign-in lifetime of the session answer: whole days, or null when the site has switched it off. */
const LIMIT_DAYS = (description: string): Schema => ({ type: ["integer", "null"], minimum: 1, maximum: MAX_LIMIT_DAYS, description: description + " null when it is off." });
/** When a session ends however active it is (SESSION_MAX_DAYS), in the session and sessions answers. */
const ENDS_AT: Schema = { type: ["integer", "null"], minimum: 0, description: "When it ends however much it is used: its sign-in plus the site's SESSION_MAX_DAYS, in milliseconds since 1970. null when that limit is off. It ends at expires_at instead when that comes first." };
/** A tour's viewing setting, in the tour list, the publish answers and the access requests. */
const ACCESS_FIELD: Schema = {
  type: "string",
  enum: ["public", "people", "me"],
  description: "Who may view the tour: public (anyone with the link), people (the addresses on its list, and you) or me (you alone). A restricted tour's page and pictures are never served publicly.",
};
const VIEWERS_FIELD: Schema = whole(`How many addresses the tour's list holds (at most ${MAX_VIEWERS}). The addresses themselves are given by GET /api/v1/tours/{id}/access alone.`);

/** `access` stated when something is created (a shared item's create, a tour's first publish). */
const CREATION_ACCESS = (thing: string, when: string, oldLimit: number): Schema => ({
  type: ["string", "null"],
  enum: ["public", "people", "me", null],
  description: `Optional, since version 0.1.51: who may view the ${thing}, stated ${when}, and only then (afterwards only the dashboard changes it). public (anyone with the link), people (the addresses of viewers, and the workspace's account) or me (the workspace's account alone). Left out or null: what it always was, and every answer is as without it. Restricted (people or me) needs a site that can send mail; a restricted ${thing} is never served to anyone without access, from the first moment. A server before 0.1.51 ignores this field and would put the ${thing} online for anyone with the link, so a client that sends it MUST also send pad, making the body longer than ${n(oldLimit)} bytes: every earlier server from 0.1.0 on then refuses the whole request with 413 before it does anything, and 0.1.51 takes it. Checking the version GET /api/v1/me gives, and the access in the answer, are second guards only.`,
});
/** `pad`, which a client sends with access so that an older server refuses the whole request (CREATION_ACCESS). */
const CREATION_PAD = (oldLimit: number, newLimit: number): Schema => ({
  type: "string",
  description: `Since version 0.1.51, only together with access: text of any content, read by nothing, to make the body longer than ${n(oldLimit)} bytes, the most a server before 0.1.51 takes, so that such a server refuses the request with 413 and makes or publishes nothing. It counts in this server's limit of ${n(newLimit)} bytes for a body with access. null counts as left out; anything else but text is refused with 400 bad_request. Without access the body is held to ${n(oldLimit)} bytes, pad or not.`,
});
const CREATION_VIEWERS = (thing: string): Schema => ({
  type: ["array", "null"],
  items: { type: "string", maxLength: 254 },
  description: `Optional, and only together with access: the addresses on the ${thing}'s list, kept whatever the setting (as the dashboard keeps them). Each must be an email address; duplicates (after trimming and lowercasing) count once; at most ${MAX_VIEWERS} different addresses. No answer to a token ever gives them back: answers carry how many there are.`,
});

/** The token or the session cookie, either one. */
const TOKEN = [{ token: [] }, { session: [] }] as [{ token: [] }, { session: [] }];
/** The session cookie alone: the session's own requests. */
const SESSION = [{ session: [] }] as [{ session: [] }];
/** The viewer cookie alone: the address a visitor proved on the tours address. */
const VIEWER = [{ viewer: [] }] as [{ viewer: [] }];
const MEDIA_VIEWER = [{ mediaViewer: [] }] as [{ mediaViewer: [] }];
/** The caller guard's two refusals of a change made with a session (src/auth.ts), on each route that takes a session alone and changes something. */
/** The refusal of upload, publish and share on a site with billing, while the workspace is read-only (src/billing.ts). */
const SUBSCRIPTION_ENDED_REFUSED = refusal(
  "Only on a site with billing switched on: the workspace's subscription has ended, or its trial is over. It can still view, download and delete; this request was refused and nothing was changed. Subscribing again in the dashboard lifts it.",
  "subscription_ended",
);
const SESSION_CHANGE_REFUSED = refusal("bad_origin: the request did not come from a page of this address. bad_csrf: the X-Csrf-Token header is missing or is not this session's anti-forgery value.", "bad_origin", "bad_csrf");
const UNAUTHORIZED = { $ref: "#/components/responses/Unauthorized" };
/** Said on every request that takes only a session. */
const NOT_FROM_THE_PAGE = "It needs the session cookie, so it cannot be tried from the documentation page, which never sends a cookie.";
/** A refusal that carries a code and no detail. */
const bare = (...codes: string[]): Schema => object(["error"], { error: { type: "string", enum: codes } });
/** A refusal whose codes come with a detail or, for those the description says so of, without one. */
const someDetail = (...codes: string[]): Schema => object(["error"], { error: { type: "string", enum: codes }, detail: { type: "string" } });
const retryAfter = { "retry-after": { description: "Seconds until the count starts again.", schema: { type: "integer", minimum: 1 } } };
const setCookie = (description: string) => ({ "set-cookie": { description, schema: { type: "string", pattern: `^${SESSION_COOKIE}=` } } });
const setViewerCookie = (description: string) => ({ "set-cookie": { description, schema: { type: "string", pattern: `^${VIEWER_COOKIE}=` } } });
const setMediaViewerCookie = (description: string) => ({ "set-cookie": { description, schema: { type: "string", pattern: `^${MEDIA_VIEWER_COOKIE}=` } } });
/** A viewer code, as the request bodies carry it. */
const viewerCode: Schema = { type: "string", pattern: "^dpv_[0-9a-f]{40}$", description: "The code of the viewer link, the part after # in its address." };
const mediaViewerCode: Schema = { type: "string", pattern: "^dpi_[0-9a-f]{40}$", description: "The code of the viewer link for an image or clip, the part after # in its address." };
const ITEM_PAGE_FIELD: Schema = { type: "string", pattern: "^/[ir]/[a-z2-7]{20}$", description: "The item's page: /i/<link_id> for an image, /r/<link_id> for a clip." };
const ITEM_VIEWERS_FIELD: Schema = whole(`How many addresses the item's list holds (at most ${MAX_VIEWERS}). The addresses themselves are given by GET /api/v1/media/{id}/access alone.`);

const tourId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The tour's id, as the tour list and an upload's commit give it.", schema: { type: "string", pattern: "^tour_[0-9a-f]{24}$" } };
const uploadId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The upload's id, from the answer that started it.", schema: { type: "string", pattern: "^up_[0-9a-f]{24}$" } };
const stepId: OpenApiParameter = { name: "step_id", in: "path", required: true, description: "The step's id.", schema: { type: "string", pattern: "^st_[0-9a-f]{24}$" } };
const accountId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The account's id, as the list of accounts gives it in id.", schema: { type: "string", pattern: "^usr_[0-9a-f]{24}$" } };
const workspaceId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The workspace's id, as the list of accounts gives it in workspace_id.", schema: { type: "string", pattern: "^ws_[0-9a-f]{24}$" } };
const mediaId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The item's id, from the answer that started it.", schema: { type: "string", pattern: "^med_[0-9a-f]{24}$" } };
const tokenIdParam: OpenApiParameter = { name: "id", in: "path", required: true, description: "The token's id, as the list of tokens gives it.", schema: { type: "string", pattern: "^tok_[0-9a-f]{24}$" } };
const inviteId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The invite's id, as the list of invites gives it.", schema: { type: "string", pattern: "^inv_[0-9a-f]{24}$" } };
const sessionId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The session's id, as the list of sessions gives it.", schema: { type: "string", pattern: "^ses_[0-9a-f]{24}$" } };

function introduction(): string {
  const hours = UPLOAD_MAX_AGE_MS / 3_600_000;
  const minutes = STALE_PUBLISH_MS / 60_000;
  return [
    "Upload, publish and manage interactive product tours. This is the API Mythicshot itself uses.",
    "",
    "## Get connected",
    "",
    'Every request except the health check, the two sign-in requests and the app\'s two requests while it connects carries a token, as the header `Authorization: Bearer YOUR_TOKEN`, or a session cookie (see below). A token starts with "dp_" and is 43 characters long. It acts only inside its own workspace: another workspace\'s tour answers 404, the same as one that does not exist.',
    "",
    "The first request to try answers with your workspace's name and the server's version:",
    "",
    "```",
    GET_STARTED,
    "```",
    "",
    "## Signing in and sessions",
    "",
    `The site's own pages sign a person in with a link sent by mail: POST /api/v1/signin/request mails the link, and POST /api/v1/signin/complete turns the code in it into a session. The link works once and for ${SIGNIN_CODE_MS / 60_000} minutes. The session is a cookie, ${SESSION_COOKIE}, on the app address only (on a server with one address, on that address); it lasts ${SESSION_MS / 86_400_000} days from its last use. Every request that lists the session can be sent with it instead of a token, and acts in the account's one workspace.`,
    "",
    "The site's settings set three sign-in lifetimes, in whole days, each switched off with 0 or off: SESSION_MAX_DAYS (90 unless set) ends a session that long after its sign-in however active it is; CONNECTION_IDLE_DAYS (90 unless set) stops a token made by signing in from the app (kind sign_in) that has not been used for that long; CONNECTION_MAX_DAYS (off unless set) stops such a token that long after it was made. A token of kind setup is never touched by them. They are read when a request is made, so a changed setting applies to every session and token at once. A session or token past one of them is refused exactly as a revoked one is, with 401 unauthorized: the app then signs in again. GET /api/v1/session gives the three limits (limits), the tokens list gives each token's expires_at and expired, and the session and sessions answers give each session's ends_at.",
    "",
    `A signed-in person changes the account's email address in two steps: POST /api/v1/account/email mails a link to the new address, and POST /api/v1/account/email/confirm, sent with the code in that link from the same account's session, makes the change, once and within ${EMAIL_CHANGE_MS / 60_000} minutes. The old address is then sent a notice. Both need the session; a token cannot change an address.`,
    "",
    `Nobody signs up: the site's admin invites an address (POST /api/v1/admin/invites), which mails a link that works once and for ${INVITE_MS / 86_400_000} days. The page the link opens looks the code up (POST /api/v1/invite/check) and accepts it with the username the person chooses (POST /api/v1/invite/accept), which makes the account, an empty workspace of its own and a session, and sets the session cookie as finishing a sign-in does. The code is only ever sent in a request body, never in an address. Both requests take no credential: one that carries a token answers \`400 credentials_not_allowed\`, and a browser signed in to any account answers \`409 signed_in\`. Every code that cannot be used, whether unknown, used, cancelled, replaced by a newer invite or expired, answers the one \`404 invite_invalid\`.`,
    "",
    `A tour may be shared with a list of addresses. A visitor proves an address on the tours address (on a server with one address, on that address), with no account: POST /api/v1/view/request, with the address and the tour's slug, answers the same \`202\` whatever the tour or the address, and mails a link only when the tour is shared with that address. The link works once and for ${VIEWER_CODE_MS / 60_000} minutes; POST /api/v1/view/check looks its code up without using it, and POST /api/v1/view/complete turns it into a viewer session, a cookie of its own, ${VIEWER_COOKIE}, which lasts ${VIEWER_IDLE_MS / 86_400_000} days from its last use and at most ${VIEWER_MAX_MS / 86_400_000} days. It is no account and no credential of any other request: it only tells the tour pages which address the browser proved (GET /api/v1/view/session), until POST /api/v1/view/signout ends it. These requests carry no token (one that does answers \`400 credentials_not_allowed\`), and every code that cannot be used, whether unknown, used or expired, answers the one \`404 view_link_invalid\`.`,
    "",
    "A request with a session that changes anything (any method but GET and HEAD) must come from the site's own pages: its Origin must be the address it is sent to, and it must carry the session's anti-forgery value in the header `X-Csrf-Token`, which GET /api/v1/session gives. A token and a session cookie together are refused.",
    "",
    "The documentation page never sends a cookie, so a session cannot be tried from it; with a token, try the requests that take one.",
    "",
    "## The site's terms",
    "",
    "A site may publish terms, with its server command. Until a signed-in account has agreed to the current version, every request made with its session answers `403 terms_required` and does nothing, except GET /api/v1/terms (the terms, the account's agreement and the anti-forgery value), GET /api/v1/terms/agreed (the version it agreed to last), POST /api/v1/terms/agree and the two sign-outs. This holds for the site's admin too. When the site publishes new terms, it holds again from the account's next request, until it agrees to the new version. A request made with a token is never held: tokens keep working whatever the terms. A site that has published no terms asks nothing of anyone.",
    "",
    "## Connecting the app",
    "",
    `The desktop app gets its token with a pair of codes, so nobody has to copy one. It asks POST /api/v1/connect/start, with no credential, for a long secret device code and a short user code such as ABCD-EFGH, shows the short one and opens verify_url, the dashboard's Connections page. A signed-in person types the short code there; the page shows the device's name (POST /api/v1/connect/lookup, with the code in the body) and the person confirms it (POST /api/v1/connect/confirm) or refuses it (POST /api/v1/connect/refuse). Meanwhile the app asks POST /api/v1/connect/token with the device code every ${POLL_INTERVAL_S} seconds: pending, until it is answered connected with a token for that person's workspace, once; the person who confirmed is then mailed at their address that a computer was connected, after the answer, which is the same whether or not that mail goes. The codes live ${CONNECT_MS / 60_000} minutes. Neither is ever put in an address.`,
    "",
    "The workspace's tokens are listed, renamed and revoked with GET /api/v1/tokens, PATCH /api/v1/tokens/{id} and DELETE /api/v1/tokens/{id}. Like the requests that take a short code, they need the session: a token cannot list, rename or revoke tokens, its own included. A revoked token is refused from the next request on.",
    "",
    "## Errors",
    "",
    'Every refusal is JSON with an error code and, mostly, a detail in plain words: `{"error":"bad_title","detail":"the title must not be empty"}`. The codes are stable; the detail text may change.',
    "",
    "Some answers can come from any request and are not repeated on each one:",
    "",
    '- `401 {"error":"unauthorized"}`, with no detail: the token or session cookie is missing, malformed, unknown, expired or revoked, or a session cookie was sent to the tours address.',
    '- `400 {"error":"mixed_credentials","detail":"send a token or a session cookie, not both"}`: the request carries a token and a session cookie.',
    '- `403 {"error":"bad_origin","detail":"this request must come from the site\'s own pages"}`: a change made with a session did not come from a page of the address it was sent to.',
    '- `403 {"error":"bad_csrf","detail":"the anti-forgery header is missing or wrong"}`: a change made with a session lacks the session\'s X-Csrf-Token.',
    '- `403 {"error":"terms_required","detail":"agree to the site\'s terms first"}`: a request made with a session, on a site with terms the account has not agreed to yet (see The site\'s terms above). Nothing was done. The admin routes answer it only to the site\'s admin.',
    '- `404 {"error":"not_found"}`, with no detail: no request has that address.',
    "- `421` with nothing in it: on a server with two addresses, the request was sent to another host name.",
    '- `500 {"error":"internal"}`: the server failed; nothing about the failure is given.',
    '- `500 {"error":"misconfigured"}`: on Cloudflare, the two addresses in the settings cannot be used together; every request answers this until they are fixed.',
    "",
    "The admin routes (under /api/v1/admin/) answer every refusal, the 400 and the two 403s above included, with the one `404 {\"error\":\"not_found\"}`; to the site's admin they answer terms_required as every route does.",
    "",
    "The app's two requests while it connects take no credential at all: one that carries a token or a session cookie answers `400 credentials_not_allowed`. Every device code that cannot give a token, whether unknown, expired, refused, already used or not a device code at all, answers the one `410 expired_code`, and asking again sooner than the interval answers `429 slow_down`.",
    "",
    "## Requests that work in steps",
    "",
    "Publish, unpublish and delete may need several requests for a large tour. Each is safe to send again: send the same request until it answers 200 or 204.",
    "",
    "## Limits",
    "",
    `- ${n(LIMITS.steps)} steps in one upload, and ${LIMITS.notesPerStep} notes on a step.`,
    `- The manifest: ${n(LIMITS.manifestBytes)} bytes.`,
    `- A step image: ${n(STEP_IMAGE_RULE.maxBytes)} bytes and ${n(STEP_IMAGE_RULE.maxSide)} pixels on a side, PNG or JPEG.`,
    `- The logo: ${n(LOGO_RULE.maxBytes)} bytes and ${n(LOGO_RULE.maxSide)} pixels on a side, PNG or JPEG.`,
    `- Text, in characters after trimming: title ${LIMITS.title}, generator ${LIMITS.generator}, note text ${LIMITS.noteText}, card title ${LIMITS.cardTitle}, card body ${LIMITS.cardBody}, next label ${LIMITS.nextLabel}, cover title ${LIMITS.coverTitle}, cover body ${LIMITS.coverBody}, cover button ${LIMITS.coverButton}, button label ${LIMITS.buttonLabel}, end text ${LIMITS.endText}, link ${LIMITS.link}.`,
    `- ${n(MAX_PUBLISH_STEPS)} steps in one published tour, and ${n(MAX_SNAPSHOT_BYTES)} bytes for its text (titles, notes, cards and settings together).`,
    `- One publish request copies up to ${COPY_BATCH} images; one delete request removes up to ${DELETE_FILES_PER_CALL} files.`,
    `- ${DEFAULT_MAX_OPEN_UPLOADS} open uploads per workspace.`,
    `- An upload that is not finished is removed after ${hours} hours.`,
    `- A shared image: ${n(DEFAULT_MEDIA_LIMITS.imageMaxBytes)} bytes and ${n(DEFAULT_MEDIA_LIMITS.imageMaxSide)} pixels on a side, PNG or JPEG. A shared clip: ${n(DEFAULT_MEDIA_LIMITS.clipMaxBytes)} bytes, GIF or MP4, at most ${n(CLIP_MAX_SIDE)} pixels on a side and ${CLIP_MAX_DURATION_MS / 60_000} minutes long. These numbers are fixed in this version: no setting changes them. Each is sent in parts of ${n(PART_BYTES)} bytes. An item's preview: ${n(PREVIEW_RULE.maxBytes)} bytes and ${n(PREVIEW_RULE.maxSide)} pixels on a side, PNG or JPEG. A workspace starts at most ${LIMITS_MEDIA.create.most} items, sends at most ${n(LIMITS_MEDIA.part.most)} parts and ${LIMITS_MEDIA.preview.most} previews an hour, and an item that is not finished within ${MEDIA_MAX_AGE_MS / 3_600_000} hours is removed and can no longer be finished.`,
    `- Connecting the app: a network asks for at most ${LIMITS_CONNECT.startNetwork.most} pairs of codes in ${LIMITS_CONNECT.startNetwork.windowMs / 60_000} minutes and ${LIMITS_CONNECT.startNetworkDay.most} in a day, and has at most ${OPEN_PER_NETWORK} waiting at once; it asks for tokens at most ${LIMITS_CONNECT.pollNetwork.most} times in ${LIMITS_CONNECT.pollNetwork.windowMs / 60_000} minutes. An account may type ${LIMITS_CONNECT.wrongAccount.most} short codes that name no waiting request in ${LIMITS_CONNECT.wrongAccount.windowMs / 60_000} minutes, and a network ${LIMITS_CONNECT.wrongNetwork.most}; a right code is not counted.`,
    `- Viewer links: one address is sent at most ${LIMITS_VIEWER.linkRecipient.most} in ${LIMITS_VIEWER.linkRecipient.windowMs / 60_000} minutes and ${LIMITS_VIEWER.linkRecipientDay.most} in a day however many tours or networks ask, and at most ${LIMITS_VIEWER.linkPair.most} for one tour in ${LIMITS_VIEWER.linkPair.windowMs / 60_000} minutes; the tours of one workspace get at most ${LIMITS_VIEWER.mailWorkspace.most} viewer mails an hour, on a cap of their own apart from sign-in's. A network asks for links at most ${LIMITS_VIEWER.linkNetwork.most} times in ${LIMITS_VIEWER.linkNetwork.windowMs / 60_000} minutes, and looks up and completes codes at most ${LIMITS_VIEWER.codeNetwork.most} times in ${LIMITS_VIEWER.codeNetwork.windowMs / 60_000} minutes.`,
    `- Invites: an admin sends at most ${LIMITS_INVITE.sendAdmin.most} an hour, resends included; the site sends at most ${LIMITS_INVITE.mailSite.most} invite mails an hour and holds at most ${MAX_INVITES} open invites; invites that ran out do not count. A network looks up and accepts invites at most ${LIMITS_INVITE.codeNetwork.most} times in ${LIMITS_INVITE.codeNetwork.windowMs / 60_000} minutes.`,
    "- A workspace may have a storage allowance, set by the server's settings or its admin. An upload or a shared item that would take the workspace over it is refused when it is started, with 413 `storage_full` and the numbers, before anything is stored. Nothing is ever deleted because of an allowance.",
    `- A publish that makes no progress for ${minutes} minutes counts as abandoned.`,
    "",
    "- A publish that a first publish with access cancelled may have written public pictures that were never live and whose names were never given out; they are removed at once, and if that fails, by a later request of the tour or the workspace. Until then a public bucket domain (PUBLIC_IMAGE_BASE) holds them under names of 128 random bits.",
    "",
    "Anything over a limit is refused, never cut short.",
  ].join("\n");
}

function schemas(): Record<string, Schema> {
  const inProgress = { type: "string", const: "in_progress" };
  return {
    Error: object(
      ["error"],
      { error: { type: "string", description: "A stable code, such as not_found." }, detail: { type: "string", description: "The reason in plain words. The text may change; do not match on it." } },
      "The shape of every refusal. Each request lists the codes it can answer.",
    ),
    Unauthorized: object(["error"], { error: { type: "string", const: "unauthorized" } }, "The one answer for a missing, malformed, unknown, expired or revoked token or session."),
    InProgress: object(
      ["status", "done", "total"],
      { status: inProgress, done: whole("Files removed so far."), total: whole("Files to remove in all.") },
      "A delete that has more to do. Send the same request again.",
    ),
    PublishInProgress: object(
      ["status", "publish_id", "done", "total", "access", "viewers"],
      {
        status: inProgress,
        publish_id: { type: "string", pattern: "^pub_[0-9a-f]{24}$", description: "Send it back in the next publish request to continue this publish." },
        done: whole("Images copied so far."),
        total: whole("Images to copy in all."),
        access: ACCESS_FIELD,
        viewers: VIEWERS_FIELD,
      },
      "A publish that has more images to copy.",
    ),
    UnpublishInProgress: object(
      ["status", "detail"],
      { status: inProgress, detail: { type: "string", description: "What is left to do, in plain words." } },
      "The tour is unpublished, but some of its public images are still to be removed. Send the same request again.",
    ),
    Tour: object(
      ["id", "title", "status", "slug", "url", "chapters", "steps", "bytes", "updated_at", "published_at", "unpublished_changes", "access", "viewers"],
      {
        id: { type: "string", pattern: "^tour_[0-9a-f]{24}$" },
        title: { type: "string" },
        status: { type: "string", enum: ["draft", "published"] },
        slug: { type: "string", description: "The last part of the public link. It never changes, also not on a rename." },
        url: { type: ["string", "null"], description: "The public link as a path, /t/<slug>, to put after the server address. null for a draft." },
        chapters: whole("How many chapters the draft has."),
        steps: whole("How many steps the draft has."),
        bytes: whole("The tour's size in bytes, counted as GET /api/v1/usage counts storage: the images of all its steps and its logo (a logo stored by a server before version 0.1.8 counts as 0). Over all of a workspace's tours these add up to the usage's pictures and logos; uploads that are not finished belong to no tour and are not in it."),
        updated_at: whole("When the draft last changed, in milliseconds since 1970."),
        published_at: { type: ["integer", "null"], description: "When the tour was last published, in milliseconds since 1970. null for a draft." },
        unpublished_changes: {
          type: "boolean",
          description:
            "true when the tour is published and its draft holds a chapter upload or update that is not on the public page yet, so publishing it again would change what visitors see; also when the server cannot tell, which happens only for some tours last published before version 0.1.4. false for a draft, and for a published tour whose page is up to date. A rename is live at once and never sets it.",
        },
        access: ACCESS_FIELD,
        viewers: VIEWERS_FIELD,
      },
    ),
    TourList: object(["tours"], { tours: { type: "array", items: ref("Tour"), description: "Most recently changed first." } }),
    RenameBody: input(["title"], { title: text(LIMITS.title, "The new title: trimmed, no control or format characters.", 1) }),
    Renamed: object(["id", "title"], { id: { type: "string" }, title: { type: "string", description: "The title as saved (trimmed)." } }),
    Deleted: object(["deleted"], { deleted: { type: "boolean", const: true } }, "Nothing of the tour is left."),
    RemovalUndone: object(
      ["restored", "files_removed"],
      {
        restored: { type: "boolean", const: false, description: "Always false: nothing that was removed is put back." },
        files_removed: { type: "integer", minimum: 0, description: "How many of the workspace's files the removal had already removed." },
      },
      "A stopped removal was undone; what it had removed stays removed.",
    ),
    Chapter: object(["id", "title", "position", "steps", "pictures", "uploaded_at"], {
      id: { type: "string", pattern: "^ch_[0-9a-f]{24}$", description: "The chapter's id." },
      title: { type: "string", description: "The chapter's title, as its upload named it." },
      position: whole("Its place in the tour, from 0: visitors see the chapters in this order."),
      steps: whole("How many steps it has."),
      pictures: whole("How many picture files its steps use (two steps may share one); removing the chapter deletes them."),
      uploaded_at: { type: ["integer", "null"], minimum: 0, description: "When it was last uploaded (a new chapter or a replace of it), in milliseconds since 1970. null when that is not known: when it was before version 0.1.55, which is so for every chapter but the one a tour was made with, and (since version 0.1.56) when the last replace was made by an earlier version, 0.1.55 included, run on the same database after it was updated to 0.1.56: such a chapter has no upload time until version 0.1.56 or later replaces it again." },
    }),
    ChapterList: object(["revision", "chapters"], {
      revision: whole("The tour's revision: every upload, replace or change of the chapters moves it on. Send it back with a change."),
      chapters: { type: "array", items: ref("Chapter"), description: "In the order visitors see them." },
    }),
    ChaptersBody: input(["revision", "chapters"], {
      revision: whole("The revision the chapters were read at, from GET /api/v1/tours/{id}/chapters."),
      chapters: { type: "array", minItems: 1, maxItems: MAX_CHAPTERS, items: { type: "string", pattern: "^ch_[0-9a-f]{24}$" }, description: "The ids of the chapters to keep, in their new order, each once. A chapter of the tour not listed is removed." },
    }),
    PublishBody: input([], {
      publish_id: { type: ["string", "null"], pattern: "^pub_[0-9a-f]{24}$", description: "The publish_id of the previous answer, to continue that publish. Never together with access or viewers." },
      access: CREATION_ACCESS("tour", "on the request that starts its first publish (no publish_id), of a tour never published whose setting and list were never set in the dashboard", 1024),
      viewers: CREATION_VIEWERS("tour"),
      pad: CREATION_PAD(1024, 1024 + ACCESS_BODY_BYTES),
    }),
    Published: object(
      ["slug", "url", "steps", "access", "viewers"],
      {
        slug: { type: "string" },
        url: { type: "string", description: "The tour's link as a path, /t/<slug>, to put after the server address." },
        steps: whole("How many steps the published version has."),
        access: ACCESS_FIELD,
        viewers: VIEWERS_FIELD,
      },
      "The new version is live.",
    ),
    TourAccess: object(
      ["access", "viewers", "limit", "can_restrict", "switching"],
      {
        access: ACCESS_FIELD,
        viewers: { type: "array", maxItems: MAX_VIEWERS, items: { type: "string" }, description: "The addresses on the tour's list, in order, as the server wrote them (trimmed, lowercase). Kept when the setting is not people." },
        limit: { type: "integer", const: MAX_VIEWERS, description: "The most addresses the list may hold." },
        can_restrict: { type: "boolean", description: "Whether this site can send mail, which people and me need: false means the tour cannot be made restricted here (one that is stays so)." },
        switching: orNull(
          object(
            ["done", "total", "target"],
            { done: whole("Pictures moved so far."), total: whole("Pictures to move in all."), target: { type: "string", enum: ["public", "restricted"], description: "Which way the move goes: to public, or to restricted (people or me)." } },
            "A move of the live pictures in progress.",
          ),
        ),
      },
      "Who may view the tour.",
    ),
    TourAccessForToken: object(
      ["access", "viewers_count", "limit", "can_restrict", "switching"],
      {
        access: ACCESS_FIELD,
        viewers_count: whole(`How many addresses the tour's list holds (at most ${MAX_VIEWERS}); the addresses themselves are answered to a signed-in session only.`),
        limit: { type: "integer", const: MAX_VIEWERS, description: "The most addresses the list may hold." },
        can_restrict: { type: "boolean", description: "Whether this site can send mail, which making a public tour people or me needs." },
        switching: orNull(
          object(
            ["done", "total", "target"],
            { done: whole("Pictures moved so far."), total: whole("Pictures to move in all."), target: { type: "string", enum: ["public", "restricted"], description: "Which way the move goes: to public, or to restricted (people or me)." } },
            "A move of the live pictures in progress.",
          ),
        ),
      },
      "Who may view the tour, as a token reads it: without the addresses.",
    ),
    MediaAccess: object(
      ["access", "viewers", "limit", "can_restrict"],
      {
        access: ACCESS_FIELD,
        viewers: { type: "array", maxItems: MAX_VIEWERS, items: { type: "string" }, description: "The addresses on the item's list, in order, as the server wrote them (trimmed, lowercase). Kept when the setting is not people." },
        limit: { type: "integer", const: MAX_VIEWERS, description: "The most addresses the list may hold." },
        can_restrict: { type: "boolean", description: "Whether this site can send mail to a visitor of an image or clip, which people and me need: false means the item cannot be made restricted here (one that is stays so)." },
      },
      "Who may view the item.",
    ),
    MediaAccessForToken: object(
      ["access", "viewers_count", "limit", "can_restrict"],
      {
        access: ACCESS_FIELD,
        viewers_count: whole(`How many addresses the item's list holds (at most ${MAX_VIEWERS}); the addresses themselves are answered to a signed-in session only.`),
        limit: { type: "integer", const: MAX_VIEWERS, description: "The most addresses the list may hold." },
        can_restrict: { type: "boolean", description: "Whether this site can send mail, which making a public item people or me needs." },
      },
      "Who may view the item, as a token reads it: without the addresses.",
    ),
    AccessBody: input(
      ["access"],
      {
        access: ACCESS_FIELD,
        viewers: {
          type: ["array", "null"],
          items: { type: "string", maxLength: 254 },
          description: `The whole new list, replacing the old one; absent or null leaves the list as it is. Duplicates (after trimming and lowercasing) count once; at most ${MAX_VIEWERS} addresses.`,
        },
      },
    ),
    AccessSwitching: object(
      ["status", "done", "total", "target"],
      {
        status: { type: "string", const: "switching" },
        done: whole("Pictures moved so far."),
        total: whole("Pictures to move in all."),
        target: { type: "string", enum: ["public", "restricted"], description: "Which way the move goes: to public, or to restricted (people or me)." },
      },
      "The live pictures are moving between the stores. Send the same request again.",
    ),
    Me: object(
      ["workspace", "version"],
      {
        workspace: { type: "string", description: "The workspace's name." },
        version: { type: "string", description: "The server's version." },
        addresses: object(
          ["tours", "app"],
          { tours: { type: "string", description: "The host name tour links use." }, app: { type: "string", description: "The host name of the app address." } },
          "Only on a server with two addresses: both host names, without a scheme. Absent means: use the address you were given.",
        ),
      },
    ),
    Usage: object(
      ["used_bytes", "allowance_bytes", "over", "tours", "images", "gifs", "counted"],
      {
        used_bytes: whole("What the workspace uses, in bytes: the five numbers of counted together."),
        allowance_bytes: { type: ["integer", "null"], description: "The workspace's storage allowance in bytes: its own number, else the server's setting. null when there is no limit." },
        over: { type: "boolean", description: "true when more is used than the allowance. Always false without a limit; exactly the allowance is not over it." },
        tours: whole("How many tours the workspace has, drafts and published."),
        images: whole("How many shared images the workspace has online. One still being sent is not counted here, though its bytes are counted."),
        gifs: whole("How many shared clips (GIFs and MP4s) the workspace has online. One still being sent is not counted here, though its bytes are counted."),
        counted: object(
          ["pictures", "logos", "uploads_in_progress", "images", "gifs"],
          {
            pictures: whole("The images of every step of every tour, published or not."),
            logos: whole("The tours' logos. A logo stored by a server before version 0.1.8 counts as 0."),
            uploads_in_progress: whole("The room held by tour uploads that are not finished: what each one needed when it was started. A shared item still being sent is not in it: it counts under images or gifs."),
            images: whole("The shared images, in every state: each one's declared bytes, its current preview, and every send of a part or preview that is not the current one yet or any more (one under way, one it replaced, one that died) until its file is removed. An image counts from the moment it is started, also while it is still being sent, and one being deleted counts until its files are gone."),
            gifs: whole("The shared clips (GIFs and MP4s), counted as images are."),
          },
          "What used_bytes is made of, in bytes. The five numbers add up to used_bytes.",
        ),
      },
      "What a workspace uses of its storage allowance.",
    ),
    LargestTours: object(["tours", "largest"], {
      tours: {
        type: "array",
        maxItems: LARGEST_TOURS,
        description: `The tours alone: at most ${LARGEST_TOURS}, largest first; tours of the same size in the order of their ids.`,
        items: object(["id", "title", "bytes"], {
          id: { type: "string", pattern: "^tour_[0-9a-f]{24}$" },
          title: { type: "string" },
          bytes: whole("The tour's size in bytes, as the tour list gives it."),
        }),
      },
      largest: {
        type: "array",
        maxItems: LARGEST_TOURS,
        description: `Tours, images and GIFs together: at most ${LARGEST_TOURS}, largest first; things of the same size in the order of their ids.`,
        items: object(["kind", "id", "title", "bytes"], {
          kind: { type: "string", enum: ["tour", "image", "gif"], description: "tour, image, or gif for a shared clip (a GIF or an MP4). Delete a tour with DELETE /api/v1/tours/{id}, an image or a GIF with DELETE /api/v1/media/{id}." },
          id: { type: "string", pattern: "^(tour|med)_[0-9a-f]{24}$", description: "A tour's id (tour_…) or a shared item's (med_…)." },
          title: { type: ["string", "null"], description: "The title. null for a shared item that has none; a tour always has one. Show it as text: it may hold any characters." },
          bytes: whole("The size in bytes: what deleting it frees, as GET /api/v1/usage counts it. A tour's as the tour list gives it; for an item, its declared bytes, its current preview, and every send of a part or preview that is not the current one yet or any more (one under way, one it replaced, one that died) until its file is removed."),
        }),
      },
    }),
    StorageFull: object(
      ["error", "detail", "used_bytes", "allowance_bytes", "needed_bytes"],
      {
        error: { type: "string", enum: ["storage_full"] },
        detail: { type: "string", description: "The same in words, as one sentence under 200 characters that a program can show after its own words, such as \"Could not start the upload: \". The text may change; do not match on it." },
        used_bytes: whole("What the workspace uses now, in bytes."),
        allowance_bytes: whole("The workspace's storage allowance, in bytes."),
        needed_bytes: whole(`The room this upload needs, in bytes: all its images, and for a logo it carries its logo_bytes, or ${n(LOGO_RULE.maxBytes)} without one; for the replacement of a chapter, only what that comes to above the chapter's present images and, for a tour's first chapter, the recorded size of its present logo. For a shared item, its bytes; for an item's preview, what its size comes to above the preview it replaces.`),
      },
      "The upload, shared item or preview would take the workspace over its storage allowance. Nothing was stored, and no upload or item exists that this request made.",
    ),
    MediaCreate: input(
      ["kind", "content_type", "bytes", "width", "height"],
      {
        kind: { type: "string", enum: ["image", "clip"], description: "An image (a PNG or a JPEG) or a clip (a GIF or an MP4)." },
        content_type: { type: "string", enum: ["image/png", "image/jpeg", "image/gif", "video/mp4"], description: "image/png or image/jpeg for an image, image/gif or video/mp4 for a clip. Part 0 must be a file of this type." },
        bytes: whole(`The file's length in bytes: at most ${n(DEFAULT_MEDIA_LIMITS.imageMaxBytes)} for an image and ${n(DEFAULT_MEDIA_LIMITS.clipMaxBytes)} for a clip.`, 1),
        width: whole(`In pixels: at most ${n(DEFAULT_MEDIA_LIMITS.imageMaxSide)} for an image and ${n(CLIP_MAX_SIDE)} for a clip. For a PNG, JPEG or GIF it must be what the file says.`, 1),
        height: whole("In pixels, as width.", 1),
        duration_ms: { type: "integer", minimum: 1, maximum: CLIP_MAX_DURATION_MS, description: "How long the clip runs, in milliseconds. Required for a clip; leave it out for an image. Shown as given." },
        title: { type: ["string", "null"], maxLength: TITLE_MAX, description: `Optional: at most ${TITLE_MAX} characters after trimming, no control or format characters. Empty is no title.` },
        access: CREATION_ACCESS("item", "in this request that creates it", 4096),
        viewers: CREATION_VIEWERS("item"),
        pad: CREATION_PAD(4096, 4096 + ACCESS_BODY_BYTES),
      },
    ),
    MediaCreated: object(["id", "parts", "part_bytes"], {
      id: { type: "string", pattern: "^med_[0-9a-f]{24}$" },
      parts: whole("How many parts to send, numbered from 0.", 1),
      part_bytes: whole(`The length of every part but the last, which holds the rest: ${n(PART_BYTES)}.`, 1),
      access: {
        ...ACCESS_FIELD,
        description: "Only when the request stated access (since version 0.1.51): the setting the item was created with. Missing although the request stated one means a server before 0.1.51, which ignored it: the item is public, so delete it before sending any part.",
      },
      viewers: whole(`Only when the request stated access: how many addresses the item's list holds (at most ${MAX_VIEWERS}), never the addresses.`),
    }),
    MediaCommitted: object(["id", "link_id", "kind", "path", "link"], {
      id: { type: "string", pattern: "^med_[0-9a-f]{24}$" },
      link_id: { type: "string", pattern: "^[a-z2-7]{20}$", description: "The item's public name. It never changes." },
      kind: { type: "string", enum: ["image", "clip"] },
      path: { type: "string", description: "The item's public address as a path: /i/<link_id> for an image, /r/<link_id> for a clip." },
      link: { type: "string", description: "The item's public address in full, on the address for images and clips from the server's settings. When the settings name no address it is the same as path, to put after the server address." },
    }),
    MediaItem: object(["id", "link_id", "kind", "title", "content_type", "bytes", "width", "height", "duration_ms", "created_at", "has_preview", "path", "link", "access", "viewers"], {
      id: { type: "string", pattern: "^med_[0-9a-f]{24}$" },
      link_id: { type: "string", pattern: "^[a-z2-7]{20}$" },
      kind: { type: "string", enum: ["image", "clip"] },
      title: { type: ["string", "null"] },
      content_type: { type: "string", enum: ["image/png", "image/jpeg", "image/gif", "video/mp4"] },
      bytes: whole("The file's length in bytes.", 1),
      width: whole("In pixels.", 1),
      height: whole("In pixels.", 1),
      duration_ms: { type: ["integer", "null"], description: "A clip's duration in milliseconds, as given. null for an image." },
      created_at: whole("When the item was started, in milliseconds since 1970."),
      has_preview: { type: "boolean", description: "Whether a preview picture was sent." },
      path: { type: "string", description: "The public address as a path: /i/<link_id> or /r/<link_id>." },
      link: { type: "string", description: "The public address in full, from the server's settings; the same as path when they name no address." },
      access: { ...ACCESS_FIELD, description: "Who may view the item: public (anyone with the link), people (the addresses on its list and the workspace's account) or me (the workspace's account alone)." },
      viewers: ITEM_VIEWERS_FIELD,
    }),
    MediaItemState: object(["id", "link_id", "kind", "title", "content_type", "bytes", "width", "height", "duration_ms", "created_at", "has_preview", "path", "link", "access", "viewers", "state"], {
      id: { type: "string", pattern: "^med_[0-9a-f]{24}$" },
      link_id: { type: "string", pattern: "^[a-z2-7]{20}$" },
      kind: { type: "string", enum: ["image", "clip"] },
      title: { type: ["string", "null"] },
      content_type: { type: "string", enum: ["image/png", "image/jpeg", "image/gif", "video/mp4"] },
      bytes: whole("The file's length in bytes.", 1),
      width: whole("In pixels.", 1),
      height: whole("In pixels.", 1),
      duration_ms: { type: ["integer", "null"], description: "A clip's duration in milliseconds, as given. null for an image." },
      created_at: whole("When the item was started, in milliseconds since 1970."),
      has_preview: { type: "boolean", description: "Whether a preview picture was sent." },
      path: { type: "string", description: "The public address as a path: /i/<link_id> or /r/<link_id>." },
      link: { type: "string", description: "The public address in full, from the server's settings; the same as path when they name no address." },
      access: { ...ACCESS_FIELD, description: "Who may view the item: public (anyone with the link), people (the addresses on its list and the workspace's account) or me (the workspace's account alone)." },
      viewers: ITEM_VIEWERS_FIELD,
      state: { type: "string", enum: ["uploading", "online"], description: "uploading until the item is finished, then online." },
    }),
    MediaList: object(["items", "next"], {
      items: { type: "array", maxItems: LIST_PAGE, items: ref("MediaItem"), description: "Newest first." },
      next: { type: ["string", "null"], description: "Send it as cursor for the next page. null on the last page." },
    }),
    MediaTooLarge: object(
      ["error", "detail", "max_bytes", "max_side"],
      {
        error: { type: "string", enum: ["media_too_large"] },
        detail: { type: "string", description: "The same in words. The text may change; do not match on it." },
        max_bytes: whole("The most bytes an item of this kind may have here.", 1),
        max_side: whole("The most pixels an item of this kind may have on a side.", 1),
      },
      "The item is larger than this server takes. Nothing was stored.",
    ),
    SignInRequest: input(["email"], { email: text(254, "The address to send the link to. Spaces around it are dropped and capitals do not count.", 3) }),
    SignInComplete: input(["code"], { code: { type: "string", pattern: "^dpl_[0-9a-f]{40}$", description: "The code of the link, the part after #c= in its address." } }),
    InviteCheck: input(["code"], { code: { type: "string", pattern: "^dpi_[0-9a-f]{40}$", description: "The code of the invite's link, the part after # in its address." } }),
    InviteAccept: input(["code", "username"], {
      code: { type: "string", pattern: "^dpi_[0-9a-f]{40}$", description: "The code of the invite's link, the part after # in its address." },
      username: { type: "string", description: "The username the person chooses: 3 to 30 lowercase letters, digits and hyphens, a letter first, no hyphen last and no two in a row, and not one the site holds back. Spaces around it are dropped and capitals become small letters. It cannot be changed later." },
    }),
    InviteFound: object(
      ["email", "invited_by", "expires_at"],
      {
        email: { type: "string", description: "The invited address, which the account will have." },
        invited_by: { type: ["string", "null"], description: "The username of the admin who sent the invite. null when that account has none or is gone." },
        expires_at: whole("When the link stops working, in milliseconds since 1970."),
      },
      "What the page shows before the account is made.",
    ),
    ViewerRequest: input(["email", "slug"], {
      email: text(254, "The visitor's address. Spaces around it are dropped and capitals do not count. Anything else answers the same, and nothing is sent."),
      slug: text(64, "The slug of the tour, as in its link /t/<slug>."),
    }),
    ViewerCode: input(["code"], { code: viewerCode }),
    MediaViewerRequest: input(["email", "path"], {
      email: text(254, "The visitor's address. Spaces around it are dropped and capitals do not count. Anything else answers the same, and nothing is sent."),
      path: text(64, "The item's page, as in its link: /i/<link_id> or /r/<link_id>."),
    }),
    MediaViewerCode: input(["code"], { code: mediaViewerCode }),
    MediaViewerFound: object(["email", "path"], { email: { type: "string", description: "The address the link was mailed to: the one the browser will prove." }, path: { ...ITEM_PAGE_FIELD, description: "The item's page the link was asked from." } }),
    MediaViewerDone: object(["path"], { path: { ...ITEM_PAGE_FIELD, description: "The item's page the link was asked from, where the page goes next." } }),
    ViewerFound: object(["email", "slug"], { email: { type: "string", description: "The address the link was mailed to: the one the browser will prove." }, slug: { type: "string", pattern: "^[a-z2-7]{10}$", description: "The tour the link was asked for." } }),
    ViewerDone: object(["slug"], { slug: { type: "string", pattern: "^[a-z2-7]{10}$", description: "The tour the link was asked for, where the page goes next." } }),
    ViewerSession: object(["email"], { email: { type: "string", description: "The address this browser proved." } }),
    InviteSend: object(["email"], { email: text(254, "The address to invite. Spaces around it are dropped and capitals do not count.", 3) }),
    Invite: object(
      ["id", "email", "created_at", "expires_at", "state"],
      {
        id: { type: "string", pattern: "^inv_[0-9a-f]{24}$" },
        email: { type: "string", description: "The invited address, as stored: in small letters." },
        created_at: whole("When it was sent, or last sent again, in milliseconds since 1970."),
        expires_at: whole("When its link stops working, in milliseconds since 1970."),
        state: { type: "string", enum: ["open", "expired"], description: "open while the link works; expired once its time ran out." },
      },
      "One invite that is open or ran out. An accepted or cancelled invite is gone.",
    ),
    InviteList: object(["invites"], {
      invites: { type: "array", maxItems: MAX_INVITES, description: `The site's invites, newest first, at most ${MAX_INVITES}: every open one, then as many that ran out as fit.`, items: ref("Invite") },
    }),
    EmailChangeRequest: input(["email"], { email: text(254, "The new address, which the link is mailed to. Spaces around it are dropped and capitals do not count.", 3) }),
    EmailChangeConfirm: input(["code"], { code: { type: "string", pattern: "^dpe_[0-9a-f]{40}$", description: "The code of the link mailed to the new address, the part after #c= in its address." } }),
    EmailChanged: object(
      ["email", "previous_email"],
      { email: { type: "string", description: "The account's address from now on." }, previous_email: { type: "string", description: "The address it had, which was sent a notice." } },
      "The change was made.",
    ),
    ConnectStart: input(["device_name"], { device_name: text(DEVICE_NAME_MAX * 4 + 64, `What the app calls this computer, shown to the person who confirms and as the token's name: ${DEVICE_NAME_MAX} characters at most once spaces around it are dropped, with no control or formatting characters.`, 1) }),
    ConnectStarted: object(
      ["device_code", "user_code", "verify_url", "expires_in", "interval"],
      {
        device_code: { type: "string", pattern: "^dpd_[0-9a-f]{40}$", description: "The secret the app asks for its token with. Keep it to the app: never show it or put it in an address." },
        user_code: { type: "string", pattern: `^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`, description: "The short code to show, for the person to type on the Connections page. Its characters leave out the ones that look alike (0 and O, 1, I and L, and U)." },
        verify_url: { type: "string", description: `The dashboard's Connections page, ${VERIFY_PATH}, where the short code is typed, on the address from the server's settings (the app address, or the one address), never from the request. When the server has no address in its settings it is the bare path: join it to the address the app is set up with. It holds neither code.` },
        expires_in: { type: "integer", const: CONNECT_MS / 1000, description: "Seconds the codes live." },
        interval: { type: "integer", const: POLL_INTERVAL_S, description: "Seconds to wait between two asks for the token." },
      },
      "A request to connect, waiting for a person to confirm it.",
    ),
    ConnectPoll: input(["device_code"], { device_code: { type: "string", description: "The device code POST /api/v1/connect/start gave." } }),
    ConnectPending: object(["status"], { status: { type: "string", const: "pending" } }, "Nobody has confirmed the request yet. Ask again after the interval."),
    ConnectConnected: object(
      ["status", "token", "workspace", "account", "version"],
      {
        status: { type: "string", const: "connected" },
        token: { type: "string", pattern: "^dp_[0-9a-f]{40}$", description: "The new token, given this once. Its name is the device's name." },
        workspace: object(["id", "name"], { id: { type: "string", pattern: "^ws_[0-9a-f]{24}$" }, name: { type: "string", description: "The workspace's name." } }, "The workspace of the person who confirmed, the one the token acts in."),
        account: object(["username"], { username: { type: ["string", "null"], description: "The confirming account's username; null when it has none. Never its email address." } }, "Who confirmed. Show it, so a person whose code someone else confirmed notices."),
        version: { type: "string", description: "The server's version." },
        addresses: object(
          ["tours", "app"],
          { tours: { type: "string", description: "The host name tour links use." }, app: { type: "string", description: "The host name of the app address." } },
          "Only on a server with two addresses: both host names, as GET /api/v1/me gives them.",
        ),
      },
      "Confirmed: the token, made now.",
    ),
    ConnectRequest: object(
      ["device_name", "asked_at", "same_network"],
      {
        device_name: { type: "string", description: "What the app calls the computer. Show it as text only." },
        asked_at: whole("When the app asked, in milliseconds since 1970."),
        same_network: { type: "boolean", description: "true when the person looking it up is on the network the app asked from; false when the networks differ or either is not known. When it is false, the code may have come from someone else: warn before confirming." },
      },
      "A request waiting for a person to confirm or refuse it.",
    ),
    UserCode: input(["user_code"], { user_code: { type: "string", maxLength: 32, description: "The short code the app shows, with or without its dash, in any case." } }),
    TokenEntry: object(
      ["id", "name", "created_at", "last_used_at", "kind", "expires_at", "expired"],
      {
        id: { type: "string", pattern: "^tok_[0-9a-f]{24}$" },
        name: { type: "string", description: "The token's name: First token for the one made with the workspace, the device's name for one made by connecting the app, or what it was renamed to." },
        created_at: whole("When it was made, in milliseconds since 1970."),
        last_used_at: { type: ["integer", "null"], minimum: 0, description: "When it was last used, in milliseconds since 1970; null until then." },
        kind: { type: "string", enum: ["setup", "sign_in"], description: "How it was made: setup by the setup wizard or with a new account; sign_in by connecting the app while signed in." },
        expires_at: {
          type: ["integer", "null"],
          minimum: 0,
          description:
            "When it stops working, in milliseconds since 1970, unless something changes: for kind sign_in, the earlier of its last use (or its creation, when never used) plus the site's CONNECTION_IDLE_DAYS and its creation plus CONNECTION_MAX_DAYS. Each use moves the first. null for kind setup, which no limit touches, and when both limits are off. The limits are read when a request is made, so a changed setting changes this at once.",
        },
        expired: { type: "boolean", description: "true from expires_at on: the token is refused as a revoked one is (401 unauthorized), and the computer must sign in again. It stays listed until it is revoked." },
      },
      "One token. Never the token itself, nor any part of it.",
    ),
    TokenList: object(["tokens"], { tokens: { type: "array", description: `The workspace's tokens that are not revoked, expired ones included, newest first, at most ${MAX_TOKENS_LISTED}.`, items: ref("TokenEntry") } }),
    TokenRename: input(["name"], { name: text(DEVICE_NAME_MAX * 4 + 64, `The new name: ${DEVICE_NAME_MAX} characters at most once spaces around it are dropped, with no control or formatting characters.`, 1) }),
    Ok: object(["ok"], { ok: { type: "boolean", const: true } }),
    Session: object(
      ["account", "workspace", "session", "csrf", "email_change", "download_url", "limits"],
      {
        account: object(
          ["id", "username", "email", "admin"],
          {
            id: { type: "string", pattern: "^usr_[0-9a-f]{24}$" },
            username: { type: ["string", "null"], description: "null until the account has one." },
            email: { type: "string" },
            admin: { type: "boolean", description: "true for the site's admin." },
          },
          "The account the session belongs to.",
        ),
        workspace: object(["id", "name"], { id: { type: "string", pattern: "^ws_[0-9a-f]{24}$" }, name: { type: "string" } }, "The account's workspace, the one every request of the session acts in."),
        session: object(
          ["id", "created_at", "expires_at", "ends_at"],
          {
            id: { type: "string", pattern: "^ses_[0-9a-f]{24}$" },
            created_at: whole("When the browser signed in, in milliseconds since 1970."),
            expires_at: whole("When the session ends unless it is used, in milliseconds since 1970."),
            ends_at: ENDS_AT,
          },
          "This session.",
        ),
        csrf: { type: "string", pattern: "^[0-9a-f]{64}$", description: "The anti-forgery value: send it in the X-Csrf-Token header of every change made with this session." },
        email_change: { type: "boolean", description: "true when the site can mail the link an email change needs; false when its mail is off, and POST /api/v1/account/email then answers mail_off." },
        download_url: {
          type: ["string", "null"],
          maxLength: DOWNLOAD_URL_MAX,
          description: "The address of the public page the desktop app is downloaded from, from the site's DOWNLOAD_URL setting: an https address with a host name, an optional port and a path, no user name and no fragment. null when the site has none. The dashboard links to it.",
        },
        limits: object(
          ["session_max_days", "connection_idle_days", "connection_max_days"],
          {
            session_max_days: LIMIT_DAYS("SESSION_MAX_DAYS: a session ends this many days after it was made, however active it is."),
            connection_idle_days: LIMIT_DAYS("CONNECTION_IDLE_DAYS: a connection made by signing in from the app stops working after this many days without use."),
            connection_max_days: LIMIT_DAYS("CONNECTION_MAX_DAYS: a connection made by signing in from the app stops working this many days after it was made."),
          },
          "The site's sign-in lifetimes, in whole days, as its settings give them now.",
        ),
        terms_agreed: object(
          ["version", "agreed_at"],
          { version: { type: "string", description: "Its label. Show it as text." }, agreed_at: whole("When, in milliseconds since 1970.") },
          "Only when the account has agreed to a version of the site's terms: the newest it agreed to, for the account page. An account that has agreed to none, and so every account of a site without terms, gets no such field.",
        ),
      },
    ),
    SessionList: object(["sessions"], {
      sessions: {
        type: "array",
        description: "The account's live sessions, the current one first.",
        items: object(["id", "label", "created_at", "last_used_at", "expires_at", "ends_at", "current"], {
          id: { type: "string", pattern: "^ses_[0-9a-f]{24}$" },
          label: { type: "string", maxLength: 40, description: "The browser and the system it was signed in on, such as Firefox on Linux, or Unknown browser." },
          created_at: whole("When it was signed in, in milliseconds since 1970."),
          last_used_at: whole("When it was last used, to the hour, in milliseconds since 1970."),
          expires_at: whole("When it ends unless it is used, in milliseconds since 1970."),
          ends_at: ENDS_AT,
          current: { type: "boolean", description: "true for the session this request was sent with." },
        }),
      },
    }),
    AdminAccount: object(
      ["id", "username", "email", "status", "admin", "created_at", "deleting", "workspace_id", "workspace_name", "tours", "used_bytes", "allowance_bytes", "storage_allowance_bytes", "over", "counted", "terms"],
      {
        id: { type: "string", pattern: "^usr_[0-9a-f]{24}$", description: "The account's id." },
        username: { type: ["string", "null"], description: "null until the account has one." },
        email: { type: "string", description: "The address the account signs in with." },
        status: { type: "string", enum: ["active", "disabled"], description: "disabled: the account cannot sign in, and its workspace's tokens are refused." },
        admin: { type: "boolean", description: "true for the site's admin." },
        created_at: whole("When the account was made, in milliseconds since 1970."),
        deleting: { type: "boolean", description: "true once a delete of the account has started and until it finishes: send DELETE /api/v1/admin/accounts/{id} again to finish it. Such an account stays disabled and cannot be enabled." },
        workspace_id: { type: "string", pattern: "^ws_[0-9a-f]{24}$", description: "The account's workspace: the id to set its allowance with." },
        workspace_name: { type: "string", description: "The workspace's name, as its owner wrote it. Show it as text: it may hold any characters." },
        tours: whole("How many tours the workspace has, drafts and published."),
        used_bytes: whole("What the workspace uses, in bytes, counted as GET /api/v1/usage counts it for the account itself."),
        allowance_bytes: { type: ["integer", "null"], description: "The allowance in force, in bytes: the workspace's own number, else the server's setting. null when there is no limit." },
        storage_allowance_bytes: { type: ["integer", "null"], description: "The workspace's own number, in bytes. null when it has none and the site's default applies." },
        over: { type: "boolean", description: "true when more is used than the allowance in force." },
        counted: object(
          ["pictures", "logos", "uploads_in_progress", "images", "gifs"],
          {
            pictures: whole("The images of every step of every tour."),
            logos: whole("The tours' logos."),
            uploads_in_progress: whole("The room held by tour uploads that are not finished."),
            images: whole("The shared images, counted as in GET /api/v1/usage, as one total."),
            gifs: whole("The shared clips (GIFs and MP4s), counted as in GET /api/v1/usage, as one total."),
          },
          "What used_bytes is made of, in bytes, as in GET /api/v1/usage. The five numbers add up to used_bytes.",
        ),
        terms: orNull(
          object(
            ["version", "agreed_at", "current"],
            {
              version: { type: "string", description: "The label of the version of the site's terms the account agreed to last. Show it as text." },
              agreed_at: whole("When it agreed to it, in milliseconds since 1970."),
              current: { type: "boolean", description: "true when that is the site's current terms; false when the account agreed only to an older version and has not agreed to the current one yet." },
            },
            "The account's newest agreement to the site's terms: the version's label, the time and whether it is to the current terms, nothing else. null when it has agreed to none (the Admin page says Not yet).",
          ),
        ),
      },
      "One account and how its workspace uses its storage. Nothing of the workspace's tours or shared items: no tour, item, title, link, picture, token or session.",
    ),
    TermsLink: object(["label", "url"], { label: text(TERMS_LIMITS.linkLabelChars, "What the link says. Show it as text."), url: { type: "string", maxLength: TERMS_LIMITS.linkUrlChars, description: "An https address with a host name, no user name or password and no # part, as the site published it." } }),
    TermsBlock: {
      oneOf: [
        object(["kind", "text"], { kind: { type: "string", enum: ["heading", "paragraph"] }, text: { type: "string", minLength: 1, description: "Show it as text." } }, "A heading or a paragraph."),
        object(["kind", "items"], { kind: { type: "string", const: "list" }, items: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "The bullets, in order. Show them as text." } }, "A list of bullets."),
      ],
    },
    Terms: object(
      ["id", "title", "version", "points", "links", "body", "published_at"],
      {
        id: { type: "string", pattern: "^trm_[0-9a-f]{24}$", description: "The version's id, which POST /api/v1/terms/agree takes." },
        title: text(TERMS_LIMITS.titleChars, "The terms' title.", 1),
        version: text(TERMS_LIMITS.versionChars, "The version's label, free text such as a date.", 1),
        points: { type: "array", maxItems: TERMS_LIMITS.points, items: text(TERMS_LIMITS.pointChars, "One main point.", 1), description: "The main points: a summary. The full terms in body are what is agreed to." },
        links: { type: "array", maxItems: TERMS_LIMITS.links, items: ref("TermsLink"), description: "Pages the site offers the terms as, if any." },
        body: { type: "array", minItems: 1, items: ref("TermsBlock"), description: "The full terms, block by block." },
        published_at: whole("When the version was published, in milliseconds since 1970."),
      },
      "One version of the site's terms, exactly as it was published; a version is never changed. Every text is the site's own: show it as text, never as markup. A version is checked when it is published; read back, a link today's rule refuses is left out, and the texts are as stored.",
    ),
    TermsAgreement: object(
      ["terms_id", "version", "agreed_at"],
      {
        terms_id: { type: "string", pattern: "^trm_[0-9a-f]{24}$", description: "The version agreed to." },
        version: { type: "string", description: "Its label." },
        agreed_at: whole("When, in milliseconds since 1970."),
      },
      "The account's newest agreement.",
    ),
    TermsState: object(
      ["terms", "agreed", "required", "csrf"],
      {
        terms: orNull(ref("Terms")),
        agreed: orNull(ref("TermsAgreement")),
        required: { type: "boolean", description: "true while the account has not agreed to the current terms: until it does, its session can make no other request but these and signing out." },
        csrf: { type: "string", pattern: "^[0-9a-f]{64}$", description: "The session's anti-forgery value, for the X-Csrf-Token header of POST /api/v1/terms/agree; GET /api/v1/session gives the same value once the terms are agreed to." },
      },
      "The current terms (null: the site has published none), the account's newest agreement (null: none), and whether the account still has to agree.",
    ),
    TermsAgreed: object(
      ["terms", "agreed_at"],
      { terms: orNull(ref("Terms")), agreed_at: { type: ["integer", "null"], minimum: 0, description: "When the account agreed to it, in milliseconds since 1970; null with terms." } },
      "The version the account agreed to last, with the time; both null when it has agreed to none.",
    ),
    TermsAgree: input(["terms"], { terms: { type: "string", pattern: "^trm_[0-9a-f]{24}$", description: "The id of the version that was shown, from GET /api/v1/terms." } }, "The body takes this one field and nothing else."),
    AdminSummary: object(
      ["accounts", "used_bytes", "standard_allowance_bytes"],
      {
        accounts: whole("How many accounts the site has."),
        used_bytes: whole("What all workspaces use together, in bytes: the sum of every account's used_bytes in the list of accounts."),
        standard_allowance_bytes: { type: ["integer", "null"], description: "The site's standard allowance from the server's settings, in bytes, which every workspace without a number of its own has. null when none is set: no limit." },
        billing_problems: object(
          ["count", "recent"],
          {
            count: whole("How many billing problems the audit record holds: paid checkouts no workspace stored, second paid subscriptions of one workspace, and paid checkouts that named a workspace's checkout but not its reference or customer."),
            recent: {
              type: "array",
              maxItems: BILLING_PROBLEMS_LISTED,
              description: `The newest of them, newest first, at most ${BILLING_PROBLEMS_LISTED}.`,
              items: object(
                ["event", "workspace_id", "at"],
                {
                  event: { type: "string", enum: ["billing_checkout_unmatched", "billing_second_subscription", "billing_checkout_mismatch", "billing_answer_refused"], description: "What happened: a paid checkout no workspace stored, a second paid subscription of one workspace, a paid checkout that named a workspace's checkout but not its reference or customer, or an answer of Stripe the site refused for its shape (the audit row names the call and the field)." },
                  workspace_id: { type: ["string", "null"], description: "The workspace it was about, or null when no workspace could be told." },
                  at: whole("When, in milliseconds since 1970."),
                },
                "One billing problem.",
              ),
            },
          },
          "Only on a site with billing switched on: billing problems the admin should look at in Stripe.",
        ),
        billing_price: {
          type: "string",
          enum: ["ok", "could_not_check", "not_checked"],
          description: "Only on a site with billing switched on: whether Stripe answered the configured price with the configured key when the site started (on Cloudflare, on the isolate's first request). could_not_check: the key may not read prices (give it Prices: read), or Stripe did not answer; not_checked: not asked yet. A price Stripe says does not exist stops the start instead.",
        },
      },
      "The site's storage in all. Three numbers, nothing of any workspace, and on a site with billing its billing problems.",
    ),
    AdminAccountList: object(["accounts", "next", "current_terms"], {
      current_terms: orNull(object(["version"], { version: { type: "string", description: "Its label. Show it as text." } }, "The site's current terms: the newest version published.")),
      accounts: { type: "array", maxItems: ADMIN_PAGE, description: `The accounts, in the order they were made, at most ${ADMIN_PAGE}.`, items: ref("AdminAccount") },
      next: { type: ["string", "null"], pattern: "^[A-Za-z0-9_-]{20,100}$", description: "The cursor to ask for the next page with, as ?after=<cursor>: opaque text, to be sent back as it is. An account deleted since does not cut the list short. null on the last page." },
    }),
    AllowanceChange: object(["storage_allowance_bytes"], {
      storage_allowance_bytes: { type: ["integer", "null"], minimum: 0, maximum: MAX_ALLOWANCE_BYTES, description: "The workspace's allowance in bytes, or null to go back to the site's default." },
    }),
    AccountRemoval: object(
      ["username", "email", "tours", "items", "connections", "used_bytes"],
      {
        username: { type: ["string", "null"], description: "The account's username, which the delete is confirmed with. null when it has none: then the delete is confirmed with email." },
        email: { type: "string", description: "The address the account signs in with, as the list of accounts shows it. Once the account is deleted it is free again." },
        tours: whole("The workspace's tours, drafts and published."),
        items: whole("The workspace's shared images and clips that are online."),
        connections: whole("The workspace's tokens that are not revoked: the computers and scripts that can publish to it."),
        used_bytes: whole("What the workspace uses, in bytes, counted as GET /api/v1/usage counts it: what a delete frees."),
      },
      "What deleting the account removes, as counts. Nothing of the workspace's tours or items by name.",
    ),
    AccountDeleteConfirm: input(["username"], {
      username: { type: "string", description: "The account's username exactly as stored, or, for an account with no username, its email address exactly as the list of accounts shows it." },
    }),
    AllowanceSet: object(
      ["workspace_id", "allowance_bytes", "storage_allowance_bytes", "used_bytes", "over"],
      {
        workspace_id: { type: "string", pattern: "^ws_[0-9a-f]{24}$" },
        allowance_bytes: { type: ["integer", "null"], description: "The allowance now in force, in bytes. null when there is no limit." },
        storage_allowance_bytes: { type: ["integer", "null"], description: "The workspace's own number as just set. null when the site's default applies." },
        used_bytes: whole("What the workspace uses, in bytes."),
        over: { type: "boolean", description: "true when the workspace uses more than its new allowance. Nothing is deleted: only uploads that need room are refused." },
      },
    ),
    Health: object(
      ["ok"],
      { ok: { type: "boolean", const: true }, address: { type: "string", enum: ["tours", "app", "img"], description: "Only on a server with two addresses (or three, with the optional img address), when asked on one of them: which one this request reached." } },
    ),
    UploadTarget: {
      description: "Where the upload goes.",
      oneOf: [ref("TargetNew"), ref("TargetChapter"), ref("TargetReplace")],
    },
    TargetNew: input(["kind"], { kind: { type: "string", const: "new" } }, "A new tour, made of this one chapter."),
    TargetChapter: input(
      ["kind", "tour_id"],
      { kind: { type: "string", const: "chapter" }, tour_id: { type: "string", pattern: "^tour_[0-9a-f]{24}$" } },
      "A new chapter at the end of an existing tour. The tour keeps its settings and logo.",
    ),
    TargetReplace: input(
      ["kind", "tour_id", "chapter_id"],
      { kind: { type: "string", const: "replace" }, tour_id: { type: "string", pattern: "^tour_[0-9a-f]{24}$" }, chapter_id: { type: "string", pattern: "^ch_[0-9a-f]{24}$" } },
      "Replaces one chapter of an existing tour. The chapter keeps its id, title and position and gets exactly the manifest's steps.",
    ),
    UploadCreate: input(
      ["manifest", "target"],
      {
        manifest: ref("Manifest"),
        target: ref("UploadTarget"),
        sha256: {
          type: "array",
          maxItems: LIMITS.steps,
          items: { type: "string", pattern: "^[0-9a-f]{64}$" },
          description: "Only with the target replace, and optional: one SHA-256 per step of the manifest, in order, of the image the client would send. The answer's have then lists the steps not to send.",
        },
        logo_bytes: {
          type: "integer",
          minimum: 1,
          maximum: LOGO_RULE.maxBytes,
          description: `Optional: the length in bytes of the logo this upload will send. It counts only for an upload that takes a logo (a new tour, or the replacement of a tour's first chapter) and whose manifest names one; any other upload ignores it. The logo sent must then have exactly this length, and on a workspace with a storage allowance the upload needs this much room for the logo. Without it a logo of any allowed length is taken, and the upload needs ${n(LOGO_RULE.maxBytes)} bytes of room for it.`,
        },
      },
    ),
    UploadCreated: object(
      ["upload_id", "steps"],
      { upload_id: { type: "string", pattern: "^up_[0-9a-f]{24}$" }, steps: whole("How many step images the upload expects.", 1) },
      "The answer for the targets new and chapter.",
    ),
    ReplaceCreated: object(
      ["upload_id", "steps", "have", "settings"],
      {
        upload_id: { type: "string", pattern: "^up_[0-9a-f]{24}$" },
        steps: whole("How many steps the manifest has.", 1),
        have: { type: "array", items: { type: "integer", minimum: 1 }, description: "The step numbers whose image the chapter already has; do not send them. Empty without sha256." },
        settings: { type: "boolean", description: "true when the chapter is the tour's first: the commit then also replaces the tour's settings and logo with the manifest's." },
      },
      "The answer for the target replace.",
    ),
    Committed: object(
      ["tour_id", "chapter_id", "steps"],
      { tour_id: { type: "string", pattern: "^tour_[0-9a-f]{24}$" }, chapter_id: { type: "string", pattern: "^ch_[0-9a-f]{24}$" }, steps: whole("How many steps the chapter has.") },
      "The answer for the targets new and chapter.",
    ),
    ReplaceCommitted: object(
      ["tour_id", "chapter_id", "steps", "publish"],
      {
        tour_id: { type: "string", pattern: "^tour_[0-9a-f]{24}$" },
        chapter_id: { type: "string", pattern: "^ch_[0-9a-f]{24}$" },
        steps: whole("How many steps the chapter has now."),
        publish: {
          type: "string",
          enum: ["draft", "ready", "other_changes"],
          description:
            "What publishing the tour would do now. draft: the tour is not published; nothing is public and nothing needs publishing. ready: the tour is published and the only changes not public yet are replaces of this chapter; publish it to put the update live. other_changes: the tour is published and its draft holds more than replaces of this chapter that was never published; publishing would put all of it live.",
        },
      },
      "The answer for the target replace.",
    ),
    Manifest: input(
      ["version", "generator", "title", "steps"],
      {
        version: { type: "integer", enum: [1, 2, 3], description: "Version 1 has steps only; version 2 adds spotlights and notes; version 3 adds cards, the cover, the button, the end card and the tour's look." },
        generator: text(LIMITS.generator, "The program that wrote the manifest."),
        title: text(LIMITS.title, "The tour's title; for a new chapter, the chapter's.", 1),
        steps: { type: "array", minItems: 1, maxItems: LIMITS.steps, items: ref("ManifestStep"), description: "The steps in order. No two may name the same image." },
        spotlight_dim: { type: ["integer", "null"], minimum: 10, maximum: 90, description: "From version 2: how dark the rest of the picture gets around a spotlight, in percent. Required when a step has a spotlight." },
        theme: ref("Theme"),
        zoom: ref("Zoom"),
        cover: orNull(ref("Cover")),
        cta: orNull(ref("Link")),
        end: orNull(ref("EndCard")),
        autoplay: ref("Autoplay"),
      },
      `The tour as the recorder wrote it, at most ${n(LIMITS.manifestBytes)} bytes. The server checks every field: unknown fields are dropped, and anything out of range, of the wrong type or over a limit is refused with 400 bad_manifest and the field's path, never cut short. Text is trimmed and may hold no control or format characters. theme, zoom, cover, cta, end and autoplay are read from version 3 only. The full rules are in src/manifest.ts.`,
    ),
    ManifestStep: input(
      ["image", "width", "height", "bytes", "click", "t_ms"],
      {
        image: { type: "string", pattern: "^step-[0-9]{3}\\.(png|jpg)$", description: "The image's name; its ending says whether a PNG or a JPEG will be sent." },
        width: { type: "integer", minimum: 1, maximum: LIMITS.imageSide, description: "The image's width in pixels; the image sent must have it." },
        height: { type: "integer", minimum: 1, maximum: LIMITS.imageSide, description: "The image's height in pixels; the image sent must have it." },
        bytes: { type: "integer", minimum: 1, maximum: LIMITS.imageBytes, description: "The image's length in bytes; the image sent must have it." },
        click: orNull(ref("Point")),
        t_ms: whole("When the step was recorded, in milliseconds from the start."),
        spotlight: orNull(ref("Box")),
        notes: { type: "array", maxItems: LIMITS.notesPerStep, items: ref("Note"), description: "From version 2." },
        card: orNull(ref("Card")),
        advance: { type: "string", enum: ["hotspot", "anywhere"], description: "From version 3: whether a click on the hotspot or anywhere moves on. hotspot when absent." },
        zoom: { type: ["boolean", "null"], description: "From version 3: this step's own zoom; null follows the tour's." },
      },
      "One step: a picture, where it was clicked, and what is drawn over it. click is required; null means no click.",
    ),
    Point: input(["x", "y"], { x: percent("Percent of the image's width."), y: percent("Percent of the image's height.") }),
    Box: input(
      ["x", "y", "w", "h"],
      { x: percent("Percent of the width."), y: percent("Percent of the height."), w: percent("Above 0."), h: percent("Above 0.") },
      "A box in percent of the image; it must end inside the image.",
    ),
    Note: { description: "A note drawn on the picture.", oneOf: [ref("TextNote"), ref("BubbleNote")] },
    TextNote: input(["kind", "x", "y", "text", "size", "color"], {
      kind: { type: "string", const: "text" },
      x: percent("Percent of the width."),
      y: percent("Percent of the height."),
      text: text(LIMITS.noteText, "May hold line feeds.", 1),
      size: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "The text size, in percent of the image's height." },
      color: colour("The text colour, #rrggbb."),
    }),
    BubbleNote: input(["kind", "x", "y", "w", "h", "tail", "text", "size", "color", "fill"], {
      kind: { type: "string", const: "bubble" },
      x: percent("Percent of the width."),
      y: percent("Percent of the height."),
      w: percent("Above 0."),
      h: percent("Above 0."),
      tail: ref("Point"),
      text: text(LIMITS.noteText, "May hold line feeds.", 1),
      size: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "The text size, in percent of the image's height." },
      color: colour("The text colour, #rrggbb."),
      fill: colour("The bubble's colour, #rrggbb."),
    }),
    Card: input(
      [],
      {
        title: text(LIMITS.cardTitle, "Empty when absent."),
        body: text(LIMITS.cardBody, "May hold line feeds. Empty when absent."),
        next_label: text(LIMITS.nextLabel, "Next when absent.", 1),
        anchor: { type: "string", enum: ["hotspot", "point", "none"], description: "Where the card points. hotspot (the default) needs a step with a click; point needs point." },
        point: orNull(ref("Point")),
        placement: { type: "string", enum: ["auto", "top", "bottom", "left", "right"], description: "auto when absent." },
      },
      "From version 3: the step's card. It needs a title or a body.",
    ),
    Link: input(
      ["label", "url"],
      { label: text(LIMITS.buttonLabel, "The button's text.", 1), url: text(LIMITS.link, "An https link with a plain host name: no user name, no IP address, no spaces.") },
      "A button with a link.",
    ),
    Theme: input(
      [],
      {
        card_style: { type: "string", enum: ["dark", "light", "compact", "auto"] },
        accent: colour("#rrggbb."),
        hotspot: { type: "string", enum: ["pulse", "dot", "none"] },
        progress_bar: { type: "boolean" },
        backdrop: { type: "string", pattern: "^(auto|#[0-9A-Fa-f]{6})$", description: "auto, or a colour as #rrggbb." },
        spotlight_soft: { type: "boolean" },
      },
      "From version 3: the tour's look. Every field has a default.",
    ),
    Zoom: input([], { enabled: { type: "boolean" }, percent: { type: "integer", minimum: 105, maximum: 140 } }, "From version 3: whether steps zoom in on the click, and how far."),
    Cover: input(
      ["title"],
      {
        title: text(LIMITS.coverTitle, "The cover's title.", 1),
        body: text(LIMITS.coverBody, "May hold line feeds. Empty when absent."),
        button: text(LIMITS.coverButton, "Start when absent.", 1),
        logo: { type: ["string", "null"], enum: ["logo.png", "logo.jpg", null], description: "Names the logo this upload will send, by its type; null for none." },
      },
      "From version 3: the page shown before the first step.",
    ),
    EndCard: input(
      [],
      { text: text(LIMITS.endText, "May hold line feeds. Empty when absent."), primary: orNull(ref("Link")), secondary: orNull(ref("Link")), replay: { type: "boolean", description: "true when absent." } },
      "From version 3: the card shown after the last step.",
    ),
    Autoplay: input([], { enabled: { type: "boolean" }, seconds: { type: "integer", minimum: 2, maximum: 20 } }, "From version 3: whether the tour moves on by itself, and after how long."),
  };
}

function paths(): OpenApiDoc["paths"] {
  const hours = UPLOAD_MAX_AGE_MS / 3_600_000;
  const minutes = STALE_PUBLISH_MS / 60_000;
  const noTour = refusal("No such tour in this workspace: unknown, another workspace's, or already deleted.", "not_found");
  const noUpload = (also = "") => refusal(`No such upload in this workspace: unknown, another workspace's, finished or cancelled${also}.`, "not_found");
  const noMedia = (also: string) => refusal(`No such item in this workspace: unknown, another workspace's, or being deleted${also}.`, "not_found");
  const image = { "image/png": { schema: { type: "string", format: "binary" } }, "image/jpeg": { schema: { type: "string", format: "binary" } } };
  return {
    "/api/v1/tours": {
      get: {
        tags: ["Tours"],
        summary: "List the workspace's tours",
        description: "Every tour of the token's workspace, drafts and published, most recently changed first. url is the public link as a path, /t/<slug>, to put after the server address; it and published_at are null for a draft.",
        operationId: "listTours",
        security: TOKEN,
        responses: { "200": answer("The tours.", ref("TourList")), "401": UNAUTHORIZED },
      },
    },
    "/api/v1/tours/{id}": {
      patch: {
        tags: ["Tours"],
        summary: "Rename a tour",
        description: `Changes the title only. The title follows the rule of a tour's title at upload: trimmed, 1 to ${LIMITS.title} characters, no control or format characters. The slug and the public link stay the same. A rename shows on the public page of a published tour at once, without publishing again.`,
        operationId: "renameTour",
        security: TOKEN,
        parameters: [tourId],
        requestBody: { required: true, content: json(ref("RenameBody")) },
        responses: {
          "200": answer("The tour's id, and the title as saved.", ref("Renamed")),
          "400": refusal("bad_request: the body is not a JSON object. bad_title: the title breaks the rule; the detail says how.", "bad_request", "bad_title"),
          "401": UNAUTHORIZED,
          "404": noTour,
          "413": refusal("The request body is too long.", "too_large"),
        },
      },
      delete: {
        tags: ["Tours"],
        summary: "Delete a tour, in steps",
        description: `Removes the tour, its chapters and steps, its draft images and logo, its published images and any unfinished upload into it. This cannot be undone. A large tour takes several requests, each removing up to ${DELETE_FILES_PER_CALL} files: send the same request until it answers 200. From the first request on, the tour is gone from the list and its public page answers 404; the later requests only remove files. A repeated request after the tour is gone answers 404, so treat 404 as "gone". Delete does not stop a publish in progress: let it finish, or unpublish the tour, then delete.`,
        operationId: "deleteTour",
        security: TOKEN,
        parameters: [tourId],
        responses: {
          "200": answer("Nothing of the tour is left.", ref("Deleted")),
          "202": answer("The tour is deleted; files remain to remove. Send the same request again.", ref("InProgress")),
          "401": UNAUTHORIZED,
          "404": noTour,
          "409": refusal("A publish of this tour is in progress. Wait for it to finish, or unpublish the tour to stop it, then delete again.", "publish_busy"),
          "500": refusal("The tour is deleted, but some of its files could not be removed yet. Send the same request again.", "cleanup_pending"),
        },
      },
    },
    "/api/v1/tours/{id}/publish": {
      post: {
        tags: ["Tours"],
        summary: "Publish a tour, in steps",
        description: `Copies the tour's draft into a public version at its link. Send it with no body to start, or to join the publish already in progress for the current draft. A small tour answers 200 at once. A large one answers 202 with a publish_id: send the request again with that id, each request copying up to ${COPY_BATCH} images, until it answers 200. Visitors see the previously published version until the last request, and a publish that did not finish never touches it. A publish works from the draft as it was when it started. A tour of more than ${n(MAX_PUBLISH_STEPS)} steps, or one whose text is over ${n(MAX_SNAPSHOT_BYTES)} bytes, answers 413 on the first request, before anything is copied. A publish with no progress for ${minutes} minutes counts as abandoned, and the next request without a publish_id starts a new one.\n\nWho may view it (since version 0.1.51): the request that starts a tour's FIRST publish may carry access and viewers, as the dashboard's change does. The setting and the start of the publish are written together, before any picture is copied, so a tour made people or me is never public, not for a moment: its pictures go to the private store only, and from the last request on its link shows the tour only to an address it may be viewed by. A tour that has been published before (also one unpublished since) refuses the fields with 409 already_published. One whose setting or list was set in the dashboard refuses a different setting, and any viewers list while it holds one, with 409 access_already_set, also when the list is right: a stated list is compared with the tour's only when the same token wrote that list at the tour's first publish and nobody (no session, no other token) changed the setting or the list since, so a request sent again after a lost answer joins its publish. access alone, the setting the tour has, publishes it as it is set; if the setting changes (even between people and me) while that request runs, it answers 409 access_already_set and publishes nothing. Nothing changes on any refusal. Send pad with access (see the field). access public with no viewers is the same as leaving them out. Making a tour restricted needs a site that can send mail: GET /api/v1/tours/{id}/access says can_restrict. The publish answers carry the setting and how many addresses, never the addresses.`,
        operationId: "publishTour",
        security: TOKEN,
        parameters: [tourId],
        requestBody: { required: false, description: "Empty to start (or access and viewers, on a tour's first publish); the previous answer's publish_id to continue.", content: json(ref("PublishBody")) },
        responses: {
          "402": SUBSCRIPTION_ENDED_REFUSED,
          "200": answer("The new version is live. The same answer on any repeat.", ref("Published")),
          "202": answer("Images are being copied. Send the request again with this publish_id.", ref("PublishInProgress")),
          "400": refusal(
            `bad_request: the body is neither empty nor a publish_id, viewers is not a list, or access or viewers came with a publish_id. empty_tour: a tour with no steps cannot be published. bad_access: access is not public, people or me, or viewers came without it. bad_viewer: an entry of viewers is not an email address; the detail gives its position. too_many_viewers: more than ${MAX_VIEWERS} different addresses. Nothing was changed.`,
            "bad_request",
            "empty_tour",
            "bad_access",
            "bad_viewer",
            "too_many_viewers",
          ),
          "401": UNAUTHORIZED,
          "404": noTour,
          "409": refusal(
            "publish_cancelled: that publish was stopped before it finished (the tour was unpublished, the publish failed or was abandoned, a fresh start replaced it, or who may view the tour was changed between public and restricted); publish again to start over. publish_busy: another publish of the tour is starting at this moment, or its draft changed while this one was starting; nothing was written, try again. access_switching: the live pictures are moving because who may view the tour is being changed; finish that change (send it again until it answers 200), then publish. With access or viewers, where nothing changed and nothing was published: already_published: the tour has been published before (also when it was unpublished since), so who may view it is changed in the dashboard only. access_already_set: who may view it was set in the dashboard, and differently. cannot_restrict: this site cannot send mail, so the tour cannot be made people or me.",
            "publish_cancelled",
            "publish_busy",
            "access_switching",
            "already_published",
            "access_already_set",
            "cannot_restrict",
          ),
          "413": refusal(`The tour has too many steps or too much text to publish, or the request body is too long: over 1,024 bytes, or ${n(1024 + ACCESS_BODY_BYTES)} with access or viewers.`, "too_large"),
          "500": refusal("The tour could not be published. What was published before is unchanged.", "publish_failed"),
        },
      },
    },
    "/api/v1/tours/{id}/access": {
      get: {
        tags: ["Tours"],
        summary: "Who may view a tour",
        description: `The tour's setting and, to a signed-in session, its whole list of addresses (a token gets only how many there are, as viewers_count, so a token that leaked does not give the addresses away), the most the list may hold, whether this site can make a tour restricted (it needs mail), and the progress of a move of the live pictures, if one is under way. While a published tour is being made public its setting stays restricted until the move is done.`,
        operationId: "getTourAccess",
        security: TOKEN,
        parameters: [tourId],
        responses: { "200": answer("Who may view the tour: with a session, the whole list; with a token, only how many addresses it holds.", { oneOf: [ref("TourAccess"), ref("TourAccessForToken")] }), "401": UNAUTHORIZED, "404": noTour },
      },
      put: {
        tags: ["Tours"],
        summary: "Change who may view a tour",
        description: `Sets public, people or me, and with viewers replaces the whole list (up to ${MAX_VIEWERS} addresses; you, the workspace's account, are always let in and need not be on it). Only a signed-in session may send it, with the anti-forgery header: a token is answered 401, so a token that leaked cannot make a restricted tour public. ${NOT_FROM_THE_PAGE} Making a public tour restricted needs a site that can send mail; between people and me it never does. Between people and me, for a change of the list, and for a tour that is not published, the change is made at once (a publish in progress is cancelled when the change is between public and the others; publish again). For a published tour between public and people or me, the pictures of the version that is live move to the other store: the answer is 202 while they move, and the same request is sent again until it answers 200. That never publishes the draft and keeps the link. Made restricted, the tour stops being public at the first request, and its public pictures are deleted as they move; a move left unfinished is finished by later requests of the workspace. Made public, it becomes public only at the last request; until then, asking for the setting it still has cancels the move. Nothing is mailed to anyone.`,
        operationId: "setTourAccess",
        security: SESSION,
        parameters: [tourId],
        requestBody: { required: true, content: json(ref("AccessBody")) },
        responses: {
          "402": SUBSCRIPTION_ENDED_REFUSED,
          "200": answer("Done: who may view the tour now.", ref("TourAccess")),
          "202": answer("The live pictures are moving. Send the same request again.", ref("AccessSwitching")),
          "400": refusal(
            `bad_request: the body is not a JSON object, or viewers is not a list. bad_access: access is not public, people or me. bad_viewer: an entry of viewers is not an email address; the detail gives its position. too_many_viewers: more than ${MAX_VIEWERS} different addresses. Nothing was changed.`,
            "bad_request",
            "bad_access",
            "bad_viewer",
            "too_many_viewers",
          ),
          "401": UNAUTHORIZED,
          "403": SESSION_CHANGE_REFUSED,
          "404": noTour,
          "409": refusal(
            "cannot_restrict: this site cannot send mail, so a public tour cannot be made people or me. access_switching: a change to another setting is still moving the pictures; send that one again until it is done. switch_cancelled: the tour was unpublished or deleted while its pictures moved; send the request again. access_busy: the tour changed while the request was decided; send it again. republish_needed: the published version cannot be moved as it is; publish the tour again, then send the change again.",
            "cannot_restrict",
            "access_switching",
            "switch_cancelled",
            "access_busy",
            "republish_needed",
          ),
          "413": refusal(`The request body is over ${n(ACCESS_BODY_BYTES)} bytes.`, "too_large"),
          "500": refusal("The move could not go on just now. Send the same request again to continue it.", "access_failed"),
        },
      },
    },
    "/api/v1/tours/{id}/chapters": {
      get: {
        tags: ["Tours"],
        summary: "List a tour's chapters",
        description: "The tour's chapters in the order visitors see them, with each one's steps, pictures and upload time, and the tour's revision, which a change of the chapters sends back.",
        operationId: "listChapters",
        security: TOKEN,
        parameters: [tourId],
        responses: { "200": answer("The chapters and the revision they were read at.", ref("ChapterList")), "401": UNAUTHORIZED, "404": noTour },
      },
      put: {
        tags: ["Tours"],
        summary: "Reorder and remove a tour's chapters",
        description: `Sends the ids of the chapters to keep, in their new order, with the revision they were read at. A chapter of the tour that is not listed is removed with its steps, and its pictures are deleted for good. It is one change: all of it is made, or nothing. It changes the draft only: visitors keep seeing the published version until the tour is published again, and until then the tour list says unpublished_changes. The tour keeps its title, link, settings and logo, whichever chapter comes first. When someone uploaded, replaced or changed the chapters since they were read, the answer is 409 tour_changed and nothing is changed: read them again. A replace still being uploaded for a removed chapter, or for the first chapter when another one becomes first, is cancelled (its upload answers 404). A list that changes nothing answers 200 and changes nothing. At most ${n(MAX_CHAPTERS)} ids: since version 0.1.56 a tour has at most ${n(MAX_CHAPTERS)} chapters (an upload of another chapter is refused with 409 too_many_chapters), and a tour that got more before then is brought down to ${n(MAX_CHAPTERS)} by one change that removes the rest, after which it takes any change.`,
        operationId: "changeChapters",
        security: TOKEN,
        parameters: [tourId],
        requestBody: { required: true, content: json(ref("ChaptersBody")) },
        responses: {
          "200": answer("Done: the chapters as they are now, with the new revision.", ref("ChapterList")),
          "400": refusal(
            `bad_request: the body is not a JSON object, revision is not a whole number, chapters is not a list of ids, or it lists an id twice. last_chapter: the list is empty; a tour keeps at least one chapter, so delete the tour instead. too_many_chapters: more than ${n(MAX_CHAPTERS)} ids. Nothing was changed.`,
            "bad_request",
            "last_chapter",
            "too_many_chapters",
          ),
          "401": UNAUTHORIZED,
          "404": refusal("No such tour in this workspace (unknown, another workspace's, or already deleted), or an id that is not a chapter of this tour (detail: no such chapter). Nothing was changed.", "not_found"),
          "409": refusal("The tour changed since its chapters were read. Nothing was changed: read them again.", "tour_changed"),
          "413": refusal(`The request body is over ${n(CHAPTERS_BODY_BYTES)} bytes.`, "too_large"),
        },
      },
    },
    "/api/v1/tours/{id}/unpublish": {
      post: {
        tags: ["Tours"],
        summary: "Unpublish a tour",
        description: "Takes the tour's public page and images down at once and makes the tour a draft again. A publish in progress is cancelled. Removing a large tour's public images can take more than one request: send the same request until it answers 204. Unpublishing a draft answers 204 too.",
        operationId: "unpublishTour",
        security: TOKEN,
        parameters: [tourId],
        responses: {
          "204": empty("The tour is a draft and all its public images are gone."),
          "202": answer("The tour is unpublished; public images remain to remove. Send the same request again.", ref("UnpublishInProgress")),
          "401": UNAUTHORIZED,
          "404": noTour,
          "500": refusal("The tour is unpublished, but some of its public images could not be removed yet. Send the same request again.", "cleanup_pending"),
        },
      },
    },
    "/api/v1/tours/{id}/steps/{step_id}/image": {
      get: {
        tags: ["Tours"],
        summary: "Get a draft step's image",
        description: "The picture of one step of the draft, as it was uploaded. The type is the one the server read from the file's own bytes at upload. Nothing may cache it but the client that asked.",
        operationId: "getStepImage",
        security: TOKEN,
        parameters: [tourId, stepId],
        responses: {
          "200": {
            description: "The image.",
            headers: {
              "content-security-policy": { description: "Always `default-src 'none'; sandbox`, so the picture can do nothing when opened on its own.", schema: { type: "string", const: "default-src 'none'; sandbox" } },
              "cache-control": { description: "Always `private, no-store`.", schema: { type: "string", const: "private, no-store" } },
            },
            content: image,
          },
          "401": UNAUTHORIZED,
          "404": refusal("No such step in this workspace.", "not_found"),
        },
      },
    },
    "/api/v1/uploads": {
      post: {
        tags: ["Uploads"],
        summary: "Start an upload",
        description: `Starts an upload from the tour's manifest (at most ${n(LIMITS.manifestBytes)} bytes) and says where it goes: a new tour, a new chapter of a tour, or the replacement of a chapter. Then send each step's image, the logo if one is due, and finish the upload; nothing changes in any tour until then. A replace changes the draft only: the public page stays as it was until the tour is published again. A workspace may have ${DEFAULT_MAX_OPEN_UPLOADS} open uploads at a time, and an upload that is not finished is removed after ${hours} hours. A repeated request only makes another upload. On a workspace with a storage allowance, an upload that would take it over is refused here with 413 storage_full, before any image is sent. A new tour or a new chapter needs room for all its images; the replacement of a chapter needs room only for what its images come to above the chapter's present ones. An upload that carries a logo (a new tour, or the replacement of a tour's first chapter, when the manifest names a logo) also needs room for the logo: logo_bytes when the request gives it, and without logo_bytes up to ${n(LOGO_RULE.maxBytes)} bytes; for a replacement, only what that comes to above the size recorded for the tour's present logo. So a replacement that does not grow the chapter is never refused for storage when it carries no logo, or gives a logo_bytes no larger than the present logo's recorded size.`,
        operationId: "createUpload",
        security: TOKEN,
        requestBody: { required: true, content: json(ref("UploadCreate")) },
        responses: {
          "402": SUBSCRIPTION_ENDED_REFUSED,
          "201": answer("The upload exists. For the target replace the answer also has have and settings.", { oneOf: [ref("UploadCreated"), ref("ReplaceCreated")] }),
          "400": refusal(
            `bad_request: the body is not a JSON object, or sha256 is not one 64-character lowercase hex text per step, or comes with another target than replace, or logo_bytes is not a whole number from 1 to ${n(LOGO_RULE.maxBytes)}. bad_manifest: the manifest breaks a rule; the detail names the field. bad_target: the target is missing or its kind is not new, chapter or replace.`,
            "bad_request",
            "bad_manifest",
            "bad_target",
          ),
          "401": UNAUTHORIZED,
          "404": refusal("The target's tour is not in this workspace (detail: no such tour), or the chapter is not a chapter of that tour (detail: no such chapter).", "not_found"),
          "409": refusal(
            `chapter_changed: a replace only: the tour's chapters were reordered or removed while this request was being decided, so whether it carries the tour's settings may have changed. Nothing was stored; start again. too_many_chapters: a new chapter only (since version 0.1.56): the tour already has ${n(MAX_CHAPTERS)} chapters, the most a tour may have; nothing was stored. Remove a chapter first.`,
            "chapter_changed",
            "too_many_chapters",
          ),
          "413": answer(
            "too_large: the request body is too long. storage_full: the upload would take the workspace over its storage allowance; nothing was stored, and the answer carries the numbers in bytes. Deleting tours, or a larger allowance, makes room; waiting does not.",
            { oneOf: [refusalSchema("too_large"), ref("StorageFull")] },
          ),
          "429": {
            description: "The workspace already has its number of open uploads. Finish or cancel one first.",
            headers: { "retry-after": { description: "Seconds to wait before trying again.", schema: { type: "integer", minimum: 1 } } },
            content: refusal("", "too_many_uploads").content,
          },
        },
      },
    },
    "/api/v1/uploads/{id}/steps/{n}": {
      put: {
        tags: ["Uploads"],
        summary: "Send one step's image",
        description: `The body is the image itself, a PNG or a JPEG of at most ${n(STEP_IMAGE_RULE.maxBytes)} bytes and ${n(STEP_IMAGE_RULE.maxSide)} pixels on a side. Its type, width, height and length must be exactly what the manifest gives for the step; the server reads them from the file's own bytes, not from the Content-Type. Steps may be sent in any order, each once.`,
        operationId: "putStepImage",
        security: TOKEN,
        parameters: [uploadId, { name: "n", in: "path", required: true, description: "The step's number in the manifest, counted from 1.", schema: { type: "integer", minimum: 1, maximum: LIMITS.steps } }],
        requestBody: { required: true, content: image },
        responses: {
          "204": empty("The image is stored."),
          "400": refusal("The body is not the image the manifest describes; the detail says what differs.", "bad_image"),
          "401": UNAUTHORIZED,
          "404": noUpload(", or the manifest has no step of that number"),
          "409": refusal("This step was already sent, or the chapter already has its image (a step listed in have).", "already_sent"),
          "413": refusal("The image is too long.", "too_large"),
        },
      },
    },
    "/api/v1/uploads/{id}/logo": {
      put: {
        tags: ["Uploads"],
        summary: "Send the logo",
        description: `The body is the cover's logo, a PNG or a JPEG (as the manifest's cover names it) of at most ${n(LOGO_RULE.maxBytes)} bytes and ${n(LOGO_RULE.maxSide)} pixels on a side. Only an upload that makes a new tour, or replaces a tour's first chapter, takes a logo; a tour keeps its logo otherwise. When the upload was started with logo_bytes, the logo must have exactly that length.`,
        operationId: "putLogo",
        security: TOKEN,
        parameters: [uploadId],
        requestBody: { required: true, content: image },
        responses: {
          "204": empty("The logo is stored."),
          "400": refusal("The body is not a logo of the type the manifest names, or is too large on a side, or its length differs from the logo_bytes the upload was started with.", "bad_image"),
          "401": UNAUTHORIZED,
          "404": noUpload(", or its manifest names no logo"),
          "409": refusal("logo_not_used: this upload goes into an existing tour, which keeps its logo; do not send one. already_sent: the logo was already sent.", "logo_not_used", "already_sent"),
          "413": refusal("The logo is too long.", "too_large"),
        },
      },
    },
    "/api/v1/uploads/{id}/commit": {
      post: {
        tags: ["Uploads"],
        summary: "Finish an upload",
        description: "Puts the upload into the draft in one go: a new tour, a new chapter, or the chapter with exactly the manifest's steps. Nothing is public until the tour is published. A repeated request answers 201 with the same ids. For a replace the answer's publish says what publishing would do now: draft, ready or other_changes.",
        operationId: "commitUpload",
        security: TOKEN,
        parameters: [uploadId],
        responses: {
          "201": answer("The draft holds the upload. For the target replace the answer also has publish.", { oneOf: [ref("Committed"), ref("ReplaceCommitted")] }),
          "401": UNAUTHORIZED,
          "404": noUpload(""),
          "409": refusal(
            `incomplete: a step's image, or a logo the upload must carry, has not been sent; nothing changes. chapter_changed: another upload replaced the chapter since this one started; nothing changes: cancel this upload and start again. too_many_chapters: a new chapter only (since version 0.1.56): the tour had ${n(MAX_CHAPTERS)} chapters at the moment of the commit (another upload into it, started beside this one, got there first); nothing changes and the upload stays open: cancel it, or remove a chapter and send the commit again.`,
            "incomplete",
            "chapter_changed",
            "too_many_chapters",
          ),
        },
      },
    },
    "/api/v1/uploads/{id}": {
      delete: {
        tags: ["Uploads"],
        summary: "Cancel an upload",
        description: "Removes the upload and only what it stored, never an image a chapter uses. It answers 204 also for an upload that is unknown, finished or already cancelled.",
        operationId: "cancelUpload",
        security: TOKEN,
        parameters: [uploadId],
        responses: { "204": empty("The upload is gone, or was not there."), "401": UNAUTHORIZED },
      },
    },
    "/api/v1/media": {
      post: {
        tags: ["Items"],
        summary: "Start a shared item",
        description: `Starts sharing one image (a PNG or a JPEG) or one clip (a GIF or an MP4): say what it is, then send its parts, optionally a preview, and finish it. The answer says how many parts to send; every part but the last is ${n(PART_BYTES)} bytes. On a workspace with a storage allowance, an item that would take it over is refused here with 413 storage_full, before any part is sent; from here on its bytes count as used until it is deleted. An item that is not finished is removed after ${MEDIA_MAX_AGE_MS / 3_600_000} hours. A workspace starts at most ${LIMITS_MEDIA.create.most} items an hour.\n\nWho may view it (since version 0.1.51): this request may carry access and viewers, as the dashboard's change does, and only this one; afterwards only the dashboard changes them. The item is created with the setting, so a restricted item is never served to anyone without access, at any moment: nobody is served it until it is finished, and from then on only an address it may be viewed by. Its link (from the commit) is the one such a viewer opens. Send pad with access (see the field); if the 201 still has no access in it, the server ignored the field and the item is public: delete it before sending any part. What cannot be restricted is refused here before anything exists: 409 cannot_restrict on a site that cannot send mail, 409 too_large_to_restrict for an item of more than ${n(RESTRICTED_MAX_BYTES)} bytes. The answer then says the setting and how many addresses, never the addresses. To know beforehand whether this site can restrict an item, GET /api/v1/media/{id}/access of any item says can_restrict; or send the create, which refuses without making anything.`,
        operationId: "createMedia",
        security: TOKEN,
        requestBody: { required: true, content: json(ref("MediaCreate")) },
        responses: {
          "402": SUBSCRIPTION_ENDED_REFUSED,
          "201": answer("The item exists. Send its parts.", ref("MediaCreated")),
          "400": refusal(
            `bad_request: the body is not a JSON object, or a field breaks its rule (viewers that is not a list included); the detail names it. bad_access: access is not public, people or me, or viewers came without it. bad_viewer: an entry of viewers is not an email address; the detail gives its position. too_many_viewers: more than ${MAX_VIEWERS} different addresses. Nothing was made.`,
            "bad_request",
            "bad_access",
            "bad_viewer",
            "too_many_viewers",
          ),
          "401": UNAUTHORIZED,
          "409": refusal(
            `Only with access people or me; nothing was made. cannot_restrict: this site cannot send mail, so an item cannot be made people or me. too_large_to_restrict: the item has more than ${n(RESTRICTED_MAX_BYTES)} bytes, the most a restricted item may have here.`,
            "cannot_restrict",
            "too_large_to_restrict",
          ),
          "413": answer(
            "too_large: the request body is too long (over 4,096 bytes, or 69,632 with access or viewers). media_too_large: the item is larger than this server takes, and the answer carries the limits. storage_full: the item would take the workspace over its storage allowance; nothing was stored. Deleting tours or items, or a larger allowance, makes room.",
            { oneOf: [refusalSchema("too_large"), ref("MediaTooLarge"), ref("StorageFull")] },
          ),
          "429": { description: `This workspace already started ${LIMITS_MEDIA.create.most} items in the last hour.`, headers: retryAfter, content: refusal("", "too_many_items").content },
        },
      },
      get: {
        tags: ["Items"],
        summary: "List the workspace's shared items",
        description: `The finished items of the workspace of one kind, newest first, ${LIST_PAGE} at a time. Ask with the query kind=image or kind=clip; for the next page add cursor= with the next of the previous answer. Items that are not finished are not listed.`,
        operationId: "listMedia",
        security: TOKEN,
        responses: {
          "200": answer("One page of items.", ref("MediaList")),
          "400": refusal("bad_request: kind is missing or not image or clip. bad_cursor: the cursor is not one this list gave.", "bad_request", "bad_cursor"),
          "401": UNAUTHORIZED,
        },
      },
    },
    "/api/v1/media/{id}/access": {
      get: {
        tags: ["Items"],
        summary: "Who may view a shared item",
        description: "The item's setting and, to a signed-in session, its whole list of addresses (a token gets only how many there are, as viewers_count, so a token that leaked does not give the addresses away), the most the list may hold, and whether this site can make an item restricted (it needs mail).",
        operationId: "getMediaAccess",
        security: TOKEN,
        parameters: [mediaId],
        responses: { "200": answer("Who may view the item: with a session, the whole list; with a token, only how many addresses it holds.", { oneOf: [ref("MediaAccess"), ref("MediaAccessForToken")] }), "401": UNAUTHORIZED, "404": noMedia("") },
      },
      put: {
        tags: ["Items"],
        summary: "Change who may view a shared item",
        description: `Sets public, people or me, and with viewers replaces the whole list (up to ${MAX_VIEWERS} addresses; you, the workspace's account, are always let in and need not be on it). Only a signed-in session may send it, with the anti-forgery header: a token is answered 401, so a token that leaked cannot make a restricted item public. ${NOT_FROM_THE_PAGE} Making a public item restricted needs a site that can send mail; between people and me it never does. The change is made at once and holds from the next request: nothing moves, as an item's file is only ever served by the server. A restricted item's page, file, download and preview picture answer only a browser that proved, on the address for images and clips, an address the item may be viewed by; everyone else gets a page that asks for an address, and no link preview. Its address stays the same. Restricting cannot take back a copy someone saved while it was public. An item of more than ${n(RESTRICTED_MAX_BYTES)} bytes cannot be restricted. Nothing is mailed to anyone.`,
        operationId: "setMediaAccess",
        security: SESSION,
        parameters: [mediaId],
        requestBody: { required: true, content: json(ref("AccessBody")) },
        responses: {
          "402": SUBSCRIPTION_ENDED_REFUSED,
          "200": answer("Done: who may view the item now.", ref("MediaAccess")),
          "400": refusal(
            `bad_request: the body is not a JSON object, or viewers is not a list. bad_access: access is not public, people or me. bad_viewer: an entry of viewers is not an email address; the detail gives its position. too_many_viewers: more than ${MAX_VIEWERS} different addresses. Nothing was changed.`,
            "bad_request",
            "bad_access",
            "bad_viewer",
            "too_many_viewers",
          ),
          "401": UNAUTHORIZED,
          "403": SESSION_CHANGE_REFUSED,
          "404": noMedia(""),
          "409": refusal(
            `cannot_restrict: this site cannot send mail, so a public item cannot be made people or me. too_large_to_restrict: the item has more than ${n(RESTRICTED_MAX_BYTES)} bytes, the most a restricted item may have here. access_busy: the item changed while the request was decided; send it again. Nothing was changed.`,
            "cannot_restrict",
            "too_large_to_restrict",
            "access_busy",
          ),
          "413": refusal(`The request body is over ${n(ACCESS_BODY_BYTES)} bytes.`, "too_large"),
        },
      },
    },
    "/api/v1/media/{id}": {
      get: {
        tags: ["Items"],
        summary: "Get one shared item",
        description: "One item of the workspace, finished or not, with its state.",
        operationId: "getMedia",
        security: TOKEN,
        parameters: [mediaId],
        responses: { "200": answer("The item.", ref("MediaItemState")), "401": UNAUTHORIZED, "404": noMedia("") },
      },
      delete: {
        tags: ["Items"],
        summary: "Delete a shared item",
        description: "Removes an item, finished or not, with every part and its preview. Its public address stops working at once. 204 means nothing of it is left and its bytes no longer count. 500 cleanup_pending means it is deleted all the same, but some of its files are still to go (the store failed, or a part or preview was being sent at that moment), and it counts until they are: send the same request again.",
        operationId: "deleteMedia",
        security: TOKEN,
        parameters: [mediaId],
        responses: {
          "204": empty("Nothing of the item is left."),
          "401": UNAUTHORIZED,
          "404": noMedia(", or already deleted"),
          "500": refusal("The item is deleted, but some of its files are still to be removed, and until they are its bytes count. Send the same request again.", "cleanup_pending"),
        },
      },
    },
    "/api/v1/media/{id}/parts/{n}": {
      put: {
        tags: ["Items"],
        summary: "Send one part of an item",
        description: `The body is part n of the file, as bytes: ${n(PART_BYTES)} bytes for every part but the last, which holds the rest. Part 0 must start like a file of the declared type, read from its own bytes, and for a PNG, JPEG or GIF its width and height must be the declared ones; an MP4's size and duration are taken as declared. Parts may be sent in any order; sending one again replaces it.`,
        operationId: "putMediaPart",
        security: TOKEN,
        parameters: [mediaId, { name: "n", in: "path", required: true, description: "The part's number, counted from 0.", schema: { type: "integer", minimum: 0, maximum: 998 } }],
        requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        responses: {
          "204": empty("The part is stored."),
          "400": refusal("bad_part: the part's length is not the one it must have. bad_media: part 0 is not a file of the declared type, or its width and height differ from the declared ones.", "bad_part", "bad_media"),
          "401": UNAUTHORIZED,
          "404": noMedia(", or the item has no part of that number"),
          "409": refusal("already_online: the item is finished; its parts cannot change. superseded: this send did not take its place (it took too long, or its claim was removed); the item is still open: check it and send again what is missing.", "already_online", "superseded"),
          "413": refusal("The part is too long.", "too_large"),
          "429": { description: `This workspace already sent ${LIMITS_MEDIA.part.most} parts in the last hour, or ${MAX_LOOSE_CLAIMS} sends of this item have not finished yet.`, headers: retryAfter, content: refusal("", "too_many_items").content },
        },
      },
    },
    "/api/v1/media/{id}/preview": {
      put: {
        tags: ["Items"],
        summary: "Send an item's preview",
        description: `Optional: a small picture that stands for the item in lists, a PNG or a JPEG of at most ${n(PREVIEW_RULE.maxBytes)} bytes and ${n(PREVIEW_RULE.maxSide)} pixels on a side, read from its own bytes. Send it before the item is finished; a new one replaces the old. Its size counts against the storage allowance.`,
        operationId: "putMediaPreview",
        security: TOKEN,
        parameters: [mediaId],
        requestBody: { required: true, content: image },
        responses: {
          "204": empty("The preview is stored."),
          "400": refusal("The body is not a PNG or JPEG within the preview's size.", "bad_image"),
          "401": UNAUTHORIZED,
          "404": noMedia(""),
          "409": refusal("already_online: the item is finished; its preview cannot change. superseded: this send did not take its place (it took too long, or its claim was removed); the item is still open: send it again.", "already_online", "superseded"),
          "413": answer("too_large: the preview is too long. storage_full: it would take the workspace over its storage allowance; nothing was stored.", { oneOf: [refusalSchema("too_large"), ref("StorageFull")] }),
          "429": { description: `This workspace already sent ${LIMITS_MEDIA.preview.most} previews in the last hour, or ${MAX_LOOSE_CLAIMS} sends of this item have not finished yet.`, headers: retryAfter, content: refusal("", "too_many_items").content },
        },
      },
      get: {
        tags: ["Items"],
        summary: "Get an item's preview",
        description: "The item's preview picture, to its own workspace, as the type read from its bytes when it was sent.",
        operationId: "getMediaPreview",
        security: TOKEN,
        parameters: [mediaId],
        responses: { "200": { description: "The preview.", content: image }, "401": UNAUTHORIZED, "404": noMedia(", or it has no preview") },
      },
    },
    "/api/v1/media/{id}/commit": {
      post: {
        tags: ["Items"],
        summary: "Finish a shared item",
        description: "Checks that every part is stored and that they add up to the declared bytes, and puts the item online at its public address. From then on it does not change until it is deleted. A repeated request answers the same.",
        operationId: "commitMedia",
        security: TOKEN,
        parameters: [mediaId],
        responses: {
          "200": answer("The item is online.", ref("MediaCommitted")),
          "401": UNAUTHORIZED,
          "404": noMedia(""),
          "409": refusal("A part has not been sent or is still being sent, the parts do not add up to the declared bytes, or the preview is still being sent; the detail says which. Nothing changes.", "incomplete"),
        },
      },
    },
    "/api/v1/me": {
      get: {
        tags: ["Workspace"],
        summary: "The workspace and the server version",
        description: "The name of the token's workspace and the version of the server: the request to test a connection with. On a server with two addresses the answer also has addresses, the two host names.",
        operationId: "getMe",
        security: TOKEN,
        responses: { "200": answer("The workspace and the version.", ref("Me")), "401": UNAUTHORIZED, "404": refusal("The token's workspace no longer exists.", "not_found") },
      },
    },
    "/api/v1/usage": {
      get: {
        tags: ["Workspace"],
        summary: "The workspace's storage use",
        description: `What the token's workspace uses of its storage allowance, in bytes. Counted: the image of every step of every tour, published or not; each tour's logo; and the room held by every upload that is not finished (its images as the manifest gives them, and for a logo it carries the logo_bytes it was started with, or ${n(LOGO_RULE.maxBytes)} bytes without, until the logo's real size is recorded when the upload is finished), until the upload is finished, cancelled or removed. An upload nobody finishes is not removed by the clock alone: it is removed when the workspace next starts an upload once it is more than ${hours} hours old, and until then its room is still counted here. Also counted: every shared image and clip, with its declared bytes, its current preview, and every send of a part or preview that is not the current one yet or any more (one under way, one it replaced, one that died) until its file is removed, from the moment it is started until its files are gone after a delete, or after it is removed unfinished once ${MEDIA_MAX_AGE_MS / 3_600_000} hours old; an item being deleted counts until then. counted gives them as images and gifs (clips: GIFs and MP4s), and an item that is not finished counts there, under its own kind, not in uploads_in_progress, which holds the tours' uploads only. The top-level images and gifs count the items that are online. Not counted: the copies of images a published tour serves, and files of tours that wait to be removed after a delete or a replace. The five numbers of counted add up to used_bytes. allowance_bytes is null when neither the server's settings nor the workspace has one: No limit. over is true when more is used than the allowance, which can happen when an allowance is lowered; the server never deletes or unpublishes anything because of it, and only starting an upload that needs room is refused.`,
        operationId: "getUsage",
        security: TOKEN,
        responses: { "200": answer("The workspace's numbers.", ref("Usage")), "401": UNAUTHORIZED },
      },
    },
    "/api/v1/usage/largest": {
      get: {
        tags: ["Workspace"],
        summary: "The workspace's ten largest tours, images and GIFs",
        description: `Two lists of the token's workspace. tours: the ${LARGEST_TOURS} largest tours, largest first, each with its id, its title and its size in bytes as the tour list gives it (its steps' images and its logo, as GET /api/v1/usage counts them). Tours of the same size come in the order of their id. largest: the ${LARGEST_TOURS} largest things of every kind together, each with its kind (tour, image, or gif for a clip), id, title (null for an item without one) and size in bytes: what deleting it frees, as GET /api/v1/usage counts it (for an item, its declared bytes, its current preview and every send that is not current). It holds items online and items still being sent, which take room and can be deleted, but not one being deleted already, which still counts in GET /api/v1/usage until its files are gone. Things of the same size come in the order of their id. Each list has fewer when the workspace has fewer; none for an empty one.`,
        operationId: "getLargestTours",
        security: TOKEN,
        responses: { "200": answer("The largest tours, and the largest of every kind.", ref("LargestTours")), "401": UNAUTHORIZED },
      },
    },
    "/api/v1/signin/request": {
      post: {
        tags: ["Accounts"],
        summary: "Ask for a sign-in link",
        description: `Mails a sign-in link to the address, when it belongs to an account that may sign in, the site has an admin and mail is on. The answer is the same in every case, so it does not tell whether the address has an account, and it does not wait for the mail. The link works once and for ${SIGNIN_CODE_MS / 60_000} minutes. Needs no credential, but must come from a page of the address it is sent to, as JSON. One address gets at most a few links in a quarter hour and in a day; past that the answer is the same and no mail is sent.`,
        operationId: "requestSignInLink",
        security: [],
        requestBody: { required: true, content: json(ref("SignInRequest")) },
        responses: {
          "200": answer("The same for every well-formed address.", ref("Ok")),
          "400": answer("bad_request: the body is not a JSON object sent as application/json. bad_email, with no detail: email is not an email address.", someDetail("bad_request", "bad_email")),
          "403": refusal("The request did not come from a page of this address: no Origin, another one, or the browser says it came from another site.", "bad_origin"),
          "429": { description: "Too many requests from this network. Nothing was sent.", headers: retryAfter, content: json(bare("rate_limited")) },
        },
      },
    },
    "/api/v1/signin/complete": {
      post: {
        tags: ["Accounts"],
        summary: "Finish signing in",
        description: "Turns the code of a sign-in link into a session, once, and sets the session cookie on this address. A session the browser already had ends. Needs no credential, but must come from a page of the address it is sent to, as JSON. A code that is unknown, already used, expired or of an account that may not sign in gets the one answer link_invalid. The answer never repeats the code.",
        operationId: "completeSignIn",
        security: [],
        requestBody: { required: true, content: json(ref("SignInComplete")) },
        responses: {
          "200": { ...answer("Signed in.", ref("Ok")), headers: setCookie("The session cookie: host-only, Secure, HttpOnly and SameSite=Lax.") },
          "400": answer("bad_request: the body is not a JSON object sent as application/json. bad_code, with no detail: code is not a sign-in code.", someDetail("bad_request", "bad_code")),
          "403": refusal("bad_origin: the request did not come from a page of this address. link_invalid: the link has expired or was already used; ask for a new one.", "bad_origin", "link_invalid"),
          "429": { description: "Too many tries from this network. Nothing was looked at.", headers: retryAfter, content: json(bare("rate_limited")) },
        },
      },
    },
    "/api/v1/invite/check": {
      post: {
        tags: ["Accounts"],
        summary: "Look up an invite",
        description: `For the page an invite's link opens: the invited address, who sent the invite and when its link stops working. It changes nothing, so opening the link uses nothing up. Needs no credential, but must come from a page of the address it is sent to, as JSON; a token is refused, and so is a browser signed in to any account. Every code that cannot be used gets the one answer invite_invalid. A network may look up and accept invites ${LIMITS_INVITE.codeNetwork.most} times in ${LIMITS_INVITE.codeNetwork.windowMs / 60_000} minutes.`,
        operationId: "checkInvite",
        security: [],
        requestBody: { required: true, content: json(ref("InviteCheck")) },
        responses: {
          "200": answer("The invite.", ref("InviteFound")),
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. credentials_not_allowed: the request carries a token.", "bad_request", "credentials_not_allowed"),
          "403": refusal("The request did not come from a page of this address.", "bad_origin"),
          "404": refusal("The invite cannot be used: unknown, already used, cancelled, replaced by a newer invite, or expired. They cannot be told apart.", "invite_invalid"),
          "409": refusal("The browser is signed in. Sign out first, then open the link again.", "signed_in"),
          "429": { description: "Too many tries from this network. Nothing was looked at.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
        },
      },
    },
    "/api/v1/invite/accept": {
      post: {
        tags: ["Accounts"],
        summary: "Accept an invite",
        description: "Makes the account the invite is for, with the username chosen: the invited address, an empty workspace of its own named after the username with the site's standard storage allowance, and a session, at once, and sets the session cookie as finishing a sign-in does. It is all made together or not at all, and of two accepts of one invite only one makes an account. A refused accept uses nothing up: the invite still works. Needs no credential, but must come from a page of the address it is sent to, as JSON; a token is refused, and so is a browser signed in to any account, which is never switched to another. The answer never repeats the code.",
        operationId: "acceptInvite",
        security: [],
        requestBody: { required: true, content: json(ref("InviteAccept")) },
        responses: {
          "200": { ...answer("The account is made, and this browser is signed in to it.", ref("Ok")), headers: setCookie("The session cookie: host-only, Secure, HttpOnly and SameSite=Lax.") },
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. credentials_not_allowed: the request carries a token. bad_username: the username breaks the rule. reserved_username: the username is one the site holds back. An invite that cannot be used answers 404 whatever the username.", "bad_request", "credentials_not_allowed", "bad_username", "reserved_username"),
          "403": refusal("The request did not come from a page of this address.", "bad_origin"),
          "404": refusal("The invite cannot be used: unknown, already used, cancelled, replaced by a newer invite, or expired. They cannot be told apart.", "invite_invalid"),
          "409": refusal("signed_in: the browser is signed in; sign out first. has_account: the address has an account by now; sign in instead. username_taken: another account has the username; choose another. Nothing was made.", "signed_in", "has_account", "username_taken"),
          "429": { description: "Too many tries from this network. Nothing was looked at.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
        },
      },
    },
    "/api/v1/session": {
      get: {
        tags: ["Accounts"],
        summary: "The session and who it is",
        description: `The account, its workspace and this session, and the anti-forgery value a change made with the session needs. Sets the session cookie again. ${NOT_FROM_THE_PAGE}`,
        operationId: "getSession",
        security: SESSION,
        responses: { "200": { ...answer("The session.", ref("Session")), headers: setCookie("The same session cookie again.") }, "401": UNAUTHORIZED },
      },
    },
    "/api/v1/sessions": {
      get: {
        tags: ["Accounts"],
        summary: "List the account's sessions",
        description: `Every live session of the caller's own account, where it is signed in, with the current one first and marked. ${NOT_FROM_THE_PAGE}`,
        operationId: "listSessions",
        security: SESSION,
        responses: { "200": answer("The sessions.", ref("SessionList")), "401": UNAUTHORIZED },
      },
    },
    "/api/v1/sessions/{id}": {
      delete: {
        tags: ["Accounts"],
        summary: "End one of the account's sessions",
        description: `Ends one session of the caller's own account, such as one in another browser; the cookie is not touched. Another account's session answers 404, the same as one that does not exist. ${NOT_FROM_THE_PAGE}`,
        operationId: "endSession",
        security: SESSION,
        parameters: [sessionId],
        responses: { "204": empty("The session has ended."), "401": UNAUTHORIZED, "403": SESSION_CHANGE_REFUSED, "404": refusal("No such live session of this account.", "not_found") },
      },
    },
    "/api/v1/signout": {
      post: {
        tags: ["Accounts"],
        summary: "Sign out",
        description: `Ends the session the request is sent with and clears its cookie. ${NOT_FROM_THE_PAGE}`,
        operationId: "signOut",
        security: SESSION,
        responses: { "204": { ...empty("Signed out."), headers: setCookie("Clears the session cookie.") }, "401": UNAUTHORIZED, "403": SESSION_CHANGE_REFUSED },
      },
    },
    "/api/v1/signout/everywhere": {
      post: {
        tags: ["Accounts"],
        summary: "Sign out everywhere",
        description: `Ends every session of the caller's account, in every browser, and clears this one's cookie. Tokens keep working. ${NOT_FROM_THE_PAGE}`,
        operationId: "signOutEverywhere",
        security: SESSION,
        responses: { "204": { ...empty("Every session of the account has ended."), headers: setCookie("Clears the session cookie.") }, "401": UNAUTHORIZED, "403": SESSION_CHANGE_REFUSED },
      },
    },
    "/api/v1/account/email": {
      post: {
        tags: ["Accounts"],
        summary: "Ask to change the email address",
        description: `Mails a link to the new address; the account's address changes only when that link is opened (POST /api/v1/account/email/confirm), once and within ${EMAIL_CHANGE_MS / 60_000} minutes. Asking again replaces the earlier link. The answer is the same whether the new address is free, belongs to another account or is the account's own, so it does not tell who has an account; only a free address is sent a link, and no other mail is sent. It does not wait for the mail. Each account, each account for one address, and each address from all accounts together, can be asked for only a few times in a quarter hour and in a day; an account that asks too often for one address limits only itself, not others asking for it. ${NOT_FROM_THE_PAGE}`,
        operationId: "requestEmailChange",
        security: SESSION,
        requestBody: { required: true, content: json(ref("EmailChangeRequest")) },
        responses: {
          "200": answer("The same for every well-formed address.", ref("Ok")),
          "400": answer("bad_request: the body is not a JSON object sent as application/json. bad_email, with no detail: email is not an email address.", someDetail("bad_request", "bad_email")),
          "401": UNAUTHORIZED,
          "403": SESSION_CHANGE_REFUSED,
          "409": refusal("This site cannot send mail, so the address cannot be changed here. Nothing was stored.", "mail_off"),
          "429": { description: "Too many requests for this account or this address. Nothing was stored or sent.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
        },
      },
    },
    "/api/v1/account/email/confirm": {
      post: {
        tags: ["Accounts"],
        summary: "Finish changing the email address",
        description: `Makes the change the code of the link names, once: the account's address becomes the new one, its open sign-in links stop working, and the old address is sent a notice that shows the new one partly hidden. It must be sent with a session of the account that asked. The account stays signed in everywhere. A code that is unknown, already used, more than ${EMAIL_CHANGE_MS / 60_000} minutes old, replaced by a later request or of another account, and one for an address another account has taken since, all get the one answer bad_code. ${NOT_FROM_THE_PAGE}`,
        operationId: "confirmEmailChange",
        security: SESSION,
        requestBody: { required: true, content: json(ref("EmailChangeConfirm")) },
        responses: {
          "200": answer("The address was changed.", ref("EmailChanged")),
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. bad_code: the link no longer works; ask for a new one.", "bad_request", "bad_code"),
          "401": UNAUTHORIZED,
          "403": SESSION_CHANGE_REFUSED,
          "429": { description: "Too many tries for this account. Nothing was looked at.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
        },
      },
    },
    "/api/v1/terms": {
      get: {
        tags: ["Accounts"],
        summary: "The site's terms and the account's agreement",
        description: `The current version of the site's terms, the account's newest agreement, whether the account still has to agree, and the session's anti-forgery value. Open before the terms are agreed to. ${NOT_FROM_THE_PAGE}`,
        operationId: "getTerms",
        security: SESSION,
        responses: { "200": answer("The terms and the account's state.", ref("TermsState")), "401": UNAUTHORIZED },
      },
    },
    "/api/v1/terms/agreed": {
      get: {
        tags: ["Accounts"],
        summary: "The terms the account agreed to",
        description: `The version of the site's terms the account agreed to last, exactly as it was published, with when it agreed. Open before the terms are agreed to. ${NOT_FROM_THE_PAGE}`,
        operationId: "getAgreedTerms",
        security: SESSION,
        responses: { "200": answer("The version, or null for an account that has agreed to none.", ref("TermsAgreed")), "401": UNAUTHORIZED },
      },
    },
    "/api/v1/terms/agree": {
      post: {
        tags: ["Accounts"],
        summary: "Agree to the site's terms",
        description: `Records that the caller's own account agrees, now, to the version of the terms it was shown, named by its id, and only while that is still the current version. Only the account, the version and the time are stored. Agreeing again to a version already agreed to changes nothing and answers 204. ${NOT_FROM_THE_PAGE}`,
        operationId: "agreeToTerms",
        security: SESSION,
        requestBody: { required: true, content: json(ref("TermsAgree")) },
        responses: {
          "204": empty("Agreed: from now on the session works as before."),
          "400": refusal("The body is not a JSON object with the one field terms, an id of a version's shape.", "bad_request"),
          "401": UNAUTHORIZED,
          "403": SESSION_CHANGE_REFUSED,
          "409": refusal("The id is not the current version: newer terms were published since they were shown, or it names no version (or the site has none). Nothing was recorded; ask GET /api/v1/terms again.", "terms_changed"),
        },
      },
    },
    "/api/v1/connect/start": {
      post: {
        tags: ["Connections"],
        summary: "Ask to connect the app",
        description: `For the desktop app, which has no credential yet: starts a request and answers its two codes and the Connections page to open. Send it with no token and no session cookie. The codes live ${CONNECT_MS / 60_000} minutes. A network may ask ${LIMITS_CONNECT.startNetwork.most} times in ${LIMITS_CONNECT.startNetwork.windowMs / 60_000} minutes and ${LIMITS_CONNECT.startNetworkDay.most} times in a day, and have ${OPEN_PER_NETWORK} requests waiting at once.`,
        operationId: "startConnection",
        security: [],
        requestBody: { required: true, content: json(ref("ConnectStart")) },
        responses: {
          "201": answer("The request, waiting for a person to confirm it.", ref("ConnectStarted")),
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. bad_device_name: the device name breaks its rule. credentials_not_allowed: the request carries a token or a session cookie.", "bad_request", "bad_device_name", "credentials_not_allowed"),
          "429": { description: "Too many requests from this network, or too many of its requests are waiting. Nothing was stored.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
        },
      },
    },
    "/api/v1/connect/token": {
      post: {
        tags: ["Connections"],
        summary: "Ask for the app's token",
        description: `For the desktop app: asks, with the device code, whether the request has been confirmed. pending until then; then connected, with a token for the workspace of the person who confirmed, given once, and who that was: the token is made at this moment, and a request nobody collects in time, or whose confirming session has ended since (signed out, ended from another browser, or expired), leaves none. Ask every ${POLL_INTERVAL_S} seconds; asking a waiting request again sooner answers slow_down and changes nothing. Every code that cannot give a token, whether unknown, expired, refused, already used or not a device code, gets the one answer expired_code, so codes cannot be told apart. Send it with no token and no session cookie. A network may ask ${LIMITS_CONNECT.pollNetwork.most} times in ${LIMITS_CONNECT.pollNetwork.windowMs / 60_000} minutes.`,
        operationId: "getConnectionToken",
        security: [],
        requestBody: { required: true, content: json(ref("ConnectPoll")) },
        responses: {
          "200": answer("Waiting, or connected with the token.", { oneOf: [ref("ConnectPending"), ref("ConnectConnected")] }),
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. credentials_not_allowed: the request carries a token or a session cookie.", "bad_request", "credentials_not_allowed"),
          "410": refusal("This code can give no token: start again with POST /api/v1/connect/start.", "expired_code"),
          "429": { description: `slow_down: asked again within the interval; wait ${POLL_INTERVAL_S} seconds more. rate_limited: too many asks from this network.`, headers: retryAfter, content: json(refusalSchema("slow_down", "rate_limited")) },
        },
      },
    },
    "/api/v1/connect/lookup": {
      post: {
        tags: ["Connections"],
        summary: "Look up a request by its short code",
        description: `What the Connections page shows before the person confirms: the device's name, when it asked, and whether the person is on the network the app asked from. The short code goes in the body, never in the address. Only a request that is waiting (neither confirmed nor refused, and not expired) is found; every other code is the one 404. A code that finds nothing counts as a wrong try: ${LIMITS_CONNECT.wrongAccount.most} for an account in ${LIMITS_CONNECT.wrongAccount.windowMs / 60_000} minutes, ${LIMITS_CONNECT.wrongNetwork.most} for a network, counted together with confirm and refuse; past that every try answers 429 until the time is up. A right code is not counted. Like every change made with a session, it must come from the site's own page with the anti-forgery header, so no other site can spend a person's tries. ${NOT_FROM_THE_PAGE}`,
        operationId: "lookUpConnection",
        security: SESSION,
        requestBody: { required: true, content: json(ref("UserCode")) },
        responses: {
          "200": answer("The request.", ref("ConnectRequest")),
          "400": refusal("The body is not a JSON object sent as application/json.", "bad_request"),
          "401": UNAUTHORIZED,
          "403": SESSION_CHANGE_REFUSED,
          "404": refusal("No request waiting under this code.", "not_found"),
          "429": { description: "Too many wrong codes from this account or this network. Nothing was looked at.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
        },
      },
    },
    "/api/v1/connect/confirm": {
      post: {
        tags: ["Connections"],
        summary: "Confirm a request to connect",
        description: `Confirms the waiting request the short code names, once, for the caller's account and its workspace: the app's next ask for the token gets a token for that workspace, as long as the session that confirmed is still signed in. A request already confirmed or refused, also by someone else a moment ago, an expired one and a code nobody has all get the one 404, and nothing changes. Counted as lookups are. ${NOT_FROM_THE_PAGE}`,
        operationId: "confirmConnection",
        security: SESSION,
        requestBody: { required: true, content: json(ref("UserCode")) },
        responses: {
          "204": empty("Confirmed."),
          "400": refusal("The body is not a JSON object sent as application/json.", "bad_request"),
          "401": UNAUTHORIZED,
          "403": SESSION_CHANGE_REFUSED,
          "404": refusal("No request waiting under this code.", "not_found"),
          "429": { description: "Too many wrong codes from this account or this network. Nothing was looked at.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
        },
      },
    },
    "/api/v1/connect/refuse": {
      post: {
        tags: ["Connections"],
        summary: "Refuse a request to connect",
        description: `Refuses the waiting request the short code names, once: the app's next ask answers expired_code. The same 404 and counting as confirming. ${NOT_FROM_THE_PAGE}`,
        operationId: "refuseConnection",
        security: SESSION,
        requestBody: { required: true, content: json(ref("UserCode")) },
        responses: {
          "204": empty("Refused."),
          "400": refusal("The body is not a JSON object sent as application/json.", "bad_request"),
          "401": UNAUTHORIZED,
          "403": SESSION_CHANGE_REFUSED,
          "404": refusal("No request waiting under this code.", "not_found"),
          "429": { description: "Too many wrong codes from this account or this network. Nothing was looked at.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
        },
      },
    },
    "/api/v1/tokens": {
      get: {
        tags: ["Connections"],
        summary: "List the workspace's tokens",
        description: `The tokens of the caller's workspace that are not revoked, newest first: each one's id, name, when it was made and last used, and how it was made. Never a token or any part of one. A token cannot call this. ${NOT_FROM_THE_PAGE}`,
        operationId: "listTokens",
        security: SESSION,
        responses: { "200": answer("The tokens.", ref("TokenList")), "401": UNAUTHORIZED },
      },
    },
    "/api/v1/tokens/{id}": {
      patch: {
        tags: ["Connections"],
        summary: "Rename a token",
        description: `Renames one of the workspace's tokens that is not revoked, and answers it. Another workspace's token, a revoked one and one that does not exist answer 404. A token cannot call this, not even to rename itself. ${NOT_FROM_THE_PAGE}`,
        operationId: "renameToken",
        security: SESSION,
        parameters: [tokenIdParam],
        requestBody: { required: true, content: json(ref("TokenRename")) },
        responses: {
          "200": answer("The token, renamed.", ref("TokenEntry")),
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. bad_name: the name breaks its rule.", "bad_request", "bad_name"),
          "401": UNAUTHORIZED,
          "403": SESSION_CHANGE_REFUSED,
          "404": refusal("No such token in this workspace.", "not_found"),
        },
      },
      delete: {
        tags: ["Connections"],
        summary: "Revoke a token",
        description: `Revokes one of the workspace's tokens, for good: every request whose token is looked up after this answer is refused with 401 (a request already under way finishes). Another workspace's token, one already revoked and one that does not exist answer 404. A token cannot call this. ${NOT_FROM_THE_PAGE}`,
        operationId: "revokeToken",
        security: SESSION,
        parameters: [tokenIdParam],
        responses: { "204": empty("Revoked."), "401": UNAUTHORIZED, "403": SESSION_CHANGE_REFUSED, "404": refusal("No such token in this workspace.", "not_found") },
      },
    },
    "/api/v1/admin/summary": {
      get: {
        tags: ["Admin"],
        summary: "Every account's storage use in all",
        description: `For the site's admin: how many accounts there are, what all their workspaces use together (counted as GET /api/v1/usage counts it for each account itself) and the site's standard allowance, null when the server's settings set none. Nothing of any workspace is in it. Every refusal is the one 404, whoever asks and whatever is wrong with the request. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminSummary",
        security: SESSION,
        responses: {
          "200": answer("The three numbers.", ref("AdminSummary")),
          "404": answer("Anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, or a session on the tours address. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
        },
      },
    },
    "/api/v1/admin/accounts": {
      get: {
        tags: ["Admin"],
        summary: "List every account's storage use",
        description: `For the site's admin: every account, in the order they were made, ${ADMIN_PAGE} at a time, with its workspace's id and name, its tour count, what it uses of its storage (counted as GET /api/v1/usage counts it for the account itself) and its allowance. Nothing of any workspace's tours is in it. Add ?after=<cursor>, with the next of the previous answer, for the next page. Every refusal is the one 404, whoever asks and whatever is wrong with the request. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminListAccounts",
        security: SESSION,
        responses: {
          "200": answer("The accounts.", ref("AdminAccountList")),
          "400": refusal("after is not a cursor this list gave (an account id, as versions before 0.1.33 gave, included): start again without it.", "bad_cursor"),
          "404": answer("Anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, or a session on the tours address. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
        },
      },
    },
    "/api/v1/admin/workspaces/{id}": {
      patch: {
        tags: ["Admin"],
        summary: "Set a workspace's storage allowance",
        description: `For the site's admin: sets the workspace's storage allowance in bytes, or with null goes back to the site's default (the server's setting). The change is in the audit record with the old and the new number. An allowance below what the workspace already uses is taken: nothing is deleted or unpublished, and only starting an upload that needs more room is refused from then on. Every refusal of the caller or of the request's origin, and a workspace that does not exist, is the one 404. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminSetAllowance",
        security: SESSION,
        parameters: [workspaceId],
        requestBody: { required: true, content: json(ref("AllowanceChange")) },
        responses: {
          "200": answer("The workspace's numbers after the change.", ref("AllowanceSet")),
          "400": refusal("bad_request: the body is not a JSON object holding storage_allowance_bytes and nothing else. bad_allowance: the value is not a whole number of bytes from 0 to 9007199254740991, or null for the site's default.", "bad_request", "bad_allowance"),
          "404": answer("No such workspace, or anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, a session on the tours address, a change from another origin or without the anti-forgery header. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
        },
      },
    },
    "/api/v1/admin/accounts/{id}/disable": {
      post: {
        tags: ["Admin"],
        summary: "Disable an account",
        description: `For the site's admin: the account cannot sign in from now on. Every session of it ends at once, its unused sign-in links and its open email change stop working, and every token of its workspace is refused while it is disabled (the tokens are kept, and work again once it is enabled). A request to connect the app that it confirmed can no longer be collected. Nothing of its workspace is served: its tour pages, published pictures and shared items answer exactly as ones that do not exist. Nothing is deleted. A tour page may be cached for ${PAGE_CACHE.replace("public, max-age=", "")} seconds and a published picture for a year (${PUBLIC_CACHE}), so this stops new fetches only: a copy a browser or a cache already holds is not taken back. On a server whose PUBLIC_IMAGE_BASE points published pictures at a storage bucket's own public address, pictures never pass through the server, so it cannot stop them at all: they stay reachable at their addresses until the tour is unpublished or deleted. Already disabled: 204, and nothing changes. In the audit record as account_disabled. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminDisableAccount",
        security: SESSION,
        parameters: [accountId],
        responses: {
          "204": empty("The account is disabled."),
          "404": answer("Anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, a session on the tours address, a change from another origin or without the anti-forgery header; and an account id that is malformed or names no account. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
          "409": refusal("own_account: this is the caller's own account. last_admin: this is the site's last active admin.", "own_account", "last_admin"),
        },
      },
    },
    "/api/v1/admin/accounts/{id}/enable": {
      post: {
        tags: ["Admin"],
        summary: "Enable a disabled account",
        description: `For the site's admin: the account may sign in again. Only that changes: its tour pages, pictures, shared items and tokens work as before it was disabled, and the person signs in again to use the dashboard. Already active: 204, and nothing changes. In the audit record as account_enabled. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminEnableAccount",
        security: SESSION,
        parameters: [accountId],
        responses: {
          "204": empty("The account is active."),
          "404": answer("Anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, a session on the tours address, a change from another origin or without the anti-forgery header; and an account id that is malformed or names no account. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
          "409": refusal("own_account: this is the caller's own account. deleting: a delete of the account has started; it cannot be enabled, and the delete is finished by sending it again.", "own_account", "deleting"),
        },
      },
    },
    "/api/v1/admin/accounts/{id}/undo-removal": {
      post: {
        tags: ["Admin"],
        summary: "Undo a delete that has removed nothing yet",
        description: `For the site's admin: a delete is recorded before the payment service is asked to cancel the account's subscription, so when that service never gives a definite answer the account stays disabled with its delete recorded. This takes the record back, only while nothing of the workspace has been removed: the account is disabled, as before the delete, and can be enabled again. What the delete already did at the payment service (a subscription cancelled, a checkout expired) is not undone. A delete that has begun removing files or rows can only be finished: send the delete again. In the audit record as account_removal_undone. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminUndoAccountRemoval",
        security: SESSION,
        parameters: [accountId],
        responses: {
          "200": answer("A removal the billing sweep had stopped is undone, also after it had begun: its record and the workspace's warning mails are gone, the account is disabled, and nothing removed is restored.", ref("RemovalUndone")),
          "204": empty("The delete's record is gone; the account is disabled."),
          "404": answer("Anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, a session on the tours address, a change from another origin or without the anti-forgery header; and an account id that is malformed or names no account. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
          "409": refusal("own_account: this is the caller's own account. not_deleting: no delete of the account is recorded. removal_started: the delete has begun removing the account's files or rows and was not stopped by the billing sweep; send the delete again to finish it.", "own_account", "not_deleting", "removal_started"),
        },
      },
    },
    "/api/v1/admin/accounts/{id}/removal": {
      get: {
        tags: ["Admin"],
        summary: "What deleting an account removes",
        description: `For the site's admin: the counts the question before a delete shows. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminAccountRemoval",
        security: SESSION,
        parameters: [accountId],
        responses: {
          "200": answer("The counts.", ref("AccountRemoval")),
          "404": answer("Anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, a session on the tours address, a change from another origin or without the anti-forgery header; and an account id that is malformed or names no account. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
        },
      },
    },
    "/api/v1/admin/accounts/{id}": {
      delete: {
        tags: ["Admin"],
        summary: "Delete a disabled account, in steps",
        description: `For the site's admin: removes a disabled account and everything of its workspace: every tour with its draft and published pictures, unfinished uploads, every shared item, the workspace's tokens and requests to connect the app, the account's sessions, sign-in links and email change, the workspace and the account; invites to its address are removed and those it sent stay valid. This cannot be undone. Only an account alone in its workspace can be deleted. Deleting, like disabling, cannot take back pictures a browser or a cache already holds (up to a year), nor stop those served from a bucket's own domain. Its address and its username are free again afterwards, and the audit record keeps account_deleted with the ids of the admin, the workspace and the account. Only a disabled account can be deleted, and the body must name it. A large workspace takes several requests, each removing a bounded part: send the same request until it answers 200. A delete that is stopped at any point leaves the account disabled and listed (with deleting true), and sending it again finishes it; while it is unfinished the account cannot be enabled. A repeated request after the account is gone answers 404, so treat 404 as "gone". Published pictures already held by a browser or a cache are not taken back (see the disable request). ${NOT_FROM_THE_PAGE}`,
        operationId: "adminDeleteAccount",
        security: SESSION,
        parameters: [accountId],
        requestBody: { required: true, content: json(ref("AccountDeleteConfirm")) },
        responses: {
          "200": answer("Nothing of the account is left.", ref("Deleted")),
          "202": answer("The delete has more to do; done and total count the workspace's files. Send the same request again.", ref("InProgress")),
          "400": refusal("bad_request: the body is not a JSON object holding username and nothing else. username_mismatch: username is not the account's username (or, when it has none, its email address) exactly.", "bad_request", "username_mismatch"),
          "404": answer("Anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, a session on the tours address, a change from another origin or without the anti-forgery header; and an account id that is malformed or names no account. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
          "409": refusal("own_account: this is the caller's own account. not_disabled: the account is not disabled; disable it first. last_admin: this is the site's last admin. shared_workspace: another account belongs to the account's workspace, whose work a delete would remove too. site_owner: the account owns the workspace the site was set up with, which cannot be deleted. not_deleting: the delete was undone while this request was asking the payment service, and nothing was removed.", "own_account", "not_disabled", "last_admin", "shared_workspace", "site_owner", "not_deleting"),
          "500": refusal("Part of the account is removed, but some of its files could not be removed yet. Nothing is lost: send the same request again.", "cleanup_pending"),
        },
      },
    },
    "/api/v1/admin/invites": {
      post: {
        tags: ["Admin"],
        summary: "Invite an address",
        description: `For the site's admin: mails the address a link that lets its owner make an account, once and for ${INVITE_MS / 86_400_000} days, and answers the invite. An address that already has an invite gets a new link in that same invite, and the older link stops working at once. The mail is sent before the answer: when it could not be handed over the invite stays and the answer is mail_failed, and resending it tries again. Nothing is counted or stored on a site that cannot send mail. An admin sends at most ${LIMITS_INVITE.sendAdmin.most} invites an hour, resends included, and the site sends at most ${LIMITS_INVITE.mailSite.most} invite mails an hour and holds at most ${MAX_INVITES} open invites (invites that ran out do not count). Every refusal of the caller is the one 404. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminInvite",
        security: SESSION,
        requestBody: { required: true, content: json(ref("InviteSend")) },
        responses: {
          "201": answer("The invite; its mail is on its way.", ref("Invite")),
          "400": answer("bad_request: the body is not a JSON object holding email and nothing else. bad_email, with no detail: email is not an email address.", someDetail("bad_request", "bad_email")),
          "404": answer("Anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, a session on the tours address, a change from another origin or without the anti-forgery header. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
          "409": refusal(`mail_off: the site cannot send mail. has_account: the address already has an account. too_many_invites: the site holds ${MAX_INVITES} open invites already; cancel one. Nothing was stored.`, "mail_off", "has_account", "too_many_invites"),
          "429": { description: "The admin sent its invites for this hour, or the site its invite mails. Nothing was stored.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
          "502": refusal("The invite is stored, but its mail could not be handed over. Resend it to try again.", "mail_failed"),
        },
      },
      get: {
        tags: ["Admin"],
        summary: "List the invites",
        description: `For the site's admin: the invites that are open or ran out, newest first, at most ${MAX_INVITES}: every open one, then as many that ran out as fit. An accepted or cancelled invite is gone, and one that ran out is removed ${INVITE_KEPT_MS / 86_400_000} days later. It works whether or not the site can send mail. Every refusal is the one 404. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminListInvites",
        security: SESSION,
        responses: { "200": answer("The invites.", ref("InviteList")), "404": answer("Anything other than the site's admin, signed in on this address, with a correct request: no credential, a token, another account's session, a token with a session, a session on the tours address, a change from another origin or without the anti-forgery header. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")) },
      },
    },
    "/api/v1/admin/invites/{id}/resend": {
      post: {
        tags: ["Admin"],
        summary: "Send an invite again",
        description: `For the site's admin: mails the invite again with a new link, for ${INVITE_MS / 86_400_000} days from now, from the admin who asks; the older link stops working at once. It counts as an invite in the admin's and the site's hourly numbers. Answers the refreshed invite. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminResendInvite",
        security: SESSION,
        parameters: [inviteId],
        responses: {
          "200": answer("The refreshed invite; its mail is on its way.", ref("Invite")),
          "404": answer("No such invite, or anything other than the site's admin, signed in on this address, with a correct request. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")),
          "409": refusal(`mail_off: the site cannot send mail. has_account: the address has an account by now; cancel the invite. too_many_invites: the invite ran out, and the site holds ${MAX_INVITES} open invites already. Nothing changed.`, "mail_off", "has_account", "too_many_invites"),
          "429": { description: "The admin sent its invites for this hour, or the site its invite mails. Nothing changed.", headers: retryAfter, content: json(refusalSchema("rate_limited")) },
          "502": refusal("The invite has its new link, but the mail could not be handed over. Resend it to try again.", "mail_failed"),
        },
      },
    },
    "/api/v1/admin/invites/{id}": {
      delete: {
        tags: ["Admin"],
        summary: "Cancel an invite",
        description: `For the site's admin: ends the invite, and its link stops working at once. The address can be invited again. It works whether or not the site can send mail. ${NOT_FROM_THE_PAGE}`,
        operationId: "adminCancelInvite",
        security: SESSION,
        parameters: [inviteId],
        responses: { "204": empty("Cancelled."), "404": answer("No such invite, or anything other than the site's admin, signed in on this address, with a correct request. The 400 and 403 answers any request can get are this 404 here.", bare("not_found")) },
      },
    },
    "/api/v1/view/request": {
      post: {
        tags: ["Viewers"],
        summary: "Ask for a link to view a shared tour",
        description: `For the page of a tour that is shared with a list of addresses, on the tours address: mails the visitor a link that proves the address, when the slug names a published tour shared with it and mail is on. The answer is the same \`202\` in every case (an unknown tour, a public one, an address not on the list, a malformed address), after the same work, so it tells nothing about the tour or its list, and it does not wait for the mail. The link works once and for ${VIEWER_CODE_MS / 60_000} minutes. Needs no credential, but must come from a page of the address it is sent to, as JSON; a token is refused. One address gets at most a few links in a quarter hour and in a day, however many tours or networks ask; past that the answer is the same and no mail is sent.`,
        operationId: "requestViewerLink",
        security: [],
        requestBody: { required: true, content: json(ref("ViewerRequest")) },
        responses: {
          "202": answer("The same for every tour and address.", ref("Ok")),
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. credentials_not_allowed: the request carries a token.", "bad_request", "credentials_not_allowed"),
          "403": refusal("The request did not come from a page of this address: no Origin, another one, or the browser says it came from another site.", "bad_origin"),
          "429": { description: "Too many requests from this network. Nothing was sent.", headers: retryAfter, content: json(bare("rate_limited")) },
        },
      },
    },
    "/api/v1/view/check": {
      post: {
        tags: ["Viewers"],
        summary: "Look up a viewer link",
        description: `For the page a viewer link opens: the address the link was mailed to and the tour it was asked for. It changes nothing, so a mail scanner that opens the link uses nothing up. Needs no credential, but must come from a page of the address it is sent to, as JSON; a token is refused. Every code that cannot be used gets the one answer view_link_invalid. A network may look up and complete codes ${LIMITS_VIEWER.codeNetwork.most} times in ${LIMITS_VIEWER.codeNetwork.windowMs / 60_000} minutes.`,
        operationId: "checkViewerLink",
        security: [],
        requestBody: { required: true, content: json(ref("ViewerCode")) },
        responses: {
          "200": answer("The link's address and tour.", ref("ViewerFound")),
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. credentials_not_allowed: the request carries a token.", "bad_request", "credentials_not_allowed"),
          "403": refusal("The request did not come from a page of this address.", "bad_origin"),
          "404": refusal("The link cannot be used: unknown, already used, expired or not a viewer code. They cannot be told apart.", "view_link_invalid"),
          "429": { description: "Too many tries from this network. Nothing was looked at.", headers: retryAfter, content: json(bare("rate_limited")) },
        },
      },
    },
    "/api/v1/view/complete": {
      post: {
        tags: ["Viewers"],
        summary: "Prove the address of a viewer link",
        description: "Turns the code of a viewer link into a viewer session for the address it was mailed to, once, and sets the viewer cookie on this address: a new session every time, which replaces the one the browser had. Of two requests with one code only one makes a session. Needs no credential, but must come from a page of the address it is sent to, as JSON, so another site cannot do it for a visitor; a token is refused. Every code that cannot be used gets the one answer view_link_invalid. The answer never repeats the code.",
        operationId: "completeViewerLink",
        security: [],
        requestBody: { required: true, content: json(ref("ViewerCode")) },
        responses: {
          "200": { ...answer("The address is proved; the tour to go to.", ref("ViewerDone")), headers: setViewerCookie("The viewer cookie: host-only, Secure, HttpOnly and SameSite=Lax.") },
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. credentials_not_allowed: the request carries a token.", "bad_request", "credentials_not_allowed"),
          "403": refusal("The request did not come from a page of this address.", "bad_origin"),
          "404": refusal("The link cannot be used: unknown, already used, expired or not a viewer code. They cannot be told apart.", "view_link_invalid"),
          "429": { description: "Too many tries from this network. Nothing was looked at.", headers: retryAfter, content: json(bare("rate_limited")) },
        },
      },
    },
    "/api/v1/view/signout": {
      post: {
        tags: ["Viewers"],
        summary: "End this browser's viewer session",
        description: "Ends the viewer session of the browser's viewer cookie and clears the cookie. A request with no viewer cookie answers the same 204 and sets nothing. Must come from a page of the address it is sent to; a token is refused. It never touches an account's session.",
        operationId: "viewerSignOut",
        security: [],
        responses: {
          "204": empty("Signed out. With a viewer cookie, the answer clears it."),
          "400": refusal("credentials_not_allowed: the request carries a token.", "credentials_not_allowed"),
          "403": refusal("The request did not come from a page of this address.", "bad_origin"),
        },
      },
    },
    "/api/v1/view/session": {
      get: {
        tags: ["Viewers"],
        summary: "The address this browser proved",
        description: "For the tour pages to show whom the visitor views as: the address of the browser's live viewer session. Needs the viewer cookie, so it cannot be tried from the documentation page, which never sends a cookie; a token is refused, and a request with both proves nothing. An account's session is no viewer session.",
        operationId: "getViewerSession",
        security: VIEWER,
        responses: {
          "200": answer("The proved address.", ref("ViewerSession")),
          "400": refusal("credentials_not_allowed: the request carries a token.", "credentials_not_allowed"),
          "401": answer("No live viewer session: no viewer cookie, or one that is unknown, signed out or over. This answer has no detail.", bare("unauthorized")),
        },
      },
    },
    "/api/v1/media-view/request": {
      post: {
        tags: ["Viewers"],
        summary: "Ask for a link to view a shared image or clip",
        description: `For the page of an image or clip that is shared with a list of addresses, on the address for images and clips: mails the visitor a link that proves the address, when the path names an item shared with it and mail is on. The answer is the same \`202\` in every case, after the same work, so it tells nothing about the item or its list. The link works once and for ${VIEWER_CODE_MS / 60_000} minutes. Needs no credential, but must come from a page of the address it is sent to, as JSON; a token is refused. The limits of POST /api/v1/view/request are shared with this request: one address, one network, one workspace and the whole site get no more viewer links from the two together than from either alone.`,
        operationId: "requestMediaViewerLink",
        security: [],
        requestBody: { required: true, content: json(ref("MediaViewerRequest")) },
        responses: {
          "202": answer("The same for every item and address.", ref("Ok")),
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. credentials_not_allowed: the request carries a token.", "bad_request", "credentials_not_allowed"),
          "403": refusal("The request did not come from a page of this address: no Origin, another one, or the browser says it came from another site.", "bad_origin"),
          "429": { description: "Too many requests from this network. Nothing was sent.", headers: retryAfter, content: json(bare("rate_limited")) },
        },
      },
    },
    "/api/v1/media-view/check": {
      post: {
        tags: ["Viewers"],
        summary: "Look up a viewer link for an image or clip",
        description: `For the page a viewer link for an image or clip opens: the address the link was mailed to and the item's page it was asked from. It changes nothing. Needs no credential, but must come from a page of the address it is sent to, as JSON; a token is refused. Every code that cannot be used gets the one answer view_link_invalid; a tour's code is one of them. A network may look up and complete codes ${LIMITS_VIEWER.codeNetwork.most} times in ${LIMITS_VIEWER.codeNetwork.windowMs / 60_000} minutes.`,
        operationId: "checkMediaViewerLink",
        security: [],
        requestBody: { required: true, content: json(ref("MediaViewerCode")) },
        responses: {
          "200": answer("The link's address and item page.", ref("MediaViewerFound")),
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. credentials_not_allowed: the request carries a token.", "bad_request", "credentials_not_allowed"),
          "403": refusal("The request did not come from a page of this address.", "bad_origin"),
          "404": refusal("The link cannot be used: unknown, already used, expired or not a viewer code for an image or clip. They cannot be told apart.", "view_link_invalid"),
          "429": { description: "Too many tries from this network. Nothing was looked at.", headers: retryAfter, content: json(bare("rate_limited")) },
        },
      },
    },
    "/api/v1/media-view/complete": {
      post: {
        tags: ["Viewers"],
        summary: "Prove the address of a viewer link for an image or clip",
        description: `Turns the code of a viewer link for an image or clip into a viewer session for the address it was mailed to, once, and sets the cookie ${MEDIA_VIEWER_COOKIE} on this address: a new session every time, which replaces the one that cookie held. It is not the tours address's viewer session, which it neither makes nor ends: an address proved for tours is proved once more for images and clips. Needs no credential, but must come from a page of the address it is sent to, as JSON; a token is refused. Every code that cannot be used gets the one answer view_link_invalid.`,
        operationId: "completeMediaViewerLink",
        security: [],
        requestBody: { required: true, content: json(ref("MediaViewerCode")) },
        responses: {
          "200": { ...answer("The address is proved; the item's page to go to.", ref("MediaViewerDone")), headers: setMediaViewerCookie("The media viewer cookie: host-only, Secure, HttpOnly and SameSite=Lax.") },
          "400": refusal("bad_request: the body is not a JSON object sent as application/json. credentials_not_allowed: the request carries a token.", "bad_request", "credentials_not_allowed"),
          "403": refusal("The request did not come from a page of this address.", "bad_origin"),
          "404": refusal("The link cannot be used: unknown, already used, expired or not a viewer code for an image or clip. They cannot be told apart.", "view_link_invalid"),
          "429": { description: "Too many tries from this network. Nothing was looked at.", headers: retryAfter, content: json(bare("rate_limited")) },
        },
      },
    },
    "/api/v1/media-view/signout": {
      post: {
        tags: ["Viewers"],
        summary: "End this browser's viewer session for images and clips",
        description: "Ends the session of the browser's media viewer cookie and clears that cookie. A request without it answers the same 204 and sets nothing. Must come from a page of the address it is sent to; a token is refused. It never touches the tours address's viewer session or an account's session.",
        operationId: "mediaViewerSignOut",
        security: [],
        responses: {
          "204": empty("Signed out. With a media viewer cookie, the answer clears it."),
          "400": refusal("credentials_not_allowed: the request carries a token.", "credentials_not_allowed"),
          "403": refusal("The request did not come from a page of this address.", "bad_origin"),
        },
      },
    },
    "/api/v1/media-view/session": {
      get: {
        tags: ["Viewers"],
        summary: "The address this browser proved for images and clips",
        description: "For the pages of an image or clip to show whom the visitor views as: the address of the browser's live media viewer session. Needs the media viewer cookie, so it cannot be tried from the documentation page; a token is refused, and a request with both proves nothing. The tours address's viewer session and an account's session are no media viewer session.",
        operationId: "getMediaViewerSession",
        security: MEDIA_VIEWER,
        responses: {
          "200": answer("The proved address.", ref("ViewerSession")),
          "400": refusal("credentials_not_allowed: the request carries a token.", "credentials_not_allowed"),
          "401": answer("No live media viewer session: no such cookie, or one that is unknown, signed out or over. This answer has no detail.", bare("unauthorized")),
        },
      },
    },
    "/healthz": {
      get: {
        tags: ["Server"],
        summary: "Whether the server is up",
        description: "Answers 200 when the server runs and reaches its database. It needs no token and answers on every host name. On a server with two addresses, asked on one of them, it also says which of the two it was reached on.",
        operationId: "getHealth",
        security: [],
        responses: { "200": answer("The server is up.", ref("Health")) },
      },
    },
  };
}

/** The whole description. Pure and deterministic: a new object on every call, built only from constants. */
export function openapi(): OpenApiDoc {
  return {
    openapi: "3.1.0",
    info: { title: "Mythicshot API", version: VERSION, description: introduction() },
    servers: [{ url: "/" }],
    tags: [
      { name: "Tours", description: "List, rename, publish, unpublish and delete tours, and read a draft step's image." },
      { name: "Uploads", description: "Send a tour, a new chapter or a chapter's replacement: start, one request per image, finish." },
      { name: "Items", description: "Share a single image or a short clip: start, one request per part, an optional preview, finish; then list, read and delete." },
      { name: "Workspace", description: "The workspace a token or a session belongs to." },
      { name: "Accounts", description: "Signing in with a link sent by mail, accepting an invite, the browser sessions of an account, changing its email address, and agreeing to the site's terms. The site's own pages use these." },
      { name: "Connections", description: "Connecting the desktop app with a short code a signed-in person confirms, and the workspace's tokens: list, rename and revoke. The app's two requests take no credential; the rest take the session." },
      { name: "Admin", description: "For the site's admin alone: the site's storage in all, how each account uses its storage, each workspace's allowance, inviting people, and disabling, enabling and deleting an account. To anyone else these answer 404." },
      { name: "Viewers", description: "A visitor proving an email address, to view a tour or a shared image or clip that is shared with a list of addresses: on the tours address for tours (/api/v1/view/), on the address for images and clips for those (/api/v1/media-view/), each with its own cookie. No account and no token: the pages use these." },
      { name: "Server", description: "Whether the server is up. Needs no token." },
    ],
    paths: paths(),
    components: {
      securitySchemes: { token: { type: "http", scheme: "bearer" }, session: { type: "apiKey", in: "cookie", name: SESSION_COOKIE }, viewer: { type: "apiKey", in: "cookie", name: VIEWER_COOKIE }, mediaViewer: { type: "apiKey", in: "cookie", name: MEDIA_VIEWER_COOKIE } },
      schemas: schemas(),
      responses: {
        Unauthorized: answer("The token or session is missing, malformed, unknown, expired or revoked.", ref("Unauthorized")),
      },
    },
  };
}
