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
import { LIMITS } from "../manifest.ts";
import { COPY_BATCH, MAX_PUBLISH_STEPS, MAX_SNAPSHOT_BYTES, STALE_PUBLISH_MS } from "../publish.ts";
import { LOGO_RULE, STEP_IMAGE_RULE } from "../sniff.ts";
import { DELETE_FILES_PER_CALL } from "../tours.ts";
import { SESSION_COOKIE, SESSION_MS, SIGNIN_CODE_MS } from "../sessions.ts";
import { DEFAULT_MAX_OPEN_UPLOADS, UPLOAD_MAX_AGE_MS } from "../uploads.ts";
import { VERSION } from "../version.ts";

export type OpenApiParameter = { name: string; in: "path"; required: true; description: string; schema: Record<string, unknown> };
export type OpenApiOperation = {
  tags: [string];
  summary: string;
  description: string;
  operationId: string;
  /**
   * Who may call: empty for a request that needs no credential; the token or the session
   * cookie (either one, never both) for most; the session alone for the session's own requests.
   */
  security: [] | [{ token: [] }, { session: [] }] | [{ session: [] }];
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
    securitySchemes: { token: { type: "http"; scheme: "bearer" }; session: { type: "apiKey"; in: "cookie"; name: string } };
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
  "GET /t/:slug": "the public tour page, for visitors; not part of the token API",
  "GET /p/:name": "a published picture, for visitors; not part of the token API",
  "GET /:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}": "the tour player's own files, loaded by the tour page",
  "GET /docs": "the documentation page itself",
  "GET /docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}": "the documentation page's own files",
  "GET /docs/licences.txt": "the licence notices of the documentation page's viewer",
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

/** The token or the session cookie, either one. */
const TOKEN = [{ token: [] }, { session: [] }] as [{ token: [] }, { session: [] }];
/** The session cookie alone: the session's own requests. */
const SESSION = [{ session: [] }] as [{ session: [] }];
const UNAUTHORIZED = { $ref: "#/components/responses/Unauthorized" };
/** Said on every request that takes only a session. */
const NOT_FROM_THE_PAGE = "It needs the session cookie, so it cannot be tried from the documentation page, which never sends a cookie.";
/** A refusal that carries a code and no detail. */
const bare = (...codes: string[]): Schema => object(["error"], { error: { type: "string", enum: codes } });
/** A refusal whose codes come with a detail or, for those the description says so of, without one. */
const someDetail = (...codes: string[]): Schema => object(["error"], { error: { type: "string", enum: codes }, detail: { type: "string" } });
const retryAfter = { "retry-after": { description: "Seconds until the count starts again.", schema: { type: "integer", minimum: 1 } } };
const setCookie = (description: string) => ({ "set-cookie": { description, schema: { type: "string", pattern: `^${SESSION_COOKIE}=` } } });

const tourId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The tour's id, as the tour list and an upload's commit give it.", schema: { type: "string", pattern: "^tour_[0-9a-f]{24}$" } };
const uploadId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The upload's id, from the answer that started it.", schema: { type: "string", pattern: "^up_[0-9a-f]{24}$" } };
const stepId: OpenApiParameter = { name: "step_id", in: "path", required: true, description: "The step's id.", schema: { type: "string", pattern: "^st_[0-9a-f]{24}$" } };
const sessionId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The session's id, as the list of sessions gives it.", schema: { type: "string", pattern: "^ses_[0-9a-f]{24}$" } };

function introduction(): string {
  const hours = UPLOAD_MAX_AGE_MS / 3_600_000;
  const minutes = STALE_PUBLISH_MS / 60_000;
  return [
    "Upload, publish and manage interactive product tours. This is the API Mythicshot itself uses.",
    "",
    "## Get connected",
    "",
    'Every request except the health check and the two sign-in requests carries a token, as the header `Authorization: Bearer YOUR_TOKEN`, or a session cookie (see below). A token starts with "dp_" and is 43 characters long. It acts only inside its own workspace: another workspace\'s tour answers 404, the same as one that does not exist.',
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
    "A request with a session that changes anything (any method but GET and HEAD) must come from the site's own pages: its Origin must be the address it is sent to, and it must carry the session's anti-forgery value in the header `X-Csrf-Token`, which GET /api/v1/session gives. A token and a session cookie together are refused.",
    "",
    "The documentation page never sends a cookie, so a session cannot be tried from it; with a token, try the requests that take one.",
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
    '- `404 {"error":"not_found"}`, with no detail: no request has that address.',
    "- `421` with nothing in it: on a server with two addresses, the request was sent to another host name.",
    '- `500 {"error":"internal"}`: the server failed; nothing about the failure is given.',
    '- `500 {"error":"misconfigured"}`: on Cloudflare, the two addresses in the settings cannot be used together; every request answers this until they are fixed.',
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
    `- ${DEFAULT_MAX_OPEN_UPLOADS} open uploads per workspace, unless the server's settings give another number.`,
    `- An upload that is not finished is removed after ${hours} hours.`,
    "- A workspace may have a storage allowance, set by the server's settings or its admin. An upload that would take the workspace over it is refused when it is started, with 413 `storage_full` and the numbers, before anything is stored. Nothing is ever deleted because of an allowance.",
    `- A publish that makes no progress for ${minutes} minutes counts as abandoned.`,
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
      ["status", "publish_id", "done", "total"],
      {
        status: inProgress,
        publish_id: { type: "string", pattern: "^pub_[0-9a-f]{24}$", description: "Send it back in the next publish request to continue this publish." },
        done: whole("Images copied so far."),
        total: whole("Images to copy in all."),
      },
      "A publish that has more images to copy.",
    ),
    UnpublishInProgress: object(
      ["status", "detail"],
      { status: inProgress, detail: { type: "string", description: "What is left to do, in plain words." } },
      "The tour is unpublished, but some of its public images are still to be removed. Send the same request again.",
    ),
    Tour: object(
      ["id", "title", "status", "slug", "url", "chapters", "steps", "updated_at", "published_at", "unpublished_changes"],
      {
        id: { type: "string", pattern: "^tour_[0-9a-f]{24}$" },
        title: { type: "string" },
        status: { type: "string", enum: ["draft", "published"] },
        slug: { type: "string", description: "The last part of the public link. It never changes, also not on a rename." },
        url: { type: ["string", "null"], description: "The public link as a path, /t/<slug>, to put after the server address. null for a draft." },
        chapters: whole("How many chapters the draft has."),
        steps: whole("How many steps the draft has."),
        updated_at: whole("When the draft last changed, in milliseconds since 1970."),
        published_at: { type: ["integer", "null"], description: "When the tour was last published, in milliseconds since 1970. null for a draft." },
        unpublished_changes: {
          type: "boolean",
          description:
            "true when the tour is published and its draft holds a chapter upload or update that is not on the public page yet, so publishing it again would change what visitors see; also when the server cannot tell, which happens only for some tours last published before version 0.1.4. false for a draft, and for a published tour whose page is up to date. A rename is live at once and never sets it.",
        },
      },
    ),
    TourList: object(["tours"], { tours: { type: "array", items: ref("Tour"), description: "Most recently changed first." } }),
    RenameBody: input(["title"], { title: text(LIMITS.title, "The new title: trimmed, no control or format characters.", 1) }),
    Renamed: object(["id", "title"], { id: { type: "string" }, title: { type: "string", description: "The title as saved (trimmed)." } }),
    Deleted: object(["deleted"], { deleted: { type: "boolean", const: true } }, "Nothing of the tour is left."),
    PublishBody: input([], { publish_id: { type: ["string", "null"], pattern: "^pub_[0-9a-f]{24}$", description: "The publish_id of the previous answer, to continue that publish." } }),
    Published: object(
      ["slug", "url", "steps"],
      { slug: { type: "string" }, url: { type: "string", description: "The tour's link as a path, /t/<slug>, to put after the server address." }, steps: whole("How many steps the published version has.") },
      "The new version is live.",
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
      ["used_bytes", "allowance_bytes", "over", "tours", "counted"],
      {
        used_bytes: whole("What the workspace uses, in bytes: the three numbers of counted together."),
        allowance_bytes: { type: ["integer", "null"], description: "The workspace's storage allowance in bytes: its own number, else the server's setting. null when there is no limit." },
        over: { type: "boolean", description: "true when more is used than the allowance. Always false without a limit; exactly the allowance is not over it." },
        tours: whole("How many tours the workspace has, drafts and published."),
        counted: object(
          ["pictures", "logos", "uploads_in_progress"],
          {
            pictures: whole("The images of every step of every tour, published or not."),
            logos: whole("The tours' logos. A logo stored by a server before version 0.1.8 counts as 0."),
            uploads_in_progress: whole("The room held by uploads that are not finished: what each one needed when it was started."),
          },
          "What used_bytes is made of, in bytes.",
        ),
      },
      "What a workspace uses of its storage allowance.",
    ),
    StorageFull: object(
      ["error", "detail", "used_bytes", "allowance_bytes", "needed_bytes"],
      {
        error: { type: "string", enum: ["storage_full"] },
        detail: { type: "string", description: "The same in words, as one sentence under 200 characters that a program can show after its own words, such as \"Could not start the upload: \". The text may change; do not match on it." },
        used_bytes: whole("What the workspace uses now, in bytes."),
        allowance_bytes: whole("The workspace's storage allowance, in bytes."),
        needed_bytes: whole(`The room this upload needs, in bytes: all its images, and for a logo it carries its logo_bytes, or ${n(LOGO_RULE.maxBytes)} without one; for the replacement of a chapter, only what that comes to above the chapter's present images and, for a tour's first chapter, the recorded size of its present logo.`),
      },
      "The upload would take the workspace over its storage allowance. Nothing was stored and no upload exists.",
    ),
    SignInRequest: input(["email"], { email: text(254, "The address to send the link to. Spaces around it are dropped and capitals do not count.", 3) }),
    SignInComplete: input(["code"], { code: { type: "string", pattern: "^dpl_[0-9a-f]{40}$", description: "The code of the link, the part after #c= in its address." } }),
    Ok: object(["ok"], { ok: { type: "boolean", const: true } }),
    Session: object(
      ["account", "workspace", "session", "csrf"],
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
          ["id", "created_at", "expires_at"],
          { id: { type: "string", pattern: "^ses_[0-9a-f]{24}$" }, created_at: whole("When the browser signed in, in milliseconds since 1970."), expires_at: whole("When the session ends unless it is used, in milliseconds since 1970.") },
          "This session.",
        ),
        csrf: { type: "string", pattern: "^[0-9a-f]{64}$", description: "The anti-forgery value: send it in the X-Csrf-Token header of every change made with this session." },
      },
    ),
    SessionList: object(["sessions"], {
      sessions: {
        type: "array",
        description: "The account's live sessions, the current one first.",
        items: object(["id", "label", "created_at", "last_used_at", "expires_at", "current"], {
          id: { type: "string", pattern: "^ses_[0-9a-f]{24}$" },
          label: { type: "string", maxLength: 40, description: "The browser and the system it was signed in on, such as Firefox on Linux, or Unknown browser." },
          created_at: whole("When it was signed in, in milliseconds since 1970."),
          last_used_at: whole("When it was last used, to the hour, in milliseconds since 1970."),
          expires_at: whole("When it ends unless it is used, in milliseconds since 1970."),
          current: { type: "boolean", description: "true for the session this request was sent with." },
        }),
      },
    }),
    Health: object(
      ["ok"],
      { ok: { type: "boolean", const: true }, address: { type: "string", enum: ["tours", "app"], description: "Only on a server with two addresses, when asked on one of them: which of the two this request reached." } },
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
        description: `Copies the tour's draft into a public version at its link. Send it with no body to start, or to join the publish already in progress for the current draft. A small tour answers 200 at once. A large one answers 202 with a publish_id: send the request again with that id, each request copying up to ${COPY_BATCH} images, until it answers 200. Visitors see the previously published version until the last request, and a publish that did not finish never touches it. A publish works from the draft as it was when it started. A tour of more than ${n(MAX_PUBLISH_STEPS)} steps, or one whose text is over ${n(MAX_SNAPSHOT_BYTES)} bytes, answers 413 on the first request, before anything is copied. A publish with no progress for ${minutes} minutes counts as abandoned, and the next request without a publish_id starts a new one.`,
        operationId: "publishTour",
        security: TOKEN,
        parameters: [tourId],
        requestBody: { required: false, description: "Empty to start; the previous answer's publish_id to continue.", content: json(ref("PublishBody")) },
        responses: {
          "200": answer("The new version is live. The same answer on any repeat.", ref("Published")),
          "202": answer("Images are being copied. Send the request again with this publish_id.", ref("PublishInProgress")),
          "400": refusal("bad_request: the body is neither empty nor a publish_id. empty_tour: a tour with no steps cannot be published.", "bad_request", "empty_tour"),
          "401": UNAUTHORIZED,
          "404": noTour,
          "409": refusal(
            "publish_cancelled: that publish was stopped before it finished (the tour was unpublished, the publish failed or was abandoned, or a fresh start replaced it); publish again to start over. publish_busy: another publish of the tour is starting at this moment, or its draft changed while this one was starting; nothing was written, try again.",
            "publish_cancelled",
            "publish_busy",
          ),
          "413": refusal("The tour has too many steps or too much text to publish, or the request body is too long.", "too_large"),
          "500": refusal("The tour could not be published. What was published before is unchanged.", "publish_failed"),
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
        description: `Starts an upload from the tour's manifest (at most ${n(LIMITS.manifestBytes)} bytes) and says where it goes: a new tour, a new chapter of a tour, or the replacement of a chapter. Then send each step's image, the logo if one is due, and finish the upload; nothing changes in any tour until then. A replace changes the draft only: the public page stays as it was until the tour is published again. A workspace may have ${DEFAULT_MAX_OPEN_UPLOADS} open uploads at a time (the server's settings can give another number), and an upload that is not finished is removed after ${hours} hours. A repeated request only makes another upload. On a workspace with a storage allowance, an upload that would take it over is refused here with 413 storage_full, before any image is sent. A new tour or a new chapter needs room for all its images; the replacement of a chapter needs room only for what its images come to above the chapter's present ones. An upload that carries a logo (a new tour, or the replacement of a tour's first chapter, when the manifest names a logo) also needs room for the logo: logo_bytes when the request gives it, and without logo_bytes up to ${n(LOGO_RULE.maxBytes)} bytes; for a replacement, only what that comes to above the size recorded for the tour's present logo. So a replacement that does not grow the chapter is never refused for storage when it carries no logo, or gives a logo_bytes no larger than the present logo's recorded size.`,
        operationId: "createUpload",
        security: TOKEN,
        requestBody: { required: true, content: json(ref("UploadCreate")) },
        responses: {
          "201": answer("The upload exists. For the target replace the answer also has have and settings.", { oneOf: [ref("UploadCreated"), ref("ReplaceCreated")] }),
          "400": refusal(
            `bad_request: the body is not a JSON object, or sha256 is not one 64-character lowercase hex text per step, or comes with another target than replace, or logo_bytes is not a whole number from 1 to ${n(LOGO_RULE.maxBytes)}. bad_manifest: the manifest breaks a rule; the detail names the field. bad_target: the target is missing or its kind is not new, chapter or replace.`,
            "bad_request",
            "bad_manifest",
            "bad_target",
          ),
          "401": UNAUTHORIZED,
          "404": refusal("The target's tour is not in this workspace (detail: no such tour), or the chapter is not a chapter of that tour (detail: no such chapter).", "not_found"),
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
            "incomplete: a step's image, or a logo the upload must carry, has not been sent; nothing changes. chapter_changed: another upload replaced the chapter since this one started; nothing changes: cancel this upload and start again.",
            "incomplete",
            "chapter_changed",
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
        description: `What the token's workspace uses of its storage allowance, in bytes. Counted: the image of every step of every tour, published or not; each tour's logo; and the room held by every upload that is not finished (its images as the manifest gives them, and for a logo it carries the logo_bytes it was started with, or ${n(LOGO_RULE.maxBytes)} bytes without, until the logo's real size is recorded when the upload is finished), until the upload is finished, cancelled or removed. An upload nobody finishes is not removed by the clock alone: it is removed when the workspace next starts an upload once it is more than ${hours} hours old, and until then its room is still counted here. Not counted: the copies of images a published tour serves, and files that wait to be removed after a delete or a replace. allowance_bytes is null when neither the server's settings nor the workspace has one: No limit. over is true when more is used than the allowance, which can happen when an allowance is lowered; the server never deletes or unpublishes anything because of it, and only starting an upload that needs room is refused.`,
        operationId: "getUsage",
        security: TOKEN,
        responses: { "200": answer("The workspace's numbers.", ref("Usage")), "401": UNAUTHORIZED },
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
        responses: { "204": empty("The session has ended."), "401": UNAUTHORIZED, "404": refusal("No such live session of this account.", "not_found") },
      },
    },
    "/api/v1/signout": {
      post: {
        tags: ["Accounts"],
        summary: "Sign out",
        description: `Ends the session the request is sent with and clears its cookie. ${NOT_FROM_THE_PAGE}`,
        operationId: "signOut",
        security: SESSION,
        responses: { "204": { ...empty("Signed out."), headers: setCookie("Clears the session cookie.") }, "401": UNAUTHORIZED },
      },
    },
    "/api/v1/signout/everywhere": {
      post: {
        tags: ["Accounts"],
        summary: "Sign out everywhere",
        description: `Ends every session of the caller's account, in every browser, and clears this one's cookie. Tokens keep working. ${NOT_FROM_THE_PAGE}`,
        operationId: "signOutEverywhere",
        security: SESSION,
        responses: { "204": { ...empty("Every session of the account has ended."), headers: setCookie("Clears the session cookie.") }, "401": UNAUTHORIZED },
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
      { name: "Workspace", description: "The workspace a token or a session belongs to." },
      { name: "Accounts", description: "Signing in with a link sent by mail, and the browser sessions of an account. The site's own pages use these." },
      { name: "Server", description: "Whether the server is up. Needs no token." },
    ],
    paths: paths(),
    components: {
      securitySchemes: { token: { type: "http", scheme: "bearer" }, session: { type: "apiKey", in: "cookie", name: SESSION_COOKIE } },
      schemas: schemas(),
      responses: {
        Unauthorized: answer("The token or session is missing, malformed, unknown, expired or revoked.", ref("Unauthorized")),
      },
    },
  };
}
