// Test only: the deferred work of a test's deps, shared by both harnesses. Work a route
// hands to `deps.defer` goes on after the answer; a test must not end while it still
// runs, or it would touch the next test's database. So each harness tracks the work, lets
// a test wait for it (`settle`), and checks at the end of every test that none is left.
import { onTestFinished } from "vitest";
import { DEFER_FAILED, deferTracker } from "../src/ports.ts";

export type Background = {
  /** What the deps get as `defer`. */
  defer(work: Promise<unknown>): void;
  /** Resolves when all work taken so far, and what it took in turn, has ended. Never rejects. */
  settle(): Promise<void>;
  /** How many pieces of work are still running. */
  open(): number;
};

/** How long the end of a test waits for deferred work before it fails the test. */
export const LEFT_OPEN_WAIT_MS = 2000;

/** A tracker of deferred work. A failure of that work is the fixed line, as on a real target. */
export function background(): Background {
  const tracker = deferTracker(() => console.error(DEFER_FAILED));
  let open = 0;
  return {
    defer(work) {
      open += 1;
      const counted = Promise.resolve(work).finally(() => {
        open -= 1;
      });
      // The tracker handles the failure; this copy only counts.
      counted.catch(() => {});
      tracker.defer(counted);
    },
    settle: () => tracker.settle(),
    open: () => open,
  };
}

/**
 * The check at the end of a test: waits up to `waitMs` for deferred work to end, and
 * throws when some is still running then. A test whose work can never end (a mailer that
 * never answers) must let it end before the test does.
 */
export async function endOfTest(tracker: Background, waitMs: number = LEFT_OPEN_WAIT_MS): Promise<void> {
  if (tracker.open() === 0) return;
  let stopWaiting = (): void => {};
  const waited = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    stopWaiting = () => clearTimeout(timer);
  });
  await Promise.race([tracker.settle(), waited]);
  stopWaiting();
  if (tracker.open() > 0) throw new Error(`a test ended with ${tracker.open()} piece(s) of deferred work still running: await settle(), or let the work end, before the test does`);
}

/**
 * Runs the end-of-test check for this tracker when the running test finishes. Deps made
 * outside a test (in a beforeAll) have no test to hang the check on; they go unchecked.
 */
export function checkAtEndOfTest(tracker: Background): void {
  try {
    onTestFinished(() => endOfTest(tracker));
  } catch {
    // Not inside a test.
  }
}
