import { isSheetsSource, isUploadSource } from "../sources/types.js";
import { SYSTEM_USER_ID } from "../definitions/systemUser.js";
import { refreshSource } from "../catalog/refresh.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import { db } from "../utils/db/index.js";
import { randomUUID } from "crypto";
import env from "../env.js";

export const REFRESH_CHECK_INTERVAL_MS = 5 * 60_000;
export const REFRESH_AFTER_MS = 24 * 60 * 60_000;
export const REFRESH_LOCK_SECONDS = 15 * 60;
/** The first sweep comes this long after start, plus up to `FIRST_SWEEP_JITTER_MS`, so replicas started together spread out. */
export const FIRST_SWEEP_DELAY_MS = 30_000;
export const FIRST_SWEEP_JITTER_MS = 30_000;
const STOP_WAIT_MS = 10_000;

const lockKey = (sourceId: string) => `zeteo:refresh:${sourceId}`;

// Deletes the lock only while it is still this holder's.
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;

/**
 * Refreshes each unarchived database source not refreshed in the last 24
 * hours, and syncs each Google Sheets source whose sync interval has passed
 * (while uploads are on), one at a time; a file upload source never. A source
 * another replica holds the lock for is skipped, and so is one that, read
 * again under the lock, is no longer due or has been archived since the list
 * was read. A failing one is logged (a failed sync is also recorded on the
 * source) without stopping the rest.
 */
export const refreshStaleSources = async (
  now: Date = new Date(),
  shouldStop: () => boolean = () => false
): Promise<void> => {
  const cutoff = new Date(now.getTime() - REFRESH_AFTER_MS);
  const due = await db.sources.listDue(cutoff, now);
  for (const source of due) {
    if (shouldStop()) return;
    const token = randomUUID();
    try {
      const got = await redis.set(
        lockKey(source.id),
        token,
        "EX",
        REFRESH_LOCK_SECONDS,
        "NX"
      );
      if (got !== "OK") continue;
      try {
        const current = await db.sources.findById(source.id);
        const stillDue =
          current !== null &&
          current.archivedAt === null &&
          (isSheetsSource(current)
            ? Boolean(env.UPLOADS_READER_URL) &&
              db.sources.syncIsDue(current, now)
            : !isUploadSource(current) &&
              (current.lastRefreshedAt === null ||
                current.lastRefreshedAt < cutoff));
        if (stillDue) await refreshSource(source.id, SYSTEM_USER_ID);
      } finally {
        await redis.eval(RELEASE, 1, lockKey(source.id), token);
      }
    } catch (err) {
      // A sync's own failures (a sheet no longer shared...) are expected and
      // already logged and recorded on the source.
      if (isSheetsSource(source) && err instanceof AppError) continue;
      logger.error({ err, source_id: source.id }, "scheduled refresh failed");
    }
  }
};

/**
 * Starts the check: a first sweep shortly after start, then one every five
 * minutes (a Sheets source syncs every 15 minutes at the most often).
 * The returned function stops it and waits briefly for a sweep in progress.
 */
export const startRefreshJob = (): (() => Promise<void>) => {
  let stopped = false;
  let sweeping: Promise<void> | null = null;
  const sweep = () => {
    if (sweeping || stopped) return;
    sweeping = refreshStaleSources(new Date(), () => stopped)
      .catch((err: unknown) => {
        logger.error({ err }, "scheduled refresh sweep failed");
      })
      .finally(() => {
        sweeping = null;
      });
  };
  const first = setTimeout(
    sweep,
    FIRST_SWEEP_DELAY_MS + Math.floor(Math.random() * FIRST_SWEEP_JITTER_MS)
  );
  const timer = setInterval(sweep, REFRESH_CHECK_INTERVAL_MS);
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
