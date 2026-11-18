import type { Source } from "../../prisma/generated/client/index.js";
import { sourceView, type SourceView } from "../views/source.js";
import { sourceStoredBytes } from "../uploads/storage.js";
import { isFileUpload, isUploadSource } from "./types.js";
import { NotFoundError } from "../utils/errors.js";
import { prisma } from "../utils/db/prisma.js";

/**
 * Per source, how many people and groups its tables are shared with: the
 * distinct principals of its grants, an upload source's owner grants left out.
 */
const shareCounts = async (ids: string[]): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map();
  const grants = await prisma.grant.findMany({
    where: { table: { sourceId: { in: ids } }, ownerGrant: false },
    select: {
      principalType: true,
      principalId: true,
      table: { select: { sourceId: true } },
    },
  });
  const principals = new Map<string, Set<string>>();
  for (const g of grants) {
    const set = principals.get(g.table.sourceId) ?? new Set<string>();
    set.add(`${g.principalType}:${g.principalId}`);
    principals.set(g.table.sourceId, set);
  }
  return new Map([...principals].map(([id, set]) => [id, set.size]));
};

/** Per upload source, when a table of it was last loaded. */
const lastLoads = async (ids: string[]): Promise<Map<string, Date>> => {
  if (ids.length === 0) return new Map();
  const loads = await prisma.sourceTable.groupBy({
    by: ["sourceId"],
    where: {
      sourceId: { in: ids },
      missingSince: null,
      lastSyncedAt: { not: null },
    },
    _max: { lastSyncedAt: true },
  });
  return new Map(
    loads
      .filter((l) => l._max.lastSyncedAt !== null)
      .map((l) => [l.sourceId, l._max.lastSyncedAt!])
  );
};

/**
 * The views of `rows`, with what a view needs besides the row: each one's
 * share count and, for a live upload source, the bytes it stores now and its
 * last load (shown as its last refresh).
 */
export const presentSources = async (rows: Source[]): Promise<SourceView[]> => {
  const ids = rows.map((r) => r.id);
  const stored = rows
    .filter((r) => isUploadSource(r) && !r.archivedAt)
    .map((r) => r.id);
  const uploads = rows.filter(isFileUpload).map((r) => r.id);
  const [shares, bytes, loads] = await Promise.all([
    shareCounts(ids),
    sourceStoredBytes(stored),
    lastLoads(uploads),
  ]);
  return rows.map((r) =>
    sourceView(r, {
      shareCount: shares.get(r.id) ?? 0,
      storedBytes: bytes.get(r.id) ?? 0,
      ...(isFileUpload(r) && { lastLoadedAt: loads.get(r.id) ?? null }),
    })
  );
};

/** The view of one source row. */
export const presentSource = async (row: Source): Promise<SourceView> =>
  (await presentSources([row]))[0]!;

/** The view of the source of `id` as it is now; 404 when there is none. */
export const presentSourceById = async (id: string): Promise<SourceView> => {
  const row = await prisma.source.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Source not found");
  return presentSource(row);
};
