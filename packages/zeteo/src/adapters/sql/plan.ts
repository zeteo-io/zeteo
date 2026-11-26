import type { SqlQueryErrorCode } from "./errors.js";
import { aggregatesRows } from "./aggregates.js";
import type {
  VisibleCatalog,
  VisibleColumn,
  VisibleMeasure,
  VisibleTable,
} from "../../grants/visibleCatalog.js";
import {
  addBusinessDays,
  businessDays,
  businessDaysBetween,
  businessDaysElapsed,
  businessDaysIn,
  businessDaysRemaining,
  compiledCalendar,
  windowedLocalDate,
  type BusinessUnit,
  type Calendar,
  type CompiledCalendar,
  type ZoneWindow,
} from "../../calendar/calendar.js";
import {
  QueryError,
  notFound,
  notFoundMessage,
  rowRuleUnavailable,
  type QueryPath,
} from "../../engine/errors.js";
import {
  MAX_EXPANDED_NODES,
  MAX_FIXED_MEASURES,
  MAX_MEASURE_NESTING,
  MeasureError,
  expandMeasure,
} from "./measures.js";
import {
  floorToMinute,
  isRelativeDate,
  resolveRelative,
  resolveRelativeDate,
} from "./relative.js";
import type {
  CalcExpr,
  CalcOp,
  Compared,
  DateAddUnit,
  DatePart,
  PeriodUnit,
  Comparison,
  Condition,
  Filter,
  Operator,
  Scalar,
  SelectItem,
  SqlQuery,
  DateDiffUnit,
} from "./language.js";
import type {
  OutputColumn,
  PlanContext,
  QueryWarning,
  Reference,
} from "../types.js";
import type {
  AggregateFn,
  ColumnRef,
  FilterValue,
  HavingSubject,
  PlanValue,
  QueryableType,
  ResolvedFilter,
  ResolvedExpr,
  ResolvedJoin,
  ResolvedOrder,
  ResolvedSelect,
  BusinessDate,
  RowFiltered,
  RuleSubject,
  ScalarExpr,
  TablePlan,
  WhereSubject,
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
const DATES: readonly Operator[] = [...NOT_TEXT, "isBusinessDay"];
const OPERATORS_BY_TYPE: Record<QueryableType, ReadonlySet<Operator>> = {
  text: new Set(ALL_OPERATORS),
  number: new Set(NOT_TEXT),
  date: new Set(DATES),
  timestamp: new Set(DATES),
  boolean: new Set(["eq", "ne", "isNull"]),
  json: new Set(["isNull"]),
};

/** Whether `op` applies to a subject of `type`: the planner's check, shared with row rules. */
export const operatorApplies = (type: QueryableType, op: Operator): boolean =>
  OPERATORS_BY_TYPE[type].has(op);

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

export const VALUE_FORMS: Record<QueryableType, string> = {
  text: "a string",
  number: "a number or a decimal string",
  boolean: "true or false",
  date: "a date, YYYY-MM-DD",
  timestamp: "an ISO 8601 timestamp with an offset or Z",
  json: "no value",
};

/** `value` as a value for a subject of `type`, or undefined when it is not one. */
export const coerceValue = (
  value: Scalar,
  type: QueryableType
): PlanValue | undefined => {
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

/** A resolved calculation and what decides its level. */
interface CaseOperand {
  when: { if: Filter; then: CalcExpr }[];
  else?: CalcExpr;
}

export interface ResolvedCalc {
  resolved: ResolvedExpr;
  hasAggregate: boolean;
  /** Holds a fixed measure outside any aggregate: one value per query. */
  hasFixed?: boolean;
  /** The first column read outside any aggregate. */
  bareColumn?: { path: string; at: QueryPath };
}

/** The operand types each operation takes, and the type it yields. */
const OP_TYPES: Record<
  Exclude<CalcOp, "coalesce">,
  { takes: readonly QueryableType[]; yields: "number" | "text" }
> = {
  add: { takes: ["number"], yields: "number" },
  sub: { takes: ["number"], yields: "number" },
  mul: { takes: ["number"], yields: "number" },
  div: { takes: ["number"], yields: "number" },
  abs: { takes: ["number"], yields: "number" },
  round: { takes: ["number"], yields: "number" },
  lower: { takes: ["text"], yields: "text" },
  upper: { takes: ["text"], yields: "text" },
  concat: { takes: ["text", "number"], yields: "text" },
};

export const typeOf = (e: ResolvedExpr): QueryableType =>
  e.kind === "column" ? e.column.type : e.type;

export const referenceKey = (r: Reference) => `${r.tableId}\u0000${r.columnId}`;

/** `customer.account.plan` → relation path `customer.account`, column `plan`. */
const splitPath = (path: string): { prefix: string; last: string } => {
  const at = path.lastIndexOf(".");
  return at < 0
    ? { prefix: "", last: path }
    : { prefix: path.slice(0, at), last: path.slice(at + 1) };
};

const joinPath = (prefix: string, name: string) =>
  prefix === "" ? name : `${prefix}.${name}`;

/**
 * A row rule's refusal, which passes through a measure's or metric's own
 * wrapping unchanged: it is about the caller's access, not the definition.
 */
export const isRowRuleRefusal = (err: unknown): boolean =>
  err instanceof QueryError && err.code === "row_rule_unavailable";

export const fail = (
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

/**
 * What one query and the fixed measures' subqueries in it share: the columns
 * read, the expansion budget and the fixed measures planned so far.
 */
export interface QueryState {
  references: Map<string, Reference>;
  expandedNodes: number;
  /** Each fixed measure is planned once per query, by name. */
  fixed: Map<string, ScalarExpr>;
  /** The fixed measures being planned, outermost first. */
  fixedStack: string[];
  /** Per fixed measure planned: the subqueries one use compiles to, its nested ones included. */
  fixedWeight: Map<string, number>;
  /** Per fixed measure planned: the columns it reads, merged into every use's reads. */
  fixedReads: Map<string, Map<string, Reference>>;
  /** The subqueries the fixed measures used so far compile to, at most `MAX_FIXED_MEASURES`. */
  subqueries: number;
  /** Whether a row rule limits a table read anywhere in the query, fixed measures and metric parts included. */
  rowsLimited: boolean;
}

/** The values a filter compares with besides literals: relative dates and fixed measures. */
interface ValueContext {
  now: Date;
  calendar: Calendar;
  /** The calendar as `isBusinessDay` binds it; absent where rows are not filtered (`having`). */
  compiled?: () => CompiledCalendar;
  /** `{ measure: name }` at `path`, compared with a subject of `type`. */
  measure: (name: string, path: QueryPath, type: QueryableType) => ScalarExpr;
}

/** What a business-day function computes, before its operands are resolved. */
type BusinessShape =
  | { kind: "businessDays"; fn: "inclusive" | "between" }
  | {
      kind: "businessPeriod";
      fn: "in" | "elapsed" | "remaining";
      unit: BusinessUnit;
    }
  | { kind: "addBusinessDays" };

const BUSINESS_KEYS = new Set([
  "businessDays",
  "businessDaysBetween",
  "businessDaysIn",
  "businessDaysInMonth",
  "businessDaysElapsed",
  "businessDaysRemaining",
  "addBusinessDays",
]);

/** A business-day operation's shape, and its date (and amount) operands with their paths. */
const businessShape = (
  key: string,
  operand: unknown,
  at: QueryPath
): {
  shape: BusinessShape;
  dates: Array<[CalcExpr, QueryPath]>;
  amount?: [CalcExpr, QueryPath];
} => {
  const list = operand as CalcExpr[];
  const pair = (): Array<[CalcExpr, QueryPath]> => [
    [list[0]!, [...at, 0]],
    [list[1]!, [...at, 1]],
  ];
  /** A date (its month), or `[unit, date]`. */
  const inPeriod = (): { unit: BusinessUnit; date: [CalcExpr, QueryPath] } =>
    Array.isArray(operand)
      ? { unit: list[0] as unknown as PeriodUnit, date: [list[1]!, [...at, 1]] }
      : { unit: "month", date: [operand as CalcExpr, at] };
  switch (key) {
    case "businessDays":
    case "businessDaysBetween":
      return {
        shape: {
          kind: "businessDays",
          fn: key === "businessDays" ? "inclusive" : "between",
        },
        dates: pair(),
      };
    case "addBusinessDays":
      return {
        shape: { kind: "addBusinessDays" },
        dates: [[list[0]!, [...at, 0]]],
        amount: [list[1]!, [...at, 1]],
      };
    default: {
      const { unit, date } = inPeriod();
      const fn =
        key === "businessDaysElapsed"
          ? "elapsed"
          : key === "businessDaysRemaining"
            ? "remaining"
            : "in";
      return {
        shape: { kind: "businessPeriod", fn, unit },
        dates: [date],
      };
    }
  }
};

/** A query's shared state before anything is planned. */
export const newQueryState = (): QueryState => ({
  references: new Map(),
  expandedNodes: 0,
  fixed: new Map(),
  fixedStack: [],
  fixedWeight: new Map(),
  fixedReads: new Map(),
  subqueries: 0,
  rowsLimited: false,
});

export class Planner {
  /** The query's own scopes: its `from` and its joins. */
  private readonly scopes = new Map<string, Scope>();
  /**
   * The joins measures added, by relation path. Seen only while a measure's
   * expansion is resolved, so a query never reads through a join it did not
   * make, and its validity never depends on a measure's definition.
   */
  private readonly measureScopes = new Map<string, Scope>();
  /** Whether a measure's expansion is being resolved. */
  private inMeasure = false;
  private readonly tablesById: Map<string, VisibleTable>;
  private readonly measures: Map<string, VisibleMeasure>;
  /** The plan's joins: the query's own, then those its measures add. */
  readonly joins: ResolvedJoin[] = [];
  /** The first of the query's own joins that can repeat rows, if any. */
  toManyJoin: string | undefined;
  /** The values filters compare with, for `resolveFilter`. */
  readonly values: ValueContext;
  /** The values a row rule compares with: as a filter's, but never a measure. */
  private readonly ruleValues: ValueContext;

  constructor(
    private readonly catalog: VisibleCatalog,
    private readonly now: Date,
    private readonly state: QueryState = newQueryState(),
    /** Before every alias: empty for the query, `f1_`… in a fixed measure's subquery. */
    private readonly aliasPrefix = ""
  ) {
    this.tablesById = new Map(catalog.tables.map((t) => [t.id, t]));
    this.measures = new Map(catalog.measures.map((m) => [m.name, m]));
    this.values = {
      now,
      calendar: catalog.calendar,
      compiled: () => compiledCalendar(catalog.calendar, now),
      measure: (name, path, type) => this.fixedValue(name, path, type),
    };
    this.ruleValues = {
      ...this.values,
      measure: (_name, path) => {
        throw fail(
          "invalid_value",
          "A row rule compares with no measure",
          path
        );
      },
    };
  }

  /** Whether a row rule limits a table read anywhere in the query so far. */
  rowsLimited(): boolean {
    return this.state.rowsLimited;
  }

  /**
   * The caller's row rule on `table`, as the plan carries it wherever the
   * table is read: resolved like a filter against the plan's `now` and the
   * calendar, its columns read from the rule by id (never from the caller's
   * grants, so they are never references and never suggested). A rule that
   * keeps no row is `never`. A rule that cannot be applied, or no longer
   * fits its columns, refuses the query at `path`: the table is never read
   * unfiltered.
   */
  private rowFilterOf(table: VisibleTable, path: QueryPath): RowFiltered {
    const rule = table.rowRule;
    if (!rule) return {};
    this.state.rowsLimited = true;
    const refuse = () =>
      rowRuleUnavailable(
        queryNameOf(this.catalog.tables, table),
        path,
        rule.kind === "unavailable" ? rule.reason : undefined
      );
    const rowRuleAt = {
      table: queryNameOf(this.catalog.tables, table),
      path: [...path],
    };
    if (rule.kind === "never") {
      return { rowFilter: { kind: "never" }, rowRuleAt };
    }
    if (rule.kind === "unavailable") throw refuse();
    const subjectOf = (columnId: string) => {
      const column = rule.columns.get(columnId);
      if (!column) throw refuse();
      const subject: RuleSubject = {
        name: column.name,
        type: column.type,
        nativeType: column.nativeType,
      };
      return { subject, type: column.type };
    };
    try {
      return {
        rowFilter: resolveFilter<RuleSubject>(
          rule.filter as Filter,
          [],
          subjectOf,
          this.ruleValues
        ),
        rowRuleAt,
      };
    } catch (err) {
      if (err instanceof QueryError) throw refuse();
      throw err;
    }
  }

  /** The scope at `prefix`: the query's own, then, inside a measure, a measure's. */
  private scopeOf(prefix: string): Scope | undefined {
    return (
      this.scopes.get(prefix) ??
      (this.inMeasure ? this.measureScopes.get(prefix) : undefined)
    );
  }

  private touch(reference: Reference): void {
    this.state.references.set(referenceKey(reference), reference);
  }

  private displayNames(): string[] {
    return this.catalog.tables.map((t) => queryNameOf(this.catalog.tables, t));
  }

  resolveFrom(name: string): Scope & RowFiltered {
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
    return { ...scope, ...this.rowFilterOf(table, path) };
  }

  /**
   * `table` as the `from` of a query the planner makes itself (a metric
   * query's part), alias `t0`. A missing table cannot be read.
   */
  fromTable(table: VisibleTable, path: QueryPath): Scope & RowFiltered {
    if (table.missing) {
      throw fail(
        "missing_in_source",
        `Table "${queryNameOf(this.catalog.tables, table)}" is missing from the source`,
        path
      );
    }
    const scope = { alias: "t0", table };
    this.scopes.set("", scope);
    return { ...scope, ...this.rowFilterOf(table, path) };
  }

  /**
   * A column path of a measure's definition (its date column), from the
   * `from` table: each relation on the way is joined as a measure's joins
   * are, a to-one left join after the others, and the column is read through
   * them.
   */
  resolveMeasureColumn(columnPath: string, path: QueryPath): Resolved {
    const segments = columnPath.split(".");
    this.inMeasure = true;
    try {
      for (let i = 1; i < segments.length; i++) {
        this.joinForMeasure(segments.slice(0, i).join("."), path);
      }
      return this.resolveColumn(columnPath, path);
    } finally {
      this.inMeasure = false;
    }
  }

  /** Fixed measure `measure` at `at`, alone: its scalar subquery, from no table of the query's. */
  resolveFixedMeasure(
    measure: VisibleMeasure,
    at: QueryPath,
    reads: Map<string, Reference>
  ): ResolvedCalc {
    return this.resolveFixed(measure, at, reads);
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
    const parent = this.scopeOf(prefix);
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
    const rows = this.rowFilterOf(target, path);
    (this.inMeasure ? this.measureScopes : this.scopes).set(relationPath, {
      alias,
      table: target,
    });
    return {
      join: {
        alias,
        relation: relationPath,
        table: { schemaName: target.schemaName, name: target.name },
        type,
        on,
        ...rows,
      },
      toMany: relation.toMany,
    };
  }

  resolveColumn(columnPath: string, path: QueryPath): Resolved {
    const { prefix, last } = splitPath(columnPath);
    const scope = this.scopeOf(prefix);
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

  /** Whether `columnPath` names a column the caller can see, without touching it. */
  hasColumn(columnPath: string): boolean {
    const { prefix, last } = splitPath(columnPath);
    return (
      this.scopes.get(prefix)?.table.columns.some((c) => c.name === last) ??
      false
    );
  }

  /**
   * A calculation at `at`, every column it reads resolved (and added to
   * `reads`) as a plain path is. Types are checked on the way up; an operand's
   * refusal carries its own path.
   */
  resolveExpr(
    expr: CalcExpr,
    at: QueryPath,
    reads: Map<string, Reference>,
    insideAggregate = false
  ): ResolvedCalc {
    if (typeof expr === "string") {
      const { ref, reference } = this.resolveColumn(expr, at);
      reads.set(referenceKey(reference), reference);
      return {
        resolved: { kind: "column", column: ref },
        hasAggregate: false,
        bareColumn: insideAggregate ? undefined : { path: expr, at },
      };
    }
    if (typeof expr === "number") {
      return {
        resolved: { kind: "literal", value: expr, type: "number" },
        hasAggregate: false,
      };
    }
    if ("value" in expr) {
      return {
        resolved: { kind: "literal", value: expr.value, type: "text" },
        hasAggregate: false,
      };
    }
    if ("date" in expr || "timestamp" in expr) {
      const type = "date" in expr ? "date" : "timestamp";
      const given = "date" in expr ? expr.date : expr.timestamp;
      const value = coerceValue(given, type);
      if (value === undefined) {
        throw fail(
          "invalid_value",
          `A ${type} literal is ${VALUE_FORMS[type]}`,
          [...at, type]
        );
      }
      return {
        resolved: { kind: "literal", value: value as string, type },
        hasAggregate: false,
      };
    }
    if ("relative" in expr) {
      return {
        resolved: {
          kind: "literal",
          value: resolveRelativeDate(expr, this.now, this.catalog.calendar),
          type: "date",
        },
        hasAggregate: false,
      };
    }
    if ("measure" in expr) {
      return this.resolveMeasure(
        expr.measure,
        [...at, "measure"],
        reads,
        insideAggregate
      );
    }
    const [key, operand] = Object.entries(expr)[0] as [string, unknown];
    const keyAt = [...at, key];
    if (key === "datePart" && (operand as unknown[])[0] === "business_day") {
      return this.resolveBusiness(
        { kind: "businessPeriod", fn: "elapsed", unit: "month" },
        [[(operand as CalcExpr[])[1]!, [...keyAt, 1]]],
        undefined,
        key,
        reads,
        insideAggregate
      );
    }
    if (key === "dateAdd" || key === "dateDiff" || key === "datePart") {
      return this.resolveDateOp(
        key,
        operand as unknown[],
        keyAt,
        reads,
        insideAggregate
      );
    }
    if (key === "businessDaysInPeriod") {
      throw fail(
        "invalid_operator",
        "businessDaysInPeriod is for a metric's formula only; in a query, use businessDaysIn",
        keyAt
      );
    }
    if (BUSINESS_KEYS.has(key)) {
      const { shape, dates, amount } = businessShape(key, operand, keyAt);
      return this.resolveBusiness(
        shape,
        dates,
        amount,
        key,
        reads,
        insideAggregate
      );
    }
    if (key === "case") {
      return this.resolveCase(
        operand as CaseOperand,
        keyAt,
        reads,
        insideAggregate
      );
    }
    if (AGGREGATE_FNS.includes(key as AggregateFn)) {
      return {
        resolved: this.resolveAggregate(
          key as AggregateFn,
          operand as CalcExpr,
          keyAt,
          reads
        ),
        hasAggregate: true,
      };
    }

    const op = key as CalcOp;
    let places: number | undefined;
    let operands: Array<[CalcExpr, QueryPath]>;
    if (Array.isArray(operand)) {
      if (op === "round") {
        const [value, p] = operand as [CalcExpr, number];
        operands = [[value, [...keyAt, 0]]];
        places = p;
      } else {
        operands = (operand as CalcExpr[]).map((e, i) => [e, [...keyAt, i]]);
      }
    } else {
      operands = [[operand as CalcExpr, keyAt]];
      if (op === "round") places = 0;
    }
    const resolvedOperands = operands.map(([e, p]) => ({
      ...this.resolveExpr(e, p, reads, insideAggregate),
      at: p,
      label: typeof e === "string" ? `"${e}"` : "the operand",
    }));

    let type: QueryableType;
    if (op === "coalesce") {
      type = typeOf(resolvedOperands[0].resolved);
      for (const o of resolvedOperands.slice(1)) {
        const t = typeOf(o.resolved);
        if (t !== type) {
          throw fail(
            "invalid_operator",
            `coalesce takes operands of one type; ${o.label} is ${t}, not ${type}`,
            o.at
          );
        }
      }
    } else {
      const { takes, yields } = OP_TYPES[op];
      for (const o of resolvedOperands) {
        const t = typeOf(o.resolved);
        if (!takes.includes(t)) {
          throw fail(
            "invalid_operator",
            `${op} needs ${takes.join(" or ")}; ${o.label} is ${t}`,
            o.at
          );
        }
      }
      type = yields;
    }

    return {
      resolved: {
        kind: "op",
        op,
        args: resolvedOperands.map((o) => o.resolved),
        ...(places === undefined ? {} : { places }),
        type: type as "number" | "text",
      },
      hasAggregate: resolvedOperands.some((o) => o.hasAggregate),
      hasFixed: resolvedOperands.some((o) => o.hasFixed),
      bareColumn: resolvedOperands.find((o) => o.bareColumn)?.bareColumn,
    };
  }

  /**
   * `{ measure: name }` at `at`: the measure's expansion, resolved as an
   * expression of the query. A measure the caller may not use, or one of
   * another table, is not found, exactly as one that does not exist. Every
   * error inside the expansion is reported at `at`, naming the measure, and
   * never points into a definition the caller did not write.
   */
  private resolveMeasure(
    name: string,
    at: QueryPath,
    reads: Map<string, Reference>,
    insideAggregate: boolean
  ): ResolvedCalc {
    const from = this.scopes.get("")!;
    const measure = this.measures.get(name);
    if (measure?.fixed) return this.resolveFixed(measure, at, reads);
    if (!measure || measure.tableId !== from.table.id) {
      const usable = this.catalog.measures
        .filter((m) => m.fixed || m.tableId === from.table.id)
        .map((m) => m.name);
      throw notFound("measure", name, at, usable);
    }
    if (insideAggregate) {
      throw fail(
        "invalid_operator",
        "An aggregate does not contain another aggregate",
        at
      );
    }
    const home = queryNameOf(this.catalog.tables, from.table);
    if (this.toManyJoin !== undefined) {
      throw fail(
        "measure_needs_single_rows",
        `${name} counts each ${home} row once; this query's join of ${this.toManyJoin} repeats rows. Query from ${home} without it.`,
        at
      );
    }
    try {
      const expansion = expandMeasure(name, from.table.id, this.measures);
      this.state.expandedNodes += expansion.nodes;
      if (this.state.expandedNodes > MAX_EXPANDED_NODES) {
        throw new MeasureError(
          "too_complex",
          `A query's measures expand to at most ${MAX_EXPANDED_NODES} operations and aggregates`
        );
      }
      let calc: ResolvedCalc;
      this.inMeasure = true;
      try {
        for (const relationPath of expansion.relationPaths) {
          this.joinForMeasure(relationPath, at);
        }
        calc = this.resolveExpr(expansion.expr, at, reads);
      } finally {
        this.inMeasure = false;
      }
      if (!calc.hasAggregate || calc.bareColumn) {
        throw new MeasureError(
          "measure_not_aggregate",
          "A measure must be group-level: every column it reads inside an aggregate"
        );
      }
      return { resolved: calc.resolved, hasAggregate: true };
    } catch (err) {
      if (isRowRuleRefusal(err)) throw err;
      if (err instanceof MeasureError || err instanceof QueryError) {
        throw new QueryError(err.code, `Measure "${name}": ${err.message}`, at);
      }
      throw err;
    }
  }

  /**
   * Fixed measure `measure` at `at`: its own query over its home table, a
   * scalar subquery with its own aliases and joins, planned once per query.
   * The query's joins, filters and grouping never reach it, so it reads no
   * row of the query and is usable from any table and inside an aggregate.
   */
  private resolveFixed(
    measure: VisibleMeasure,
    at: QueryPath,
    reads: Map<string, Reference>
  ): ResolvedCalc {
    const { name } = measure;
    try {
      const known = this.state.fixed.get(name);
      if (known) {
        this.countSubqueries(this.state.fixedWeight.get(name)!);
        for (const [key, ref] of this.state.fixedReads.get(name)!) {
          reads.set(key, ref);
        }
        return { resolved: known, hasAggregate: false, hasFixed: true };
      }
      const stack = this.state.fixedStack;
      if (stack.includes(name)) {
        throw new MeasureError(
          "measure_cycle",
          `"${name}" uses itself: ${[...stack, name].join(" → ")}`
        );
      }
      if (stack.length > MAX_MEASURE_NESTING) {
        throw new MeasureError(
          "measure_too_deep",
          `Measures use other measures at most ${MAX_MEASURE_NESTING} levels deep`
        );
      }
      // Each use is counted with what it nests, as each compiles on its own.
      this.countSubqueries(1);
      const before = this.state.subqueries;
      const n = this.state.fixed.size + stack.length + 1;
      const home = this.tablesById.get(measure.tableId);
      if (!home) throw notFound("measure", name, at, []);
      if (home.missing) {
        throw fail(
          "missing_in_source",
          `Table "${queryNameOf(this.catalog.tables, home)}" is missing from the source`,
          at
        );
      }
      const prefix = `f${n}_`;
      const inner = new Planner(this.catalog, this.now, this.state, prefix);
      const from = { alias: `${prefix}t0`, table: home };
      inner.scopes.set("", from);
      // A fixed measure ignores the query's filters, never the caller's rows.
      const homeRows = inner.rowFilterOf(home, at);
      stack.push(name);
      const ownReads = new Map<string, Reference>();
      let calc: ResolvedCalc;
      try {
        const expansion = expandMeasure(name, home.id, this.measures);
        this.state.expandedNodes += expansion.nodes;
        if (this.state.expandedNodes > MAX_EXPANDED_NODES) {
          throw new MeasureError(
            "too_complex",
            `A query's measures expand to at most ${MAX_EXPANDED_NODES} operations and aggregates`
          );
        }
        inner.inMeasure = true;
        for (const relationPath of expansion.relationPaths) {
          inner.joinForMeasure(relationPath, at);
        }
        calc = inner.resolveExpr(expansion.expr, at, ownReads);
      } finally {
        stack.pop();
      }
      for (const [key, ref] of ownReads) reads.set(key, ref);
      if (!calc.hasAggregate || calc.bareColumn) {
        throw new MeasureError(
          "measure_not_aggregate",
          "A measure must be group-level: every column it reads inside an aggregate"
        );
      }
      const scalar: ScalarExpr = {
        kind: "scalar",
        plan: {
          alias: `f${n}`,
          from: {
            alias: from.alias,
            schemaName: home.schemaName,
            name: home.name,
            ...homeRows,
          },
          joins: inner.joins,
          expr: calc.resolved,
        },
        type: typeOf(calc.resolved),
      };
      this.state.fixed.set(name, scalar);
      this.state.fixedWeight.set(name, 1 + this.state.subqueries - before);
      this.state.fixedReads.set(name, ownReads);
      return { resolved: scalar, hasAggregate: false, hasFixed: true };
    } catch (err) {
      if (isRowRuleRefusal(err)) throw err;
      if (err instanceof MeasureError || err instanceof QueryError) {
        throw new QueryError(err.code, `Measure "${name}": ${err.message}`, at);
      }
      throw err;
    }
  }

  /** Counts `n` more fixed-measure subqueries toward the query's limit. */
  private countSubqueries(n: number): void {
    this.state.subqueries += n;
    if (this.state.subqueries > MAX_FIXED_MEASURES) {
      throw new MeasureError(
        "too_complex",
        `A query holds at most ${MAX_FIXED_MEASURES} fixed-measure subqueries, those inside fixed measures included`
      );
    }
  }

  /**
   * `{ measure: name }` as a comparison value at `path`, compared with a
   * subject of `type`: a fixed measure of that type. One the caller cannot
   * see is not found, exactly as one that does not exist.
   */
  private fixedValue(
    name: string,
    path: QueryPath,
    type: QueryableType
  ): ScalarExpr {
    const measure = this.measures.get(name);
    if (!measure) {
      const fixed = this.catalog.measures
        .filter((m) => m.fixed)
        .map((m) => m.name);
      throw notFound("measure", name, [...path, "measure"], fixed);
    }
    if (!measure.fixed) {
      throw fail(
        "invalid_value",
        `A comparison compares with a fixed measure; "${name}" is not fixed`,
        path
      );
    }
    const resolved = this.resolveFixed(measure, path, new Map())
      .resolved as ScalarExpr;
    if (resolved.type !== type) {
      throw fail(
        "invalid_value",
        `The value is ${type}; "${name}" is ${resolved.type}`,
        path
      );
    }
    return resolved;
  }

  /**
   * The join a measure needs at `relationPath`: the query's own when it made
   * one, else one an earlier measure added, else a left join after the
   * others, kept apart from the query's scopes. A measure reads to-one
   * relations only, so its joins neither drop nor repeat rows.
   */
  private joinForMeasure(relationPath: string, at: QueryPath): void {
    if (this.scopeOf(relationPath)) return;
    const { join, toMany } = this.resolveJoin(
      relationPath,
      "left",
      `${this.aliasPrefix}t${this.joins.length + 1}`,
      at
    );
    if (toMany) {
      throw fail(
        "measure_reads_to_many",
        `"${relationPath}" can match several rows per row; a measure reads only to-one relations`,
        at
      );
    }
    this.joins.push(join);
    const maxJoins = this.catalog.source.maxJoins;
    if (this.joins.length > maxJoins) {
      throw fail(
        "too_many_joins",
        `This source allows at most ${maxJoins} ${maxJoins === 1 ? "join" : "joins"}`,
        at
      );
    }
  }

  /**
   * A business-day function. Its dates are any date or timestamp
   * expressions; when every operand is a literal (a date, timestamp or
   * relative date, and a number of days) the planner computes the value from
   * the calendar and binds it, else the compiler computes it per row from the
   * calendar the plan carries. A value the calendar leaves null (a date before
   * 1900) is left to the compiler too, which gives null.
   */
  private resolveBusiness(
    shape: BusinessShape,
    dates: Array<[CalcExpr, QueryPath]>,
    amount: [CalcExpr, QueryPath] | undefined,
    key: string,
    reads: Map<string, Reference>,
    insideAggregate: boolean
  ): ResolvedCalc {
    const label = (e: CalcExpr) =>
      typeof e === "string" ? `"${e}"` : "the operand";
    const resolvedDates = dates.map(([e, p]) => {
      const calc = this.resolveExpr(e, p, reads, insideAggregate);
      const type = typeOf(calc.resolved);
      if (type !== "date" && type !== "timestamp") {
        throw fail(
          "invalid_operator",
          `${key} needs a date or timestamp; ${label(e)} is ${type}`,
          p
        );
      }
      return { calc, date: { expr: calc.resolved, type } as BusinessDate };
    });
    let resolvedAmount: ResolvedCalc | undefined;
    if (amount) {
      const [e, p] = amount;
      resolvedAmount = this.resolveExpr(e, p, reads, insideAggregate);
      const type = typeOf(resolvedAmount.resolved);
      if (type !== "number") {
        throw fail(
          "invalid_operator",
          `${key} takes a number of business days; ${label(e)} is ${type}`,
          p
        );
      }
    }
    const calendar = compiledCalendar(this.catalog.calendar, this.now);
    const folded = this.foldBusiness(
      shape,
      resolvedDates.map((d) => d.date),
      resolvedAmount?.resolved,
      calendar
    );
    if (folded !== undefined) return { resolved: folded, hasAggregate: false };
    const all = [
      ...resolvedDates.map((d) => d.calc),
      ...(resolvedAmount ? [resolvedAmount] : []),
    ];
    const common = {
      hasAggregate: all.some((c) => c.hasAggregate),
      hasFixed: all.some((c) => c.hasFixed),
      bareColumn: all.find((c) => c.bareColumn)?.bareColumn,
    };
    const [first, second] = resolvedDates.map((d) => d.date) as [
      BusinessDate,
      BusinessDate | undefined,
    ];
    switch (shape.kind) {
      case "businessDays":
        return {
          ...common,
          resolved: {
            kind: "businessDays",
            fn: shape.fn,
            start: first,
            end: second!,
            calendar,
            type: "number",
          },
        };
      case "businessPeriod":
        return {
          ...common,
          resolved: {
            kind: "businessPeriod",
            fn: shape.fn,
            unit: shape.unit,
            // Read only by a fiscal unit: a calendar change leaves other plans alone.
            fiscalStartMonth: shape.unit.startsWith("fiscal_")
              ? this.catalog.calendar.fiscalYearStartMonth
              : 1,
            date: first,
            calendar,
            type: "number",
          },
        };
      case "addBusinessDays":
        return {
          ...common,
          resolved: {
            kind: "addBusinessDays",
            date: first,
            amount: resolvedAmount!.resolved,
            calendar,
            type: "date",
          },
        };
    }
  }

  /**
   * The value of a business-day function whose operands are all literals,
   * from the calendar; undefined when one is not a literal or the calendar
   * gives null, for the compiler to compute.
   */
  private foldBusiness(
    shape: BusinessShape,
    dates: BusinessDate[],
    amount: ResolvedExpr | undefined,
    calendar: CompiledCalendar
  ): ResolvedExpr | undefined {
    const cal = this.catalog.calendar;
    const locals: string[] = [];
    for (const { expr } of dates) {
      if (expr.kind !== "literal") return undefined;
      const local =
        expr.type === "timestamp"
          ? windowedLocalDate(
              new Date(expr.value as string),
              cal.timeZone,
              calendar.zone
            )
          : (expr.value as string);
      if (local === null) return undefined;
      locals.push(local);
    }
    if (amount && amount.kind !== "literal") return undefined;
    const [a, b] = locals as [string, string];
    let value: number | string | null;
    switch (shape.kind) {
      case "businessDays":
        value =
          shape.fn === "inclusive"
            ? businessDays(cal, a, b)
            : businessDaysBetween(cal, a, b);
        break;
      case "businessPeriod":
        value =
          shape.fn === "in"
            ? businessDaysIn(cal, shape.unit, a)
            : shape.fn === "elapsed"
              ? businessDaysElapsed(cal, a, shape.unit)
              : businessDaysRemaining(cal, a, shape.unit);
        break;
      case "addBusinessDays":
        value = addBusinessDays(cal, a, Number(amount!.value));
        break;
    }
    if (value === null) return undefined;
    return typeof value === "number"
      ? { kind: "literal", value, type: "number" }
      : { kind: "literal", value, type: "date" };
  }

  /**
   * `dateAdd`, `dateDiff` or `datePart`: the operands that are expressions
   * must be dates or timestamps; the others were checked by the language.
   */
  private resolveDateOp(
    key: "dateAdd" | "dateDiff" | "datePart",
    operand: unknown[],
    at: QueryPath,
    reads: Map<string, Reference>,
    insideAggregate: boolean
  ): ResolvedCalc {
    const exprIndexes =
      key === "dateAdd" ? [0] : key === "dateDiff" ? [1, 2] : [1];
    const operands = exprIndexes.map((i) => {
      const e = operand[i] as CalcExpr;
      const p = [...at, i];
      const calc = this.resolveExpr(e, p, reads, insideAggregate);
      const type = typeOf(calc.resolved);
      if (type !== "date" && type !== "timestamp") {
        throw fail(
          "invalid_operator",
          `${key} needs a date or timestamp; ${typeof e === "string" ? `"${e}"` : "the operand"} is ${type}`,
          p
        );
      }
      return { ...calc, type };
    });
    const common = {
      hasAggregate: operands.some((o) => o.hasAggregate),
      hasFixed: operands.some((o) => o.hasFixed),
      bareColumn: operands.find((o) => o.bareColumn)?.bareColumn,
    };
    const first = operands[0]!;
    if (key === "dateAdd") {
      return {
        ...common,
        resolved: {
          kind: "dateAdd",
          arg: first.resolved,
          amount: operand[1] as number,
          unit: operand[2] as DateAddUnit,
          type: first.type,
        },
      };
    }
    if (key === "dateDiff") {
      return {
        ...common,
        resolved: {
          kind: "dateDiff",
          unit: operand[0] as DateDiffUnit,
          start: first.resolved,
          end: operands[1]!.resolved,
          operand: operands.some((o) => o.type === "timestamp")
            ? "timestamp"
            : "date",
          type: "number",
        },
      };
    }
    const part = operand[0] as Exclude<DatePart, "business_day">;
    return {
      ...common,
      resolved: {
        kind: "datePart",
        part,
        arg: first.resolved,
        // Read only by a fiscal part: a calendar change leaves other plans alone.
        fiscalStartMonth: part.startsWith("fiscal_")
          ? this.catalog.calendar.fiscalYearStartMonth
          : 1,
        // A timestamp's date is read in the calendar's zone (none for UTC).
        ...zoneFor(first.type, this.catalog, this.now),
        type: "number",
      },
    };
  }

  /**
   * A `case` at `at`. Each `if` filters column paths as `where` does, and the
   * columns it reads count as reads, and as bare when the case is outside an
   * aggregate; every `then` and the `else` share one type.
   */
  private resolveCase(
    operand: CaseOperand,
    at: QueryPath,
    reads: Map<string, Reference>,
    insideAggregate: boolean
  ): ResolvedCalc {
    let bareColumn: ResolvedCalc["bareColumn"];
    let hasAggregate = false;
    let hasFixed = false;
    let type: QueryableType | undefined;
    const typed = (e: ResolvedCalc, p: QueryPath) => {
      const t = typeOf(e.resolved);
      if (type === undefined) {
        refuseJson(t, "the expression", "a case", p);
        type = t;
      } else if (t !== type) {
        throw fail(
          "invalid_operator",
          `case takes values of one type; this one is ${t}, not ${type}`,
          p
        );
      }
      hasAggregate ||= e.hasAggregate;
      hasFixed ||= e.hasFixed ?? false;
      bareColumn ??= e.bareColumn;
    };
    const branches = operand.when.map((branch, i) => {
      const whenAt = [...at, "when", i];
      const when = resolveFilter<ColumnRef>(
        branch.if,
        [...whenAt, "if"],
        (key, p) => {
          const { ref, reference } = this.resolveColumn(key, p);
          reads.set(referenceKey(reference), reference);
          if (!insideAggregate) bareColumn ??= { path: key, at: p };
          return { subject: ref, type: ref.type };
        },
        this.values
      );
      const thenAt = [...whenAt, "then"];
      const then = this.resolveExpr(
        branch.then,
        thenAt,
        reads,
        insideAggregate
      );
      typed(then, thenAt);
      return { when, then: then.resolved };
    });
    let otherwise: ResolvedExpr | undefined;
    if (operand.else !== undefined) {
      const elseAt = [...at, "else"];
      const resolved = this.resolveExpr(
        operand.else,
        elseAt,
        reads,
        insideAggregate
      );
      typed(resolved, elseAt);
      otherwise = resolved.resolved;
    }
    return {
      resolved: {
        kind: "case",
        branches,
        ...(otherwise ? { otherwise } : {}),
        type: type!,
      },
      hasAggregate,
      hasFixed,
      bareColumn,
    };
  }

  /** An aggregate over `arg`, the argument at `at`. */
  private resolveAggregate(
    fn: AggregateFn,
    arg: CalcExpr,
    at: QueryPath,
    reads: Map<string, Reference>
  ): ResolvedExpr & { kind: "aggregate" } {
    if (fn === "count" && arg === "*") {
      return { kind: "aggregate", fn, arg: "*", type: "number" };
    }
    const { resolved } = this.resolveExpr(arg, at, reads, true);
    const type = typeOf(resolved);
    const label = typeof arg === "string" ? `"${arg}"` : "its operand";
    if (fn === "countDistinct") refuseJson(type, String(arg), fn, at);
    const allowed = AGGREGATE_TYPES[fn];
    if (allowed && !allowed.includes(type)) {
      throw fail(
        "invalid_operator",
        `${fn} needs a ${allowed.join(", ")} value; ${label} is ${type}`,
        at
      );
    }
    return {
      kind: "aggregate",
      fn,
      arg: resolved,
      type: fn === "min" || fn === "max" ? type : "number",
    };
  }

  referenceList(): Reference[] {
    return [...this.state.references.values()];
  }
}

/** One condition on a subject of `type`: the operator checked, the value coerced. */
const resolveCondition = <S>(
  subject: S,
  type: QueryableType,
  label: string,
  condition: Condition,
  path: QueryPath,
  values: ValueContext
): ResolvedFilter<S> => {
  const { now, calendar } = values;
  const [op, raw] = Object.entries(condition)[0] as [Operator, unknown];
  const at = [...path, op];
  if (!operatorApplies(type, op)) {
    throw fail(
      "invalid_operator",
      `${op} does not apply to "${label}", a ${type} column`,
      at
    );
  }
  const value = (v: Compared, valuePath: QueryPath): FilterValue => {
    if (typeof v === "object" && "measure" in v) {
      return values.measure(v.measure, valuePath, type);
    }
    if (isRelativeDate(v)) {
      // A relative moment is only for a date or a timestamp; elsewhere it is
      // the value error for the operator and path.
      if (type === "date" || type === "timestamp") {
        return type === "date"
          ? resolveRelativeDate(v, now, calendar)
          : resolveRelative(v, now, calendar).toISOString();
      }
      throw fail(
        "invalid_value",
        `"${label}" is ${type}; ${op} takes ${VALUE_FORMS[type]}`,
        valuePath
      );
    }
    const coerced = coerceValue(v, type);
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
    case "isBusinessDay":
      if (!values.compiled) {
        throw fail(
          "invalid_operator",
          "isBusinessDay filters rows, in where or a case's if; having filters groups",
          at
        );
      }
      return {
        kind: "businessDay",
        subject,
        is: raw as boolean,
        calendar: values.compiled(),
      };
    case "contains":
    case "startsWith":
      return { kind: "match", op, subject, value: raw as string };
    case "between": {
      const [low, high] = raw as [Compared, Compared];
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
        values: (raw as Scalar[]).map(
          (v, i) => value(v, [...at, i]) as PlanValue
        ),
      };
    default:
      return {
        kind: "compare",
        op,
        subject,
        value: value(raw as Compared, at),
      };
  }
};

/** A filter tree, each path resolved by `subjectOf`. */
const resolveFilter = <S>(
  filter: Filter,
  path: QueryPath,
  subjectOf: (
    key: string,
    path: QueryPath
  ) => { subject: S; type: QueryableType },
  values: ValueContext
): ResolvedFilter<S> => {
  if ("and" in filter && Array.isArray(filter.and)) {
    return {
      kind: "and",
      filters: (filter.and as Filter[]).map((f, i) =>
        resolveFilter(f, [...path, "and", i], subjectOf, values)
      ),
    };
  }
  if ("or" in filter && Array.isArray(filter.or)) {
    return {
      kind: "or",
      filters: (filter.or as Filter[]).map((f, i) =>
        resolveFilter(f, [...path, "or", i], subjectOf, values)
      ),
    };
  }
  if ("not" in filter) {
    return {
      kind: "not",
      filter: resolveFilter(
        filter.not as Filter,
        [...path, "not"],
        subjectOf,
        values
      ),
    };
  }
  const leaves = Object.entries(filter as Comparison).map(
    ([key, condition]) => {
      const at = [...path, key];
      const { subject, type } = subjectOf(key, at);
      return resolveCondition(subject, type, key, condition, at, values);
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

/**
 * `{ zone }` for a timestamp in a calendar whose zone is not UTC, so the plan
 * (and a run's fingerprint) changes with the zone; else nothing.
 */
export const zoneFor = (
  type: QueryableType,
  catalog: VisibleCatalog,
  now: Date
): { zone?: ZoneWindow } => {
  if (type !== "timestamp") return {};
  const { zone } = compiledCalendar(catalog.calendar, now);
  return zone ? { zone } : {};
};

/** Evaluated per group rather than per row: an aggregate or a group-level calc. */
const perGroup = (s: ResolvedSelect): boolean =>
  s.kind === "aggregate" || (s.kind === "calc" && s.level === "group");

const aggregateFnOf = (
  item: Exclude<SelectItem, string>
): AggregateFn | undefined => AGGREGATE_FNS.find((fn) => fn in item);

/** Resolves `query` against `catalog`, the caller's view of the source. */
export const planSql = (
  query: SqlQuery,
  catalog: VisibleCatalog,
  ctx?: PlanContext
): TablePlan => {
  const now = ctx?.now ?? floorToMinute(new Date());
  const maxJoins = catalog.source.maxJoins;
  if ((query.join?.length ?? 0) > maxJoins) {
    throw new QueryError(
      "too_many_joins",
      `This source allows at most ${maxJoins} ${maxJoins === 1 ? "join" : "joins"}`,
      ["join"]
    );
  }
  const planner = new Planner(catalog, now);
  const from = planner.resolveFrom(query.from);

  const joins = planner.joins;
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
  planner.toManyJoin = toManyJoins[0]?.relation;

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
        // Read only by a fiscal unit: a calendar change leaves other plans alone.
        fiscalStartMonth: item.bucket.startsWith("fiscal_")
          ? catalog.calendar.fiscalYearStartMonth
          : 1,
        column: ref,
        // A timestamp's date is read in the calendar's zone (none for UTC).
        ...zoneFor(ref.type, catalog, now),
        output: item.as ?? `${item.bucket}_${item.column.replaceAll(".", "_")}`,
        type: "date",
      };
      references = [reference];
      columnPath = item.column;
      if (item.as) outputPath = ["select", i, "as"];
    } else if (
      "measure" in item ||
      "calc" in item ||
      typeof (item as Record<string, unknown>)[aggregateFnOf(item)!] !==
        "string"
    ) {
      // A calc, or an aggregate over an expression: both named by their `as`;
      // a measure is named by its own name unless it has an `as`.
      const reads = new Map<string, Reference>();
      const { as, ...rest } = item as { as?: string } & Record<string, unknown>;
      const {
        resolved: expr,
        hasAggregate,
        hasFixed,
        bareColumn,
      } = "calc" in rest
        ? planner.resolveExpr(
            rest.calc as CalcExpr,
            ["select", i, "calc"],
            reads
          )
        : planner.resolveExpr(rest as CalcExpr, ["select", i], reads);
      // A constant item is pointless, and SQL Server refuses a constant in
      // ORDER BY and GROUP BY, both of which a select item may land in.
      if (!bareColumn && !hasAggregate && !hasFixed) {
        throw fail(
          "invalid_operator",
          "A calculation reads at least one column",
          ["select", i]
        );
      }
      if (hasAggregate && bareColumn) {
        throw fail(
          "invalid_grouping",
          `"${bareColumn.path}" is outside an aggregate in a calculation that has one; put it inside an aggregate or in a select item of its own`,
          bareColumn.at
        );
      }
      resolved = {
        kind: "calc",
        expr,
        // Fixed measures alone are one value per group, never grouped by.
        level: hasAggregate || !bareColumn ? "group" : "row",
        output: as ?? (rest.measure as string),
        type: typeOf(expr),
      };
      references = [...reads.values()];
      outputPath =
        as === undefined ? ["select", i, "measure"] : ["select", i, "as"];
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
  const hasAggregate = select.some(perGroup);

  // A where key is a calc's or an aggregate's name before it is a column path;
  // columns and buckets are named by their path or filtered as the column.
  const where =
    query.where &&
    resolveFilter<WhereSubject>(
      query.where,
      ["where"],
      (key, at) => {
        const index = outputIndex(key);
        const named = index >= 0 ? select[index] : undefined;
        if (named && (named.kind === "calc" || named.kind === "aggregate")) {
          if (planner.hasColumn(key)) {
            throw fail(
              "duplicate_output_name",
              `"${key}" is both a select item's name and a column; give the select item another "as"`,
              at
            );
          }
          if (perGroup(named)) {
            throw fail(
              "invalid_grouping",
              `"${key}" is computed per group, which where cannot filter; use having`,
              at
            );
          }
          return { subject: { index, type: named.type }, type: named.type };
        }
        const { ref } = planner.resolveColumn(key, at);
        return { subject: ref, type: ref.type };
      },
      planner.values
    );

  const grouped = hasAggregate || (query.groupBy?.length ?? 0) > 0;
  const groupedItems = new Set<number>();
  query.groupBy?.forEach((entry, j) => {
    const named = outputIndex(entry);
    if (named >= 0) {
      if (perGroup(select[named])) {
        throw fail(
          "invalid_grouping",
          `"${entry}" is computed per group; group by the items beside it`,
          ["groupBy", j]
        );
      }
      refuseJson(select[named].type, entry, "groupBy", ["groupBy", j]);
      groupedItems.add(named);
      return;
    }
    const byPath = select
      .map((s, i) => (!perGroup(s) && selectPaths[i] === entry ? i : -1))
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
      if (!perGroup(s) && !groupedItems.has(i)) {
        throw fail(
          "invalid_grouping",
          `"${s.output}" must be in groupBy or be an aggregate or a fixed measure`,
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
    resolveFilter<HavingSubject>(
      query.having,
      ["having"],
      (key, at) => {
        const index = outputIndex(key);
        if (index < 0 || !perGroup(select[index])) {
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
      },
      { ...planner.values, compiled: undefined }
    );

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

  const warnings: QueryWarning[] = select.some(aggregatesRows)
    ? toManyJoins.map(({ relation, path }) => ({
        code: "join_multiplies_rows",
        message: `"${relation}" can match several rows per row it joins to, so aggregates may count a row more than once`,
        path,
      }))
    : [];

  return {
    kind: "table",
    from: {
      alias: "t0",
      schemaName: from.table.schemaName,
      name: from.table.name,
      ...(from.rowFilter && {
        rowFilter: from.rowFilter,
        rowRuleAt: from.rowRuleAt,
      }),
    },
    joins,
    select,
    distinct,
    where,
    groupBy: grouped ? select.flatMap((s, i) => (perGroup(s) ? [] : [i])) : [],
    having,
    orderBy,
    defaultOrder: (query.orderBy?.length ?? 0) === 0,
    references: planner.referenceList(),
    columns,
    warnings,
    limit: query.limit,
    offset: query.offset ?? 0,
    rowsLimited: planner.rowsLimited(),
  };
};
