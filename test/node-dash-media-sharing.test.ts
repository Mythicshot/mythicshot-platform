// Who can view an image or a clip, on the Images and GIFs pages (Plan 2k, task 2): the "Who
// can view" column, "Sharing…" first in each item's More, and the tour's Sharing box
// (src/dash/sharing.ts) with an item's differences: nothing moves, too_large_to_restrict has
// its own sentence, and a line says that restricting cannot take back a copy already made. The
// pages' scripts run under Node against a stand-in document (test/node-tours-page.ts,
// openDash), first with answers from the test, then against the real app. Node only: the
// Workers runtime runs no code from a string.
//
// What this leaves unproven, for docs/dashboard-browser-check.md: the real layout at phone
// width, focus rings, a screen reader reading the box, and a real browser's radio buttons.
import { isBrandMark } from "./dash-checks.ts";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { GIFS_HTML, GIFS_JS, IMAGES_HTML, IMAGES_JS } from "../src/dash/media.ts";
import { PART_BYTES } from "../src/media.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { gif, png, send } from "./bundle.ts";
import { FakeElement } from "./pages-dom.ts";
import { APP, CSRF, FAILED, FIREFOX, TOO_MANY, type Answer, type Responder, type Tab, answers, browser, checkTabs, holding, key, openDash, session } from "./node-tours-page.ts";

afterEach(checkTabs);

type Which = "images" | "gifs";
const M1 = "med_" + "1".repeat(24);
const M2 = "med_" + "2".repeat(24);
const M3 = "med_" + "3".repeat(24);
const MAIL = "solex@example.com";
const LIST = ["bram@example.com", "mara@example.com", "rook@example.com", "tess@example.com"];

/** Each page: its document and script, its kind and the words that name its items. */
const PAGES: Record<Which, { html: string; js: string; kind: "image" | "clip"; noun: string; nouns: string; column: string; untitled: string; hint: string }> = {
  images: { html: IMAGES_HTML, js: IMAGES_JS, kind: "image", noun: "image", nouns: "images", column: "Image", untitled: "Untitled image", hint: 'Deleting an image stops its link for everyone. "More" holds: Sharing, Delete.' },
  gifs: { html: GIFS_HTML, js: GIFS_JS, kind: "clip", noun: "clip", nouns: "clips", column: "GIF", untitled: "Untitled GIF", hint: 'Deleting a GIF stops its link for everyone. "More" holds: Sharing, Delete.' },
};

/** The sentences new or adapted for items, by page: every one is pinned here. */
const said = (which: Which) => {
  const n = PAGES[which].noun;
  return {
    gate: `Opening a restricted ${n} asks you for your email address too: the dashboard's sign-in does not carry over to the ${n}'s address.`,
    hint: `You can always view your own ${PAGES[which].nouns}. People on the list are not told they were added: send them the link yourself.`,
    copies: `Restricting takes effect at once on this site, but anyone who already opened or saved the ${n} keeps their copy.`,
    kept: `This site cannot send mail, so once this ${n} is public it cannot be restricted again here.`,
    restrict: `Restrict ${n}`,
    cannotRestrict: `This site cannot send mail, so this ${n} cannot be restricted. Nothing was changed.`,
    tooLarge: `This ${n} is too large to restrict on this site. Nothing was changed.`,
    busyAgain: `The ${n} changed while this was being saved. Press Save again.`,
  };
};
// The tour's sentences an item's box shows as they are.
const NOMAIL = 'This site cannot send mail, so only "Anyone with the link" can be chosen here.';
const RESTRICT_PEOPLE = "From now on only the people you chose can open the link. The link itself stays the same.";
const RESTRICT_ME = "From now on only you can open the link. The link itself stays the same.";
const PUBLIC_TEXT = "Nobody will be asked to sign in any more. Anyone who has or gets the link can open it. Your list of people is kept in case you restrict it again.";

const listPath = (which: Which) => `/api/v1/media?kind=${PAGES[which].kind}`;
const path = (id: string) => `/api/v1/media/${id}/access`;
const item = (which: Which, id: string, over: Record<string, unknown> = {}) => ({
  id,
  link_id: "q8d2abcdefghijklmnop",
  kind: PAGES[which].kind,
  title: "Loot window",
  content_type: PAGES[which].kind === "image" ? "image/png" : "image/gif",
  bytes: 90_112,
  width: 842,
  height: 311,
  duration_ms: PAGES[which].kind === "image" ? null : 6000,
  created_at: Date.UTC(2026, 10, 19, 12),
  has_preview: false,
  path: "/i/q8d2abcdefghijklmnop",
  link: "https://img.example.com/i/q8d2abcdefghijklmnop",
  access: "public",
  viewers: 0,
  ...over,
});
/** The list of the tests: a public item, one shared with 4 people, one set to "Only me". */
const ITEMS = (which: Which) => [item(which, M1, { title: "Public one" }), item(which, M2, { title: "Shared one", access: "people", viewers: 4 }), item(which, M3, { title: "Mine", access: "me" })];
const listed = (items: unknown[]): Answer => ({ status: 200, json: { items, next: null } });
const access = (over: Record<string, unknown> = {}): Answer => ({ status: 200, json: { access: "people", viewers: LIST, limit: 200, can_restrict: true, ...over } });
const PUBLIC = access({ access: "public", viewers: [] });
const refused = (status: number, error: string, detail = "x"): Answer => ({ status, json: { error, detail } });

function standard(which: Which, extra: Record<string, Answer | Answer[]> = {}): Responder {
  return answers({ "GET /api/v1/session": session(), [`GET ${listPath(which)}`]: listed(ITEMS(which)), "GET /api/v1/usage": { status: 503, json: { error: "unavailable" } }, ...extra });
}
function openMedia(which: Which, respond: Responder): Tab {
  return openDash({ html: PAGES[which].html, js: PAGES[which].js, file: `${which}.js` }, respond, { forbid: ["URL", "Image"] });
}

const rows = (tab: Tab) => tab.$("media-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
const cells = (row: FakeElement) => row.children.filter((c): c is FakeElement => c instanceof FakeElement);
const viewCell = (row: FakeElement) => cells(row)[2];
const byText = (row: FakeElement, text: string) => {
  const found = row.all().find((e) => (e.tagName === "button" || e.tagName === "a") && e.textContent === text && e.getAttribute("role") !== "menuitem");
  if (!found) throw new Error(`no "${text}" in the row`);
  return found;
};
const menuItems = (row: FakeElement) => row.all().filter((e) => e.getAttribute("role") === "menuitem");
const entry = (row: FakeElement, text: string) => {
  const found = menuItems(row).find((m) => m.textContent === text);
  if (!found) throw new Error(`no "${text}" in the menu`);
  return found;
};
const rowButtons = (tab: Tab) => rows(tab).flatMap((row) => row.all().filter((e) => e.tagName === "button"));
async function openSharing(tab: Tab, i: number): Promise<void> {
  const row = rows(tab)[i];
  byText(row, "More").click();
  entry(row, "Sharing…").click();
  await tab.settle();
}
async function drive(tab: Tab, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await tab.settle();
    if (tab.timers() === 0) return;
    tab.tick();
  }
}
async function arm(tab: Tab): Promise<void> {
  expect(tab.tick()).toContain(600);
  await tab.settle();
}
const puts = (tab: Tab) => tab.fetched.filter((f) => f.method === "PUT");
const bodies = (tab: Tab) => puts(tab).map((f) => JSON.parse(f.body!));
const chips = (tab: Tab) => tab.$("share-chips").children.filter((c): c is FakeElement => c instanceof FakeElement);
const addresses = (tab: Tab) => chips(tab).map((c) => c.all().find((e) => e.className === "name")!.textContent);
const chipButton = (tab: Tab, address: string) => chips(tab).flatMap((c) => c.all()).find((e) => e.tagName === "button" && e.getAttribute("aria-label") === `Remove ${address}`)!;
const radios = (tab: Tab) => ["share-public", "share-people", "share-me"].map((id) => tab.$(id));
const checkedOne = (tab: Tab) => radios(tab).find((r) => r.checked)?.id ?? null;
const boxOpen = (tab: Tab) => !tab.$("share-dialog").hidden;
const boxShows = (tab: Tab) => {
  const all = tab.shows();
  const at = all.findIndex((t) => t.startsWith('Who can view "') || t.startsWith('Restrict "') || t.startsWith('Let anyone with the link view "'));
  return at < 0 ? [] : all.slice(at);
};
function type(tab: Tab, text: string): void {
  const input = tab.$("share-input");
  input.value = text;
  input.dispatch("input");
}

for (const which of ["images", "gifs"] as Which[]) {
  const P = PAGES[which];
  const S = said(which);

  describe(`the ${which} page: who can view each ${P.noun}`, () => {
    it("shows the Tours page's column and labels, the setting on a phone's details line, and Sharing… first in More, then Delete", async () => {
      const list = [
        item(which, M1, { title: "Public", access: "public", viewers: 3 }),
        item(which, M2, { title: "Four", access: "people", viewers: 4 }),
        item(which, M3, { title: "One", access: "people", viewers: 1 }),
        item(which, "med_" + "4".repeat(24), { title: "None", access: "people", viewers: 0 }),
        item(which, "med_" + "5".repeat(24), { title: "Me", access: "me", viewers: 2 }),
        item(which, "med_" + "6".repeat(24), { title: "Odd", access: "friends" }),
        item(which, "med_" + "7".repeat(24), { title: "No count", access: "people", viewers: "4" }),
      ];
      const tab = openMedia(which, standard(which, { [`GET ${listPath(which)}`]: listed(list) }));
      await tab.settle();
      expect(tab.doc.root.all().filter((e) => e.tagName === "th").map((e) => e.textContent)).toEqual(["Preview", P.column, "Who can view", "Size", "Shared", "Actions"]);
      expect(rows(tab).map((r) => [viewCell(r).className, viewCell(r).all().map((e) => [e.className, e.textContent])])).toEqual([
        ["view", [["", "Anyone with the link"]]],
        ["view", [["tag warn", "4 people"]]],
        ["view", [["tag warn", "1 person"]]],
        ["view", [["tag warn", "Nobody yet"]]],
        ["view", [["tag warn", "Only me"]]],
        ["view", [["", "—"]]],
        ["view", [["", "—"]]],
      ]);
      // On a phone the column is hidden (src/dash/style.ts) and the setting joins the details line, as on the Tours page.
      const narrow = (row: FakeElement) => row.all().find((e) => e.className === "narrow-only")!.textContent;
      expect(rows(tab).map((r) => narrow(r).split(" · ").slice(-1)[0])).toEqual(["Anyone with the link", "4 people", "1 person", "Nobody yet", "Only me", "19 Nov", "19 Nov"]);
      // Copy link, Open and More; More holds Sharing… then Delete.
      expect(rows(tab).map((r) => r.all().filter((e) => (e.tagName === "button" || e.tagName === "a") && e.shown).map((e) => e.textContent))).toEqual(Array(7).fill(["Copy link", "Open", "More"]));
      expect(rows(tab).map((r) => menuItems(r).map((m) => [m.textContent, m.className]))).toEqual(Array(7).fill([["Sharing…", ""], ["Delete", "danger"]]));
      expect(tab.$("media-gate").shown).toBe(true);
      expect(tab.$("media-gate").textContent).toBe(S.gate);
      expect(tab.$("media-hint").textContent).toBe(P.hint);
    });

    it("shows no line about restricted items when every one is public", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${listPath(which)}`]: listed([item(which, M1)]) }));
      await tab.settle();
      expect(tab.$("media-gate").shown).toBe(false);
      expect(tab.$("media-hint").shown).toBe(true);
    });
  });

  describe(`the ${which} page: the Sharing box`, () => {
    it("reads GET .../access first with the session, then opens the tour's box with the item's words", async () => {
      const held = holding((req) => req.path === path(M2), standard(which));
      const tab = openMedia(which, held.respond);
      await tab.settle();
      const row = rows(tab)[1];
      byText(row, "More").click();
      entry(row, "Sharing…").click();
      await tab.settle();
      expect(boxOpen(tab)).toBe(false);
      for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(true);
      held.answer(access());
      await tab.settle();
      expect(tab.fetched.filter((f) => f.path === path(M2)).map((f) => [f.method, f.headers["X-Csrf-Token"], f.body, f.init.credentials])).toEqual([["GET", undefined, undefined, "same-origin"]]);
      expect(boxOpen(tab)).toBe(true);
      expect(tab.$("share-box").getAttribute("role")).toBe("dialog");
      expect(boxShows(tab)).toEqual([
        'Who can view "Shared one"?',
        "Anyone with the linkNo sign-in. Fastest for viewers.",
        "Only people I chooseThey prove their email address with a link we send them.",
        `Only meYou prove your own address, ${MAIL}, the same way.`,
        "People who can view · 4 of 200",
        ...LIST.flatMap((a) => [a, "✕"]),
        "Add",
        S.hint,
        "Cancel",
        "Save",
      ]);
      expect(radios(tab).map((r) => [r.type, r.getAttribute("name"), r.checked, r.disabled])).toEqual([
        ["radio", "share-access", false, false],
        ["radio", "share-access", true, false],
        ["radio", "share-access", false, false],
      ]);
      expect(tab.doc.activeElement).toBe(tab.$("share-people"));
      for (const id of ["dash-top", "media-page"]) expect([tab.$(id).getAttribute("inert"), tab.$(id).getAttribute("aria-hidden")], id).toEqual(["", "true"]);
      // An item's box has no move: none of the tour's parts for one is in the page.
      for (const id of ["share-resume", "share-moving", "share-progress", "share-moving-text", "share-resume-buttons", "share-close", "share-restricted", "share-make-public"]) expect(tab.doc.root.all().some((e) => e.id === id), id).toBe(false);
      expect(puts(tab)).toEqual([]);
    });

    it("an untitled item is named as its row names it", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${listPath(which)}`]: listed([item(which, M1, { title: "  " })]), [`GET ${path(M1)}`]: PUBLIC }));
      await tab.settle();
      await openSharing(tab, 0);
      expect(tab.$("share-title").textContent).toBe(`Who can view "${P.untitled}"?`);
    });

    it("says that restricting takes effect at once but cannot take back a copy, while a restricted setting is chosen for a public item", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${path(M1)}`]: PUBLIC, [`GET ${path(M2)}`]: access() }));
      await tab.settle();
      await openSharing(tab, 0);
      expect(tab.$("share-copies").shown).toBe(false);
      tab.$("share-people").click();
      expect(tab.$("share-copies").shown).toBe(true);
      expect(tab.$("share-copies").textContent).toBe(S.copies);
      expect(boxShows(tab).slice(1, 5)).toEqual(["Anyone with the linkNo sign-in. Fastest for viewers.", "Only people I chooseThey prove their email address with a link we send them.", `Only meYou prove your own address, ${MAIL}, the same way.`, S.copies]);
      tab.$("share-me").click();
      expect(tab.$("share-copies").shown).toBe(true);
      tab.$("share-public").click();
      expect(tab.$("share-copies").shown).toBe(false);
      // The question before restricting says it again, with the tour's words otherwise.
      tab.$("share-me").click();
      tab.$("share-save").click();
      expect(boxShows(tab)).toEqual(['Restrict "Public one"?', RESTRICT_ME, S.copies, "Keep it public", S.restrict]);
      expect(tab.$("share-box").getAttribute("aria-describedby")).toBe("share-ask-text share-ask-warn");
      tab.$("share-keep").click();
      tab.$("share-cancel").click();
      // An item restricted already: never.
      await openSharing(tab, 1);
      for (const id of ["share-people", "share-me", "share-public"]) {
        tab.$(id).click();
        expect(tab.$("share-copies").shown, id).toBe(false);
      }
    });
  });

  describe(`the ${which} page: saving who can view`, () => {
    it("public to Only people I choose asks first, waits before its button works, sends once and shows the new setting at once", async () => {
      const after = ITEMS(which).map((t) => (t.id === M1 ? { ...t, access: "people", viewers: 1 } : t));
      const tab = openMedia(which, standard(which, { [`GET ${path(M1)}`]: PUBLIC, [`PUT ${path(M1)}`]: access({ viewers: ["ana@example.com"] }), [`GET ${listPath(which)}`]: [listed(ITEMS(which)), listed(after)] }));
      await tab.settle();
      await openSharing(tab, 0);
      tab.$("share-people").click();
      type(tab, "Ana@Example.com");
      key(tab.$("share-input"), "Enter");
      tab.$("share-save").click();
      tab.$("share-go").click();
      await tab.settle();
      expect(puts(tab)).toEqual([]);
      expect(boxShows(tab)).toEqual(['Restrict "Public one"?', RESTRICT_PEOPLE, S.copies, "Keep it public", S.restrict]);
      expect(tab.doc.activeElement).toBe(tab.$("share-keep"));
      expect([tab.$("share-go").disabled, tab.$("share-go").getAttribute("aria-disabled")]).toEqual([false, "true"]);
      await arm(tab);
      expect(tab.$("share-go").hasAttribute("aria-disabled")).toBe(false);
      tab.$("share-go").click();
      tab.$("share-go").click();
      expect(tab.$("share-go").textContent).toBe("Saving…");
      await drive(tab);
      expect(puts(tab).map((f) => [f.path, f.headers["X-Csrf-Token"], f.headers["content-type"], JSON.parse(f.body!)])).toEqual([[path(M1), CSRF, "application/json", { access: "people", viewers: ["ana@example.com"] }]]);
      // At once: no progress, no second request, no pause.
      expect(tab.timers()).toBe(0);
      expect(boxOpen(tab)).toBe(false);
      expect(viewCell(rows(tab)[0]).textContent).toBe("1 person");
      expect(tab.doc.activeElement).toBe(byText(rows(tab)[0], "More"));
      expect(tab.$("media-message").hidden).toBe(true);
    });

    it("public to Only me asks with its own sentence and sends an empty list", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${path(M1)}`]: PUBLIC, [`PUT ${path(M1)}`]: access({ access: "me", viewers: [] }) }));
      await tab.settle();
      await openSharing(tab, 0);
      tab.$("share-me").click();
      tab.$("share-save").click();
      expect(tab.$("share-ask-text").textContent).toBe(RESTRICT_ME);
      await arm(tab);
      tab.$("share-go").click();
      await drive(tab);
      expect(bodies(tab)).toEqual([{ access: "me", viewers: [] }]);
      expect(boxOpen(tab)).toBe(false);
    });

    it("between the two restricted settings, and a change of the list alone, it saves without asking", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: access(), [`PUT ${path(M2)}`]: [access({ access: "me" }), access({ viewers: LIST.slice(1) })], [`GET ${path(M3)}`]: access({ access: "me" }), [`PUT ${path(M3)}`]: access({ viewers: [...LIST, "zed@example.com"] }) }));
      await tab.settle();
      await openSharing(tab, 1);
      tab.$("share-me").click();
      tab.$("share-save").click();
      expect(tab.$("share-ask").shown).toBe(false);
      await drive(tab);
      await openSharing(tab, 1);
      chipButton(tab, "bram@example.com").click();
      tab.$("share-save").click();
      await drive(tab);
      await openSharing(tab, 2);
      tab.$("share-people").click();
      type(tab, "zed@example.com");
      tab.$("share-save").click();
      await drive(tab);
      expect(bodies(tab)).toEqual([
        { access: "me", viewers: LIST },
        { access: "people", viewers: LIST.slice(1) },
        { access: "people", viewers: [...LIST, "zed@example.com"] },
      ]);
      expect(puts(tab).map((f) => f.path)).toEqual([path(M2), path(M2), path(M3)]);
      expect(boxOpen(tab)).toBe(false);
    });

    it("restricted to public asks with the tour's words, keeps the list, and Keep it restricted sends nothing", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: access(), [`PUT ${path(M2)}`]: access({ access: "public" }) }));
      await tab.settle();
      await openSharing(tab, 1);
      tab.$("share-public").click();
      tab.$("share-save").click();
      expect(boxShows(tab)).toEqual(['Let anyone with the link view "Shared one"?', PUBLIC_TEXT, "Keep it restricted", "Make public"]);
      tab.$("share-keep").click();
      expect(tab.doc.activeElement).toBe(tab.$("share-save"));
      expect(puts(tab)).toEqual([]);
      tab.$("share-save").click();
      await arm(tab);
      tab.$("share-go").click();
      await drive(tab);
      expect(bodies(tab)).toEqual([{ access: "public", viewers: LIST }]);
    });

    it("a 202 is no move: the box shows no progress, sends nothing again, and says the change did not happen", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: access(), [`PUT ${path(M2)}`]: { status: 202, json: { status: "switching", done: 1, total: 3 } } }));
      await tab.settle();
      await openSharing(tab, 1);
      tab.$("share-me").click();
      tab.$("share-save").click();
      await drive(tab);
      expect(puts(tab)).toHaveLength(1);
      expect(tab.$("share-message").textContent).toBe(FAILED);
      expect(tab.$("share-form").shown).toBe(true);
      expect(tab.shows().join(" ")).not.toMatch(/Moving|pictures/);
    });
  });

  describe(`the ${which} page: the list of addresses`, () => {
    it("adds several at once, refuses an entry not shaped like an address, stops at the limit, and removes with the focus on the next chip", async () => {
      const full = Array.from({ length: 200 }, (_, i) => `p${i}@example.com`);
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: [access(), access({ viewers: full }), access({ viewers: full.slice(0, 198) })] }));
      await tab.settle();
      await openSharing(tab, 1);
      type(tab, "  Ana@Example.com, bo@example.com;\ncy@example.org\tMARA@example.com  ana@example.com,,");
      tab.$("share-add").click();
      expect(addresses(tab)).toEqual([...LIST, "ana@example.com", "bo@example.com", "cy@example.org"]);
      expect(tab.$("share-count").textContent).toBe("People who can view · 7 of 200");
      type(tab, "new@example.com, mara@nowhere");
      tab.$("share-add").click();
      expect(tab.$("share-add-message").textContent).toBe('"mara@nowhere" does not look like an email address. Nothing was added.');
      expect(tab.$("share-input").getAttribute("aria-invalid")).toBe("true");
      expect(addresses(tab)).toHaveLength(7);
      chipButton(tab, "bram@example.com").click();
      expect(tab.doc.activeElement).toBe(chipButton(tab, "mara@example.com"));
      tab.$("share-cancel").click();
      await openSharing(tab, 1);
      type(tab, "one.more@example.com");
      tab.$("share-add").click();
      expect(tab.$("share-add-message").textContent).toBe("The list is full at 200 people. Remove someone first.");
      tab.$("share-cancel").click();
      await openSharing(tab, 1);
      type(tab, "a@example.com b@example.com c@example.com");
      tab.$("share-add").click();
      expect(tab.$("share-add-message").textContent).toBe("That would make 201 people, and the list holds 200. Nothing was added.");
      expect(addresses(tab)).toHaveLength(198);
      expect(puts(tab)).toEqual([]);
    });

    it("the last chip removed leaves the focus on the field; an address typed and not added is added on Save", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: access({ viewers: ["a@example.com"] }), [`PUT ${path(M2)}`]: access({ viewers: ["zed@example.com"] }) }));
      await tab.settle();
      await openSharing(tab, 1);
      chipButton(tab, "a@example.com").click();
      expect(tab.doc.activeElement).toBe(tab.$("share-input"));
      type(tab, "Zed@example.com");
      tab.$("share-save").click();
      await drive(tab);
      expect(bodies(tab)).toEqual([{ access: "people", viewers: ["zed@example.com"] }]);
    });
  });

  describe(`the ${which} page: refusals`, () => {
    it("stops at once on each refusal with its sentence, keeps the choice, and shows the item as the API now gives it", async () => {
      const cases: [Answer, string][] = [
        [refused(409, "cannot_restrict"), S.cannotRestrict],
        [refused(409, "too_large_to_restrict"), S.tooLarge],
        [refused(409, "access_busy"), S.busyAgain],
        [refused(400, "too_many_viewers"), "The list holds at most 200 people. Remove some and press Save again."],
        [refused(400, "bad_viewer", "viewers[9] is not an email address; nothing was changed"), FAILED],
        [refused(400, "bad_access"), FAILED],
        [refused(400, "bad_request"), FAILED],
        [refused(413, "too_large"), FAILED],
        [refused(500, "internal"), FAILED],
        [refused(429, "rate_limited"), TOO_MANY],
      ];
      for (const [answer, text] of cases) {
        const what = JSON.stringify(answer);
        const after = ITEMS(which).map((t) => (t.id === M1 ? { ...t, access: "people", viewers: 0 } : t));
        const tab = openMedia(which, standard(which, { [`GET ${path(M1)}`]: [PUBLIC, PUBLIC, access({ viewers: [] })], [`PUT ${path(M1)}`]: answer, [`GET ${listPath(which)}`]: [listed(ITEMS(which)), listed(after)] }));
        await tab.settle();
        await openSharing(tab, 0);
        tab.$("share-me").click();
        tab.$("share-save").click();
        await arm(tab);
        tab.$("share-go").click();
        await drive(tab);
        expect(puts(tab), what).toHaveLength(1);
        expect(boxOpen(tab), what).toBe(true);
        expect(tab.$("share-message").textContent, what).toBe(text);
        expect(tab.$("share-form").shown, what).toBe(true);
        expect(checkedOne(tab), what).toBe("share-me");
        expect(tab.doc.activeElement, what).toBe(tab.$("share-save"));
        // Read on opening, before sending and after: the box and the row show what the API reports.
        expect(tab.fetched.filter((f) => f.path === path(M1) && f.method === "GET"), what).toHaveLength(3);
        expect(viewCell(rows(tab)[0]).textContent, what).toBe("Nobody yet");
        expect(tab.timers(), what).toBe(0);
      }
    });

    it("bad_viewer names the entry the server's position points at, from the page's own list, as text", async () => {
      const hostile = '<b onclick="x">"q"</b>‮@example.com';
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: access({ viewers: ["a@example.com", hostile] }), [`PUT ${path(M2)}`]: refused(400, "bad_viewer", "viewers[1] is not an email address; nothing was changed") }));
      await tab.settle();
      await openSharing(tab, 1);
      tab.$("share-me").click();
      tab.$("share-save").click();
      await drive(tab);
      expect(tab.$("share-message").children.map((c) => [(c as FakeElement).className, (c as FakeElement).textContent])).toEqual([
        ["", '"'],
        ["name", hostile],
        ["", '" is not accepted as an email address. Remove it and press Save again.'],
      ]);
      expect(tab.doc.root.all().some((e) => e.tagName === "b")).toBe(false);
    });

    it("an item deleted meanwhile: the box closes and the list read again no longer has it", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: [access(), refused(404, "not_found")], [`GET ${listPath(which)}`]: [listed(ITEMS(which)), listed(ITEMS(which).filter((t) => t.id !== M2))] }));
      await tab.settle();
      await openSharing(tab, 1);
      tab.$("share-me").click();
      tab.$("share-save").click();
      await drive(tab);
      expect(puts(tab)).toEqual([]);
      expect(boxOpen(tab)).toBe(false);
      expect(rows(tab)).toHaveLength(2);
      expect(tab.doc.activeElement).toBe(tab.$("h-page"));
    });

    it("when who can view cannot be read, the page says so, reads the list again and gives every button back", async () => {
      for (const [answer, text] of [
        [refused(500, "internal"), FAILED],
        [refused(429, "rate_limited"), TOO_MANY],
        ["network", FAILED],
        [{ status: 200, json: { access: "friends", viewers: [], can_restrict: true } }, FAILED],
      ] as [Answer, string][]) {
        const what = JSON.stringify(answer);
        const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: answer }));
        await tab.settle();
        await openSharing(tab, 1);
        expect(boxOpen(tab), what).toBe(false);
        expect(tab.$("media-message").textContent, what).toBe(text);
        expect(tab.fetched.filter((f) => f.path === listPath(which)), what).toHaveLength(2);
        for (const b of rowButtons(tab)) expect(b.disabled, `${what} ${b.textContent}`).toBe(false);
        expect(tab.doc.activeElement, what).toBe(byText(rows(tab)[1], "More"));
      }
      const out = openMedia(which, standard(which, { [`GET ${path(M2)}`]: { status: 401, json: { error: "unauthorized" } } }));
      await out.settle();
      await openSharing(out, 1);
      expect(out.left()).toBe("/signin");
    });
  });

  describe(`the ${which} page: a site that cannot send mail`, () => {
    it("offers only Anyone with the link for a public item, and a forced choice is put back", async () => {
      const off = access({ access: "public", viewers: ["kept@example.com"], can_restrict: false });
      const tab = openMedia(which, standard(which, { [`GET ${path(M1)}`]: off, [`PUT ${path(M1)}`]: off }));
      await tab.settle();
      await openSharing(tab, 0);
      expect(radios(tab).map((r) => [r.id, r.checked, r.disabled])).toEqual([
        ["share-public", true, false],
        ["share-people", false, true],
        ["share-me", false, true],
      ]);
      expect([tab.$("share-nomail").shown, tab.$("share-nomail").textContent]).toEqual([true, NOMAIL]);
      expect([tab.$("share-nomail-kept").shown, tab.$("share-copies").shown]).toEqual([false, false]);
      expect(tab.$("share-people").click()).toBeNull();
      tab.$("share-me").checked = true;
      tab.$("share-me").dispatch("change");
      expect(checkedOne(tab)).toBe("share-public");
      expect(tab.$("share-copies").shown).toBe(false);
      tab.$("share-public").focus();
      key(tab.doc.body, "Tab");
      key(tab.doc.body, "Tab");
      key(tab.doc.body, "Tab");
      expect(tab.doc.activeElement).toBe(tab.$("share-public"));
      tab.$("share-save").click();
      await drive(tab);
      expect(bodies(tab)).toEqual([{ access: "public", viewers: ["kept@example.com"] }]);
    });

    it("a restricted item keeps its setting, may move between the restricted two, and is warned before it is made public", async () => {
      const off = access({ can_restrict: false });
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: off, [`PUT ${path(M2)}`]: [access({ access: "me", can_restrict: false }), access({ access: "public", can_restrict: false })] }));
      await tab.settle();
      await openSharing(tab, 1);
      expect(radios(tab).map((r) => r.disabled)).toEqual([false, false, false]);
      expect([tab.$("share-nomail").shown, tab.$("share-nomail-kept").shown, tab.$("share-nomail-kept").textContent]).toEqual([false, true, S.kept]);
      tab.$("share-me").click();
      tab.$("share-save").click();
      await drive(tab);
      await openSharing(tab, 1);
      tab.$("share-public").click();
      tab.$("share-save").click();
      expect(boxShows(tab)).toEqual(['Let anyone with the link view "Shared one"?', PUBLIC_TEXT, S.kept, "Keep it restricted", "Make public"]);
      expect(tab.$("share-box").getAttribute("aria-describedby")).toBe("share-ask-text share-nomail-kept");
      await arm(tab);
      tab.$("share-go").click();
      await drive(tab);
      expect(bodies(tab)).toEqual([
        { access: "me", viewers: LIST },
        { access: "public", viewers: LIST },
      ]);
    });
  });

  describe(`the ${which} page: changed elsewhere`, () => {
    it("re-reads before sending: a setting or a list changed elsewhere sends nothing, shows the item as it is now and says to press Save again", async () => {
      const setting = openMedia(which, standard(which, { [`GET ${path(M2)}`]: [access(), access({ access: "me" })] }));
      await setting.settle();
      await openSharing(setting, 1);
      chipButton(setting, "bram@example.com").click();
      setting.$("share-save").click();
      await drive(setting);
      expect(puts(setting)).toEqual([]);
      expect(setting.$("share-message").textContent).toBe(S.busyAgain);
      expect([checkedOne(setting), addresses(setting)]).toEqual(["share-people", LIST.slice(1)]);
      expect(setting.doc.activeElement).toBe(setting.$("share-save"));

      const list = openMedia(which, standard(which, { [`GET ${path(M2)}`]: [access({ viewers: ["alice@example.com", "bob@example.com"] }), access({ viewers: ["alice@example.com"] })], [`PUT ${path(M2)}`]: access({ viewers: ["alice@example.com", "carol@example.com"] }) }));
      await list.settle();
      await openSharing(list, 1);
      type(list, "carol@example.com");
      list.$("share-add").click();
      list.$("share-save").click();
      await drive(list);
      expect(puts(list)).toEqual([]);
      expect(list.$("share-message").textContent).toBe(S.busyAgain);
      expect(addresses(list)).toEqual(["alice@example.com"]);
      // Saved again, it sends the site's list as now shown, with what is added then.
      type(list, "carol@example.com");
      list.$("share-add").click();
      list.$("share-save").click();
      await drive(list);
      expect(bodies(list)).toEqual([{ access: "people", viewers: ["alice@example.com", "carol@example.com"] }]);

      const mail = openMedia(which, standard(which, { [`GET ${path(M2)}`]: [access(), access({ can_restrict: false })] }));
      await mail.settle();
      await openSharing(mail, 1);
      mail.$("share-me").click();
      mail.$("share-save").click();
      await drive(mail);
      expect(puts(mail)).toEqual([]);
      expect(mail.$("share-message").textContent).toBe(S.busyAgain);

      const unread = openMedia(which, standard(which, { [`GET ${path(M2)}`]: [access(), "network"] }));
      await unread.settle();
      await openSharing(unread, 1);
      unread.$("share-me").click();
      unread.$("share-save").click();
      await drive(unread);
      expect(puts(unread)).toEqual([]);
      expect(unread.$("share-message").textContent).toBe(FAILED);
      expect(checkedOne(unread)).toBe("share-me");
    });

    it("a lost answer is sent again at most three times, then the setting read again decides", async () => {
      const won = openMedia(which, standard(which, { [`GET ${path(M2)}`]: [access(), access(), access({ access: "me" })], [`PUT ${path(M2)}`]: ["network", "network", "network"] }));
      await won.settle();
      await openSharing(won, 1);
      won.$("share-me").click();
      won.$("share-save").click();
      await won.settle();
      expect(won.tick()).toEqual([1000]);
      await won.settle();
      expect(won.tick()).toEqual([3000]);
      await drive(won);
      expect(puts(won)).toHaveLength(3);
      expect(new Set(puts(won).map((f) => f.body)).size).toBe(1);
      expect(boxOpen(won)).toBe(false);

      const lost = openMedia(which, standard(which, { [`GET ${path(M2)}`]: access(), [`PUT ${path(M2)}`]: "network" }));
      await lost.settle();
      await openSharing(lost, 1);
      lost.$("share-me").click();
      lost.$("share-save").click();
      await drive(lost);
      expect(puts(lost)).toHaveLength(3);
      expect(boxOpen(lost)).toBe(true);
      expect(lost.$("share-message").textContent).toBe(FAILED);
      expect(checkedOne(lost)).toBe("share-me");
    });
  });

  describe(`the ${which} page: keyboard and focus`, () => {
    it("More opens with the arrow keys on Sharing… or Delete; Tab goes round the box as on the Tours page; Cancel, Escape and the backdrop give the focus back to More", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: access({ viewers: ["a@example.com", "b@example.com"] }) }));
      await tab.settle();
      const more = byText(rows(tab)[1], "More");
      expect([more.getAttribute("aria-haspopup"), more.getAttribute("aria-expanded"), more.getAttribute("aria-describedby")]).toEqual(["true", "false", "item-1"]);
      key(more, "ArrowDown");
      expect(tab.doc.activeElement).toBe(entry(rows(tab)[1], "Sharing…"));
      expect(more.getAttribute("aria-expanded")).toBe("true");
      key(tab.doc.activeElement!, "ArrowDown");
      expect(tab.doc.activeElement).toBe(entry(rows(tab)[1], "Delete"));
      key(tab.doc.activeElement!, "Escape");
      expect(tab.doc.activeElement).toBe(more);
      key(more, "ArrowUp");
      expect(tab.doc.activeElement).toBe(entry(rows(tab)[1], "Delete"));
      key(tab.doc.activeElement!, "Home");
      (tab.doc.activeElement as FakeElement).click();
      await tab.settle();
      expect(boxOpen(tab)).toBe(true);
      const round = () => {
        const seen: string[] = [];
        for (let i = 0; i < 8; i++) {
          key(tab.doc.body, "Tab");
          const a = tab.doc.activeElement!;
          seen.push(a.id || a.getAttribute("aria-label")!);
        }
        return seen;
      };
      expect(round()).toEqual(["Remove a@example.com", "Remove b@example.com", "share-input", "share-add", "share-cancel", "share-save", "share-people", "Remove a@example.com"]);
      tab.$("share-public").click();
      tab.$("share-public").focus();
      expect(round().slice(0, 3)).toEqual(["share-cancel", "share-save", "share-public"]);
      for (const close of [() => tab.$("share-cancel").click(), () => key(tab.doc.body, "Escape"), () => tab.$("share-dialog").click()]) {
        if (!boxOpen(tab)) await openSharing(tab, 1);
        close();
        expect(boxOpen(tab)).toBe(false);
        expect(tab.doc.activeElement).toBe(byText(rows(tab)[1], "More"));
        for (const id of ["dash-top", "media-page"]) expect(tab.$(id).hasAttribute("inert"), id).toBe(false);
      }
      expect(puts(tab)).toEqual([]);
    });

    it("one box at a time: while the box is open, nothing behind it starts, and Delete still asks from More when it is closed", async () => {
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: access() }));
      await tab.settle();
      await openSharing(tab, 1);
      entry(rows(tab)[0], "Sharing…").click();
      entry(rows(tab)[1], "Delete").click();
      await tab.settle();
      expect(tab.$("delete-dialog").hidden).toBe(true);
      expect(tab.fetched.filter((f) => f.path.endsWith("/access"))).toHaveLength(1);
      tab.$("share-cancel").click();
      byText(rows(tab)[1], "More").click();
      entry(rows(tab)[1], "Delete").click();
      expect(tab.$("delete-dialog").hidden).toBe(false);
      expect(tab.$("delete-title").textContent).toBe('Delete "Shared one"?');
      tab.$("delete-keep").click();
      expect(tab.doc.activeElement).toBe(byText(rows(tab)[1], "More"));
    });
  });

  describe(`the ${which} page: the house rules`, () => {
    it("uses the session only, sends the change to the item whose box is open, and never puts an address in a path", async () => {
      const reordered = [{ ...ITEMS(which)[1], title: "Renamed" }, ITEMS(which)[2]];
      const tab = openMedia(which, standard(which, { [`GET ${path(M2)}`]: access(), [`PUT ${path(M2)}`]: [refused(409, "access_busy"), access({ access: "me" })], [`GET ${listPath(which)}`]: [listed(ITEMS(which)), listed(reordered)] }));
      await tab.settle();
      await openSharing(tab, 1);
      tab.$("share-me").click();
      tab.$("share-save").click();
      await drive(tab);
      expect(rows(tab).map((r) => r.all().find((e) => e.className === "t")!.textContent)).toEqual(["Renamed", "Mine"]);
      tab.$("share-save").click();
      await drive(tab);
      expect(puts(tab).map((f) => f.path)).toEqual([path(M2), path(M2)]);
      expect(tab.fetched.some((f) => f.path.includes(M1) && f.method !== "GET")).toBe(false);
      expect(tab.doc.activeElement).toBe(byText(rows(tab)[0], "More"));
      for (const f of tab.fetched) {
        // No token and no other credential: the browser's session for this address, and the anti-forgery header on a change.
        expect(Object.keys(f.headers).map((h) => h.toLowerCase()), f.path).not.toContain("authorization");
        expect([f.init.credentials, f.init.referrerPolicy], f.path).toEqual(["same-origin", "no-referrer"]);
        expect(f.headers["X-Csrf-Token"], f.path).toBe(f.method === "GET" ? undefined : CSRF);
        for (const a of LIST) expect(f.path, f.path).not.toContain(a.split("@")[0]);
      }
    });

    it("shows hostile titles and addresses as text", async () => {
      const title = '<img src=x onerror="alert(1)">‮"quoted" & ' + "long ".repeat(80);
      const list = ["<script>x</script>@example.com", "‮evil@example.com", "a".repeat(240) + "@example.com"];
      const tab = openMedia(which, standard(which, { [`GET ${listPath(which)}`]: listed([item(which, M1, { title, access: "people", viewers: 3 })]), [`GET ${path(M1)}`]: access({ viewers: list }) }));
      await tab.settle();
      await openSharing(tab, 0);
      expect(tab.$("share-title").children.map((c) => [(c as FakeElement).className, (c as FakeElement).textContent])).toEqual([
        ["", 'Who can view "'],
        ["name", title],
        ["", '"?'],
      ]);
      expect(addresses(tab)).toEqual(list);
      expect(tab.doc.body.all().some((e) => (e.tagName === "img" && !isBrandMark(e)) || e.tagName === "script")).toBe(false);
    });
  });
}

// ---- Against the real app ----

describe("who can view an image or a clip, against the real app", () => {
  const HOSTS = { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" };
  async function signIn(deps: Deps, username: string) {
    const account = await seedAccount(deps, { username });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, account.userId), FIREFOX, null);
    return { ...account, cookie: `${SESSION_COOKIE}=${made!.secret}` };
  }
  async function share(deps: Deps, token: string, kind: "image" | "clip"): Promise<string> {
    const file = kind === "image" ? png(64, 48, 4000) : gif(64, 48, 4000);
    expect(file.length).toBeLessThanOrEqual(PART_BYTES);
    const made = await send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify({ kind, content_type: kind === "image" ? "image/png" : "image/gif", bytes: file.length, width: 64, height: 48, ...(kind === "clip" ? { duration_ms: 2000 } : {}), title: `A ${kind}` }), headers: { "content-type": "application/json" } });
    expect(made.status, made.text).toBe(201);
    const id = made.json.id as string;
    expect((await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { token, body: file as NonNullable<RequestInit["body"]> })).status).toBe(204);
    expect((await send(deps, "POST", `/api/v1/media/${id}/commit`, { token })).status).toBe(200);
    return id;
  }

  for (const which of ["images", "gifs"] as Which[]) {
    it(`${which}: restricts an item to two people and makes it public again through the page; a token reads the count only, cannot change it, and no route a token can call gives an address`, async () => {
      const { deps } = await makeDeps({ hosts: HOSTS });
      await seedAccount(deps, { admin: true, username: "itemshare-admin" });
      const owner = await signIn(deps, "itemshare");
      const id = await share(deps, owner.token, PAGES[which].kind);
      const tab = openMedia(which, browser(deps, owner.cookie));
      await tab.settle();
      expect(viewCell(rows(tab)[0]).textContent).toBe("Anyone with the link");
      await openSharing(tab, 0);
      expect(boxOpen(tab)).toBe(true);
      expect(tab.$("share-me-text").textContent).toBe(`You prove your own address, ${owner.email}, the same way.`);
      tab.$("share-people").click();
      expect(tab.$("share-copies").shown).toBe(true);
      type(tab, "Ana@Example.com; bo@example.com");
      tab.$("share-add").click();
      tab.$("share-save").click();
      await arm(tab);
      tab.$("share-go").click();
      await drive(tab, 200);
      expect(boxOpen(tab)).toBe(false);
      expect(tab.$("media-message").hidden).toBe(true);
      expect(viewCell(rows(tab)[0]).textContent).toBe("2 people");
      expect(tab.$("media-gate").shown).toBe(true);
      // A token gets the count, never the addresses, from every route it may call about the item.
      const byToken = [
        await send(deps, "GET", `/api/v1/media/${id}/access`, { token: owner.token }),
        await send(deps, "GET", `/api/v1/media/${id}`, { token: owner.token }),
        await send(deps, "GET", listPath(which), { token: owner.token }),
      ];
      expect(byToken[0].json).toEqual({ access: "people", viewers_count: 2, limit: 200, can_restrict: true });
      expect(byToken[1].json).toMatchObject({ access: "people", viewers: 2 });
      for (const r of byToken) {
        expect(r.status).toBe(200);
        for (const a of ["ana@example.com", "bo@example.com"]) expect(r.text).not.toContain(a);
      }
      // A token cannot make it public: only the session can, and the page has no other credential.
      const put = await send(deps, "PUT", `/api/v1/media/${id}/access`, { origin: APP, token: owner.token, body: JSON.stringify({ access: "public" }), headers: { "content-type": "application/json" } });
      expect(put.status).toBe(401);
      // Back to public through the page, with the list kept.
      await openSharing(tab, 0);
      expect(tab.$("share-copies").shown).toBe(false);
      expect(tab.$("share-people").checked).toBe(true);
      tab.$("share-public").click();
      tab.$("share-save").click();
      await arm(tab);
      tab.$("share-go").click();
      await drive(tab, 200);
      expect(boxOpen(tab)).toBe(false);
      expect(viewCell(rows(tab)[0]).textContent).toBe("Anyone with the link");
      expect((await send(deps, "GET", `/api/v1/media/${id}/access`, { token: owner.token })).json).toEqual({ access: "public", viewers_count: 2, limit: 200, can_restrict: true });
      // No request of the page carried a token.
      for (const f of tab.fetched) expect(Object.keys(f.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    });
  }

  it("another workspace's session never sees the item nor changes it", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    await seedAccount(deps, { admin: true, username: "itemshare2-admin" });
    const owner = await signIn(deps, "itemshare2");
    const other = await signIn(deps, "itemshare2-other");
    const id = await share(deps, owner.token, "image");
    const tab = openMedia("images", browser(deps, other.cookie));
    await tab.settle();
    expect(rows(tab)).toEqual([]);
    expect(tab.$("media-empty").shown).toBe(true);
    // Its session, sent straight to the item's access as the page would send it: not found, and nothing changed.
    const real = browser(deps, other.cookie);
    const sessionRes = await send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: other.cookie, "user-agent": FIREFOX } });
    const csrf = sessionRes.json.csrf as string;
    expect(await real({ method: "GET", path: path(id), headers: {}, body: undefined, init: {} })).toMatchObject({ status: 404 });
    expect(await real({ method: "PUT", path: path(id), headers: { "content-type": "application/json", "X-Csrf-Token": csrf }, body: JSON.stringify({ access: "me" }), init: {} })).toMatchObject({ status: 404 });
    expect((await send(deps, "GET", `/api/v1/media/${id}/access`, { token: owner.token })).json).toMatchObject({ access: "public" });
  });

  it("on a site without mail, the restricted options cannot be chosen and nothing restricted is sent", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS }, { mail: false });
    await seedAccount(deps, { admin: true, username: "itemshare3-admin" });
    const owner = await signIn(deps, "itemshare3");
    const id = await share(deps, owner.token, "clip");
    const tab = openMedia("gifs", browser(deps, owner.cookie));
    await tab.settle();
    await openSharing(tab, 0);
    expect(radios(tab).map((r) => r.disabled)).toEqual([false, true, true]);
    expect(tab.$("share-nomail").shown).toBe(true);
    tab.$("share-save").click();
    await drive(tab);
    expect(boxOpen(tab)).toBe(false);
    expect((await send(deps, "GET", `/api/v1/media/${id}/access`, { token: owner.token })).json).toMatchObject({ access: "public", can_restrict: false });
  });
});
