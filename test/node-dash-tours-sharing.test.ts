// Who can view a tour, on the Tours page (Plan 2h, task 4; the restricted tours set's mockups
// 1 to 3): the "Who can view" column, "Sharing…" in More, the Sharing box with its options,
// its list of addresses and its field, the question before a change between public and
// restricted, the move's progress and how it ends, a move that stopped, and the refusals. The
// page's scripts run under Node against a stand-in document (test/node-tours-page.ts), first
// with answers from the test, then against the real app. Node only: the Workers runtime runs
// no code from a string.
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { fixtures, send, uploadTour, type Json } from "./bundle.ts";
import { FakeElement } from "./pages-dom.ts";
import {
  APP,
  CSRF,
  FAILED,
  FIREFOX,
  MOCKUP_TOURS,
  T1,
  T2,
  T3,
  TOO_MANY,
  type Answer,
  type Tab,
  browser,
  byText,
  checkTabs,
  holding,
  key,
  menuItems,
  menuOf,
  openTours,
  rowButtons,
  rows,
  standard,
  tour,
  toursAnswer,
} from "./node-tours-page.ts";

afterEach(checkTabs);

const LIST = ["bram@example.com", "mara@example.com", "rook@example.com", "tess@example.com"];
/** GET .../access as the API answers it: by default the tour of mockup 2, shared with 4 people. */
const access = (over: Record<string, unknown> = {}): Answer => ({ status: 200, json: { access: "people", viewers: LIST, limit: 200, can_restrict: true, switching: null, ...over } });
const PUBLIC = access({ access: "public", viewers: [] });
const moving = (done: number, total: number): Answer => ({ status: 202, json: { status: "switching", done, total } });
const refused = (status: number, error: string, detail = "x"): Answer => ({ status, json: { error, detail } });
const path = (id: string) => `/api/v1/tours/${id}/access`;
const MAIL = "solex@example.com";

const entry = (row: FakeElement, text: string) => {
  const found = menuItems(row).find((m) => m.textContent === text);
  if (!found) throw new Error(`no "${text}" in the menu`);
  return found;
};
/** Opens the Sharing box of the i-th row and waits for its answer. */
async function openSharing(tab: Tab, i: number): Promise<void> {
  const row = rows(tab)[i];
  byText(row, "More").click();
  entry(row, "Sharing…").click();
  await tab.settle();
}
/** Lets every request and pause run until nothing is waiting. */
async function drive(tab: Tab, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await tab.settle();
    if (tab.timers() === 0) return;
    tab.tick();
  }
}
/** Lets the pause before the warning's button works pass, and the button work. */
async function arm(tab: Tab): Promise<void> {
  expect(tab.tick()).toContain(600);
  await tab.settle();
}
const puts = (tab: Tab) => tab.fetched.filter((f) => f.method === "PUT");
const sent = (tab: Tab) => puts(tab).map((f) => [f.path, f.headers["X-Csrf-Token"], f.headers["content-type"], f.body === undefined ? undefined : JSON.parse(f.body)]);
const chips = (tab: Tab) => tab.$("share-chips").children.filter((c): c is FakeElement => c instanceof FakeElement);
const chipButton = (tab: Tab, address: string) => {
  const b = chips(tab).flatMap((c) => c.all()).find((e) => e.tagName === "button" && e.getAttribute("aria-label") === `Remove ${address}`);
  if (!b) throw new Error(`no chip for ${address}`);
  return b;
};
const radios = (tab: Tab) => ["share-public", "share-people", "share-me"].map((id) => tab.$(id));
const checkedOne = (tab: Tab) => radios(tab).find((r) => r.checked)?.id ?? null;
const addresses = (tab: Tab) => chips(tab).map((c) => c.all().find((e) => e.className === "name")!.textContent);
const boxOpen = (tab: Tab) => !tab.$("share-dialog").hidden;
/** What the box shows now, block by block. */
const boxShows = (tab: Tab) => {
  const all = tab.shows();
  const at = all.findIndex((t) => t.startsWith("Who can view \"") || t.startsWith("Restrict \"") || t.startsWith("Let anyone with the link view \""));
  return at < 0 ? [] : all.slice(at);
};
/** Types into the address field, as a person does. */
function type(tab: Tab, text: string): void {
  const input = tab.$("share-input");
  input.value = text;
  input.dispatch("input");
}

describe("the Tours list shows who can view each tour", () => {
  it("as mockup 1: plain text for a public tour, an amber tag for a restricted one, and a dash for a tour that is not published", async () => {
    const list = [
      tour(T1, { title: "Public", access: "public", viewers: 3 }),
      tour(T2, { title: "Four", access: "people", viewers: 4 }),
      tour(T3, { title: "One", access: "people", viewers: 1 }),
      tour("tour_" + "4".repeat(24), { title: "None", access: "people", viewers: 0 }),
      tour("tour_" + "5".repeat(24), { title: "Me", access: "me", viewers: 2 }),
      tour("tour_" + "6".repeat(24), { title: "Draft", status: "draft", url: null, access: "me" }),
      tour("tour_" + "7".repeat(24), { title: "Odd", access: "friends" }),
      tour("tour_" + "8".repeat(24), { title: "No count", access: "people", viewers: "4" }),
    ];
    const tab = openTours(standard({ "GET /api/v1/tours": toursAnswer(list) }));
    await tab.settle();
    const header = tab.doc.root.all().filter((e) => e.tagName === "th").map((e) => e.textContent);
    expect(header).toEqual(["Tour", "Status", "Who can view", "Size", "Changed", "Actions"]);
    const cell = (row: FakeElement) => row.children.filter((c): c is FakeElement => c instanceof FakeElement)[2];
    expect(rows(tab).map((r) => [cell(r).className, cell(r).all().map((e) => [e.className, e.textContent])])).toEqual([
      ["view", [["", "Anyone with the link"]]],
      ["view", [["tag warn", "4 people"]]],
      ["view", [["tag warn", "1 person"]]],
      ["view", [["tag warn", "Nobody yet"]]],
      ["view", [["tag warn", "Only me"]]],
      ["view", [["", "—"]]],
      ["view", [["", "—"]]],
      ["view", [["", "—"]]],
    ]);
    // On a phone the setting joins the details line; a tour without one adds nothing.
    const narrow = (row: FakeElement) => row.all().find((e) => e.className === "narrow-only")!.textContent;
    expect(rows(tab).map((r) => narrow(r).split(" · ").slice(3).join(" · "))).toEqual(["Anyone with the link", "4 people", "1 person", "Nobody yet", "Only me", "", "", ""]);
    // Sharing… heads the More menu of a published tour only.
    expect(rows(tab).map((r) => menuItems(r)[0].textContent)).toEqual(["Sharing…", "Sharing…", "Sharing…", "Sharing…", "Sharing…", "Delete", "Sharing…", "Sharing…"]);
    // The line about opening a restricted tour shows because one is published.
    expect(tab.$("tours-gate").shown).toBe(true);
    expect(tab.$("tours-gate").textContent).toBe("Opening a restricted tour asks you for your email address too: the dashboard's sign-in does not carry over to the tour's address.");
    expect(tab.$("tours-hint").textContent).toBe('"Changes waiting" means Mythicshot uploaded a newer version that visitors do not see yet. "More" holds: Sharing, Publish changes, Unpublish, Delete.');
    // Open on a restricted tour is its link, as for any tour.
    expect(byText(rows(tab)[1], "Open").getAttribute("href")).toBe(`${APP}/t/k3f9abcdef`);
  });

  it("shows no line about restricted tours when none is published restricted", async () => {
    const list = [tour(T1, { access: "public" }), tour(T3, { status: "draft", url: null, access: "people", viewers: 2 })];
    const tab = openTours(standard({ "GET /api/v1/tours": toursAnswer(list) }));
    await tab.settle();
    expect(tab.$("tours-gate").shown).toBe(false);
  });
});

describe("the Sharing box", () => {
  it("reads GET .../access first, then opens mockup 2 with real radio buttons, the account's address, the chips and the field", async () => {
    const held = holding((req) => req.path === path(T2), standard());
    const tab = openTours(held.respond);
    await tab.settle();
    const row = rows(tab)[1];
    byText(row, "More").click();
    entry(row, "Sharing…").click();
    await tab.settle();
    // Nothing opens before the answer, and nothing else can start meanwhile.
    expect(boxOpen(tab)).toBe(false);
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(true);
    expect(byText(rows(tab)[0], "More").click()).toBeNull();
    expect(menuOf(rows(tab)[0]).hidden).toBe(true);
    held.answer(access());
    await tab.settle();
    expect(tab.fetched.filter((f) => f.path === path(T2)).map((f) => [f.method, f.headers["X-Csrf-Token"], f.body])).toEqual([["GET", undefined, undefined]]);
    expect(boxOpen(tab)).toBe(true);
    expect(tab.$("share-box").getAttribute("role")).toBe("dialog");
    expect(boxShows(tab)).toEqual([
      'Who can view "Loot master setup"?',
      "Anyone with the linkNo sign-in. Fastest for viewers.",
      "Only people I chooseThey prove their email address with a link we send them.",
      `Only meYou prove your own address, ${MAIL}, the same way.`,
      "People who can view · 4 of 200",
      ...LIST.flatMap((a) => [a, "✕"]),
      "Add",
      "You can always view your own tours. People on the list are not told they were added: send them the link yourself.",
      "Cancel",
      "Save",
    ]);
    // Three real radio buttons of one group, each with its label, the current setting checked and focused.
    expect(radios(tab).map((r) => [r.tagName, r.type, r.getAttribute("name"), r.getAttribute("value"), r.checked, r.disabled])).toEqual([
      ["input", "radio", "share-access", "public", false, false],
      ["input", "radio", "share-access", "people", true, false],
      ["input", "radio", "share-access", "me", false, false],
    ]);
    for (const r of radios(tab)) expect(tab.doc.root.all().some((e) => e.tagName === "label" && e.getAttribute("for") === r.id && e.contains(r))).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("share-people"));
    // Each chip's remove button is named for a screen reader; the field is labelled by the count.
    expect(chips(tab).map((c) => c.all().filter((e) => e.tagName === "button").map((b) => [b.getAttribute("type"), b.getAttribute("aria-label")]))).toEqual(LIST.map((a) => [["button", `Remove ${a}`]]));
    expect(tab.doc.root.all().find((e) => e.tagName === "label" && e.getAttribute("for") === "share-input")!.textContent).toBe("People who can view · 4 of 200");
    expect(tab.$("share-input").getAttribute("placeholder")).toBe("name@example.com");
    // The address in "Only me" is the session's, isolated from the words around it.
    expect(tab.$("share-me-text").children.map((c) => [(c as FakeElement).className, c instanceof FakeElement ? c.textContent : ""])).toEqual([
      ["", "You prove your own address, "],
      ["name", MAIL],
      ["", ", the same way."],
    ]);
    expect(puts(tab)).toEqual([]);
  });

  it("shows the list only for Only people I choose; Cancel, Escape and the backdrop discard the edits and send nothing", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access() }));
    await tab.settle();
    await openSharing(tab, 1);
    tab.$("share-me").click();
    expect(checkedOne(tab)).toBe("share-me");
    expect(tab.$("share-people-part").shown).toBe(false);
    expect([tab.$("share-input").disabled, tab.$("share-add").disabled]).toEqual([true, true]);
    tab.$("share-people").click();
    chipButton(tab, "mara@example.com").click();
    expect(addresses(tab)).toEqual(["bram@example.com", "rook@example.com", "tess@example.com"]);
    tab.$("share-cancel").click();
    expect(boxOpen(tab)).toBe(false);
    expect(tab.doc.activeElement).toBe(byText(rows(tab)[1], "More"));
    // Opened again: read again, and the edits are gone.
    await openSharing(tab, 1);
    expect(addresses(tab)).toEqual(LIST);
    expect(tab.fetched.filter((f) => f.path === path(T2))).toHaveLength(2);
    tab.$("share-me").click();
    key(tab.doc.body, "Escape");
    expect(boxOpen(tab)).toBe(false);
    await openSharing(tab, 1);
    expect(checkedOne(tab)).toBe("share-people");
    tab.$("share-dialog").click();
    expect(boxOpen(tab)).toBe(false);
    expect(puts(tab)).toEqual([]);
  });

  it("Add takes one or several addresses, separated by commas, spaces, semicolons or line ends, trimmed, lower-cased and without duplicates", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access() }));
    await tab.settle();
    await openSharing(tab, 1);
    type(tab, "  Ana@Example.com, bo@example.com;\ncy@example.org\tMARA@example.com  ana@example.com,,");
    tab.$("share-add").click();
    expect(addresses(tab)).toEqual([...LIST, "ana@example.com", "bo@example.com", "cy@example.org"]);
    expect(tab.$("share-input").value).toBe("");
    expect(tab.$("share-count").textContent).toBe("People who can view · 7 of 200");
    expect(tab.$("share-add-message").hidden).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("share-input"));
    // Enter in the field adds (it never saves); a held Enter's repeats do nothing.
    type(tab, "dee@example.com");
    expect(key(tab.$("share-input"), "Enter").defaultPrevented).toBe(true);
    expect(addresses(tab).at(-1)).toBe("dee@example.com");
    type(tab, "eve@example.com");
    expect(tab.$("share-input").dispatch("keydown", { key: "Enter", repeat: true }).defaultPrevented).toBe(true);
    expect(addresses(tab)).not.toContain("eve@example.com");
    expect(boxOpen(tab)).toBe(true);
    expect(puts(tab)).toEqual([]);
  });

  it("refuses the whole paste when one entry is not shaped like an address, naming it as text, cut to 60 characters", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access() }));
    await tab.settle();
    await openSharing(tab, 1);
    const said = () => tab.$("share-add-message").children.map((c) => [(c as FakeElement).className, (c as FakeElement).textContent]);
    for (const bad of ["mara@example", "@example.com", "a@b@example.com", "a@example.123", "a@.example.com", "a@example..com", "ünï@example.com"]) {
      type(tab, `new@example.com, ${bad}`);
      tab.$("share-add").click();
      expect(said(), bad).toEqual([
        ["", '"'],
        ["name", bad],
        ["", '" does not look like an email address. Nothing was added.'],
      ]);
      expect(addresses(tab), bad).toEqual(LIST);
      expect(tab.$("share-input").value, bad).toBe(`new@example.com, ${bad}`);
      expect(tab.$("share-input").getAttribute("aria-invalid"), bad).toBe("true");
    }
    // Very long, with markup and a direction mark: shown as text, cut to 60 characters.
    const long = '<img/src=x/onerror="alert(1)">‮' + "z".repeat(100);
    type(tab, long);
    tab.$("share-add").click();
    expect(said()[1]).toEqual(["name", Array.from(long).slice(0, 60).join("") + "…"]);
    expect(tab.$("share-add-message").all().filter((e) => e.tagName !== "span")).toEqual([]);
    // Typing again clears the message.
    type(tab, "x");
    expect(tab.$("share-add-message").hidden).toBe(true);
    expect(tab.$("share-input").hasAttribute("aria-invalid")).toBe(false);
  });

  it("stops at the limit: a full list takes nobody more, and a paste that would pass it adds nothing", async () => {
    const full = Array.from({ length: 200 }, (_, i) => `p${i}@example.com`);
    const tab = openTours(standard({ [`GET ${path(T2)}`]: [access({ viewers: full }), access({ viewers: full.slice(0, 198) })] }));
    await tab.settle();
    await openSharing(tab, 1);
    expect(tab.$("share-count").textContent).toBe("People who can view · 200 of 200");
    type(tab, "one.more@example.com");
    tab.$("share-add").click();
    expect(tab.$("share-add-message").textContent).toBe("The list is full at 200 people. Remove someone first.");
    // One already on the list is no addition, so nothing is refused.
    type(tab, "P1@example.com");
    tab.$("share-add").click();
    expect(tab.$("share-add-message").hidden).toBe(true);
    expect(addresses(tab)).toHaveLength(200);
    tab.$("share-cancel").click();
    await openSharing(tab, 1);
    type(tab, "a@example.com b@example.com c@example.com");
    tab.$("share-add").click();
    expect(tab.$("share-add-message").textContent).toBe("That would make 201 people, and the list holds 200. Nothing was added.");
    expect(addresses(tab)).toHaveLength(198);
  });

  it("a chip's remove button takes the address off the list and leaves the focus on the next chip, then on the field", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access({ viewers: ["a@example.com", "b@example.com"] }) }));
    await tab.settle();
    await openSharing(tab, 1);
    chipButton(tab, "a@example.com").click();
    expect(addresses(tab)).toEqual(["b@example.com"]);
    expect(tab.doc.activeElement).toBe(chipButton(tab, "b@example.com"));
    expect(tab.$("share-count").textContent).toBe("People who can view · 1 of 200");
    // A held key's repeats press nothing.
    expect(chipButton(tab, "b@example.com").dispatch("keydown", { key: "Enter", repeat: true }).defaultPrevented).toBe(true);
    chipButton(tab, "b@example.com").click();
    expect(addresses(tab)).toEqual([]);
    expect(tab.doc.activeElement).toBe(tab.$("share-input"));
  });

  it("Tab goes round the box as a browser would: the checked option alone of the three, the chips, the field, Add, Cancel and Save", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access({ viewers: ["a@example.com", "b@example.com"] }) }));
    await tab.settle();
    await openSharing(tab, 1);
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
  });
});

describe("saving who can view", () => {
  it("a change of the list alone sends the chosen setting and the whole list, once, to the box's tour, without asking; the row shows what the API reports", async () => {
    const after = MOCKUP_TOURS.map((t) => (t.id === T2 ? { ...t, viewers: 5 } : t));
    const done = access({ viewers: [...LIST, "ana@example.com"].sort() });
    const held = holding((req) => req.method === "PUT", standard({ [`GET ${path(T2)}`]: access(), "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(after)] }));
    const tab = openTours(held.respond);
    await tab.settle();
    await openSharing(tab, 1);
    type(tab, "ana@example.com");
    tab.$("share-add").click();
    tab.$("share-save").click();
    // A second click, a dispatched click and a held key send nothing more.
    tab.$("share-save").click();
    tab.$("share-save").dispatch("click");
    expect(tab.$("share-save").dispatch("keydown", { key: "Enter", repeat: true }).defaultPrevented).toBe(true);
    await tab.settle();
    expect([tab.$("share-save").textContent, tab.$("share-save").getAttribute("aria-busy"), tab.$("share-cancel").disabled]).toEqual(["Saving…", "true", true]);
    for (const r of radios(tab)) expect(r.disabled).toBe(true);
    // Escape does nothing while it runs.
    key(tab.doc.body, "Escape");
    expect(boxOpen(tab)).toBe(true);
    held.answer(done);
    await drive(tab);
    expect(sent(tab)).toEqual([[path(T2), CSRF, "application/json", { access: "people", viewers: [...LIST, "ana@example.com"] }]]);
    expect(boxOpen(tab)).toBe(false);
    const cell = rows(tab)[1].children.filter((c): c is FakeElement => c instanceof FakeElement)[2];
    expect(cell.textContent).toBe("5 people");
    expect(tab.doc.activeElement).toBe(byText(rows(tab)[1], "More"));
    expect(tab.$("tours-message").hidden).toBe(true);
    // No address ever went into an address bar.
    for (const f of tab.fetched) for (const a of [...LIST, "ana@example.com"]) expect(f.path).not.toContain(a.split("@")[0]);
  });

  it("an address typed and not added yet is added on Save; one that is refused sends nothing", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access(), [`PUT ${path(T2)}`]: access({ viewers: [...LIST, "zed@example.com"] }) }));
    await tab.settle();
    await openSharing(tab, 1);
    type(tab, "mara@nowhere");
    tab.$("share-save").click();
    await drive(tab);
    expect(puts(tab)).toEqual([]);
    expect(tab.$("share-add-message").textContent).toBe('"mara@nowhere" does not look like an email address. Nothing was added.');
    type(tab, "Zed@example.com");
    tab.$("share-save").click();
    await drive(tab);
    expect(sent(tab).map((s) => s[3])).toEqual([{ access: "people", viewers: [...LIST, "zed@example.com"] }]);
    expect(boxOpen(tab)).toBe(false);
  });

  it("between the two restricted settings it saves without asking", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access(), [`PUT ${path(T2)}`]: access({ access: "me" }) }));
    await tab.settle();
    await openSharing(tab, 1);
    tab.$("share-me").click();
    tab.$("share-save").click();
    expect(tab.$("share-ask").shown).toBe(false);
    await drive(tab);
    expect(sent(tab).map((s) => s[3])).toEqual([{ access: "me", viewers: LIST }]);
    expect(boxOpen(tab)).toBe(false);
  });

  it("public to restricted asks first with mockup 3's words; its button waits, so neither a double click nor a held key can skip it", async () => {
    const tab = openTours(standard({ [`GET ${path(T1)}`]: PUBLIC, [`PUT ${path(T1)}`]: access({ viewers: ["ana@example.com"] }) }));
    await tab.settle();
    await openSharing(tab, 0);
    tab.$("share-people").click();
    type(tab, "ana@example.com");
    key(tab.$("share-input"), "Enter");
    // A double click on Save: the second click lands where "Restrict tour" now is, and does nothing.
    tab.$("share-save").click();
    tab.$("share-go").click();
    tab.$("share-save").click();
    await tab.settle();
    expect(puts(tab)).toEqual([]);
    expect(boxShows(tab)).toEqual([
      'Restrict "Timeline rehearsal walkthrough"?',
      "From now on only the people you chose can open the link. The link itself stays the same.",
      "Anyone who already opened this tour may still have its pictures in their browser. Restricting cannot take those back.",
      "Keep it public",
      "Restrict tour",
    ]);
    expect(tab.$("share-box").getAttribute("aria-describedby")).toBe("share-ask-text share-ask-warn");
    // The focus is on the button that keeps it public, so a second Enter keeps it public.
    expect(tab.doc.activeElement).toBe(tab.$("share-keep"));
    // Until it works the other button is inert but stays in the Tab order, announced as
    // unavailable (aria-disabled), never missing: pressing it then does nothing.
    expect([tab.$("share-go").disabled, tab.$("share-go").getAttribute("aria-disabled")]).toEqual([false, "true"]);
    key(tab.doc.body, "Tab");
    expect(tab.doc.activeElement).toBe(tab.$("share-go"));
    tab.$("share-go").click();
    key(tab.$("share-go"), "Enter");
    await tab.settle();
    expect(puts(tab)).toEqual([]);
    expect(tab.$("share-ask").shown).toBe(true);
    key(tab.doc.body, "Tab");
    expect(tab.doc.activeElement).toBe(tab.$("share-keep"));
    // A held Enter's repeats press nothing.
    expect(tab.$("share-keep").dispatch("keydown", { key: "Enter", repeat: true }).defaultPrevented).toBe(true);
    expect(tab.tick()).toEqual([600]);
    await tab.settle();
    expect(tab.$("share-go").hasAttribute("aria-disabled")).toBe(false);
    // The focus stays where it was: nothing is announced when it starts to work.
    expect(tab.doc.activeElement).toBe(tab.$("share-keep"));
    key(tab.doc.body, "Tab");
    expect(tab.doc.activeElement).toBe(tab.$("share-go"));
    // Keep it public goes back to the options with the edits kept, and sends nothing.
    tab.$("share-keep").click();
    expect(tab.$("share-form").shown).toBe(true);
    expect([checkedOne(tab), addresses(tab)]).toEqual(["share-people", ["ana@example.com"]]);
    expect(tab.doc.activeElement).toBe(tab.$("share-save"));
    expect(boxShows(tab)[0]).toBe('Who can view "Timeline rehearsal walkthrough"?');
    // Escape and the backdrop go back the same way, and the button waits again each time.
    for (const back of [() => key(tab.doc.body, "Escape"), () => tab.$("share-dialog").click()]) {
      tab.$("share-save").click();
      expect(tab.$("share-go").getAttribute("aria-disabled")).toBe("true");
      back();
      expect(boxOpen(tab)).toBe(true);
      expect(tab.$("share-form").shown).toBe(true);
    }
    tab.tick();
    expect(puts(tab)).toEqual([]);
    // Only me has its own sentence.
    tab.$("share-me").click();
    tab.$("share-save").click();
    expect(tab.$("share-ask-text").textContent).toBe("From now on only you can open the link. The link itself stays the same.");
    tab.$("share-keep").click();
    // Saved for good.
    tab.$("share-people").click();
    tab.$("share-save").click();
    await arm(tab);
    tab.$("share-go").click();
    tab.$("share-go").click();
    expect(tab.$("share-go").textContent).toBe("Saving…");
    await drive(tab);
    expect(sent(tab).map((s) => [s[0], s[3]])).toEqual([[path(T1), { access: "people", viewers: ["ana@example.com"] }]]);
    expect(boxOpen(tab)).toBe(false);
  });

  it("restricted to public asks with its own words; Keep it restricted sends nothing", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access(), [`PUT ${path(T2)}`]: access({ access: "public" }) }));
    await tab.settle();
    await openSharing(tab, 1);
    tab.$("share-public").click();
    // The list is kept (not shown) while public is chosen, and goes along whole.
    expect(tab.$("share-people-part").shown).toBe(false);
    tab.$("share-save").click();
    expect(boxShows(tab)).toEqual([
      'Let anyone with the link view "Loot master setup"?',
      "Nobody will be asked to sign in any more. Anyone who has or gets the link can open it. Your list of people is kept in case you restrict it again.",
      "Keep it restricted",
      "Make public",
    ]);
    tab.$("share-keep").click();
    expect(puts(tab)).toEqual([]);
    tab.$("share-save").click();
    await arm(tab);
    tab.$("share-go").click();
    await drive(tab);
    expect(sent(tab).map((s) => s[3])).toEqual([{ access: "public", viewers: LIST }]);
  });
});

describe("a move of the pictures", () => {
  it("shows its progress and repeats the identical request after a short pause until it is done; then the row shows the new setting", async () => {
    const after = MOCKUP_TOURS.map((t) => (t.id === T1 ? { ...t, access: "people", viewers: 1 } : t));
    const tab = openTours(
      standard({
        [`GET ${path(T1)}`]: PUBLIC,
        [`PUT ${path(T1)}`]: [moving(0, 3), moving(2, 3), access({ viewers: ["ana@example.com"] })],
        "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(after)],
      }),
    );
    await tab.settle();
    await openSharing(tab, 0);
    tab.$("share-people").click();
    type(tab, "ana@example.com");
    tab.$("share-save").click();
    await arm(tab);
    tab.$("share-go").click();
    await tab.settle();
    expect(boxShows(tab)).toEqual(['Who can view "Timeline rehearsal walkthrough"?', "Moving the pictures, 0 of 3. Keep this page open."]);
    expect([tab.$("share-progress").max, tab.$("share-progress").value]).toEqual([3, "0"]);
    expect(tab.doc.activeElement).toBe(tab.$("share-title"));
    // Escape, the backdrop and Tab do nothing to it.
    key(tab.doc.body, "Escape");
    tab.$("share-dialog").click();
    key(tab.doc.body, "Tab");
    expect(boxOpen(tab)).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("share-title"));
    expect(tab.tick()).toEqual([300]);
    await tab.settle();
    expect(tab.$("share-moving-text").textContent).toBe("Moving the pictures, 2 of 3. Keep this page open.");
    expect(tab.$("share-progress").value).toBe("2");
    tab.tick();
    await drive(tab);
    const bodies = puts(tab).map((f) => f.body);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ access: "people", viewers: ["ana@example.com"] });
    expect(new Set(puts(tab).map((f) => f.path))).toEqual(new Set([path(T1)]));
    expect(boxOpen(tab)).toBe(false);
    expect(rows(tab)[0].children.filter((c): c is FakeElement => c instanceof FakeElement)[2].textContent).toBe("1 person");
    expect(tab.$("tours-gate").shown).toBe(true);
  });

  it("sends again after 500 access_failed or a lost answer, at most three times in a row, then decides by reading the setting again", async () => {
    // Lost three times; the setting read again is the one sent: done.
    const won = openTours(standard({ [`GET ${path(T2)}`]: [access(), access(), access({ access: "me" })], [`PUT ${path(T2)}`]: ["network", refused(500, "access_failed"), "network"] }));
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
    expect(boxOpen(won)).toBe(false);
    expect(won.$("tours-message").hidden).toBe(true);

    // The setting read again is not the one sent: the box stays, says so, and keeps the choice.
    const lost = openTours(standard({ [`GET ${path(T2)}`]: access(), [`PUT ${path(T2)}`]: "network" }));
    await lost.settle();
    await openSharing(lost, 1);
    lost.$("share-me").click();
    lost.$("share-save").click();
    await drive(lost);
    expect(puts(lost)).toHaveLength(3);
    expect(boxOpen(lost)).toBe(true);
    expect(lost.$("share-message").textContent).toBe(FAILED);
    expect([checkedOne(lost), lost.$("share-save").textContent, lost.$("share-save").disabled]).toEqual(["share-me", "Save", false]);
    expect(lost.doc.activeElement).toBe(lost.$("share-save"));

    // A 202 in between starts the count again.
    const mixed = openTours(standard({ [`GET ${path(T2)}`]: access(), [`PUT ${path(T2)}`]: [refused(500, "access_failed"), moving(1, 2), refused(500, "access_failed"), "network", refused(500, "access_failed")] }));
    await mixed.settle();
    await openSharing(mixed, 1);
    mixed.$("share-me").click();
    mixed.$("share-save").click();
    await drive(mixed);
    expect(puts(mixed)).toHaveLength(5);
    expect(new Set(puts(mixed).map((f) => f.body)).size).toBe(1);
  });

  it("stops at once on a refusal, saying why in plain words, and shows the tour as the API now gives it", async () => {
    const cases: [Answer, string][] = [
      [refused(409, "cannot_restrict"), "This site cannot send mail, so this tour cannot be restricted. Nothing was changed."],
      [refused(409, "access_switching"), "This tour's pictures are still being moved. Open Sharing again to finish that first."],
      [refused(409, "switch_cancelled"), "The tour was unpublished or deleted while its pictures were being moved, so the change did not finish."],
      [refused(409, "access_busy"), "The tour changed while this was being saved. Press Save again."],
      [refused(409, "republish_needed"), "This tour's pictures could not be moved. Unpublish it, publish it again from Mythicshot, then set who can view it."],
      [refused(400, "too_many_viewers"), "The list holds at most 200 people. Remove some and press Save again."],
      [refused(400, "bad_viewer", "viewers[9] is not an email address; nothing was changed"), FAILED],
      [refused(400, "bad_request"), FAILED],
      [refused(413, "too_large"), FAILED],
      [refused(500, "internal"), FAILED],
      [refused(429, "rate_limited"), TOO_MANY],
    ];
    for (const [answer, text] of cases) {
      const what = JSON.stringify(answer);
      const after = MOCKUP_TOURS.map((t) => (t.id === T2 ? { ...t, viewers: 9 } : t));
      const tab = openTours(standard({ [`GET ${path(T2)}`]: access(), [`PUT ${path(T2)}`]: [moving(1, 4), answer], "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(after)] }));
      await tab.settle();
      await openSharing(tab, 1);
      tab.$("share-me").click();
      tab.$("share-save").click();
      await drive(tab);
      expect(puts(tab), what).toHaveLength(2);
      expect(boxOpen(tab), what).toBe(true);
      expect(tab.$("share-message").textContent, what).toBe(text);
      expect(tab.$("share-form").shown, what).toBe(true);
      expect(checkedOne(tab), what).toBe("share-me");
      // The setting was read on opening, before sending and after: the row shows what the API reports.
      expect(tab.fetched.filter((f) => f.path === path(T2) && f.method === "GET"), what).toHaveLength(3);
      expect(rows(tab)[1].children.filter((c): c is FakeElement => c instanceof FakeElement)[2].textContent, what).toBe("9 people");
      expect(tab.timers(), what).toBe(0);
    }
  });

  it("bad_viewer names the entry at the position the server gave, from the page's own list, as text", async () => {
    const hostile = '<b onclick="x">"q"</b>‮@example.com';
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access({ viewers: ["a@example.com", hostile] }), [`PUT ${path(T2)}`]: refused(400, "bad_viewer", "viewers[1] is not an email address; nothing was changed") }));
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

  it("stops when the page is left, sends nothing more by itself, and offers to finish when Sharing is opened", async () => {
    const tab = openTours(
      standard({
        [`GET ${path(T1)}`]: [PUBLIC, PUBLIC, access({ viewers: ["ana@example.com"], switching: { done: 1, total: 3, target: "restricted" } })],
        [`PUT ${path(T1)}`]: [moving(1, 3), access({ viewers: ["ana@example.com"] })],
      }),
    );
    await tab.settle();
    await openSharing(tab, 0);
    tab.$("share-people").click();
    type(tab, "ana@example.com");
    tab.$("share-save").click();
    await arm(tab);
    tab.$("share-go").click();
    await tab.settle();
    tab.pagehide();
    await drive(tab);
    expect(puts(tab)).toHaveLength(1);
    // The box says so, and shows the stopped move as the API reports it: a move to restricted,
    // which it offers only to finish.
    expect(tab.$("share-message").textContent).toBe(FAILED);
    expect(boxShows(tab)).toEqual([
      'Who can view "Timeline rehearsal walkthrough"?',
      'Moving this tour\'s pictures stopped at 1 of 3. Choose "Keep it restricted" to finish restricting it.',
      FAILED,
      "Cancel",
      "Keep it restricted",
    ]);
    expect(tab.doc.activeElement).toBe(tab.$("share-restricted"));
    // Pressed: the request is the setting the tour has now, with its list.
    tab.$("share-restricted").click();
    await drive(tab);
    expect(sent(tab).map((s) => s[3])).toEqual([
      { access: "people", viewers: ["ana@example.com"] },
      { access: "people", viewers: ["ana@example.com"] },
    ]);
    expect(boxOpen(tab)).toBe(false);
  });

  it("never loops for ever: after 5000 requests it stops, says so, and shows the move as stopped", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: [access(), access(), access({ switching: { done: 7, total: 9, target: "public" } })], [`PUT ${path(T2)}`]: moving(7, 9) }));
    await tab.settle();
    await openSharing(tab, 1);
    tab.$("share-public").click();
    tab.$("share-save").click();
    await arm(tab);
    tab.$("share-go").click();
    for (let i = 0; i < 40_000 && !(puts(tab).length >= 5000 && tab.timers() === 0); i++) {
      await new Promise((r) => setImmediate(r));
      if (tab.timers() > 0) tab.tick();
    }
    await drive(tab);
    expect(puts(tab)).toHaveLength(5000);
    expect(tab.$("share-message").textContent).toBe(FAILED);
    expect(tab.$("share-resume").shown).toBe(true);
  }, 120_000);
});

describe("a move that stopped", () => {
  it("a move to public: Keep it restricted sends the setting the tour has now; Make public asks first, then sends public", async () => {
    const stopped = access({ switching: { done: 3, total: 9, target: "public" } });
    const tab = openTours(standard({ [`GET ${path(T2)}`]: stopped, [`PUT ${path(T2)}`]: [access(), access({ access: "public" })] }));
    await tab.settle();
    await openSharing(tab, 1);
    expect(boxShows(tab)).toEqual([
      'Who can view "Loot master setup"?',
      'Moving this tour\'s pictures stopped at 3 of 9. "Keep it restricted" leaves it as it is now; "Make public" finishes making it public.',
      "Cancel",
      "Keep it restricted",
      "Make public",
    ]);
    expect(tab.doc.activeElement).toBe(tab.$("share-restricted"));
    expect(tab.$("share-box").getAttribute("aria-describedby")).toBe("share-resume");
    tab.$("share-restricted").click();
    await drive(tab);
    expect(sent(tab).map((s) => s[3])).toEqual([{ access: "people", viewers: LIST }]);
    expect(boxOpen(tab)).toBe(false);

    await openSharing(tab, 1);
    tab.$("share-make-public").click();
    expect(boxShows(tab)[0]).toBe('Let anyone with the link view "Loot master setup"?');
    // Going back returns to the stopped move, not to the options.
    tab.$("share-keep").click();
    expect(tab.$("share-resume").shown).toBe(true);
    tab.$("share-make-public").click();
    await arm(tab);
    tab.$("share-go").click();
    await drive(tab);
    expect(sent(tab).map((s) => s[3])[1]).toEqual({ access: "public", viewers: LIST });
    expect(boxOpen(tab)).toBe(false);
  });

  it("a move to restricted offers only to finish it", async () => {
    const stopped = access({ access: "me", switching: { done: 2, total: 5, target: "restricted" } });
    const tab = openTours(standard({ [`GET ${path(T2)}`]: stopped, [`PUT ${path(T2)}`]: access({ access: "me" }) }));
    await tab.settle();
    await openSharing(tab, 1);
    expect(boxShows(tab)).toEqual([
      'Who can view "Loot master setup"?',
      'Moving this tour\'s pictures stopped at 2 of 5. Choose "Keep it restricted" to finish restricting it.',
      "Cancel",
      "Keep it restricted",
    ]);
    expect(tab.$("share-make-public").shown).toBe(false);
    // A hidden Make public pressed anyway (as only a script could) sends nothing.
    tab.$("share-make-public").click();
    expect(tab.$("share-ask").shown).toBe(false);
    tab.$("share-restricted").click();
    await drive(tab);
    expect(sent(tab).map((s) => s[3])).toEqual([{ access: "me", viewers: LIST }]);
    expect(boxOpen(tab)).toBe(false);
  });

  it("a move the server finished or cancelled meanwhile: nothing is sent, and the box shows the tour as it is now", async () => {
    // Finished by the server in the background (a move to restricted).
    const done = openTours(standard({ [`GET ${path(T2)}`]: [access({ switching: { done: 2, total: 5, target: "restricted" } }), access()] }));
    await done.settle();
    await openSharing(done, 1);
    done.$("share-restricted").click();
    await drive(done);
    expect(puts(done)).toEqual([]);
    expect(done.$("share-form").shown).toBe(true);
    expect([checkedOne(done), addresses(done)]).toEqual(["share-people", LIST]);
    expect(done.$("share-message").hidden).toBe(true);
    expect([done.$("share-restricted").textContent, done.$("share-save").disabled]).toEqual(["Keep it restricted", false]);
    expect(done.doc.activeElement).toBe(done.$("share-save"));

    // Cancelled by the server after it stalled (a move to public): the tour stays restricted.
    const cancelled = openTours(standard({ [`GET ${path(T2)}`]: [access({ switching: { done: 3, total: 9, target: "public" } }), access()] }));
    await cancelled.settle();
    await openSharing(cancelled, 1);
    cancelled.$("share-make-public").click();
    await arm(cancelled);
    cancelled.$("share-go").click();
    await drive(cancelled);
    expect(puts(cancelled)).toEqual([]);
    expect(cancelled.$("share-form").shown).toBe(true);
    expect(checkedOne(cancelled)).toBe("share-people");

    // A change made elsewhere while the options were open: nothing is sent, the edits stay, and the box says to press Save again.
    const elsewhere = openTours(standard({ [`GET ${path(T2)}`]: [access(), access({ access: "me" })], [`PUT ${path(T2)}`]: access() }));
    await elsewhere.settle();
    await openSharing(elsewhere, 1);
    chipButton(elsewhere, "bram@example.com").click();
    elsewhere.$("share-save").click();
    await drive(elsewhere);
    expect(puts(elsewhere)).toEqual([]);
    expect(elsewhere.$("share-message").textContent).toBe("The tour changed while this was being saved. Press Save again.");
    expect([checkedOne(elsewhere), addresses(elsewhere)]).toEqual(["share-people", LIST.slice(1)]);
    // The setting read before sending is unreachable: nothing is sent, and the page says so.
    const unread = openTours(standard({ [`GET ${path(T2)}`]: [access(), "network"] }));
    await unread.settle();
    await openSharing(unread, 1);
    unread.$("share-me").click();
    unread.$("share-save").click();
    await drive(unread);
    expect(puts(unread)).toEqual([]);
    expect(unread.$("share-message").textContent).toBe(FAILED);
    expect(checkedOne(unread)).toBe("share-me");
  });

  it("a move whose state changed under a request is refused gracefully: the box shows what the API now reports", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: [access({ switching: { done: 3, total: 9, target: "public" } }), access({ switching: { done: 3, total: 9, target: "public" } }), access({ switching: { done: 4, total: 9, target: "restricted" } })], [`PUT ${path(T2)}`]: refused(409, "access_switching") }));
    await tab.settle();
    await openSharing(tab, 1);
    tab.$("share-make-public").click();
    await arm(tab);
    tab.$("share-go").click();
    await drive(tab);
    expect(puts(tab)).toHaveLength(1);
    expect(boxShows(tab)).toEqual([
      'Who can view "Loot master setup"?',
      'Moving this tour\'s pictures stopped at 4 of 9. Choose "Keep it restricted" to finish restricting it.',
      "This tour's pictures are still being moved. Open Sharing again to finish that first.",
      "Cancel",
      "Keep it restricted",
    ]);
    tab.$("share-close").click();
    expect(boxOpen(tab)).toBe(false);
  });
});

describe("the house rules", () => {
  it("the request goes to the tour whose box is open, never to another, even after the list was read again in another order", async () => {
    const reordered = [{ ...MOCKUP_TOURS[1], title: "Renamed" }, MOCKUP_TOURS[2]];
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access(), [`PUT ${path(T2)}`]: [refused(409, "access_busy"), access({ access: "me" })], "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(reordered)] }));
    await tab.settle();
    await openSharing(tab, 1);
    tab.$("share-me").click();
    tab.$("share-save").click();
    await drive(tab);
    // The list underneath now has the tour first, and T1 is gone; the box is still T2's.
    expect(rows(tab).map((r) => r.all().find((e) => e.className === "t")!.textContent)).toEqual(["Renamed", "Note send rehearsal"]);
    tab.$("share-save").click();
    await drive(tab);
    expect(puts(tab).map((f) => f.path)).toEqual([path(T2), path(T2)]);
    expect(tab.fetched.some((f) => f.path.includes(T1) && f.method !== "GET")).toBe(false);
    expect(tab.doc.activeElement).toBe(byText(rows(tab)[0], "More"));
  });

  it("hostile titles and addresses show as text: markup, quotes, direction marks and very long ones", async () => {
    const title = '<img src=x onerror="alert(1)">‮"quoted" & ' + "long ".repeat(80);
    const list = ['<script>x</script>@example.com', "‮evil@example.com", "a".repeat(240) + "@example.com", '"q"@example.com'];
    const tours = [tour(T1, { title, access: "people", viewers: 4 })];
    const tab = openTours(standard({ "GET /api/v1/tours": toursAnswer(tours), [`GET ${path(T1)}`]: access({ viewers: list }), [`PUT ${path(T1)}`]: access({ access: "public", viewers: list }) }));
    await tab.settle();
    await openSharing(tab, 0);
    expect(tab.$("share-title").children.map((c) => [(c as FakeElement).className, (c as FakeElement).textContent])).toEqual([
      ["", 'Who can view "'],
      ["name", title],
      ["", '"?'],
    ]);
    expect(addresses(tab)).toEqual(list);
    for (const c of chips(tab)) expect(c.all().find((e) => e.className === "name")!.children.every((n) => !(n instanceof FakeElement))).toBe(true);
    expect(tab.doc.body.all().some((e) => e.tagName === "img" || e.tagName === "script")).toBe(false);
    tab.$("share-public").click();
    tab.$("share-save").click();
    expect(tab.$("share-title").children.map((c) => (c as FakeElement).className)).toEqual(["", "name", ""]);
    expect(tab.$("share-title").textContent).toBe(`Let anyone with the link view "${title}"?`);
    await arm(tab);
    tab.$("share-go").click();
    await drive(tab);
    expect(JSON.parse(puts(tab)[0].body!)).toEqual({ access: "public", viewers: list });
    expect(puts(tab)[0].path).toBe(path(T1));
  });

  it("on a site that cannot send mail, nothing restricted can be chosen for a public tour", async () => {
    const tab = openTours(standard({ [`GET ${path(T1)}`]: access({ access: "public", viewers: ["kept@example.com"], can_restrict: false }), [`PUT ${path(T1)}`]: access({ access: "public", viewers: ["kept@example.com"], can_restrict: false }) }));
    await tab.settle();
    await openSharing(tab, 0);
    expect(radios(tab).map((r) => [r.id, r.checked, r.disabled])).toEqual([
      ["share-public", true, false],
      ["share-people", false, true],
      ["share-me", false, true],
    ]);
    expect(tab.$("share-nomail").shown).toBe(true);
    expect(tab.$("share-nomail").textContent).toBe('This site cannot send mail, so only "Anyone with the link" can be chosen here.');
    expect(tab.$("share-nomail-kept").shown).toBe(false);
    // A click on a disabled option does nothing; one forced through anyway is put back.
    expect(tab.$("share-people").click()).toBeNull();
    tab.$("share-me").checked = true;
    tab.$("share-me").dispatch("change");
    expect(checkedOne(tab)).toBe("share-public");
    expect(tab.$("share-people-part").shown).toBe(false);
    // Tab reaches only the public option among the three.
    tab.$("share-public").focus();
    key(tab.doc.body, "Tab");
    key(tab.doc.body, "Tab");
    key(tab.doc.body, "Tab");
    expect(tab.doc.activeElement).toBe(tab.$("share-public"));
    tab.$("share-save").click();
    await drive(tab);
    expect(sent(tab).map((s) => s[3])).toEqual([{ access: "public", viewers: ["kept@example.com"] }]);
  });

  it("on a site that cannot send mail, a restricted tour keeps its setting, can move between the restricted two, have its list edited, or be made public", async () => {
    const noMail = access({ can_restrict: false });
    const tab = openTours(standard({ [`GET ${path(T2)}`]: noMail, [`PUT ${path(T2)}`]: [access({ access: "me", can_restrict: false }), access({ access: "public", can_restrict: false })] }));
    await tab.settle();
    await openSharing(tab, 1);
    expect(radios(tab).map((r) => [r.checked, r.disabled])).toEqual([
      [false, false],
      [true, false],
      [false, false],
    ]);
    expect(tab.$("share-nomail").shown).toBe(false);
    expect(tab.$("share-nomail-kept").textContent).toBe("This site cannot send mail, so once this tour is public it cannot be restricted again here.");
    expect(tab.$("share-nomail-kept").shown).toBe(true);
    chipButton(tab, "bram@example.com").click();
    tab.$("share-me").click();
    tab.$("share-save").click();
    await drive(tab);
    expect(sent(tab).map((s) => s[3])).toEqual([{ access: "me", viewers: LIST.slice(1) }]);
    await openSharing(tab, 1);
    tab.$("share-public").click();
    tab.$("share-save").click();
    expect(tab.$("share-ask").shown).toBe(true);
    await arm(tab);
    tab.$("share-go").click();
    await drive(tab);
    expect(sent(tab).map((s) => s[3])[1]).toEqual({ access: "public", viewers: LIST });
  });

  it("one box or menu at a time: while the box is open the page behind is inert, and Sharing reads nothing twice", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: access() }));
    await tab.settle();
    await openSharing(tab, 1);
    for (const id of ["dash-top", "tours-page"]) expect([tab.$(id).getAttribute("inert"), tab.$(id).getAttribute("aria-hidden")], id).toEqual(["", "true"]);
    // A menu entry pressed now (as only a script could) opens nothing more.
    entry(rows(tab)[0], "Sharing…").click();
    entry(rows(tab)[1], "Delete").click();
    await tab.settle();
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect(tab.fetched.filter((f) => f.path.endsWith("/access"))).toHaveLength(1);
    tab.$("share-cancel").click();
    for (const id of ["dash-top", "tours-page"]) expect(tab.$(id).hasAttribute("inert"), id).toBe(false);
  });

  it("when who can view cannot be read, the page says so and the list is read again", async () => {
    for (const [answer, text] of [
      [refused(500, "internal"), FAILED],
      [refused(429, "rate_limited"), TOO_MANY],
      ["network", FAILED],
      [{ status: 200, json: { access: "friends", viewers: [], can_restrict: true, switching: null } }, FAILED],
    ] as [Answer, string][]) {
      const what = JSON.stringify(answer);
      const tab = openTours(standard({ [`GET ${path(T2)}`]: answer }));
      await tab.settle();
      await openSharing(tab, 1);
      expect(boxOpen(tab), what).toBe(false);
      expect(tab.$("tours-message").textContent, what).toBe(text);
      expect(tab.fetched.filter((f) => f.path === "/api/v1/tours"), what).toHaveLength(2);
      for (const b of rowButtons(tab)) expect(b.disabled, `${what} ${b.textContent}`).toBe(false);
      expect(tab.doc.activeElement, what).toBe(byText(rows(tab)[1], "More"));
    }
    // A tour that is gone: the list read again no longer has it, and nothing more is said.
    const gone = openTours(standard({ [`GET ${path(T2)}`]: refused(404, "not_found"), "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(MOCKUP_TOURS.filter((t) => t.id !== T2))] }));
    await gone.settle();
    await openSharing(gone, 1);
    expect(gone.$("tours-message").hidden).toBe(true);
    expect(rows(gone)).toHaveLength(2);
    expect(gone.doc.activeElement).toBe(gone.$("h-page"));
    // Signed out meanwhile: off to sign in.
    const out = openTours(standard({ [`GET ${path(T2)}`]: { status: 401, json: { error: "unauthorized" } } }));
    await out.settle();
    await openSharing(out, 1);
    expect(out.left()).toBe("/signin");
  });
});

// ---- Against the real app ----

describe("sharing against the real app", () => {
  async function site(mail: boolean) {
    const { deps } = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" }, retiredGraceMs: 0 }, { mail });
    await seedAccount(deps, { admin: true, username: "sharecheck-admin" });
    const owner = await seedAccount(deps, { username: "sharecheck" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), FIREFOX, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;
    const uploaded = await uploadTour(deps, owner.token, fixtures.v3 as Json);
    let r = await send(deps, "POST", `/api/v1/tours/${uploaded.tour_id}/publish`, { token: owner.token });
    while (r.status === 202) r = await send(deps, "POST", `/api/v1/tours/${uploaded.tour_id}/publish`, { token: owner.token, body: JSON.stringify({ publish_id: r.json.publish_id }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(200);
    return { deps, owner, cookie, id: uploaded.tour_id as string, slug: r.json.slug as string };
  }

  it("restricts a published tour to two people, moving its pictures, and makes it public again; a token cannot change it", async () => {
    const s = await site(true);
    const tab = openTours(browser(s.deps, s.cookie));
    await tab.settle();
    expect(rows(tab)[0].children.filter((c): c is FakeElement => c instanceof FakeElement)[2].textContent).toBe("Anyone with the link");
    await openSharing(tab, 0);
    expect(boxOpen(tab)).toBe(true);
    expect(tab.$("share-me-text").textContent).toBe(`You prove your own address, ${s.owner.email}, the same way.`);
    tab.$("share-people").click();
    type(tab, "Ana@Example.com; bo@example.com");
    tab.$("share-add").click();
    tab.$("share-save").click();
    await arm(tab);
    tab.$("share-go").click();
    await drive(tab, 200);
    expect(boxOpen(tab)).toBe(false);
    expect(tab.$("tours-message").hidden).toBe(true);
    expect(rows(tab)[0].children.filter((c): c is FakeElement => c instanceof FakeElement)[2].textContent).toBe("2 people");
    expect(tab.$("tours-gate").shown).toBe(true);
    const now = await send(s.deps, "GET", `/api/v1/tours/${s.id}/access`, { token: s.owner.token });
    // A token reads the count only (the addresses are for the session, which the page shows on opening Sharing again below).
    expect(now.json).toEqual({ access: "people", viewers_count: 2, limit: 200, can_restrict: true, switching: null });
    expect((await send(s.deps, "GET", `/t/${s.slug}`, { origin: "https://tours.example.com" })).status).toBe(404);
    // A token (the desktop app) cannot make it public: only the session can, and the page has no other credential.
    const byToken = await send(s.deps, "PUT", `/api/v1/tours/${s.id}/access`, { origin: APP, token: s.owner.token, body: JSON.stringify({ access: "public" }), headers: { "content-type": "application/json" } });
    expect(byToken.status).toBe(401);
    // Back to public through the page.
    await openSharing(tab, 0);
    expect(addresses(tab)).toEqual(["ana@example.com", "bo@example.com"]);
    tab.$("share-public").click();
    tab.$("share-save").click();
    await arm(tab);
    tab.$("share-go").click();
    await drive(tab, 200);
    expect(boxOpen(tab)).toBe(false);
    expect(rows(tab)[0].children.filter((c): c is FakeElement => c instanceof FakeElement)[2].textContent).toBe("Anyone with the link");
    expect((await send(s.deps, "GET", `/api/v1/tours/${s.id}/access`, { token: s.owner.token })).json).toMatchObject({ access: "public", viewers_count: 2, switching: null });
    expect((await send(s.deps, "GET", `/t/${s.slug}`, { origin: "https://tours.example.com" })).status).toBe(200);
  });

  it("on a site without mail, the restricted options cannot be chosen and nothing is sent for them", async () => {
    const s = await site(false);
    const tab = openTours(browser(s.deps, s.cookie));
    await tab.settle();
    await openSharing(tab, 0);
    expect(radios(tab).map((r) => r.disabled)).toEqual([false, true, true]);
    expect(tab.$("share-nomail").shown).toBe(true);
    tab.$("share-save").click();
    await drive(tab);
    expect(boxOpen(tab)).toBe(false);
    expect((await send(s.deps, "GET", `/api/v1/tours/${s.id}/access`, { token: s.owner.token })).json).toMatchObject({ access: "public", can_restrict: false });
  });
});
