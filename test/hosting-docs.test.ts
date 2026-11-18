/// <reference types="vite/client" />
// Checks on the provider guides in docs/hosting and on the Fly.io template that can be
// made without an account: every guide exists, follows the shared outline and says at
// its top that it is unverified; no guide names the owner's domain or an address outside
// the documentation ranges; links between docs resolve; the server guides install the
// way the Docker runbook does; and deploy/fly/fly.toml parses, holds no secret, and
// agrees with the Dockerfile and the compose file on the port, the data path and the
// health path.
//
// Files are read through Vite's ?raw imports, which work under both Vitest configs.
import { describe, expect, it } from "vitest";
import dockerfile from "../Dockerfile?raw";
import composeYml from "../deploy/docker-compose.yml?raw";
import flyToml from "../deploy/fly/fly.toml?raw";
import installSh from "../deploy/install.sh?raw";
import appTs from "../src/app.ts?raw";

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
const SERVER_GUIDES = ["docs/hosting/digitalocean.md", "docs/hosting/aws-lightsail.md", "docs/hosting/azure.md", "docs/hosting/linode.md"];
const GUIDES = [...SERVER_GUIDES, FLY];

/** Headings every guide has, without their step numbers. */
const SHARED_HEADINGS = ["What you need and what it costs", "Open the setup wizard", "Backups", "Updates", "Delete everything to stop paying", "Pages this guide relies on"];
/** Headings the four server guides add, in this order between the shared ones. */
const SERVER_HEADINGS = ["Create the server", "Open ports 80 and 443", "Point the domain at the server", "Connect by SSH", "Install the platform"];
const SERVER_OUTLINE = ["What you need and what it costs", ...SERVER_HEADINGS, "Open the setup wizard", "Backups", "Updates", "Delete everything to stop paying", "Pages this guide relies on"];

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
    expect(Object.keys(hosting).sort()).toEqual([INDEX, ...GUIDES].sort());
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

  it("the four server guides follow one outline, in one order", () => {
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

  it("no guide names the owner's domain, a real token or a real setup code", () => {
    for (const [p, text] of [...Object.entries(hosting), ["deploy/fly/fly.toml", flyToml]]) {
      expect(text.toLowerCase(), p).not.toContain("mythicsourcecode");
      expect(text, p).not.toMatch(/dp_[0-9a-f]{40}/);
      expect(text, p).not.toMatch(/SETUP_CODE=[0-9a-f]{16,}/);
    }
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
      if (p !== INDEX) expect(urls.length, p).toBeGreaterThanOrEqual(10);
    }
    // Each guide links its own provider's pages, not another's.
    const hosts: Record<string, RegExp> = {
      "docs/hosting/digitalocean.md": /(^|\.)digitalocean\.com$/,
      "docs/hosting/aws-lightsail.md": /(^|\.)(aws\.)?amazon\.com$/,
      "docs/hosting/azure.md": /(^|\.)(microsoft|azure)\.com$/,
      "docs/hosting/linode.md": /(^|\.)(akamai|linode)\.com$/,
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
    expect(codeLines(hosting[FLY])).toContain(`fly volumes create ${String(mounts.source)} --region ${String(toml.primary_region)} --size 1`);
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
    expect(codeLines(hosting[FLY])).toContain("fly secrets set SETUP_CODE=<your setup code>");
    expect(codeLines(hosting[FLY])).toContain("openssl rand -hex 16");
  });

  it("the guide names the template's place and copies it next to the Dockerfile", () => {
    expect(hosting[FLY]).toContain("](../../deploy/fly/fly.toml)");
    expect(codeLines(hosting[FLY])).toContain("cp deploy/fly/fly.toml fly.toml");
    expect(codeLines(hosting[FLY])).toContain(`app = "${String(toml.app)}"`);
    expect(codeLines(hosting[FLY])).toContain(`primary_region = "${String(toml.primary_region)}"`);
  });
});
