import { assertNoTransaction, getTereo } from "../utils/tereo.js";
import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { RequestError } from "@tereo-io/sdk/handler";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import env from "../env.js";

export const HIERARCHY_TTL_SECONDS = 30;

/** Test mode: a user's reports, a JSON list of user ids (absent: none). */
export const testReportsKey = (userId: string) =>
  `zeteo:test:reports:${userId}`;
/** Test mode: the users whose reports cannot be read (tereo unavailable). */
export const TEST_REPORTS_UNAVAILABLE_KEY = "zeteo:test:reports_unavailable";
/** Test mode: the users whose reports tereo refuses as too many. */
export const TEST_REPORTS_TOO_LARGE_KEY = "zeteo:test:reports_too_large";

/** Tereo could not say who is below a user: unreachable, erroring, or no such user. Fail closed. */
export class HierarchyUnavailableError extends Error {
  constructor(message = "The reporting lines are temporarily unavailable") {
    super(message);
    this.name = "HierarchyUnavailableError";
  }
}

/** Tereo refused the read as too large (over 10,000 users or 64 levels): it never returns a truncated list. */
export class HierarchyTooLargeError extends Error {
  constructor(message = "Too many users report to this user") {
    super(message);
    this.name = "HierarchyTooLargeError";
  }
}

const cache = new Map<string, { ids: string[]; expires: number }>();

/** Forgets every cached answer (tests). */
export const clearHierarchyCache = (): void => cache.clear();

/**
 * `usersBelow` against tereo itself, whatever the mode: the ids of every user
 * below `userId` in tereo's reporting lines, at any depth, deactivated users
 * included, as tereo returns them. Cached 30 s per user in this process; a
 * failure is never cached.
 */
export const usersBelowFromTereo = async (
  userId: string
): Promise<string[]> => {
  assertNoTransaction("tereo listUserReports()");
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.ids;
  let reports;
  try {
    reports = await getTereo().auth.listUserReports(userId, {
      transitive: true,
    });
  } catch (err) {
    if (err instanceof RequestError && err.httpStatus === 422) {
      throw new HierarchyTooLargeError();
    }
    logger.error({ err, user_id: userId }, "listing a user's reports failed");
    throw new HierarchyUnavailableError();
  }
  if (reports === null) {
    logger.error({ user_id: userId }, "tereo has no reporting lines for user");
    throw new HierarchyUnavailableError();
  }
  const ids = reports.map((r) => r.id);
  cache.set(userId, {
    ids,
    expires: Date.now() + HIERARCHY_TTL_SECONDS * 1000,
  });
  return ids;
};

/**
 * The test-mode answer, from Redis so every process sharing it agrees, and
 * never cached: a test changes a user's reports and the next read sees it.
 * An unreadable seam is unavailable, like tereo.
 */
const usersBelowInTestMode = async (userId: string): Promise<string[]> => {
  assertNoTransaction("tereo listUserReports()");
  let state: [number, number, string | null];
  try {
    state = await withinRedisTimeout(
      Promise.all([
        redis.sismember(TEST_REPORTS_UNAVAILABLE_KEY, userId),
        redis.sismember(TEST_REPORTS_TOO_LARGE_KEY, userId),
        redis.get(testReportsKey(userId)),
      ])
    );
  } catch (err) {
    logger.warn({ err }, "test-mode reporting lines unreadable");
    throw new HierarchyUnavailableError();
  }
  const [unavailable, tooLarge, raw] = state;
  if (unavailable === 1) throw new HierarchyUnavailableError();
  if (tooLarge === 1) throw new HierarchyTooLargeError();
  return raw === null ? [] : (JSON.parse(raw) as string[]);
};

/**
 * The ids of every user below `userId` in tereo's reporting lines, at any
 * depth, deactivated users included. Throws `HierarchyUnavailableError` or
 * `HierarchyTooLargeError`, never answers with a partial list. In test mode
 * the answer comes from Redis (`tests/support/hierarchy.ts`).
 */
export const usersBelow = (userId: string): Promise<string[]> =>
  env.TEREO_TEST_MODE
    ? usersBelowInTestMode(userId)
    : usersBelowFromTereo(userId);
