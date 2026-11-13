import type { OutputColumn, QueryWarning, Reference } from "../types.js";
import type { SqlQueryErrorCode } from "./errors.js";
import type {
  VisibleCatalog,
  VisibleColumn,
  VisibleTable,
} from "../../grants/visibleCatalog.js";
import {
  QueryError,
  notFound,
  notFoundMessage,
  type QueryPath,
} from "../../engine/errors.js";
import type {
  Comparison,
  Condition,
  Filter,
  Operator,
  Scalar,
  SelectItem,
  SqlQuery,
} from "./language.js";
import type {
  AggregateFn,
  ColumnRef,
  HavingSubject,
  PlanValue,
  QueryableType,
  ResolvedFilter,
  ResolvedJoin,
  ResolvedOrder,
  ResolvedSelect,
  SqlPlan,
} from "./types.js";

// Resolves a parsed query against the caller's visible catalogue. The planner
// is given nothing the caller may not see, so a name outside their grants is
// refused exactly as a name that does not exist: every lookup searches only
// the visible catalogue, and every suggestion is drawn from it.

const ALL_OPERATORS: readonly Operator[] = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "isNull",
];
const NOT_TEXT = ALL_OPERATORS.filter(
  (op) => op !== "contains" && op !== "startsWith"
);
const OPERATORS_BY_TYPE: Record<QueryableType, ReadonlySet<Operator>> = {
  text: new Set(ALL_OPERATORS),
  number: new Set(NOT_TEXT),
  date: new Set(NOT_TEXT),
  timestamp: new Set(NOT_TEXT),
  boolean: new Set(["eq", "ne", "isNull"]),
  json: new Set(["isNull"]),
};

const AGGREGATE_FNS: readonly AggregateFn[] = [
  "count",
  "countDistinct",
  "sum",
  "avg",
  "min",
  "max",
];
/** The column types each aggregate takes; `undefined` means any queryable type. */
const AGGREGATE_TYPES: Record<
  AggregateFn,
  readonly QueryableType[] | undefined
> = {
  count: undefined,
  countDistinct: undefined,
  sum: ["number"],
  avg: ["number"],
  min: ["text", "number", "date", "timestamp"],
  max: ["text", "number", "date", "timestamp"],
};

const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

const isCalendarDate = (y: string, m: string, d: string): boolean => {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
};

const VALUE_FORMS: Record<QueryableType, string> = {
  text: "a string",
  number: "a number or a decimal string",
  boolean: "true or false",
  date: "a date, YYYY-MM-DD",
  timestamp: "an ISO 8601 timestamp with an offset or Z",
  json: "no value",
};

/** `value` as a value for a subject of `type`, or undefined when it is not one. */
const coerce = (value: Scalar, type: QueryableType): PlanValue | undefined => {
  switch (type) {
    case "text":
      return typeof value === "string" ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      if (typeof value === "number") return value;
      return typeof value === "string" && DECIMAL.test(value)
        ? value
        : undefined;
    case "date": {
      const m = typeof value === "string" ? DATE.exec(value) : null;
      return m && isCalendarDate(m[1], m[2], m[3]) ? value : undefined;
    }
    case "timestamp": {
      const m = typeof value === "string" ? TIMESTAMP.exec(value) : null;
      const valid =
        m !== null &&
        isCalendarDate(m[1], m[2], m[3]) &&
        Number(m[4]) < 24 &&
        Number(m[5]) < 60 &&
        Number(m[6]) < 60 &&
        (m[9] === undefined || (Number(m[9]) < 24 && Number(m[10]) < 60));
      return valid ? value : undefined;
    }
    case "json":
      return undefined;
  }
};

interface Scope {
  alias: string;
  table: VisibleTable;
}

/** A resolved column and the catalogue column behind it. */
interface Resolved {
  ref: ColumnRef;
  reference: Reference;
}

const referenceKey = (r: Reference) => `${r.tableId}\u0000${r.columnId}`;

/** `customer.account.plan` → relation path `customer.account`, column `plan`. */
const splitPath = (path: string): { prefix: string; last: string } => {
  const at = path.lastIndexOf(".");
  return at < 0
    ? { prefix: "", last: path }
    : { prefix: path.slice(0, at), last: path.slice(at + 1) };
};

const joinPath = (prefix: string, name: string) =>
  prefix === "" ? name : `${prefix}.${name}`;

const fail = (
  code: SqlQueryErrorCode,
  message: string,
  path: QueryPath
): QueryError => new QueryError(code, message, path);

/**
 * A table as a query writes it in `from`: the bare name when no other table
 * of `tables` shares it, else `schema.table`. `resolveFrom` accepts exactly
 * these, and the catalogue prints them.
 */
export const queryNameOf = (
  tables: readonly Pick<VisibleTable, "schemaName" | "name">[],
  table: Pick<VisibleTable, "schemaName" | "name">
): string =>
  tables.filter((t) => t.name === table.name).length === 1
    ? table.name
    : `${table.schemaName}.${table.name}`;

class Planner {
  private readonly scopes = new Map<string, Scope>();
  private readonly references = new Map<string, Reference>();
  private readonly tablesById: Map<string, VisibleTable>;

  constructor(private readonly catalog: VisibleCatalog) {
    this.tablesById = new Map(catalog.tables.map((t) => [t.id, t]));
  }

  private touch(reference: Reference): void {
    this.references.set(referenceKey(reference), reference);
  }

  private displayNames(): string[] {
    return this.catalog.tables.map((t) => queryNameOf(this.catalog.tables, t));
  }

  resolveFrom(name: string): Scope {
    const path = ["from"];
    const bare = this.catalog.tables.filter((t) => t.name === name);
    const matches =
      bare.length > 0
        ? bare
        : this.catalog.tables.filter(
            (t) => `${t.schemaName}.${t.name}` === name
          );
    if (matches.length > 1) {
      throw new QueryError(
        "not_found_or_not_accessible",
        notFoundMessage("table", name),
        path,
        matches.map((t) => `${t.schemaName}.${t.name}`).sort()
      );
    }
    const table = matches[0];
    if (!table) throw notFound("table", name, path, this.displayNames());
    if (table.missing) {
      throw fail(
        "missing_in_source",
        `Table "${name}" is missing from the source`,
        path
      );
    }
    const scope = { alias: "t0", table };
    this.scopes.set("", scope);
    return scope;
  }

  /** The key column `name` of a relation's table; the relation is unusable without it. */
  private keyColumn(
    table: VisibleTable,
    name: string,
    relationPath: string,
    path: QueryPath,
    candidates: () => string[]
  ): VisibleColumn {
    const column = table.columns.find((c) => c.name === name);
    // A visible relation's keys are all granted, so this is drift between the
    // relation and the catalogue; it fails as an unusable relation.
    if (!column) throw notFound("relation", relationPath, path, candidates());
    if (column.missing) {
      throw fail(
        "missing_in_source",
        `A key column of "${relationPath}" is missing from the source`,
        path
      );
    }
    return column;
  }

  resolveJoin(
    relationPath: string,
    type: ResolvedJoin["type"],
    alias: string,
    path: QueryPath
  ): { join: ResolvedJoin; toMany: boolean } {
    const { prefix, last } = splitPath(relationPath);
    const parent = this.scopes.get(prefix);
    if (!parent) {
      throw fail(
        "join_parent_missing",
        `Join "${prefix}" before "${relationPath}"`,
        path
      );
    }
    const fromParent = this.catalog.relations.filter(
      (r) => r.fromTableId === parent.table.id
    );
    const candidates = () => fromParent.map((r) => joinPath(prefix, r.name));
    const relation = fromParent.find((r) => r.name === last);
    const target = relation && this.tablesById.get(relation.toTableId);
    if (!relation || !target) {
      throw notFound("relation", relationPath, path, candidates());
    }
    if (relation.missing || target.missing) {
      throw fail(
        "missing_in_source",
        `Relation "${relationPath}" is missing from the source`,
        path
      );
    }
    const on: ResolvedJoin["on"] = relation.fromColumns.map((fromName, i) => {
      const toName = relation.toColumns[i];
      const from = this.keyColumn(
        parent.table,
        fromName,
        relationPath,
        path,
        candidates
      );
      const to = this.keyColumn(target, toName, relationPath, path, candidates);
      this.touch({ tableId: parent.table.id, columnId: from.id });
      this.touch({ tableId: target.id, columnId: to.id });
      return [parent.alias, from.name, to.name];
    });
    this.scopes.set(relationPath, { alias, table: target });
    return {
      join: {
        alias,
        relation: relationPath,
        table: { schemaName: target.schemaName, name: target.name },
        type,
        on,
      },
      toMany: relation.toMany,
    };
  }

  resolveColumn(columnPath: string, path: QueryPath): Resolved {
    const { prefix, last } = splitPath(columnPath);
    const scope = this.scopes.get(prefix);
    if (!scope) {
      const joined = [...this.scopes.keys()].filter((k) => k !== "");
      throw notFound("relation", prefix, path, joined);
    }
    const column = scope.table.columns.find((c) => c.name === last);
    if (!column) {
      throw notFound(
        "column",
        columnPath,
        path,
        scope.table.columns.map((c) => joinPath(prefix, c.name))
      );
    }
    if (column.missing) {
      throw fail(
        "missing_in_source",
        `Column "${columnPath}" is missing from the source`,
        path
      );
    }
    if (column.type === "other") {
      throw fail(
        "column_not_queryable",
        `Column "${columnPath}" has a type that cannot be queried`,
        path
      );
    }
    const reference = { tableId: scope.table.id, columnId: column.id };
    this.touch(reference);
    return {
      ref: {
        alias: scope.alias,
        name: column.name,
        type: column.type,
        nativeType: column.nativeType,
      },
      reference,
    };
  }

  referenceList(): Reference[] {
    return [...this.references.values()];
  }
}

/** One condition on a subject of `type`: the operator checked, the value coerced. */
const resolveCondition = <S>(
  subject: S,
  type: QueryableType,
  label: string,
  condition: Condition,
  path: QueryPath
): ResolvedFilter<S> => {
  const [op, raw] = Object.entries(condition)[0] as [Operator, unknown];
  const at = [...path, op];
  if (!OPERATORS_BY_TYPE[type].has(op)) {
    throw fail(
      "invalid_operator",
      `${op} does not apply to "${label}", a ${type} column`,
      at
    );
  }
  const value = (v: Scalar, valuePath: QueryPath): PlanValue => {
    const coerced = coerce(v, type);
    if (coerced === undefined) {
      throw fail(
        "invalid_value",
        `"${label}" is ${type}; ${op} takes ${VALUE_FORMS[type]}`,
        valuePath
      );
    }
    return coerced;
  };
  switch (op) {
    case "isNull":
      return { kind: "isNull", subject, isNull: raw as boolean };
    case "contains":
    case "startsWith":
      return { kind: "match", op, subject, value: raw as string };
    case "between": {
      const [low, high] = raw as [Scalar, Scalar];
      return {
        kind: "between",
        subject,
        low: value(low, [...at, 0]),
        high: value(high, [...at, 1]),
      };
    }
    case "in":
    case "notIn":
      return {
        kind: "in",
        op,
        subject,
        values: (raw as Scalar[]).map((v, i) => value(v, [...at, i])),
      };
    default:
      return { kind: "compare", op, subject, value: value(raw as Scalar, at) };
  }
};

/** A filter tree, each path resolved by `subjectOf`. */
const resolveFilter = <S>(
  filter: Filter,
  path: QueryPath,
  subjectOf: (
    key: string,
    path: QueryPath
  ) => { subject: S; type: QueryableType }
): ResolvedFilter<S> => {
  if ("and" in filter && Array.isArray(filter.and)) {
    return {
      kind: "and",
      filters: (filter.and as Filter[]).map((f, i) =>
        resolveFilter(f, [...path, "and", i], subjectOf)
      ),
    };
  }
  if ("or" in filter && Array.isArray(filter.or)) {
    return {
      kind: "or",
      filters: (filter.or as Filter[]).map((f, i) =>
        resolveFilter(f, [...path, "or", i], subjectOf)
      ),
    };
  }
  if ("not" in filter) {
    return {
      kind: "not",
      filter: resolveFilter(filter.not as Filter, [...path, "not"], subjectOf),
    };
  }
  const leaves = Object.entries(filter as Comparison).map(
    ([key, condition]) => {
      const at = [...path, key];
      const { subject, type } = subjectOf(key, at);
      return resolveCondition(subject, type, key, condition, at);
    }
  );
  return leaves.length === 1 ? leaves[0] : { kind: "and", filters: leaves };
};

// Postgres `json` has no equality operator, so a json value cannot be
// compared, grouped, deduplicated or sorted.
const refuseJson = (
  type: QueryableType,
  label: string,
  use: string,
  path: QueryPath
): void => {
  if (type === "json") {
    throw fail(
      "invalid_operator",
      `"${label}" is json, which cannot be used in ${use}`,
      path
    );
  }
};

const aggregateFnOf = (
  item: Exclude<SelectItem, string>
): AggregateFn | undefined => AGGREGATE_FNS.find((fn) => fn in item);

/** Resolves `query` against `catalog`, the caller's view of the source. */
export const planSql = (query: SqlQuery, catalog: VisibleCatalog): SqlPlan => {
  const planner = new Planner(catalog);
  const from = planner.resolveFrom(query.from);

  const joins: ResolvedJoin[] = [];
  const toManyJoins: Array<{ relation: string; path: QueryPath }> = [];
  (query.join ?? []).forEach((item, i) => {
    const relation = typeof item === "string" ? item : item.relation;
    const type = typeof item === "string" ? "inner" : (item.type ?? "inner");
    const path =
      typeof item === "string" ? ["join", i] : ["join", i, "relation"];
    const { join, toMany } = planner.resolveJoin(
      relation,
      type,
      `t${i + 1}`,
      path
    );
    joins.push(join);
    if (toMany) toManyJoins.push({ relation, path: ["join", i] });
  });

  const select: ResolvedSelect[] = [];
  const columns: OutputColumn[] = [];
  /** Per select item, the column path it reads, for groupBy by path. */
  const selectPaths: Array<string | undefined> = [];
  query.select.forEach((item, i) => {
    let resolved: ResolvedSelect;
    let references: Reference[] = [];
    let columnPath: string | undefined;
    let outputPath: QueryPath = ["select", i];
    if (typeof item === "string") {
      const { ref, reference } = planner.resolveColumn(item, ["select", i]);
      resolved = { kind: "column", column: ref, output: item, type: ref.type };
      references = [reference];
      columnPath = item;
    } else if ("bucket" in item) {
      const { ref, reference } = planner.resolveColumn(item.column, [
        "select",
        i,
        "column",
      ]);
      if (ref.type !== "date" && ref.type !== "timestamp") {
        throw fail(
          "invalid_operator",
          `A bucket needs a date or timestamp column; "${item.column}" is ${ref.type}`,
          ["select", i, "column"]
        );
      }
      resolved = {
        kind: "bucket",
        unit: item.bucket,
        column: ref,
        output: item.as ?? `${item.bucket}_${item.column.replaceAll(".", "_")}`,
        type: ref.type,
      };
      references = [reference];
      columnPath = item.column;
      if (item.as) outputPath = ["select", i, "as"];
    } else {
      const fn = aggregateFnOf(item)!;
      const arg = (item as Record<AggregateFn, string>)[fn];
      let column: ColumnRef | "*" = "*";
      let type: QueryableType = "number";
      if (!(fn === "count" && arg === "*")) {
        const { ref, reference } = planner.resolveColumn(arg, [
          "select",
          i,
          fn,
        ]);
        if (fn === "countDistinct") {
          refuseJson(ref.type, arg, "countDistinct", ["select", i, fn]);
        }
        const allowed = AGGREGATE_TYPES[fn];
        if (allowed && !allowed.includes(ref.type)) {
          throw fail(
            "invalid_operator",
            `${fn} needs a ${allowed.join(", ")} column; "${arg}" is ${ref.type}`,
            ["select", i, fn]
          );
        }
        column = ref;
        if (fn === "min" || fn === "max") type = ref.type;
        references = [reference];
      }
      resolved = {
        kind: "aggregate",
        fn,
        column,
        output:
          item.as ??
          (column === "*" ? "count" : `${fn}_${arg.replaceAll(".", "_")}`),
        type,
      };
      if (item.as) outputPath = ["select", i, "as"];
    }
    if (select.some((s) => s.output === resolved.output)) {
      throw fail(
        "duplicate_output_name",
        `Two select items are named "${resolved.output}"; give one an "as"`,
        outputPath
      );
    }
    select.push(resolved);
    columns.push({ name: resolved.output, type: resolved.type, references });
    selectPaths.push(columnPath);
  });

  const distinct = query.distinct ?? false;
  if (distinct) {
    select.forEach((s, i) =>
      refuseJson(s.type, s.output, "a distinct query", ["select", i])
    );
  }

  const outputIndex = (name: string) =>
    select.findIndex((s) => s.output === name);
  const hasAggregate = select.some((s) => s.kind === "aggregate");

  const where =
    query.where &&
    resolveFilter<ColumnRef>(query.where, ["where"], (key, at) => {
      const { ref } = planner.resolveColumn(key, at);
      return { subject: ref, type: ref.type };
    });

  const grouped = hasAggregate || (query.groupBy?.length ?? 0) > 0;
  const groupedItems = new Set<number>();
  query.groupBy?.forEach((entry, j) => {
    const named = outputIndex(entry);
    if (named >= 0) {
      if (select[named].kind === "aggregate") {
        throw fail(
          "invalid_grouping",
          `"${entry}" is an aggregate; group by the items beside it`,
          ["groupBy", j]
        );
      }
      refuseJson(select[named].type, entry, "groupBy", ["groupBy", j]);
      groupedItems.add(named);
      return;
    }
    const byPath = select
      .map((s, i) =>
        s.kind !== "aggregate" && selectPaths[i] === entry ? i : -1
      )
      .filter((i) => i >= 0);
    if (byPath.length === 0) {
      throw fail(
        "invalid_grouping",
        `"${entry}" is not a select item; groupBy names select items`,
        ["groupBy", j]
      );
    }
    byPath.forEach((i) => {
      refuseJson(select[i].type, entry, "groupBy", ["groupBy", j]);
      groupedItems.add(i);
    });
  });
  if (grouped) {
    select.forEach((s, i) => {
      if (s.kind !== "aggregate" && !groupedItems.has(i)) {
        throw fail(
          "invalid_grouping",
          `"${s.output}" must be in groupBy or be an aggregate`,
          ["select", i]
        );
      }
    });
  }

  if (query.having && !hasAggregate) {
    throw fail("invalid_having", "having needs an aggregate in select", [
      "having",
    ]);
  }
  const having =
    query.having &&
    resolveFilter<HavingSubject>(query.having, ["having"], (key, at) => {
      const index = outputIndex(key);
      if (index < 0 || select[index].kind !== "aggregate") {
        throw fail(
          "invalid_having",
          `"${key}" is not the name of an aggregate select item`,
          at
        );
      }
      return {
        subject: { index, type: select[index].type },
        type: select[index].type,
      };
    });

  const orderBy: ResolvedOrder[] = query.orderBy
    ? query.orderBy.map((entry, j) => {
        const [key, direction] = Object.entries(entry)[0];
        const at = ["orderBy", j, key];
        const index = outputIndex(key);
        if (index >= 0) {
          refuseJson(select[index].type, key, "orderBy", at);
          return { target: { kind: "output", index }, direction };
        }
        if (grouped || distinct) {
          throw fail(
            "invalid_order",
            `"${key}" is not a select item; a grouped or distinct query orders only by its select items`,
            at
          );
        }
        const { ref } = planner.resolveColumn(key, at);
        refuseJson(ref.type, key, "orderBy", at);
        return { target: { kind: "column", column: ref }, direction };
      })
    : select.flatMap((s, index) =>
        s.type === "json"
          ? []
          : [{ target: { kind: "output", index }, direction: "asc" }]
      );

  const warnings: QueryWarning[] = hasAggregate
    ? toManyJoins.map(({ relation, path }) => ({
        code: "join_multiplies_rows",
        message: `"${relation}" can match several rows per row it joins to, so aggregates may count a row more than once`,
        path,
      }))
    : [];

  return {
    from: {
      alias: "t0",
      schemaName: from.table.schemaName,
      name: from.table.name,
    },
    joins,
    select,
    distinct,
    where,
    groupBy: grouped
      ? select.flatMap((s, i) => (s.kind === "aggregate" ? [] : [i]))
      : [],
    having,
    orderBy,
    references: planner.referenceList(),
    columns,
    warnings,
    limit: query.limit,
    offset: query.offset ?? 0,
  };
};
