// The Node target's stop: what happens between the signal and the end of the process,
// run here with a stand-in server, clock, tracker and database. A real signal cannot be
// sent to a child process on every platform the tests run on, so the sequence itself is
// a function, and this is the test of it.
import { describe, expect, it } from "vitest";
import { STOP_CUT_REQUESTS_MS, STOP_DEADLINE_MS, stopSequence } from "../src/node/stop.ts";

/** A clock whose timers run only when the test moves it. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  return {
    setTimeout: (run: () => void, ms: number) => void timers.push({ at: now + ms, run }),
    /** Moves the clock on, running every timer that falls due, then lets promises run. */
    async advance(ms: number): Promise<void> {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.run();
        await flush();
      }
      now = until;
      await flush();
    },
    now: () => now,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A server with one open request: `close` calls back only once its connections are cut, or the request ends. */
function fakeServer(opts: { openRequest: boolean; closesWhenCut?: boolean }) {
  let done: (() => void) | null = null;
  let open = opts.openRequest;
  const seen: string[] = [];
  const tryClose = () => {
    if (!open && done !== null) {
      const call = done;
      done = null;
      call();
    }
  };
  return {
    seen,
    close(callback: () => void) {
      seen.push("close");
      done = callback;
      tryClose();
    },
    closeIdleConnections() {
      seen.push("idle");
    },
    closeAllConnections() {
      seen.push("all");
      if (opts.closesWhenCut !== false) open = false;
      tryClose();
    },
    /** The open request ends by itself. */
    finishRequest() {
      open = false;
      tryClose();
    },
  };
}

function world(opts: { openRequest: boolean; closesWhenCut?: boolean; settle: () => Promise<void>; closeDb?: () => void }) {
  const clock = fakeClock();
  const server = fakeServer(opts);
  const events: string[] = [];
  const at: Record<string, number> = {};
  const note = (what: string) => {
    events.push(what);
    at[what] ??= clock.now();
  };
  const stop = stopSequence({
    server,
    settle: opts.settle,
    closeDb: () => {
      note("db closed");
      opts.closeDb?.();
    },
    setTimeout: clock.setTimeout,
    log: (line) => note(`log: ${line}`),
    error: (line) => note(`error: ${line}`),
    exit: (code) => note(`exit ${code}`),
  });
  return { clock, server, events, at, stop };
}

const never = () => new Promise<void>(() => {});

describe("the stop sequence of the Node target", () => {
  it("the deadline leaves room before the 10 s kill, and open requests are cut before it", () => {
    expect(STOP_DEADLINE_MS).toBe(7000);
    expect(STOP_CUT_REQUESTS_MS).toBe(5000);
    expect(STOP_CUT_REQUESTS_MS).toBeLessThan(STOP_DEADLINE_MS);
    expect(STOP_DEADLINE_MS).toBeLessThanOrEqual(10_000 - 3000);
  });

  it("with nothing open it closes the database and exits at once", async () => {
    const w = world({ openRequest: false, settle: () => Promise.resolve() });
    w.stop("SIGTERM");
    await flush();
    expect(w.events).toEqual(["log: SIGTERM received, stopping", "db closed", "log: stopped", "exit 0"]);
    expect(w.server.seen.slice(0, 2)).toEqual(["close", "idle"]);
    // The timers that were set do nothing more when they fall due.
    await w.clock.advance(60_000);
    expect(w.events.filter((e) => e === "db closed")).toHaveLength(1);
    expect(w.events.filter((e) => e.startsWith("exit"))).toHaveLength(1);
  });

  it("a slow request plus a never-ending deferred task still closes the database by the deadline, exactly once", async () => {
    const w = world({ openRequest: true, settle: never });
    w.stop("SIGTERM");
    await w.clock.advance(STOP_CUT_REQUESTS_MS - 1);
    expect(w.server.seen).toEqual(["close", "idle"]);
    expect(w.events).toEqual(["log: SIGTERM received, stopping"]);
    // The open request is cut, and the server is closed; the deferred work is still going.
    await w.clock.advance(1);
    expect(w.server.seen).toEqual(["close", "idle", "all"]);
    expect(w.events).toEqual(["log: SIGTERM received, stopping"]);
    await w.clock.advance(STOP_DEADLINE_MS - STOP_CUT_REQUESTS_MS - 1);
    expect(w.events).toEqual(["log: SIGTERM received, stopping"]);
    // One deadline, counted from the signal, not from the moment the server closed.
    await w.clock.advance(1);
    expect(w.events).toEqual(["log: SIGTERM received, stopping", "db closed", "log: stopped", "exit 0"]);
    expect(w.at["db closed"]).toBe(STOP_DEADLINE_MS);
    await w.clock.advance(60_000);
    expect(w.events.filter((e) => e === "db closed")).toHaveLength(1);
    expect(w.events.filter((e) => e.startsWith("exit"))).toHaveLength(1);
  });

  it("a server that never reports closed does not hold the stop past the deadline", async () => {
    const w = world({ openRequest: true, closesWhenCut: false, settle: () => Promise.resolve() });
    w.stop("SIGINT");
    await w.clock.advance(STOP_DEADLINE_MS - 1);
    expect(w.events).toEqual(["log: SIGINT received, stopping"]);
    await w.clock.advance(1);
    expect(w.events).toEqual(["log: SIGINT received, stopping", "db closed", "log: stopped", "exit 0"]);
  });

  it("deferred work that ends in time is waited for, and work deferred by a request still open is too", async () => {
    let release: () => void = () => {};
    const work = new Promise<void>((resolve) => (release = resolve));
    let settles = 0;
    const w = world({
      openRequest: true,
      settle: () => {
        settles += 1;
        return work;
      },
    });
    w.stop("SIGTERM");
    await w.clock.advance(1000);
    // Not asked while a request is open: that request may still defer work.
    expect(settles).toBe(0);
    w.server.finishRequest();
    await flush();
    expect(settles).toBe(1);
    expect(w.events).toEqual(["log: SIGTERM received, stopping"]);
    await w.clock.advance(2000);
    release();
    await flush();
    expect(w.events).toEqual(["log: SIGTERM received, stopping", "db closed", "log: stopped", "exit 0"]);
    expect(w.at["db closed"]).toBe(3000);
    await w.clock.advance(60_000);
    expect(w.events.filter((e) => e === "db closed")).toHaveLength(1);
  });

  it("a second signal changes nothing, and a tracker that fails does not stop the stop", async () => {
    const w = world({ openRequest: false, settle: () => Promise.reject(new Error("made-up-secret")) });
    w.stop("SIGTERM");
    w.stop("SIGINT");
    w.stop("SIGTERM");
    await flush();
    expect(w.events).toEqual(["log: SIGTERM received, stopping", "db closed", "log: stopped", "exit 0"]);
    expect(w.server.seen.filter((s) => s === "close")).toHaveLength(1);
  });

  it("a database that cannot be closed ends the process with 1 and one fixed line", async () => {
    const w = world({
      openRequest: false,
      settle: () => Promise.resolve(),
      closeDb: () => {
        throw new Error("made-up-secret");
      },
    });
    w.stop("SIGTERM");
    await flush();
    expect(w.events).toEqual(["log: SIGTERM received, stopping", "db closed", "error: stop: the database could not be closed", "exit 1"]);
  });
});
