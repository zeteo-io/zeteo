import type { RuleColumn, RuleDescriptionPart } from "./resolve.js";
import { keysById, valuesOfUser } from "../identity/service.js";
import { isIdentityRef, mapRule, opOf } from "./store.js";
import type { RowAccess, RuleFilter } from "./types.js";
import { loadAccessAs } from "../grants/access.js";
import { NotFoundError } from "../utils/errors.js";
import { combineRowAccess } from "./resolve.js";
import { originOf } from "../uploads/origin.js";
import { describeRowRule } from "./describe.js";
import { prisma } from "../utils/db/prisma.js";

// What one user gets of one table, for an admin: the columns, the rows, the
// grants that give them, and what an admin should look at. The admin sees
// every column, so the rule is described with all of them named.

export type EffectiveWarning =
  | { code: "all_rows_overrides"; grant_id: string }
  | { code: "missing_identity_value"; key: string }
  | { code: "row_rule_unavailable"; reason: string }
  | { code: "merged_members_limited"; member_table_ids: string[] };

export interface EffectiveAccess {
  columns: "all" | string[];
  rows: "all" | "limited" | "none";
  rule_summary: string | null;
  grants: Array<{
    grant_id: string;
    principal_type: "user" | "group";
    principal_id: string;
    row_access: RowAccess;
  }>;
  warnings: EffectiveWarning[];
}

/** The identity key ids the rules use. */
const keysOf = (rules: RuleFilter[]): Set<string> => {
  const keys = new Set<string>();
  for (const rule of rules) {
    mapRule(rule, [], (id, condition) => {
      const [, raw] = opOf(condition);
      if (isIdentityRef(raw)) keys.add(raw.identity);
      return [id, condition];
    });
  }
  return keys;
};

/**
 * `userId`'s access to `tableId` as if signed in to `organizationId` (null:
 * global groups only). Asks tereo for the user's groups, so it never runs
 * inside a transaction. A table that does not exist is a 404.
 */
export const effectiveAccess = async (
  userId: string,
  tableId: string,
  organizationId: string | null
): Promise<EffectiveAccess> => {
  const table = await prisma.sourceTable.findUnique({
    where: { id: tableId },
    select: {
      id: true,
      origin: true,
      columns: {
        select: {
          id: true,
          name: true,
          type: true,
          nativeType: true,
          position: true,
        },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!table) throw new NotFoundError("Table not found");

  const access = await loadAccessAs(userId, organizationId);
  // The grants loadAccess counts: the user's and their groups', on a live
  // source, with at least one column.
  const grants = (
    await prisma.grant.findMany({
      where: {
        tableId,
        table: { source: { archivedAt: null } },
        OR: [
          { principalType: "user", principalId: userId },
          ...(access.groupIds.length === 0
            ? []
            : [
                {
                  principalType: "group" as const,
                  principalId: { in: [...access.groupIds] },
                },
              ]),
        ],
      },
      select: {
        id: true,
        principalType: true,
        principalId: true,
        allColumns: true,
        rowAccess: true,
        rowRule: true,
        rowRuleDescription: true,
        _count: { select: { columns: true } },
      },
      orderBy: { id: "asc" },
    })
  ).filter((g) => g.allColumns || g._count.columns > 0);

  const held = access.tableAccess(tableId);
  const columns: EffectiveAccess["columns"] =
    held === undefined
      ? []
      : held === "all"
        ? "all"
        : table.columns.filter((c) => held.has(c.id)).map((c) => c.name);

  const combined = combineRowAccess(
    grants.map((g) => ({
      id: g.id,
      rowAccess: g.rowAccess,
      rowRule: (g.rowRule ?? null) as RuleFilter | null,
    }))
  );
  const rule = access.rowRule(tableId);
  const warnings: EffectiveWarning[] = [];

  const rows: EffectiveAccess["rows"] =
    held === undefined
      ? "none"
      : rule === undefined
        ? "all"
        : rule.kind === "filter"
          ? "limited"
          : "none";

  if (grants.some((g) => g.rowAccess === "rule")) {
    for (const g of grants) {
      if (g.rowAccess === "all") {
        warnings.push({ code: "all_rows_overrides", grant_id: g.id });
      }
    }
  }

  let ruleSummary: string | null = null;
  if (held !== undefined && combined.kind === "rules") {
    const keyIds = keysOf(combined.grants.map((g) => g.rule));
    const [keys, values] = await Promise.all([
      keyIds.size === 0 ? new Map() : keysById([...keyIds]),
      valuesOfUser(userId, [...keyIds]),
    ]);
    for (const keyId of keyIds) {
      const key = keys.get(keyId);
      if (key && (values.get(keyId) ?? []).length === 0) {
        warnings.push({ code: "missing_identity_value", key: key.name });
      }
    }
    if (rule?.kind === "unavailable") {
      warnings.push({ code: "row_rule_unavailable", reason: rule.reason });
    }
    // A filter's parts leave out the grants that give no row; otherwise every rule grant.
    const custom = new Map(grants.map((g) => [g.id, g.rowRuleDescription]));
    const parts: RuleDescriptionPart[] =
      rule?.kind === "filter"
        ? rule.descriptions
        : combined.grants.map((g) => ({
            grantId: g.id,
            custom: custom.get(g.id) ?? null,
            stored: g.rule,
          }));
    const named = new Map<string, RuleColumn>(
      table.columns
        .filter((c) => c.type !== "other")
        .map((c) => [
          c.id,
          {
            id: c.id,
            name: c.name,
            type: c.type as RuleColumn["type"],
            nativeType: c.nativeType,
          },
        ])
    );
    ruleSummary = describeRowRule(
      parts,
      new Set(named.keys()),
      named,
      new Map([...keys].map(([id, k]) => [id, k.label as string]))
    );
  }

  const origin = originOf(table);
  if (rows === "all" && origin?.kind === "merged") {
    const limited = origin.definition.members
      .map((m) => m.tableId)
      .filter((id) => access.rowRule(id) !== undefined);
    if (limited.length > 0) {
      warnings.push({
        code: "merged_members_limited",
        member_table_ids: limited,
      });
    }
  }

  return {
    columns,
    rows,
    rule_summary: ruleSummary,
    grants: grants.map((g) => ({
      grant_id: g.id,
      principal_type: g.principalType,
      principal_id: g.principalId,
      row_access: g.rowAccess,
    })),
    warnings,
  };
};
