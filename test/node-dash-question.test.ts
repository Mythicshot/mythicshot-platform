// The dashboard's one question helper, Dash.question in src/dash/script.ts, on its own: the
// shared script run in a fresh Node `vm` context against a small stand-in document that has
// a page, a backdrop and a question in it. The four pages that use it (Tours, Storage, Admin,
// Account) are tested through it in their own files. Node only: the Workers runtime runs no
// code from a string.
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { DASH_JS } from "../src/dash/script.ts";
import { FakeDocument, FakeElement } from "./pages-dom.ts";

const HTML = `<!doctype html>
<html lang="en"><head><title>t</title></head><body>
<header id="dash-top"><p id="dash-user"></p></header>
<main id="page"><p id="dash-load"></p><h1 id="h-page" tabindex="-1">Page</h1><button type="button" id="opener">Open</button></main>
<div class="backdrop" id="bd" hidden>
  <div class="dialog" id="box"><h2 id="q-title" tabindex="-1"></h2>
    <input id="q-field" type="text">
    <p class="message" id="q-message" hidden></p>
    <button type="button" id="q-cancel">Cancel</button>
    <button type="button" id="q-go">Go</button>
  </div>
</div>
</body></html>`;

type Q = {
  open(o?: Record<string, unknown>): boolean;
  close(refocus: boolean): void;
  dismiss(): void;
  say(text: string): void;
  busy(on: boolean, button?: string, label?: string): void;
  isOpen(): boolean;
  isWorking(): boolean;
};

function setUp(options: Record<string, unknown> = {}) {
  const doc = new FakeDocument(HTML);
  const ctx = vm.createContext({ document: doc, location: {}, fetch: () => Promise.reject(new Error("no")) });
  vm.runInContext(DASH_JS, ctx);
  (ctx as Record<string, unknown>).options = { backdrop: "bd", box: "box", role: "alertdialog", title: "q-title", message: "q-message", behind: ["dash-top", "page", "no-such-part"], fields: ["q-field"], buttons: ["q-cancel", "q-go"], lock: "readonly", ...options };
  const q = vm.runInContext("Dash.question(options)", ctx) as Q;
  const $ = (id: string) => doc.getElementById(id)!;
  const key = (k: string, shiftKey = false) => ((doc.activeElement as FakeElement | null) ?? doc.body).dispatch("keydown", { key: k, shiftKey }).defaultPrevented;
  const inert = () =>
    ["dash-top", "page"].map((id) => {
      expect($(id).hasAttribute("inert"), id).toBe($(id).getAttribute("aria-hidden") === "true");
      return $(id).hasAttribute("inert");
    });
  return { doc, q, $, key, inert };
}

describe("Dash.question", () => {
  it("opens with its title and first focus, sets its role, makes the parts behind it inert (leaving out a missing one), and starts with the message hidden", () => {
    const { doc, q, $, inert } = setUp();
    expect($("box").getAttribute("role")).toBe("alertdialog");
    expect([q.isOpen(), inert()]).toEqual([false, [false, false]]);
    expect(q.open({ title: '<b>Delete "x"?</b>', focus: "q-go" })).toBe(true);
    expect([q.isOpen(), $("bd").hidden, $("q-title").textContent, $("q-message").hidden]).toEqual([true, false, '<b>Delete "x"?</b>', true]);
    expect($("q-title").children.every((c) => !(c instanceof FakeElement))).toBe(true);
    expect(doc.activeElement).toBe($("q-go"));
    expect(inert()).toEqual([true, true]);
    // A second open while it is open does nothing.
    expect(q.open({ focus: "q-cancel" })).toBe(false);
    expect(doc.activeElement).toBe($("q-go"));
    // Without a focus named, the first field takes it.
    q.close(false);
    q.open();
    expect(doc.activeElement).toBe($("q-field"));
    expect(setUp({ role: "dialog" }).$("box").getAttribute("role")).toBe("dialog");
  });

  it("Tab and Shift+Tab go round the enabled controls only, from anywhere, at the document", () => {
    const { doc, q, $, key } = setUp();
    q.open();
    expect(key("Tab")).toBe(true);
    expect(doc.activeElement).toBe($("q-cancel"));
    expect(key("Tab")).toBe(true);
    expect(doc.activeElement).toBe($("q-go"));
    expect(key("Tab")).toBe(true);
    expect(doc.activeElement).toBe($("q-field"));
    expect(key("Tab", true)).toBe(true);
    expect(doc.activeElement).toBe($("q-go"));
    // A disabled control is passed over, never focused.
    $("q-cancel").disabled = true;
    $("q-field").focus();
    expect(key("Tab")).toBe(true);
    expect(doc.activeElement).toBe($("q-go"));
    $("q-cancel").disabled = false;
    // Focus that got out of the question comes back to the first, or with Shift to the last.
    doc.activeElement = doc.body;
    expect(key("Tab")).toBe(true);
    expect(doc.activeElement).toBe($("q-field"));
    doc.activeElement = doc.body;
    expect(key("Tab", true)).toBe(true);
    expect(doc.activeElement).toBe($("q-go"));
    // Other keys, and every key while it is closed, are left alone.
    expect(key("a")).toBe(false);
    q.close(false);
    expect(key("Tab")).toBe(false);
    expect(key("Escape")).toBe(false);
  });

  it("Escape and a click on the backdrop close it and give the focus back to what the page names, looked up at that moment, else the fallback", () => {
    const { doc, q, $, key, inert } = setUp();
    let target: FakeElement | null = $("opener");
    const closed: string[] = [];
    const open = () => q.open({ back: () => target, fallback: "h-page", onClose: () => closed.push("closed") });
    open();
    doc.activeElement = doc.body;
    expect(key("Escape")).toBe(true);
    expect([q.isOpen(), $("bd").hidden, doc.activeElement, inert(), closed]).toEqual([false, true, $("opener"), [false, false], ["closed"]]);
    // A click inside the question does not close it; one on the backdrop does.
    open();
    $("q-title").click();
    $("q-field").click();
    expect(q.isOpen()).toBe(true);
    target = null;
    $("bd").click();
    expect([q.isOpen(), doc.activeElement, closed]).toEqual([false, $("h-page"), ["closed", "closed"]]);
    // dismiss() is the page's own Cancel; close(false) leaves the focus where it is.
    open();
    q.dismiss();
    expect([q.isOpen(), doc.activeElement]).toEqual([false, $("h-page")]);
    open();
    $("q-field").focus();
    q.close(false);
    expect([q.isOpen(), doc.activeElement]).toEqual([false, $("q-field")]);
  });

  it("while a request runs: the controls are locked, the busy label shows, Escape and the backdrop do nothing, Tab keeps the focus on the title; close(false) still closes", () => {
    const { doc, q, $, key } = setUp();
    q.open();
    q.busy(true, "q-go", "Going…");
    expect(q.isWorking()).toBe(true);
    expect([$("q-go").textContent, $("q-go").disabled, $("q-go").getAttribute("aria-busy"), $("q-cancel").disabled, $("q-field").hasAttribute("readonly"), $("q-field").disabled]).toEqual(["Going…", true, "true", true, true, false]);
    expect(key("Escape")).toBe(true);
    $("bd").click();
    q.dismiss();
    expect(q.isOpen()).toBe(true);
    doc.activeElement = doc.body;
    expect(key("Tab")).toBe(true);
    expect(doc.activeElement).toBe($("q-title"));
    expect(key("Tab", true)).toBe(true);
    expect(doc.activeElement).toBe($("q-title"));
    q.busy(false, "q-go");
    expect([q.isWorking(), $("q-go").textContent, $("q-go").disabled, $("q-go").getAttribute("aria-busy"), $("q-cancel").disabled, $("q-field").hasAttribute("readonly")]).toEqual([false, "Go", false, null, false, false]);
    // A page whose field is disabled while it works.
    const other = setUp({ lock: "disabled" });
    other.q.open();
    other.q.busy(true, "q-go", "Going…");
    expect([other.$("q-field").disabled, other.$("q-field").hasAttribute("readonly")]).toEqual([true, false]);
    other.q.busy(false, "q-go");
    expect(other.$("q-field").disabled).toBe(false);
    // A question that ends while its request is running is closed by the page, without a refocus.
    q.busy(true, "q-go", "Going…");
    $("q-go").focus();
    q.close(false);
    expect(q.isOpen()).toBe(false);
    expect($("bd").hidden).toBe(true);
    q.busy(false, "q-go");
  });

  it("the message line is hidden until it holds text, and empty again on every open and close", () => {
    const { q, $ } = setUp();
    q.open();
    q.say("Something went wrong. Try again in a moment.");
    expect([$("q-message").textContent, $("q-message").hidden]).toEqual(["Something went wrong. Try again in a moment.", false]);
    q.say("");
    expect([$("q-message").textContent, $("q-message").hidden]).toEqual(["", true]);
    q.say("x");
    q.close(false);
    expect([$("q-message").textContent, $("q-message").hidden]).toEqual(["", true]);
    q.open();
    q.say("x");
    q.close(false);
    q.open();
    expect($("q-message").hidden).toBe(true);
    // A question without a message line ignores say().
    const bare = setUp({ message: undefined });
    bare.q.open();
    expect(() => bare.q.say("x")).not.toThrow();
  });

  it("tolerates parts that left the page: no backdrop means no question, and closing with nothing behind it does not throw", () => {
    const { q, $, doc } = setUp();
    q.open();
    $("page").remove();
    $("bd").remove();
    expect(() => q.close(true)).not.toThrow();
    expect(q.isOpen()).toBe(false);
    expect(q.open()).toBe(false);
    expect(doc.getElementById("bd")).toBeNull();
    const none = setUp({ backdrop: "nothing", box: "nothing-either" });
    expect(none.q.open()).toBe(false);
    expect(none.q.isOpen()).toBe(false);
  });
});
