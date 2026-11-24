import { keysById, valuesOfUser, valuesOfUsers } from "../identity/service.js";
import { identityKeysOf, isIdentityRef, mapRule, opOf } from "./store.js";
import type { RowAccess, RuleFilter } from "./types.js";
import { namedGroupsOf } from "../grants/principals.js";
import { loadAccessAs } from "../grants/access.js";
import { NotFoundError } from "../utils/errors.js";
import { combineRowAccess } from "./resolve.js";
import { originOf } from "../uploads/origin.js";
import { describeRowRule } from "./describe.js";
import { prisma } from "../utils/db/prisma.js";
import {
  HierarchyTooLargeError,
  HierarchyUnavailableError,
  usersBelow,
} from "../grants/hierarchy.js";
import type {
  ResolvedRuleFilter,
  RowRule,
  RuleColumn,
  RuleDescriptionPart,
} from "./resolve.js";

// What one user gets of one table, for an admin: the columns, the rows, the
// grants that give them, and what an admin should look at. The admin sees
// every column, so the rule is described with all of them named.

export type EffectiveWarning =
  | { code: "all_rows_overrides"; grant_id: string }
  | { code: "missing_identity_value"; key: string }
  | { code: "row_rule_unavailable"; reason: string }
  | { code: "merged_members_limited"; member_table_ids: string[] }
  | {
      code: "org_scoped_rule_inactive";
      group_id: string;
      group_name: string | null;
      organization_id: string;
      organization_name: string | null;
    };

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
  /** The organizations of the user's groups, to ask again as signed in to one. */
  organizations: Array<{ id: string; name: string | null }>;
}

/** The identity keys the rules use plainly and with `below`, apart. */
const keysByUse = (
  rules: RuleFilter[]
): { plain: Set<string>; below: Set<string> } => {
  const plain = new Set<string>();
  const below = new Set<string>();
  for (const rule of rules) {
    mapRule(rule, [], (id, condition) => {
      const [, raw] = opOf(condition);
      if (isIdentityRef(raw)) {
        (raw.below === true ? below : plain).add(raw.identity);
      }
      return [id, condition];
    });
  }
  return { plain, below };
};

/**
 * The values under `keyIds` of the user and everyone below them, or null when
 * tereo cannot say who that is (the rule's own warning says so then).
 */
const valuesWithBelow = async (
  userId: string,
  keyIds: string[]
): Promise<Map<string, string[]> | null> => {
  if (keyIds.length === 0) return new Map();
  let below: string[];
  try {
    below = await usersBelow(userId);
  } catch (err) {
    if (
      err instanceof HierarchyUnavailableError ||
      err instanceof HierarchyTooLargeError
    ) {
      return null;
    }
    throw err;
  }
  return valuesOfUsers([...new Set([userId, ...below])], keyIds);
};

/** `value` as JSON with every object's keys sorted, so equal values give equal text. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
      return inner;
    }
    return Object.fromEntries(
      Object.keys(inner)
        .sort()
        .map((k) => [k, (inner as Record<string, unknown>)[k]])
    );
  });

/** The resolved filter keyed by column name, so two tables' filters compare. */
const byName = (
  filter: ResolvedRuleFilter,
  columns: Map<string, RuleColumn>
): unknown => {
  if ("and" in filter && Array.isArray(filter.and)) {
    return { and: filter.and.map((f) => byName(f, columns)) };
  }
  if ("or" in filter && Array.isArray(filter.or)) {
    return { or: filter.or.map((f) => byName(f, columns)) };
  }
  if ("not" in filter && Object.keys(filter).length === 1) {
    return { not: byName(filter.not as ResolvedRuleFilter, columns) };
  }
  return Object.fromEntries(
    Object.entries(filter).map(([id, condition]) => [
      // An id with no name never equals another table's column.
      columns.get(id)?.name ?? `#${id}`,
      condition,
    ])
  );
};

/** A table's resolved rows as comparable text: no rule (every row), no row, unavailable or the filter by column name. */
const rowsKey = (rule: RowRule | undefined): string =>
  rule === undefined
    ? "all"
    : rule.kind === "filter"
      ? `filter:${canonical(byName(rule.filter, rule.columns))}`
      : rule.kind === "unavailable"
        ? `unavailable:${rule.reason}`
        : "never";

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

  const [access, userGroups] = await Promise.all([
    loadAccessAs(userId, organizationId),
    namedGroupsOf(userId),
  ]);
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

  // A rule on a group of another organization than the sign-in's (or on
  // any organization's group, signed in to none) does not count, so it
  // limits nothing here: by design, and worth an admin's notice.
  const elsewhere = userGroups.filter(
    (g) => g.organizationId !== null && g.organizationId !== organizationId
  );
  if (elsewhere.length > 0) {
    const ruled = await prisma.grant.findMany({
      where: {
        tableId,
        table: { source: { archivedAt: null } },
        rowAccess: "rule",
        principalType: "group",
        principalId: { in: elsewhere.map((g) => g.id) },
      },
      select: {
        principalId: true,
        allColumns: true,
        _count: { select: { columns: true } },
      },
    });
    const ruledIds = new Set(
      ruled
        .filter((g) => g.allColumns || g._count.columns > 0)
        .map((g) => g.principalId)
    );
    for (const g of elsewhere) {
      if (!ruledIds.has(g.id)) continue;
      warnings.push({
        code: "org_scoped_rule_inactive",
        group_id: g.id,
        group_name: g.name,
        organization_id: g.organizationId!,
        organization_name: g.organizationName,
      });
    }
  }

  let ruleSummary: string | null = null;
  if (held !== undefined && combined.kind === "rules") {
    const rules = combined.grants.map((g) => g.rule);
    const keyIds = identityKeysOf(rules);
    const used = keysByUse(rules);
    const [keys, values, withBelow] = await Promise.all([
      keyIds.size === 0 ? new Map() : keysById([...keyIds]),
      valuesOfUser(userId, [...keyIds]),
      valuesWithBelow(userId, [...used.below]),
    ]);
    // Used plainly, a key is missing when the user holds no value; with
    // `below`, when neither they nor anyone below them does (unknown when
    // tereo cannot say: the rule's own warning covers that).
    for (const keyId of keyIds) {
      const key = keys.get(keyId);
      if (!key) continue;
      const missingOwn =
        used.plain.has(keyId) && (values.get(keyId) ?? []).length === 0;
      const missingBelow =
        used.below.has(keyId) &&
        withBelow !== null &&
        (withBelow.get(keyId) ?? []).length === 0;
      if (missingOwn || missingBelow) {
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

  // A merged table's rows come from its own grants, not its members'. Warn
  // when it shows rows while a member the user's rules limit is limited
  // differently (every row of the merged table, or another rule): the merged
  // table may show that member's rows the member's own grants do not.
  const origin = originOf(table);
  if (rows !== "none" && origin?.kind === "merged") {
    const mergedRows = rowsKey(rule);
    const limited = origin.definition.members
      .map((m) => m.tableId)
      .filter((id) => {
        const member = access.rowRule(id);
        return member !== undefined && rowsKey(member) !== mergedRows;
      });
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
    organizations: [
      ...new Map(
        userGroups
          .filter((g) => g.organizationId !== null)
          .map((g) => [
            g.organizationId!,
            { id: g.organizationId!, name: g.organizationName },
          ])
      ).values(),
    ],
  };
};
