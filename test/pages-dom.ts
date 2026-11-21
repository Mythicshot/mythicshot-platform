// Test only: a small stand-in for a browser's document, built from the sign-in pages' own
// HTML, so the tests can read what each page shows and (under Node) run the pages' script
// against it. It understands exactly the HTML those pages use: elements, attributes,
// text, a doctype and void elements. No page script, style or entity beyond the five
// basic ones. It is not a browser: layout, focus rules and CSS are not modelled.

const VOID = new Set(["meta", "link", "input", "br", "img", "hr"]);
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

export class FakeText {
  parent: FakeElement | null = null;
  constructor(public text: string) {}
}

type Listener = (event: FakeEvent) => void;

/** What a keyboard event carries besides its type: the key, whether Shift was held, and whether it is a held key's repeat. */
export type KeyInit = { key?: string; shiftKey?: boolean; repeat?: boolean };

export class FakeEvent {
  defaultPrevented = false;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  constructor(
    public type: string,
    public target: FakeElement,
    init: KeyInit = {},
  ) {
    this.key = init.key ?? "";
    this.shiftKey = init.shiftKey === true;
    this.repeat = init.repeat === true;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

export class FakeElement {
  readonly attrs = new Map<string, string>();
  children: (FakeElement | FakeText)[] = [];
  parent: FakeElement | null = null;
  /** What the script set through the CSSOM (`el.style.width = …`); never an attribute. */
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<string, Listener[]>();
  private currentValue: string | null = null;
  private currentChecked: boolean | null = null;
  /** A progress bar's `max`, as the script sets the property. */
  max = 1;

  constructor(
    public readonly tagName: string,
    public readonly doc: FakeDocument,
  ) {}

  get id(): string {
    return this.attrs.get("id") ?? "";
  }
  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", String(v));
  }
  get type(): string {
    return this.attrs.get("type") ?? (this.tagName === "button" ? "submit" : "");
  }
  set type(v: string) {
    this.attrs.set("type", String(v));
  }
  get hidden(): boolean {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set("hidden", "");
    else this.attrs.delete("hidden");
  }
  get disabled(): boolean {
    return this.attrs.has("disabled");
  }
  set disabled(v: boolean) {
    if (v) this.attrs.set("disabled", "");
    else this.attrs.delete("disabled");
  }
  get value(): string {
    return this.currentValue ?? this.attrs.get("value") ?? "";
  }
  set value(v: string) {
    this.currentValue = String(v);
  }
  /** A checkbox's or radio button's state; setting a radio button checked unchecks the others of its name, as a browser does. */
  get checked(): boolean {
    return this.currentChecked ?? this.attrs.has("checked");
  }
  set checked(v: boolean) {
    this.currentChecked = v === true;
    const name = this.getAttribute("name");
    if (v !== true || this.type !== "radio" || name === null) return;
    for (const e of this.doc.root.all()) if (e !== this && e.tagName === "input" && e.type === "radio" && e.getAttribute("name") === name) e.currentChecked = false;
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parent = null;
    const t = new FakeText(String(v));
    t.parent = this;
    this.children = String(v) === "" ? [] : [t];
  }
  /** Markup is never set by the pages' script: anything that would parse HTML fails the test. */
  set innerHTML(_v: string) {
    throw new Error("innerHTML was set");
  }
  set outerHTML(_v: string) {
    throw new Error("outerHTML was set");
  }
  insertAdjacentHTML(): never {
    throw new Error("insertAdjacentHTML was called");
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    if (name === "style" || name.startsWith("on")) throw new Error(`the script set the ${name} attribute`);
    this.attrs.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  appendChild<T extends FakeElement | FakeText>(child: T): T {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild<T extends FakeElement | FakeText>(child: T): T {
    this.children = this.children.filter((c) => c !== child);
    child.parent = null;
    if (this.doc.activeElement && (this.doc.activeElement === child || (child instanceof FakeElement && child.contains(this.doc.activeElement)))) this.doc.activeElement = this.doc.body;
    return child;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  contains(other: FakeElement | null): boolean {
    for (let at: FakeElement | null = other; at !== null; at = at.parent) if (at === this) return true;
    return false;
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  /** Runs this element's listeners for `type`, then its ancestors' (bubbling). */
  dispatch(type: string, init: KeyInit = {}): FakeEvent {
    const event = new FakeEvent(type, this, init);
    for (let at: FakeElement | null = this; at !== null; at = at.parent) for (const fn of at.listeners.get(type) ?? []) fn(event);
    return event;
  }
  focus(): void {
    this.doc.activeElement = this;
    this.doc.focusLog.push(this.id || this.tagName);
  }
  select(): void {}
  /** What a person's click does: nothing on a disabled control; a radio button is checked (then "change"); a submit button submits its form. */
  click(): FakeEvent | null {
    if (this.disabled) return null;
    const turnsOn = this.tagName === "input" && this.type === "radio" && !this.checked;
    if (turnsOn) this.checked = true;
    const event = this.dispatch("click");
    if (turnsOn) this.dispatch("change");
    if (!event.defaultPrevented && this.tagName === "button" && this.type === "submit") {
      const form = this.closest("form");
      if (form) form.dispatch("submit");
    }
    return event;
  }
  closest(tag: string): FakeElement | null {
    for (let at: FakeElement | null = this; at !== null; at = at.parent) if (at.tagName === tag) return at;
    return null;
  }
  /** Every descendant element, in document order. */
  all(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) if (c instanceof FakeElement) out.push(c, ...c.all());
    return out;
  }
  /** True when this element and every ancestor is shown: not `hidden`, and not inside head or noscript. */
  get shown(): boolean {
    for (let at: FakeElement | null = this; at !== null; at = at.parent) if (at.hidden || at.tagName === "head" || at.tagName === "noscript") return false;
    return true;
  }
}

export class FakeDocument {
  readonly root: FakeElement;
  activeElement: FakeElement | null = null;
  /** The ids (or tag names) of everything focused, in order. */
  readonly focusLog: string[] = [];

  constructor(html: string) {
    this.root = new FakeElement("#document", this);
    parseInto(this, html);
  }
  /** When set, every use of the document by a script is written here as "document", in order with what else the test logs. */
  log: string[] | null = null;
  get body(): FakeElement {
    this.log?.push("document");
    return this.root.all().find((e) => e.tagName === "body")!;
  }
  get head(): FakeElement {
    return this.root.all().find((e) => e.tagName === "head")!;
  }
  /** The text of <title>, as a browser's document.title reads and writes it. */
  get title(): string {
    return this.root.all().find((e) => e.tagName === "title")?.textContent ?? "";
  }
  set title(v: string) {
    this.log?.push("document");
    const t = this.root.all().find((e) => e.tagName === "title");
    if (t) t.textContent = String(v);
  }
  /** Listeners on the document: events dispatched on any element bubble up to them. */
  addEventListener(type: string, fn: (event: FakeEvent) => void): void {
    this.root.addEventListener(type, fn);
  }
  getElementById(id: string): FakeElement | null {
    this.log?.push("document");
    return this.root.all().find((e) => e.id === id) ?? null;
  }
  createElement(tag: string): FakeElement {
    this.log?.push("document");
    return new FakeElement(tag.toLowerCase(), this);
  }
  /** Writing a cookie fails the test: the pages' script never touches one. */
  get cookie(): string {
    throw new Error("document.cookie was read");
  }
  set cookie(_v: string) {
    throw new Error("document.cookie was written");
  }
  write(): never {
    throw new Error("document.write was called");
  }
}

function decode(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);
}

function parseInto(doc: FakeDocument, html: string): void {
  const stack: FakeElement[] = [doc.root];
  const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/gi;
  let consumed = 0;
  for (const m of html.matchAll(token)) {
    if (m.index !== consumed) throw new Error(`the page's HTML could not be read at ${consumed}: ${html.slice(consumed, consumed + 40)}`);
    consumed += m[0].length;
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) {
      top.appendChild(new FakeText(decode(m[4])));
      continue;
    }
    if (m[2] === undefined) continue; // a comment or the doctype
    const tag = m[2].toLowerCase();
    if (m[1] === "/") {
      if (top.tagName !== tag) throw new Error(`</${tag}> closes <${top.tagName}>`);
      stack.pop();
      continue;
    }
    const el = new FakeElement(tag, doc);
    for (const a of (m[3] ?? "").matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) el.attrs.set(a[1].toLowerCase(), decode(a[2] ?? ""));
    top.appendChild(el);
    if (!VOID.has(tag)) stack.push(el);
  }
  if (consumed !== html.length) throw new Error("the page's HTML has text the reader did not take");
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].tagName}> is never closed`);
}

/** The text of every text node under `el`, trimmed, with runs of white space as one space, empty ones left out. */
export function textNodes(el: FakeElement, filter: (parent: FakeElement) => boolean = () => true): string[] {
  const out: string[] = [];
  const walk = (node: FakeElement) => {
    for (const c of node.children) {
      if (c instanceof FakeText) {
        const t = c.text.replace(/\s+/g, " ").trim();
        if (t !== "" && filter(node)) out.push(t);
      } else walk(c);
    }
  };
  walk(el);
  return out;
}

/** What a person sees in the body now: the text of every shown element, block by block, as one line each. */
export function visibleText(doc: FakeDocument): string[] {
  const BLOCKS = new Set(["p", "h1", "h2", "label", "button", "li"]);
  const out: string[] = [];
  for (const el of doc.body.all()) {
    if (!el.shown || !BLOCKS.has(el.tagName)) continue;
    // A row of a list: its parts in order, a button in it left to its own line.
    const t = el.tagName === "li" ? textNodes(el, (p) => p.closest("button") === null).join(" | ") : el.textContent.replace(/\s+/g, " ").trim();
    if (t !== "") out.push(t);
  }
  return out;
}
