import { redis } from "../../utils/redis.js";
import {
  TEST_REPORTS_TOO_LARGE_KEY,
  TEST_REPORTS_UNAVAILABLE_KEY,
  testReportsKey,
} from "../../grants/hierarchy.js";

// The test-mode reporting lines `usersBelow` reads, for every process sharing
// this Redis. Test mode never caches them, so a change applies at once.

/** Makes `reportIds` everyone below `userId`, at any depth. */
export const setTestReports = async (userId: string, reportIds: string[]) => {
  await redis.set(testReportsKey(userId), JSON.stringify(reportIds), "EX", 600);
};

/** Makes reading `userId`'s reports fail as tereo being unavailable, or too large. */
export const failTestReports = async (
  userId: string,
  kind: "unavailable" | "too_large"
) => {
  await redis.sadd(
    kind === "unavailable"
      ? TEST_REPORTS_UNAVAILABLE_KEY
      : TEST_REPORTS_TOO_LARGE_KEY,
    userId
  );
};

/** Forgets the user's reports and failures: no one below them again. */
export const clearTestReports = async (userId: string) => {
  await Promise.all([
    redis.del(testReportsKey(userId)),
    redis.srem(TEST_REPORTS_UNAVAILABLE_KEY, userId),
    redis.srem(TEST_REPORTS_TOO_LARGE_KEY, userId),
  ]);
};
