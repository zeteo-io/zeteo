import type { VisibleCatalog } from "../grants/visibleCatalog.js";
import { invalidRequest } from "../utils/validateReq.js";
import { adapterFor } from "../adapters/index.js";
import type { Access } from "../grants/access.js";
import { logger } from "../utils/logger.js";
import { QueryError } from "./errors.js";
import type {
  PlanContext,
  QueryPlan,
  SourceAdapter,
} from "../adapters/types.js";

// Planning a body against a visible catalogue: shared by queries, exports and
// saved queries, and importing none of them.

/** What the run has got to, for its record. */
export interface Progress {
  sourceId: string | null;
  /** The source's language refused the body: a 400 that is not recorded. */
  unrecorded: boolean;
}

/** Step 3: the planner must reference only granted columns; a miss means it and the catalogue disagree. */
const checkReferences = (
  plan: QueryPlan,
  access: Access,
  catalog: VisibleCatalog
): void => {
  for (const ref of plan.references) {
    if (access.allows(ref.tableId, ref.columnId)) continue;
    logger.error(
      {
        source_id: catalog.source.id,
        table_id: ref.tableId,
        column_id: ref.columnId,
      },
      "a query plan references a column outside the caller's grants"
    );
    throw new QueryError(
      "not_found_or_not_accessible",
      "A name in the query was not found or is not accessible",
      []
    );
  }
};

/**
 * Step 3: the body in the source's language, planned against the visible
 * catalogue, every reference granted. A body the language refuses is a 400
 * that is not recorded.
 */
export const planFor = (
  body: unknown,
  access: Access,
  catalog: VisibleCatalog,
  progress: Progress,
  ctx?: PlanContext
): { adapter: SourceAdapter; plan: QueryPlan } => {
  const adapter = adapterFor(catalog.source.type);
  const parsed = adapter.language.schema.safeParse(body);
  if (!parsed.success) {
    progress.unrecorded = true;
    throw invalidRequest("body", parsed.error);
  }
  const plan = adapter.language.plan(parsed.data, catalog, ctx);
  checkReferences(plan, access, catalog);
  return { adapter, plan };
};
