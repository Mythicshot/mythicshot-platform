// The dashboard's Admin page, /admin, and its script /dash/admin.js: what their answers
// are (headers, where they answer, no database or storage call, nothing about anyone and
// the same document for an admin and a member), the exact wording of the approved mockups
// 9 and 10, and what the script's text may and may not do. What the script does when it
// runs, for an admin and for a member, and the size parser's table of inputs, are tested
// under Node in test/node-dash-admin.test.ts: the Workers runtime runs no code from a
// string, so on this target the parser's rule is pinned by its text.
import { describe, expect, it } from "vitest";
import { MANROPE_FACE } from "../src/brand-css.ts";
import { makeDeps, seedAccount } from "#harness";
import { ADMIN_HTML, ADMIN_JS, SIZE_JS } from "../src/dash/admin.ts";
import { DASH_PAGES } from "../src/dash/routes.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { send, type Call } from "./bundle.ts";
import { isBrandMarkAlt } from "./dash-checks.ts";
import { FakeDocument, textNodes } from "./pages-dom.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const UNKNOWN = "https://evil.example.net";
const NOT_FOUND = '{"error":"not_found"}';
const BROWSER = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const POLICY = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY: Record<string, string> = {
  "content-security-policy": POLICY,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};

type Served = { path: string; body: string; type: string };
const PAGE: Served = { path: "/admin", body: ADMIN_HTML, type: "text/html; charset=utf-8" };
const SCRIPT: Served = { path: "/dash/admin.js", body: ADMIN_JS, type: "text/javascript; charset=utf-8" };
const ALL = [PAGE, SCRIPT];

const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** A signed-in browser's cookie for a new account. */
async function signedIn(deps: Parameters<typeof seedAccount>[0], opts: { admin?: boolean; username?: string } = {}) {
  const account = await seedAccount(deps, opts);
  const made = await redeemSignInCode(deps, await createSignInCode(deps, account.userId), BROWSER, null);
  expect(made).not.toBeNull();
  return { ...account, cookie: `${SESSION_COOKIE}=${made!.secret}`, secret: made!.secret, sessionId: made!.sessionId, csrf: await csrfFor(made!.secret) };
}

// ---- The wording ----

/** Every text of the Admin page's body, in order, hidden parts included. Nothing else may be in it. */
const ADMIN_WORDING = [
  "Mythicshot",
  "Images",
  "GIFs",
  "Tours",
  "Storage",
  "Connections",
  "Account",
  "Admin",
  "This page needs JavaScript.",
  // The invites set's mockup 1: the page's heading is "Admin", and the accounts are a card of their own.
  "Admin",
  "Invite someone",
  "They get a mail with a link that works once and for 7 days. They pick their own username and get an empty workspace of their own.",
  // Proposed: the field's name for a screen reader; the eye sees the placeholder.
  "Email address",
  "Send invite",
  "Open invites",
  "Address",
  "Sent",
  "Works until",
  "Actions",
  // Proposed: the open invites card with none.
  "No open invites.",
  "Accounts",
  "Account",
  "Workspace",
  "Tours",
  // Proposed: the names a screen reader gives the bar's column and the buttons' column; the eye does not see them.
  "Share",
  "Used",
  "Allowance",
  "Joined",
  // 0.1.53: the site's terms, hidden on a site where no account has agreed to any (test/dash-terms.test.ts).
  "Terms",
  "Actions",
  "Show more",
  "You see totals only. What is in another person's workspace is never shown here.",
  "Page not found",
  "Back to Tours",
  "Allowance",
  "Cancel",
  "Save",
  "The link in the mail stops working. You can invite the same address again later.",
  "Keep it",
  "Cancel invite",
  "Pictures that people already opened may stay in their browsers.",
  "Keep it",
  "Disable account",
  "This removes the account and everything in its workspace:",
  "Tours",
  "Images and GIFs",
  "Connected computers",
  "Storage freed",
  "Keep it",
  "Delete account",
];

/** Every text the Admin page's script puts on the page. */
const ADMIN_TEXT: Record<string, string> = {
  oneAccount: "1 account",
  accounts: " accounts",
  dot: " · ",
  usedInAll: " used in all",
  standard: " · standard allowance ",
  noStandard: " · no standard allowance",
  admin: "Admin",
  over: "Over",
  none: "None",
  setAllowance: "Set allowance",
  tours: "Tours",
  used: "Used",
  allowance: "Allowance",
  askTitle: "Storage allowance for ",
  usesBefore: "Uses ",
  usesAfter: " now.",
  hintSize: "Write a size such as 500 MB or 10 GB.",
  hintStandardBefore: " Leave it empty to use the standard allowance of ",
  hintStandardAfter: ".",
  hintNone: " Leave it empty for no allowance.",
  warnBefore: "That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under ",
  warnAfter: ".",
  // Proposed (review follow-up): an allowance exactly what is used, and an allowance of 0.
  warnEqualBefore: "That is exactly what this workspace uses. Nothing is deleted, but its new uploads are refused until it is under ",
  zero: "An allowance of 0 refuses every upload from this workspace.",
  badSize: "Write a size such as 500 MB or 10 GB.",
  save: "Save",
  saveAnyway: "Save anyway",
  saving: "Saving…",
  notFound: "Page not found",
  disabled: "Disabled",
  notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
  // The invites set's mockups 1 to 4.
  more: "More",
  disable: "Disable",
  enable: "Enable",
  remove: "Delete",
  // Proposed: the tag of an account whose delete has started.
  deletingTag: "Deleting",
  sending: "Sending…",
  invitedBefore: "An invite is on its way to ",
  invitedMiddle: ". The link works once and until ",
  invitedAfter: ".",
  hasAccount: "That address already has an account.",
  badEmail: "That does not look like an email address.",
  // Proposed in the brief, pinned here.
  mailOff: "This site cannot send mail, so nobody can be invited from here.",
  mailFailed: "The invite was saved, but the mail could not be sent. Press Resend to try again.",
  tooManyInvites: "There are 100 open invites already. Cancel one you no longer need first.",
  // Proposed: the rest after a 429, as the Connections page's.
  restBefore: "Too many invites in a short time. Try again in ",
  oneMinute: "1 minute.",
  minutes: " minutes.",
  // Proposed: a send whose answer was lost, when the list then shows the invite.
  lostSendAfter: " has an invite now, but the answer was lost on the way, so it is not known whether its mail went out. If it does not arrive, press Resend.",
  // Proposed: the phone's line under an invite's address.
  sentInLine: "sent ",
  untilInLine: "works until ",
  ranOut: "Ran out ",
  resend: "Resend",
  cancel: "Cancel",
  // Proposed wording, not in the mockup (its caption only describes Resend), pinned here.
  resentBefore: "A new invite is on its way to ",
  resentAfter: ". The earlier link no longer works.",
  // Proposed: a resend whose answer was lost, when the list then shows new dates; and an invite that is gone.
  lostResendAfter: " has a new link, so the earlier one no longer works, but the answer was lost on the way, so it is not known whether its mail went out. If it does not arrive, press Resend again.",
  inviteGone: "That invite is no longer open: it was used or cancelled meanwhile.",
  cancelBefore: "Cancel the invite to ",
  cancelAfter: "?",
  cancelling: "Cancelling…",
  disableBefore: 'Disable "',
  quoteAfter: '"?',
  fromNowOn: "From now on ",
  disableMiddle: " cannot sign in, Mythicshot on their computers cannot publish, and their ",
  // Proposed in the brief, pinned here: "their 1 tour", "their 3 tours", and "their tours" for none.
  oneTour: "1 tour",
  manyTours: " tours",
  allTours: "tours",
  disableEnd: " and every image and clip they shared stop being available to anyone. Nothing is deleted: enabling the account brings everything back.",
  disabling: "Disabling…",
  // Proposed: More's label while an enable runs.
  enabling: "Enabling…",
  enabledAfter: " is enabled again. Their tours and shared links work as before; they sign in again to use the dashboard.",
  // Proposed in the brief, pinned here; the enable's own_account is proposed.
  ownDisable: "You cannot disable your own account.",
  lastAdminDisable: "This is the last admin, so it cannot be disabled.",
  ownEnable: "You cannot enable your own account.",
  beingDeleted: "This account is being deleted and cannot be enabled.",
  deleteBefore: 'Delete "',
  deleteAfter: '" for good?',
  removeWarnBefore: "This cannot be undone. Their links stop working for everyone, and ",
  removeWarnAfter: " can be invited again as a new account.",
  typeUsername: "Type the username to confirm",
  // Proposed: the label for an account without a username.
  typeEmail: "Type the email address to confirm",
  deletingBefore: 'Deleting "',
  deletingAfter: '"…',
  filesBefore: "Removing files, ",
  filesOf: " of ",
  filesAfter: ". Keep this page open. If it is interrupted, open Delete again to finish.",
  // Proposed: the note after a delete, and the delete's refusals (not_disabled's and site_owner's are the brief's).
  deletedAfter: " was deleted.",
  mismatch: "That does not match. Type it exactly as it is shown in the list.",
  notDisabled: "Disable the account first.",
  siteOwner: "This account set the site up and cannot be deleted.",
  sharedWorkspace: "Another account belongs to this workspace, so it cannot be deleted.",
  lastAdminDelete: "This is the last admin, so it cannot be deleted.",
  ownDelete: "You cannot delete your own account.",
  // Proposed in the review: the loop reached its call limit.
  tooLong: "This is taking longer than expected. Open Delete again to carry on.",
  // The invites set's mockup 1: the day the account was made.
  joined: "Joined",
  terms: "Terms",
  notYet: "Not yet",
  // New (review L5): an agreement to an older version, under "Not yet".
  agreedToBefore: "Agreed to ",
  agreedToMiddle: " on ",
};

/** The strings with a space in the script that are not words for a person: class names and lists of ids. */
const CLASS_NAMES = ["accounts", "accounts no-terms", "btn sm quiet", "btn sm danger", "tag warn", "n tours", "n used", "n allowance", "mini over", "allow-warn allow-message", "allow-hint allow-message", "d name", "ws name", "t name", "d narrow-only", "note plain", "delete-text delete-warn"];

/** A script's TEXT object, read from the script's own text. */
function scriptText(js: string): Record<string, string> {
  const block = /\n {2}var TEXT = \{\n([\s\S]*?)\n {2}\};\n/.exec(js);
  expect(block, "the script keeps its words in one TEXT object").not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of block![1].split("\n")) {
    const m = /^ {4}([a-zA-Z]+): ("(?:[^"\\]|\\.)*"|'[^'\\]*'),$/.exec(line);
    expect(m, `a line of TEXT: ${line}`).not.toBeNull();
    out[m![1]] = m![2].startsWith("'") ? m![2].slice(1, -1) : JSON.parse(m![2]);
  }
  return out;
}

/** Every quoted string in a script outside its comments, unescaped. */
function scriptStrings(script: string): string[] {
  const js = script
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return [
    ...[...js.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string),
    ...[...js.matchAll(/'[^'\\\n]*'/g)].map((m) => m[0].slice(1, -1)),
  ];
}

describe("the Admin page and its script", () => {
  it("each answers with the sign-in pages' headers, makes no database or storage call, and is in the dashboard's routes", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of ALL) {
      for (const [deps, origin] of [[one.deps, "https://any.example.org"], [one.deps, "http://localhost:3000"], [two.deps, APP]] as const) {
        const r = await send(deps, "GET", s.path, { origin });
        expect(r.status, `${origin} ${s.path}`).toBe(200);
        expect(r.text, s.path).toBe(s.body);
        expect(Object.fromEntries(r.headers.entries()), s.path).toEqual({ ...SECURITY, "content-type": s.type });
        expect(r.calls, `${s.path}: database and storage calls`).toBe(0);
      }
      const head = await send(two.deps, "HEAD", s.path, { origin: APP });
      expect([head.status, head.bytes.length, head.headers.get("content-security-policy"), head.calls], s.path).toEqual([200, 0, POLICY, 0]);
    }
    const entry = DASH_PAGES.find((p) => p.path === "/admin");
    expect(entry && [entry.path, entry.html, entry.script.path, entry.script.body]).toEqual(["/admin", ADMIN_HTML, "/dash/admin.js", ADMIN_JS]);
    expect(DASH_PAGES.filter((p) => p.path === "/admin" || p.script.path === "/dash/admin.js")).toHaveLength(1);
  });

  it("the page is the same for nobody, a member, an admin and a token, and holds nothing about anyone", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await signedIn(deps, { admin: true, username: "admincheck-owner" });
    const member = await signedIn(deps, { username: "admincheck-member" });
    const secrets = [admin.email, member.email, "admincheck-owner", "admincheck-member", admin.userId, member.userId, admin.workspaceId, member.workspaceId, admin.token, member.token, admin.secret, member.secret, admin.sessionId, admin.csrf, member.csrf];
    for (const s of ALL) {
      const nobody = await send(deps, "GET", s.path, { origin: APP });
      const answers = [
        await send(deps, "GET", s.path, { origin: APP, headers: { cookie: admin.cookie, "user-agent": BROWSER } }),
        await send(deps, "GET", s.path, { origin: APP, headers: { cookie: member.cookie, "user-agent": BROWSER } }),
        await send(deps, "GET", s.path, { origin: APP, token: admin.token }),
      ];
      for (const r of [nobody, ...answers]) {
        expect(seen(r), s.path).toEqual(seen(nobody));
        expect(r.calls, s.path).toBe(0);
        expect(r.headers.get("set-cookie"), s.path).toBeNull();
        for (const secret of secrets) expect(r.text, `${s.path} holds ${secret}`).not.toContain(secret);
      }
    }
    // The admin screen is hidden in the document; only the script shows it, after the session says admin.
    const doc = new FakeDocument(ADMIN_HTML);
    expect(doc.getElementById("admin")!.hidden).toBe(true);
    expect(doc.getElementById("missing")!.hidden).toBe(true);
    expect(doc.getElementById("allow-dialog")!.hidden).toBe(true);
    expect(doc.getElementById("tab-admin")!.hidden).toBe(true);
    expect(doc.getElementById("tab-admin")!.getAttribute("aria-current")).toBe("page");
  });

  it("answers on the app address only: the tours address refuses it, an unknown address is misdirected", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    await seedAccount(two.deps, { admin: true, username: "admincheck-admin" });
    const viewer = await signedIn(two.deps, { admin: false, username: "admincheck-viewer" });
    for (const s of ALL) {
      expect(HOST_RULES[`GET ${s.path}`], s.path).toBe("app");
      for (const headers of [{}, { cookie: viewer.cookie }] as Record<string, string>[]) {
        const onTours = await send(two.deps, "GET", s.path, { origin: TOURS, headers });
        expect([onTours.status, onTours.text, onTours.calls, onTours.headers.get("location")], `tours ${s.path}`).toEqual([404, NOT_FOUND, 0, null]);
      }
      const unknown = await send(two.deps, "GET", s.path, { origin: UNKNOWN });
      expect([unknown.status, unknown.bytes.length, unknown.calls], `unknown ${s.path}`).toEqual([421, 0, 0]);
      expect(UNDOCUMENTED_ROUTES[`GET ${s.path}`]?.length ?? 0, s.path).toBeGreaterThan(10);
    }
  });

  it("the wording is mockups 9 and 10's own, and the invites set's mockups 1 to 4", () => {
    const doc = new FakeDocument(ADMIN_HTML);
    expect(textNodes(doc.body)).toEqual(ADMIN_WORDING);
    expect(textNodes(doc.head)).toEqual(["Admin"]);
    // The one placeholder is the invite field's, mockup 1's example address.
    for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt"]) expect(e.hasAttribute(name) && !isBrandMarkAlt(e, name), `<${e.tagName} ${name}>`).toBe(false);
    expect(doc.body.all().filter((e) => e.hasAttribute("placeholder")).map((e) => [e.id, e.getAttribute("placeholder")])).toEqual([["invite-email", "name@example.com"]]);
    expect(scriptText(ADMIN_JS)).toEqual(ADMIN_TEXT);
    const words = new Set(Object.values(ADMIN_TEXT));
    const sentences = scriptStrings(ADMIN_JS).filter((t) => /[a-z]/i.test(t) && /\s/.test(t) && t !== "use strict");
    for (const t of sentences) expect(words.has(t) || CLASS_NAMES.includes(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
    // The sentences of mockups 9 and 10, put together from their parts.
    const T = ADMIN_TEXT;
    expect("3" + T.accounts + T.dot + "6.6 GB" + T.usedInAll + T.standard + "5 GB").toBe("3 accounts · 6.6 GB used in all · standard allowance 5 GB");
    expect(T.oneAccount + T.dot + "0 bytes" + T.usedInAll + T.noStandard).toBe("1 account · 0 bytes used in all · no standard allowance");
    expect(T.askTitle + "Harbor Studio").toBe("Storage allowance for Harbor Studio");
    expect(T.usesBefore + "5.3 GB" + T.usesAfter).toBe("Uses 5.3 GB now.");
    expect(T.hintSize + T.hintStandardBefore + "5 GB" + T.hintStandardAfter).toBe("Write a size such as 500 MB or 10 GB. Leave it empty to use the standard allowance of 5 GB.");
    expect(T.hintSize + T.hintNone).toBe("Write a size such as 500 MB or 10 GB. Leave it empty for no allowance.");
    expect(T.warnBefore + "2 GB" + T.warnAfter).toBe("That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under 2 GB.");
    // The sentences of the invites set's mockups 1 to 4, put together from their parts.
    expect(T.invitedBefore + "mara@example.com" + T.invitedMiddle + "27 Nov 2026" + T.invitedAfter).toBe("An invite is on its way to mara@example.com. The link works once and until 27 Nov 2026.");
    expect(T.ranOut + "19 Nov").toBe("Ran out 19 Nov");
    expect(T.cancelBefore + "mara@example.com" + T.cancelAfter).toBe("Cancel the invite to mara@example.com?");
    // Proposed wording (not in the mockups), put together from its parts.
    expect(T.resentBefore + "mara@example.com" + T.resentAfter).toBe("A new invite is on its way to mara@example.com. The earlier link no longer works.");
    // Mockups 3 and 4 again.
    expect(T.disableBefore + "tess" + T.quoteAfter).toBe('Disable "tess"?');
    expect(T.fromNowOn + "tess" + T.disableMiddle + "3" + T.manyTours + T.disableEnd).toBe(
      "From now on tess cannot sign in, Mythicshot on their computers cannot publish, and their 3 tours and every image and clip they shared stop being available to anyone. Nothing is deleted: enabling the account brings everything back.",
    );
    expect(T.fromNowOn + "tess" + T.disableMiddle + T.oneTour + T.disableEnd).toContain("and their 1 tour and every image");
    expect(T.fromNowOn + "tess" + T.disableMiddle + T.allTours + T.disableEnd).toContain("and their tours and every image");
    expect("tess" + T.enabledAfter).toBe("tess is enabled again. Their tours and shared links work as before; they sign in again to use the dashboard.");
    expect(T.deleteBefore + "rook" + T.deleteAfter).toBe('Delete "rook" for good?');
    expect(T.removeWarnBefore + "rook@example.com" + T.removeWarnAfter).toBe("This cannot be undone. Their links stop working for everyone, and rook@example.com can be invited again as a new account.");
    expect(T.deletingBefore + "rook" + T.deletingAfter).toBe('Deleting "rook"…');
    expect(T.filesBefore + "240" + T.filesOf + "400" + T.filesAfter).toBe("Removing files, 240 of 400. Keep this page open. If it is interrupted, open Delete again to finish.");
    expect(T.restBefore + "60" + T.minutes).toBe("Too many invites in a short time. Try again in 60 minutes.");
    // The failure sentences are the shared script's approved ones; the page has none of its own.
    expect(ADMIN_JS).toContain("Dash.failure(");
    expect(ADMIN_JS).not.toMatch(/Something went wrong|Too many requests/);
    // Text only through textContent; no confirm().
    for (const api of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "DOMParser", "srcdoc", "confirm(", "alert(", "prompt("]) expect(ADMIN_JS, api).not.toContain(api);
  });

  it("the page loads nothing from another origin and carries no inline script, style or handler", () => {
    const doc = new FakeDocument(ADMIN_HTML);
    const all = doc.root.all();
    expect(all.filter((e) => e.tagName === "script").map((e) => [e.getAttribute("src"), e.hasAttribute("defer"), e.textContent])).toEqual([
      ["/dash/dash.js", true, ""],
      ["/dash/admin.js", true, ""],
    ]);
    expect(all.filter((e) => e.tagName === "link").map((e) => [e.getAttribute("rel"), e.getAttribute("href")])).toEqual([["icon", "/favicon.ico"], ["icon", "/favicon.svg"], ["stylesheet", "/dash/dash.css"]]);
    expect(all.filter((e) => e.tagName === "style")).toEqual([]);
    for (const e of all) {
      for (const [name, value] of e.attrs) {
        expect(name === "style" || name.startsWith("on"), `<${e.tagName} ${name}>`).toBe(false);
        if (["src", "href", "action", "formaction", "srcset", "poster", "data"].includes(name)) expect(value, name).toMatch(/^\/(?!\/)/);
      }
    }
    expect(ADMIN_HTML).not.toMatch(/https?:|\/\//i);
    expect(all.filter((e) => e.tagName === "form")).toEqual([]);
    // The script sets no style or handler attribute; the one style it touches is a bar's width, through the CSSOM.
    expect(ADMIN_JS).not.toMatch(/setAttribute\("(?:style|on[a-z]+|src|srcdoc|href)"/);
    expect(ADMIN_JS).not.toMatch(/\.on[a-z]+\s*=/);
    expect([...ADMIN_JS.matchAll(/\.style\b[^;]*/g)].map((m) => m[0])).toEqual(['.style.width = width + "%"', '.style.width = share + "%"']);
    expect(DASH_CSS.replace(MANROPE_FACE, "")).not.toMatch(/url\(|@import|https?:|\/\/|expression\(/i);
  });

  it("the script keeps to this site and to the admin routes, and a member's page asks for nothing of them", () => {
    expect(ADMIN_JS).not.toMatch(/\bfetch\(/);
    expect(ADMIN_JS).not.toMatch(/csrf/i);
    // Every request, by method and path.
    const requests = [...ADMIN_JS.matchAll(/\bapi\("([A-Z]+)", ([^,)]*)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(requests.sort()).toEqual(
      [
        'GET "/api/v1/admin/summary"',
        "GET path",
        "PATCH WORKSPACES + encodeURIComponent(id",
        "GET INVITES",
        "POST INVITES",
        'POST INVITES + "/" + encodeURIComponent(v.id',
        'DELETE INVITES + "/" + encodeURIComponent(v.id',
        'POST ACCOUNTS + "/" + encodeURIComponent(d.id',
        'POST ACCOUNTS + "/" + encodeURIComponent(a.id',
        'GET ACCOUNTS + "/" + encodeURIComponent(a.id',
        "DELETE path",
      ].sort(),
    );
    expect(ADMIN_JS).toContain('var ACCOUNTS = "/api/v1/admin/accounts";');
    expect(ADMIN_JS).toContain('var WORKSPACES = "/api/v1/admin/workspaces/";');
    expect(ADMIN_JS).toContain('var INVITES = "/api/v1/admin/invites";');
    expect(ADMIN_JS).toContain('var path = after === null ? ACCOUNTS : ACCOUNTS + "?after=" + encodeURIComponent(after);');
    // Each request with its whole path and its body, as written.
    for (const line of [
      'Dash.api("POST", INVITES, { email: v })',
      'Dash.api("POST", INVITES + "/" + encodeURIComponent(v.id) + "/resend")',
      'Dash.api("DELETE", INVITES + "/" + encodeURIComponent(v.id))',
      'Dash.api("POST", ACCOUNTS + "/" + encodeURIComponent(d.id) + "/disable")',
      'Dash.api("POST", ACCOUNTS + "/" + encodeURIComponent(a.id) + "/enable")',
      'Dash.api("GET", ACCOUNTS + "/" + encodeURIComponent(a.id) + "/removal")',
      'var path = ACCOUNTS + "/" + encodeURIComponent(r.id);',
      'Dash.api("DELETE", path, { username: r.expected })',
    ]) expect(ADMIN_JS, line).toContain(line);
    // An address goes only into a body: "email" is never part of a path.
    expect(ADMIN_JS).not.toMatch(/(?:INVITES|ACCOUNTS) \+[^;]*email/);
    // The ids that go into an address are checked first, each against the API's shape.
    expect(ADMIN_JS).toContain("var USER_ID = /^usr_[0-9a-f]{24}$/;");
    expect(ADMIN_JS).toContain("var WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;");
    expect(ADMIN_JS).toContain("var INVITE_ID = /^inv_[0-9a-f]{24}$/;");
    expect(ADMIN_JS).toContain("if (!free() || blocked() || !INVITE_ID.test(v.id)) return;");
    expect(ADMIN_JS).toContain("if (!free() || !INVITE_ID.test(v.id)) return;");
    expect(ADMIN_JS.match(/if \(!free\(\) \|\| !USER_ID\.test\(a\.id\)\) return;/g)).toHaveLength(3);
    expect(ADMIN_JS).toContain("return list.filter(function (a) { return a !== null && typeof a === \"object\" && typeof a.workspace_id === \"string\" && WORKSPACE_ID.test(a.workspace_id)");
    expect(ADMIN_JS).toContain("var own = me === null || a.id === me || !USER_ID.test(a.id);");
    // Nothing is asked of the admin routes before the session says admin.
    expect(ADMIN_JS).toContain("if (who.admin !== true) { notFound(); return; }");
    // Nothing is stored, no cookie is touched, and leaving the page goes only to /signin, through the shared script.
    const forbidden = ["localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState", "replaceState", "location", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(", "eval(", "Function(", "console.", "window.open", "setInterval(", "document.referrer", "navigator."];
    for (const api of forbidden) expect(ADMIN_JS, api).not.toContain(api);
    // The two timers: the pause between a delete's calls, and the end of the rest after a 429.
    expect(ADMIN_JS.match(/setTimeout\(/g)).toHaveLength(2);
    // A delete's loop is bounded twice over: misses in a row, and calls in all (a count too
    // large to run in a test, so pinned by its text; the misses are run in test/node-dash-admin-actions.test.ts).
    for (const line of [
      "var MAX_MISSES = 3;",
      "var MAX_ROUNDS = 5000;",
      "return rounds < MAX_ROUNDS ? pause(PAUSE_MS).then(sendUnlessLeft) : finish(null, false, true);",
      "if (again && rounds >= MAX_ROUNDS) return finish(res, false, true);",
      "if (misses < MAX_MISSES) return pause(MISS_PAUSES_MS[misses - 1]).then(sendUnlessLeft);",
      // Reaching the call limit ends with its own sentence.
      "deleteQ.say(tooLong ? TEXT.tooLong : refusalOf(\"delete\", res));",
      // Leaving the page stops the loop: checked before every send and after every pause.
      'addEventListener("pagehide", function () { pageLeft = true; });',
      "if (pageLeft) return finish(null, false, false);",
      "return pageLeft ? finish(null, false, false) : send();",
    ]) expect(ADMIN_JS, line).toContain(line);
    expect(ADMIN_TEXT.tooLong).toBe("This is taking longer than expected. Open Delete again to carry on.");
    // The one listener on the window, and nothing else of it.
    expect(ADMIN_JS.match(/\baddEventListener\("pagehide"/g)).toHaveLength(1);
    // No other page serves, loads or names the Admin page's script.
    for (const p of DASH_PAGES.filter((x) => x.path !== "/admin")) {
      expect(p.html, p.path).not.toContain("/dash/admin.js");
      expect(p.script.body, p.path).not.toContain("admin.js");
    }
    expect(DASH_JS).not.toContain("admin.js");
    // The one link in the page leads back to Tours.
    const links = new FakeDocument(ADMIN_HTML).body.all().filter((e) => e.tagName === "a" && e.parent?.tagName !== "nav");
    expect(links.map((a) => [a.getAttribute("href"), a.textContent])).toEqual([["/tours", "Back to Tours"]]);
  });

  it("the size parser's rule: digits with at most one decimal part, then B, byte(s), KB, MB or GB in any case, 1024 to the next unit", () => {
    expect(ADMIN_JS).toContain(SIZE_JS);
    expect(SIZE_JS).toContain("var SIZE = /^([0-9]+)(?:\\.([0-9]+))?\\s*(b|bytes?|kb|mb|gb)?$/i;");
    expect(SIZE_JS).toContain('var UNITS = { b: 1, byte: 1, bytes: 1, kb: 1024, mb: 1048576, gb: 1073741824 };');
    expect(SIZE_JS).toContain("var MAX_BYTES = 9007199254740991;");
    // Rounded exactly, on whole numbers: no floating point anywhere (review follow-up B6).
    expect(SIZE_JS).toContain("BigInt(");
    expect(SIZE_JS).not.toMatch(/Math\.round|parseFloat|Number\(m\[/);
  });

  it("the page is usable with the keyboard and a screen reader, and its table becomes blocks on a phone", () => {
    const doc = new FakeDocument(ADMIN_HTML);
    const all = doc.root.all();
    for (const b of all.filter((e) => e.tagName === "button")) expect(b.getAttribute("type"), `#${b.id}`).toBe("button");
    const messages = all.filter((e) => /\b(?:message|load)\b/.test(e.className) && e.parent?.tagName !== "noscript");
    expect(messages.map((m) => m.id).sort()).toEqual(["admin-message", "allow-message", "cancel-message", "dash-load", "delete-message", "disable-message", "invite-message", "invites-message"]);
    for (const m of messages) expect([m.getAttribute("role"), m.getAttribute("aria-live")], `#${m.id}`).toEqual(["status", "polite"]);
    // A message line takes no room until it has a message; nor does a note.
    for (const m of messages.filter((e) => e.id !== "dash-load")) expect(m.hidden, `#${m.id}`).toBe(true);
    const notes = all.filter((e) => /\bnote\b/.test(e.className));
    expect(notes.map((n) => n.id)).toEqual(["invite-note", "invites-note", "admin-note"]);
    for (const n of notes) expect([n.getAttribute("role"), n.getAttribute("aria-live"), n.hidden], `#${n.id}`).toEqual(["status", "polite", true]);
    // The page behind a question, made inert while it is open: the bar and the admin screen.
    expect(ADMIN_JS).toContain('var BEHIND = ["dash-top", "admin"];');
    for (const h of all.filter((e) => e.tagName === "h1" || e.tagName === "h2")) expect(h.getAttribute("tabindex"), `#${h.id}`).toBe("-1");
    const dialogs = all.filter((e) => e.getAttribute("role") === "dialog" || e.getAttribute("role") === "alertdialog");
    expect(dialogs.map((d) => [d.id, d.getAttribute("role"), d.getAttribute("aria-modal"), d.getAttribute("aria-labelledby"), d.getAttribute("aria-describedby")])).toEqual([
      ["allow-box", "dialog", "true", "allow-title", "allow-uses"],
      ["cancel-box", "alertdialog", "true", "cancel-title", "cancel-text"],
      ["disable-box", "alertdialog", "true", "disable-title", "disable-text disable-warn"],
      ["delete-box", "alertdialog", "true", "delete-title", "delete-text delete-warn"],
    ]);
    const input = doc.getElementById("allow-input")!;
    expect([input.tagName, input.getAttribute("type"), input.getAttribute("autocomplete"), input.getAttribute("spellcheck"), input.getAttribute("aria-describedby")]).toEqual(["input", "text", "off", "false", "allow-hint allow-message"]);
    // The invite field: an email field the browser offers nothing for, named for a screen reader.
    const email = doc.getElementById("invite-email")!;
    expect([email.getAttribute("type"), email.getAttribute("autocomplete"), email.getAttribute("spellcheck"), email.getAttribute("maxlength"), email.getAttribute("aria-describedby")]).toEqual(["email", "off", "false", "254", "invite-text invite-message"]);
    const typed = doc.getElementById("delete-input")!;
    expect([typed.getAttribute("type"), typed.getAttribute("autocomplete"), typed.getAttribute("autocapitalize"), typed.getAttribute("spellcheck")]).toEqual(["text", "off", "off", "false"]);
    // The empty headers have names a screen reader reads and the eye does not see.
    expect(all.filter((e) => e.tagName === "th").map((th) => th.textContent)).toEqual(["Address", "Sent", "Works until", "Actions", "Account", "Workspace", "Tours", "Share", "Used", "Allowance", "Joined", "Terms", "Actions"]);
    for (const name of ["Share", "Actions", "Email address"]) for (const e of all.filter((x) => (x.tagName === "span" || x.tagName === "label") && x.textContent === name)) expect(e.className, name).toBe("vh");
    expect(all.filter((e) => e.tagName === "label").map((l) => l.getAttribute("for"))).toEqual(["invite-email", "allow-input", "delete-input"]);
    // Every element the script looks up by id is on the page.
    const ids = new Set(all.map((e) => e.id));
    const asked = [...ADMIN_JS.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
    expect(asked.length).toBeGreaterThan(10);
    for (const id of asked) expect(ids.has(id), `#${id}`).toBe(true);
    // The Admin page's own styles, after the shared ones: the small bar, the warning, and blocks on a phone.
    const own = DASH_CSS.slice(DASH_CSS.indexOf("/* The Admin page. */"));
    expect(DASH_CSS.indexOf("/* The Admin page. */")).toBeGreaterThan(DASH_CSS.indexOf("/* The Tours page. */"));
    expect(own).toContain(".accounts .mini { min-width: 80px; }");
    expect(own).toContain(".accounts .mini.over i { background: var(--caution-border); }");
    // A caution: an orange box with an edge and a warning sign, shared by every page.
    expect(DASH_CSS).toContain(".warn-box, .over-box { position: relative; padding: 10px 12px 10px 40px; border: 1px solid var(--caution-border); border-radius: var(--radius-md); background: var(--caution-tint); color: var(--caution-text);");
    const phone = [...own.matchAll(/@media \(max-width: 720px\) \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(phone).toContain(".accounts, .accounts tbody, .accounts tr, .accounts td { display: block; }");
    expect(phone).toContain(".accounts thead { display: none; }");
    expect(phone).toContain(".accounts td[data-label]::before { content: attr(data-label); ");
    // Invites become cards on a phone: the address, the line with the dates (or the tag), the buttons under them.
    expect(phone).toContain(".invites, .invites tbody, .invites tr, .invites td { display: block; }");
    expect(phone).toContain(".invites thead, .invites td.when { display: none; }");
    expect(phone).toContain(".invites td.acts-cell { margin-top: 8px; }");
    // A long question scrolls inside the screen.
    expect(own).toContain("#cancel-box, #disable-box, #delete-box { max-height: 100%; overflow-y: auto; }");
    expect(DASH_CSS).not.toMatch(/overflow-x|100vw/);
  });
});
