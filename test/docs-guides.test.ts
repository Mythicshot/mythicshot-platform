// The guides of the documentation page against the real routes, on both targets: a guide
// must not be able to say something the site does not do.
//
// Every `curl` command is read back out of the page itself (docsHtml()), in page order,
// turned into a request the way a shell and curl would (test/curl.ts) and sent through the
// harness. Only here are the placeholders filled in: the page's placeholder address
// becomes the harness's, YOUR_TOKEN a seeded token, the words in capitals the values the
// earlier answers gave, and the @files pictures that fit the example manifests. The status
// each example must answer is the one the page prints under it.
import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { looksLikeToken } from "../src/docs/client/rules.ts";
import { ANY_REQUEST_CODES, CODE_MEANINGS, errorCodes, GUIDE_ORIGIN, GUIDES, HISTORY_NOTE, limitLines, type GuideExample } from "../src/docs/guides.ts";
import { GET_STARTED, openapi } from "../src/docs/openapi.ts";
import { docsHtml } from "../src/docs/page.ts";
import type { Deps } from "../src/ports.ts";
import { COPY_BATCH } from "../src/publish.ts";
import { VERSION } from "../src/version.ts";
import { clone, fixtures, logoPng, ORIGIN, png, send, sha256Hex, uploadTour, type Call, type Json } from "./bundle.ts";
import { parseCurl, shellWords } from "./curl.ts";

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescape = (html: string) => html.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);
/** A piece of the page as the text a reader sees: tags out, entities back. */
const textOf = (html: string) => unescape(html.replace(/<[^>]*>/g, ""));

type PageGuide = { id: string; html: string; examples: GuideExample[] };

/** The guides as the page shows them: each section, and its commands with the status printed under each. */
function pageGuides(): PageGuide[] {
  const out: PageGuide[] = [];
  for (const section of docsHtml().matchAll(/<section class="own block guide" id="guide-([a-z-]+)">([\s\S]*?)<\/section>/g)) {
    const examples: GuideExample[] = [];
    for (const m of section[2].matchAll(/<code class="example">([^<]*)<\/code><\/pre>.*?<p class="answers">Answers (\d{3})( when it is done, 202 until then)?\.<\/p>/g)) {
      const status = Number(m[2]);
      examples.push(m[3] === undefined ? { curl: unescape(m[1]), expect: status } : { curl: unescape(m[1]), expect: status, repeatUntil: status });
    }
    out.push({ id: section[1], html: section[2], examples });
  }
  return out;
}

/** The words in capitals an example leaves for the reader to fill in, and the files it sends. */
function placeholdersOf(curl: string): string[] {
  const words = curl.split(GUIDE_ORIGIN).join("").match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  const files = [...curl.matchAll(/ @([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  return [...new Set([...words, ...files])];
}

type World = { deps: Deps; vars: Record<string, string>; files: Record<string, Uint8Array> };

/** Sends one example as curl would, with the placeholders filled in. */
async function run(world: World, curl: string): Promise<Call> {
  let command = curl.split(GUIDE_ORIGIN).join(ORIGIN);
  for (const [word, value] of Object.entries(world.vars)) command = command.split(word).join(value);
  const left = placeholdersOf(command).filter((w) => !Object.hasOwn(world.files, w));
  if (left.length > 0) throw new Error(`nothing to put in place of ${left.join(", ")} in: ${curl}`);
  const request = parseCurl(command);
  if (!request.url.startsWith(ORIGIN + "/")) throw new Error(`an example goes somewhere else than the site: ${request.url}`);
  let body: Uint8Array | string | undefined;
  if (request.data?.kind === "text") body = request.data.text;
  if (request.data?.kind === "file") {
    body = world.files[request.data.name];
    if (body === undefined) throw new Error(`no file ${request.data.name} for: ${curl}`);
  }
  const answer = await send(world.deps, request.method, request.url.slice(ORIGIN.length), { headers: request.headers, body: body as RequestInit["body"] });
  // What a later example needs from this answer.
  for (const [field, word] of [["upload_id", "UPLOAD_ID"], ["tour_id", "TOUR_ID"], ["chapter_id", "CHAPTER_ID"]]) {
    if (typeof answer.json?.[field] === "string") world.vars[word] = answer.json[field];
  }
  return answer;
}

/** Sends an example; one that works in steps is sent again, unchanged, while it answers 202. */
async function runExample(world: World, example: GuideExample): Promise<{ answer: Call; sent: number }> {
  let answer = await run(world, example.curl);
  let sent = 1;
  while (example.repeatUntil !== undefined && answer.status === 202 && sent < 100) {
    answer = await run(world, example.curl);
    sent++;
  }
  return { answer, sent };
}

describe("the guides of the documentation page", () => {
  it("the page shows every example of every guide, in order, with the status it answers", () => {
    const shown = pageGuides();
    expect(shown.map((g) => g.id)).toEqual(["upload-and-publish", "update-a-tour", "errors-and-limits"]);
    expect(GUIDES.map((g) => g.id)).toEqual(shown.map((g) => g.id));
    for (const [i, guide] of GUIDES.entries()) {
      const examples = guide.steps.flatMap((s) => (s.example === undefined ? [] : [s.example]));
      expect(examples.length, guide.id).toBeGreaterThan(0);
      expect(shown[i].examples, guide.id).toEqual(examples);
      // A step that works in several requests ends on the status it repeats until.
      for (const e of examples) if (e.repeatUntil !== undefined) expect(e.repeatUntil, e.curl).toBe(e.expect);
      // The title, the introduction, every step's words and the closing sentences are on the page.
      const text = textOf(shown[i].html);
      for (const words of [guide.title, guide.intro, ...guide.steps.flatMap((s) => [s.text, ...(s.note === undefined ? [] : [s.note])]), ...(guide.closing ?? [])]) {
        expect(text, `${guide.id}: ${words}`).toContain(words);
      }
    }
    // No command on the page is outside a guide, but the first one.
    const all = [...docsHtml().matchAll(/<code[^>]*>(curl [^<]*)<\/code>/g)].map((m) => unescape(m[1]));
    expect(all).toEqual([GET_STARTED, ...shown.flatMap((g) => g.examples.map((e) => e.curl))]);
  });

  it("every example is a single curl command a shell can run", () => {
    const examples = [GET_STARTED, ...pageGuides().flatMap((g) => g.examples.map((e) => e.curl))];
    expect(examples.length).toBeGreaterThan(10);
    for (const curl of examples) {
      expect(curl, curl).not.toMatch(/[\n\r]/);
      // shellWords throws on a quote left open and on anything a shell would expand.
      const words = shellWords(curl);
      expect(words[0], curl).toBe("curl");
      const request = parseCurl(curl);
      // One address, the placeholder one, and under the API.
      expect(request.url.startsWith(`${GUIDE_ORIGIN}/api/v1/`), curl).toBe(true);
      expect(curl.split(GUIDE_ORIGIN).length - 1, curl).toBe(1);
      // No real token: only the placeholder, and no example leaves the header out by accident.
      expect(curl, curl).not.toMatch(/dp_[0-9a-f]/);
      if (request.headers.authorization !== undefined) expect(request.headers.authorization, curl).toBe("Bearer YOUR_TOKEN");
      // A body given as text is JSON, and says so.
      if (request.data?.kind === "text") {
        expect(request.headers["content-type"], curl).toBe("application/json");
        expect(() => JSON.parse(request.data!.kind === "text" ? request.data!.text : ""), curl).not.toThrow();
      }
    }
    // The reader of commands refuses what it does not understand.
    for (const bad of ["curl 'x", 'curl "x', "curl x | sh", "curl $(id)", "curl `id`", "curl x; id", "curl x > y", 'curl "$HOME"', "wget x", "curl a b", "curl", "curl -k x", "curl -d @f x", "curl -H nope x", "curl -X get x"]) {
      expect(() => parseCurl(bad), bad).toThrow();
    }
    expect(parseCurl(`curl -X PUT u -H "A-B: c d" --data-binary @f.png`)).toEqual({ method: "PUT", url: "u", headers: { "a-b": "c d", "content-type": "application/x-www-form-urlencoded" }, data: { kind: "file", name: "f.png" } });
    expect(parseCurl(`curl u -d '{"a":"b c"}'`)).toEqual({ method: "POST", url: "u", headers: { "content-type": "application/x-www-form-urlencoded" }, data: { kind: "text", text: '{"a":"b c"}' } });
    expect(parseCurl("curl u")).toEqual({ method: "GET", url: "u", headers: {}, data: null });
  });

  it("every word in capitals and every file an example uses is explained in its guide, and nothing else is", () => {
    for (const [i, guide] of GUIDES.entries()) {
      const shown = pageGuides()[i];
      const legend = /<p class="legend">(.*?)<\/p>/.exec(shown.html);
      expect(legend, guide.id).not.toBeNull();
      const legendText = textOf(legend![1]);
      const used = new Set(shown.examples.flatMap((e) => placeholdersOf(e.curl)));
      for (const word of used) expect(legendText, `${guide.id}: ${word} is not explained`).toContain(word);
      for (const [word, meaning] of guide.placeholders) {
        expect(used.has(word), `${guide.id}: ${word} is explained and not used`).toBe(true);
        expect(legendText, guide.id).toContain(`${word} is ${meaning}`);
      }
    }
  });

  it("every curl example in the page runs against the harness and answers what the guide says", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "Acme");
    const b = await seedWorkspace(deps, "Other");
    expect(looksLikeToken(a.token)).toBe(true);
    // Pictures that are what the example manifests say: type, width, height and length.
    const files = { "step-001.png": png(1280, 720, 48213), "step-002.png": png(1280, 720, 51022, 7), "logo.png": logoPng() };
    const world: World = {
      deps,
      files,
      vars: { YOUR_TOKEN: a.token, SHA256_OF_STEP_001: await sha256Hex(files["step-001.png"]), SHA256_OF_STEP_002: await sha256Hex(files["step-002.png"]) },
    };
    const tourPage = async () => (await send(deps, "GET", `/t/${slug}`)).status;
    let slug = "";
    const guides = pageGuides();
    const ran: string[] = [];
    /** Runs the next example of `guide` and holds it to the status the page prints. */
    const next = async (guide: PageGuide, n: number): Promise<Json> => {
      const example = guide.examples[n];
      const { answer } = await runExample(world, example);
      expect(answer.status, `${guide.id} example ${n + 1} answered ${answer.status} ${answer.text.slice(0, 200)}: ${example.curl}`).toBe(example.expect);
      ran.push(example.curl);
      return answer;
    };

    // Upload and publish a tour.
    const first = guides[0];
    expect(first.examples).toHaveLength(6);
    const started = await next(first, 0);
    expect(started.json).toEqual({ upload_id: world.vars.UPLOAD_ID, steps: 1 }); // "Note the upload_id in the answer."
    await next(first, 1);
    await next(first, 2);
    const finished = await next(first, 3);
    expect(finished.json.tour_id).toBe(world.vars.TOUR_ID); // "The answer has the tour_id."
    const tourId = world.vars.TOUR_ID;
    const published = await next(first, 4);
    // "The answer's url is the tour's link, as a path to put after your site's address."
    slug = published.json.slug;
    expect(published.json).toEqual({ slug, url: `/t/${slug}`, steps: 1 });
    expect(await tourPage()).toBe(200);
    await next(first, 5);
    expect(await tourPage()).toBe(404); // "To take the tour down again, unpublish it."

    // Update a tour over the same link. The guide is about a published tour, so it is published first.
    expect((await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token: a.token })).status).toBe(200);
    const before = (await send(deps, "GET", `/t/${slug}`)).text;
    const second = guides[1];
    expect(second.examples).toHaveLength(5);
    const replacing = await next(second, 0);
    // "the answer's have lists the steps the site already has", and the note about the first chapter.
    expect(replacing.json).toEqual({ upload_id: world.vars.UPLOAD_ID, steps: 2, have: [1], settings: true });
    await next(second, 1);
    const replaced = await next(second, 2);
    expect(replaced.json.publish).toBe("ready"); // "If it says ready, publish the tour"
    expect(replaced.json.tour_id).toBe(tourId);
    // "visitors see the old version until the publish finishes"
    expect((await send(deps, "GET", `/t/${slug}`)).text).toBe(before);
    const again = await next(second, 3);
    // "The link and the title stay the same"
    expect(again.json).toEqual({ slug, url: `/t/${slug}`, steps: 2 });
    expect((await send(deps, "GET", `/t/${slug}`)).text).not.toBe(before);
    const list = await send(deps, "GET", "/api/v1/tours", { token: a.token });
    expect(list.json.tours.map((t: Json) => [t.id, t.title, t.slug])).toEqual([[tourId, "My first tour", slug]]);
    await next(second, 4);
    // Cancelling took nothing of the tour away.
    expect(await tourPage()).toBe(200);

    // Errors and limits.
    const third = guides[2];
    expect(third.examples).toHaveLength(3);
    const noToken = await next(third, 0);
    expect(noToken.json).toEqual({ error: "unauthorized" });
    const missing = await next(third, 1);
    expect(missing.json.error).toBe("not_found");
    // "Another workspace's tour answers 404, the same as one that does not exist": the same
    // command, sent for a tour that does exist, in another workspace.
    const theirs = await uploadTour(deps, b.token, clone(fixtures.v1));
    const zeroId = "tour_" + "0".repeat(24);
    expect(third.examples[1].curl).toContain(zeroId);
    const other = await run(world, third.examples[1].curl.replace(zeroId, theirs.tour_id));
    expect(other.status).toBe(404);
    expect(other.text).toBe(missing.text);
    expect((await send(deps, "GET", "/api/v1/tours", { token: b.token })).json.tours[0].title).toBe(fixtures.v1.title);
    const refused = await next(third, 2);
    expect(refused.json.error).toBe("bad_title");
    expect(typeof refused.json.detail).toBe("string"); // "with the reason"

    // Every example on the page was sent.
    expect(ran).toEqual(guides.flatMap((g) => g.examples.map((e) => e.curl)));
  });

  it("the publish command, sent again unchanged, finishes a tour that needs several requests", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "Acme");
    const m = clone(fixtures.v1) as Json;
    const base = m.steps[0];
    m.steps = Array.from({ length: COPY_BATCH + 1 }, (_, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 120 }));
    const { tour_id } = await uploadTour(deps, a.token, m);
    const example = pageGuides()[0].examples.find((e) => e.repeatUntil !== undefined)!;
    expect(example.curl).toContain("/publish");
    const world: World = { deps, files: {}, vars: { YOUR_TOKEN: a.token, TOUR_ID: tour_id } };
    // The first request answers 202 with a publish_id, as the guide says.
    const once = await run(world, example.curl);
    expect(once.status).toBe(202);
    expect(once.json.publish_id).toMatch(/^pub_[0-9a-f]{24}$/);
    const { answer, sent } = await runExample(world, example);
    expect(answer.status).toBe(200);
    expect(sent).toBe(1);
    expect(answer.json.steps).toBe(COPY_BATCH + 1);
    // And "with that id" answers the same once it is live.
    const withId = await send(deps, "POST", `/api/v1/tours/${tour_id}/publish`, { token: a.token, body: JSON.stringify({ publish_id: once.json.publish_id }), headers: { "content-type": "application/json" } });
    expect(withId.status).toBe(200);
    expect(withId.json).toEqual(answer.json);
  });

  it("the page's first command is GET /api/v1/me and answers 200 with a token and 401 without", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "Acme");
    const shown = /<code id="first-command">([^<]*)<\/code>/.exec(docsHtml());
    expect(shown).not.toBeNull();
    const first = unescape(shown![1]);
    expect(first).toBe(GET_STARTED);
    expect(first).toBe(`curl ${GUIDE_ORIGIN}/api/v1/me -H "Authorization: Bearer YOUR_TOKEN"`);
    expect(parseCurl(first)).toEqual({ method: "GET", url: `${GUIDE_ORIGIN}/api/v1/me`, headers: { authorization: "Bearer YOUR_TOKEN" }, data: null });

    const withToken = await run({ deps, files: {}, vars: { YOUR_TOKEN: a.token } }, first);
    expect(withToken.status).toBe(200);
    // "It answers with your workspace's name and the server's version."
    expect(withToken.json).toEqual({ workspace: "Acme", version: VERSION });
    // Without the header, and with the placeholder left in.
    const bare = await run({ deps, files: {}, vars: {} }, first.replace(' -H "Authorization: Bearer YOUR_TOKEN"', ""));
    expect(bare.status).toBe(401);
    const unfilled = await send(deps, "GET", "/api/v1/me", { headers: { authorization: "Bearer YOUR_TOKEN" } });
    expect(unfilled.status).toBe(401);
  });

  it("the page says how to keep the token out of the shell's history, and a command written that way works", async () => {
    expect(HISTORY_NOTE).toBe("A token typed into a command stays in your shell's history. Put it in a variable first, with read -rs TOKEN, and write $TOKEN in place of YOUR_TOKEN.");
    // Once under "Get connected", in the step about the header, and once in every guide's legend.
    const html = docsHtml();
    const connected = /<section class="own block" id="get-connected">([\s\S]*?)<\/section>/.exec(html)![1];
    expect(textOf(connected)).toContain(`as the header Authorization: Bearer YOUR_TOKEN. ${HISTORY_NOTE}`);
    for (const guide of pageGuides()) {
      const legend = textOf(/<p class="legend">(.*?)<\/p>/.exec(guide.html)![1]);
      expect(legend.endsWith(`. ${HISTORY_NOTE}`), guide.id).toBe(true);
    }
    expect(textOf(html).split(HISTORY_NOTE).length - 1).toBe(4);
    // The examples themselves keep the placeholder.
    for (const g of GUIDES) for (const s of g.steps) if (s.example) expect(s.example.curl).not.toContain("$");

    // What the note tells the reader to type is a command the reader of commands takes, and it works.
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "Acme");
    for (const curl of [GET_STARTED, ...pageGuides().flatMap((g) => g.examples.map((e) => e.curl))]) {
      const safe = curl.split("YOUR_TOKEN").join("$TOKEN");
      // Without the variable the shell would send nothing in its place; this reader refuses instead.
      if (safe !== curl) expect(() => parseCurl(safe), safe).toThrow();
      const asTyped = parseCurl(safe, { TOKEN: a.token });
      const asPrinted = parseCurl(curl.split("YOUR_TOKEN").join(a.token));
      expect(asTyped, curl).toEqual(asPrinted);
    }
    const first = parseCurl(GET_STARTED.split("YOUR_TOKEN").join("$TOKEN").split(GUIDE_ORIGIN).join(ORIGIN), { TOKEN: a.token });
    const answer = await send(deps, first.method, first.url.slice(ORIGIN.length), { headers: first.headers });
    expect(answer.status).toBe(200);
    expect(answer.json.workspace).toBe("Acme");
    // Only a named variable inside double quotes is taken; nothing else a shell would expand.
    for (const bad of ['curl "$(id)"', 'curl "${TOKEN}"', "curl $TOKEN", "curl '$TOKEN' \"$OTHER\"", 'curl "$"']) expect(() => parseCurl(bad, { TOKEN: "x" }), bad).toThrow();
    expect(parseCurl("curl '$TOKEN'", { TOKEN: "x" }).url).toBe("$TOKEN");
  });

  it("the table of error codes is the description's codes, each with its statuses and a meaning", () => {
    const doc = openapi();
    const codes = errorCodes(doc);
    // Every code has a meaning, and no meaning is for a code the description does not have.
    expect(codes.map((c) => c.code).sort()).toEqual(Object.keys(CODE_MEANINGS).sort());
    for (const meaning of Object.values(CODE_MEANINGS)) expect(meaning.length).toBeGreaterThan(20);
    // The codes are the ones the description's requests list, found here by plain search.
    const listed = new Set<string>();
    const text = JSON.stringify(doc.paths);
    for (const m of text.matchAll(/"error":\{"type":"string","enum":\[([^\]]*)\]/g)) for (const code of JSON.parse(`[${m[1]}]`) as string[]) listed.add(code);
    expect(listed.size).toBeGreaterThan(10);
    // bad_csrf is both: any change made with a session can answer it, and the session-only routes list it too.
    expect(codes.map((c) => c.code).sort()).toEqual([...new Set([...listed, "unauthorized", ...Object.keys(ANY_REQUEST_CODES)])].sort());
    expect(codes.find((c) => c.code === "bad_csrf")?.statuses).toEqual([403]);
    // The codes any request can answer are the ones the description's introduction states, with their status (and a detail, for some).
    for (const [code, status] of Object.entries(ANY_REQUEST_CODES)) expect(doc.info.description, code).toMatch(new RegExp("`" + status + ' \\{"error":"' + code + '"(\\}`|,"detail":)'));
    expect(codes.find((c) => c.code === "unauthorized")?.statuses).toEqual([401]);
    expect(codes.find((c) => c.code === "not_found")?.statuses).toEqual([404]);
    expect(codes.find((c) => c.code === "too_many_uploads")?.statuses).toEqual([429]);
    expect(codes.find((c) => c.code === "cleanup_pending")?.statuses).toEqual([500]);

    // And the page has one row per code: its statuses, the code, the meaning.
    const html = pageGuides()[2].html;
    const rows = [...html.matchAll(/<tr><td>([^<]*)<\/td><td><code>([^<]*)<\/code><\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => [m[1], m[2], unescape(m[3])]);
    expect(rows).toEqual(codes.map((c) => [c.statuses.join(", "), c.code, CODE_MEANINGS[c.code]]));
  });

  it("the list of limits is the description's own, sentence for sentence", () => {
    const doc = openapi();
    const lines = limitLines(doc);
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) expect(doc.info.description).toContain(`- ${line}\n`);
    // Every list line under the description's "## Limits" heading is taken.
    const section = doc.info.description.split("## Limits\n")[1];
    expect(section.split("\n").filter((l) => l.startsWith("- "))).toEqual(lines.map((l) => `- ${l}`));
    const html = pageGuides()[2].html;
    const shown = /<ul class="limits">\n([\s\S]*?)\n<\/ul>/.exec(html);
    expect(shown).not.toBeNull();
    expect(shown![1].split("\n").map((li) => textOf(li))).toEqual(lines);
    // What the plan asks the list to cover.
    const text = lines.join(" ");
    for (const part of ["steps in one upload", "A step image", "The logo", "The manifest", "Text, in characters", "steps in one published tour", "open uploads per workspace", "An upload that is not finished is removed after"]) {
      expect(text, part).toContain(part);
    }
  });
});
