import type { RowAccess, RuleCondition, RuleFilter } from "./types.js";
import type { Condition, Scalar } from "../adapters/sql/language.js";
import { valuesOfUser, valuesOfUsers } from "../identity/service.js";
import type { QueryableType } from "../adapters/sql/types.js";
import { isIdentityRef, mapRule, opOf } from "./store.js";
import { coerceValue } from "../adapters/sql/plan.js";
import { prisma } from "../utils/db/prisma.js";
import {
  HierarchyTooLargeError,
  HierarchyUnavailableError,
  usersBelow,
} from "../grants/hierarchy.js";

// A caller's rows on a table, from the row access of every grant that reaches
// them on it: any `all` grant gives every row; otherwise the rules of the
// `rule` grants, OR'd; otherwise (every grant `unlimited_default`) every row.
// Each rule is resolved for the caller first: identity references become the
// caller's values (with `below`, those of the caller and of everyone below
// them in tereo's reporting lines), coerced to the column's type. Relative
// dates stay as written, for the planner to resolve against the query's `now`.

/** At most this many identity values put into one table's rule; more and the table is unavailable. */
export const MAX_RULE_VALUES = 50_000;

/** A rule filter keyed by column id with identity references replaced by literal lists. */
export type ResolvedRuleFilter =
  | { and: ResolvedRuleFilter[] }
  | { or: ResolvedRuleFilter[] }
  | { not: ResolvedRuleFilter }
  | Record<string, Condition>;

/** A column a resolved rule reads. */
export interface RuleColumn {
  id: string;
  name: string;
  type: QueryableType;
  nativeType: string;
}

/** One grant's rule, for telling the caller why their rows are limited. */
export interface RuleDescriptionPart {
  grantId: string;
  custom: string | null;
  stored: RuleFilter;
}

/**
 * The caller's rows on a table when they are limited: `never` (no row),
 * `filter` (the rows the filter keeps) or `unavailable` (the rule cannot be
 * applied as written, so the table cannot be read).
 */
export type RowRule =
  | { kind: "never" }
  | {
      kind: "filter";
      filter: ResolvedRuleFilter;
      columns: Map<string, RuleColumn>;
      descriptions: RuleDescriptionPart[];
    }
  | {
      kind: "unavailable";
      reason: "column_missing" | "too_many_values" | "hierarchy_unavailable";
    };

/** The values an identity reference stands for: the caller's own, and with `below` those of the caller and everyone below them. */
export interface IdentityValues {
  own: Map<string, string[]>;
  below: Map<string, string[]>;
}

/** What resolution reads of a grant. */
export interface GrantRow {
  id: string;
  rowAccess: RowAccess;
  /** The stored rule (JSON); set exactly when `rowAccess` is `rule`. */
  rowRule: unknown;
  rowRuleDescription: string | null;
}

export type CombinedRowAccess =
  | { kind: "all" }
  | { kind: "rules"; grants: Array<{ id: string; rule: RuleFilter }> };

/** "A limit beats no limit": the formula over the grants reaching a caller on one table. */
export const combineRowAccess = (
  grants: Array<{
    id: string;
    rowAccess: RowAccess;
    rowRule: RuleFilter | null;
  }>
): CombinedRowAccess => {
  if (grants.some((g) => g.rowAccess === "all")) return { kind: "all" };
  const rules: Array<{ id: string; rule: RuleFilter }> = [];
  for (const grant of grants) {
    if (grant.rowAccess !== "rule") continue;
    // The database's CHECK keeps this from happening; refuse rather than widen.
    if (grant.rowRule === null) {
      throw new Error(`Grant ${grant.id} limits rows with no rule`);
    }
    rules.push({ id: grant.id, rule: grant.rowRule });
  }
  return rules.length === 0
    ? { kind: "all" }
    : { kind: "rules", grants: rules };
};

// eq with an identity means "is one of my values", ne "is none of them".
const LIST_OP = { eq: "in", in: "in", ne: "notIn", notIn: "notIn" } as const;

const resolveCounted = (
  stored: RuleFilter,
  values: IdentityValues,
  columns: Map<string, RuleColumn>
): { filter: ResolvedRuleFilter; substituted: number } | "never" => {
  let never = false;
  let substituted = 0;
  const filter = mapRule(stored, [], (columnId, condition) => {
    const [op, raw] = opOf(condition);
    if (!isIdentityRef(raw)) return [columnId, condition];
    const column = columns.get(columnId);
    if (!column) throw new Error(`Rule column ${columnId} was not loaded`);
    const source = raw.below === true ? values.below : values.own;
    const kept = (source.get(raw.identity) ?? []).filter(
      (v) => coerceValue(v as Scalar, column.type) !== undefined
    );
    // An identity with no usable value makes the whole grant's rule false,
    // whatever surrounds it: notIn or not over nothing must never widen.
    if (kept.length === 0) never = true;
    substituted += kept.length;
    // An operator outside the table would key the list "undefined": refuse.
    if (!Object.hasOwn(LIST_OP, op)) {
      throw new Error(`Operator ${op} cannot take an identity reference`);
    }
    const listOp = LIST_OP[op as keyof typeof LIST_OP];
    return [columnId, { [listOp]: kept } as RuleCondition];
  });
  return never
    ? "never"
    : { filter: filter as ResolvedRuleFilter, substituted };
};

/**
 * The stored rule with each identity reference replaced by the caller's
 * values under that key (with `below`, `belowValues`, the caller's and those
 * of everyone below them), as a list (`eq`/`in` → `in`, `ne`/`notIn` → `notIn`).
 * A value that is not of the column's type is dropped; when an identity
 * leaves no value the whole rule is `never`. `columns` must hold every column
 * an identity reference compares with.
 */
export const resolveGrantRule = (
  stored: RuleFilter,
  values: Map<string, string[]>,
  columns: Map<string, RuleColumn>,
  belowValues: Map<string, string[]> = new Map()
): ResolvedRuleFilter | "never" => {
  const resolved = resolveCounted(
    stored,
    { own: values, below: belowValues },
    columns
  );
  return resolved === "never" ? "never" : resolved.filter;
};

/** The column ids and identity key ids a stored rule uses, the keys used with `below` apart. */
const usedBy = (
  rule: RuleFilter,
  columnIds: Set<string>,
  keyIds: Set<string>,
  belowKeyIds: Set<string> = new Set()
) =>
  mapRule(rule, [], (columnId, condition) => {
    columnIds.add(columnId);
    const [, raw] = opOf(condition);
    if (isIdentityRef(raw)) {
      (raw.below === true ? belowKeyIds : keyIds).add(raw.identity);
    }
    return [columnId, condition];
  });

/** Whether a stored rule uses `below` anywhere. */
const usesBelow = (rule: RuleFilter): boolean => {
  const below = new Set<string>();
  usedBy(rule, new Set(), new Set(), below);
  return below.size > 0;
};

type BelowValues =
  | { kind: "ok"; values: Map<string, string[]> }
  | { kind: "failed"; reason: "hierarchy_unavailable" | "too_many_values" };

/**
 * The values under `keyIds` of the caller and of everyone below them, read
 * from tereo. A failure is the reason the rules using `below` cannot be
 * applied: never a fallback to the caller's own values. A service account
 * has no place in tereo's reporting lines, so nobody is below it: it gets
 * its own values, decided by its type and never by a failure.
 */
const valuesBelow = async (
  userId: string,
  keyIds: string[],
  isServiceAccount: boolean
): Promise<BelowValues> => {
  if (isServiceAccount) {
    return { kind: "ok", values: await valuesOfUsers([userId], keyIds) };
  }
  let below: string[];
  try {
    below = await usersBelow(userId);
  } catch (err) {
    if (err instanceof HierarchyTooLargeError) {
      return { kind: "failed", reason: "too_many_values" };
    }
    if (err instanceof HierarchyUnavailableError) {
      return { kind: "failed", reason: "hierarchy_unavailable" };
    }
    throw err;
  }
  const users = [...new Set([userId, ...below])];
  return { kind: "ok", values: await valuesOfUsers(users, keyIds) };
};

/**
 * The caller's row rule per table, for the tables whose rows are limited; a
 * table absent from the result gives every row. `tableGrants` holds the
 * grants that reach the caller, by table id. One query reads the columns the
 * rules use and one the caller's identity values; neither runs when no grant
 * has a rule. When a rule uses `below`, tereo is asked once who is below the
 * caller and one more query reads their values with the caller's; when that
 * fails, every table with such a rule is `unavailable`. A service account
 * (`isServiceAccount`) is never looked up: `below` gives it its own values.
 */
export const resolveRowRules = async (
  userId: string,
  tableGrants: Map<string, GrantRow[]>,
  { isServiceAccount = false }: { isServiceAccount?: boolean } = {}
): Promise<Map<string, RowRule>> => {
  const limited = new Map<
    string,
    Array<{ id: string; rule: RuleFilter; custom: string | null }>
  >();
  const columnIds = new Set<string>();
  const keyIds = new Set<string>();
  const belowKeyIds = new Set<string>();
  for (const [tableId, grants] of tableGrants) {
    const combined = combineRowAccess(
      grants.map((g) => ({
        id: g.id,
        rowAccess: g.rowAccess,
        rowRule: (g.rowRule ?? null) as RuleFilter | null,
      }))
    );
    if (combined.kind === "all") continue;
    const custom = new Map(grants.map((g) => [g.id, g.rowRuleDescription]));
    limited.set(
      tableId,
      combined.grants.map((g) => ({ ...g, custom: custom.get(g.id) ?? null }))
    );
    for (const { rule } of combined.grants) {
      usedBy(rule, columnIds, keyIds, belowKeyIds);
    }
  }
  const out = new Map<string, RowRule>();
  if (limited.size === 0) return out;

  const [rows, own, below] = await Promise.all([
    columnIds.size === 0
      ? Promise.resolve([])
      : prisma.sourceColumn.findMany({
          where: { id: { in: [...columnIds] } },
          select: {
            id: true,
            tableId: true,
            name: true,
            type: true,
            nativeType: true,
            missingSince: true,
          },
        }),
    valuesOfUser(userId, [...keyIds]),
    belowKeyIds.size === 0
      ? Promise.resolve<BelowValues>({ kind: "ok", values: new Map() })
      : valuesBelow(userId, [...belowKeyIds], isServiceAccount),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const [tableId, grants] of limited) {
    const used = new Set<string>();
    for (const { rule } of grants) usedBy(rule, used, new Set());
    const columns = new Map<string, RuleColumn>();
    let missing = false;
    for (const id of used) {
      const row = byId.get(id);
      // Gone, missing from the source, of another table or of a type a
      // query cannot read: the rule cannot be applied, so neither can the table.
      if (
        !row ||
        row.tableId !== tableId ||
        row.missingSince !== null ||
        row.type === "other"
      ) {
        missing = true;
        break;
      }
      columns.set(id, {
        id,
        name: row.name,
        type: row.type,
        nativeType: row.nativeType,
      });
    }
    if (missing) {
      out.set(tableId, { kind: "unavailable", reason: "column_missing" });
      continue;
    }
    if (below.kind === "failed" && grants.some((g) => usesBelow(g.rule))) {
      out.set(tableId, { kind: "unavailable", reason: below.reason });
      continue;
    }
    const values: IdentityValues = {
      own,
      below: below.kind === "ok" ? below.values : new Map(),
    };

    const filters: ResolvedRuleFilter[] = [];
    const descriptions: RuleDescriptionPart[] = [];
    let substituted = 0;
    for (const grant of grants) {
      const resolved = resolveCounted(grant.rule, values, columns);
      if (resolved === "never") continue;
      substituted += resolved.substituted;
      filters.push(resolved.filter);
      descriptions.push({
        grantId: grant.id,
        custom: grant.custom,
        stored: grant.rule,
      });
    }
    if (substituted > MAX_RULE_VALUES) {
      out.set(tableId, { kind: "unavailable", reason: "too_many_values" });
    } else if (filters.length === 0) {
      out.set(tableId, { kind: "never" });
    } else {
      out.set(tableId, {
        kind: "filter",
        filter: filters.length === 1 ? filters[0] : { or: filters },
        columns,
        descriptions,
      });
    }
  }
  return out;
};
