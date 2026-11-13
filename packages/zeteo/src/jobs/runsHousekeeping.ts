import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { recordInterruptedExport } from "../engine/record.js";
import { EXPORT_TIMEOUT_MS } from "../engine/limits.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import { db } from "../utils/db/index.js";
import { randomUUID } from "crypto";
import env from "../env.js";

/** An export still running this long after it started has lost its process: its limit, plus a margin for its end to be recorded. */
export const INTERRUPTED_AFTER_MS = EXPORT_TIMEOUT_MS + 5 * 60_000;
export const HOUSEKEEPING_INTERVAL_MS = 60 * 60_000;
export const HOUSEKEEPING_LOCK_SECONDS = 10 * 60;
/** The first sweep comes this long after start, plus up to `FIRST_SWEEP_JITTER_MS`, so replicas started together spread out. */
export const FIRST_SWEEP_DELAY_MS = 60_000;
export const FIRST_SWEEP_JITTER_MS = 60_000;
const BATCH_SIZE = 1000;
const STOP_WAIT_MS = 10_000;
const DAY_MS = 24 * 60 * 60_000;

const LOCK_KEY = "zeteo:job:runs-housekeeping";

// Deletes the lock only while it is still this holder's.
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;

/**
 * Marks exports still `running` after `INTERRUPTED_AFTER_MS` as failed with
 * `interrupted`, each with its `zeteo.export.run` entry. One that fails to
 * close is logged and the rest go on. Returns how many it closed.
 */
export const closeInterruptedExports = async (
  now: Date = new Date()
): Promise<number> => {
  const cutoff = new Date(now.getTime() - INTERRUPTED_AFTER_MS);
  let closed = 0;
  let after: string | undefined;
  for (;;) {
    const rows = await db.queryRuns.listRunningExportsBefore(
      cutoff,
      after,
      BATCH_SIZE
    );
    for (const row of rows) {
      try {
        // `sourceId` is never null here: the list asks for exports with one.
        const done = await recordInterruptedExport(
          { ...row, sourceId: row.sourceId as string },
          now
        );
        if (done) closed += 1;
      } catch (err) {
        logger.error(
          { err, run_id: row.id },
          "closing an interrupted export failed"
        );
      }
    }
    if (rows.length < BATCH_SIZE) return closed;
    after = rows[rows.length - 1]!.id;
  }
};

/**
 * Deletes runs older than `days`, 1,000 at a time, never one still `running`.
 * 0 deletes nothing. Writes no audit entries: Tereo's audit log is the
 * lasting record. Returns how many it deleted.
 */
export const deleteOldRuns = async (
  days: number,
  now: Date = new Date()
): Promise<number> => {
  if (days <= 0) return 0;
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  let deleted = 0;
  for (;;) {
    const count = await db.queryRuns.deleteFinishedBefore(cutoff, BATCH_SIZE);
    deleted += count;
    if (count === 0) return deleted;
  }
};

/** One tick: both steps, under the lock. A Redis failure skips the tick. */
export const runHousekeeping = async (
  now: Date = new Date(),
  shouldStop: () => boolean = () => false
): Promise<void> => {
  const token = randomUUID();
  try {
    const got = await withinRedisTimeout(
      redis.set(LOCK_KEY, token, "EX", HOUSEKEEPING_LOCK_SECONDS, "NX")
    );
    if (got !== "OK") return;
  } catch (err) {
    logger.warn({ err }, "runs housekeeping skipped: the lock was unavailable");
    return;
  }
  try {
    const closed = await closeInterruptedExports(now);
    if (closed > 0) logger.info({ closed }, "closed interrupted exports");
    if (shouldStop()) return;
    const deleted = await deleteOldRuns(env.QUERY_RUNS_RETENTION_DAYS, now);
    if (deleted > 0) logger.info({ deleted }, "deleted old query runs");
  } catch (err) {
    logger.error({ err }, "runs housekeeping failed");
  } finally {
    try {
      await withinRedisTimeout(redis.eval(RELEASE, 1, LOCK_KEY, token));
    } catch (err) {
      // The lock expires by itself.
      logger.warn({ err }, "runs housekeeping lock not released");
    }
  }
};

/**
 * Starts the job: a first sweep 60 to 120 seconds after start, then one every
 * hour. The returned function stops it and waits briefly for a sweep in
 * progress.
 */
export const startRunsHousekeepingJob = (): (() => Promise<void>) => {
  let stopped = false;
  let sweeping: Promise<void> | null = null;
  const sweep = () => {
    if (sweeping || stopped) return;
    sweeping = runHousekeeping(new Date(), () => stopped)
      .catch((err: unknown) => {
        logger.error({ err }, "runs housekeeping sweep failed");
      })
      .finally(() => {
        sweeping = null;
      });
  };
  const first = setTimeout(
    sweep,
    FIRST_SWEEP_DELAY_MS + Math.floor(Math.random() * FIRST_SWEEP_JITTER_MS)
  );
  const timer = setInterval(sweep, HOUSEKEEPING_INTERVAL_MS);
  // The job must not keep the process alive.
  first.unref();
  timer.unref();
  return async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    if (!sweeping) return;
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([
      sweeping,
      new Promise<void>((resolve) => {
        wait = setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(wait);
  };
};
