import { assertNoTransaction, getTereo } from "../utils/tereo.js";
import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { TEST_ORPHANED_KEY } from "../grants/principals.js";
import { TereoUnreachableError } from "../utils/errors.js";
import { mapConcurrently } from "../utils/concurrency.js";
import type { AuthServiceUser } from "@tereo-io/sdk";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import env from "../env.js";
import {
  purgeServiceToken,
  getHandler,
  requests,
  RequestError,
  CORE_CLIENT,
} from "@tereo-io/sdk/handler";

export type PrincipalType = "user" | "group";

export interface Principal {
  type: PrincipalType;
  id: string;
  name: string | null;
  /** Users only; a group has no `email` key. */
  email?: string | null;
  status: "active" | "inactive" | "orphaned";
}

export interface PrincipalRef {
  type: PrincipalType;
  id: string;
}

/** Test mode's directory: a Redis hash of `${type}:${id}` to a JSON `Principal`. */
export const TEST_DIRECTORY_KEY = "zeteo:test:directory";

/** Tereo's most ids in one `getUsersByIds` request. */
export const MAX_USER_IDS_PER_REQUEST = 100;

/**
 * How long one search or lookup may wait on tereo, retries included. The SDK
 * sets no timeout and the handler retries timeouts and 5xx with back-off, so
 * without this a silent tereo could hold a request for minutes.
 */
export const DIRECTORY_BUDGET_MS = 5000;

/** How many groups one lookup reads from tereo at once; each is its own request, and a 429 would pause every call zeteo makes to tereo. */
export const GROUP_READS_IN_FLIGHT = 8;

export const GROUP_CACHE_TTL_SECONDS = 60;
export const groupCacheKey = (id: string) => `zeteo:directory:group:${id}`;

class DirectoryDeadlineError extends Error {
  constructor() {
    super(`tereo did not answer within ${DIRECTORY_BUDGET_MS} ms`);
    this.name = "DirectoryDeadlineError";
  }
}

/**
 * `run`, or a `DirectoryDeadlineError` once it has taken the budget. The
 * signal aborts when the call ends either way, cancelling the requests that
 * were given it and any still running beside a failed one.
 */
const withinBudget = async <T>(
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DirectoryDeadlineError()),
      DIRECTORY_BUDGET_MS
    );
  });
  const work = run(controller.signal);
  // Settling after the deadline, it must not be an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size)
  );

const refKey = (ref: PrincipalRef) => `${ref.type}:${ref.id}`;

const orphaned = (ref: PrincipalRef): Principal =>
  ref.type === "user"
    ? { type: "user", id: ref.id, name: null, email: null, status: "orphaned" }
    : { type: "group", id: ref.id, name: null, status: "orphaned" };

const fromUser = (u: AuthServiceUser): Principal => ({
  type: "user",
  id: u.id,
  name: u.name,
  email: u.email,
  status: u.status === "active" ? "active" : "inactive",
});

const fromGroup = (g: {
  id: string;
  name: string;
  archivedAt: string | null;
}): Principal => ({
  type: "group",
  id: g.id,
  name: g.name,
  status: g.archivedAt === null ? "active" : "inactive",
});

/** The HTTP status of a failed request to tereo, when it answered: the SDK's `RequestError`, or the raw handler's axios error. */
const statusOf = (err: unknown): number | undefined => {
  if (err instanceof RequestError) return err.httpStatus;
  const e = err as { isAxiosError?: unknown; response?: { status?: unknown } };
  // Not `instanceof AxiosError`: @dianemo/core's axios may be another copy.
  return e?.isAxiosError === true && typeof e.response?.status === "number"
    ? e.response.status
    : undefined;
};

/**
 * Logs a failed call and returns the error to throw. The logged error is a new
 * one: the raw handler's axios error carries the request's params, the search
 * text among them, and nothing of that may reach the log.
 */
const unreachable = (
  call: string,
  err: unknown,
  counts: Record<string, number>
): TereoUnreachableError => {
  const status = statusOf(err);
  const outcome =
    err instanceof DirectoryDeadlineError
      ? `did not finish within ${DIRECTORY_BUDGET_MS} ms`
      : `failed${status === undefined ? "" : ` with HTTP ${status}`}`;
  logger.error(
    {
      err: new Error(`${call} ${outcome}`),
      ...counts,
    },
    "asking tereo for users or groups failed"
  );
  return new TereoUnreachableError();
};

interface PaginatedUsers {
  data: AuthServiceUser[];
}

/** One `GET /v1/admin/users` through the raw handler, as the SDK's requests do on a 401: a new service token, once. */
const getUsers = async (
  params: Record<string, string | number>,
  signal: AbortSignal
): Promise<AuthServiceUser[]> => {
  const send = () =>
    getHandler().handleRequest<PaginatedUsers>({
      clientName: CORE_CLIENT,
      requestName: "zeteo.directory.searchUsers",
      method: "GET",
      url: "/v1/admin/users",
      params,
      signal,
    });
  try {
    return (await send()).data.data;
  } catch (err) {
    if (statusOf(err) !== 401) throw err;
    logger.warn("tereo rejected the service token; retrying once");
    await purgeServiceToken();
    return (await send()).data.data;
  }
};

/** Users whose name or email contains `q`: two requests, as tereo's filters are ANDed. Human users only. */
const searchUsers = async (
  q: string,
  limit: number,
  signal: AbortSignal
): Promise<Principal[]> => {
  const base = { "filter[userType]": "human", limit };
  const [byName, byEmail] = await Promise.all([
    getUsers(
      { ...base, "filter[name]": q, "filter[name_op]": "contains" },
      signal
    ),
    getUsers(
      { ...base, "filter[email]": q, "filter[email_op]": "contains" },
      signal
    ),
  ]);
  const seen = new Map<string, AuthServiceUser>();
  for (const u of [...byName, ...byEmail])
    if (!seen.has(u.id)) seen.set(u.id, u);
  return [...seen.values()].slice(0, limit).map(fromUser);
};

const searchGroups = async (q: string, limit: number): Promise<Principal[]> => {
  const page = await requests.auth.listGroups({ q, limit });
  return page.data.slice(0, limit).map(fromGroup);
};

/** `searchPrincipals` against tereo itself. */
export const searchFromTereo = async (
  type: PrincipalType,
  q: string,
  limit: number
): Promise<Principal[]> => {
  assertNoTransaction(`tereo search ${type}s`);
  try {
    return await withinBudget((signal) =>
      type === "user" ? searchUsers(q, limit, signal) : searchGroups(q, limit)
    );
  } catch (err) {
    throw unreachable(`searching ${type}s`, err, { limit });
  }
};

/*
 * Groups' resolved principals are cached, found or orphaned, never a failed
 * read. Users are not: their names and emails are personal data, kept out of
 * Redis. A cache that fails or is slow is passed over.
 */
const readGroupCache = async (
  ids: string[]
): Promise<Map<string, Principal>> => {
  const cached = new Map<string, Principal>();
  if (ids.length === 0) return cached;
  try {
    const values = await withinRedisTimeout(
      redis.mget(...ids.map(groupCacheKey))
    );
    ids.forEach((id, i) => {
      const value = values[i];
      if (value) cached.set(id, JSON.parse(value) as Principal);
    });
  } catch (err) {
    logger.warn({ err }, "directory group cache unreadable; asking tereo");
    cached.clear();
  }
  return cached;
};

const writeGroupCache = async (groups: Principal[]): Promise<void> => {
  const results = await Promise.allSettled(
    groups.map((g) =>
      withinRedisTimeout(
        redis.set(
          groupCacheKey(g.id),
          JSON.stringify(g),
          "EX",
          GROUP_CACHE_TTL_SECONDS
        )
      )
    )
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    logger.warn(
      { err: failed[0]!.reason, failed: failed.length },
      "directory group cache not written"
    );
  }
};

/** `lookupPrincipals` against tereo itself. */
export const lookupFromTereo = async (
  refs: PrincipalRef[]
): Promise<Principal[]> => {
  const distinct = [...new Map(refs.map((r) => [refKey(r), r])).values()];
  // An id that is no UUID cannot be anyone's: tereo would answer 400, not 404.
  const askable = distinct.filter((r) => UUID.test(r.id));
  const userIds = askable.filter((r) => r.type === "user").map((r) => r.id);
  const groupIds = askable.filter((r) => r.type === "group").map((r) => r.id);
  const found = new Map<string, Principal>();
  const readGroups: Principal[] = [];
  assertNoTransaction("tereo lookupPrincipals()");
  try {
    await withinBudget(async (signal) => {
      const cached = await readGroupCache(groupIds);
      for (const [id, p] of cached) found.set(`group:${id}`, p);
      const unread = groupIds.filter((id) => !cached.has(id));
      await Promise.all([
        ...chunks(userIds, MAX_USER_IDS_PER_REQUEST).map(async (ids) => {
          for (const u of await requests.auth.getUsersByIds(ids)) {
            // A malformed element would be filed under the wrong id and read as an orphan.
            if (typeof u?.id !== "string" || typeof u.status !== "string") {
              throw new Error("tereo returned a malformed user");
            }
            found.set(`user:${u.id}`, fromUser(u));
          }
        }),
        mapConcurrently(
          unread,
          GROUP_READS_IN_FLIGHT,
          async (id) => {
            const group = await getTereo().auth.getGroup(id);
            readGroups.push(
              group ? fromGroup(group) : orphaned({ type: "group", id })
            );
          },
          signal
        ),
      ]);
    });
  } catch (err) {
    throw unreachable("looking up principals", err, { refs: distinct.length });
  }
  for (const p of readGroups) found.set(`group:${p.id}`, p);
  // Not awaited: the answer does not wait on the cache, and the write never rejects.
  void writeGroupCache(readGroups);
  return distinct.map((r) => found.get(refKey(r)) ?? orphaned(r));
};

/** A test-mode seam's Redis read; one that fails or does not answer in time is `tereo_unreachable`. */
const readSeam = async <T>(command: Promise<T>, refs: number): Promise<T> => {
  try {
    return await withinRedisTimeout(command);
  } catch (err) {
    throw unreachable("reading the test directory", err, { refs });
  }
};

const seeded = async (): Promise<Principal[]> =>
  Object.values(await readSeam(redis.hgetall(TEST_DIRECTORY_KEY), 0)).map(
    (json) => JSON.parse(json) as Principal
  );

const searchSeam = async (
  type: PrincipalType,
  q: string,
  limit: number
): Promise<Principal[]> => {
  const needle = q.toLowerCase();
  return (await seeded())
    .filter(
      (p) =>
        p.type === type &&
        p.status !== "orphaned" &&
        [p.name, p.email].some((v) => v?.toLowerCase().includes(needle))
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit);
};

const lookupSeam = async (refs: PrincipalRef[]): Promise<Principal[]> => {
  const distinct = [...new Map(refs.map((r) => [refKey(r), r])).values()];
  if (distinct.length === 0) return [];
  const [values, marks] = await Promise.all([
    readSeam(
      redis.hmget(TEST_DIRECTORY_KEY, ...distinct.map(refKey)),
      refs.length
    ),
    readSeam(
      Promise.all(
        distinct.map((r) => redis.sismember(TEST_ORPHANED_KEY, r.id))
      ),
      refs.length
    ),
  ]);
  return distinct.map((r, i) =>
    marks[i] === 1 || values[i] === null
      ? orphaned(r)
      : (JSON.parse(values[i]) as Principal)
  );
};

/**
 * Users or groups whose name (or a user's email) contains `q`, at most
 * `limit`. A user search leaves out service accounts, an unreachable tereo
 * is a `TereoUnreachableError`.
 */
export const searchPrincipals = (
  type: PrincipalType,
  q: string,
  limit: number
): Promise<Principal[]> =>
  env.TEREO_TEST_MODE
    ? searchSeam(type, q, limit)
    : searchFromTereo(type, q, limit);

/**
 * One principal per ref, in the refs' order, a repeated ref collapsed to its
 * first. A user or group tereo does not have is `orphaned`, with no name. Any
 * other failure is a `TereoUnreachableError`, never `orphaned`. At most 100 refs.
 */
export const lookupPrincipals = (refs: PrincipalRef[]): Promise<Principal[]> =>
  env.TEREO_TEST_MODE ? lookupSeam(refs) : lookupFromTereo(refs);
