import type { Caller } from "../middleware/auth.js";
import { groupIdsOf } from "./principals.js";
import { db } from "../utils/db/index.js";
import {
  resolveRowRules,
  type GrantRow,
  type RowRule,
} from "../row-rules/resolve.js";

export interface Access {
  /** Sources with at least one granted table. */
  sourceIds: Set<string>;
  allows(tableId: string, columnId: string): boolean;
  /** `"all"` for an all-columns grant, else the granted column ids; undefined when the table is not granted. */
  tableAccess(tableId: string): "all" | ReadonlySet<string> | undefined;
  /** The caller's rows on the table when grants limit them; undefined when every row is theirs. */
  rowRule(tableId: string): RowRule | undefined;
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
  const tableGrants = new Map<string, GrantRow[]>();
  for (const grant of grants) {
    if (grant.table.source.archivedAt) continue;
    if (!grant.allColumns && grant.columns.length === 0) continue;
    sourceIds.add(grant.table.sourceId);
    tableGrants.set(grant.tableId, [
      ...(tableGrants.get(grant.tableId) ?? []),
      grant,
    ]);
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

  // A service account is resolved like a user: its own grants and values;
  // with `below`, only its own values, as no one reports to it.
  const rowRules = [...tableGrants.values()].some((held) =>
    held.some((g) => g.rowAccess === "rule")
  )
    ? await resolveRowRules(caller.userId, tableGrants, {
        isServiceAccount: caller.isServiceAccount,
      })
    : new Map<string, RowRule>();

  return {
    userId: caller.userId,
    groupIds,
    sourceIds,
    tableAccess: (tableId) => tables.get(tableId),
    rowRule: (tableId) => rowRules.get(tableId),
    allows: (tableId, columnId) => {
      const held = tables.get(tableId);
      return held === "all" || (held?.has(columnId) ?? false);
    },
  };
};

/**
 * `loadAccess` for a user who is not the caller, as if signed in to
 * `organizationId`: their own grants and those of their global groups and
 * that organization's. It asks tereo for the groups, so it never runs inside
 * `withAudit`. Judged as a user (effective access is for users, and a
 * transfer refuses a service account): `below` reads their reporting lines.
 */
export const loadAccessAs = (
  userId: string,
  organizationId: string | null
): Promise<CallerAccess> =>
  loadAccess({
    userId,
    organizationId,
    permissions: [],
    isServiceAccount: false,
  });
