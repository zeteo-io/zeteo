import type { Source } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";
import env from "../../env.js";

export const findById = (id: string): Promise<Source | null> =>
  prisma.source.findUnique({ where: { id } });

export const findBySlug = (slug: string): Promise<Source | null> =>
  prisma.source.findUnique({ where: { slug } });

/** One page in creation order (`created_at`, then `id`), starting after `after`; `hasMore` says whether another page follows. */
export const listPage = async (options: {
  includeArchived: boolean;
  limit: number;
  after?: { createdAt: Date; id: string };
  type?: Source["type"];
  ownerId?: string;
}): Promise<{ rows: Source[]; hasMore: boolean }> => {
  const { includeArchived, limit, after, type, ownerId } = options;
  const rows = await prisma.source.findMany({
    where: {
      ...(includeArchived ? {} : { archivedAt: null }),
      ...(type !== undefined && { type }),
      ...(ownerId !== undefined && { ownerId }),
      ...(after && {
        OR: [
          { createdAt: { gt: after.createdAt } },
          { createdAt: after.createdAt, id: { gt: after.id } },
        ],
      }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

/**
 * Whether an upload source has Google Sheets tables (not ones their owner
 * removed): only such a source syncs.
 */
export const hasSheetsTables = async (sourceId: string): Promise<boolean> => {
  const found = await prisma.$queryRaw<unknown[]>`
    SELECT 1 FROM "zeteo"."source_tables"
    WHERE "source_id" = ${sourceId}::uuid
      AND "origin"->>'kind' = 'google-sheets'
      AND ("origin"->>'removed') IS DISTINCT FROM 'true'
    LIMIT 1`;
  return found.length > 0;
};

/**
 * Whether an upload source with Google Sheets tables is due a sync at `now`: it has an interval,
 * and no attempt (good or failed) within it. A failing source is so retried
 * once per interval.
 */
export const syncIsDue = (
  row: Pick<Source, "syncIntervalMinutes" | "lastSyncAttemptAt">,
  now: Date
): boolean =>
  row.syncIntervalMinutes !== null &&
  (row.lastSyncAttemptAt === null ||
    row.lastSyncAttemptAt.getTime() <
      now.getTime() - row.syncIntervalMinutes * 60_000);

/**
 * The unarchived sources due for the scheduled check, the longest-waiting
 * first: database sources never refreshed or last refreshed before
 * `olderThan`, then upload sources with Google Sheets tables whose sync interval has passed at
 * `now` (`syncIsDue`), while uploads are on (`UPLOADS_READER_URL`). File
 * upload sources never are: their uploads keep them.
 */
export const listDue = async (
  olderThan: Date,
  now: Date
): Promise<Source[]> => {
  const databases = await prisma.source.findMany({
    where: {
      archivedAt: null,
      type: { not: "upload" },
      OR: [{ lastRefreshedAt: null }, { lastRefreshedAt: { lt: olderThan } }],
    },
    orderBy: [
      { lastRefreshedAt: { sort: "asc", nulls: "first" } },
      { id: "asc" },
    ],
  });
  // Sheets tables are synced only while uploads are on.
  if (!env.UPLOADS_READER_URL) return databases;
  // The interval is per source, which Prisma's filters cannot compare with.
  // Timestamps are stored as UTC without a zone.
  const due = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "zeteo"."sources" s
    WHERE "type" = 'upload' AND "archived_at" IS NULL
      AND "sync_interval_minutes" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "zeteo"."source_tables" t
        WHERE t."source_id" = s."id" AND t."origin"->>'kind' = 'google-sheets'
          AND (t."origin"->>'removed') IS DISTINCT FROM 'true')
      AND ("last_sync_attempt_at" IS NULL
        OR "last_sync_attempt_at" < (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') - make_interval(mins => "sync_interval_minutes"))`;
  const sheets = await prisma.source.findMany({
    where: { id: { in: due.map((d) => d.id) } },
    orderBy: [
      { lastSyncAttemptAt: { sort: "asc", nulls: "first" } },
      { id: "asc" },
    ],
  });
  return [...databases, ...sheets];
};

/** The slugs of the unarchived sources among `ids`. */
export const listSlugs = async (ids: Iterable<string>): Promise<string[]> =>
  (
    await prisma.source.findMany({
      where: { id: { in: [...ids] }, archivedAt: null },
      select: { slug: true },
    })
  ).map((s) => s.slug);
