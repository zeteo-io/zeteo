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
}

/**
 * A saved query as a viewer sees it. `source` and `query` are left out, not
 * null, unless the viewer has access; an admin who reads sources sees `source`
 * regardless, but never `query`.
 */
export const savedQueryView = (
  row: SavedQueryRow,
  { accessible, ownerName, sourceSlug, showSource }: SavedQueryViewOptions
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
});

export type SavedQueryView = ReturnType<typeof savedQueryView>;
