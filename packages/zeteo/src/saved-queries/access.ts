import type { SavedQuery } from "../../prisma/generated/client/index.js";
import type { Access } from "../grants/access.js";
import {
  loadSourceVisibleCatalog,
  type VisibleCatalog,
} from "../grants/visibleCatalog.js";
import {
  planSavedAgainst,
  type SavedQueryToPlan,
} from "../engine/savedPlan.js";

/**
 * Whether the caller may use the saved query: its source is visible to them
 * and not archived, and its JSON plans against what they are granted.
 * `catalog` is the saved query's source from `loadSourceVisibleCatalog`. Any
 * failure is false, and none says why.
 */
export const canUse = (
  access: Access,
  saved: SavedQueryToPlan,
  catalog: VisibleCatalog
): boolean => {
  try {
    planSavedAgainst(access, saved, catalog, {
      sourceId: null,
      unrecorded: false,
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * `canUse` for each saved query, by id, loading each distinct source's
 * catalogue once.
 */
export const decideAccess = async (
  access: Access,
  saved: SavedQuery[]
): Promise<Map<string, boolean>> => {
  const catalogs = new Map<string, VisibleCatalog>();
  // One source at a time: a page of saved queries can name many.
  for (const sourceId of new Set(saved.map((s) => s.sourceId))) {
    catalogs.set(sourceId, await loadSourceVisibleCatalog(sourceId, access));
  }
  return new Map(
    saved.map((s) => [s.id, canUse(access, s, catalogs.get(s.sourceId)!)])
  );
};
