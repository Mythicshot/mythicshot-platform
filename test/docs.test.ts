/// <reference types="vite/client" />
// Checks on README.md and the two runbooks that can be made without a server: links and
// anchors resolve, every install.sh command and option the docs name exists and every
// one the script has is documented, every environment variable the docs name is read by
// the code, no hostname other than the placeholders and the vendor pages appears, and
// the setup-recovery SQL both runbooks give does what they say on both targets. The same
// two-way check holds for the modes and options of `npm run setup:cloudflare`.
//
// Files are read through Vite's ?raw imports, which work under both Vitest configs.
import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { createApp } from "../src/app.ts";
import type { Deps } from "../src/ports.ts";
import installSh from "../deploy/install.sh?raw";
import setupCloudflareTs from "../scripts/setup-cloudflare.ts?raw";

const DOCS = import.meta.glob(["../README.md", "../LICENSE", "../docs/*.md"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Guides a doc may link into by heading; their own checks are in test/hosting-docs.test.ts. */
const GUIDES = import.meta.glob("../docs/hosting/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Every file a doc may link to; only the keys are used. */
const REPO_FILES = Object.keys(
  import.meta.glob(["../*", "../deploy/**", "../docs/**", "../migrations/**", "../scripts/**", "../src/**", "../test/**"], { query: "?raw" }),
).map((k) => k.replace(/^\.\.\//, ""));

/** The code that reads environment variables, as text. */
const CODE = import.meta.glob(
  [
    "../src/**/*.ts",
    "../scripts/*.ts",
    "../deploy/docker-compose.yml",
    "../deploy/caddy/Caddyfile",
    "../deploy/caddy/Caddyfile.two",
    "../deploy/tunnel/caddy/Caddyfile.two",
    "../Dockerfile",
    "../wrangler.jsonc",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** Docs keyed by their path from the repo root. */
const docs: Record<string, string> = Object.fromEntries(Object.entries(DOCS).map(([k, v]) => [k.replace(/^\.\.\//, ""), v]));
const MARKDOWN = Object.keys(docs).filter((p) => p.endsWith(".md"));
const README = "README.md";
const DOCKER = "docs/runbook-docker.md";
const CLOUDFLARE = "docs/runbook-cloudflare.md";
/** Every markdown file a link's anchor may point into: the docs, and the hosting guides. */
const linkable: Record<string, string> = { ...Object.fromEntries(Object.entries(GUIDES).map(([k, v]) => [k.replace(/^\.\.\//, ""), v])), ...docs };

/** Hosts the docs may name besides the placeholders: the vendor pages they rely on and r2.dev, named as the address not to use. */
const ALLOWED_HOSTS = new Set([
  "developers.cloudflare.com",
  "docs.docker.com",
  "download.docker.com",
  "caddyserver.com",
  "www.debian.org",
  "r2.dev",
  "workers.dev",
]);

/** Last labels that are file extensions, not top-level domains. */
const FILE_EXTENSIONS = new Set(["sh", "md", "yml", "yaml", "json", "jsonc", "ts", "js", "mjs", "sqlite", "tar", "gz", "sql", "txt", "asc", "sources", "lock", "old", "new", "bak", "toml", "vars"]);

function isPlaceholderHost(host: string): boolean {
  return /(^|\.)example\.(com|net|org)$/.test(host) || host === "localhost";
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

/** Inline code spans in prose. */
function codeSpans(prose: string): string[] {
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

/** Every line of code in a doc: inline spans and the lines of fenced blocks. */
function codeLines(md: string): string[] {
  const { prose, blocks } = split(md);
  return [...codeSpans(prose), ...blocks.flatMap((b) => b.body.split("\n"))];
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

/** The commands and options install.sh's parse_args accepts; an option that takes a value (--name=*) is listed by its name. */
function scriptVocabulary(): { commands: Set<string>; flags: Set<string> } {
  const body = installSh.match(/^parse_args\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
  const commands = new Set<string>();
  const flags = new Set<string>();
  for (const m of body.matchAll(/^\s*([a-z| =*-]+)\)/gm)) {
    for (const word of m[1].split("|").map((w) => w.trim().replace(/=\*$/, ""))) {
      if (word.startsWith("-")) flags.add(word);
      else if (/^[a-z]+$/.test(word)) commands.add(word);
    }
  }
  return { commands, flags };
}

/** The install.sh commands and options a doc names: the words after install.sh on each code line, an option's =value dropped. */
function docVocabulary(md: string): { commands: string[]; flags: string[] } {
  const commands: string[] = [];
  const flags: string[] = [];
  for (const line of codeLines(md)) {
    for (const m of line.matchAll(/install\.sh((?: +(?:--?[a-z][a-z-]*(?:=[a-z0-9.<>-]+)?|[a-z]+)(?=\s|$))*)/g)) {
      for (const word of m[1].trim().split(/ +/).filter(Boolean)) (word.startsWith("-") ? flags : commands).push(word.replace(/=.*$/, ""));
    }
  }
  return { commands, flags };
}

/** A string list declared as `const NAME = [...]` in the setup command's source. */
function setupList(name: string): string[] {
  const body = setupCloudflareTs.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1];
  if (body === undefined) throw new Error(`no ${name} in scripts/setup-cloudflare.ts`);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The setup:cloudflare modes and options a doc names: the words after the command on each code line, skipping option values. */
function setupDocVocabulary(md: string): { commands: string[]; flags: string[] } {
  const valueFlags = setupList("VALUE_FLAGS");
  const commands: string[] = [];
  const flags: string[] = [];
  for (const line of codeLines(md)) {
    for (const m of line.matchAll(/(?:setup:cloudflare|setup-cloudflare\.ts)((?: +(?:--(?=\s|$)|--?[a-z][a-z-]*|[a-z][a-z0-9.-]*|<[a-z]+>)(?=\s|$))*)/g)) {
      const words = m[1].trim().split(/ +/).filter((w) => w !== "" && w !== "--" && !w.startsWith("<"));
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w.startsWith("-")) {
          flags.push(w);
          if (valueFlags.includes(w)) i++;
        } else commands.push(w);
      }
    }
  }
  return { commands, flags };
}

/** Environment variables the code reads. */
function variablesRead(): Set<string> {
  const out = new Set<string>();
  const add = (re: RegExp, text: string) => {
    for (const m of text.matchAll(re)) out.add(m[1]);
  };
  for (const [path, text] of Object.entries(CODE)) {
    if (path.endsWith(".ts")) add(/\benv\.([A-Z][A-Z0-9_]*)/g, text);
    if (path.endsWith("docker-compose.yml")) {
      add(/\$\{([A-Z][A-Z0-9_]*)/g, text);
      add(/^ {6}([A-Z][A-Z0-9_]*):/gm, text);
    }
    if (/Caddyfile(\.two)?$/.test(path)) add(/\{\$([A-Z][A-Z0-9_]*)\}/g, text);
    if (path.endsWith("Dockerfile")) add(/\b([A-Z][A-Z0-9_]*)=/g, text.match(/^ENV [\s\S]*?[^\\]\n/m)?.[0] ?? "");
    if (path.endsWith("wrangler.jsonc")) add(/"([A-Z][A-Z0-9_]*)"\s*:/g, text.match(/"vars"\s*:\s*\{[^}]*\}/)?.[0] ?? "");
  }
  // install.sh: variables taken from the environment with a default, and the keys of .env.
  add(/\$\{([A-Z][A-Z0-9_]*):-/g, installSh);
  add(/^ {6}([A-Z][A-Z0-9_]*)\) /gm, installSh.match(/^read_env_file\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "");
  return out;
}

/** Environment variables a doc names: inline spans that are one upper-case name, and NAME= or $NAME in code blocks. */
function variablesNamed(md: string): Set<string> {
  const out = new Set<string>();
  const { prose, blocks } = split(md);
  for (const span of codeSpans(prose)) {
    const m = span.match(/^([A-Z][A-Z0-9_]{2,})(=.*)?$/);
    if (m) out.add(m[1]);
  }
  for (const b of blocks) {
    if (b.lang === "sql") continue;
    for (const m of b.body.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]{2,})=/gm)) out.add(m[1]);
    for (const m of b.body.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})/g)) out.add(m[1]);
  }
  return out;
}

/** One `## ` section of a doc, from its heading to the next heading of that level. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`no section "${heading}"`);
  const end = md.indexOf("\n## ", start + 1);
  return md.slice(start + 1, end < 0 ? undefined : end);
}

/** The setup-recovery SQL a runbook gives: its sql block that deletes the setup row. */
function recoverySql(md: string): string {
  const block = split(md).blocks.find((b) => b.lang === "sql" && b.body.includes("DELETE FROM setup"));
  if (!block) throw new Error("no recovery SQL block");
  return block.body;
}

describe("the docs", () => {
  it("exist: the README, both runbooks and the licence", () => {
    for (const p of [README, DOCKER, CLOUDFLARE, "LICENSE"]) expect(docs[p], p).toBeTypeOf("string");
    expect(docs.LICENSE).toMatch(/All rights reserved\./);
    expect(docs[README]).toMatch(/All rights reserved/);
    for (const p of MARKDOWN) expect(docs[p].toLowerCase(), p).not.toContain("open source");
  });

  it("the README links both runbooks and has both columns of the split", () => {
    const r = docs[README];
    for (const s of ["docs/runbook-docker.md", "docs/runbook-cloudflare.md", "What the installer does for you", "What is yours to do", "LICENSE"]) expect(r).toContain(s);
  });

  it("each runbook says at its top that it is not yet verified end to end", () => {
    for (const p of [DOCKER, CLOUDFLARE]) {
      const top = docs[p].split("\n").slice(0, 12).join("\n");
      expect(top, p).toMatch(/not yet been (run|verified) end to end/i);
    }
  });

  it("each runbook keeps its Draft warning, as a callout, right under the title", () => {
    const notices: Record<string, RegExp> = {
      [DOCKER]: /^> \[!WARNING\]\n> Draft: this runbook has not yet been run end to end on a real server\./m,
      [CLOUDFLARE]: /^> \[!WARNING\]\n> Draft: this runbook has not yet been run end to end on a real Cloudflare account\./m,
    };
    for (const [p, re] of Object.entries(notices)) {
      const lines = docs[p].split("\n");
      expect(lines[0], p).toMatch(/^# Runbook: /);
      expect(lines.slice(1, 6).join("\n"), p).toMatch(re);
      expect(docs[p], p).toMatch(/\*\*Unconfirmed\*\*/);
    }
  });

  it("the Cloudflare runbook warns, in a callout, that attaching an address takes it over", () => {
    expect(docs[CLOUDFLARE]).toMatch(/^> \[!WARNING\]\n> Attaching an address takes it over/m);
    expect(docs[CLOUDFLARE]).not.toMatch(/delete that record first/);
  });

  it("every relative link and anchor resolves", () => {
    const problems: string[] = [];
    for (const p of MARKDOWN) {
      for (const m of split(docs[p]).prose.matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = m[1];
        if (/^[a-z]+:/.test(link)) continue;
        const [path, anchor] = link.split("#", 2);
        const target = path === "" ? p : resolveLink(p, path);
        if (target === null) {
          problems.push(`${p}: ${link} leaves the repo`);
          continue;
        }
        const exists = REPO_FILES.includes(target) || REPO_FILES.some((f) => f.startsWith(target.replace(/\/$/, "") + "/"));
        if (!exists) problems.push(`${p}: ${link} does not exist`);
        else if (anchor !== undefined) {
          if (!(target in linkable)) problems.push(`${p}: ${link} has an anchor into a file that is not a doc`);
          else if (!anchors(linkable[target]).has(anchor)) problems.push(`${p}: ${link} names a missing heading`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every external link is https to a placeholder or a vendor page", () => {
    const problems: string[] = [];
    for (const p of MARKDOWN) {
      for (const m of docs[p].matchAll(/\]\(([a-z]+:[^)\s]+)\)/g)) {
        const url = new URL(m[1]);
        if (url.protocol !== "https:") problems.push(`${p}: ${m[1]} is not https`);
        else if (!ALLOWED_HOSTS.has(url.hostname) && !isPlaceholderHost(url.hostname)) problems.push(`${p}: ${m[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("no doc names a hostname other than the placeholders and the vendor pages", () => {
    const problems: string[] = [];
    for (const [p, text] of Object.entries(docs)) {
      for (const m of text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63})\b/g)) {
        const host = m[0];
        const at = m.index ?? 0;
        if (text[at - 1] === ".") continue; // the tail of a name such as .env.old
        if (text[at + host.length] === "(") continue; // a method call in a code example, such as db.close()
        if (FILE_EXTENSIONS.has(m[1].toLowerCase())) continue;
        if (isPlaceholderHost(host) || ALLOWED_HOSTS.has(host)) continue;
        problems.push(`${p}: ${host}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("IP addresses in the docs are documentation, private or loopback addresses", () => {
    const ok = /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|10\.|192\.168\.|127\.0\.0\.1$)/;
    for (const [p, text] of Object.entries(docs)) {
      for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) expect(m[0], p).toMatch(ok);
      for (const m of text.matchAll(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi)) {
        if (/^[0-9]+:[0-9]+:[0-9]+$/.test(m[0])) continue; // a time
        expect(m[0].toLowerCase(), p).toMatch(/^2001:db8:/);
      }
    }
  });

  it("the docs never name the owner's hostname or any real token or setup code", () => {
    for (const [p, text] of Object.entries(docs)) {
      expect(text, p).not.toContain("mythicsourcecode");
      expect(text, p).not.toMatch(/dp_[0-9a-f]{40}/);
      expect(text, p).not.toMatch(/SETUP_CODE=[0-9a-f]{16,}/);
    }
  });

  it("every install.sh command and option the docs name exists in the script", () => {
    const { commands, flags } = scriptVocabulary();
    expect(commands.size).toBeGreaterThan(0);
    for (const p of MARKDOWN) {
      const named = docVocabulary(docs[p]);
      for (const c of named.commands) expect(commands, `${p}: install.sh ${c}`).toContain(c);
      for (const f of named.flags) expect(flags, `${p}: install.sh ${f}`).toContain(f);
    }
  });

  it("every install.sh command and option is documented in the Docker runbook", () => {
    const { commands, flags } = scriptVocabulary();
    const named = docVocabulary(docs[DOCKER]);
    const spans = new Set(codeSpans(split(docs[DOCKER]).prose));
    for (const c of commands) expect(named.commands, `install.sh ${c}`).toContain(c);
    for (const f of flags) expect(named.flags.includes(f) || spans.has(f) || spans.has(`${f}=<name>`), `install.sh ${f}`).toBe(true);
  });

  it("the option that takes a value is in the script's vocabulary and in the runbook's option table", () => {
    expect(scriptVocabulary().flags).toContain("--app-domain");
    expect(docVocabulary("`sudo bash install.sh install --app-domain=app.example.com --yes`")).toEqual({ commands: ["install"], flags: ["--app-domain", "--yes"] });
    expect(docs[DOCKER]).toMatch(/^\| `--app-domain=<name>` \| Only with `install`: /m);
  });

  it("every environment variable the docs name is read by the code", () => {
    const read = variablesRead();
    expect(read).toContain("SETUP_CODE");
    for (const p of MARKDOWN) for (const v of variablesNamed(docs[p])) expect(read, `${p}: ${v}`).toContain(v);
  });

  it("every setting the app reads is named in the docs", () => {
    const named = new Set(MARKDOWN.flatMap((p) => [...variablesNamed(docs[p])]));
    for (const [path, text] of Object.entries(CODE)) {
      if (!path.endsWith(".ts")) continue;
      for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})/g)) expect(named, `${path}: ${m[1]}`).toContain(m[1]);
    }
  });

  it("every setup:cloudflare mode and option the docs name exists in the command", () => {
    const commands = setupList("COMMANDS");
    const flags = setupList("FLAGS");
    expect(commands).toEqual(["setup", "status", "update"]);
    let named = 0;
    for (const p of MARKDOWN) {
      const v = setupDocVocabulary(docs[p]);
      named += v.commands.length + v.flags.length;
      for (const c of v.commands) expect(commands, `${p}: setup:cloudflare ${c}`).toContain(c);
      for (const f of v.flags) expect(flags, `${p}: setup:cloudflare ${f}`).toContain(f);
    }
    expect(named).toBeGreaterThan(0);
  });

  it("every setup:cloudflare mode and option is documented in the Cloudflare runbook", () => {
    const v = setupDocVocabulary(docs[CLOUDFLARE]);
    const spans = new Set(codeSpans(split(docs[CLOUDFLARE]).prose));
    for (const c of setupList("COMMANDS").filter((c) => c !== "setup")) expect(v.commands, `setup:cloudflare ${c}`).toContain(c);
    expect(docs[CLOUDFLARE]).toContain("npm run setup:cloudflare");
    for (const f of setupList("FLAGS")) expect(v.flags.includes(f) || spans.has(f), `setup:cloudflare ${f}`).toBe(true);
  });

  it("the README gives both routes side by side with their first command", () => {
    const r = docs[README];
    expect(r).toContain("npm run setup:cloudflare");
    expect(r).toContain("sudo bash install.sh");
  });

  it("both runbooks say what you need before you start", () => {
    for (const p of [DOCKER, CLOUDFLARE]) expect(anchors(docs[p]), p).toContain("what-you-need-before-you-start");
  });

  it("both runbooks reach the setup wizard and say to generate the setup code", () => {
    for (const p of [DOCKER, CLOUDFLARE]) {
      expect(docs[p], p).toContain("/setup");
      expect(docs[p], p).toContain("openssl rand -hex 16");
    }
  });

  it("both runbooks give the same setup-recovery SQL", () => {
    expect(recoverySql(docs[DOCKER])).toBe(recoverySql(docs[CLOUDFLARE]));
  });
});

describe("the setup-recovery SQL in the runbooks", () => {
  const CODE_OK = "0123456789abcdef0123456789abcdef";
  const ORIGIN = "https://tours.example.com";

  async function run(deps: Deps): Promise<void> {
    const statements = recoverySql(docs[DOCKER]).split(";").map((s) => s.trim()).filter(Boolean);
    for (const sql of statements) {
      if (/^SELECT/i.test(sql)) await deps.db.all(sql);
      else await deps.db.run(sql);
    }
  }

  async function count(deps: Deps, table: string): Promise<number> {
    return (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
  }

  async function claim(deps: Deps): Promise<Response> {
    return await createApp(deps).fetch(
      new Request(ORIGIN + "/setup/claim", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ code: CODE_OK, workspace: "Acme Tours", email: "owner@example.com" }),
      }),
    );
  }

  it("reopens setup after a claim whose token was never used", async () => {
    const { deps } = await makeDeps({ setupCode: CODE_OK });
    expect((await claim(deps)).status).toBe(201);
    expect((await createApp(deps).fetch(new Request(ORIGIN + "/setup"))).status).toBe(404);
    await run(deps);
    for (const t of ["workspace", "user", "api_token", "setup"]) expect(await count(deps, t), t).toBe(0);
    expect((await createApp(deps).fetch(new Request(ORIGIN + "/setup"))).status).toBe(200);
    expect((await claim(deps)).status).toBe(201);
  });

  it("changes nothing once the token has been used", async () => {
    const { deps } = await makeDeps({ setupCode: CODE_OK });
    const res = await claim(deps);
    const { token } = (await res.json()) as { token: string };
    expect((await createApp(deps).fetch(new Request(ORIGIN + "/api/v1/me", { headers: { authorization: `Bearer ${token}` } }))).status).toBe(200);
    await run(deps);
    for (const t of ["workspace", "user", "api_token", "setup"]) expect(await count(deps, t), t).toBe(1);
  });

  it("changes nothing when a tour exists", async () => {
    const { deps } = await makeDeps({ setupCode: CODE_OK });
    expect((await claim(deps)).status).toBe(201);
    const ws = await deps.db.first<{ id: string }>("SELECT id FROM workspace");
    await deps.db.run(
      "INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES ('tour_x', ?, 'T', 'abcdefghij', 'draft', 1, 1)",
      [ws!.id],
    );
    await run(deps);
    for (const t of ["workspace", "user", "api_token", "setup", "tour"]) expect(await count(deps, t), t).toBe(1);
  });

  it("changes nothing when there is more than one workspace", async () => {
    const { deps } = await makeDeps({ setupCode: CODE_OK });
    expect((await claim(deps)).status).toBe(201);
    await seedWorkspace(deps, "Second");
    await run(deps);
    expect(await count(deps, "workspace")).toBe(2);
    expect(await count(deps, "setup")).toBe(1);
  });
});

describe("the tunnel route", () => {
  const TUNNEL = import.meta.glob(["../deploy/tunnel/docker-compose.yml", "../deploy/tunnel/caddy/Caddyfile", "../deploy/docker-compose.yml"], {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const compose = TUNNEL["../deploy/tunnel/docker-compose.yml"];
  const caddyfile = TUNNEL["../deploy/tunnel/caddy/Caddyfile"];
  const direct = TUNNEL["../deploy/docker-compose.yml"];
  const runbook = docs[DOCKER];

  /** The body of a here-document inside install.sh, by its end marker. */
  function embedded(marker: string): string {
    const m = installSh.match(new RegExp(`<<'${marker}'\\n([\\s\\S]*?)^${marker}$`, "m"));
    if (!m) throw new Error(`no ${marker} in install.sh`);
    return m[1];
  }

  /** One service's block of a compose file. */
  function service(text: string, name: string): string {
    const m = text.match(new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)*)`, "m"));
    if (!m) throw new Error(`no service ${name}`);
    return m[1];
  }

  it("install.sh carries exact copies of the tunnel stack file and Caddyfile", () => {
    expect(embedded("DP_TUNNEL_COMPOSE_END")).toBe(compose);
    expect(embedded("DP_TUNNEL_CADDYFILE_END")).toBe(caddyfile);
  });

  it("publishes no port on the host and requests no certificate", () => {
    expect(compose).not.toMatch(/^\s*(ports|expose|network_mode):/m);
    expect(direct).toMatch(/^\s*ports:/m);
    expect(caddyfile).toMatch(/^\tauto_https off$/m);
    expect(caddyfile).toMatch(/^http:\/\/\{\$DOMAIN\} \{$/m);
    expect(caddyfile).not.toContain("ACME_EMAIL");
    expect(caddyfile).toContain('header Strict-Transport-Security "max-age=604800"');
    expect(caddyfile).toContain("reverse_proxy app:3000");
  });

  it("pins cloudflared by digest and uses the same Caddy image as the direct stack", () => {
    expect(service(compose, "cloudflared")).toMatch(/^    image: cloudflare\/cloudflared@sha256:[0-9a-f]{64}$/m);
    const caddyImage = /^    image: (caddy@sha256:[0-9a-f]{64})$/m;
    expect(service(compose, "caddy").match(caddyImage)?.[1]).toBe(service(direct, "caddy").match(caddyImage)?.[1]);
  });

  it("gives the token to cloudflared through TUNNEL_TOKEN only, never on a command line or to another service", () => {
    const cf = service(compose, "cloudflared");
    expect(cf).toContain("      TUNNEL_TOKEN: ${TUNNEL_TOKEN:?TUNNEL_TOKEN is not set in .env}\n");
    expect(cf).toContain("    command: tunnel --no-autoupdate --metrics 127.0.0.1:20241 run\n");
    expect(cf).not.toContain("--token");
    expect(compose).not.toMatch(/^\s*env_file:/m);
    expect(compose.match(/^\s+TUNNEL_TOKEN:/gm)).toHaveLength(1);
    for (const name of ["app", "caddy"]) expect(service(compose, name), name).not.toMatch(/^\s+TUNNEL_TOKEN/m);
    expect(compose).not.toMatch(/eyJ[A-Za-z0-9+/_-]{20,}/);
  });

  it("cloudflared is healthy only while its own ready check passes", () => {
    expect(service(compose, "cloudflared")).toContain('test: ["CMD", "cloudflared", "tunnel", "--metrics", "127.0.0.1:20241", "ready"]');
  });

  it("the runbook, the installer and the stack file name the same service URL", () => {
    const url = installSh.match(/^readonly TUNNEL_SERVICE_URL=(\S+)$/m)?.[1];
    expect(url).toBe("http://caddy:80");
    expect(runbook).toContain("```text\nhttp://caddy:80\n```");
    expect(compose).toContain("service URL http://caddy:80");
    expect(service(compose, "caddy")).not.toBe("");
  });

  it("the runbook covers the route end to end, with its warnings and its open points", () => {
    for (const s of [
      "## Behind a Cloudflare Tunnel",
      "sudo bash install.sh install --tunnel",
      "DEPLOY_MODE=tunnel",
      "TUNNEL_TOKEN",
      "### Switch between the direct and the tunnel route",
      "### What is not yet confirmed",
      "tunnel --no-autoupdate --metrics 127.0.0.1:20241 run",
      "Provided Tunnel token is not valid.",
    ]) expect(runbook, s).toContain(s);
    const section = runbook.slice(runbook.indexOf("## Behind a Cloudflare Tunnel"), runbook.indexOf("## Two addresses"));
    expect(section.match(/^> \[!WARNING\]$/gm)?.length).toBeGreaterThanOrEqual(3);
    expect(section.match(/\*\*How to tell it worked:\*\*/g)?.length).toBeGreaterThanOrEqual(5);
    expect(section).toMatch(/\*\*Unconfirmed:\*\* this route has not yet been run against a real tunnel/);
    // The docs never show a token being typed after TUNNEL_TOKEN= on a command line.
    for (const line of codeLines(runbook)) expect(line).not.toMatch(/TUNNEL_TOKEN=\S*eyJ/);
  });

  it("every message the troubleshooting table quotes for the tunnel route is one install.sh prints", () => {
    for (const s of [
      "this install is in direct mode",
      "this install is in tunnel mode",
      "the running stack was written for",
      "that is not a tunnel token",
      "cloudflared could not read the token",
      "Cloudflare refused the tunnel's registration",
      "cloudflared could not reach Cloudflare",
      "what was pasted had more than one line",
      "--new-token is for an install in tunnel mode",
      "nothing is installed on this machine",
      "the new token was not saved",
      "this install is still not finished",
    ]) {
      expect(runbook, s).toContain(s);
      expect(installSh, s).toContain(s);
    }
  });

  it("what the runbook says the tunnel route prints is what install.sh prints", () => {
    for (const s of [
      "The platform is running and its tunnel is connected to Cloudflare.",
      "In Cloudflare's dashboard, the tunnel needs one published application (skip this if it is there already):",
      "No port is published on this server; it is reached only through the tunnel, at https://",
      "Tunnel token from the Cloudflare dashboard (what you paste is not shown):",
      "How do visitors reach this server?",
    ]) {
      expect(runbook, s).toContain(s);
      expect(installSh, s).toContain(s);
    }
  });
});

describe("a tunnel token that does not connect", () => {
  const runbook = docs[DOCKER];

  it("the runbook says a failed first tunnel install is put right by running the script again", () => {
    expect(runbook).toContain("### If the tunnel does not connect");
    expect(runbook).toContain("every run asks for the token again");
    expect(runbook).toContain("printed once, at the end of the first run whose tunnel connects");
    expect(runbook).not.toContain("On a first install it asks again");
    expect(installSh).toContain("it asks for the tunnel token again");
  });

  it("the runbook's way to replace the token on a working install is --new-token, not an edit of .env", () => {
    expect(runbook).toContain("sudo bash install.sh install --new-token");
    expect(runbook).not.toMatch(/edit the `TUNNEL_TOKEN=` line/);
    expect(runbook).toContain(".tunnel-pending");
    expect(installSh).toContain('PENDING_FILE="$INSTALL_DIR/.tunnel-pending"');
  });

  it("the runbook says a new token is saved only after it has connected, and what update does with an unfinished install", () => {
    expect(runbook).toContain("saved to `.env` before the stack starts");
    // A trial is not free: the tunnel restarts, and neither text may claim otherwise.
    const started = "The site is started again on the previous token";
    expect(runbook).toContain(started);
    expect(installSh).toContain(started);
    expect(runbook).toContain("the site cannot be reached for a moment");
    expect(installSh).toContain("the site cannot be reached for a moment");
    expect(runbook).not.toContain("keeps running");
    expect(installSh.split("\n").filter((l) => !l.startsWith("#")).join("\n")).not.toContain("keeps running");
    // The new token is saved straight after the start, before Caddy is restarted.
    const start = installSh.match(/^start_stack\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
    expect(start.indexOf("save_new_token")).toBeGreaterThan(0);
    expect(start.indexOf("save_new_token")).toBeLessThan(start.indexOf("restart caddy"));
    expect(runbook).toContain("Only once the tunnel has connected does the script rewrite the `TUNNEL_TOKEN` line of `.env`");
    expect(runbook).not.toContain("puts the previous token back");
    expect(installSh).not.toContain("Putting the previous token back");
    const said = "The last install here did not finish: its tunnel never connected to Cloudflare, so the site cannot be reached yet";
    expect(runbook).toContain(said);
    expect(installSh).toContain(said);
    expect(runbook).toContain("`sudo bash install.sh update` leaves the file where it is");
    // update has no line that removes the mark: only finish, in an install run, does.
    const update = installSh.match(/^cmd_update\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
    expect(update).toContain("PENDING_FILE");
    expect(update).not.toMatch(/\brm\b|safe_rm_file/);
    expect(installSh.match(/safe_rm_file "\$PENDING_FILE"/g)?.length).toBe(1);
  });

  it("starting the stack removes no container the script did not make", () => {
    for (const line of installSh.split("\n")) if (/ up -d/.test(line)) expect(line).not.toContain("--remove-orphans");
  });
});

describe("two addresses in the stack files", () => {
  const FILES = import.meta.glob(
    [
      "../deploy/docker-compose.yml",
      "../deploy/tunnel/docker-compose.yml",
      "../deploy/caddy/Caddyfile",
      "../deploy/caddy/Caddyfile.two",
      "../deploy/tunnel/caddy/Caddyfile",
      "../deploy/tunnel/caddy/Caddyfile.two",
    ],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;
  const file = (path: string): string => {
    const text = FILES[`../deploy/${path}`];
    if (text === undefined) throw new Error(`no deploy/${path}`);
    return text;
  };

  /** The body of a here-document inside install.sh, by its end marker. */
  function embedded(marker: string): string {
    const m = installSh.match(new RegExp(`<<'${marker}'\\n([\\s\\S]*?)^${marker}$`, "m"));
    if (!m) throw new Error(`no ${marker} in install.sh`);
    return m[1];
  }

  /** One service's block of a compose file. */
  function service(text: string, name: string): string {
    const m = text.match(new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)*)`, "m"));
    if (!m) throw new Error(`no service ${name}`);
    return m[1];
  }

  /** The lines of b that differ from the line of a at the same place, as pairs. */
  function changedLines(a: string, b: string): [string, string][] {
    const x = a.split("\n");
    const y = b.split("\n");
    expect(y.length).toBe(x.length);
    return x.flatMap((line, i): [string, string][] => (line === y[i] ? [] : [[line, y[i]]]));
  }

  it("install.sh carries exact copies of all four Caddyfiles and both stack files", () => {
    expect(embedded("DP_COMPOSE_END")).toBe(file("docker-compose.yml"));
    expect(embedded("DP_TUNNEL_COMPOSE_END")).toBe(file("tunnel/docker-compose.yml"));
    expect(embedded("DP_CADDYFILE_END")).toBe(file("caddy/Caddyfile"));
    expect(embedded("DP_CADDYFILE_TWO_END")).toBe(file("caddy/Caddyfile.two"));
    expect(embedded("DP_TUNNEL_CADDYFILE_END")).toBe(file("tunnel/caddy/Caddyfile"));
    expect(embedded("DP_TUNNEL_CADDYFILE_TWO_END")).toBe(file("tunnel/caddy/Caddyfile.two"));
  });

  it("the two-address Caddyfiles differ from the one-address ones only in the site address line", () => {
    expect(changedLines(file("caddy/Caddyfile"), file("caddy/Caddyfile.two"))).toEqual([["{$DOMAIN} {", "{$DOMAIN}, {$APP_DOMAIN} {"]]);
    expect(changedLines(file("tunnel/caddy/Caddyfile"), file("tunnel/caddy/Caddyfile.two"))).toEqual([
      ["http://{$DOMAIN} {", "http://{$DOMAIN}, http://{$APP_DOMAIN} {"],
    ]);
  });

  it("the one-address Caddyfiles have no place for a second name, so an empty one cannot widen them", () => {
    for (const p of ["caddy/Caddyfile", "tunnel/caddy/Caddyfile"]) expect(file(p), p).not.toContain("APP_DOMAIN");
  });

  it("both stack files give the app its two addresses, derived from DOMAIN and APP_DOMAIN, and Caddy the app address", () => {
    for (const p of ["docker-compose.yml", "tunnel/docker-compose.yml"]) {
      const app = service(file(p), "app");
      expect(app, p).toContain("      TOURS_HOST: ${APP_DOMAIN:+${DOMAIN}}\n");
      expect(app, p).toContain("      APP_HOST: ${APP_DOMAIN:-}\n");
      const caddy = service(file(p), "caddy");
      expect(caddy, p).toContain("      APP_DOMAIN: ${APP_DOMAIN:-}\n");
      expect(caddy, p).toContain("      DOMAIN: ${DOMAIN:?DOMAIN is not set in .env}\n");
      // Without APP_DOMAIN nothing is required: one address stays the default.
      expect(file(p), p).not.toMatch(/\$\{APP_DOMAIN:\?/);
      expect(file(p), p).not.toMatch(/\$\{(TOURS_HOST|APP_HOST)/);
    }
    expect(service(file("tunnel/docker-compose.yml"), "cloudflared")).not.toMatch(/APP_DOMAIN|TOURS_HOST|APP_HOST/);
  });

  it("install.sh reads APP_DOMAIN from .env, takes --app-domain=<name> and never rewrites .env for it", () => {
    const read = installSh.match(/^read_env_file\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
    expect(read).toMatch(/^ {6}APP_DOMAIN\) /m);
    expect(read).toContain("has an APP_DOMAIN that is not a valid host name or is the same as DOMAIN; fix it by hand, nothing was changed");
    expect(installSh).toContain("  --app-domain=<name>  With install: a second address, for the app. The domain asked for stays the address of the tours.");
    for (const s of [
      "--app-domain goes only with install",
      "--app-domain must be a host name in lowercase, such as app.example.com, without https:// and without a path",
      "the app address must be a different name than the tours address",
      "and install.sh does not change that file. To add the second address, add that line to",
      "Mythicshot keeps using https://",
      "answered, but the platform does not see it as its",
      "and that nothing in front of the platform changes the Host header.",
    ]) expect(installSh, s).toContain(s);
    // The only function that rewrites an existing .env changes the TUNNEL_TOKEN line alone.
    const replace = installSh.match(/^replace_env_token\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
    expect(replace).not.toBe("");
    expect(replace).not.toContain("APP_DOMAIN");
  });

  it("the role check tells an older platform from a changed Host header, and asks without a curl settings file", () => {
    expect(installSh).toContain("answered, but the platform running here is older than two addresses. Run: sudo bash");
    const check = installSh.match(/^check_role\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
    expect(check).toContain("older than two addresses");
    expect(check).toContain("does not see it as its");
    const calls = check.split("\n").filter((l) => /\$\(curl /.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const l of calls) expect(l).toMatch(/\$\(curl -q /);
  });

  it("the script takes neither host name nor the token from the caller's environment into Compose", () => {
    for (const name of ["TUNNEL_TOKEN", "APP_DOMAIN", "DOMAIN"]) expect(installSh, name).toMatch(new RegExp(`^unset ${name}$`, "m"));
  });

  it("TOURS_HOST and APP_HOST in a Docker .env are reported as having no effect, in the script and in the runbook", () => {
    const read = installSh.match(/^read_env_file\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
    expect(read).toContain("TOURS_HOST | APP_HOST)");
    expect(read).toContain("which has no effect on an install made by this script: a second address is set with APP_DOMAIN");
    const two = section(docs[DOCKER], "Two addresses");
    expect(two).toMatch(/`TOURS_HOST` or `APP_HOST` line written into `\.env` by hand has no effect/);
    expect(two).toContain("which has no effect on an install made by this script");
  });

  it("the runbook says which Compose version the two-address settings were checked on, and the way back after a failed start", () => {
    const two = section(docs[DOCKER], "Two addresses");
    expect(two).toMatch(/checked on Docker Compose 5\.5\.1, not on the oldest version the script accepts/);
    expect(two).toContain("validates the new stack file before it replaces anything");
    expect(two).toMatch(/puts the old Caddyfile back but never changes `\.env`/);
    expect(two).toContain("remove the `APP_DOMAIN` line");
    expect(installSh).toMatch(/^# .*checked on Compose 5\.5\.1/m);
    // The option's row in the table stays short and points to the section.
    const row = docs[DOCKER].split("\n").find((l) => l.startsWith("| `--app-domain=<name>` |")) ?? "";
    expect(row).toContain("](#two-addresses)");
    expect(row).not.toContain("5.5.1");
    expect(row.length).toBeLessThan(400);
  });

  it("the stack files name only placeholder hosts", () => {
    for (const [p, text] of Object.entries(FILES)) {
      for (const m of text.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev)\b/g)) expect(isPlaceholderHost(m[0]), `${p}: ${m[0]}`).toBe(true);
    }
  });
});

describe("two addresses in the docs", () => {
  const HOSTS = { tours: "tours.example.com", app: "app.example.com" };
  const readme = section(docs[README], "One address or two");
  const docker = section(docs[DOCKER], "Two addresses");
  const cloudflare = section(docs[CLOUDFLARE], "Two addresses");

  it("the README and both runbooks say how to turn on two addresses, and how to go back", () => {
    // The README: the settings, what answers where, and where each route's steps are.
    for (const name of ["TOURS_HOST", "APP_HOST"]) expect(docs[README], name).toMatch(new RegExp(`^\\| \`${name}\` \\| both \\| `, "m"));
    expect(docs[README]).toMatch(/^The container stack's `\.env`, written by `install\.sh`, also holds .*`APP_DOMAIN`/m);
    for (const link of ["](docs/runbook-docker.md#two-addresses)", "](docs/runbook-cloudflare.md#two-addresses)", "](docs/hosting/cpanel.md#14-a-second-address-for-the-app)"]) expect(readme, link).toContain(link);
    expect(readme).toMatch(/Mythicshot keeps (using )?the tours address/);
    expect(readme).toMatch(/[Tt]o go back/);

    // The Docker runbook: both routes, a first install, an existing one, the check and the way back.
    expect(docs[DOCKER]).toContain("- [Two addresses](#two-addresses)");
    for (const s of [
      "sudo bash install.sh install --app-domain=app.example.com",
      "sudo bash install.sh install --tunnel --app-domain=app.example.com",
      "```text\nAPP_DOMAIN=app.example.com\n```",
      "### On a first install",
      "### On an install that has one address today",
      "### Go back to one address",
      "a published application for each",
    ]) expect(docker, s).toContain(s);
    expect(docker).toMatch(/\| A \| `app` /);
    expect(docker.match(/\*\*How to tell it worked:\*\*/g)?.length).toBeGreaterThanOrEqual(2);
    const back = docker.slice(docker.indexOf("### Go back to one address"));
    expect(back).toContain("`APP_DOMAIN` line");
    expect(back).toContain("sudo bash install.sh install");

    // The Cloudflare runbook: the two vars, and that turning them on waits for a later version.
    expect(docs[CLOUDFLARE]).toContain("- [Two addresses](#two-addresses)");
    for (const s of ["`TOURS_HOST`", "`APP_HOST`", "writes both empty", "`workers.dev`", "421", '{"error":"misconfigured"}', "wrangler.deploy.jsonc"]) expect(cloudflare, s).toContain(s);
    expect(cloudflare).toMatch(/waits? for a later version/);
    expect(cloudflare).toMatch(/[Tt]o go back/);
    expect(cloudflare).toContain("npm run setup:cloudflare -- update");
  });

  it("the docs name only placeholder hosts for both addresses", () => {
    const allowed: Record<string, string[]> = {
      TOURS_HOST: ["tours.example.com", ""],
      APP_HOST: ["app.example.com", ""],
      APP_DOMAIN: ["app.example.com", "<name>"],
      "--app-domain": ["app.example.com", "<name>"],
      DOMAIN: ["tours.example.com"],
    };
    let seen = 0;
    for (const p of MARKDOWN) {
      const text = docs[p];
      const found: [string, string][] = [];
      for (const m of text.matchAll(/(?<![A-Z_])(TOURS_HOST|APP_HOST|APP_DOMAIN|DOMAIN)=([a-z0-9.<>-]+)/g)) found.push([m[1], m[2]]);
      for (const m of text.matchAll(/(--app-domain)(?:=| (?=<|[a-z0-9-]+\.))([a-z0-9.<>-]+)/g)) found.push([m[1], m[2]]);
      for (const m of text.matchAll(/"(TOURS_HOST|APP_HOST)":\s*"([^"]*)"/g)) found.push([m[1], m[2]]);
      for (const [key, raw] of found) {
        expect(allowed[key], `${p}: ${key}=${raw}`).toContain(raw.replace(/\.$/, ""));
        seen++;
      }
      // Where a doc shows the answer of /api/v1/me, the names in it are the placeholders.
      for (const m of text.matchAll(/"addresses":\{[^}]*\}/g)) expect(m[0], p).toBe('"addresses":{"tours":"tours.example.com","app":"app.example.com"}');
    }
    expect(seen).toBeGreaterThan(8);
    for (const part of [readme, docker, cloudflare]) for (const host of Object.values(HOSTS)) expect(part).toContain(host);
  });

  it("every part about two addresses says it has never been run on real hosting", () => {
    expect(readme).toMatch(/^> \[!warning\] Never run on real hosting\n> Nothing about two addresses has been run on real hosting yet/m);
    expect(docker).toMatch(/^\*\*Unconfirmed:\*\* nothing in this section has been run on a real server or against a real tunnel/m);
    expect(cloudflare).toMatch(/^\*\*Unconfirmed:\*\* nothing in this section has been run on a real Cloudflare account/m);
  });

  it("what the README says each address answers is what the app answers", async () => {
    const { deps } = await makeDeps({ setupCode: "0123456789abcdef0123456789abcdef", hosts: HOSTS });
    const ask = (host: string, path: string, headers: Record<string, string> = {}) => createApp(deps).fetch(new Request(`https://${host}${path}`, { headers, redirect: "manual" }));
    const hosts = [HOSTS.tours, HOSTS.app, "other.example.net"];
    // The wizard is open only until a workspace exists, so it is asked first, before anyone has claimed the install.
    const wizard: number[] = [];
    for (const host of hosts) wizard.push((await ask(host, "/setup")).status);
    const { token } = await seedWorkspace(deps, "Acme Tours");

    // /healthz: the three bodies the README gives.
    for (const [host, body] of [
      [HOSTS.tours, '{"ok":true,"address":"tours"}'],
      [HOSTS.app, '{"ok":true,"address":"app"}'],
      ["other.example.net", '{"ok":true}'],
    ]) {
      expect(readme, body).toContain("`" + body + "`");
      expect(await (await ask(host, "/healthz")).text(), host).toBe(body);
    }

    // The table: one row per kind of request, with the status on each address.
    const row = (start: string): string[] => {
      const line = readme.split("\n").find((l) => l.startsWith(`| ${start}`));
      if (!line) throw new Error(`no row ${start}`);
      return line.split("|").slice(1, -1).map((c) => c.trim());
    };
    expect(row("Request")).toEqual(["Request", "Tours address", "App address", "Any other host name"]);
    const cases: [string, string, Record<string, string>, number[]][] = [
      ["A tour page, `/t/<slug>`", "/t/abcdefghij?x=1", {}, [404, 308, 421]],
      ["A published picture, `/p/<name>`", "/p/nothing.png", {}, [404, 308, 421]],
      ["The token API, `/api/v1/…`", "/api/v1/me", { authorization: `Bearer ${token}` }, [200, 200, 421]],
      ["The setup wizard, `/setup`", "/setup", {}, [200, 404, 421]],
      ["The player's script and stylesheet", "/player.js", {}, [200, 404, 421]],
      ["`/healthz`", "/healthz", {}, [200, 200, 200]],
    ];
    for (const [start, path, headers, statuses] of cases) {
      const cells = row(start);
      for (let i = 0; i < 3; i++) {
        const status = path === "/setup" ? wizard[i] : (await ask(hosts[i], path, headers)).status;
        expect(status, `${path} on ${hosts[i]}`).toBe(statuses[i]);
        // Nothing is published here, so the tours address answers 404 for the page and the picture; the row says it answers.
        if (statuses[i] === 308 || statuses[i] === 421 || (i === 1 && statuses[i] === 404)) expect(cells[i + 1], `${start}: column ${i + 1}`).toContain("`" + statuses[i] + "`");
        else expect(cells[i + 1], `${start}: column ${i + 1}`).toMatch(/^Answers/);
      }
    }

    // The redirect goes to the tours address, with the same path and query, and is not kept.
    const moved = await ask(HOSTS.app, "/t/abcdefghij?x=1");
    expect(moved.headers.get("location")).toBe("https://tours.example.com/t/abcdefghij?x=1");
    expect(moved.headers.get("cache-control")).toBe("no-store");
    expect(readme).toContain("same path and query");

    // The refusal is empty.
    const refused = await ask("other.example.net", "/t/abcdefghij");
    expect(await refused.text()).toBe("");
    expect(readme).toContain("an empty `421`");

    // /api/v1/me names both addresses, as the README shows, and only with two addresses.
    const me = (await (await ask(HOSTS.app, "/api/v1/me", { authorization: `Bearer ${token}` })).json()) as { addresses?: unknown };
    expect(me.addresses).toEqual(HOSTS);
    expect(docs[README]).toContain('"addresses":{"tours":"tours.example.com","app":"app.example.com"}');
    const one = await makeDeps({});
    const seeded = await seedWorkspace(one.deps, "Acme Tours");
    const plain = await createApp(one.deps).fetch(new Request("https://tours.example.com/api/v1/me", { headers: { authorization: `Bearer ${seeded.token}` } }));
    expect(Object.keys((await plain.json()) as object).sort()).toEqual(["version", "workspace"]);
  });

  it("the lines the README quotes for a pair that cannot be used are the app's own", async () => {
    const { resolveHosts } = await import("../src/hosts.ts");
    const lines = [
      resolveHosts({ tours: "tours.example.com" }),
      resolveHosts({ tours: "https://tours.example.com", app: "app.example.com" }),
      resolveHosts({ tours: "tours.example.com", app: "tours.example.com" }),
    ].map((r) => (r.ok ? "" : r.problem));
    expect(lines[0]).toBe("TOURS_HOST is set but APP_HOST is not. Set both for two addresses, or neither for one.");
    for (const line of lines) {
      expect(line).not.toBe("");
      expect(readme, line).toContain(line);
    }
    expect(readme).toContain('{"error":"misconfigured"}');
    expect(cloudflare).toContain("`hosts: `");
  });

  it("what the Docker runbook quotes for two addresses is what install.sh prints", () => {
    for (const s of [
      "Mythicshot keeps using https://",
      "answered, but the platform running here is older than two addresses",
      "answered, but the platform does not see it as its",
      "and that nothing in front of the platform changes the Host header.",
      "and install.sh does not change that file. To add the second address, add that line to",
      "but the Caddyfile here was written for one address, and update does not rewrite it",
      "but the Caddyfile here was written for two addresses, and update does not rewrite it",
      "the app address must be a different name than the tours address",
      "has an APP_DOMAIN that is not a valid host name or is the same as DOMAIN",
      "--app-domain goes only with install",
      "the tunnel needs two published applications, one for each address",
      "did not answer",
      "was not asked",
    ]) {
      expect(docs[DOCKER], s).toContain(s);
      expect(installSh, s).toContain(s);
    }
    // The line for an address that passed is built from the host and its role.
    expect(installSh).toContain(`info "$host is the platform's $role address"`);
    for (const role of ["tours", "app"]) expect(docker).toContain(`\`${role}.example.com is the platform's ${role} address\``);
    // A wrong role is a failed run, and status reports it the same way.
    expect(docker).toContain("exit code 1");
    expect(docker).toMatch(/`sudo bash install\.sh status`[^\n]*exit code 1/);
    const status = installSh.match(/^cmd_status\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
    expect(status).toContain("check_roles 1");
  });

  it("the Docker runbook still says no forwarded header is read, and the Fly steps are said to wait", () => {
    const sees = docs[DOCKER].slice(docs[DOCKER].indexOf("What the app sees:"), docs[DOCKER].indexOf("The tunnel token reaches cloudflared"));
    for (const s of ["`X-Forwarded-Host`", "`Forwarded`", "`X-Original-Host`", "`Host` header"]) expect(sees, s).toContain(s);
    expect(sees).toMatch(/two addresses/);
    // The code agrees: no source file reads a forwarded host.
    let sources = 0;
    for (const [path, text] of Object.entries(CODE)) {
      if (!path.startsWith("../src/")) continue;
      sources++;
      const code = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(code.toLowerCase(), path).not.toMatch(/x-forwarded-host|x-original-host|["'`]forwarded["'`]/);
    }
    expect(sources).toBeGreaterThan(10);
    expect(docker).toMatch(/Fly\.io[^\n]*wait for a later version/);
  });

  it("the Cloudflare runbook says what the guided setup does with the two vars, as the command does", () => {
    expect(setupCloudflareTs).toContain('const HOST_VARS = ["TOURS_HOST", "APP_HOST"] as const;');
    expect(setupCloudflareTs).toContain("it handles one custom domain only");
    expect(cloudflare).toContain("it handles one custom domain only");
    expect(cloudflare).toContain("keeps a pair that was set by hand");
    expect(CODE["../wrangler.jsonc"]).toMatch(/"TOURS_HOST": "",\n\s*"APP_HOST": ""/);
  });
});
