import { AppError, SavedQueryNotAccessibleError } from "../utils/errors.js";
import type { SavedQuery } from "../../prisma/generated/client/index.js";
import { planFor, type Progress } from "./plan.js";
import type { Access } from "../grants/access.js";
import { logger } from "../utils/logger.js";
import {
  loadSourceVisibleCatalog,
  type VisibleCatalog,
} from "../grants/visibleCatalog.js";
import type {
  PlanContext,
  QueryPlan,
  SourceAdapter,
} from "../adapters/types.js";

/** What planning a saved query needs of it: its source and its stored JSON. */
export type SavedQueryToPlan = Pick<SavedQuery, "sourceId" | "query">;

export interface PlannedSavedQuery {
  catalog: VisibleCatalog;
  adapter: SourceAdapter;
  plan: QueryPlan;
}

/**
 * The saved query planned against `catalog`, its source as the caller sees it
 * (from `loadSourceVisibleCatalog`). The plan is always attempted, whatever
 * the catalogue holds, so every outcome costs the same work.
 *
 * Every failure, whatever its cause (a source hidden, archived or not this
 * one, a body the language refuses, a name the planner cannot find, a
 * reference outside the grants), is one fresh `SavedQueryNotAccessibleError`:
 * nothing of the original error goes with it. `progress` is touched only on
 * success, so a refusal reads the same in the run's record whatever its cause.
 */
export const planSavedAgainst = (
  access: Access,
  saved: SavedQueryToPlan,
  catalog: VisibleCatalog,
  progress: Progress,
  ctx?: PlanContext
): PlannedSavedQuery => {
  let planned: { adapter: SourceAdapter; plan: QueryPlan };
  try {
    planned = planFor(
      saved.query,
      access,
      catalog,
      { sourceId: null, unrecorded: false },
      ctx
    );
  } catch (err) {
    // A planner or language refusal is the expected kind; anything else is a
    // fault worth seeing in the log, though the caller still gets only this.
    if (!(err instanceof AppError)) {
      logger.error({ err }, "planning a saved query failed unexpectedly");
    }
    throw new SavedQueryNotAccessibleError();
  }
  const visible =
    catalog.source.id === saved.sourceId &&
    access.sourceIds.has(saved.sourceId);
  if (!visible) throw new SavedQueryNotAccessibleError();
  progress.sourceId = catalog.source.id;
  return { catalog, ...planned };
};

/**
 * A saved query planned as the caller, for the engine: its source's visible
 * catalogue loaded by the id the saved query holds (never by the slug in its
 * JSON), then `planSavedAgainst`. Throws `SavedQueryNotAccessibleError` where
 * `canUse` answers false.
 */
export const planSaved = async (
  access: Access,
  saved: SavedQueryToPlan,
  progress: Progress,
  ctx?: PlanContext
): Promise<PlannedSavedQuery> => {
  const catalog = await loadSourceVisibleCatalog(saved.sourceId, access);
  return planSavedAgainst(access, saved, catalog, progress, ctx);
};
