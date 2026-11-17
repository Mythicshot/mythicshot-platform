// Publish or unpublish a tour from the command line, against either target.
//
//   node scripts/publish.ts <server> <tour_id> [--unpublish]
//
// The API token comes from the DEMO_PLATFORM_TOKEN environment variable or, when that is
// not set, from a prompt that does not echo it (or one line on stdin when stdin is not a
// terminal). It is never taken from an argument, because arguments show in the process
// list, and it is never printed, not even in an error.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const TOKEN = /^dp_[0-9a-f]{40}$/;
const TOUR_ID = /^tour_[0-9a-f]{24}$/;
const USAGE = "usage: node scripts/publish.ts <server> <tour_id> [--unpublish]\n  the token is read from DEMO_PLATFORM_TOKEN or asked for at a prompt";

export type Io = {
  env: Record<string, string | undefined>;
  /** Asks for the token without echoing it. */
  prompt: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: typeof fetch;
};

/** `https://` for any host; `http://` only for this machine, so the token never crosses a network in clear text. */
export function checkServer(s: string): string | null {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/** Runs one publish or unpublish. Returns the process exit code. */
export async function runPublish(argv: string[], io: Io): Promise<number> {
  // Refuse anything that looks like a token before looking at the rest, without repeating it.
  if (argv.some((a) => a.includes("dp_"))) {
    io.err("Do not pass the token as an argument: it would show in the process list. Set DEMO_PLATFORM_TOKEN or enter it at the prompt.");
    return 2;
  }
  const unpublish = argv.includes("--unpublish");
  const positional = argv.filter((a) => a !== "--unpublish");
  if (positional.length !== 2 || positional.some((a) => a.startsWith("--"))) {
    io.err(USAGE);
    return 2;
  }
  const server = checkServer(positional[0]);
  if (server === null) {
    io.err("The server must be an https:// address (http:// only for localhost), with no user name, query or fragment.");
    return 2;
  }
  const tourId = positional[1];
  if (!TOUR_ID.test(tourId)) {
    io.err("The tour id must look like tour_ followed by 24 hex characters.");
    return 2;
  }

  const fromEnv = io.env.DEMO_PLATFORM_TOKEN;
  const token = (fromEnv !== undefined && fromEnv !== "" ? fromEnv : await io.prompt()).trim();
  if (!TOKEN.test(token)) {
    io.err("That is not an API token (dp_ followed by 40 hex characters).");
    return 2;
  }

  const action = unpublish ? "unpublish" : "publish";
  let res: Response;
  try {
    res = await io.fetch(`${server}/api/v1/tours/${tourId}/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, redirect: "error" });
  } catch {
    io.err(`Could not reach ${server}.`);
    return 1;
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (res.status === 401) {
    io.err("The server rejected the API token.");
    return 1;
  }
  if (!res.ok) {
    const code = typeof body?.error === "string" ? body.error : "error";
    const detail = typeof body?.detail === "string" ? `: ${body.detail}` : "";
    io.err(`${action} failed with HTTP ${res.status} (${code})${detail}`);
    return 1;
  }
  if (unpublish) {
    io.out(`Unpublished ${tourId}.`);
  } else {
    const url = typeof body?.url === "string" ? body.url : "";
    io.out(`Published ${body?.steps ?? "?"} steps: ${server}${url}`);
  }
  return 0;
}

/** Reads one line from the terminal without echoing it, or one line from piped stdin. */
function promptHidden(): Promise<string> {
  return new Promise((resolve) => {
    const tty = process.stdin.isTTY === true;
    if (tty) process.stderr.write("API token: ");
    const silent = new Writable({ write: (_chunk, _enc, done) => done() });
    const rl = createInterface({ input: process.stdin, output: silent, terminal: tty });
    let answered = false;
    rl.once("line", (line) => {
      answered = true;
      rl.close();
      if (tty) process.stderr.write("\n");
      resolve(line);
    });
    rl.once("close", () => {
      if (!answered) resolve("");
    });
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPublish(process.argv.slice(2), {
    env: process.env,
    prompt: promptHidden,
    out: (l) => process.stdout.write(l + "\n"),
    err: (l) => process.stderr.write(l + "\n"),
    fetch,
  }).then((code) => process.exit(code));
}
