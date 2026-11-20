import type { SavedQuery } from "../../prisma/generated/client/index.js";
import type { SavedQueryToPlan } from "../engine/savedPlan.js";
import type { Access } from "../grants/access.js";
import { planFor } from "../engine/plan.js";
import {
  loadSourceVisibleCatalog,
  withoutRowRules,
  type VisibleCatalog,
} from "../grants/visibleCatalog.js";

/** Whether the saved query's source is the catalogue's and visible to the caller. */
export const isVisible = (
  access: Access,
  saved: SavedQueryToPlan,
  catalog: VisibleCatalog
): boolean =>
  catalog.source.id === saved.sourceId && access.sourceIds.has(saved.sourceId);

/**
 * Whether the caller may use the saved query: its source is visible to them
 * and not archived, and its JSON plans against what they are granted. Row
 * rules play no part: they limit the rows a run reads, not whether the
 * caller may run it. `catalog` is the saved query's source from
 * `loadSourceVisibleCatalog`. Any failure is false, and none says why.
 */
export const canUse = (
  access: Access,
  saved: SavedQueryToPlan,
  catalog: VisibleCatalog
): boolean => {
  try {
    planFor(saved.query, access, withoutRowRules(catalog), {
      sourceId: null,
      unrecorded: false,
    });
  } catch {
    return false;
  }
  return isVisible(access, saved, catalog);
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
