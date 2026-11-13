import type { Caller } from "../middleware/auth.js";
import { groupIdsOf } from "./principals.js";
import { db } from "../utils/db/index.js";

export interface Access {
  /** Sources with at least one granted table. */
  sourceIds: Set<string>;
  allows(tableId: string, columnId: string): boolean;
  /** `"all"` for an all-columns grant, else the granted column ids; undefined when the table is not granted. */
  tableAccess(tableId: string): "all" | ReadonlySet<string> | undefined;
}

/** A caller's access, with whom it was loaded for. */
export interface CallerAccess extends Access {
  userId: string;
  /** The groups that count for the caller, as `groupIdsOf` gave them. */
  groupIds: readonly string[];
}

/** The union of the caller's own grants and those of the groups that count for them. */
export const loadAccess = async (caller: Caller): Promise<CallerAccess> => {
  const groupIds = await groupIdsOf(caller);
  const grants = await db.grants.listForPrincipals([
    { type: "user", id: caller.userId },
    ...groupIds.map((id) => ({ type: "group" as const, id })),
  ]);

  const sourceIds = new Set<string>();
  const tables = new Map<string, "all" | Set<string>>();
  for (const grant of grants) {
    if (grant.table.source.archivedAt) continue;
    if (!grant.allColumns && grant.columns.length === 0) continue;
    sourceIds.add(grant.table.sourceId);
    const held = tables.get(grant.tableId);
    if (held === "all") continue;
    if (grant.allColumns) {
      tables.set(grant.tableId, "all");
      continue;
    }
    const columns = held ?? new Set<string>();
    for (const { columnId } of grant.columns) columns.add(columnId);
    tables.set(grant.tableId, columns);
  }

  return {
    userId: caller.userId,
    groupIds,
    sourceIds,
    tableAccess: (tableId) => tables.get(tableId),
    allows: (tableId, columnId) => {
      const held = tables.get(tableId);
      return held === "all" || (held?.has(columnId) ?? false);
    },
  };
};
