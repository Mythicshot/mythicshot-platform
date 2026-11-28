import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../app.ts";
import { stripeOverFetch } from "../stripe.ts";
import { PRICE_MISSING, checkPrice } from "../billing.ts";
import { withBudget } from "../budget.ts";
import { setClientAddress } from "../client.ts";
import { downloadUrlSetting, homeUrlSetting } from "../https-address.ts";
import { lifetimesSetting } from "../lifetimes.ts";
import { DEFER_FAILED, deferTracker, type Deps } from "../ports.ts";
import { clientAddressReader, configFromEnv, fileStoreFromEnv, guardTarget, mailFromEnv, proxyHint, type Incoming } from "./config.ts";
import { APP_UID, prepareDataDir } from "./datadir.ts";
import { NodeDb } from "./db.ts";
import { diskModeR2Line, makeFileStores, siteFileStores } from "./file-stores.ts";
import { startMarkerCheck } from "./file-tools.ts";
import type { ClosableMailer } from "./mail-thread.ts";
import { migrate } from "./migrate.ts";
import { mediaLimitsProblem } from "../limits.ts";
import { stopSequence } from "./stop.ts";

// src/node/entry.ts and dist/node/entry.js both sit two folders below the repo root.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

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
  // Limits of shared items that would need more parts than an item may have stop the start too.
  const mediaProblem = mediaLimitsProblem(config);
  if (mediaProblem !== null) throw new Error(mediaProblem);
  // Mail and the client address never stop the start. A mail block that cannot be used
  // leaves mail off, and a header name that cannot be used leaves every address unknown;
  // each says so in one fixed line that holds no value. The mail server is not contacted
  // here, and the mail worker thread is not made: the first mail makes both.
  const mail = mailFromEnv(process.env, config);
  if (mail.problem !== null) console.error(mail.problem);
  const closeMail = (mail.mailer as Partial<ClosableMailer>).close;
  const client = clientAddressReader(process.env.CLIENT_ADDRESS_HEADER);
  if (client.problem !== null) console.error(client.problem);
  // Nor does the app's download page: one that cannot be used is left out (configFromEnv)
  // and said in its one fixed line.
  const download = downloadUrlSetting(process.env.DOWNLOAD_URL);
  if (download.problem !== null) console.error(download.problem);
  // Nor does the site's home page: one that cannot be used leaves the logo without a link
  // (configFromEnv) and is said in its one fixed line.
  const home = homeUrlSetting(process.env.HOME_URL);
  if (home.problem !== null) console.error(home.problem);
  // Nor do the sign-in lifetimes: one that cannot be used is its default (configFromEnv),
  // and each such setting is said in its one fixed line.
  for (const line of lifetimesSetting(process.env).problems) console.error(line);
  // Without the setting, a request from a private or local address is the sign of a proxy
  // whose visitors all look like one: one line says which setting to set, once.
  const hint = proxyHint(process.env.CLIENT_ADDRESS_HEADER, (line) => console.error(line));
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

  // The files: the data folder's drafts and public folders, or the two R2 buckets with
  // FILE_STORE=r2 (the settings were checked by configFromEnv above). The one factory every
  // command uses, so nothing falls back to the folders by itself.
  const fileSettings = fileStoreFromEnv(process.env);
  const files = siteFileStores(fileSettings, root);
  // R2 settings typed in while the files are still on disk, not usable yet: said once, never a value.
  if (fileSettings.r2Problem !== undefined) console.error(diskModeR2Line(fileSettings.r2Problem));
  // With the files on R2, each bucket must carry its own role marker (written by r2-check): a
  // missing or wrong one stops the start, so swapped bucket names never serve; R2 not answering
  // just now is said in one line and the start goes on. One quick try, not the retries.
  if (fileSettings.mode === "r2") {
    const marks = await startMarkerCheck(makeFileStores("r2", fileSettings, root, { timeoutMs: 10_000, bodyTimeoutMs: 10_000, retryPausesMs: [] }));
    if (marks !== null && "stop" in marks) throw new Error(marks.stop);
    if (marks !== null) console.error(marks.warn);
  }
  const deps: Deps = {
    db,
    drafts: files.drafts,
    pub: files.pub,
    // "Download all my data" streams every file from disk here: no per-request limit on reads (src/export.ts).
    config: { ...config, exportFileReads: null },
    now: () => Date.now(),
    // No mailer at all while mail is off, so the deps are then the ones of a site without mail.
    ...(mail.mode === "smtp" ? { mail: mail.mailer } : {}),
    defer: background.defer,
    // Only with billing on: the client that reaches Stripe, made from the key, which goes nowhere else.
    ...(config.billing ? { stripe: stripeOverFetch(config.billing.apiKey) } : {}),
  };

  // With billing on: Stripe is asked once for the configured price with the configured key. A
  // definite "no such price" stops the start; a key that may not read prices, or no answer, does
  // not (the admin's summary says it could not be checked).
  if (config.billing) {
    if ((await checkPrice(deps)) === "missing") throw new Error(PRICE_MISSING);
  }

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
    hint(env.incoming);
    setClientAddress(req, client.read(env.incoming));
    return guarded(req, env);
  };
  const server = serve({ fetch: fetchOne, port, serverOptions: { headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS } }, (info) => {
    console.log(`listening on port ${info.port}`);
  });

  // `docker stop` sends SIGTERM, and Node running as PID 1 has no default handler for
  // it. Stop taking requests, let open ones finish, wait for work deferred by a request
  // (a mail on its way), then end the mail worker and close the database so SQLite
  // checkpoints its WAL into db.sqlite and the file is whole on the volume. The whole stop has one deadline,
  // counted from the signal and well before the 10 s kill: requests still open after
  // STOP_CUT_REQUESTS_MS are cut, and at STOP_DEADLINE_MS the database is closed whatever
  // is still going on. The sequence and its test are in ./stop.ts.
  const stop = stopSequence({
    server: {
      close: (done) => server.close(done),
      closeIdleConnections: () => {
        if ("closeIdleConnections" in server) server.closeIdleConnections();
      },
      closeAllConnections: () => {
        if ("closeAllConnections" in server) server.closeAllConnections();
      },
    },
    settle: () => background.settle(),
    // Just before the database: a mail still on its way has had the time up to the
    // deadline, and is then ended with its worker, so the thread cannot outlive the stop.
    ...(typeof closeMail === "function" ? { closeMail: () => closeMail.call(mail.mailer) } : {}),
    closeDb: () => db.close(),
    setTimeout: (run, ms) => setTimeout(run, ms),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "startup failed");
  process.exit(1);
});
