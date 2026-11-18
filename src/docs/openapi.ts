// The API description: every request a token can make, as one OpenAPI 3.1 document.
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
import { DEFAULT_MAX_OPEN_UPLOADS, UPLOAD_MAX_AGE_MS } from "../uploads.ts";
import { VERSION } from "../version.ts";

export type OpenApiParameter = { name: string; in: "path"; required: true; description: string; schema: Record<string, unknown> };
export type OpenApiOperation = {
  tags: [string];
  summary: string;
  description: string;
  operationId: string;
  /** Empty for a request that needs no token. */
  security: [] | [{ token: [] }];
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
  components: { securitySchemes: { token: { type: "http"; scheme: "bearer" } }; schemas: Record<string, unknown>; responses: Record<string, unknown> };
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
const refusal = (description: string, ...codes: string[]) =>
  answer(description, {
    type: "object",
    required: ["error", "detail"],
    properties: { error: { type: "string", enum: codes }, detail: { type: "string" } },
    additionalProperties: false,
  });
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

const TOKEN = [{ token: [] }] as [{ token: [] }];
const UNAUTHORIZED = { $ref: "#/components/responses/Unauthorized" };

const tourId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The tour's id, as the tour list and an upload's commit give it.", schema: { type: "string", pattern: "^tour_[0-9a-f]{24}$" } };
const uploadId: OpenApiParameter = { name: "id", in: "path", required: true, description: "The upload's id, from the answer that started it.", schema: { type: "string", pattern: "^up_[0-9a-f]{24}$" } };
const stepId: OpenApiParameter = { name: "step_id", in: "path", required: true, description: "The step's id.", schema: { type: "string", pattern: "^st_[0-9a-f]{24}$" } };

function introduction(): string {
  const hours = UPLOAD_MAX_AGE_MS / 3_600_000;
  const minutes = STALE_PUBLISH_MS / 60_000;
  return [
    "Upload, publish and manage interactive product tours. This is the API Mythicshot itself uses.",
    "",
    "## Get connected",
    "",
    'Every request except the health check carries a token, as the header `Authorization: Bearer YOUR_TOKEN`. A token starts with "dp_" and is 43 characters long. It acts only inside its own workspace: another workspace\'s tour answers 404, the same as one that does not exist.',
    "",
    "The first request to try answers with your workspace's name and the server's version:",
    "",
    "```",
    GET_STARTED,
    "```",
    "",
    "## Errors",
    "",
    'Every refusal is JSON with an error code and, mostly, a detail in plain words: `{"error":"bad_title","detail":"the title must not be empty"}`. The codes are stable; the detail text may change.',
    "",
    "Some answers can come from any request and are not repeated on each one:",
    "",
    '- `401 {"error":"unauthorized"}`, with no detail: the token is missing, malformed, unknown or revoked.',
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
    Unauthorized: object(["error"], { error: { type: "string", const: "unauthorized" } }, "The one answer for a missing, malformed, unknown or revoked token."),
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
        description: `Starts an upload from the tour's manifest (at most ${n(LIMITS.manifestBytes)} bytes) and says where it goes: a new tour, a new chapter of a tour, or the replacement of a chapter. Then send each step's image, the logo if one is due, and finish the upload; nothing changes in any tour until then. A replace changes the draft only: the public page stays as it was until the tour is published again. A workspace may have ${DEFAULT_MAX_OPEN_UPLOADS} open uploads at a time (the server's settings can give another number), and an upload that is not finished is removed after ${hours} hours. A repeated request only makes another upload.`,
        operationId: "createUpload",
        security: TOKEN,
        requestBody: { required: true, content: json(ref("UploadCreate")) },
        responses: {
          "201": answer("The upload exists. For the target replace the answer also has have and settings.", { oneOf: [ref("UploadCreated"), ref("ReplaceCreated")] }),
          "400": refusal(
            "bad_request: the body is not a JSON object, or sha256 is not one 64-character lowercase hex text per step, or comes with another target than replace. bad_manifest: the manifest breaks a rule; the detail names the field. bad_target: the target is missing or its kind is not new, chapter or replace.",
            "bad_request",
            "bad_manifest",
            "bad_target",
          ),
          "401": UNAUTHORIZED,
          "404": refusal("The target's tour is not in this workspace (detail: no such tour), or the chapter is not a chapter of that tour (detail: no such chapter).", "not_found"),
          "413": refusal("The request body is too long.", "too_large"),
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
        description: `The body is the cover's logo, a PNG or a JPEG (as the manifest's cover names it) of at most ${n(LOGO_RULE.maxBytes)} bytes and ${n(LOGO_RULE.maxSide)} pixels on a side. Only an upload that makes a new tour, or replaces a tour's first chapter, takes a logo; a tour keeps its logo otherwise.`,
        operationId: "putLogo",
        security: TOKEN,
        parameters: [uploadId],
        requestBody: { required: true, content: image },
        responses: {
          "204": empty("The logo is stored."),
          "400": refusal("The body is not a logo of the type the manifest names, or is too large on a side.", "bad_image"),
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
      { name: "Workspace", description: "The workspace a token belongs to." },
      { name: "Server", description: "Whether the server is up. Needs no token." },
    ],
    paths: paths(),
    components: {
      securitySchemes: { token: { type: "http", scheme: "bearer" } },
      schemas: schemas(),
      responses: {
        Unauthorized: answer("The token is missing, malformed, unknown or revoked.", ref("Unauthorized")),
      },
    },
  };
}
