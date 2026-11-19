/// <reference types="vite/client" />
// Checks on the provider guides in docs/hosting and on the Fly.io template that can be
// made without an account: every guide exists, follows the shared outline and says at
// its top that it is unverified (the shared cPanel hosting guide is not written from a
// provider's pages: it says at its top what was run on real hosting and what was not,
// and is checked against the script it describes); no guide names a hostname outside a short allow-list or
// an address outside the documentation ranges; links between docs resolve; the server guides install the
// way the Docker runbook does; and deploy/fly/fly.toml parses, holds no secret, and
// agrees with the Dockerfile and the compose file on the port, the data path and the
// health path.
//
// Files are read through Vite's ?raw imports, which work under both Vitest configs.
import { describe, expect, it } from "vitest";
import dockerfile from "../Dockerfile?raw";
import composeYml from "../deploy/docker-compose.yml?raw";
import flyToml from "../deploy/fly/fly.toml?raw";
import cpanelSh from "../deploy/cpanel/cpanel.sh?raw";
import installSh from "../deploy/install.sh?raw";
import packageJson from "../package.json?raw";
import packageCpanelTs from "../scripts/package-cpanel.ts?raw";
import appTs from "../src/app.ts?raw";
import adminTs from "../src/node/admin.ts?raw";
import hostGateTs from "../src/host-gate.ts?raw";

const HOSTING = import.meta.glob("../docs/hosting/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const RUNBOOKS = import.meta.glob("../docs/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Every file a guide may link to; only the keys are used. */
const REPO_FILES = Object.keys(
  import.meta.glob(["../*", "../deploy/**", "../docs/**", "../migrations/**", "../scripts/**", "../src/**", "../test/**"], { query: "?raw" }),
).map((k) => k.replace(/^\.\.\//, ""));

const strip = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/^\.\.\//, ""), v]));
/** The hosting docs, keyed by their path from the repo root. */
const hosting: Record<string, string> = strip(HOSTING);
/** Every markdown file a link's anchor may point into. */
const allDocs: Record<string, string> = { ...strip(RUNBOOKS), ...hosting };

const INDEX = "docs/hosting/README.md";
const FLY = "docs/hosting/fly.md";
const SERVER_GUIDES = ["docs/hosting/digitalocean.md", "docs/hosting/aws-lightsail.md", "docs/hosting/azure.md", "docs/hosting/linode.md", "docs/hosting/namecheap.md"];
const GUIDES = [...SERVER_GUIDES, FLY];
/** The guide for shared cPanel hosting: no provider, no prices and no external pages, so it has its own checks below. */
const CPANEL = "docs/hosting/cpanel.md";

/** Headings every guide has, without their step numbers. */
const SHARED_HEADINGS = ["What you need and what it costs", "Open the setup wizard", "Backups", "Updates", "Delete everything to stop paying", "Pages this guide relies on"];
/** Headings the four server guides add, in this order between the shared ones. */
const SERVER_HEADINGS = ["Create the server", "Open ports 80 and 443", "Point the domain at the server", "Connect by SSH", "Install the platform"];
const SERVER_OUTLINE = ["What you need and what it costs", ...SERVER_HEADINGS, "Open the setup wizard", "Backups", "Updates", "Delete everything to stop paying", "Pages this guide relies on"];

/**
 * The only hostnames the guides and the template may name, besides the example.com
 * placeholders and an app's own address under fly.dev: the providers' documentation and
 * pricing hosts the guides link to. Any other real domain fails the check below.
 */
const ALLOWED_HOSTS = new Set([
  "docs.docker.com",
  "www.digitalocean.com",
  "docs.digitalocean.com",
  "techdocs.akamai.com",
  "api.linode.com",
  "aws.amazon.com",
  "docs.aws.amazon.com",
  "learn.microsoft.com",
  "prices.azure.com",
  "docs.fly.io",
  "community.fly.io",
  "www.namecheap.com",
]);

/** Last labels that are file extensions, not top-level domains. */
const FILE_EXTENSIONS = new Set(["sh", "md", "yml", "yaml", "json", "ts", "js", "cjs", "sqlite", "tar", "gz", "tgz", "toml", "pem", "env", "html", "old", "new", "txt"]);

function isPlaceholderHost(host: string): boolean {
  return /(^|\.)example\.(com|net|org)$/.test(host) || /(^|\.)fly\.dev$/.test(host);
}

/** Splits a markdown text into its fenced code blocks and the prose around them. */
function split(md: string): { prose: string; blocks: { lang: string; body: string }[] } {
  const blocks: { lang: string; body: string }[] = [];
  const prose = md.replace(/^```([a-z]*)\n([\s\S]*?)^```$/gm, (_m, lang: string, body: string) => {
    blocks.push({ lang, body });
    return "";
  });
  return { prose, blocks };
}

/** Every line of code in a doc: inline spans and the lines of fenced blocks. */
function codeLines(md: string): string[] {
  const { prose, blocks } = split(md);
  return [...[...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]), ...blocks.flatMap((b) => b.body.split("\n"))];
}

/** The level-two headings of a doc, in order, without a leading step number. */
function sections(md: string): string[] {
  return [...split(md).prose.matchAll(/^## +(.+?) *$/gm)].map((m) => m[1].replace(/^\d+\. /, ""));
}

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens, repeats numbered. */
function anchors(md: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of split(md).prose.matchAll(/^#{1,6} +(.+?) *$/gm)) {
    const text = m[1].replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const base = text.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Resolves a relative link from a doc to a path from the repo root, or null if it leaves the repo. */
function resolveLink(from: string, target: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

type TomlValue = string | number | boolean;
type TomlTable = { [key: string]: TomlValue | TomlTable | TomlTable[] };

/**
 * Parses the part of TOML the template uses: comments, `key = value` with a string, an
 * integer or a boolean, `[table]` and `[[array of tables]]` headers with dotted names.
 * Anything else throws, so a template that grows past this subset fails loudly here.
 */
function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const descend = (path: string[], line: number): TomlTable => {
    let t: TomlTable = root;
    for (const name of path) {
      const next = t[name];
      if (next === undefined) t = t[name] = {};
      else if (Array.isArray(next)) t = next[next.length - 1];
      else if (typeof next === "object") t = next;
      else throw new Error(`line ${line}: ${name} is already a value`);
    }
    return t;
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) return;
    const n = i + 1;
    const arr = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/);
    const tab = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (arr) {
      const path = arr[1].split(".");
      const parent = descend(path.slice(0, -1), n);
      const name = path[path.length - 1];
      const list = parent[name] ?? (parent[name] = []);
      if (!Array.isArray(list)) throw new Error(`line ${n}: ${arr[1]} is not an array of tables`);
      list.push((current = {}));
      return;
    }
    if (tab) {
      const path = tab[1].split(".");
      const parent = descend(path.slice(0, -1), n);
      const name = path[path.length - 1];
      if (parent[name] !== undefined) throw new Error(`line ${n}: table ${tab[1]} is defined twice`);
      parent[name] = current = {};
      return;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+) *= *(.+)$/);
    if (!kv) throw new Error(`line ${n}: cannot parse: ${line}`);
    const [, key, rest] = kv;
    if (key in current) throw new Error(`line ${n}: ${key} is set twice`);
    const str = rest.match(/^"([^"\\]*)"( *#.*)?$/);
    const num = rest.match(/^(-?\d+)( *#.*)?$/);
    const bool = rest.match(/^(true|false)( *#.*)?$/);
    if (str) current[key] = str[1];
    else if (num) current[key] = Number(num[1]);
    else if (bool) current[key] = bool[1] === "true";
    else throw new Error(`line ${n}: unsupported value: ${rest}`);
  });
  return root;
}

/** A table inside a parsed TOML document, or a failure naming the missing one. */
function table(t: TomlTable, name: string): TomlTable {
  const v = t[name];
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`[${name}] is missing`);
  return v;
}

/** An array of tables inside a parsed TOML document. */
function tables(t: TomlTable, name: string): TomlTable[] {
  const v = t[name];
  if (!Array.isArray(v)) throw new Error(`[[${name}]] is missing`);
  return v;
}

/** One capture from a source file, or a failure that names what was looked for. */
function capture(text: string, re: RegExp, what: string): string {
  const m = text.match(re);
  if (!m) throw new Error(`could not find ${what}`);
  return m[1];
}

/** What the image and the compose file say about the port, the data folder and the health check. */
function appFacts(): { port: number; dataDir: string; healthPath: string } {
  const env = capture(dockerfile, /^(ENV [\s\S]*?[^\\])\n/m, "the Dockerfile's ENV block");
  const port = Number(capture(env, /\bPORT=(\d+)/, "PORT in the Dockerfile"));
  const dataDir = capture(env, /\bDATA_DIR=(\S+)/, "DATA_DIR in the Dockerfile");
  const healthPath = capture(dockerfile, /^HEALTHCHECK[\s\S]*?\+'(\/[a-z]+)'\)/m, "the health path in the Dockerfile");
  // The Dockerfile agrees with itself, with the compose file and with the route table.
  expect(Number(capture(dockerfile, /^EXPOSE (\d+)$/m, "EXPOSE"))).toBe(port);
  expect(capture(dockerfile, /^VOLUME \["([^"]+)"\]$/m, "VOLUME")).toBe(dataDir);
  expect(Number(capture(composeYml, /^ {6}PORT: "(\d+)"$/m, "PORT in the compose file"))).toBe(port);
  expect(capture(composeYml, /^ {6}DATA_DIR: (\S+)$/m, "DATA_DIR in the compose file")).toBe(dataDir);
  expect(capture(composeYml, /^ {8}target: (\S+)$/m, "the bind target in the compose file")).toBe(dataDir);
  expect(appTs).toContain(`app.get("${healthPath}"`);
  return { port, dataDir, healthPath };
}

/** The commands and options install.sh's parse_args accepts. */
function scriptVocabulary(): Set<string> {
  const body = installSh.match(/^parse_args\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
  const words = new Set<string>();
  for (const m of body.matchAll(/^\s*([a-z| -]+)\)/gm)) for (const w of m[1].split("|").map((s) => s.trim())) if (w) words.add(w);
  return words;
}

describe("the hosting guides", () => {
  it("exist: the chooser and one guide per provider", () => {
    for (const p of [INDEX, ...GUIDES]) expect(hosting[p], p).toBeTypeOf("string");
    expect(Object.keys(hosting).sort()).toEqual([INDEX, ...GUIDES, CPANEL].sort());
  });

  it("every guide has the shared headings", () => {
    for (const p of GUIDES) {
      const have = sections(hosting[p]);
      for (const h of SHARED_HEADINGS) expect(have, `${p}: ${h}`).toContain(h);
      expect(have.some((h) => h.startsWith("Point the domain at ")), `${p}: a "Point the domain" section`).toBe(true);
      expect(have.indexOf("What you need and what it costs"), p).toBeLessThan(have.indexOf("Open the setup wizard"));
      expect(have[have.length - 1], p).toBe("Pages this guide relies on");
    }
  });

  it("the server guides follow one outline, in one order", () => {
    for (const p of SERVER_GUIDES) expect(sections(hosting[p]).filter((h) => h !== "Contents"), p).toEqual(SERVER_OUTLINE);
  });

  it("every numbered section has an entry in the guide's table of contents", () => {
    for (const p of GUIDES) {
      const toc = hosting[p].match(/^## Contents\n\n([\s\S]*?)\n\n## /m)?.[1] ?? "";
      const listed = [...toc.matchAll(/^- \[([^\]]+)\]\(#([^)]+)\)$/gm)].map((m) => m[1]);
      const have = [...split(hosting[p]).prose.matchAll(/^## +(.+?) *$/gm)].map((m) => m[1]).filter((h) => h !== "Contents");
      expect(listed, p).toEqual(have);
    }
  });

  it("every guide says at its top that it is not yet verified on a real account", () => {
    for (const p of [INDEX, ...GUIDES]) {
      const top = hosting[p].split("\n").slice(0, 6).join("\n");
      expect(top, p).toContain("> [!WARNING]");
      expect(top, p).toContain("Not yet verified on a real account");
    }
  });

  it("every guide says at its top how the software is obtained today", () => {
    for (const p of [INDEX, ...GUIDES]) {
      const top = hosting[p].split("\n").slice(0, 10).join("\n");
      expect(top, p).toMatch(/The software is not public yet/);
      expect(top, p).toMatch(/no public repository/);
      expect(top, p).toMatch(/from the owner/);
    }
    // The server guides need the image built by hand; the Fly guide builds it on Fly.
    for (const p of SERVER_GUIDES) expect(hosting[p].split("\n").slice(0, 10).join("\n"), p).toMatch(/no published image/);
  });

  it("no guide holds a real token or a real setup code", () => {
    for (const [p, text] of [...Object.entries(hosting), ["deploy/fly/fly.toml", flyToml]]) {
      expect(text, p).not.toMatch(/dp_[0-9a-f]{40}/);
      expect(text, p).not.toMatch(/SETUP_CODE=[0-9a-f]{16,}/);
    }
  });

  it("the only hostnames are the placeholders and the providers' own pages", () => {
    const problems: string[] = [];
    for (const [p, text] of [...Object.entries(hosting), ["deploy/fly/fly.toml", flyToml]]) {
      for (const m of text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63})\b/gi)) {
        const host = m[0].toLowerCase();
        const at = m.index ?? 0;
        if (text[at - 1] === "." || text[at - 1] === "/" || text[at - 1] === "_") continue; // the tail of a file name or a path
        if (FILE_EXTENSIONS.has(m[1].toLowerCase())) continue;
        if (isPlaceholderHost(host) || ALLOWED_HOSTS.has(host)) continue;
        if (host === "fly.io") continue; // the provider is called Fly.io; links to it are checked below
        problems.push(`${p}: ${host}`);
      }
      // Every link goes to an allowed host too, whatever its spelling.
      for (const m of text.matchAll(/https?:\/\/([^/\s)"'`]+)/g)) {
        const host = m[1].toLowerCase();
        if (!isPlaceholderHost(host) && !ALLOWED_HOSTS.has(host)) problems.push(`${p}: link to ${host}`);
      }
    }
    expect(problems).toEqual([]);
    // The check has teeth: a real domain in prose, in code or in a link is caught.
    const probe = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63})\b/gi;
    expect([..."open tours.realcompany.io now".matchAll(probe)].map((m) => m[0])).toEqual(["tours.realcompany.io"]);
    expect(isPlaceholderHost("tours.realcompany.io") || ALLOWED_HOSTS.has("tours.realcompany.io")).toBe(false);
    expect(isPlaceholderHost("tours.example.com") && isPlaceholderHost("tours-example.fly.dev")).toBe(true);
  });

  it("every guide uses the placeholder domain", () => {
    for (const p of GUIDES) expect(hosting[p], p).toContain("tours.example.com");
  });

  it("IP addresses are from the documentation ranges only", () => {
    const v4 = /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/;
    for (const [p, text] of [...Object.entries(hosting), ["deploy/fly/fly.toml", flyToml]]) {
      for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) expect(m[0], p).toMatch(v4);
      for (const m of text.matchAll(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi)) {
        if (/^[0-9]+:[0-9]+:[0-9]+$/.test(m[0])) continue; // a time
        expect(m[0].toLowerCase(), p).toMatch(/^2001:db8:/);
      }
    }
  });

  it("every relative link and anchor resolves", () => {
    const problems: string[] = [];
    for (const [p, text] of Object.entries(hosting)) {
      for (const m of split(text).prose.matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = m[1];
        if (/^[a-z]+:/.test(link)) continue;
        const [path, anchor] = link.split("#", 2);
        const target = path === "" ? p : resolveLink(p, path);
        if (target === null) {
          problems.push(`${p}: ${link} leaves the repo`);
          continue;
        }
        if (!REPO_FILES.includes(target)) problems.push(`${p}: ${link} does not exist`);
        else if (anchor !== undefined) {
          if (!(target in allDocs)) problems.push(`${p}: ${link} has an anchor into a file that is not a doc`);
          else if (!anchors(allDocs[target]).has(anchor)) problems.push(`${p}: ${link} names a missing heading`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every external link is https, and every provider claim has one", () => {
    for (const [p, text] of Object.entries(hosting)) {
      const urls = [...text.matchAll(/\]\(([a-z]+:[^)\s]+)\)/g)].map((m) => new URL(m[1]));
      for (const u of urls) expect(u.protocol, `${p}: ${u.href}`).toBe("https:");
      if (p !== INDEX && p !== CPANEL) expect(urls.length, p).toBeGreaterThanOrEqual(10);
    }
    // Each guide links its own provider's pages, not another's.
    const hosts: Record<string, RegExp> = {
      "docs/hosting/digitalocean.md": /(^|\.)digitalocean\.com$/,
      "docs/hosting/aws-lightsail.md": /(^|\.)(aws\.)?amazon\.com$/,
      "docs/hosting/azure.md": /(^|\.)(microsoft|azure)\.com$/,
      "docs/hosting/linode.md": /(^|\.)(akamai|linode)\.com$/,
      "docs/hosting/namecheap.md": /(^|\.)namecheap\.com$/,
      "docs/hosting/fly.md": /(^|\.)fly\.io$/,
    };
    for (const [p, re] of Object.entries(hosts)) {
      const provider = [...hosting[p].matchAll(/\]\((https:[^)\s]+)\)/g)].filter((m) => re.test(new URL(m[1]).hostname));
      expect(provider.length, p).toBeGreaterThanOrEqual(8);
    }
  });

  it("every guide dates its prices", () => {
    for (const p of [INDEX, ...GUIDES]) expect(hosting[p], p).toMatch(/[Cc]hecked 2026-11-17/);
  });

  it("the chooser links the five guides and both runbooks", () => {
    for (const p of GUIDES) expect(hosting[INDEX], p).toContain(`](${p.replace("docs/hosting/", "")})`);
    expect(hosting[INDEX]).toContain("](../runbook-docker.md)");
    expect(hosting[INDEX]).toContain("](../runbook-cloudflare.md)");
    expect(hosting[INDEX]).toMatch(/^\| Provider \| Monthly cost \| Effort \| Best for \|$/m);
  });

  it("the server guides install the way the Docker runbook does", () => {
    const runbook = allDocs["docs/runbook-docker.md"];
    const words = scriptVocabulary();
    expect(words.size).toBeGreaterThan(0);
    for (const p of SERVER_GUIDES) {
      const lines = codeLines(hosting[p]);
      // The runbook's own commands, taken from the runbook so the two cannot drift apart.
      for (const cmd of ["dpkg --print-architecture", "docker build -t demo-platform:latest .", "docker save -o demo-platform.tar demo-platform:latest"]) {
        expect(runbook, cmd).toContain(cmd);
        expect(lines, `${p}: ${cmd}`).toContain(cmd);
      }
      expect(lines.some((l) => /^(sudo )?docker load -i demo-platform\.tar$/.test(l)), `${p}: docker load`).toBe(true);
      expect(lines.filter((l) => /^(sudo )?bash install\.sh$/.test(l)).length, `${p}: install.sh is run twice`).toBeGreaterThanOrEqual(2);
      expect(lines.some((l) => /^scp .*demo-platform\.tar deploy\/install\.sh \S+@203\.0\.113\.10:$/.test(l)), `${p}: scp`).toBe(true);
      // Nothing the runbook does not offer: no registry, no pull, no piping a download into a shell.
      for (const l of lines) {
        expect(l, p).not.toMatch(/docker (pull|login|push)/);
        expect(l, p).not.toMatch(/curl[^|]*\|\s*(sudo )?(ba)?sh/);
        for (const m of l.matchAll(/install\.sh((?: +(?:--?[a-z][a-z-]*|[a-z]+)(?=\s|$))*)/g)) {
          for (const w of m[1].trim().split(/ +/).filter(Boolean)) expect(words, `${p}: install.sh ${w}`).toContain(w);
        }
      }
      expect(hosting[p], p).toContain("](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server)");
    }
  });

  it("every guide reaches the setup wizard and warns about the setup code and the token", () => {
    for (const p of GUIDES) {
      expect(hosting[p], p).toContain("https://tours.example.com/setup");
      expect(hosting[p], p).toMatch(/> \[!WARNING\]\n> Whoever enters the setup code first becomes the owner/);
      expect(hosting[p], p).toMatch(/> \[!WARNING\]\n> The API token works like a password/);
    }
  });

  it("every guide warns before data is deleted and says billing goes on until deletion", () => {
    for (const p of GUIDES) {
      const text = hosting[p];
      const last = text.slice(text.search(/^## \d+\. Delete everything to stop paying$/m));
      expect(last, p).toMatch(/> \[!WARNING\]\n> .*(cannot be undone|cannot be recovered|irretrievable|irreversible)/);
    }
    for (const p of SERVER_GUIDES) expect(hosting[p], p).toMatch(/> \[!WARNING\]\n> .*still billed|does not stop the bill/);
  });
});

describe("the shared cPanel hosting guide", () => {
  const guide = hosting[CPANEL];
  const lines = codeLines(guide);
  /** The commands and options cpanel.sh's parse_args accepts, without the short forms and the `name=value` spellings. */
  const vocabulary = (): { commands: string[]; flags: string[] } => {
    const body = cpanelSh.match(/^parse_args\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
    const words = [...new Set([...body.matchAll(/^ {6,8}([a-z| -]+)\)/gm)].flatMap((m) => m[1].split("|").map((s) => s.trim())).filter(Boolean))];
    return { commands: words.filter((w) => /^[a-z]+$/.test(w)), flags: words.filter((w) => /^--[a-z-]+$/.test(w) && w !== "--help") };
  };

  it("says at its top what was run on real hosting and what was only tested against stand-ins", () => {
    const top = guide.split("\n").slice(0, 8).join("\n");
    expect(top.split("\n").slice(0, 4).join("\n")).toContain("> [!WARNING]\n> Partly verified.");
    expect(top).toMatch(/Partly verified/);
    expect(top).toMatch(/done by hand on one real shared cPanel account, at one provider/);
    // Of the script, an update and a status have run there once; the rest has not.
    expect(top).toMatch(/`cpanel\.sh`[^\n]*the `update` and `status` commands of an earlier version have run once on that account, from an archive unpacked there/);
    expect(top).toMatch(/`install`, `backup` as a command of its own, the commands to go back and the second address have only been tested on a development computer against stand-ins/);
    expect(top).toMatch(/The software is not public yet/);
    expect(top).toMatch(/from the owner/);
    // The closing section keeps the two sides apart, and names the script's tests.
    expect(sections(guide)[sections(guide).length - 1]).toBe("What has been run where");
    const last = guide.slice(guide.indexOf("## What has been run where"));
    expect(last).toMatch(/\*\*Run by hand on real hosting,\*\*/);
    // What the script itself did there, once: an update over the hand-made install, and a status.
    const ran = last.slice(last.indexOf("**Run by the script on real hosting,**"), last.indexOf("**Tested only on a development computer,**"));
    expect(ran).toMatch(/^\*\*Run by the script on real hosting,\*\* once, on that same account, with Bash 4\.4 and the version of the script from before the second address:$/m);
    expect(ran).toMatch(/^- The archive from `npm run package:cpanel`, unpacked on the hosting\.$/m);
    expect(ran).toMatch(/^- `\.\/cpanel\.sh update` with `--domain`, over the install that had been made by hand: first as a dry run, then for real\./m);
    expect(ran).toMatch(/backup with the app's own Node\.js[^\n]*`app\.cjs` among them[^\n]*passed the health check/);
    expect(ran).toMatch(/^- What `npm ci` does to `node_modules` in the app folder\.[^\n]*`npm ci` kept the link\./m);
    expect(ran).toMatch(/^- `\.\/cpanel\.sh status`, from the installed copy\.$/m);
    expect(ran).not.toMatch(/cpanel\.sh (install|backup)/);
    // What it did not do there is listed as tested against stand-ins only.
    const only = last.slice(last.indexOf("**Tested only on a development computer,**"), last.indexOf("**Not yet confirmed on real hosting,**"));
    expect(only).toMatch(/^- `\.\/cpanel\.sh install`, and `\.\/cpanel\.sh backup` run as a command of its own\./m);
    for (const what of [/status code after a health check that passed/, /`sqlite3` tool/, /Resuming an update that was cut off, and the commands to go back/, /The second address/, /The restore steps/]) expect(only).toMatch(what);
    // The script's own header says the same.
    expect(cpanelSh).toMatch(/# script, update and status have run there once, with Bash 4\.4, from an archive unpacked/);
    expect(cpanelSh).toMatch(/# installed copy\. install, backup as a command of its own, resuming an update that was/);
    expect(cpanelSh).not.toMatch(/This script itself has\s+# only been run against stand-ins/);
    expect(last).toMatch(/\*\*Tested only on a development computer,\*\* never on real hosting/);
    expect(last).toContain("](../../deploy/cpanel/test-cpanel.sh)");
    // What nobody has seen on real hosting yet is listed: what only an install does, and the second address.
    const open = last.slice(last.indexOf("**Not yet confirmed on real hosting,**"));
    expect(open).toMatch(/^\*\*Not yet confirmed on real hosting,\*\*[^\n]*\n\n1\. That `cloudlinux-selector create` answers the way the script expects/);
    expect([...open.matchAll(/^(\d+)\. /gm)].map((m) => m[1])).toEqual(["1", "2", "3"]);
    // The link npm ci kept, and the hosting's Bash, are no longer open questions.
    expect(open).not.toMatch(/node_modules|Bash/);
    expect(cpanelSh).toContain("node_modules was a link into the Node.js environment before npm ci and is a plain folder now");
    expect((JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts["test:cpanel"]).toBe("bash deploy/cpanel/test-cpanel.sh");
  });

  it("links no external page, so none that was not opened, and names no provider", () => {
    expect([...guide.matchAll(/\]\(([a-z]+:[^)\s]+)\)/g)]).toEqual([]);
    expect(guide).not.toMatch(/https?:\/\/(?!(?:tours|app)\.example\.com\b)/);
    for (const p of SERVER_GUIDES) {
      const provider = hosting[p].match(/^# Host on (?:an? )?(\S+)/)?.[1] ?? "";
      expect(provider.length, p).toBeGreaterThan(2);
      expect(guide.toLowerCase(), provider).not.toContain(provider.toLowerCase());
    }
  });

  it("every section has an entry in its table of contents", () => {
    const toc = guide.match(/^## Contents\n\n([\s\S]*?)\n\n## /m)?.[1] ?? "";
    const listed = [...toc.matchAll(/^- \[([^\]]+)\]\(#([^)]+)\)$/gm)].map((m) => m[1]);
    const have = [...split(guide).prose.matchAll(/^## +(.+?) *$/gm)].map((m) => m[1]).filter((h) => h !== "Contents");
    expect(listed).toEqual(have);
    for (const h of ["What you need", "Create the subdomain", "Upload and unpack the archive", "Install the platform", "Read the setup code", "Open the setup wizard", "HTTPS", "Updates", "Backups", "Restore from a backup", "Roll back an update", "Troubleshooting", "A second address for the app"]) {
      expect(sections(guide), h).toContain(h);
    }
  });

  it("every cpanel.sh command and option the guide names exists, and every one the script has is in the guide", () => {
    const { commands, flags } = vocabulary();
    expect([...commands].sort()).toEqual(["admin", "backup", "install", "status", "update"]);
    expect([...flags].sort()).toEqual(["--allow-downgrade", "--app-domain", "--app-root", "--domain", "--dry-run", "--node", "--yes"]);
    // After `admin`, the script takes only its own options; from the first other word on, every word is the admin command's.
    const ADMIN_OWN = ["--app-root", "--node", "--dry-run"];
    const named = new Set<string>();
    for (const l of lines) {
      for (const m of l.matchAll(/cpanel\.sh((?: +(?:--[a-z][a-z-]*|[a-z]+(?=\s|$)|(?:tours|app)\.example\.com|<[a-z]+>))*)/g)) {
        let admin = false;
        for (const w of m[1].trim().split(/ +/).filter((x) => /^(--)?[a-z-]+$/.test(x))) {
          if (admin && !ADMIN_OWN.includes(w)) break;
          named.add(w);
          if (w === "admin") admin = true;
        }
      }
    }
    for (const w of named) expect([...commands, ...flags], `cpanel.sh ${w}`).toContain(w);
    for (const c of commands) expect(named, `cpanel.sh ${c}`).toContain(c);
    const words = new Set(lines.flatMap((l) => l.split(/\s+/)));
    for (const f of flags) expect(named.has(f) || words.has(f), `cpanel.sh ${f}`).toBe(true);
    // The script's own usage text names every one of them too.
    const usage = cpanelSh.match(/^usage\(\) \{\n([\s\S]*?)^USAGE$/m)?.[1] ?? "";
    for (const w of [...commands, ...flags]) expect(usage, w).toContain(w);
  });

  it("the defaults, paths and commands it gives are the script's", () => {
    expect(cpanelSh).toMatch(/^readonly DEFAULT_APP_ROOT=apps\/tours$/m);
    expect(cpanelSh).toMatch(/^readonly DEFAULT_NODE=24$/m);
    expect(guide).toContain("The default is `apps/tours`");
    expect(guide).toContain("`/home/you/apps/tours-data`");
    expect(guide).toContain("`/home/you/apps/tours-config.env`");
    expect(lines).toContain("./cpanel.sh install --domain tours.example.com");
    expect(lines).toContain("./cpanel.sh install --domain tours.example.com --dry-run");
    expect(lines).toContain("./cpanel.sh update");
    // The package step, the create command and the health address are the real ones.
    expect(cpanelSh).toContain("npm ci --omit=dev --ignore-scripts");
    expect(guide).toContain("`npm ci --omit=dev --ignore-scripts`");
    expect(cpanelSh).toContain("cloudlinux-selector create --json --interpreter nodejs");
    expect(guide).toContain("`cloudlinux-selector create`");
    // Health is asked at the recorded address, and at both when there are two.
    expect(cpanelSh).toContain('"https://$host/healthz"');
    expect(cpanelSh).toContain('check_address "$DOMAIN"');
    expect(cpanelSh).toContain('report_address "$DOMAIN" tours');
    expect(cpanelSh).toContain('report_address "$APP_DOMAIN" app');
    expect(appTs).toContain('app.get("/healthz"');
    expect(lines).toContain("curl https://tours.example.com/healthz");
    // The rollback commands the guide shows are the ones the script prints, with the guide's paths.
    const body = cpanelSh.match(/^print_rollback\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
    // Every one starts by changing into the app folder, quoted, so each stands alone.
    expect(body).toContain(`local cd="cd '$APP_DIR' &&"`);
    const printed = [...body.matchAll(/info "\$cd ([^"]*)"/g)].map((m) => m[1]);
    expect(printed).toHaveLength(6);
    expect(printed[0]).toBe("[ -d dist.old ] && rm -rf dist && mv dist.old dist");
    expect(printed[1]).toBe("[ -d migrations.old ] && rm -rf migrations && mv migrations.old migrations");
    const fill = (s: string) =>
      "cd '/home/you/apps/tours' && " +
      s
        .replace("$ACTIVATE", "/home/you/nodevenv/apps/tours/24/bin/activate")
        .replace("$ROLLBACK_BACKUP", "/home/you/backups/tours-<date>-<time>")
        .replace("$ROLLBACK_RESTORE", "package.json package-lock.json app.cjs cpanel.sh VERSION")
        .replace("$MARKER_NAME", ".cpanel-update");
    expect(cpanelSh).toMatch(/^readonly MARKER_NAME=\.cpanel-update$/m);
    // The one line left out is printed only for an install that lacked some files before.
    for (const cmd of printed.filter((c) => !c.includes("$ROLLBACK_REMOVE"))) expect(lines, cmd).toContain(fill(cmd));
    expect(printed.filter((c) => c.includes("$ROLLBACK_REMOVE"))).toEqual(["rm -f $ROLLBACK_REMOVE"]);
  });

  it("the archive it names is the one the packager writes, by the command package.json has", () => {
    expect(packageCpanelTs).toContain("`demo-platform-${version}-cpanel.tgz`");
    expect(packageCpanelTs).toContain('join(root, "dist", "cpanel")');
    expect(guide).toContain("`dist/cpanel/demo-platform-<version>-cpanel.tgz`");
    expect((JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts["package:cpanel"]).toBe("node scripts/package-cpanel.ts");
    expect(lines).toContain("npm run package:cpanel");
    expect(lines).toContain("tar -xzf ~/demo-platform-<version>-cpanel.tgz -C ~/tours-release");
  });

  it("reaches the setup wizard, reads the code from the settings file and never shows one", () => {
    expect(guide).toContain("https://tours.example.com/setup");
    expect(guide).toMatch(/> \[!WARNING\]\n> Whoever enters the setup code first becomes the owner/);
    expect(guide).toMatch(/> \[!WARNING\]\n> The API token works like a password/);
    expect(guide).toMatch(/The script never prints the setup code/);
    // The code is read in the File Manager or an editor, never printed into a terminal.
    for (const l of lines) expect(l, l).not.toMatch(/\b(grep|cat|less|more|head|tail|sed|awk)\b.*(SETUP_CODE|config\.env)/);
    expect(lines).toContain("nano ~/apps/tours-config.env");
    expect(guide).toMatch(/Do not print the file or the line/);
    expect(guide).not.toMatch(/SETUP_CODE=[^\s`'<]/);
  });

  it("warns where data can be lost or a secret exposed, in one line each", () => {
    const part = (from: string, to: string) => guide.slice(guide.search(new RegExp(`^## \\d+\\. ${from}$`, "m")), guide.search(new RegExp(`^## \\d+\\. ${to}$`, "m")));
    expect(part("Upload and unpack the archive", "Install the platform")).toMatch(/> \[!WARNING\]\n> Do not upload or unpack the archive inside `public_html`/);
    expect(part("Backups", "Restore from a backup")).toMatch(/> \[!WARNING\]\n> A backup that stays on the hosting is lost with the hosting account/);
    expect(part("Restore from a backup", "Roll back an update")).toMatch(/> \[!WARNING\]\n> A restore puts the data back as it was when the backup was made/);
    expect(part("Roll back an update", "Troubleshooting")).toMatch(/> \[!WARNING\]\n> If the new version already changed the database/);
    for (const m of guide.matchAll(/^> \[!(?:WARNING|NOTE)\]\n((?:> .*\n)+)/gm)) expect(m[1].trim().split("\n"), m[1]).toHaveLength(1);
    for (const section of guide.split(/^## /m)) expect((section.match(/^> \[!WARNING\]$/gm) ?? []).length, section.split("\n")[0]).toBeLessThanOrEqual(2);
  });

  it("no paragraph is wrapped: a line of prose is never followed directly by another", () => {
    const rows = split(guide).prose.split("\n");
    const plain = (r: string) => r !== "" && !/^(#|\||> |- |\d+\. )/.test(r);
    rows.forEach((row, i) => {
      if (plain(row)) expect(plain(rows[i + 1] ?? ""), `wrapped paragraph at: ${row.slice(0, 60)}`).toBe(false);
    });
  });

  /** The section on the second address: from its heading to the next level-two heading. */
  const second = (): string => {
    const from = guide.search(/^## \d+\. A second address for the app$/m);
    expect(from).toBeGreaterThan(-1);
    const rest = guide.slice(from + 3);
    return guide.slice(from, from + 3 + rest.search(/^## /m));
  };

  it("has a numbered section on a second address, after the troubleshooting and before the closing section", () => {
    const have = sections(guide);
    expect(have.indexOf("A second address for the app")).toBe(have.indexOf("Troubleshooting") + 1);
    // Only the section on the first admin, added after it, stands between it and the closing section.
    expect(have.indexOf("A second address for the app")).toBe(have.indexOf("What has been run where") - 2);
    expect(guide).toMatch(/^- \[\d+\. A second address for the app\]\(#\d+-a-second-address-for-the-app\)$/m);
    // The numbers of the sections before it did not move: links to them still hold.
    expect(guide).toMatch(/^## 13\. Troubleshooting$/m);
    expect(guide).toMatch(/^## 14\. A second address for the app$/m);
  });

  it("has a numbered section on making the first admin, with the command, what it prints and a warning against the hosting's sqlite3 tool", () => {
    const have = sections(guide);
    // Added last, so no number before it moved.
    expect(have.indexOf("Make yourself the admin")).toBe(have.indexOf("What has been run where") - 1);
    expect(guide).toMatch(/^## 15\. Make yourself the admin$/m);
    const from = guide.search(/^## 15\. Make yourself the admin$/m);
    const part = guide.slice(from, guide.indexOf("## What has been run where"));
    // The command as the owner approved it, from the installed copy, and the words it prints.
    expect(lines).toContain("cd ~/apps/tours && ./cpanel.sh admin --email you@example.com --username yourname");
    expect(part).toContain(
      '```text\nThe admin account "yourname" was created.\nYour tours, their links and your tokens stay exactly as they are.\n\nOpen this link within 15 minutes to sign in:\nhttps://app.example.com/signin/link#…\n```',
    );
    // Each of those lines is the command's own.
    for (const said of ["was created.", "Your tours, their links and your tokens stay exactly as they are.", "Open this link within 15 minutes to sign in:", "This site already has an admin. Nothing was changed.", "The database is from an older version. Update the site first."]) {
      expect(part, said).toContain(said);
      expect(adminTs, said).toContain(said);
    }
    // A link while mail is off, and the dry run.
    expect(lines).toContain("cd ~/apps/tours && ./cpanel.sh admin --email you@example.com");
    expect(part).toContain("`./cpanel.sh admin --dry-run first-admin --email you@example.com --username yourname`");
    // The update section points to it.
    expect(guide).toMatch(/^\*\*After the update that brings accounts,\*\*[^\n]*\[step 15\]\(#15-make-yourself-the-admin\)\.$/m);
    expect(part).toMatch(/^> \[!WARNING\]\n> The link signs in whoever opens it first/m);
    expect(part).toMatch(/^> \[!WARNING\]\n> Never open the database with the hosting's `sqlite3` tool/m);
    // The sign-in page is not in this version: the guide says so, and does not claim a sign-in works yet.
    expect(part).toContain(
      "\nThe page this link opens arrives in a later version of the platform. Until then the command makes the admin, but the link leads to a page that is not found and expires unused. After that update, get a new link with the recovery setting, as described below.\n",
    );
    expect(part).not.toMatch(/ends with the link and no other line|in one step/);
    expect(part).toContain("The admin was made, but no link was made. To get one, add the line RECOVERY_LINKS=on to the site's settings file, run the command again with --email alone, then remove the line.");
    // A link for an existing account is a recovery tool: on for one run, off again; signing in normally needs no shell.
    expect(part).toMatch(/^\*\*A new sign-in link is a recovery tool\.\*\*[^\n]*`RECOVERY_LINKS=on`[^\n]*remove the line again[^\n]*$/m);
    expect(lines).toContain("RECOVERY_LINKS=on");
    expect(part).toContain("Recovery links are off. To get one, add the line RECOVERY_LINKS=on to the site's settings file, run this again, then remove the line.");
    expect(part).toContain("Remove the line RECOVERY_LINKS=on from the settings file now.");
    expect(part).toMatch(/by a link sent by mail[^\n]*needs no shell/);
    // Which account becomes the admin, and which settings the command sees.
    expect(part).toMatch(/the oldest of them/);
    expect(part).toMatch(/^The command reads the settings the settings file holds from that file only[^\n]*are not seen by it\.$/m);
    // The script's usage line is the planned one.
    expect(cpanelSh).toContain("  admin       Run the site's admin command, for example: admin first-admin --email you@example.com --username yourname");
  });

  it("the Docker runbook makes the first admin with the same command, run in the container", () => {
    const runbook = allDocs["docs/runbook-docker.md"];
    const code = codeLines(runbook);
    expect(code).toContain("docker compose exec app node dist/node/admin.js first-admin --email you@example.com --username yourname");
    expect(code).toContain("docker compose exec app node dist/node/admin.js signin-link --email you@example.com");
    expect(runbook).toMatch(/> \[!WARNING\]\n> Never open the database with the server's `sqlite3` tool/);
    expect(runbook).toMatch(/> \[!WARNING\]\n> The link signs in whoever opens it first/);
    expect(runbook).toContain(
      "\nThe page this link opens arrives in a later version of the platform. Until then the command makes the admin, but the link leads to a page that is not found and expires unused. After that update, get a new link with the recovery setting, as in step 3.\n",
    );
    expect(runbook).toContain("The admin was made, but no link was made. To get one, add the line RECOVERY_LINKS=on to the site's settings file, run the command again with --email alone, then remove the line.");
    expect(runbook).toMatch(/`RECOVERY_LINKS=on`[^\n]*`\.env`[^\n]*remove the line again/);
    expect(runbook).toMatch(/by a link sent by mail[^\n]*needs no shell/);
  });

  it("the second address is set up in the order that keeps the platform reachable, and attaching it stays marked Unconfirmed", () => {
    const part = second();
    // The steps are the section's first numbered list.
    const steps = [...split(part).prose.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
    // Step 0 comes before all of them: a version that knows the two lines, installed and checked.
    expect(steps.slice(0, 7).map((x) => x.n)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(steps[0].text).toMatch(/^First update to a version that has this section, without the `--app-domain` option/);
    expect(steps[0].text).toMatch(/An older version ignores the two lines/);
    expect(steps[0].text).toMatch(/Only then go on\.$/);
    // Step 0's update is what makes the backup, and the guide says so there, before any restart.
    expect(steps[0].text).toMatch(/That update makes a backup before it changes anything, as in \[step 10\]\(#10-backups\)/);
    expect(part).not.toMatch(/Make a backup first/);
    // The same-version update with the option replaces dist.old: the earlier version is then only in the backup.
    expect(part).toMatch(/it replaces `dist\.old` with the version it found running, so when that is the version already installed, the copy of the version from before step 0 is then only in the backup that step 0 made\./);
    const first = steps.slice(1, 7);
    expect(first[0].text).toMatch(/^Create the subdomain `app\.example\.com`/);
    expect(first[1].text).toMatch(/^Attach it to the same Node\.js app\./);
    expect(first[2].text).toMatch(/^Wait for its certificate/);
    expect(first[3].text).toMatch(/^Add the two lines to the settings file/);
    expect(first[4].text).toMatch(/^Restart the app/);
    expect(first[5].text).toMatch(/^Check both addresses, right after the restart/);
    // Nobody has done the attach step on real hosting: it says so, and so does the closing list.
    expect(first[1].text).toContain("**Unconfirmed:**");
    expect(first[1].text).toMatch(/has not been tried on real hosting/);
    for (const i of [0, 2, 3, 4, 5]) expect(first[i].text, first[i].text).not.toContain("Unconfirmed");
    const open = guide.slice(guide.indexOf("**Not yet confirmed on real hosting,**"));
    expect(open).toMatch(/^\d+\. That one Node\.js app can answer for a second subdomain, and that the host name reaches the app unchanged/m);
    // The script takes no part in it.
    expect(part).toMatch(/The script creates no domain/);
    const creates = cpanelSh.split("\n").filter((l) => l.includes("cloudlinux-selector create"));
    expect(creates.length).toBeGreaterThan(2);
    for (const l of creates) expect(l, l).not.toMatch(/APP_DOMAIN|app-domain/);
    // The lines, the restart and the check are the script's own.
    const code = codeLines(part);
    expect(code).toContain("nano ~/apps/tours-config.env");
    expect(code).toContain("TOURS_HOST=tours.example.com");
    expect(code).toContain("APP_HOST=app.example.com");
    // The two lines are always a person's: the script prints them and never writes them.
    expect(cpanelSh).not.toMatch(/printf[^\n#]*(TOURS_HOST|APP_HOST)=/);
    expect(code).toContain("touch ~/apps/tours/tmp/restart.txt");
    expect(cpanelSh).toContain('run touch "$APP_DIR/tmp/restart.txt"');
    expect(code).toContain("cd ~/apps/tours && ./cpanel.sh status --app-domain app.example.com");
    // What each address answers when it worked, as the app reports it.
    expect(code).toContain('{"ok":true,"address":"tours"}');
    expect(code).toContain('{"ok":true,"address":"app"}');
    expect(cpanelSh).toContain(String.raw`[[ "$reply" == *"\"address\":\"$role\""* ]]`);
    expect(part).toContain("`health of the tours address: ok`");
    expect(part).toContain("`health of the app address: ok`");
    expect(cpanelSh).toContain('info "health of the $2 address: ok"');
    // How the script comes to remember it: an update that checks both addresses before it changes anything.
    expect(code).toContain("./cpanel.sh update --app-domain app.example.com");
    expect(part).toMatch(/Before it asks or changes anything, that update asks both addresses for their roles, once each\. If either does not report its own, it stops, prints the two lines and changes nothing\./);
    expect(part).toMatch(/It then shows no commands to go back, because the new version is not at fault\./);
    // An install starts with one address: the option is not offered for it, here or in the script.
    expect(part).toMatch(/\*\*A new install\.\*\* The install does not take the option, and says so/);
    for (const l of codeLines(guide)) expect(l, l).not.toMatch(/cpanel\.sh install[^\n]*--app-domain/);
    expect(cpanelSh).toContain(String.raw`[ "$COMMAND" != install ] || usage_error "--app-domain does not go with install: install with one address first, then add the second with update, as the guide's section \"A second address for the app\" describes"`);
    expect(guide).toMatch(/^\| `--app-domain <name>` \|[^\n]*It goes with `update` and `status`, not with `install`/m);
    // One warning, in one line, about what a wrong name does.
    expect(part).toMatch(/> \[!WARNING\]\n> A wrong name in either of the two lines/);
  });

  it("an install with one address is moved in that same order, and the way back is given", () => {
    const part = second();
    const at = (re: RegExp) => part.search(re);
    const steps = at(/^1\. Create the subdomain/m);
    const move = at(/^\*\*An install that has one address today\.\*\*/m);
    const back = at(/^\*\*The way back\.\*\*/m);
    expect(steps).toBeGreaterThan(-1);
    expect(move).toBeGreaterThan(steps);
    expect(back).toBeGreaterThan(move);
    const note = part.slice(move, back);
    // A backup first; the name and its certificate before the two lines; the tours address stays the one it was.
    expect(note).toMatch(/backup/);
    // The version first, as in step 0.
    expect(note.search(/Start with step 0: the installed version must know the two lines before they are added\./)).toBeGreaterThan(-1);
    expect(note.search(/Start with step 0/)).toBeLessThan(note.search(/steps 1 to 3/));
    expect(note).toMatch(/step 6 comes right after it/);
    expect(note.search(/steps 1 to 3/)).toBeLessThan(note.search(/steps 4 to 6/));
    expect(note).toMatch(/`--domain`[^\n]*stays[^\n]*`tours\.example\.com`/);
    expect(note).toMatch(/Mythicshot keeps the address it has/);
    // Back to one address: the two lines out, a restart, and the script's own record of the name.
    const way = part.slice(back);
    expect(way).toMatch(/Remove the two lines/);
    expect(codeLines(way)).toContain("touch ~/apps/tours/tmp/restart.txt");
    expect(codeLines(way)).toContain("nano ~/apps/tours/.cpanel-install");
    expect(way).toContain("`APP_DOMAIN=`");
    expect(cpanelSh).toMatch(/^readonly STATE_NAME=\.cpanel-install$/m);
    expect(cpanelSh).toContain(`printf 'APP_DOMAIN=%s\\n' "$RECORDED_APP_DOMAIN"`);
    expect(codeLines(way)).toContain("cd ~/apps/tours && ./cpanel.sh status");
  });

  it("the script's words about the second address are the agreed ones, and it never reads or writes the host lines of an existing settings file", () => {
    for (const text of [
      "  --app-domain <name> A second address, for the app, such as app.example.com. With it, --domain is the address of the tours. Remembered after the first time.",
      "--app-domain must be a host name in lowercase, such as app.example.com, without https:// and without a path",
      "--app-domain must be a different name than --domain",
      "the settings file $SETTINGS is kept as it is. For two addresses it must hold these two lines; add them by hand if they are not there, then restart the app:",
      'info "TOURS_HOST=$DOMAIN"',
      'info "APP_HOST=$APP_DOMAIN"',
      "https://$host/healthz answered, but the platform does not see it as its $role address. The settings file $SETTINGS must hold TOURS_HOST=$DOMAIN and APP_HOST=$APP_DOMAIN, and the app must be restarted after a change.",
      'say "Installed version $version, and it answers at https://$DOMAIN"',
      "--app-domain goes only with update and status",
      "                      With update and status. An install starts with one address.",
      "https://$host answers its health check but refuses every other request: the settings file names other addresses in TOURS_HOST and APP_HOST than the one this install uses.",
      'say "Version $new is in place and answers, but the addresses do not report their roles"',
      "the two addresses do not both report their own role yet, so the update did not start and the app address was not recorded. Nothing was changed",
      "the app address recorded in $STATE_FILE is the same as the tours address; remove the APP_DOMAIN line. Nothing was changed",
      'say "Updated to version $new, and it answers at $(answers_at)"',
      `printf 'https://%s and https://%s' "$DOMAIN" "$APP_DOMAIN"`,
    ]) {
      expect(cpanelSh, text).toContain(text);
    }
    // Of the settings file the script still reads the DATA_DIR line and no other.
    const reads = cpanelSh.split("\n").filter((l) => /^\s*[^#\s]/.test(l) && /\b(sed|grep|awk|cat|head|tail|source)\s[^\n]*"\$SETTINGS"/.test(l));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("DATA_DIR=");
    // And it writes the file in one place only: the new file of a first install.
    const writes = cpanelSh.split("\n").filter((l) => /^\s*[^#\s]/.test(l) && /(>>?\s*"\$SETTINGS"|mv[^\n]*"\$SETTINGS"$|tee[^\n]*\$SETTINGS)/.test(l));
    expect(writes).toEqual(['      mv -- "$tmp" "$SETTINGS"']);
    // A passed health check is followed by a request without a token whose body is thrown away.
    expect(cpanelSh).toContain(String.raw`code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "https://$1/api/v1/me" 2>/dev/null)" || return 1`);
    expect(cpanelSh).toContain('[ "$code" = 421 ]');
    expect(cpanelSh).not.toMatch(/Authorization|Bearer/i);
    // The route it asks is one the platform answers on both addresses, and refuses on any other name.
    expect(hostGateTs).toContain('"GET /api/v1/me": "both"');
    expect(guide).toMatch(/\| The script says an address answers its health check but refuses every other request \|/);
    // An app address is written to the state file from the record, which changes only after a passed check.
    expect(cpanelSh).toContain(`[ -z "$RECORDED_APP_DOMAIN" ] || printf 'APP_DOMAIN=%s\\n' "$RECORDED_APP_DOMAIN"`);
    expect(cpanelSh.match(/RECORDED_APP_DOMAIN="\$APP_DOMAIN"/g)).toHaveLength(1);
    // The troubleshooting table names what the script says when a role is wrong.
    expect(guide).toMatch(/\| The script says the platform does not see an address as its tours or its app address \|/);
    // The guide's option table has the option.
    expect(guide).toMatch(/^\| `--app-domain <name>` \|/m);
  });

  it("the chooser and the Namecheap VPS guide point to it", () => {
    expect(hosting[INDEX]).toContain("](cpanel.md)");
    expect(hosting["docs/hosting/namecheap.md"]).toContain("](cpanel.md)");
  });
});

describe("deploy/fly/fly.toml", () => {
  const toml = parseToml(flyToml);
  const facts = appFacts();

  it("parses, and has only the sections the guide explains", () => {
    expect(Object.keys(toml).sort()).toEqual(["app", "env", "http_service", "kill_signal", "kill_timeout", "mounts", "primary_region", "vm"]);
    expect(toml.app).toBe("tours-example");
    expect(toml.primary_region).toMatch(/^[a-z]{3}$/);
  });

  it("the parser refuses what it does not understand", () => {
    expect(() => parseToml('a = [1, 2]')).toThrow(/unsupported value/);
    expect(() => parseToml('a = 1\na = 2')).toThrow(/set twice/);
    expect(() => parseToml("[t]\n[t]")).toThrow(/defined twice/);
    expect(() => parseToml("nonsense")).toThrow(/cannot parse/);
    expect(parseToml('[a]\n  b = "c" # d\n[[a.e]]\n  f = 1\n[[a.e]]\n  f = true')).toEqual({ a: { b: "c", e: [{ f: 1 }, { f: true }] } });
  });

  it("forwards to the port the image listens on", () => {
    const http = table(toml, "http_service");
    expect(http.internal_port).toBe(facts.port);
    expect(table(toml, "env").PORT).toBe(String(facts.port));
    expect(http.force_https).toBe(true);
  });

  it("mounts one volume where the image keeps its data", () => {
    const mounts = table(toml, "mounts");
    expect(mounts.destination).toBe(facts.dataDir);
    expect(table(toml, "env").DATA_DIR).toBe(facts.dataDir);
    expect(mounts.source).toBeTypeOf("string");
    // The guide creates the volume by this name.
    const lines = codeLines(hosting[FLY]);
    expect(lines).toContain(`fly volumes create ${String(mounts.source)} --region <your region> --size 1`);
    // The reader may change the region, so no command carries the template's own.
    for (const l of lines) expect(l, l).not.toMatch(new RegExp(`--region ${String(toml.primary_region)}\\b`));
    expect(hosting[FLY]).toMatch(/must match the `primary_region` line/);
  });

  it("checks the app's own health path", () => {
    const checks = tables(table(toml, "http_service"), "checks");
    expect(checks).toHaveLength(1);
    expect(checks[0].path).toBe(facts.healthPath);
    expect(String(checks[0].method).toUpperCase()).toBe("GET");
  });

  it("keeps one Machine running: never stopped when idle, one size, signalled with SIGTERM", () => {
    const http = table(toml, "http_service");
    expect(http.auto_stop_machines).toBe("off");
    expect(http.auto_start_machines).toBe(true);
    expect(tables(toml, "vm")).toHaveLength(1);
    expect(toml.kill_signal).toBe("SIGTERM");
    // The guide deploys without a spare Machine and explains the choice.
    expect(codeLines(hosting[FLY])).toContain("fly deploy --ha=false");
    expect(sections(hosting[FLY])).toContain("Why the Machine never sleeps");
    expect(hosting[FLY]).toMatch(/> \[!WARNING\]\n> Never run more than one Machine/);
  });

  it("holds no secret: the setup code is a Fly secret, never a line in the file", () => {
    const env = table(toml, "env");
    expect(Object.keys(env).sort()).toEqual(["DATA_DIR", "PORT"]);
    for (const line of flyToml.split("\n")) {
      const code = line.replace(/#.*$/, "");
      expect(code, line).not.toMatch(/SETUP_CODE|SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE/i);
      expect(code, line).not.toMatch(/[0-9a-f]{16,}/i);
      expect(code, line).not.toMatch(/[A-Za-z0-9+/_-]{24,}/);
    }
    // The code is typed into `fly secrets import`, never passed on a command line.
    expect(codeLines(hosting[FLY])).toContain("fly secrets import");
    expect(codeLines(hosting[FLY])).toContain("SETUP_CODE=<your setup code>");
    for (const l of codeLines(hosting[FLY])) expect(l, l).not.toMatch(/fly secrets set .*SETUP_CODE/);
    expect(codeLines(hosting[FLY])).toContain("openssl rand -hex 16");
  });

  it("the guide names the template's place and copies it next to the Dockerfile", () => {
    expect(hosting[FLY]).toContain("](../../deploy/fly/fly.toml)");
    expect(codeLines(hosting[FLY])).toContain("cp deploy/fly/fly.toml fly.toml");
    expect(codeLines(hosting[FLY])).toContain(`app = "${String(toml.app)}"`);
    expect(codeLines(hosting[FLY])).toContain(`primary_region = "${String(toml.primary_region)}"`);
  });
});
