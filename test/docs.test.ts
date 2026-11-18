/// <reference types="vite/client" />
// Checks on README.md and the two runbooks that can be made without a server: links and
// anchors resolve, every install.sh command and option the docs name exists and every
// one the script has is documented, every environment variable the docs name is read by
// the code, no hostname other than the placeholders and the vendor pages appears, and
// the setup-recovery SQL both runbooks give does what they say on both targets.
//
// Files are read through Vite's ?raw imports, which work under both Vitest configs.
import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { createApp } from "../src/app.ts";
import type { Deps } from "../src/ports.ts";
import installSh from "../deploy/install.sh?raw";

const DOCS = import.meta.glob(["../README.md", "../LICENSE", "../docs/*.md"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every file a doc may link to; only the keys are used. */
const REPO_FILES = Object.keys(
  import.meta.glob(["../*", "../deploy/**", "../docs/**", "../migrations/**", "../src/**", "../test/**"], { query: "?raw" }),
).map((k) => k.replace(/^\.\.\//, ""));

/** The code that reads environment variables, as text. */
const CODE = import.meta.glob(["../src/**/*.ts", "../scripts/*.ts", "../deploy/docker-compose.yml", "../deploy/caddy/Caddyfile", "../Dockerfile", "../wrangler.jsonc"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Docs keyed by their path from the repo root. */
const docs: Record<string, string> = Object.fromEntries(Object.entries(DOCS).map(([k, v]) => [k.replace(/^\.\.\//, ""), v]));
const MARKDOWN = Object.keys(docs).filter((p) => p.endsWith(".md"));
const README = "README.md";
const DOCKER = "docs/runbook-docker.md";
const CLOUDFLARE = "docs/runbook-cloudflare.md";

/** Hosts the docs may name besides the placeholders: the vendor pages they rely on and r2.dev, named as the address not to use. */
const ALLOWED_HOSTS = new Set([
  "developers.cloudflare.com",
  "docs.docker.com",
  "download.docker.com",
  "caddyserver.com",
  "www.debian.org",
  "r2.dev",
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

/** The commands and options install.sh's parse_args accepts. */
function scriptVocabulary(): { commands: Set<string>; flags: Set<string> } {
  const body = installSh.match(/^parse_args\(\) \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
  const commands = new Set<string>();
  const flags = new Set<string>();
  for (const m of body.matchAll(/^\s*([a-z| -]+)\)/gm)) {
    for (const word of m[1].split("|").map((w) => w.trim())) {
      if (word.startsWith("-")) flags.add(word);
      else if (/^[a-z]+$/.test(word)) commands.add(word);
    }
  }
  return { commands, flags };
}

/** The install.sh commands and options a doc names: the words after install.sh on each code line. */
function docVocabulary(md: string): { commands: string[]; flags: string[] } {
  const commands: string[] = [];
  const flags: string[] = [];
  for (const line of codeLines(md)) {
    for (const m of line.matchAll(/install\.sh((?: +(?:--?[a-z][a-z-]*|[a-z]+)(?=\s|$))*)/g)) {
      for (const word of m[1].trim().split(/ +/).filter(Boolean)) (word.startsWith("-") ? flags : commands).push(word);
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
    if (path.endsWith("Caddyfile")) add(/\{\$([A-Z][A-Z0-9_]*)\}/g, text);
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
          if (!(target in docs)) problems.push(`${p}: ${link} has an anchor into a file that is not a doc`);
          else if (!anchors(docs[target]).has(anchor)) problems.push(`${p}: ${link} names a missing heading`);
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
    for (const f of flags) expect(named.flags.includes(f) || spans.has(f), `install.sh ${f}`).toBe(true);
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
    const section = runbook.slice(runbook.indexOf("## Behind a Cloudflare Tunnel"), runbook.indexOf("## Troubleshooting by symptom"));
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
