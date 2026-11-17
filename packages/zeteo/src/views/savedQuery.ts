import type { SavedQueryRow } from "../utils/db/savedQueries.js";

export interface SavedQueryViewOptions {
  /** Whether the viewer may run it: it plans against what they are granted. */
  accessible: boolean;
  /** From the directory; null when it could not be looked up. */
  ownerName: string | null;
  /** The saved query's source slug; read only when the view may show it. */
  sourceSlug: string | null;
  /** The viewer may read sources (`zeteo.sources.read`), so the source is shown even when they cannot run the saved query. */
  showSource: boolean;
  /** How many shares it has; given only when the viewer may see the share list (the owner, or `zeteo.saved_queries.read`). */
  shareCount?: number;
}

/**
 * A saved query as a viewer sees it. `source` and `query` are left out, not
 * null, unless the viewer has access; an admin who reads sources sees `source`
 * regardless, but never `query`. `share_count` is left out unless given.
 */
export const savedQueryView = (
  row: SavedQueryRow,
  {
    accessible,
    ownerName,
    sourceSlug,
    showSource,
    shareCount,
  }: SavedQueryViewOptions
) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  owner: { id: row.ownerId, name: ownerName },
  accessible,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
  ...(row.sharedAt && { shared_at: row.sharedAt.toISOString() }),
  last_run_at: row.lastRunAt?.toISOString() ?? null,
  you_last_ran_at: row.userLastRunAt?.toISOString() ?? null,
  ...((accessible || showSource) &&
    sourceSlug !== null && { source: { id: row.sourceId, slug: sourceSlug } }),
  ...(accessible && { query: row.query }),
  ...(shareCount !== undefined && { share_count: shareCount }),
});

export type SavedQueryView = ReturnType<typeof savedQueryView>;
