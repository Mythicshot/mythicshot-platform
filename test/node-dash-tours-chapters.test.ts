// A tour's chapters, on the Tours page (0.1.55, the approved mockup of the Chapters box):
// "Chapters…" in More, the box with its rows, moving, removing and putting back, the caution,
// Save changes and how it ends, Cancel, the keyboard, and a stale revision. The page's scripts
// run under Node against a stand-in document (test/node-tours-page.ts), first with answers
// from the test, then against the real app. Node only: the Workers runtime runs no code from a
// string.
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { clone, commit, createUpload, fixtures, putStep, send, stepImage, uploadTour, type Json } from "./bundle.ts";
import { FakeElement } from "./pages-dom.ts";
import {
  CSRF,
  FAILED,
  FIREFOX,
  MOCKUP_TOURS,
  T1,
  T2,
  T3,
  type Answer,
  type Tab,
  browser,
  byText,
  checkTabs,
  day,
  holding,
  key,
  menuItems,
  openTours,
  rowButtons,
  rows,
  shown,
  standard,
  toursAnswer,
} from "./node-tours-page.ts";

afterEach(checkTabs);

const C1 = "ch_" + "a".repeat(24);
const C2 = "ch_" + "b".repeat(24);
const C3 = "ch_" + "c".repeat(24);
const path = (id: string) => `/api/v1/tours/${id}/chapters`;
const chapter = (id: string, title: string, steps: number, pictures: number, uploaded: number | null) => ({ id, title, position: 0, steps, pictures, uploaded_at: uploaded });
const LIST = (revision = 7) => ({
  revision,
  chapters: [chapter(C1, "Getting started", 5, 5, day(2026, 11, 2)), chapter(C2, "Raid groups", 8, 7, day(2026, 11, 18)), chapter(C3, "Loot rules", 1, 1, null)].map((c, i) => ({ ...c, position: i })),
});
const answer = (revision = 7): Answer => ({ status: 200, json: LIST(revision) });
const STALE = "This tour changed while the box was open. The chapters were loaded again; nothing was saved.";
const LAST = "A tour needs at least one chapter. Delete the tour instead.";

const boxOpen = (tab: Tab) => !tab.$("chapters-dialog").hidden;
const chapterRows = (tab: Tab) => tab.$("chapters-list").children.filter((c): c is FakeElement => c instanceof FakeElement);
/** Each row as a person sees it: its title line, its details line, and its buttons by accessible name (disabled ones marked). */
const shownRows = (tab: Tab) =>
  chapterRows(tab).map((r) => {
    const name = r.all().find((e) => e.className === "ch-name")!;
    const details = r.all().find((e) => e.className === "ch-d")!;
    const buttons = r.all().filter((e) => e.tagName === "button").map((b) => (b.getAttribute("aria-label") ?? b.textContent) + (b.disabled || b.getAttribute("aria-disabled") === "true" ? " (off)" : ""));
    return [name.textContent, details.children.map((c) => (c instanceof FakeElement ? c.textContent : "")).join(" | "), buttons.join(", ")];
  });
const rowButton = (tab: Tab, i: number, name: string) => {
  const b = chapterRows(tab)[i].all().find((e) => e.tagName === "button" && (e.getAttribute("aria-label") ?? e.textContent) === name);
  if (!b) throw new Error(`no ${name} in row ${i}`);
  return b;
};
const puts = (tab: Tab) => tab.fetched.filter((f) => f.method === "PUT");
const entry = (row: FakeElement, text: string) => {
  const found = menuItems(row).find((m) => m.textContent === text);
  if (!found) throw new Error(`no "${text}" in the menu`);
  return found;
};
async function openChapters(tab: Tab, i: number): Promise<void> {
  const row = rows(tab)[i];
  byText(row, "More").click();
  entry(row, "Chapters…").click();
  await tab.settle();
}

describe("the Chapters box", () => {
  it("is in every tour's More, after Sharing, and the hint names it", async () => {
    const tab = openTours(standard());
    await tab.settle();
    expect(rows(tab).map((r) => menuItems(r).map((m) => m.textContent))).toEqual([
      ["Sharing…", "Chapters…", "Unpublish", "Delete"],
      ["Sharing…", "Chapters…", "Publish changes", "Unpublish", "Delete"],
      ["Chapters…", "Delete"],
    ]);
    expect(tab.$("tours-hint").textContent).toBe('"Changes waiting" means Mythicshot uploaded a newer version that visitors do not see yet. "More" holds: Sharing, Chapters, Publish changes, Unpublish, Delete.');
  });

  it("reads the chapters first, then opens as the mockup: the heading, the line, one row per chapter with its buttons, Save changes off", async () => {
    const held = holding((req) => req.path === path(T2), standard());
    const tab = openTours(held.respond);
    await tab.settle();
    await openChapters(tab, 1);
    // Nothing opens before the answer, and nothing else can start meanwhile.
    expect(boxOpen(tab)).toBe(false);
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(true);
    held.answer(answer());
    await tab.settle();
    expect(tab.fetched.filter((f) => f.path === path(T2)).map((f) => [f.method, f.headers["X-Csrf-Token"], f.body])).toEqual([["GET", undefined, undefined]]);
    expect(boxOpen(tab)).toBe(true);
    expect(tab.$("chapters-box").getAttribute("role")).toBe("dialog");
    expect(tab.$("chapters-box").getAttribute("aria-modal")).toBe("true");
    expect(tab.$("chapters-title").textContent).toBe('Chapters of "Loot master setup"');
    expect(tab.$("chapters-sub").textContent).toBe("Visitors see the chapters in this order.");
    expect(shownRows(tab)).toEqual([
      ["1. Getting started", `5 steps · uploaded ${shown(day(2026, 11, 2))}`, "Move up (off), Move down, Remove"],
      ["2. Raid groups", `8 steps · uploaded ${shown(day(2026, 11, 18))}`, "Move up, Move down, Remove"],
      // An upload time the site does not know is left out.
      ["3. Loot rules", "1 step", "Move up, Move down (off), Remove"],
    ]);
    // The move buttons show arrows and are named for a screen reader; each button is described by its chapter's title.
    expect([rowButton(tab, 1, "Move up").textContent, rowButton(tab, 1, "Move down").textContent]).toEqual(["↑", "↓"]);
    for (const b of chapterRows(tab)[1].all().filter((e) => e.tagName === "button")) {
      expect(b.getAttribute("type")).toBe("button");
      expect(tab.doc.getElementById(b.getAttribute("aria-describedby")!)!.textContent).toBe("2. Raid groups");
    }
    expect(tab.$("chapters-warn").shown).toBe(false);
    expect([tab.$("chapters-cancel").textContent, tab.$("chapters-save").textContent, tab.$("chapters-save").disabled]).toEqual(["Cancel", "Save changes", true]);
    // The focus starts on the first row's first button that works, and the page behind is inert.
    expect(tab.doc.activeElement).toBe(rowButton(tab, 0, "Move down"));
    expect(tab.$("tours-page").getAttribute("inert")).toBe("");
    expect(puts(tab)).toEqual([]);
  });

  it("shows other people's titles as text, each in its own isolated element", async () => {
    const odd = { revision: 1, chapters: [chapter(C1, '<img src=x onerror="alert(1)">', 1, 1, null), chapter(C2, "‮evil", 1, 1, null)] };
    const tab = openTours(standard({ "GET /api/v1/tours": toursAnswer([{ ...MOCKUP_TOURS[0], title: "<b>Bold</b>" }]), [`GET ${path(T1)}`]: { status: 200, json: odd } }));
    await tab.settle();
    await openChapters(tab, 0);
    expect(tab.$("chapters-title").children.map((c) => [(c as FakeElement).className, (c as FakeElement).textContent])).toEqual([
      ["", 'Chapters of "'],
      ["name", "<b>Bold</b>"],
      ["", '"'],
    ]);
    const names = chapterRows(tab).map((r) => r.all().find((e) => e.className === "ch-name")!.children.map((c) => [(c as FakeElement).className, (c as FakeElement).textContent]));
    expect(names).toEqual([
      [["", "1. "], ["name", '<img src=x onerror="alert(1)">']],
      [["", "2. "], ["name", "‮evil"]],
    ]);
    expect(tab.doc.root.all().some((e) => e.tagName === "img" && e.getAttribute("src") === "x")).toBe(false);
  });

  it("moves a chapter up and down, says which rows moved, keeps the focus on the button pressed, and Save changes follows whether anything changed", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: answer() }));
    await tab.settle();
    await openChapters(tab, 1);
    rowButton(tab, 0, "Move down").click();
    expect(shownRows(tab).map((r) => [r[0], r[1].split(" | ")[1] ?? ""])).toEqual([
      ["1. Raid groups", "moved up"],
      ["2. Getting started", "moved down"],
      ["3. Loot rules", ""],
    ]);
    expect(tab.doc.activeElement).toBe(rowButton(tab, 1, "Move down"));
    expect(tab.$("chapters-save").disabled).toBe(false);
    // Down again: to the last row, whose Move down is off, so the focus goes to its Move up.
    rowButton(tab, 1, "Move down").click();
    expect(shownRows(tab).map((r) => r[0])).toEqual(["1. Raid groups", "2. Loot rules", "3. Getting started"]);
    expect(tab.doc.activeElement).toBe(rowButton(tab, 2, "Move up"));
    rowButton(tab, 2, "Move up").click();
    rowButton(tab, 1, "Move up").click();
    // Back as it was: no notes, and nothing to save.
    expect(shownRows(tab).map((r) => [r[0], r[1].includes("moved")])).toEqual([["1. Getting started", false], ["2. Raid groups", false], ["3. Loot rules", false]]);
    expect(tab.doc.activeElement).toBe(rowButton(tab, 0, "Move down"));
    expect(tab.$("chapters-save").disabled).toBe(true);
    expect(puts(tab)).toEqual([]);
  });

  it("Remove strikes a row through and moves it to the end, the others close up, the caution says what goes, and Put back undoes it", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: answer() }));
    await tab.settle();
    await openChapters(tab, 1);
    rowButton(tab, 1, "Remove").click();
    expect(shownRows(tab)).toEqual([
      ["1. Getting started", `5 steps · uploaded ${shown(day(2026, 11, 2))}`, "Move up (off), Move down, Remove"],
      ["2. Loot rules", "1 step", "Move up, Move down (off), Remove"],
      ["Raid groups", `8 steps · uploaded ${shown(day(2026, 11, 18))}`, "Put back"],
    ]);
    const gone = chapterRows(tab)[2];
    expect(gone.className).toBe("ch gone");
    expect(gone.all().find((e) => e.className === "ch-name")!.children.map((c) => (c as FakeElement).tagName)).toEqual(["s"]);
    expect(tab.doc.activeElement).toBe(rowButton(tab, 2, "Put back"));
    // The caution box: the existing style (its icon and border), with the title isolated.
    const warn = tab.$("chapters-warn");
    expect([warn.shown, warn.className]).toEqual([true, "warn-box"]);
    expect(warn.textContent).toBe('Removing "Raid groups" deletes its 7 pictures for good. Visitors keep seeing the tour as it is until you publish.');
    expect(warn.children.map((c) => (c as FakeElement).className)).toEqual(["", "name", ""]);
    expect(tab.$("chapters-box").getAttribute("aria-describedby")).toBe("chapters-sub chapters-warn");
    expect(tab.$("chapters-save").disabled).toBe(false);
    // A second: the sentence counts the chapters and all their pictures; the last one cannot go.
    rowButton(tab, 1, "Remove").click();
    expect(warn.textContent).toBe("Removing 2 chapters deletes their 8 pictures for good. Visitors keep seeing the tour as it is until you publish.");
    expect(shownRows(tab).map((r) => [r[0], r[2]])).toEqual([
      ["1. Getting started", "Move up (off), Move down (off), Remove (off)"],
      ["Raid groups", "Put back"],
      ["Loot rules", "Put back"],
    ]);
    const last = rowButton(tab, 0, "Remove");
    expect([last.disabled, last.getAttribute("aria-disabled"), last.getAttribute("title")]).toEqual([false, "true", LAST]);
    last.click();
    expect(chapterRows(tab)).toHaveLength(3);
    expect(shownRows(tab)[0][0]).toBe("1. Getting started");
    // One picture is said in the singular.
    rowButton(tab, 1, "Put back").click();
    expect(warn.textContent).toBe('Removing "Loot rules" deletes its 1 picture for good. Visitors keep seeing the tour as it is until you publish.');
    // Raid groups went back to its place.
    expect(shownRows(tab).map((r) => r[0])).toEqual(["1. Getting started", "2. Raid groups", "Loot rules"]);
    expect(tab.doc.activeElement).toBe(rowButton(tab, 1, "Remove"));
    rowButton(tab, 2, "Put back").click();
    expect(shownRows(tab).map((r) => r[0])).toEqual(["1. Getting started", "2. Raid groups", "3. Loot rules"]);
    expect(warn.shown).toBe(false);
    expect(tab.$("chapters-box").getAttribute("aria-describedby")).toBe("chapters-sub");
    expect(tab.$("chapters-save").disabled).toBe(true);
    expect(puts(tab)).toEqual([]);
  });

  it("a tour of one chapter offers no move and no removal", async () => {
    const tab = openTours(standard({ [`GET ${path(T3)}`]: { status: 200, json: { revision: 1, chapters: [chapter(C1, "Only one", 6, 6, day(2026, 11, 17))] } } }));
    await tab.settle();
    await openChapters(tab, 2);
    expect(shownRows(tab)).toEqual([["1. Only one", `6 steps · uploaded ${shown(day(2026, 11, 17))}`, "Move up (off), Move down (off), Remove (off)"]]);
    expect(tab.doc.activeElement).toBe(tab.$("chapters-cancel"));
  });

  it("Cancel, Escape and the backdrop close it with nothing sent, the focus back on More; opened again it reads the chapters again", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: answer() }));
    await tab.settle();
    for (const close of [() => tab.$("chapters-cancel").click(), () => key(tab.doc.body, "Escape"), () => tab.$("chapters-dialog").click()]) {
      await openChapters(tab, 1);
      rowButton(tab, 0, "Remove").click();
      close();
      expect(boxOpen(tab)).toBe(false);
      expect(tab.doc.activeElement).toBe(byText(rows(tab)[1], "More"));
      expect(tab.$("tours-page").hasAttribute("inert")).toBe(false);
    }
    await openChapters(tab, 1);
    expect(shownRows(tab).map((r) => r[0])).toEqual(["1. Getting started", "2. Raid groups", "3. Loot rules"]);
    expect(tab.fetched.filter((f) => f.path === path(T2))).toHaveLength(4);
    expect(puts(tab)).toEqual([]);
  });

  it("Tab goes round the rows' buttons that work, then Cancel and Save changes", async () => {
    const tab = openTours(standard({ [`GET ${path(T2)}`]: answer() }));
    await tab.settle();
    await openChapters(tab, 1);
    rowButton(tab, 2, "Remove").click();
    const order: string[] = [];
    const nameOf = (e: FakeElement | null) => (e === null ? "" : e.id || (e.getAttribute("aria-label") ?? e.textContent) + " " + tab.doc.getElementById(e.getAttribute("aria-describedby") ?? "")?.textContent);
    rowButton(tab, 0, "Move down").focus();
    for (let i = 0; i < 9; i++) {
      order.push(nameOf(tab.doc.activeElement));
      key(tab.doc.body, "Tab");
    }
    expect(order).toEqual([
      "Move down 1. Getting started",
      "Remove 1. Getting started",
      "Move up 2. Raid groups",
      "Remove 2. Raid groups",
      "Put back Loot rules",
      "chapters-cancel",
      "chapters-save",
      "Move down 1. Getting started",
      "Remove 1. Getting started",
    ]);
    // Shift+Tab goes back.
    key(tab.doc.body, "Tab", true);
    expect(nameOf(tab.doc.activeElement)).toBe("Remove 1. Getting started");
  });

  it("Save changes sends the kept ids in order with the revision, once, with the anti-forgery header; then the box closes and the list shows Changes waiting", async () => {
    const waiting = MOCKUP_TOURS.map((t) => (t.id === T1 ? { ...t, unpublished_changes: true } : t));
    const held = holding((req) => req.method === "PUT", standard({ [`GET ${path(T1)}`]: answer(), "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(waiting)] }));
    const tab = openTours(held.respond);
    await tab.settle();
    expect(rows(tab)[0].all().filter((e) => e.className === "tag warn").map((e) => e.textContent)).toEqual([]);
    await openChapters(tab, 0);
    rowButton(tab, 2, "Move up").click();
    rowButton(tab, 0, "Remove").click();
    tab.$("chapters-save").click();
    // While it runs: Saving…, every control off, and a second press sends nothing.
    expect([tab.$("chapters-save").textContent, tab.$("chapters-save").getAttribute("aria-busy")]).toEqual(["Saving…", "true"]);
    for (const b of chapterRows(tab).flatMap((r) => r.all().filter((e) => e.tagName === "button"))) expect(b.disabled).toBe(true);
    expect(tab.$("chapters-cancel").disabled).toBe(true);
    tab.$("chapters-save").click();
    key(tab.doc.body, "Escape");
    expect(boxOpen(tab)).toBe(true);
    held.answer({ status: 200, json: { revision: 8, chapters: [chapter(C3, "Loot rules", 1, 1, null), chapter(C2, "Raid groups", 8, 7, null)] } });
    await tab.settle();
    expect(puts(tab).map((f) => [f.path, f.headers["X-Csrf-Token"], f.headers["content-type"], JSON.parse(f.body!)])).toEqual([[path(T1), CSRF, "application/json", { revision: 7, chapters: [C3, C2] }]]);
    expect(boxOpen(tab)).toBe(false);
    expect(rows(tab)[0].all().filter((e) => e.className === "tag warn").map((e) => e.textContent)).toEqual(["Changes waiting"]);
    expect(tab.$("tours-message").shown).toBe(false);
    expect(tab.doc.activeElement).toBe(byText(rows(tab)[0], "More"));
  });

  it("a stale revision says so, reads the chapters again with the edits dropped, and sends nothing more", async () => {
    const tab = openTours(standard({
      [`GET ${path(T1)}`]: [answer(7), { status: 200, json: { revision: 9, chapters: [chapter(C2, "Raid groups", 8, 7, null), chapter(C1, "Getting started", 5, 5, null)] } }],
      [`PUT ${path(T1)}`]: { status: 409, json: { error: "tour_changed", detail: "x" } },
    }));
    await tab.settle();
    await openChapters(tab, 0);
    rowButton(tab, 0, "Remove").click();
    tab.$("chapters-save").click();
    await tab.settle();
    expect(boxOpen(tab)).toBe(true);
    expect(tab.$("chapters-message").textContent).toBe(STALE);
    expect(shownRows(tab).map((r) => r[0])).toEqual(["1. Raid groups", "2. Getting started"]);
    expect(tab.$("chapters-warn").shown).toBe(false);
    expect(tab.$("chapters-save").disabled).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("chapters-title"));
    expect(puts(tab)).toHaveLength(1);
    // A save from here sends the new revision.
    rowButton(tab, 1, "Move up").click();
    expect(tab.$("chapters-message").shown).toBe(false);
  });

  it("a lost answer is decided by the chapters as they are now: saved when they are what was sent, else the edits stay and it says it failed", async () => {
    const saved = openTours(standard({
      [`GET ${path(T1)}`]: [answer(7), { status: 200, json: { revision: 8, chapters: [chapter(C1, "Getting started", 5, 5, null), chapter(C3, "Loot rules", 1, 1, null)] } }],
      [`PUT ${path(T1)}`]: "network",
    }));
    await saved.settle();
    await openChapters(saved, 0);
    rowButton(saved, 1, "Remove").click();
    saved.$("chapters-save").click();
    await saved.settle();
    expect(boxOpen(saved)).toBe(false);
    expect(saved.$("tours-message").shown).toBe(false);

    const lost = openTours(standard({ [`GET ${path(T1)}`]: answer(7), [`PUT ${path(T1)}`]: [{ status: 500, json: { error: "internal" } }] }));
    await lost.settle();
    await openChapters(lost, 0);
    rowButton(lost, 1, "Remove").click();
    lost.$("chapters-save").click();
    await lost.settle();
    expect(boxOpen(lost)).toBe(true);
    expect(lost.$("chapters-message").textContent).toBe(FAILED);
    expect(shownRows(lost).map((r) => r[0])).toEqual(["1. Getting started", "2. Loot rules", "Raid groups"]);
    expect(lost.$("chapters-save").disabled).toBe(false);
    expect(lost.doc.activeElement).toBe(lost.$("chapters-save"));
    expect(puts(lost)).toHaveLength(1);
  });

  it("a tour that is gone closes the box and the list shows it gone; a chapters list that cannot be read opens nothing and says so", async () => {
    const gone = openTours(standard({ [`GET ${path(T1)}`]: [answer(), { status: 404, json: { error: "not_found", detail: "no such tour" } }], [`PUT ${path(T1)}`]: { status: 404, json: { error: "not_found", detail: "no such tour" } }, "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(MOCKUP_TOURS.slice(1))] }));
    await gone.settle();
    await openChapters(gone, 0);
    rowButton(gone, 0, "Remove").click();
    gone.$("chapters-save").click();
    await gone.settle();
    expect(boxOpen(gone)).toBe(false);
    expect(rows(gone)).toHaveLength(2);

    const broken = openTours(standard({ [`GET ${path(T1)}`]: { status: 200, json: { revision: "7", chapters: [] } } }));
    await broken.settle();
    await openChapters(broken, 0);
    expect(boxOpen(broken)).toBe(false);
    expect(broken.$("tours-message").textContent).toBe(FAILED);
    for (const b of rowButtons(broken)) expect(b.disabled).toBe(false);
  });
});

describe("the Chapters box against the real app", () => {
  it("reorders and removes a published tour's chapters through the API; the row then says Changes waiting", { timeout: 60_000 }, async () => {
    const { deps, draftKeys } = await makeDeps({ retiredGraceMs: 0 });
    await seedAccount(deps, { admin: true, username: "chapters-admin" });
    const owner = await seedAccount(deps, { username: "chapters" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), FIREFOX, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;
    const first = await uploadTour(deps, owner.token, fixtures.v2 as Json);
    const m = clone(fixtures.v2 as Json);
    m.title = "Second chapter";
    const id = (await createUpload(deps, owner.token, m, { kind: "chapter", tour_id: first.tour_id })).json.upload_id as string;
    for (let i = 0; i < m.steps.length; i++) expect((await putStep(deps, owner.token, id, i + 1, stepImage(m.steps[i], 7))).status).toBe(204);
    const second = (await commit(deps, owner.token, id)).json.chapter_id as string;
    let r = await send(deps, "POST", `/api/v1/tours/${first.tour_id}/publish`, { token: owner.token });
    while (r.status === 202) r = await send(deps, "POST", `/api/v1/tours/${first.tour_id}/publish`, { token: owner.token, body: JSON.stringify({ publish_id: r.json.publish_id }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(200);

    const tab = openTours(browser(deps, cookie));
    await tab.settle();
    await openChapters(tab, 0);
    expect(shownRows(tab).map((x) => x[0])).toEqual([`1. ${(fixtures.v2 as Json).title}`, "2. Second chapter"]);
    rowButton(tab, 0, "Remove").click();
    tab.$("chapters-save").click();
    await tab.settle();
    expect(boxOpen(tab)).toBe(false);
    expect(rows(tab)[0].all().filter((e) => e.className === "tag warn").map((e) => e.textContent)).toEqual(["Changes waiting"]);
    const now = (await send(deps, "GET", `/api/v1/tours/${first.tour_id}/chapters`, { token: owner.token })).json;
    expect(now.chapters.map((c: Json) => c.id)).toEqual([second]);
    // The removed chapter's pictures are gone from the drafts store; the kept ones and the live copies stay.
    const keys = await draftKeys();
    expect(keys.some((k) => k.startsWith(`u/up_${first.chapter_id.slice(3)}/`))).toBe(false);
    expect(keys.some((k) => k.startsWith(`u/${id}/`))).toBe(true);
  });
});
