import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../app.ts";
import { withBudget } from "../budget.ts";
import { setClientAddress } from "../client.ts";
import { DEFER_FAILED, deferTracker, type Deps } from "../ports.ts";
import { clientAddressReader, configFromEnv, guardTarget, mailFromEnv, type Incoming } from "./config.ts";
import { APP_UID, prepareDataDir } from "./datadir.ts";
import { NodeDb } from "./db.ts";
import { NodeFileStore } from "./files.ts";
import { migrate } from "./migrate.ts";

// src/node/entry.ts and dist/node/entry.js both sit two folders below the repo root.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** How long open requests may run after SIGTERM before their connections are cut. */
const STOP_GRACE_MS = 5000;

/**
 * A client must send all request headers within 15 s and the whole request, body
 * included, within 60 s, or Node answers 408 and closes the connection. The largest body
 * is a 2,000,000-byte step image, so 60 s still allows an uplink of about 35 KB/s, while
 * a slow or stalled client cannot hold a connection open for Node's default five minutes.
 */
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  // Everything the app creates (the database, its WAL, draft and published files) is
  // readable by the app user only. Set before any file is opened.
  process.umask(0o077);
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("DATA_DIR is not set");
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is not a valid port");
  // Read before anything is created or opened: a pair of addresses that cannot be used
  // stops the start here, with its one line and nothing else.
  const config = configFromEnv(process.env);
  // Mail and the client address never stop the start. A mail block that cannot be used
  // leaves mail off, and a header name that cannot be used leaves every address unknown;
  // each says so in one fixed line that holds no value. The mail server is not contacted
  // here: the first connection is made by the first mail.
  const mail = mailFromEnv(process.env, config);
  if (mail.problem !== null) console.error(mail.problem);
  const client = clientAddressReader(process.env.CLIENT_ADDRESS_HEADER);
  if (client.problem !== null) console.error(client.problem);
  // Work that goes on after an answer (a mail being sent) is tracked here, so a stop can
  // wait for it. A failure is one fixed line; the error itself is never written.
  const background = deferTracker(() => console.error(DEFER_FAILED));

  const root = prepareDataDir(dataDir);
  const dbPath = join(root, "db.sqlite");
  let db: NodeDb;
  try {
    db = new NodeDb(dbPath);
  } catch {
    const uid = typeof process.getuid === "function" ? process.getuid() : APP_UID;
    throw new Error(`cannot open ${dbPath}: it and its folder must be writable by uid ${uid}`);
  }
  await migrate(db, MIGRATIONS_DIR);

  const deps: Deps = {
    db,
    drafts: new NodeFileStore(join(root, "drafts")),
    pub: new NodeFileStore(join(root, "public")),
    config,
    now: () => Date.now(),
    // No mailer at all while mail is off, so the deps are then the ones of a site without mail.
    ...(mail.mode === "smtp" ? { mail: mail.mailer } : {}),
    defer: background.defer,
  };

  // Each request gets its own metered ports, as on Cloudflare, so one that goes over the
  // call budget is logged here too. Building the route table per request is cheap.
  const serveOne = (req: Request) => withBudget(deps, req.method, async (d) => createApp(d).fetch(req));
  // With two addresses the host is read from the Host header only. A request line that
  // carries a full address instead of a path would name its own host, so the guard answers
  // it as a host this install does not serve. With one address nothing is checked, as before.
  const guarded = guardTarget(config.hosts, serveOne);
  // The client address is noted before the app sees the request: the socket's, or the last
  // value of the header CLIENT_ADDRESS_HEADER names. The app itself reads no header for it.
  const fetchOne = (req: Request, env: { incoming: Incoming & { url?: string } }) => {
    setClientAddress(req, client.read(env.incoming));
    return guarded(req, env);
  };
  const server = serve({ fetch: fetchOne, port, serverOptions: { headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS } }, (info) => {
    console.log(`listening on port ${info.port}`);
  });

  // `docker stop` sends SIGTERM, and Node running as PID 1 has no default handler for
  // it. Stop taking requests, let open ones finish, then close the database so SQLite
  // checkpoints its WAL into db.sqlite and the file is whole on the volume. If requests
  // are still open after the grace period they are cut, before Docker's own 10 s kill.
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, stopping`);
    const finish = () => {
      // Work still going on after its answer (a mail on its way) is given the same grace
      // as open requests before the database is closed under it. Nothing is tried again:
      // a mail cut off here is not sent a second time.
      const grace = new Promise<void>((done) => setTimeout(done, STOP_GRACE_MS));
      void Promise.race([background.settle(), grace]).then(() => {
        db.close();
        console.log("stopped");
        process.exit(0);
      });
    };
    server.close(finish);
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }, STOP_GRACE_MS).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "startup failed");
  process.exit(1);
});
