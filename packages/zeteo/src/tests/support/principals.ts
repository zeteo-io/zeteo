import type { GroupRef } from "../../grants/principals.js";
import { redis } from "../../utils/redis.js";
import {
  TEST_DIRECTORY_KEY,
  type Principal,
} from "../../principals/directory.js";
import {
  TEST_ORPHANED_KEY,
  groupsKey,
  testGroupsKey,
} from "../../grants/principals.js";

/** Makes `userId` a member of `groups` for every process sharing this Redis (test mode only). */
export const setTestGroups = async (userId: string, groups: GroupRef[]) => {
  await redis.set(testGroupsKey(userId), JSON.stringify(groups), "EX", 600);
};

export const clearTestGroups = async (userId: string) => {
  await redis.del(testGroupsKey(userId), groupsKey(userId));
};

/** Makes `principalStatus` answer `orphaned` for the id. */
export const markOrphaned = async (id: string) => {
  await redis.sadd(TEST_ORPHANED_KEY, id);
};

export const clearOrphaned = async (id: string) => {
  await redis.srem(TEST_ORPHANED_KEY, id);
};

/** Replaces the test-mode directory `searchPrincipals` and `lookupPrincipals` read, for every process sharing this Redis. */
export const seedDirectory = async (principals: Principal[]) => {
  await redis.del(TEST_DIRECTORY_KEY);
  if (principals.length === 0) return;
  await redis.hset(
    TEST_DIRECTORY_KEY,
    Object.fromEntries(
      principals.map((p) => [`${p.type}:${p.id}`, JSON.stringify(p)])
    )
  );
  await redis.expire(TEST_DIRECTORY_KEY, 600);
};

export const clearDirectory = async () => {
  await redis.del(TEST_DIRECTORY_KEY);
};
