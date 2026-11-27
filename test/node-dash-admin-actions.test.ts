// What the Admin page's script does for invites and for an account as a whole, when it runs
// (the harness is test/node-admin-page.ts): the invite card and its outcomes, the open invites
// with Resend and Cancel, the More menu of each account, Disable, Enable and Delete with its
// progress, and the house rules: one question or menu at a time, also while a request runs;
// a held key presses nothing; a second click sends one request; a lost answer is decided by
// the list read again; other people's text only ever as text; and a member learns nothing.
//
// What this leaves unproven, for docs/dashboard-browser-check.md: real layout at phone
// width, focus rings, `inert` as a browser applies it, and a screen reader.
import { isBrandMark } from "./dash-checks.ts";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE } from "../src/sessions.ts";
import { INVITE_HTML, INVITE_JS } from "../src/signin/accept.ts";
import { send } from "./bundle.ts";
import { FakeDocument, FakeElement } from "./pages-dom.ts";
import {
  APP,
  CSRF,
  FAILED,
  FIREFOX,
  MB,
  MOCKUP,
  MOCKUP_USED,
  NOT_FOUND,
  SIGNED_OUT,
  STANDARD,
  TOO_MANY,
  U1,
  U2,
  U3,
  W2,
  W3,
  account,
  answers,
  browser,
  checkTabs,
  choose,
  drain,
  entries,
  inviteList,
  key,
  list,
  more,
  of,
  openAdmin,
  rowOf,
  rows,
  session,
  sessionOf,
  standard,
  summary,
  type,
  type Answer,
  type Fetched,
  type Tab,
} from "./node-admin-page.ts";

afterEach(checkTabs);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A date as the page writes it with the year, in this process's time zone. */
const long = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
/** A date as the page writes it in "Ran out": the year only when it is not this year. */
const short = (ms: number) => {
  const d = new Date(ms);
  const text = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date().getFullYear() ? text : `${text} ${d.getFullYear()}`;
};
const DAY = 86_400_000;
const NOW = Date.now();

const I1 = "inv_" + "a".repeat(24);
const I2 = "inv_" + "b".repeat(24);
const I3 = "inv_" + "c".repeat(24);
const U4 = "usr_" + "4".repeat(24);
const U5 = "usr_" + "5".repeat(24);
const W4 = "ws_" + "4".repeat(24);
const W5 = "ws_" + "5".repeat(24);

const invite = (id: string, email: string, created: number, state: "open" | "expired" = "open") => ({ id, email, created_at: created, expires_at: created + 7 * DAY, state });
/** The two invites of the invites set's mockup 1: one open, one that ran out. */
const MARA = invite(I1, "mara@example.com", NOW - DAY);
const BRAM = invite(I2, "bram@example.com", NOW - 9 * DAY, "expired");

const MAIL_OFF = "This site cannot send mail, so nobody can be invited from here.";
const MAIL_FAILED = "The invite was saved, but the mail could not be sent. Press Resend to try again.";
const BAD_EMAIL = "That does not look like an email address.";
const HAS_ACCOUNT = "That address already has an account.";
const TOO_MANY_INVITES = "There are 100 open invites already. Cancel one you no longer need first.";
const GONE = "That invite is no longer open: it was used or cancelled meanwhile.";
const NOT_RELOADED = "The change was made, but the list could not be loaded again. Reload the page to see it.";
const refused = (status: number, error: string): Answer => ({ status, json: { error, detail: "the API's own words" } });

const invRows = (tab: Tab) => tab.$("invites-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
const button = (row: FakeElement, text: string) => row.all().find((e) => e.tagName === "button" && e.textContent === text)!;
/** What one invite row shows, cell by cell, and the phone's line under its address. */
function invOf(row: FakeElement) {
  const [what, sent, until] = row.children.filter((c): c is FakeElement => c instanceof FakeElement);
  return {
    address: what.all().find((e) => e.className === "t name")!.textContent,
    phone: what.all().find((e) => e.className === "d narrow-only")!.textContent,
    sent: sent.textContent,
    until: until.textContent,
    tags: until.all().filter((e) => e.className === "tag warn").map((e) => e.textContent),
    buttons: row.all().filter((e) => e.tagName === "button").map((b) => [b.textContent, b.className]),
  };
}
const inviteSays = (tab: Tab) => [tab.$("invite-message").textContent, tab.$("invite-message").shown];
const noteOf = (tab: Tab, id: string) => (tab.$(id).shown ? [tab.$(id).textContent, tab.$(id).className] : null);

async function opened(respond: (req: Fetched) => Answer | Promise<Answer>): Promise<Tab> {
  const tab = openAdmin(respond);
  await tab.settle();
  return tab;
}

// ---- The invites card ----

describe("the invites: the list", () => {
  it("shows mockup 1: each invite's address, the day it was sent, the day it works until or the amber 'Ran out', and Resend and Cancel", async () => {
    const tab = await opened(standard({ "GET /api/v1/admin/invites": inviteList([MARA, BRAM]) }));
    expect(tab.$("invites").shown).toBe(true);
    expect(invRows(tab).map(invOf)).toEqual([
      { address: "mara@example.com", phone: `sent ${long(MARA.created_at)} · works until ${long(MARA.expires_at)}`, sent: long(MARA.created_at), until: long(MARA.expires_at), tags: [], buttons: [["Resend", "btn sm quiet"], ["Cancel", "btn sm danger"]] },
      { address: "bram@example.com", phone: `sent ${long(BRAM.created_at)} · Ran out ${short(BRAM.expires_at)}`, sent: long(BRAM.created_at), until: `Ran out ${short(BRAM.expires_at)}`, tags: [`Ran out ${short(BRAM.expires_at)}`], buttons: [["Resend", "btn sm quiet"], ["Cancel", "btn sm danger"]] },
    ]);
    expect([tab.$("invites-table").shown, tab.$("invites-empty").shown]).toEqual([true, false]);
    // Each button names its invite for a screen reader.
    for (const [i, row] of invRows(tab).entries()) for (const b of row.all().filter((e) => e.tagName === "button")) expect([b.getAttribute("type"), b.getAttribute("aria-describedby")]).toEqual(["button", `invite-${i}`]);
  });

  it("with no invites the card says so quietly; a list that cannot be read says why and the accounts stay", async () => {
    const empty = await opened(standard());
    expect([empty.$("invites-table").shown, empty.$("invites-empty").shown, empty.$("invites-empty").textContent]).toEqual([false, true, "No open invites."]);
    for (const [answer, text] of [[{ status: 500, json: { error: "internal" } }, FAILED], [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY], ["network", FAILED], [{ status: 200, json: { invites: "x" } }, FAILED]] as const) {
      const tab = await opened(standard({ "GET /api/v1/admin/invites": answer as Answer }));
      expect([tab.$("invites").shown, tab.$("invites-message").textContent, tab.$("invites-table").shown, tab.$("invites-empty").shown], JSON.stringify(answer)).toEqual([true, text, false, false]);
      expect(rows(tab)).toHaveLength(3);
    }
    // An invites route that answers 404 means this session is no admin: the missing page.
    const gone = await opened(standard({ "GET /api/v1/admin/invites": NOT_FOUND }));
    expect(gone.shows()).toEqual(["Mythicshot", "morgan", "Page not found", "Back to Tours"]);
  });

  it("shows addresses holding markup, quotes, right-to-left letters and great length as text, each in its own isolated element", async () => {
    const odd = [
      invite(I1, '"<img src=x onerror=alert(1)>"@example.com', NOW),
      invite(I2, "‮evil‬@example.com", NOW),
      invite(I3, "a".repeat(64) + "@" + "b".repeat(60) + ".example.com", NOW),
    ];
    const tab = await opened(standard({ "GET /api/v1/admin/invites": inviteList(odd), ["DELETE /api/v1/admin/invites/" + I1]: { status: 204 } }));
    expect(invRows(tab).map((r) => invOf(r).address)).toEqual(odd.map((v) => v.email));
    expect(tab.doc.root.all().some((e) => ((e.tagName === "img" && !isBrandMark(e)) || e.tagName === "script") && e.parent?.tagName !== "head")).toBe(false);
    button(invRows(tab)[0], "Cancel").click();
    const title = tab.$("cancel-title");
    expect(title.textContent).toBe(`Cancel the invite to ${odd[0].email}?`);
    // The address sits alone in a bidi-isolated element between the fixed words.
    expect(title.children.map((c) => (c instanceof FakeElement ? [c.className, c.textContent] : null))).toEqual([["", "Cancel the invite to "], ["name", odd[0].email], ["", "?"]]);
  });

  it("ignores an invite whose id is not of the API's shape, so no such id ever goes into an address", async () => {
    const tab = await opened(standard({ "GET /api/v1/admin/invites": inviteList([invite("inv_../../accounts", "x@example.com", NOW), invite("INV_" + "a".repeat(24), "y@example.com", NOW), MARA]) }));
    expect(invRows(tab).map((r) => invOf(r).address)).toEqual(["mara@example.com"]);
  });
});

describe("the invites: sending one", () => {
  const entry = invite(I3, "tess@example.com", NOW);

  it("sends the address in the body only, says it is on its way until the day it works, clears the field and reads the list again", async () => {
    const tab = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA]), inviteList([entry, MARA])], "POST /api/v1/admin/invites": { status: 201, json: entry } }));
    type(tab, "  Tess@Example.com ", "invite-email");
    const go = tab.$("invite-go");
    go.click();
    // While it runs: "Sending…", and nothing on the page can start anything else.
    expect([go.textContent, go.disabled, go.getAttribute("aria-busy")]).toEqual(["Sending…", true, "true"]);
    expect(more(rows(tab)[1]).disabled).toBe(true);
    expect(button(invRows(tab)[0], "Resend").disabled).toBe(true);
    await tab.settle();
    const sent = of(tab, "POST", "/api/v1/admin/invites");
    expect(sent.map((f) => [f.headers["X-Csrf-Token"], f.headers["content-type"], f.body])).toEqual([[CSRF, "application/json", '{"email":"Tess@Example.com"}']]);
    expect(noteOf(tab, "invite-note")).toEqual([`An invite is on its way to tess@example.com. The link works once and until ${long(entry.expires_at)}.`, "note"]);
    expect(tab.$("invite-note").all().find((e) => e.className === "name")!.textContent).toBe("tess@example.com");
    expect(tab.$("invite-email").value).toBe("");
    expect(of(tab, "GET", "/api/v1/admin/invites")).toHaveLength(2);
    expect(invRows(tab).map((r) => invOf(r).address)).toEqual(["tess@example.com", "mara@example.com"]);
    expect([go.textContent, go.disabled, more(rows(tab)[1]).disabled]).toEqual(["Send invite", false, false]);
    expect(tab.doc.activeElement).toBe(tab.$("invite-email"));
    // No address went into any path.
    for (const f of tab.fetched) expect(f.path).not.toMatch(/@|tess/i);
  });

  it("says what each refusal means, in plain words, and keeps the field", async () => {
    for (const [answer, text, reads] of [
      [refused(409, "has_account"), HAS_ACCOUNT, 1],
      [{ status: 400, json: { error: "bad_email" } }, BAD_EMAIL, 1],
      [refused(400, "bad_request"), BAD_EMAIL, 1],
      [refused(409, "mail_off"), MAIL_OFF, 1],
      [refused(409, "too_many_invites"), TOO_MANY_INVITES, 1],
      // The invite was saved: the list is read again and shows it.
      [refused(502, "mail_failed"), MAIL_FAILED, 2],
      [{ status: 500, json: { error: "internal" } }, FAILED, 1],
    ] as const) {
      const tab = await opened(standard({ "POST /api/v1/admin/invites": answer as Answer }));
      type(tab, "tess@example.com", "invite-email");
      tab.$("invite-go").click();
      await tab.settle();
      expect(inviteSays(tab), JSON.stringify(answer)).toEqual([text, true]);
      expect(tab.$("invite-email").value).toBe("tess@example.com");
      expect(of(tab, "GET", "/api/v1/admin/invites"), JSON.stringify(answer)).toHaveLength(reads);
      expect(tab.$("invite-note").shown).toBe(false);
      expect(tab.$("invite-email").getAttribute("aria-invalid")).toBe(text === BAD_EMAIL ? "true" : null);
      expect([tab.$("invite-go").disabled, tab.doc.activeElement]).toEqual([false, tab.$("invite-email")]);
      // Typing again clears it.
      type(tab, "tess@example.org", "invite-email");
      expect(inviteSays(tab)).toEqual(["", false]);
    }
  });

  it("an address of the wrong shape is refused in the page with no request; an empty field sends nothing either", async () => {
    const tab = await opened(standard());
    for (const text of ["mara", "mara@", "@example.com", "a b@example.com", "a@b@example.com", "x".repeat(250) + "@e.co"]) {
      type(tab, text, "invite-email");
      tab.$("invite-go").click();
      expect(inviteSays(tab), text).toEqual([BAD_EMAIL, true]);
      expect(tab.$("invite-email").getAttribute("aria-invalid")).toBe("true");
    }
    type(tab, "   ", "invite-email");
    tab.$("invite-go").click();
    expect(of(tab, "POST", "/api/v1/admin/invites")).toEqual([]);
    expect(tab.doc.activeElement).toBe(tab.$("invite-email"));
  });

  it("Enter in the field sends, once; a held Enter's repeats and a second click send nothing more", async () => {
    const tab = await opened(standard({ "POST /api/v1/admin/invites": { status: 201, json: entry } }));
    type(tab, "tess@example.com", "invite-email");
    expect(key(tab.$("invite-email"), "Enter", false, true).defaultPrevented).toBe(true);
    expect(of(tab, "POST", "/api/v1/admin/invites")).toEqual([]);
    key(tab.$("invite-email"), "Enter");
    key(tab.$("invite-email"), "Enter");
    tab.$("invite-go").dispatch("click");
    await tab.settle();
    expect(of(tab, "POST", "/api/v1/admin/invites")).toHaveLength(1);
    // The button's own held key is held back too.
    expect(key(tab.$("invite-go"), "Enter", false, true).defaultPrevented).toBe(true);
    expect(key(tab.$("invite-go"), " ", false, true).defaultPrevented).toBe(true);
    expect(key(tab.$("invite-go"), "Enter").defaultPrevented).toBe(false);
  });

  it("a 429 rests Send invite and every Resend for the answer's retry-after, as the Connections page rests Continue", async () => {
    const limited = (s?: string): Answer => ({ status: 429, json: { error: "rate_limited" }, headers: s === undefined ? {} : { "retry-after": s } });
    for (const [after, text, ms] of [["90", "Too many invites in a short time. Try again in 2 minutes.", 90_000], ["30", "Too many invites in a short time. Try again in 1 minute.", 30_000], [undefined, "Too many invites in a short time. Try again in 60 minutes.", 3_600_000], ["x", "Too many invites in a short time. Try again in 60 minutes.", 3_600_000]] as const) {
      const tab = await opened(standard({ "GET /api/v1/admin/invites": inviteList([MARA]), "POST /api/v1/admin/invites": limited(after) }));
      type(tab, "tess@example.com", "invite-email");
      tab.$("invite-go").click();
      await tab.settle();
      expect(inviteSays(tab), String(after)).toEqual([text, true]);
      expect([tab.$("invite-go").disabled, button(invRows(tab)[0], "Resend").disabled, button(invRows(tab)[0], "Cancel").disabled]).toEqual([true, true, false]);
      // Nothing sends meanwhile, by click, by Enter, or by Resend.
      tab.$("invite-go").dispatch("click");
      key(tab.$("invite-email"), "Enter");
      button(invRows(tab)[0], "Resend").dispatch("click");
      // Typing does not take the sentence away.
      type(tab, "tess@example.org", "invite-email");
      expect(inviteSays(tab)).toEqual([text, true]);
      expect(tab.fetched.filter((f) => f.method === "POST")).toHaveLength(1);
      expect(tab.pendingDelays()).toEqual([ms]);
      tab.tick();
      expect(inviteSays(tab)).toEqual(["", false]);
      expect([tab.$("invite-go").disabled, button(invRows(tab)[0], "Resend").disabled]).toEqual([false, false]);
    }
  });

  it("when no answer comes, the list read again decides: an invite there now was made, with its mail unknown; otherwise it failed", async () => {
    const made = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA]), inviteList([entry, MARA])], "POST /api/v1/admin/invites": "network" }));
    type(made, "Tess@example.com", "invite-email");
    made.$("invite-go").click();
    await made.settle();
    expect(noteOf(made, "invite-note")).toEqual(["tess@example.com has an invite now, but the answer was lost on the way, so it is not known whether its mail went out. If it does not arrive, press Resend.", "note plain"]);
    expect([made.$("invite-email").value, made.$("invite-message").shown]).toEqual(["", false]);

    // An address that already had an invite, whose dates did not change: nothing was sent.
    const old = invite(I3, "tess@example.com", NOW - 2 * DAY);
    const not = await opened(standard({ "GET /api/v1/admin/invites": inviteList([old]), "POST /api/v1/admin/invites": "network" }));
    type(not, "tess@example.com", "invite-email");
    not.$("invite-go").click();
    await not.settle();
    expect(inviteSays(not)).toEqual([FAILED, true]);
    expect(not.$("invite-note").shown).toBe(false);
    // The same address with new dates was sent again.
    const again = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([old]), inviteList([entry])], "POST /api/v1/admin/invites": "network" }));
    type(again, "tess@example.com", "invite-email");
    again.$("invite-go").click();
    await again.settle();
    expect(noteOf(again, "invite-note")?.[1]).toBe("note plain");
    // And when the list cannot be read either: it failed, as far as the page knows.
    const blind = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([]), "network"], "POST /api/v1/admin/invites": "network" }));
    type(blind, "tess@example.com", "invite-email");
    blind.$("invite-go").click();
    await blind.settle();
    expect(inviteSays(blind)).toEqual([FAILED, true]);
  });

  it("a lost session goes to /signin; a 404 (no longer the admin) reads the list and shows the missing page", async () => {
    const out = await opened(standard({ "POST /api/v1/admin/invites": SIGNED_OUT }));
    type(out, "tess@example.com", "invite-email");
    out.$("invite-go").click();
    await out.settle();
    expect(out.left()).toBe("/signin");
    const gone = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([]), NOT_FOUND], "POST /api/v1/admin/invites": NOT_FOUND }));
    type(gone, "tess@example.com", "invite-email");
    gone.$("invite-go").click();
    await gone.settle();
    expect(gone.shows()).toEqual(["Mythicshot", "morgan", "Page not found", "Back to Tours"]);
  });
});

describe("the invites: Resend and Cancel", () => {
  const fresh = { ...MARA, created_at: NOW, expires_at: NOW + 7 * DAY };
  const RESEND = `POST /api/v1/admin/invites/${I1}/resend`;
  const CANCEL = `DELETE /api/v1/admin/invites/${I1}`;

  it("Resend asks nothing: one request, the row's dates are the new ones, and the note says the earlier link no longer works", async () => {
    const tab = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA, BRAM]), inviteList([fresh, BRAM])], [RESEND]: { status: 200, json: fresh } }));
    const again = button(invRows(tab)[0], "Resend");
    again.click();
    expect([again.textContent, again.disabled, tab.$("cancel-dialog").hidden]).toEqual(["Sending…", true, true]);
    again.dispatch("click");
    await tab.settle();
    const sent = of(tab, "POST", `/api/v1/admin/invites/${I1}/resend`);
    expect(sent.map((f) => [f.headers["X-Csrf-Token"], f.body])).toEqual([[CSRF, undefined]]);
    expect(invOf(invRows(tab)[0])).toMatchObject({ sent: long(fresh.created_at), until: long(fresh.expires_at) });
    expect(noteOf(tab, "invites-note")).toEqual(["A new invite is on its way to mara@example.com. The earlier link no longer works.", "note"]);
    expect(tab.doc.activeElement).toBe(button(invRows(tab)[0], "Resend"));
  });

  it("Resend's refusals in plain words; a 404 means the invite is gone and the list is read again", async () => {
    for (const [answer, text] of [
      [refused(409, "has_account"), HAS_ACCOUNT],
      [refused(409, "mail_off"), MAIL_OFF],
      [refused(409, "too_many_invites"), TOO_MANY_INVITES],
      [refused(502, "mail_failed"), MAIL_FAILED],
      [{ status: 500, json: { error: "internal" } }, FAILED],
    ] as const) {
      const tab = await opened(standard({ "GET /api/v1/admin/invites": inviteList([MARA]), [RESEND]: answer as Answer }));
      button(invRows(tab)[0], "Resend").click();
      await tab.settle();
      expect([tab.$("invites-message").textContent, tab.$("invites-message").shown], JSON.stringify(answer)).toEqual([text, true]);
      expect(of(tab, "GET", "/api/v1/admin/invites")).toHaveLength(2);
    }
    const gone = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA, BRAM]), inviteList([BRAM])], [RESEND]: NOT_FOUND }));
    button(invRows(gone)[0], "Resend").click();
    await gone.settle();
    expect(invRows(gone).map((r) => invOf(r).address)).toEqual(["bram@example.com"]);
    expect(gone.$("invites-message").textContent).toBe(GONE);
    expect(gone.doc.activeElement).toBe(gone.$("h-invites"));
  });

  it("when no answer comes to Resend, the list decides: new dates mean a new link (its mail unknown), the same dates a failure, no row a gone invite", async () => {
    const changed = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA]), inviteList([fresh])], [RESEND]: "network" }));
    button(invRows(changed)[0], "Resend").click();
    await changed.settle();
    expect(noteOf(changed, "invites-note")).toEqual(["mara@example.com has a new link, so the earlier one no longer works, but the answer was lost on the way, so it is not known whether its mail went out. If it does not arrive, press Resend again.", "note plain"]);
    const same = await opened(standard({ "GET /api/v1/admin/invites": inviteList([MARA]), [RESEND]: "network" }));
    button(invRows(same)[0], "Resend").click();
    await same.settle();
    expect([same.$("invites-message").textContent, same.$("invites-note").shown]).toEqual([FAILED, false]);
    const gone = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA]), inviteList([])], [RESEND]: "network" }));
    button(invRows(gone)[0], "Resend").click();
    await gone.settle();
    expect(gone.$("invites-message").textContent).toBe(GONE);
    // A full list (100 rows) may have pushed it off the end: not proof that it is gone, so the general sentence.
    const hundred = Array.from({ length: 100 }, (_, i) => invite("inv_" + i.toString(16).padStart(24, "0"), `p${i}@example.com`, NOW - i));
    const full = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA]), inviteList(hundred)], [RESEND]: "network" }));
    button(invRows(full)[0], "Resend").click();
    await full.settle();
    expect([full.$("invites-message").textContent, full.$("invites-note").shown]).toEqual([FAILED, false]);
    // A list that cannot be read cannot say so either.
    const blind = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA]), "network"], [RESEND]: "network" }));
    button(invRows(blind)[0], "Resend").click();
    await blind.settle();
    expect(blind.$("invites-message").textContent).toBe(FAILED);
  });

  it("Cancel asks mockup 2's question first; Keep it, Escape and the backdrop send nothing; Cancel invite cancels and the list is read again", async () => {
    const tab = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA, BRAM]), inviteList([BRAM])], [CANCEL]: { status: 204 } }));
    const drop = button(invRows(tab)[0], "Cancel");
    drop.click();
    expect(tab.$("cancel-dialog").shown).toBe(true);
    expect(tab.shows().slice(-4)).toEqual(["Cancel the invite to mara@example.com?", "The link in the mail stops working. You can invite the same address again later.", "Keep it", "Cancel invite"]);
    expect(tab.doc.activeElement).toBe(tab.$("cancel-keep"));
    expect(tab.doc.body.all().filter((e) => e.hasAttribute("inert")).map((e) => e.id)).toEqual(["dash-top", "admin", "source-line"]);
    tab.$("cancel-keep").click();
    expect([tab.$("cancel-dialog").hidden, tab.doc.activeElement]).toEqual([true, drop]);
    drop.click();
    key(tab.doc.body, "Escape");
    expect(tab.$("cancel-dialog").hidden).toBe(true);
    drop.click();
    tab.$("cancel-dialog").click();
    expect(tab.$("cancel-dialog").hidden).toBe(true);
    expect(tab.fetched.filter((f) => f.method === "DELETE")).toEqual([]);
    drop.click();
    const go = tab.$("cancel-go");
    go.click();
    expect([go.textContent, go.disabled, tab.$("cancel-keep").disabled]).toEqual(["Cancelling…", true, true]);
    key(tab.doc.body, "Escape");
    go.dispatch("click");
    expect(tab.$("cancel-dialog").hidden).toBe(false);
    await tab.settle();
    expect(of(tab, "DELETE", `/api/v1/admin/invites/${I1}`).map((f) => f.headers["X-Csrf-Token"])).toEqual([CSRF]);
    expect(tab.$("cancel-dialog").hidden).toBe(true);
    expect(invRows(tab).map((r) => invOf(r).address)).toEqual(["bram@example.com"]);
    expect(tab.doc.activeElement).toBe(tab.$("h-invites"));
    expect(go.textContent).toBe("Cancel invite");
  });

  it("Cancel: a 404 is done; a failure stays in the question; a lost answer is done only when the whole list no longer has it", async () => {
    const gone = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA]), inviteList([])], [CANCEL]: NOT_FOUND }));
    button(invRows(gone)[0], "Cancel").click();
    gone.$("cancel-go").click();
    await gone.settle();
    expect([gone.$("cancel-dialog").hidden, gone.$("invites-empty").shown]).toEqual([true, true]);

    const fails = await opened(standard({ "GET /api/v1/admin/invites": inviteList([MARA]), [CANCEL]: { status: 429, json: { error: "rate_limited" } } }));
    button(invRows(fails)[0], "Cancel").click();
    fails.$("cancel-go").click();
    await fails.settle();
    expect([fails.$("cancel-dialog").hidden, fails.$("cancel-message").textContent, fails.$("cancel-go").disabled]).toEqual([false, TOO_MANY, false]);
    expect(fails.doc.activeElement).toBe(fails.$("cancel-go"));

    const lostDone = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA]), inviteList([BRAM])], [CANCEL]: "network" }));
    button(invRows(lostDone)[0], "Cancel").click();
    lostDone.$("cancel-go").click();
    await lostDone.settle();
    expect(lostDone.$("cancel-dialog").hidden).toBe(true);

    const lostThere = await opened(standard({ "GET /api/v1/admin/invites": inviteList([MARA]), [CANCEL]: "network" }));
    button(invRows(lostThere)[0], "Cancel").click();
    lostThere.$("cancel-go").click();
    await lostThere.settle();
    expect([lostThere.$("cancel-dialog").hidden, lostThere.$("cancel-message").textContent]).toEqual([false, FAILED]);

    // A full list (100 rows) may have pushed it off the end: not proof that it is gone.
    const hundred = Array.from({ length: 100 }, (_, i) => invite("inv_" + i.toString(16).padStart(24, "0"), `p${i}@example.com`, NOW - i));
    const full = await opened(standard({ "GET /api/v1/admin/invites": [inviteList([MARA]), inviteList(hundred)], [CANCEL]: "network" }));
    button(invRows(full)[0], "Cancel").click();
    full.$("cancel-go").click();
    await full.settle();
    expect([full.$("cancel-dialog").hidden, full.$("cancel-message").textContent]).toEqual([false, FAILED]);
  });

  it("the question's held keys press nothing", async () => {
    const tab = await opened(standard({ "GET /api/v1/admin/invites": inviteList([MARA]) }));
    button(invRows(tab)[0], "Cancel").click();
    for (const id of ["cancel-keep", "cancel-go"]) {
      expect(key(tab.$(id), "Enter", false, true).defaultPrevented, id).toBe(true);
      expect(key(tab.$(id), " ", false, true).defaultPrevented, id).toBe(true);
    }
    expect(key(button(invRows(tab)[0], "Resend"), "Enter", false, true).defaultPrevented).toBe(true);
  });
});

// ---- The accounts' More menus ----

const ROOK = account(U4, W4, { username: "rook", email: "rook@example.com", status: "disabled", workspace_name: "Rook's demos", tours: 1, used_bytes: 18 * MB });
const TESS = account(U2, W2, { username: "tess", email: "tess@example.com", workspace_name: "Tess", tours: 3, used_bytes: 210 * MB });

describe("each account's More menu", () => {
  it("holds Set allowance, then Disable or Enable, then Delete for a disabled account; the admin's own row and a row being deleted hold less", async () => {
    const deleting = account(U5, W5, { username: "vale", status: "disabled", deleting: true });
    const odd = account("usr_x", "ws_" + "6".repeat(24), { username: "odd" });
    const otherAdmin = account(U3, W3, { username: "bram", admin: true });
    const tab = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], TESS, ROOK, deleting, odd, otherAdmin]) }));
    expect(rows(tab).map((r) => [rowOf(r).name, rowOf(r).tags, entries(r)])).toEqual([
      ["morgan", ["Admin"], ["Set allowance"]],
      ["tess", [], ["Set allowance", "Disable"]],
      ["rook", ["Disabled"], ["Set allowance", "Enable", "Delete"]],
      ["vale", ["Deleting"], ["Delete"]],
      // An id not of the API's shape never goes into an address: only the allowance, which goes by workspace.
      ["odd", [], ["Set allowance"]],
      // Another admin can be disabled; the API refuses the last one.
      ["bram", ["Admin"], ["Set allowance", "Disable"]],
    ]);
    expect(rows(tab)[3].all().find((e) => e.textContent === "Deleting")!.className).toBe("tag warn");
    // Delete is red; the others are not.
    expect(rows(tab)[2].all().filter((e) => e.getAttribute("role") === "menuitem").map((e) => e.className)).toEqual(["", "", "danger"]);
  });

  it("with no account id of the API's shape in the session, no row offers Disable, Enable or Delete", async () => {
    for (const id of ["usr_1", null, 7]) {
      const tab = await opened(standard({ "GET /api/v1/session": session(true, "morgan", id), "GET /api/v1/admin/accounts": list([MOCKUP[0], TESS, ROOK]) }));
      expect(rows(tab).map(entries), String(id)).toEqual([["Set allowance"], ["Set allowance"], ["Set allowance"]]);
    }
  });

  it("opens with a click or the arrow keys, moves with the arrows, Home and End, closes with Escape back on More, and one menu at a time", async () => {
    const tab = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], TESS, ROOK]) }));
    const [, t, r] = rows(tab);
    const menuOf = (row: FakeElement) => row.all().find((e) => e.getAttribute("role") === "menu")!;
    const items = (row: FakeElement) => row.all().filter((e) => e.getAttribute("role") === "menuitem");
    more(r).click();
    expect([menuOf(r).shown, more(r).getAttribute("aria-expanded"), tab.doc.activeElement]).toEqual([true, "true", items(r)[0]]);
    key(menuOf(r), "ArrowDown");
    expect(tab.doc.activeElement).toBe(items(r)[1]);
    key(menuOf(r), "End");
    expect(tab.doc.activeElement).toBe(items(r)[2]);
    key(menuOf(r), "ArrowDown");
    expect(tab.doc.activeElement).toBe(items(r)[0]);
    key(menuOf(r), "ArrowUp");
    expect(tab.doc.activeElement).toBe(items(r)[2]);
    key(menuOf(r), "Home");
    expect(tab.doc.activeElement).toBe(items(r)[0]);
    key(menuOf(r), "Escape");
    expect([menuOf(r).shown, more(r).getAttribute("aria-expanded"), tab.doc.activeElement]).toEqual([false, "false", more(r)]);
    // ArrowUp on More opens it on the last entry; opening another closes the first.
    key(more(r), "ArrowUp");
    expect(tab.doc.activeElement).toBe(items(r)[2]);
    more(t).click();
    expect([menuOf(r).shown, menuOf(t).shown]).toEqual([false, true]);
    // A held arrow's repeats open nothing; a click elsewhere closes the menu.
    key(menuOf(t), "Escape");
    key(more(r), "ArrowDown", false, true);
    expect(menuOf(r).shown).toBe(false);
    more(t).click();
    tab.$("h-page").click();
    expect(menuOf(t).shown).toBe(false);
    // An entry of a closed menu does nothing.
    items(t)[1].click();
    expect(tab.$("disable-dialog").hidden).toBe(true);
    // A held Enter on More and on an entry is held back.
    expect(key(more(t), "Enter", false, true).defaultPrevented).toBe(true);
    expect(key(items(t)[1], "Enter", false, true).defaultPrevented).toBe(true);
  });

  it("no menu opens while a question is open or a change runs", async () => {
    const held: ((a: Answer) => void)[] = [];
    const tab = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], TESS, ROOK]), [`POST /api/v1/admin/accounts/${U4}/enable`]: () => new Promise<Answer>((r) => held.push(r)) }));
    choose(rows(tab)[1], "Disable");
    expect(tab.$("disable-dialog").shown).toBe(true);
    more(rows(tab)[2]).dispatch("click");
    expect(rows(tab)[2].all().find((e) => e.getAttribute("role") === "menu")!.shown).toBe(false);
    tab.$("disable-keep").click();
    choose(rows(tab)[2], "Enable");
    // The enable runs: every row's More is disabled, and a forced click opens nothing.
    expect(rows(tab).map((r) => more(r).disabled)).toEqual([true, true, true]);
    expect(more(rows(tab)[2]).textContent).toBe("Enabling…");
    more(rows(tab)[1]).dispatch("click");
    expect(rows(tab)[1].all().find((e) => e.getAttribute("role") === "menu")!.shown).toBe(false);
    expect(tab.$("invite-go").disabled).toBe(true);
    held[0]({ status: 204 });
    await tab.settle();
    expect(rows(tab).map((r) => more(r).disabled)).toEqual([false, false, false]);
  });
});

// ---- Disabling and enabling ----

describe("disabling and enabling an account", () => {
  const DISABLE = `POST /api/v1/admin/accounts/${U2}/disable`;
  const ENABLE = `POST /api/v1/admin/accounts/${U2}/enable`;
  const off = { ...TESS, status: "disabled" };

  it("Disable asks mockup 3's question, with the row's tour count, and nothing is sent until Disable account", async () => {
    for (const [tours, words] of [[3, "their 3 tours"], [1, "their 1 tour"], [0, "their tours"]] as const) {
      const tab = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], { ...TESS, tours }]) }));
      choose(rows(tab)[1], "Disable");
      expect(tab.$("disable-dialog").shown).toBe(true);
      expect(tab.shows().slice(-5)).toEqual([
        'Disable "tess"?',
        `From now on tess cannot sign in, Mythicshot on their computers cannot publish, and ${words} and every image and clip they shared stop being available to anyone. Nothing is deleted: enabling the account brings everything back.`,
        "Pictures that people already opened may stay in their browsers.",
        "Keep it",
        "Disable account",
      ]);
      expect(tab.doc.activeElement).toBe(tab.$("disable-keep"));
      tab.$("disable-keep").click();
      expect([tab.$("disable-dialog").hidden, tab.doc.activeElement]).toEqual([true, more(rows(tab)[1])]);
      expect(tab.fetched.filter((f) => f.method === "POST")).toEqual([]);
    }
  });

  it("Disable account sends one request, reads the list again from the start through the pages shown, and the row says Disabled", async () => {
    const page2 = [account(U4, W4, { username: "zed" })];
    const tab = await opened(
      standard({
        "GET /api/v1/admin/accounts": [list([MOCKUP[0], TESS], U3), list([MOCKUP[0], off], U3)],
        [`GET /api/v1/admin/accounts?after=${U3}`]: list(page2),
        [DISABLE]: { status: 204 },
      }),
    );
    tab.$("admin-more").click();
    await tab.settle();
    expect(rows(tab)).toHaveLength(3);
    choose(rows(tab)[1], "Disable");
    const go = tab.$("disable-go");
    go.click();
    expect([go.textContent, go.disabled, tab.$("disable-keep").disabled]).toEqual(["Disabling…", true, true]);
    go.dispatch("click");
    key(tab.doc.body, "Escape");
    expect(tab.$("disable-dialog").hidden).toBe(false);
    await tab.settle();
    expect(of(tab, "POST", `/api/v1/admin/accounts/${U2}/disable`).map((f) => [f.headers["X-Csrf-Token"], f.body])).toEqual([[CSRF, undefined]]);
    // Re-read from the start, through both pages, with the cursor exactly as it came.
    expect(tab.fetched.filter((f) => f.path.startsWith("/api/v1/admin/accounts")).map((f) => f.path)).toEqual(["/api/v1/admin/accounts", `/api/v1/admin/accounts?after=${U3}`, `/api/v1/admin/accounts/${U2}/disable`, "/api/v1/admin/accounts", `/api/v1/admin/accounts?after=${U3}`]);
    expect(tab.$("disable-dialog").hidden).toBe(true);
    expect([rowOf(rows(tab)[1]).tags, rowOf(rows(tab)[1]).menu]).toEqual([["Disabled"], ["Set allowance", "Enable", "Delete"]]);
    expect(rows(tab)).toHaveLength(3);
    expect(tab.doc.activeElement).toBe(more(rows(tab)[1]));
  });

  it("a disabled-then-enabled row returns to exactly its earlier view, and Enable asks nothing and says so", async () => {
    const tab = await opened(standard({ "GET /api/v1/admin/accounts": [list([MOCKUP[0], TESS]), list([MOCKUP[0], off]), list([MOCKUP[0], TESS])], [DISABLE]: { status: 204 }, [ENABLE]: { status: 204 } }));
    const before = rowOf(rows(tab)[1]);
    choose(rows(tab)[1], "Disable");
    tab.$("disable-go").click();
    await tab.settle();
    expect(rowOf(rows(tab)[1])).toEqual({ ...before, tags: ["Disabled"], menu: ["Set allowance", "Enable", "Delete"] });
    choose(rows(tab)[1], "Enable");
    expect(tab.$("disable-dialog").hidden).toBe(true);
    await tab.settle();
    expect(of(tab, "POST", `/api/v1/admin/accounts/${U2}/enable`).map((f) => f.headers["X-Csrf-Token"])).toEqual([CSRF]);
    expect(rowOf(rows(tab)[1])).toEqual(before);
    expect(noteOf(tab, "admin-note")).toEqual(["tess is enabled again. Their tours and shared links work as before; they sign in again to use the dashboard.", "note"]);
    expect(tab.doc.activeElement).toBe(more(rows(tab)[1]));
    expect(more(rows(tab)[1]).textContent).toBe("More");
  });

  it("refusals in plain words: own_account and last_admin in the question, deleting and own_account under the table", async () => {
    for (const [answer, text] of [[refused(409, "own_account"), "You cannot disable your own account."], [refused(409, "last_admin"), "This is the last admin, so it cannot be disabled."], [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY]] as const) {
      const tab = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], TESS]), [DISABLE]: answer as Answer }));
      choose(rows(tab)[1], "Disable");
      tab.$("disable-go").click();
      await tab.settle();
      expect([tab.$("disable-dialog").hidden, tab.$("disable-message").textContent, tab.$("disable-go").disabled]).toEqual([false, text, false]);
      expect(tab.doc.activeElement).toBe(tab.$("disable-go"));
    }
    for (const [answer, text] of [[refused(409, "deleting"), "This account is being deleted and cannot be enabled."], [refused(409, "own_account"), "You cannot enable your own account."], [{ status: 500, json: { error: "internal" } }, FAILED]] as const) {
      const tab = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], off]), [ENABLE]: answer as Answer }));
      choose(rows(tab)[1], "Enable");
      await tab.settle();
      expect([tab.$("admin-message").textContent, tab.$("admin-note").shown]).toEqual([text, false]);
    }
  });

  it("when no answer comes, the row's status in the list read again decides", async () => {
    const done = await opened(standard({ "GET /api/v1/admin/accounts": [list([MOCKUP[0], TESS]), list([MOCKUP[0], off])], [DISABLE]: "network" }));
    choose(rows(done)[1], "Disable");
    done.$("disable-go").click();
    await done.settle();
    expect([done.$("disable-dialog").hidden, rowOf(rows(done)[1]).tags]).toEqual([true, ["Disabled"]]);
    const notDone = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], TESS]), [DISABLE]: "network" }));
    choose(rows(notDone)[1], "Disable");
    notDone.$("disable-go").click();
    await notDone.settle();
    expect([notDone.$("disable-dialog").hidden, notDone.$("disable-message").textContent, rowOf(rows(notDone)[1]).tags]).toEqual([false, FAILED, []]);

    const enabled = await opened(standard({ "GET /api/v1/admin/accounts": [list([MOCKUP[0], off]), list([MOCKUP[0], TESS])], [ENABLE]: "network" }));
    choose(rows(enabled)[1], "Enable");
    await enabled.settle();
    expect(noteOf(enabled, "admin-note")?.[0]).toBe("tess is enabled again. Their tours and shared links work as before; they sign in again to use the dashboard.");
    const still = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], off]), [ENABLE]: "network" }));
    choose(rows(still)[1], "Enable");
    await still.settle();
    expect([still.$("admin-message").textContent, still.$("admin-note").shown]).toEqual([FAILED, false]);
    // A change that worked whose list cannot be read again says so.
    const blind = await opened(standard({ "GET /api/v1/admin/accounts": [list([MOCKUP[0], off]), "network"], [ENABLE]: { status: 204 } }));
    choose(rows(blind)[1], "Enable");
    await blind.settle();
    expect([blind.$("admin-message").textContent, blind.$("admin-note").shown]).toEqual([NOT_RELOADED, true]);
  });

  it("names holding markup, quotes and right-to-left letters stay text in the question, each in its own isolated element", async () => {
    const evil = { ...TESS, username: '<b>"x"</b>‮' };
    const tab = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], evil]) }));
    choose(rows(tab)[1], "Disable");
    expect(tab.$("disable-title").children.map((c) => (c instanceof FakeElement ? [c.className, c.textContent] : null))).toEqual([["", 'Disable "'], ["name", evil.username], ["", '"?']]);
    expect(tab.$("disable-text").all().filter((e) => e.className === "name").map((e) => e.textContent)).toEqual([evil.username]);
    expect(tab.doc.root.all().some((e) => e.tagName === "b")).toBe(false);
  });
});

// ---- Deleting ----

describe("deleting an account", () => {
  const REMOVAL = `GET /api/v1/admin/accounts/${U4}/removal`;
  const DELETE = `DELETE /api/v1/admin/accounts/${U4}`;
  const counts = { username: "rook", email: "rook@example.com", tours: 1, items: 4, connections: 2, used_bytes: 18 * MB };
  const progress = (done: number, total: number): Answer => ({ status: 202, json: { status: "in_progress", done, total } });
  const DELETED: Answer = { status: 200, json: { deleted: true } };
  const deletingRook = { ...ROOK, deleting: true };
  const withRook = list([MOCKUP[0], ROOK]);
  const withoutRook = list([MOCKUP[0]]);
  const deletes = (tab: Tab) => of(tab, "DELETE", `/api/v1/admin/accounts/${U4}`);

  async function openDelete(extra: NonNullable<Parameters<typeof standard>[0]> = {}): Promise<Tab> {
    const tab = await opened(standard({ "GET /api/v1/admin/accounts": withRook, [REMOVAL]: { status: 200, json: counts }, ...extra }));
    choose(rows(tab)[1], "Delete");
    await tab.settle();
    return tab;
  }

  it("reads what goes first, then asks mockup 4's question; Delete account stays disabled until the username is typed exactly", async () => {
    const tab = await openDelete();
    expect(of(tab, "GET", `/api/v1/admin/accounts/${U4}/removal`)).toHaveLength(1);
    expect(tab.$("delete-dialog").shown).toBe(true);
    expect(tab.shows().slice(-6)).toEqual(['Delete "rook" for good?', "This removes the account and everything in its workspace:", "This cannot be undone. Their links stop working for everyone, and rook@example.com can be invited again as a new account.", "Type the username to confirm", "Keep it", "Delete account"]);
    const facts = tab.$("delete-facts").children.filter((c): c is FakeElement => c instanceof FakeElement).map((e) => e.textContent);
    expect(facts).toEqual(["Tours", "1", "Images and GIFs", "4", "Connected computers", "2", "Storage freed", "18 MB"]);
    expect(tab.doc.activeElement).toBe(tab.$("delete-input"));
    // The field starts empty, with the name to type shown muted in it.
    expect([tab.$("delete-input").value, tab.$("delete-input").getAttribute("placeholder")]).toEqual(["", "rook"]);
    const go = tab.$("delete-go");
    for (const text of ["", "roo", "Rook", "rook ", " rook", "rook@example.com", "rooк"]) {
      type(tab, text, "delete-input");
      expect(go.disabled, JSON.stringify(text)).toBe(true);
      go.click();
      // Even a click that reaches the button anyway sends nothing.
      go.dispatch("click");
    }
    expect(deletes(tab)).toEqual([]);
    // Tab goes round the field and Keep it only, while Delete account is disabled.
    tab.$("delete-keep").focus();
    key(tab.$("delete-keep"), "Tab");
    expect(tab.doc.activeElement).toBe(tab.$("delete-input"));
    type(tab, "rook", "delete-input");
    expect(go.disabled).toBe(false);
    type(tab, "rookx", "delete-input");
    expect(go.disabled).toBe(true);
    tab.$("delete-keep").click();
    expect([tab.$("delete-dialog").hidden, tab.doc.activeElement]).toEqual([true, more(rows(tab)[1])]);
    expect(deletes(tab)).toEqual([]);
  });

  it("an account without a username is confirmed with its email address", async () => {
    const tab = await openDelete({ [REMOVAL]: { status: 200, json: { ...counts, username: null } }, [DELETE]: DELETED, "GET /api/v1/admin/accounts": [withRook, withoutRook] });
    expect(tab.$("delete-label").textContent).toBe("Type the email address to confirm");
    expect(tab.$("delete-title").textContent).toBe('Delete "rook@example.com" for good?');
    type(tab, "rook", "delete-input");
    expect(tab.$("delete-go").disabled).toBe(true);
    type(tab, "rook@example.com", "delete-input");
    tab.$("delete-go").click();
    await drain(tab);
    expect(deletes(tab).map((f) => f.body)).toEqual(['{"username":"rook@example.com"}']);
  });

  it("deleting shows mockup 4's progress, sends the same request again after a short pause while it answers 202, then the row is gone and the page says so", async () => {
    const tab = await openDelete({ "GET /api/v1/admin/accounts": [withRook, withoutRook], "GET /api/v1/admin/summary": [summary(2, MOCKUP_USED, STANDARD), summary(1, 1, STANDARD)], [DELETE]: [progress(0, 400), progress(240, 400), DELETED] });
    type(tab, "rook", "delete-input");
    tab.$("delete-go").click();
    tab.$("delete-go").dispatch("click");
    expect(tab.$("delete-title").textContent).toBe('Deleting "rook"…');
    expect([tab.$("delete-ask").shown, tab.$("delete-buttons").shown, tab.$("delete-progress").shown]).toEqual([false, false, true]);
    expect(tab.doc.activeElement).toBe(tab.$("delete-title"));
    await tab.settle();
    expect(tab.$("delete-done").textContent).toBe("Removing files, 0 of 400. Keep this page open. If it is interrupted, open Delete again to finish.");
    expect(tab.pendingDelays()).toEqual([300]);
    // While it runs, Escape and the backdrop do nothing, and Tab stays on the title.
    key(tab.doc.body, "Escape");
    tab.$("delete-dialog").click();
    expect(tab.$("delete-dialog").hidden).toBe(false);
    expect(key(tab.doc.body, "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-title"));
    tab.tick();
    await tab.settle();
    expect(tab.$("delete-done").textContent).toBe("Removing files, 240 of 400. Keep this page open. If it is interrupted, open Delete again to finish.");
    expect(tab.$("delete-fill").style.width).toBe("60%");
    tab.tick();
    await tab.settle();
    // Each call carried the row's id and the name typed, with the anti-forgery header.
    expect(deletes(tab).map((f) => [f.headers["X-Csrf-Token"], f.body])).toEqual(Array(3).fill([CSRF, '{"username":"rook"}']));
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect(rows(tab).map((r) => rowOf(r).name)).toEqual(["morgan"]);
    expect(tab.$("admin-summary").textContent).toBe("1 account · 1 byte used in all · standard allowance 5 GB");
    expect(noteOf(tab, "admin-note")).toEqual(["rook was deleted.", "note"]);
    expect(tab.doc.activeElement).toBe(tab.$("h-accounts"));
    expect(tab.pendingDelays()).toEqual([]);
  });

  it("the request carries the id of the row whose question is open and that row's name, also after the list was read again underneath", async () => {
    // Show more is on its way when the question opens; its rows arrive while the question is open.
    const held: ((a: Answer) => void)[] = [];
    const vale = account(U5, W5, { username: "vale", status: "disabled" });
    const tab = await opened(
      standard({
        "GET /api/v1/admin/accounts": [list([MOCKUP[0], ROOK], U3), list([vale, MOCKUP[0], ROOK], U3)],
        [`GET /api/v1/admin/accounts?after=${U3}`]: () => (held.length === 0 ? new Promise<Answer>((r) => held.push(r)) : list([])),
        [REMOVAL]: { status: 200, json: counts },
        [DELETE]: [progress(1, 10), "network", "network", "network", DELETED],
      }),
    );
    tab.$("admin-more").click();
    choose(rows(tab)[1], "Delete");
    await tab.settle();
    expect(tab.$("delete-dialog").shown).toBe(true);
    held[0](list([vale]));
    await tab.settle();
    expect(rows(tab).map((r) => rowOf(r).name)).toEqual(["morgan", "rook", "vale"]);
    type(tab, "rook", "delete-input");
    tab.$("delete-go").click();
    await drain(tab);
    // Interrupted; the list read again now has another account where rook was.
    expect(rows(tab).map((r) => rowOf(r).name)).toEqual(["vale", "morgan", "rook"]);
    expect(tab.$("delete-dialog").shown).toBe(true);
    tab.$("delete-go").click();
    await drain(tab);
    const sent = tab.fetched.filter((f) => f.method === "DELETE");
    expect(new Set(sent.map((f) => `${f.path} ${f.body}`))).toEqual(new Set([`/api/v1/admin/accounts/${U4} {"username":"rook"}`]));
    expect(sent).toHaveLength(5);
  });

  it("stops at once on a refusal, says why in plain words, and goes back to the question", async () => {
    for (const [answer, text] of [
      [refused(400, "username_mismatch"), "That does not match. Type it exactly as it is shown in the list."],
      [refused(409, "not_disabled"), "Disable the account first."],
      [refused(409, "site_owner"), "This account set the site up and cannot be deleted."],
      [refused(409, "shared_workspace"), "Another account belongs to this workspace, so it cannot be deleted."],
      [refused(409, "last_admin"), "This is the last admin, so it cannot be deleted."],
      [refused(409, "own_account"), "You cannot delete your own account."],
      [refused(400, "bad_request"), FAILED],
      [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY],
      [{ status: 202, json: { status: "in_progress" } }, FAILED],
    ] as const) {
      const tab = await openDelete({ [DELETE]: answer as Answer });
      type(tab, "rook", "delete-input");
      tab.$("delete-go").click();
      const ran = await drain(tab);
      expect([ran, deletes(tab).length], JSON.stringify(answer)).toEqual([[], 1]);
      expect([tab.$("delete-dialog").shown, tab.$("delete-ask").shown, tab.$("delete-buttons").shown, tab.$("delete-message").textContent], JSON.stringify(answer)).toEqual([true, true, true, text]);
      expect(tab.$("delete-title").textContent).toBe('Delete "rook" for good?');
      expect([tab.$("delete-go").disabled, tab.$("delete-keep").disabled]).toEqual([false, false]);
      // The list was read again, so the row shows what is true.
      expect(of(tab, "GET", "/api/v1/admin/accounts")).toHaveLength(2);
    }
  });

  it("never loops forever: a cleanup that keeps failing, or answers that keep getting lost, are sent at most three times in a row", async () => {
    for (const answer of [refused(500, "cleanup_pending"), "network"] as const) {
      const tab = await openDelete({ [DELETE]: answer as Answer });
      type(tab, "rook", "delete-input");
      tab.$("delete-go").click();
      const ran = await drain(tab);
      expect([deletes(tab).length, ran], String(answer)).toEqual([3, [1000, 3000]]);
      expect([tab.$("delete-ask").shown, tab.$("delete-message").textContent]).toEqual([true, FAILED]);
    }
    // A failure in between is forgiven once the delete moves on again.
    const tab = await openDelete({ "GET /api/v1/admin/accounts": [withRook, withoutRook], [DELETE]: [progress(0, 9), refused(500, "cleanup_pending"), "network", progress(3, 9), "network", "network", progress(6, 9), DELETED] });
    type(tab, "rook", "delete-input");
    tab.$("delete-go").click();
    await drain(tab);
    expect(deletes(tab)).toHaveLength(8);
    expect(noteOf(tab, "admin-note")?.[0]).toBe("rook was deleted.");
  });

  it("an interrupted delete: the question says so, the row shows Deleting, and Delete account, or Delete again from the menu, goes on without asking again", async () => {
    const tab = await openDelete({
      "GET /api/v1/admin/accounts": [withRook, list([MOCKUP[0], deletingRook]), list([MOCKUP[0], deletingRook]), withoutRook],
      [DELETE]: [progress(2, 10), "network", "network", "network", progress(5, 10), "network", "network", "network", DELETED],
    });
    type(tab, "rook", "delete-input");
    tab.$("delete-go").click();
    await drain(tab);
    expect([tab.$("delete-dialog").shown, tab.$("delete-ask").shown, tab.$("delete-message").textContent, tab.$("delete-go").disabled]).toEqual([true, true, FAILED, false]);
    expect(rowOf(rows(tab)[1])).toMatchObject({ tags: ["Deleting"], menu: ["Delete"] });
    expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
    // Closed and opened again from the menu: what goes is read again, and the delete goes straight on.
    tab.$("delete-keep").click();
    choose(rows(tab)[1], "Delete");
    await tab.settle();
    expect([tab.$("delete-progress").shown, tab.$("delete-title").textContent]).toEqual([true, 'Deleting "rook"…']);
    await drain(tab);
    expect(tab.$("delete-message").textContent).toBe(FAILED);
    tab.$("delete-go").click();
    await drain(tab);
    expect(deletes(tab).map((f) => f.body)).toEqual(Array(9).fill('{"username":"rook"}'));
    expect(of(tab, "GET", `/api/v1/admin/accounts/${U4}/removal`)).toHaveLength(2);
    expect(noteOf(tab, "admin-note")?.[0]).toBe("rook was deleted.");
  });

  it("after the page is loaded again, an interrupted delete asks for the username again", async () => {
    const tab = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], deletingRook]), [REMOVAL]: { status: 200, json: counts }, [DELETE]: DELETED }));
    choose(rows(tab)[1], "Delete");
    await tab.settle();
    expect([tab.$("delete-ask").shown, tab.$("delete-input").value, tab.$("delete-go").disabled]).toEqual([true, "", true]);
    expect(deletes(tab)).toEqual([]);
  });

  it("a name confirmed on this page is used again only while the list just read marks the row as being deleted; otherwise it asks with an empty field", async () => {
    const ACTIVE_TESS = { ...TESS };
    const tab = await opened(
      standard({
        // Read on load; after the interruption (being deleted); after Tess is disabled, a list that no longer marks rook as being deleted.
        "GET /api/v1/admin/accounts": [list([MOCKUP[0], ACTIVE_TESS, ROOK]), list([MOCKUP[0], ACTIVE_TESS, deletingRook]), list([MOCKUP[0], { ...TESS, status: "disabled" }, ROOK])],
        [REMOVAL]: { status: 200, json: counts },
        [DELETE]: [progress(1, 9), "network", "network", "network"],
        [`POST /api/v1/admin/accounts/${U2}/disable`]: { status: 204 },
      }),
    );
    choose(rows(tab)[2], "Delete");
    await tab.settle();
    type(tab, "rook", "delete-input");
    tab.$("delete-go").click();
    await drain(tab);
    expect(rowOf(rows(tab)[2]).tags).toEqual(["Deleting"]);
    tab.$("delete-keep").click();
    // Something else reads the list again; it shows rook as disabled but no longer being deleted.
    choose(rows(tab)[1], "Disable");
    tab.$("disable-go").click();
    await tab.settle();
    expect([rowOf(rows(tab)[2]).tags, rowOf(rows(tab)[2]).menu]).toEqual([["Disabled"], ["Set allowance", "Enable", "Delete"]]);
    choose(rows(tab)[2], "Delete");
    await tab.settle();
    // The name was confirmed here, but the list does not say the delete is under way: it asks again.
    expect([tab.$("delete-ask").shown, tab.$("delete-progress").shown, tab.$("delete-input").value, tab.$("delete-go").disabled]).toEqual([true, false, "", true]);
    expect(deletes(tab)).toHaveLength(4);
  });

  it("leaving the page stops a running delete: no send after the page is hidden, and on return the question shows the interruption and goes on only when pressed", async () => {
    // Left during a pause.
    const paused = await openDelete({ "GET /api/v1/admin/accounts": [withRook, list([MOCKUP[0], deletingRook]), list([MOCKUP[0], deletingRook]), withoutRook], [DELETE]: [progress(1, 10), progress(5, 10), DELETED] });
    type(paused, "rook", "delete-input");
    paused.$("delete-go").click();
    await paused.settle();
    expect(paused.pendingDelays()).toEqual([300]);
    paused.pagehide();
    paused.tick();
    await drain(paused);
    expect(deletes(paused)).toHaveLength(1);
    expect([paused.$("delete-dialog").shown, paused.$("delete-ask").shown, paused.$("delete-message").textContent, paused.$("delete-input").value]).toEqual([true, true, FAILED, "rook"]);
    expect(rowOf(rows(paused)[1]).tags).toEqual(["Deleting"]);
    // Back on the page, the admin carries on deliberately.
    paused.$("delete-go").click();
    await drain(paused);
    expect(deletes(paused)).toHaveLength(3);
    expect(noteOf(paused, "admin-note")?.[0]).toBe("rook was deleted.");

    // Left while a send is on its way: its answer is shown, but nothing is sent after it.
    const held: ((a: Answer) => void)[] = [];
    const flying = await openDelete({
      "GET /api/v1/admin/accounts": [withRook, list([MOCKUP[0], deletingRook])],
      [DELETE]: () => new Promise<Answer>((r) => held.push(r)),
    });
    type(flying, "rook", "delete-input");
    flying.$("delete-go").click();
    await flying.settle();
    flying.pagehide();
    held[0](progress(3, 10));
    await drain(flying);
    expect(deletes(flying)).toHaveLength(1);
    expect([flying.$("delete-ask").shown, flying.$("delete-message").textContent]).toEqual([true, FAILED]);

    // Left after a lost answer, during its pause: no retry.
    const lost = await openDelete({ "GET /api/v1/admin/accounts": [withRook, list([MOCKUP[0], ROOK])], [DELETE]: "network" });
    type(lost, "rook", "delete-input");
    lost.$("delete-go").click();
    await lost.settle();
    expect(lost.pendingDelays()).toEqual([1000]);
    lost.pagehide();
    await drain(lost);
    expect(deletes(lost)).toHaveLength(1);
    expect(lost.$("delete-message").textContent).toBe(FAILED);
  });

  it("a name refused as not matching is forgotten, so opening Delete again asks for it", async () => {
    const tab = await openDelete({ "GET /api/v1/admin/accounts": [withRook, list([MOCKUP[0], deletingRook])], [DELETE]: [progress(1, 9), refused(400, "username_mismatch")] });
    type(tab, "rook", "delete-input");
    tab.$("delete-go").click();
    await drain(tab);
    tab.$("delete-keep").click();
    choose(rows(tab)[1], "Delete");
    await tab.settle();
    expect([tab.$("delete-ask").shown, tab.$("delete-input").value, tab.$("delete-go").disabled]).toEqual([true, "", true]);
    expect(deletes(tab)).toHaveLength(2);
  });

  it("when the answers are lost and the list no longer has the account, or a 404 comes, it was deleted; a 404 with the row still there is a failure", async () => {
    const lost = await openDelete({ "GET /api/v1/admin/accounts": [withRook, withoutRook], [DELETE]: "network" });
    type(lost, "rook", "delete-input");
    lost.$("delete-go").click();
    await drain(lost);
    expect([lost.$("delete-dialog").hidden, noteOf(lost, "admin-note")?.[0]]).toEqual([true, "rook was deleted."]);
    const gone = await openDelete({ "GET /api/v1/admin/accounts": [withRook, withoutRook], [DELETE]: [progress(1, 2), NOT_FOUND] });
    type(gone, "rook", "delete-input");
    gone.$("delete-go").click();
    await drain(gone);
    expect([gone.$("delete-dialog").hidden, noteOf(gone, "admin-note")?.[0]]).toEqual([true, "rook was deleted."]);
    const there = await openDelete({ [DELETE]: NOT_FOUND });
    type(there, "rook", "delete-input");
    there.$("delete-go").click();
    await drain(there);
    expect([there.$("delete-dialog").hidden, there.$("delete-message").textContent]).toEqual([false, FAILED]);
    // A delete that worked whose list cannot be read says so.
    const blind = await openDelete({ "GET /api/v1/admin/accounts": [withRook, "network"], [DELETE]: DELETED });
    type(blind, "rook", "delete-input");
    blind.$("delete-go").click();
    await drain(blind);
    expect([blind.$("delete-dialog").hidden, noteOf(blind, "admin-note")?.[0], blind.$("admin-message").textContent]).toEqual([true, "rook was deleted.", NOT_RELOADED]);
  });

  it("the read before the question: a failure is said under the table and opens nothing; a 404 reads the list; a lost session goes to /signin", async () => {
    const fails = await openDelete({ [REMOVAL]: { status: 500, json: { error: "internal" } } });
    expect([fails.$("delete-dialog").hidden, fails.$("admin-message").textContent]).toEqual([true, FAILED]);
    expect(fails.doc.activeElement).toBe(more(rows(fails)[1]));
    const odd = await openDelete({ [REMOVAL]: { status: 200, json: { username: "rook" } } });
    expect([odd.$("delete-dialog").hidden, odd.$("admin-message").textContent]).toEqual([true, FAILED]);
    const gone = await openDelete({ [REMOVAL]: NOT_FOUND, "GET /api/v1/admin/accounts": [withRook, withoutRook] });
    // Gone: the list shows it, and there is nothing to say.
    expect([gone.$("delete-dialog").hidden, gone.$("admin-message").shown]).toEqual([true, false]);
    expect(rows(gone).map((r) => rowOf(r).name)).toEqual(["morgan"]);
    const out = await openDelete({ [REMOVAL]: SIGNED_OUT });
    expect(out.left()).toBe("/signin");
    // While it is read, no menu opens and nothing else starts.
    const held: ((a: Answer) => void)[] = [];
    const slow = await opened(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], TESS, ROOK]), [REMOVAL]: () => new Promise<Answer>((r) => held.push(r)) }));
    choose(rows(slow)[2], "Delete");
    expect(rows(slow).map((r) => more(r).disabled)).toEqual([true, true, true]);
    more(rows(slow)[1]).dispatch("click");
    choose(rows(slow)[1], "Disable");
    expect(slow.$("disable-dialog").hidden).toBe(true);
    held[0]({ status: 200, json: counts });
    await slow.settle();
    expect([slow.$("delete-dialog").shown, slow.$("disable-dialog").shown]).toEqual([true, false]);
  });

  it("a name holding markup, quotes, right-to-left letters or great length stays text, in its own isolated element", async () => {
    const name = '<img src=x>"‮' + "y".repeat(200);
    const tab = await openDelete({ [REMOVAL]: { status: 200, json: { ...counts, username: name, email: '"<b>"@example.com' } } });
    expect(tab.$("delete-title").children.map((c) => (c instanceof FakeElement ? [c.className, c.textContent] : null))).toEqual([["", 'Delete "'], ["name", name], ["", '" for good?']]);
    expect(tab.$("delete-warn").all().filter((e) => e.className === "name").map((e) => e.textContent)).toEqual(['"<b>"@example.com']);
    expect(tab.doc.root.all().some((e) => (e.tagName === "img" && !isBrandMark(e)) || e.tagName === "b")).toBe(false);
    type(tab, name, "delete-input");
    expect(tab.$("delete-go").disabled).toBe(false);
  });
});

// ---- A member, and the real app ----

describe("the Admin page for a member learns nothing new", () => {
  it("asks only for the session, and a session that says admin with routes that answer 404 asks nothing of the invites", async () => {
    const member = openAdmin(answers({ "GET /api/v1/session": session(false, "tess", U2) }));
    await member.settle();
    expect(member.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session"]);
    for (const id of ["invite-email", "invites-rows", "cancel-dialog", "disable-dialog", "delete-dialog", "delete-input"]) expect(member.has(id), id).toBe(false);
    const notAdmin = openAdmin(standard({ "GET /api/v1/admin/accounts": NOT_FOUND }));
    await notAdmin.settle();
    expect(notAdmin.fetched.map((f) => f.path)).not.toContain("/api/v1/admin/invites");
    expect(notAdmin.shows()).toEqual(["Mythicshot", "morgan", "Page not found", "Back to Tours"]);
  });
});

describe("invites and account actions against the real app", () => {
  const TWO = { hosts: { tours: "tours.example.com", app: "app.example.com" }, storageAllowanceBytes: STANDARD };

  it("the admin invites an address, resends it and cancels it, through the API and its mailer", async () => {
    const { deps, mail } = await makeDeps(TWO);
    const admin = await seedAccount(deps, { admin: true, username: "realadmin" });
    const real = browser(deps, await sessionOf(deps, admin.userId));
    const tab = openAdmin(real.respond);
    await tab.settle();
    expect(tab.$("invites-empty").shown).toBe(true);
    type(tab, "Mara@Example.com", "invite-email");
    tab.$("invite-go").click();
    await tab.settle();
    expect(mail.sent.map((m) => m.to)).toEqual(["mara@example.com"]);
    const row = await deps.db.first<{ id: string; expires_at: number }>("SELECT id, expires_at FROM invite WHERE email = ?", ["mara@example.com"]);
    expect(noteOf(tab, "invite-note")?.[0]).toBe(`An invite is on its way to mara@example.com. The link works once and until ${long(row!.expires_at)}.`);
    expect(invRows(tab).map((r) => invOf(r).address)).toEqual(["mara@example.com"]);
    // The same address again has its own sentence from the API's code; an account's address too.
    type(tab, admin.email, "invite-email");
    tab.$("invite-go").click();
    await tab.settle();
    expect(inviteSays(tab)).toEqual([HAS_ACCOUNT, true]);
    button(invRows(tab)[0], "Resend").click();
    await tab.settle();
    expect(mail.sent).toHaveLength(2);
    expect(noteOf(tab, "invites-note")?.[0]).toBe("A new invite is on its way to mara@example.com. The earlier link no longer works.");
    button(invRows(tab)[0], "Cancel").click();
    tab.$("cancel-go").click();
    await tab.settle();
    expect(await deps.db.first("SELECT id FROM invite WHERE id = ?", [row!.id])).toBeNull();
    expect(tab.$("invites-empty").shown).toBe(true);
  });

  it("on a site whose mail is off, the page says nobody can be invited from here", async () => {
    const { deps } = await makeDeps(TWO, { mail: false });
    const admin = await seedAccount(deps, { admin: true, username: "realadmin" });
    const tab = openAdmin(browser(deps, await sessionOf(deps, admin.userId)).respond);
    await tab.settle();
    type(tab, "mara@example.com", "invite-email");
    tab.$("invite-go").click();
    await tab.settle();
    expect(inviteSays(tab)).toEqual([MAIL_OFF, true]);
  });

  it("the admin disables, enables, disables again and deletes an account, typing its username; the visitor's pages then answer as for nothing", async () => {
    const { deps } = await makeDeps(TWO);
    const admin = await seedAccount(deps, { admin: true, username: "realadmin" });
    const member = await seedAccount(deps, { username: "realmember" });
    const memberCookie = await sessionOf(deps, member.userId);
    const real = browser(deps, await sessionOf(deps, admin.userId));
    const tab = openAdmin(real.respond);
    await tab.settle();
    expect(rows(tab).map((r) => [rowOf(r).name, rowOf(r).menu])).toEqual([
      ["realadmin", ["Set allowance"]],
      ["realmember", ["Set allowance", "Disable"]],
    ]);
    const before = rowOf(rows(tab)[1]);
    choose(rows(tab)[1], "Disable");
    tab.$("disable-go").click();
    await tab.settle();
    expect(await deps.db.first("SELECT status FROM user WHERE id = ?", [member.userId])).toEqual({ status: "disabled" });
    expect(rowOf(rows(tab)[1]).tags).toEqual(["Disabled"]);
    // The member's session ended; their token is refused.
    expect((await send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: memberCookie, "user-agent": FIREFOX } })).status).toBe(401);
    expect((await send(deps, "GET", "/api/v1/tours", { origin: APP, token: member.token })).status).toBe(401);
    choose(rows(tab)[1], "Enable");
    await tab.settle();
    expect(await deps.db.first("SELECT status FROM user WHERE id = ?", [member.userId])).toEqual({ status: "active" });
    expect(rowOf(rows(tab)[1])).toEqual(before);
    choose(rows(tab)[1], "Disable");
    tab.$("disable-go").click();
    await tab.settle();
    choose(rows(tab)[1], "Delete");
    await tab.settle();
    expect(tab.$("delete-title").textContent).toBe('Delete "realmember" for good?');
    type(tab, "realmember", "delete-input");
    tab.$("delete-go").click();
    await drain(tab);
    expect(await deps.db.first("SELECT id FROM user WHERE id = ?", [member.userId])).toBeNull();
    expect(rows(tab).map((r) => rowOf(r).name)).toEqual(["realadmin"]);
    expect(noteOf(tab, "admin-note")?.[0]).toBe("realmember was deleted.");
    const audit = await deps.db.all<{ event: string }>("SELECT event FROM audit WHERE event LIKE 'account_%' ORDER BY rowid");
    expect(audit.map((a) => a.event)).toEqual(["account_disabled", "account_enabled", "account_disabled", "account_deleted"]);
  });
});

// ---- The whole feature, through the real routes and the real pages ----

/**
 * The invitee's browser: the invite page's own script run as a browser runs it on the app
 * address, with a cookie jar, so the session that accepting sets is the one later requests carry.
 */
function inviteeBrowser(deps: Deps) {
  const app = createApp(deps);
  const jar = { cookie: null as string | null };
  const ask = async (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) => {
    const headers: Record<string, string> = { ...init.headers, "user-agent": FIREFOX };
    if (method !== "GET" && method !== "HEAD") Object.assign(headers, { origin: APP, "sec-fetch-site": "same-origin" });
    if (jar.cookie !== null) headers.cookie = jar.cookie;
    const res = await app.fetch(new Request(APP + path, { method, headers, body: init.body }));
    for (const c of res.headers.getSetCookie()) jar.cookie = /Max-Age=0/.test(c) ? null : c.split(";")[0];
    return res;
  };
  function open(url: string) {
    const doc = new FakeDocument(INVITE_HTML);
    let current = new URL(url);
    let left: string | null = null;
    const pending: Promise<unknown>[] = [];
    const location = {
      get hash() {
        return current.hash;
      },
      get pathname() {
        return current.pathname;
      },
      get search() {
        return current.search;
      },
      replace(path: string) {
        left = path;
      },
      assign(path: string) {
        left = path;
      },
    };
    const history = {
      replaceState(_s: unknown, _t: string, next: string) {
        current = new URL(next, current);
      },
    };
    const fetch = (path: string, init: Record<string, unknown> = {}) => {
      const p = ask(String(init.method ?? "GET"), path, { headers: init.headers as Record<string, string>, body: init.body as string | undefined });
      pending.push(p.catch(() => {}));
      return p;
    };
    vm.runInContext(INVITE_JS, vm.createContext({ document: doc, location, history, fetch }), { filename: "invite.js" });
    const $ = (id: string) => doc.root.all().find((e) => e.id === id)!;
    return {
      $,
      url: () => current.href,
      left: () => left,
      async settle() {
        for (let i = 0; i < 30; i++) {
          await Promise.race([Promise.all(pending), new Promise((r) => globalThis.setTimeout(r, 1))]);
          await new Promise((r) => setImmediate(r));
        }
      },
    };
  }
  return { jar, ask, open };
}

describe("the whole feature, through the real routes and pages", () => {
  it("invite from the Admin page, accept on the invite page, then disable, enable, disable and delete the new account from the Admin page; its address can be invited again", async () => {
    const made = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" }, storageAllowanceBytes: STANDARD });
    const { deps, mail } = made;
    const admin = await seedAccount(deps, { admin: true, username: "realadmin" });
    const adminBrowser = browser(deps, await sessionOf(deps, admin.userId));

    // The admin's page sends the invite.
    const page = openAdmin(adminBrowser.respond);
    await page.settle();
    expect(rows(page).map((r) => rowOf(r).name)).toEqual(["realadmin"]);
    type(page, "mara@example.com", "invite-email");
    page.$("invite-go").click();
    await page.settle();
    await made.settle();
    expect(noteOf(page, "invite-note")?.[0]).toMatch(/^An invite is on its way to mara@example\.com\. The link works once and until /);
    expect(invRows(page).map((r) => invOf(r).address)).toEqual(["mara@example.com"]);
    const sent = mail.sent.filter((m) => m.to === "mara@example.com");
    expect(sent).toHaveLength(1);
    const link = /https:\/\/app\.example\.com\/invite#dpi_[0-9a-f]{40}/.exec(sent[0].text)![0];

    // The invitee opens the mailed link in their own browser and accepts through the page's own script.
    const invitee = inviteeBrowser(deps);
    const accept = invitee.open(link);
    await accept.settle();
    expect(accept.url()).toBe(`${APP}/invite`);
    expect(accept.$("invite-email").textContent).toBe("mara@example.com");
    accept.$("username").value = "mara";
    accept.$("username").dispatch("input");
    accept.$("choose-button").click();
    await accept.settle();
    expect(accept.left()).toBe("/connections");
    expect(invitee.jar.cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=dps_[0-9a-f]{64}$`));
    expect((await invitee.ask("GET", "/api/v1/session")).status).toBe(200);
    const mara = await deps.db.first<{ id: string }>("SELECT id FROM user WHERE email = ?", ["mara@example.com"]);
    expect(mara).not.toBeNull();

    // The admin's page, loaded again, lists the new account, and the invite is gone.
    const tab = openAdmin(adminBrowser.respond);
    await tab.settle();
    expect(rows(tab).map((r) => [rowOf(r).name, rowOf(r).tags, rowOf(r).workspace, rowOf(r).menu])).toEqual([
      ["realadmin", ["Admin"], "Account", ["Set allowance"]],
      ["mara", [], "mara", ["Set allowance", "Disable"]],
    ]);
    expect(tab.$("invites-empty").shown).toBe(true);
    const before = rowOf(rows(tab)[1]);

    // Disable: the new account's session is refused from then on.
    choose(rows(tab)[1], "Disable");
    tab.$("disable-go").click();
    await tab.settle();
    expect(rowOf(rows(tab)[1]).tags).toEqual(["Disabled"]);
    expect((await invitee.ask("GET", "/api/v1/session")).status).toBe(401);
    expect((await invitee.ask("GET", "/api/v1/tokens")).status).toBe(401);

    // Enable: the row is as it was.
    choose(rows(tab)[1], "Enable");
    await tab.settle();
    expect(rowOf(rows(tab)[1])).toEqual(before);
    expect(await deps.db.first("SELECT status FROM user WHERE id = ?", [mara!.id])).toEqual({ status: "active" });

    // Disable again, then delete with the username typed, to the end.
    choose(rows(tab)[1], "Disable");
    tab.$("disable-go").click();
    await tab.settle();
    choose(rows(tab)[1], "Delete");
    await tab.settle();
    expect(tab.$("delete-title").textContent).toBe('Delete "mara" for good?');
    expect(tab.$("delete-go").disabled).toBe(true);
    type(tab, "mara", "delete-input");
    tab.$("delete-go").click();
    await drain(tab);
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect(noteOf(tab, "admin-note")?.[0]).toBe("mara was deleted.");
    expect(rows(tab).map((r) => rowOf(r).name)).toEqual(["realadmin"]);
    expect(tab.$("admin-summary").textContent).toMatch(/^1 account · /);
    expect(await deps.db.first("SELECT id FROM user WHERE id = ?", [mara!.id])).toBeNull();

    // The address can be invited again, from the same page.
    type(tab, "mara@example.com", "invite-email");
    tab.$("invite-go").click();
    await tab.settle();
    await made.settle();
    expect(noteOf(tab, "invite-note")?.[0]).toMatch(/^An invite is on its way to mara@example\.com\./);
    expect(invRows(tab).map((r) => invOf(r).address)).toEqual(["mara@example.com"]);
    expect(mail.sent.filter((m) => m.to === "mara@example.com")).toHaveLength(2);
    const audit = await deps.db.all<{ event: string }>("SELECT event FROM audit WHERE event LIKE 'account_%' OR event LIKE 'invite_%' ORDER BY rowid");
    expect(audit.map((a) => a.event)).toEqual(["invite_sent", "invite_accepted", "account_disabled", "account_enabled", "account_disabled", "account_deleted", "invite_sent"]);
  });
});
