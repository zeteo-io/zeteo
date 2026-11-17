import { DATA_READ } from "../../definitions/tereoDeclaration.js";
import type { Caller } from "../../middleware/auth.js";
import { prisma } from "../../utils/db/prisma.js";
import { runQuery } from "../../engine/index.js";
import type { SeededSource } from "./queries.js";
import { uniqueName } from "./savedQueries.js";
import { redis } from "../../utils/redis.js";

/** A caller who may read data, as the engine sees them. */
export const readerOf = (userId: string): Caller => ({
  userId,
  organizationId: null,
  permissions: [DATA_READ],
  isServiceAccount: false,
});

/** A saved query over `orders` (or `from`) of the source and a dashboard, straight in the database. */
export const seedDashboardQuery = async (
  source: SeededSource,
  ownerId: string,
  select: string[] = ["id", "status"],
  from = "orders"
) => {
  const query = { source: source.slug, from, select };
  const saved = await prisma.savedQuery.create({
    data: { ownerId, sourceId: source.id, name: uniqueName(), query },
    select: { id: true },
  });
  const dashboard = await prisma.dashboard.create({
    data: { ownerId, name: uniqueName("dashboard") },
    select: { id: true },
  });
  return {
    savedQuery: { id: saved.id, sourceId: source.id },
    dashboardId: dashboard.id,
    query,
  };
};

export type SeededDashboardQuery = Awaited<
  ReturnType<typeof seedDashboardQuery>
>;

/** Runs the seeded saved query as a dashboard panel would, as `userId`. */
export const runOnDashboard = (
  userId: string,
  seeded: SeededDashboardQuery,
  body: unknown = seeded.query,
  signal?: AbortSignal
) =>
  runQuery({
    caller: readerOf(userId),
    entryPoint: "dashboard",
    body,
    signal,
    savedQuery: seeded.savedQuery,
    dashboard: { dashboardId: seeded.dashboardId, now: new Date() },
  });

/** Every dashboard cache entry and recording window in Redis, removed. */
export const clearDashboardKeys = async (): Promise<void> => {
  const keys = await redis.keys("zeteo:dash:*");
  if (keys.length > 0) await redis.del(...keys);
};

/**
 * Moves Redis's clock for this user's recording windows `ms` forward, as a
 * fake clock moves the process's: each window's time to live shortened by
 * `ms`, and a window that would have run out removed.
 */
export const ageRecordWindows = async (
  userId: string,
  ms: number
): Promise<void> => {
  const keys = await redis.keys(`zeteo:dash:rec:${userId}:*`);
  for (const key of keys) {
    const left = await redis.pttl(key);
    if (left <= ms) await redis.del(key);
    else await redis.pexpire(key, left - ms);
  }
};

/** The dashboards created for these owners, removed (their runs keep no link). */
export const removeDashboardsOf = (ownerIds: string[]) =>
  prisma.dashboard.deleteMany({ where: { ownerId: { in: ownerIds } } });

/** A run's `zeteo.query.run` audit metadata. */
export const auditMetadataOf = async (
  runId: string
): Promise<Record<string, unknown>> => {
  const rows = await prisma.$queryRaw<{ metadata: Record<string, unknown> }[]>`
    SELECT payload->'metadata' AS metadata FROM "core"."core_outbox"
    WHERE payload->>'entityId' = ${runId}`;
  if (rows.length !== 1) throw new Error(`${rows.length} audit entries`);
  return rows[0]!.metadata;
};
