import type { Source } from "../../prisma/generated/client/index.js";
import { sourceStoredBytes } from "../uploads/storage.js";
import { NotFoundError } from "../utils/errors.js";
import { originOf } from "../uploads/origin.js";
import { prisma } from "../utils/db/prisma.js";
import { isUploadSource } from "./types.js";
import {
  sourceView,
  STALE_AFTER_MS,
  tableSyncError,
  type SheetsSyncState,
  type SourceView,
} from "../views/source.js";

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

/** An upload source's Google Sheets state: its sync state and its live tables' oldest good sync. */
interface SheetsState {
  sync: SheetsSyncState;
  /** Null when it has no live Sheets table, or one never synced. */
  oldestSyncAt: Date | null;
  hasLive: boolean;
}

/**
 * Per upload source with Google Sheets tables (those their owner removed left
 * out), the sync state of its live ones: those failing, whether it is stale
 * (a failing table with no good sync for `STALE_AFTER_MS`), and the oldest
 * good sync among them.
 */
const sheetsStates = async (
  ids: string[],
  now: Date
): Promise<Map<string, SheetsState>> => {
  if (ids.length === 0) return new Map();
  const tables = await prisma.sourceTable.findMany({
    where: {
      sourceId: { in: ids },
      origin: { path: ["kind"], equals: "google-sheets" },
    },
    select: {
      id: true,
      sourceId: true,
      name: true,
      origin: true,
      missingSince: true,
      lastSyncedAt: true,
      lastSyncError: true,
    },
    orderBy: { name: "asc" },
  });
  const found = new Map<string, SheetsState>();
  for (const t of tables) {
    const origin = originOf(t);
    if (origin?.kind !== "google-sheets" || origin.removed === true) continue;
    const state = found.get(t.sourceId) ?? {
      sync: { failing: [], stale: false },
      oldestSyncAt: null,
      hasLive: false,
    };
    found.set(t.sourceId, state);
    if (t.missingSince !== null) continue;
    const synced = t.lastSyncedAt;
    // The oldest wins; a table never synced makes it null.
    if (!state.hasLive) state.oldestSyncAt = synced;
    else if (synced === null || state.oldestSyncAt === null) {
      state.oldestSyncAt = null;
    } else if (synced < state.oldestSyncAt) state.oldestSyncAt = synced;
    state.hasLive = true;
    const error = tableSyncError(t.lastSyncError);
    if (!error) continue;
    state.sync.failing.push({ table_id: t.id, name: t.name, ...error });
    if (synced === null || now.getTime() - synced.getTime() > STALE_AFTER_MS) {
      state.sync.stale = true;
    }
  }
  return found;
};

/**
 * The views of `rows`, with what a view needs besides the row: each one's
 * share count and, for a live upload source, the bytes it stores now, its
 * last load or oldest good Sheets sync (shown as its last refresh) and the
 * sync state of its Google Sheets tables.
 */
export const presentSources = async (
  rows: Source[],
  now: Date = new Date()
): Promise<SourceView[]> => {
  const ids = rows.map((r) => r.id);
  const stored = rows
    .filter((r) => isUploadSource(r) && !r.archivedAt)
    .map((r) => r.id);
  const uploads = rows.filter(isUploadSource).map((r) => r.id);
  const [shares, bytes, loads, sheets] = await Promise.all([
    shareCounts(ids),
    sourceStoredBytes(stored),
    lastLoads(uploads),
    sheetsStates(uploads, now),
  ]);
  return rows.map((r) => {
    const state = sheets.get(r.id);
    return sourceView(r, {
      shareCount: shares.get(r.id) ?? 0,
      storedBytes: bytes.get(r.id) ?? 0,
      ...(isUploadSource(r) && {
        lastLoadedAt: state?.hasLive
          ? state.oldestSyncAt
          : (loads.get(r.id) ?? null),
        sheetsSync: state?.sync ?? null,
      }),
    });
  });
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
