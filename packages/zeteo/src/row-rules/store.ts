import type { Compared, Operator, Scalar } from "../adapters/sql/language.js";
import type { IdentityRef, RuleCondition, RuleFilter } from "./types.js";
import { coerceValue, operatorApplies } from "../adapters/sql/plan.js";
import type { QueryableType } from "../adapters/sql/types.js";
import { isRelativeDate } from "../adapters/sql/relative.js";
import { InvalidRowRuleError } from "../utils/errors.js";
import type { Prisma } from "../utils/db/prisma.js";
import { keysById } from "../identity/service.js";
import { prisma } from "../utils/db/prisma.js";

// A row rule is written with column and identity key names and stored with
// their ids (catalogue ids are stable, so a rename does not break a rule).
// Relative dates are stored as written and resolved at query time.

type Path = (string | number)[];

/** The names a stored rule's ids show as: its columns and identity keys. */
export interface RuleNames {
  columns: Map<string, { name: string; missing: boolean }>;
  keys: Map<string, { name: string }>;
}

const IDENTITY_OPS: ReadonlySet<string> = new Set(["eq", "ne", "in", "notIn"]);

export const isIdentityRef = (value: unknown): value is IdentityRef =>
  typeof value === "object" && value !== null && "identity" in value;

const isComparison = (
  rule: RuleFilter
): rule is Record<string, RuleCondition> =>
  !("and" in rule && Array.isArray(rule.and)) &&
  !("or" in rule && Array.isArray(rule.or)) &&
  !("not" in rule);

/**
 * The rule with each comparison's key and condition passed through `leaf`;
 * `and`, `or` and `not` kept as they are.
 */
export const mapRule = (
  rule: RuleFilter,
  path: Path,
  leaf: (
    key: string,
    condition: RuleCondition,
    path: Path
  ) => [string, RuleCondition]
): RuleFilter => {
  if ("and" in rule && Array.isArray(rule.and)) {
    return {
      and: (rule.and as RuleFilter[]).map((f, i) =>
        mapRule(f, [...path, "and", i], leaf)
      ),
    };
  }
  if ("or" in rule && Array.isArray(rule.or)) {
    return {
      or: (rule.or as RuleFilter[]).map((f, i) =>
        mapRule(f, [...path, "or", i], leaf)
      ),
    };
  }
  if (!isComparison(rule)) {
    const { not } = rule as { not: RuleFilter };
    return { not: mapRule(not, [...path, "not"], leaf) };
  }
  return Object.fromEntries(
    Object.entries(rule).map(([key, condition]) =>
      leaf(key, condition, [...path, key])
    )
  );
};

/** The condition's operator and value. */
export const opOf = (condition: RuleCondition): [Operator, unknown] =>
  Object.entries(condition)[0] as [Operator, unknown];

/** The identity key ids the rules use. */
export const identityKeysOf = (rules: RuleFilter[]): Set<string> => {
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

/** Every identity reference in the rule, with where it is. */
const identityRefs = (rule: RuleFilter): Array<[IdentityRef, Path]> => {
  const found: Array<[IdentityRef, Path]> = [];
  mapRule(rule, ["row_rule"], (key, condition, path) => {
    const [op, raw] = opOf(condition);
    if (isIdentityRef(raw)) found.push([raw, [...path, op]]);
    return [key, condition];
  });
  return found;
};

/**
 * Whether a JSON number reached the server as written: a safe integer, or a
 * fraction of at most 15 significant digits, which a double always keeps. A
 * larger integer (past 2^53) or a longer fraction was rounded in parsing, so
 * a rule holding it would match other rows than the one written.
 */
const isExactNumber = (n: number): boolean => {
  if (!Number.isFinite(n)) return false;
  if (Number.isInteger(n)) return Number.isSafeInteger(n);
  const digits = n.toExponential().replace(/e.*$/, "").replace(/[-.]/g, "");
  return digits.length <= 15;
};

/**
 * Refuses a rule written by an upload source's owner (not a holder of
 * `zeteo.grants.write`) that names identity values, at the first reference.
 */
export const refuseIdentityRefs = (rule: RuleFilter): void => {
  const [first] = identityRefs(rule);
  if (first) {
    throw new InvalidRowRuleError(
      "A row rule written by a source's owner cannot use identity values; ask an admin with zeteo.grants.write to add one",
      [...first[1], "identity"]
    );
  }
};

/** Operators that order: an equality's values are compared exactly, or fail closed, whatever their digits. */
const ORDERING_OPS: ReadonlySet<string> = new Set([
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
]);

/**
 * A number literal's digits as SQL Server binds it: those before the point,
 * leading zeros aside, and every one after it. Past 38, no decimal holds it
 * and it would be compared through a float.
 */
const digitsOf = (value: unknown): number => {
  const m = /^-?(\d+)(?:\.(\d+))?$/.exec(String(value));
  return m ? m[1]!.replace(/^0+/, "").length + (m[2]?.length ?? 0) : 0;
};

/** A literal or relative date checked against the column's type; refused with the path of the value. */
const checkValue = (
  value: unknown,
  type: QueryableType,
  label: string,
  op: Operator,
  path: Path
): void => {
  const wrong = () =>
    new InvalidRowRuleError(
      `"${label}" is ${type}; ${op} takes a value of that type`,
      path
    );
  if (typeof value === "object" && value !== null && "measure" in value) {
    throw new InvalidRowRuleError(
      "A row rule compares to literal values, relative dates or identity values, not measures",
      path
    );
  }
  if (isRelativeDate(value)) {
    if (type !== "date" && type !== "timestamp") throw wrong();
    return;
  }
  if (typeof value === "number" && !isExactNumber(value)) {
    throw new InvalidRowRuleError(
      `${value} cannot be held exactly as a JSON number; write large numbers as decimal strings`,
      path
    );
  }
  if (coerceValue(value as Scalar, type) === undefined) throw wrong();
  if (type === "number" && ORDERING_OPS.has(op) && digitsOf(value) > 38) {
    throw new InvalidRowRuleError(
      `${String(value)} has more than 38 digits, more than SQL Server compares exactly; ${op} takes at most 38`,
      path
    );
  }
};

/**
 * The rule as stored: keyed by the ids of `tableId`'s columns, identity
 * references by key id, and `identityKeyIds`, the distinct keys it uses. Every
 * column must be one of the table's own (no relation paths), present and
 * queryable, every operator must suit its column's type and every literal
 * parse to it; every identity key must exist. The keys are locked
 * (`FOR KEY SHARE`) so that a key's removal waits for this transaction and
 * then sees the grant that uses it.
 */
export const toStoredRule = async (
  tx: Prisma.TransactionClient,
  tableId: string,
  rule: RuleFilter
): Promise<{ stored: RuleFilter; identityKeyIds: string[] }> => {
  const refs = identityRefs(rule);
  const names = [...new Set(refs.map(([ref]) => ref.identity))];
  const keys =
    names.length === 0
      ? []
      : await tx.$queryRaw<Array<{ id: string; name: string }>>`
          SELECT "id", "name" FROM "zeteo"."identity_keys"
          WHERE "name" = ANY(${names}::text[])
          ORDER BY "id"
          FOR KEY SHARE`;
  const keyIds = new Map(keys.map((k) => [k.name, k.id]));

  const columns = await tx.sourceColumn.findMany({
    where: { tableId },
    select: { id: true, name: true, type: true, missingSince: true },
  });
  const byName = new Map(columns.map((c) => [c.name, c]));
  const used = new Set<string>();

  const stored = mapRule(rule, ["row_rule"], (name, condition, path) => {
    if (name.includes(".")) {
      throw new InvalidRowRuleError(
        `A row rule uses the columns of the grant's own table; "${name}" is a relation path`,
        path
      );
    }
    const column = byName.get(name);
    if (!column) {
      throw new InvalidRowRuleError(
        `"${name}" is not a column of the grant's table`,
        path
      );
    }
    if (column.missingSince !== null) {
      throw new InvalidRowRuleError(
        `Column "${name}" is missing from the source`,
        path
      );
    }
    if (column.type === "other") {
      throw new InvalidRowRuleError(
        `Column "${name}" has a type that cannot be queried`,
        path
      );
    }
    const type = column.type;
    const [op, raw] = opOf(condition);
    const at = [...path, op];
    if (!operatorApplies(type, op)) {
      throw new InvalidRowRuleError(
        `${op} does not apply to "${name}", a ${type} column`,
        at
      );
    }
    if (isIdentityRef(raw)) {
      // The schema admits identity values only under eq, ne, in and notIn.
      if (!IDENTITY_OPS.has(op)) {
        throw new InvalidRowRuleError(
          `${op} does not take an identity value`,
          at
        );
      }
      // Identity values are text; none coerces to these types, so the
      // reference would never match anything.
      if (type === "boolean" || type === "json") {
        throw new InvalidRowRuleError(
          `An identity value cannot be compared with "${name}", a ${type} column`,
          [...at, "identity"]
        );
      }
      const keyId = keyIds.get(raw.identity);
      if (keyId === undefined) {
        throw new InvalidRowRuleError(
          `There is no identity key named "${raw.identity}"`,
          [...at, "identity"]
        );
      }
      used.add(keyId);
      // `below: false` is the plain reference; only `true` is kept.
      const ref: IdentityRef =
        raw.below === true
          ? { identity: keyId, below: true }
          : { identity: keyId };
      return [column.id, { [op]: ref } as RuleCondition];
    }
    switch (op) {
      case "between":
        (raw as [Compared, Compared]).forEach((v, i) =>
          checkValue(v, type, name, op, [...at, i])
        );
        break;
      case "in":
      case "notIn":
        (raw as Scalar[]).forEach((v, i) =>
          checkValue(v, type, name, op, [...at, i])
        );
        break;
      case "eq":
      case "ne":
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        checkValue(raw, type, name, op, at);
        break;
      default:
        // isNull, isBusinessDay, contains, startsWith: the schema checked the value.
        break;
    }
    return [column.id, condition];
  });
  return { stored, identityKeyIds: [...used] };
};

/** The stored rule with names for ids, for the grant's view; an id with no name is kept as it is. */
export const toApiRule = (
  stored: RuleFilter,
  columns: RuleNames["columns"],
  keys: RuleNames["keys"]
): RuleFilter =>
  mapRule(stored, [], (id, condition) => {
    const [op, raw] = opOf(condition);
    const named = isIdentityRef(raw)
      ? ({
          [op]: {
            ...raw,
            identity: keys.get(raw.identity)?.name ?? raw.identity,
          },
        } as RuleCondition)
      : condition;
    return [columns.get(id)?.name ?? id, named];
  });

/**
 * What stops the stored rule from applying as written, for an admin:
 * `column_missing:<name>`, `column_unknown:<id>`, `identity_key_unknown:<id>`.
 */
export const ruleProblems = (
  stored: RuleFilter,
  columns: RuleNames["columns"],
  keys: RuleNames["keys"]
): string[] => {
  const problems = new Set<string>();
  mapRule(stored, [], (id, condition) => {
    const column = columns.get(id);
    if (!column) problems.add(`column_unknown:${id}`);
    else if (column.missing) problems.add(`column_missing:${column.name}`);
    const [, raw] = opOf(condition);
    if (isIdentityRef(raw) && !keys.has(raw.identity)) {
      problems.add(`identity_key_unknown:${raw.identity}`);
    }
    return [id, condition];
  });
  return [...problems];
};

/** The names of every column and identity key the stored rules use. */
export const ruleNamesFor = async (
  rules: Array<RuleFilter | null>
): Promise<RuleNames> => {
  const columnIds = new Set<string>();
  const keyIds = new Set<string>();
  for (const rule of rules) {
    if (!rule) continue;
    mapRule(rule, [], (id, condition) => {
      columnIds.add(id);
      const [, raw] = opOf(condition);
      if (isIdentityRef(raw)) keyIds.add(raw.identity);
      return [id, condition];
    });
  }
  if (columnIds.size === 0) return { columns: new Map(), keys: new Map() };
  const [rows, keys] = await Promise.all([
    prisma.sourceColumn.findMany({
      where: { id: { in: [...columnIds] } },
      select: { id: true, name: true, missingSince: true },
    }),
    keyIds.size === 0 ? new Map() : keysById([...keyIds]),
  ]);
  return {
    columns: new Map(
      rows.map((c) => [
        c.id,
        { name: c.name, missing: c.missingSince !== null },
      ])
    ),
    keys,
  };
};
