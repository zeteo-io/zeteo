import { TooManyRequestsError } from "../utils/errors.js";
import { performance } from "node:perf_hooks";

/** The first wait for a lease, doubled after each refusal. */
const FIRST_WAIT_MS = 100;
/** The longest single wait for a lease. */
const MAX_WAIT_MS = 2000;

/** A refusal that a later attempt may not meet: a slot of the user's or the source's is taken. */
const isBusy = (err: unknown): boolean =>
  err instanceof TooManyRequestsError &&
  (err.code === "too_many_queries" || err.code === "source_busy");

/** Waits `ms`, or rejects with the signal's reason when it aborts. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * A dashboard run's leases: `acquire` retried while the viewer's own limit
 * (their other tabs or screens) or the source's refuses it, waiting 100 ms,
 * then twice as long each time up to 2 s, until `deadlineAt` (on
 * `performance.now()`'s clock); then that refusal is thrown. Any other
 * failure is thrown at once.
 */
export const waitForLeases = async <T>(
  acquire: () => Promise<T>,
  deadlineAt: number,
  signal?: AbortSignal
): Promise<T> => {
  let wait = FIRST_WAIT_MS;
  for (;;) {
    try {
      return await acquire();
    } catch (err) {
      if (!isBusy(err)) throw err;
      const left = deadlineAt - performance.now();
      if (left <= 0) throw err;
      await pause(Math.min(wait, left), signal);
      wait = Math.min(wait * 2, MAX_WAIT_MS);
    }
  }
};

/** `promise`, or the signal's reason once it aborts, whichever comes first. */
const unlessAborted = <T>(promise: Promise<T>, signal?: AbortSignal) => {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
};

interface InFlight {
  promise: Promise<unknown>;
  /** The signal of the run that executes it. */
  signal?: AbortSignal;
}

/** The dashboard runs executing in this process, by fingerprint. */
const inFlight = new Map<string, InFlight>();

/**
 * Identical dashboard runs in this process share one execution: the first
 * runs `execute`, and every run with the same key while it runs waits for
 * its result instead, taking no lease of its own. A run that waits stops
 * waiting when its own signal aborts; when the executing run's caller goes
 * away instead, the next waiting run executes its own.
 */
export const coalesce = async <T>(
  key: string,
  signal: AbortSignal | undefined,
  execute: () => Promise<T>
): Promise<T> => {
  for (;;) {
    signal?.throwIfAborted();
    const running = inFlight.get(key);
    if (!running) {
      const own: InFlight = { promise: execute(), signal };
      inFlight.set(key, own);
      try {
        return (await own.promise) as T;
      } finally {
        if (inFlight.get(key) === own) inFlight.delete(key);
      }
    }
    try {
      return (await unlessAborted(running.promise, signal)) as T;
    } catch (err) {
      const leaderLeft =
        running.signal?.aborted === true && err === running.signal.reason;
      if (leaderLeft && signal?.aborted !== true) {
        if (inFlight.get(key) === running) inFlight.delete(key);
        continue;
      }
      throw err;
    }
  }
};
