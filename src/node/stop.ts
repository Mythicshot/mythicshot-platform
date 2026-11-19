// The Node target's stop: everything between the signal and the end of the process, as
// one function over the things it touches, so it can be run in a test with stand-ins.
//
// `docker stop` and Fly send SIGTERM and kill the process 10 s later (stop_grace_period
// and kill_timeout in deploy/), and Node running as PID 1 has no default handler for the
// signal. The database must be closed before that kill, so SQLite checkpoints its WAL
// into db.sqlite and the file is whole on the volume. So the stop has ONE deadline,
// counted from the signal: whatever is still open then is left behind and the database
// is closed.

/** When connections still open are cut, counted from the signal. Open requests get this long to finish. */
export const STOP_CUT_REQUESTS_MS = 5000;

/**
 * When the database is closed at the latest, counted from the signal: 3 s before the
 * 10 s kill. Work deferred by a request (a mail on its way) has until then, however long
 * the open requests took; it is never tried again, so a mail cut off here is not sent a
 * second time.
 */
export const STOP_DEADLINE_MS = 7000;

export type StopParts = {
  /** The listening server. `close` stops taking connections and calls back when the last one has ended. */
  server: { close(done: () => void): unknown; closeIdleConnections?: () => void; closeAllConnections?: () => void };
  /** Resolves when all deferred work has ended (the tracker's `settle`). */
  settle: () => Promise<void>;
  /**
   * Ends the mailer's work (the mail worker): refuses what waits, ends what is on its way
   * and stops the worker. Called exactly once, just before the database is closed, so a
   * mail on its way has had all the time up to the deadline. Optional: no mail, nothing.
   */
  closeMail?: () => unknown;
  /** Closes the database. Called exactly once. */
  closeDb: () => void;
  setTimeout: (run: () => void, ms: number) => unknown;
  /** Writes a line of the normal course (standard output). */
  log: (line: string) => void;
  /** Writes the one line of a stop that went wrong (standard error). */
  error: (line: string) => void;
  /** Ends the process. Called exactly once, with 0, or with 1 when the database could not be closed. */
  exit: (code: number) => void;
};

/**
 * The handler for a stop signal. On the first signal it stops taking requests and lets
 * open ones finish; when the server has closed it waits for the deferred work; then it
 * closes the mailer and the database and exits. Connections still open at STOP_CUT_REQUESTS_MS are cut.
 * At STOP_DEADLINE_MS, counted from the signal, the database is closed and the process
 * ends whatever is still open: a request that never ends, a server that never reports
 * closed, or deferred work that never settles. Further signals change nothing.
 */
export function stopSequence(parts: StopParts): (signal: string) => void {
  let stopping = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (parts.closeMail !== undefined) {
      try {
        // Not waited for: the database closes now, whatever the mailer does. A rejection is
        // caught, so none is left unhandled; its text is never read.
        void Promise.resolve(parts.closeMail()).catch(() => {});
      } catch {
        // A mailer that cannot be closed does not hold up the stop.
      }
    }
    try {
      parts.closeDb();
    } catch {
      // Fixed text: the error could carry a path or anything else the back end put in it.
      parts.error("stop: the database could not be closed");
      parts.exit(1);
      return;
    }
    parts.log("stopped");
    parts.exit(0);
  };
  return (signal) => {
    if (stopping) return;
    stopping = true;
    parts.log(`${signal} received, stopping`);
    // The one deadline, set before anything can hold the stop up.
    parts.setTimeout(finish, STOP_DEADLINE_MS);
    parts.setTimeout(() => parts.server.closeAllConnections?.(), STOP_CUT_REQUESTS_MS);
    parts.server.close(() => {
      // Only now: a request that was still open may have deferred work until it ended.
      let settled: Promise<void>;
      try {
        settled = Promise.resolve(parts.settle());
      } catch {
        settled = Promise.resolve();
      }
      void settled.then(finish, finish);
    });
    parts.server.closeIdleConnections?.();
  };
}
