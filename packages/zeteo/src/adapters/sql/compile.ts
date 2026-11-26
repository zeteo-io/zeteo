import { compileBusiness, compileBusinessDay } from "./businessDays.js";
import type { ZoneWindow } from "../../calendar/calendar.js";
import { QueryError } from "../../engine/errors.js";
import { METRIC_UNION as UNION } from "./types.js";
import { aggregatesRows } from "./aggregates.js";
import { plainNumber } from "./values.js";
import type {
  AnySelect,
  SqlDialect,
  Staging,
  ValueSubject,
} from "./dialect.js";
import type {
  BucketUnit,
  ColumnRef,
  CompareOp,
  MetricPart,
  MetricPlan,
  TablePlan,
  FilterValue,
  HavingSubject,
  PlanValue,
  ResolvedExpr,
  ResolvedFilter,
  ResolvedJoin,
  ResolvedSelect,
  RowFiltered,
  RuleSubject,
  ScalarPlan,
  SqlPlan,
  TableName,
  WhereSubject,
} from "./types.js";
import {
  sql,
  type AliasedExpression,
  type JoinBuilder,
  type RawBuilder,
  type Expression,
  type SqlBool,
} from "kysely";

export interface CompiledQuery {
  sql: string;
  parameters: unknown[];
}

// Identifiers come only from the plan and only through `sql.id`, which quotes
// each part and doubles any quote inside it; values are bound by the dialect,
// never written into the text. Select items are aliased c0, c1… by position:
// output names can be longer than an engine's alias limit, and the caller maps
// result columns back to `plan.columns` by index.

const COMPARE_SQL: Record<CompareOp, RawBuilder<unknown>> = {
  eq: sql`=`,
  ne: sql`<>`,
  gt: sql`>`,
  gte: sql`>=`,
  lt: sql`<`,
  lte: sql`<=`,
};
const AND = sql` and `;
const OR = sql` or `;

/** `alias.name`, noted as read: a ruled table provides only the columns read of it. */
const ref = (comp: Compilation, alias: string, name: string) => {
  const at = comp.scope + alias;
  let names = comp.reads.get(at);
  if (!names) comp.reads.set(at, (names = new Set()));
  names.add(name);
  return sql.id(alias, name);
};

const column = (c: ColumnRef, comp: Compilation) =>
  comp.dialect.column(ref(comp, c.alias, c.name), c.nativeType);

/** More values than this in one `in` of a clause are bound as one list (`inSet`). */
const IN_LIST_MAX = 100;

const ARITHMETIC = { add: sql` + `, sub: sql` - `, mul: sql` * ` } as const;

/**
 * Where an expression is compiled. A fixed measure's value is read per row
 * (`row`: in where, a row-level calc, inside an aggregate) as column `v` of a
 * one-row derived table joined on `1 = 1`, since SQL Server aggregates no
 * subquery and groups by none; elsewhere (group-level, outside any aggregate)
 * as a scalar subquery, which needs no grouping. `fixed` collects the derived
 * tables the current query level joins, by alias.
 */
export interface ExprContext {
  row: boolean;
  comp: Compilation;
  fixed: Map<string, ScalarPlan>;
  /**
   * The business-day subqueries of a dialect that cannot aggregate a
   * subquery (SQL Server), by alias: each is applied to every row, outer,
   * and read as its column `n`, so an aggregate (and GROUP BY) sees a column.
   */
  applied: Map<string, Expression<unknown>>;
}

/** A context of its own for one query level: no fixed measure or applied subquery yet. */
const levelContext = (comp: Compilation, row: boolean): ExprContext => ({
  row,
  comp,
  fixed: new Map(),
  applied: new Map(),
});

/**
 * One compilation's state, carried through what compiles it, never kept in
 * the module: two compilations, or one inside another, never share it.
 */
export interface Compilation {
  dialect: SqlDialect;
  staging: Staging;
  /**
   * The query level being compiled, whose aliases are its own: empty for the
   * query, `p<k>.` for a metric part, `<alias>.` for a fixed measure's query.
   */
  scope: string;
  /** The columns read of each table, by scope and alias. */
  reads: Map<string, Set<string>>;
  /** The read each ruled table reference is served by, by scope and alias. */
  ruled: Map<string, string>;
  /**
   * The columns each ruled read provides, by the read: those its references
   * read in a first pass over the same plan. Absent in that pass.
   */
  provides?: ReadonlyMap<string, readonly string[]>;
  /** The reads made so far, for a dialect that serves a read once (`ruledOnce`). */
  made: Map<string, Expression<unknown>>;
  /** Whether conditions that cannot raise are applied beside the rule (`pushDown`). */
  pushDown: boolean;
}

/** A condition of the caller's applied beside a table's rule. */
interface Pushed {
  filter: ResolvedFilter<ColumnRef>;
  sql: Expression<SqlBool>;
}

/** A row rule's column, by its bare name inside its table's derived table. */
const ruleSubject = (dialect: SqlDialect) => (c: RuleSubject) => ({
  expression: dialect.column(sql.id(c.name), c.nativeType),
  type: c.type,
  nativeType: c.nativeType,
});

/**
 * The one place a table reaches SQL: as itself under its alias, or, with the
 * caller's row rule, as what `dialect.ruled` reads in its place, so nothing
 * outside it sees, or evaluates an expression on, a row the rule leaves out.
 * Whatever reads a table (the from, every join, a fixed measure's query, a
 * metric part) reads it through here.
 */
const tableSource = (
  t: TableName & { alias: string } & RowFiltered,
  comp: Compilation,
  pushed: readonly Pushed[] = []
): AliasedExpression<unknown, string> => {
  const name = sql.id(t.schemaName, t.name);
  if (!t.rowFilter) return sql`${name}`.as(t.alias);
  const { dialect } = comp;
  // Not per row: a business-day check stays inline in the rule's where, as
  // nothing there aggregates it.
  const rule = compileFilter(
    t.rowFilter,
    dialect,
    ruleSubject(dialect),
    levelContext(comp, false),
    { mode: "rule" }
  );
  const where =
    pushed.length === 0
      ? rule
      : sql<SqlBool>`(${rule}) and ${sql.join(
          pushed.map((p) => p.sql),
          AND
        )}`;
  const at = comp.scope + t.alias;
  // A read served once is shared by references to the same table under the
  // same rule and conditions; any other is a reference's own.
  const key = dialect.ruledOnce
    ? JSON.stringify(
        [t.schemaName, t.name, t.rowFilter, pushed.map((p) => p.filter)],
        (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v)
      )
    : at;
  comp.ruled.set(at, key);
  const made = comp.made.get(key);
  if (made) return sql`${made}`.as(t.alias);
  const read = dialect.ruled(
    { table: name, columns: comp.provides?.get(key) ?? [], where },
    comp.staging
  );
  if (dialect.ruledOnce) comp.made.set(key, read);
  return sql`${read}`.as(t.alias);
};

/** Joins `joins` in order: inner or left, on their key equalities. */
const withJoins = (
  qb: AnySelect,
  joins: readonly ResolvedJoin[],
  comp: Compilation,
  pushed: ReadonlyMap<string, readonly Pushed[]> = new Map()
): AnySelect => {
  for (const join of joins) {
    const target = tableSource(
      { ...join.table, alias: join.alias, rowFilter: join.rowFilter },
      comp,
      pushed.get(join.alias)
    );
    const on = (j: JoinBuilder<never, never>) =>
      j.on(
        sql<SqlBool>`${sql.join(
          join.on.map(
            ([parent, parentColumn, col]) =>
              sql`${ref(comp, parent, parentColumn)} = ${ref(comp, join.alias, col)}`
          ),
          AND
        )}`
      );
    qb =
      join.type === "inner"
        ? qb.innerJoin(target, on)
        : qb.leftJoin(target, on);
  }
  return qb;
};

/** Joins each one-row derived table of `fixed` on `1 = 1`, which keeps every row. */
const withFixed = (
  qb: AnySelect,
  fixed: ReadonlyMap<string, ScalarPlan>,
  comp: Compilation
): AnySelect => {
  for (const plan of fixed.values()) {
    qb = qb.innerJoin(scalarQuery(plan, comp).as(plan.alias), (j) =>
      j.on(sql<SqlBool>`1 = 1`)
    );
  }
  return qb;
};

/** Applies each business-day subquery of `applied` to every row, keeping every row. */
const withApplied = (
  qb: AnySelect,
  applied: ReadonlyMap<string, Expression<unknown>>
): AnySelect => {
  for (const [alias, lookup] of applied) {
    qb = qb.outerApply(sql`${lookup}`.as(alias));
  }
  return qb;
};

/**
 * A business-day subquery where it is used: as it is, or, per row on an
 * engine that aggregates no subquery, applied to every row and read as a
 * column. Operands compiled before it were applied first, so it may read them.
 */
const applied = (
  subquery: Expression<unknown>,
  dialect: SqlDialect,
  ctx: ExprContext
): Expression<unknown> => {
  if (!ctx.row || dialect.subqueryInAggregate) return subquery;
  const alias = `m${ctx.applied.size}`;
  ctx.applied.set(alias, subquery);
  return sql.id(alias, "n");
};

/**
 * A timestamp's date (the timestamp as a calculation reads it, its UTC
 * instant): in `zone` when given, converted once per row, else its UTC date.
 * Postgres converts natively, in place; SQL Server's conversion is a
 * subquery (a search of the zone's offsets), applied to the row where it is
 * row-level and read as a column, which GROUP BY and an aggregate take, as a
 * business-day subquery is.
 */
const localDate = (
  timestamp: Expression<unknown>,
  zone: ZoneWindow | undefined,
  dialect: SqlDialect,
  ctx: ExprContext
): Expression<unknown> => {
  if (!zone) return sql`cast(${timestamp} as date)`;
  const converted = dialect.zoneDate(timestamp, zone);
  return dialect.subqueryInAggregate
    ? converted
    : applied(sql`(select ${converted} as ${sql.id("n")})`, dialect, ctx);
};

/** A bucket of a date or timestamp column: its period's first day, a timestamp's in `zone`. */
const bucketOf = (
  unit: BucketUnit,
  c: ColumnRef,
  fiscalStartMonth: number,
  zone: ZoneWindow | undefined,
  dialect: SqlDialect,
  ctx: ExprContext
): Expression<unknown> => {
  const read = column(c, ctx.comp);
  const date =
    c.type === "date"
      ? read
      : localDate(
          dialect.timestampUtc(read, c.nativeType),
          zone,
          dialect,
          // A bucket is row-level wherever it is: it is grouped by.
          { ...ctx, row: true }
        );
  return dialect.bucket(unit, date, fiscalStartMonth);
};

/** A fixed measure's own query: one row, its value as `v`. */
const scalarQuery = (plan: ScalarPlan, outer: Compilation): AnySelect => {
  const comp = { ...outer, scope: `${plan.alias}.` };
  const { dialect } = comp;
  const ctx = levelContext(comp, false);
  const qb = withJoins(
    dialect.kysely.selectFrom(tableSource(plan.from, comp)),
    plan.joins,
    comp
  );
  const value = compileExpr(plan.expr, dialect, ctx);
  return withApplied(
    withFixed(qb.select(sql`${value}`.as("v")), ctx.fixed, comp),
    ctx.applied
  );
};
/** Whether an expression's value is a binary float on the engine (a float column, an average, arithmetic over either). */
const isApproximate = (expr: ResolvedExpr, dialect: SqlDialect): boolean => {
  switch (expr.kind) {
    case "column":
      return (
        expr.column.type === "number" && dialect.isFloat(expr.column.nativeType)
      );
    case "literal":
    case "dateAdd":
    case "dateDiff":
    case "datePart":
    case "businessDays":
    case "businessPeriod":
    case "addBusinessDays":
      return false;
    case "case":
      return [...expr.branches.map((b) => b.then), expr.otherwise].some(
        (e) => e !== undefined && isApproximate(e, dialect)
      );
    case "aggregate":
      if (expr.fn === "avg") return true;
      if (expr.fn === "count" || expr.fn === "countDistinct") return false;
      return expr.arg !== "*" && isApproximate(expr.arg, dialect);
    case "scalar":
      return isApproximate(expr.plan.expr, dialect);
    case "pivot":
      return isApproximate(expr.of, dialect);
    case "op":
      return (
        (expr.op === "add" ||
          expr.op === "sub" ||
          expr.op === "mul" ||
          expr.op === "abs" ||
          expr.op === "coalesce") &&
        expr.args.some((arg) => isApproximate(arg, dialect))
      );
  }
};

const typeOf = (expr: ResolvedExpr) =>
  expr.kind === "column" ? expr.column.type : expr.type;

/** A filter over catalogue columns: the column read as every part of the query reads it. */
const columnSubject = (comp: Compilation) => (c: ColumnRef) => ({
  expression: column(c, comp),
  type: c.type,
  nativeType: c.nativeType,
});

/** A planned calculation as SQL; literals are bound by the dialect. */
export const compileExpr = (
  expr: ResolvedExpr,
  dialect: SqlDialect,
  ctx: ExprContext
): Expression<unknown> => {
  const inner = (e: ResolvedExpr) => compileExpr(e, dialect, ctx);
  switch (expr.kind) {
    case "scalar":
      if (ctx.row) {
        ctx.fixed.set(expr.plan.alias, expr.plan);
        return sql.id(expr.plan.alias, "v");
      }
      // Kysely puts a subquery inside an expression in parentheses.
      return sql`${scalarQuery(expr.plan, ctx.comp)}`;
    case "pivot":
      // Each period has one row per part, so max picks the part's value.
      return sql`max(${sql.id(UNION, `v${expr.index}`)})`;
    case "column": {
      const read = column(expr.column, ctx.comp);
      if (expr.column.type === "text") {
        return dialect.text(read, expr.column.nativeType);
      }
      return expr.column.type === "timestamp"
        ? dialect.timestampUtc(read, expr.column.nativeType)
        : read;
    }
    case "literal":
      return dialect.literal(
        typeof expr.value === "number" ? plainNumber(expr.value) : expr.value,
        expr.type
      );
    case "dateAdd":
      return dialect.dateAdd(
        inner(expr.arg),
        expr.amount,
        expr.unit,
        expr.type
      );
    case "dateDiff":
      return dialect.dateDiff(
        expr.unit,
        inner(expr.start),
        inner(expr.end),
        expr.operand
      );
    case "datePart":
      return dialect.datePart(
        expr.part,
        expr.zone
          ? localDate(inner(expr.arg), expr.zone, dialect, ctx)
          : inner(expr.arg),
        expr.fiscalStartMonth
      );
    case "businessDays":
    case "businessPeriod":
      return applied(compileBusiness(expr, dialect, inner), dialect, ctx);
    case "addBusinessDays":
      return dialect.anchorPlus(
        applied(compileBusiness(expr, dialect, inner), dialect, ctx)
      );
    case "case": {
      const whens = expr.branches.map(
        (b) =>
          sql`when ${compileFilter(
            b.when,
            dialect,
            columnSubject(ctx.comp),
            ctx,
            {
              // A case may be grouped by or aggregated (a measure's where is
              // one), where SQL Server takes no subquery: no `inSet` there.
              lists: dialect.subqueryInAggregate ? "set" : "literal",
              mode: "case",
            }
          )} then ${inner(b.then)}`
      );
      const otherwise = expr.otherwise
        ? sql` else ${inner(expr.otherwise)}`
        : sql``;
      return sql`case ${sql.join(whens, sql` `)}${otherwise} end`;
    }
    case "aggregate":
      if (expr.arg === "*") return dialect.aggregate(expr.fn, "*");
      return expr.arg.kind === "column"
        ? dialect.aggregate(
            expr.fn,
            column(expr.arg.column, ctx.comp),
            expr.arg.column.nativeType
          )
        : dialect.aggregate(
            expr.fn,
            compileExpr(expr.arg, dialect, { ...ctx, row: true }),
            undefined,
            expr.arg
          );
    case "op": {
      const args = expr.args.map(inner);
      switch (expr.op) {
        case "add":
        case "sub":
        case "mul":
          return sql`(${sql.join(args, ARITHMETIC[expr.op])})`;
        case "div":
          return dialect.divide(args[0]!, args[1]!);
        case "round":
          return dialect.round(args[0]!, expr.places ?? 0);
        case "abs":
          return sql`abs(${args[0]!})`;
        case "lower":
          return sql`lower(${args[0]!})`;
        case "upper":
          return sql`upper(${args[0]!})`;
        case "coalesce":
          return sql`coalesce(${sql.join(args)})`;
        case "concat":
          return dialect.concat(
            expr.args.map((arg, i) =>
              typeOf(arg) === "number"
                ? dialect.numberToText(args[i]!, isApproximate(arg, dialect))
                : args[i]!
            )
          );
      }
      break;
    }
  }
  // A kind the switch does not know would compile to nothing, which binds as null.
  throw new Error(
    `cannot compile an expression of kind ${(expr as { kind: unknown }).kind}`
  );
};

/** Whether a select item is computed per group rather than per row. */
const perGroup = (item: ResolvedSelect) =>
  item.kind === "aggregate" || (item.kind === "calc" && item.level === "group");

const selectExpression = (
  item: ResolvedSelect,
  comp: Compilation,
  fixed: Map<string, ScalarPlan>,
  applied: Map<string, Expression<unknown>>
): Expression<unknown> => {
  const { dialect } = comp;
  switch (item.kind) {
    case "column":
      return column(item.column, comp);
    case "aggregate":
      return item.column === "*"
        ? dialect.aggregate(item.fn, "*")
        : dialect.aggregate(
            item.fn,
            column(item.column, comp),
            item.column.nativeType
          );
    case "bucket":
      return bucketOf(
        item.unit,
        item.column,
        item.fiscalStartMonth,
        item.zone,
        dialect,
        { row: true, comp, fixed, applied }
      );
    case "calc":
      return compileExpr(item.expr, dialect, {
        row: item.level === "row",
        comp,
        fixed,
        applied,
      });
  }
};

const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

/**
 * An equality whose values the subject cannot hold, so no row equals one:
 * `eq` (and `in`) holds for no row; `ne` (and `notIn`) for every row whose
 * value is not null. Unknown for a null, as the comparison would be, so a
 * `not` around it keeps hiding that row.
 */
const noValueLeft = (
  expression: Expression<unknown>,
  op: "eq" | "ne"
): Expression<SqlBool> =>
  op === "eq"
    ? sql<SqlBool>`${expression} <> ${expression}`
    : sql<SqlBool>`${expression} = ${expression}`;

const isPlanValue = (v: FilterValue): v is PlanValue =>
  !(typeof v === "object" && v !== null && "kind" in v);

/**
 * Where a condition sits: `positive` under an even number of `not`s,
 * `negative` under an odd number; `neutral` in a `case`, whose branch it
 * picks.
 */
type Position = "positive" | "negative" | "neutral";

const flip = (p: Position): Position =>
  p === "positive" ? "negative" : p === "negative" ? "positive" : p;

/**
 * What a filter compiles for: the caller's `where` (or `having`, a metric's
 * range), a row `rule`, or a `case`'s condition.
 */
type FilterMode = "where" | "rule" | "case";

/**
 * The values an equality compares (`dialect.equalityValues`), or undefined
 * when a rule's condition must keep no row. A value the catalogue's type
 * cannot hold is left out only where leaving it out can only drop rows: in
 * an `eq` or `in` in positive position, a `ne` or `notIn` in negative one.
 * Elsewhere it is compared exactly, as the column, widened since the
 * catalogue was read, may hold it; and a value no exact comparison can be
 * made with is left out of a caller's condition (no exact number column holds
 * it), but makes a rule's condition keep no row, never more.
 */
const equalityValuesAt = (
  dialect: SqlDialect,
  values: readonly PlanValue[],
  s: ValueSubject,
  eq: boolean,
  at: Position,
  mode: FilterMode
): PlanValue[] | undefined => {
  const { held, wider, unbound } = dialect.equalityValues(values, s);
  if (at === "positive" ? eq : at === "negative" ? !eq : false) return held;
  if (unbound && mode === "rule" && at !== "neutral") return undefined;
  return [...held, ...wider];
};

/**
 * A rule's equality that cannot be compared exactly, as what keeps no row
 * where it sits: false in positive position, true under a `not`.
 */
const keepsNoRow = (at: Position): Expression<SqlBool> =>
  at === "positive" ? sql<SqlBool>`1 = 0` : sql<SqlBool>`1 = 1`;

/**
 * A filter as SQL. `lists` says how an `in` of more than `IN_LIST_MAX` values
 * binds: `set`, as one parameter (`inSet`, a subquery on SQL Server), where
 * the filter is a clause of its own (where, having, a row rule); `literal`,
 * one parameter per value, inside an expression that may be aggregated or
 * grouped by. `mode` says what it is for (`equalityValuesAt`).
 */
const compileFilter = <S>(
  filter: ResolvedFilter<S>,
  dialect: SqlDialect,
  subject: (s: S) => ValueSubject & { expression: Expression<unknown> },
  ctx: ExprContext,
  {
    lists = "set",
    mode = "where",
  }: { lists?: "set" | "literal"; mode?: FilterMode } = {}
): Expression<SqlBool> => {
  /** A value bound for the subject, or a fixed measure's value. */
  const valueOf = (v: FilterValue, s: ValueSubject): Expression<unknown> =>
    typeof v === "object" && v !== null && "kind" in v
      ? compileExpr(v, dialect, ctx)
      : dialect.value(v, s);
  const go = (f: ResolvedFilter<S>, at: Position): Expression<SqlBool> => {
    switch (f.kind) {
      case "and":
      case "or":
        return sql<SqlBool>`(${sql.join(
          f.filters.map((g) => go(g, at)),
          f.kind === "and" ? AND : OR
        )})`;
      case "not":
        return sql<SqlBool>`not (${go(f.filter, flip(at))})`;
      case "never":
        return sql<SqlBool>`1 = 0`;
      case "compare": {
        const s = subject(f.subject);
        let v = f.value;
        if ((f.op === "eq" || f.op === "ne") && isPlanValue(v)) {
          const values = equalityValuesAt(
            dialect,
            [v],
            s,
            f.op === "eq",
            at,
            mode
          );
          if (!values) return keepsNoRow(at);
          if (values.length === 0) return noValueLeft(s.expression, f.op);
          v = values[0]!;
        }
        return sql<SqlBool>`${s.expression} ${COMPARE_SQL[f.op]} ${valueOf(v, s)}`;
      }
      case "between": {
        const s = subject(f.subject);
        return sql<SqlBool>`${s.expression} between ${valueOf(f.low, s)} and ${valueOf(f.high, s)}`;
      }
      case "in": {
        const s = subject(f.subject);
        const values = equalityValuesAt(
          dialect,
          f.values,
          s,
          f.op === "in",
          at,
          mode
        );
        if (!values) return keepsNoRow(at);
        if (values.length === 0) {
          return noValueLeft(s.expression, f.op === "in" ? "eq" : "ne");
        }
        if (lists === "set" && values.length > IN_LIST_MAX) {
          return dialect.inSet(s.expression, values, s, f.op === "notIn");
        }
        const bound = sql.join(
          values.map((v: PlanValue) => dialect.value(v, s))
        );
        return sql<SqlBool>`${s.expression} ${f.op === "in" ? sql`in` : sql`not in`} (${bound})`;
      }
      case "match": {
        const escaped = escapeLike(f.value);
        const s = subject(f.subject);
        return dialect.like(
          s.expression,
          f.op === "contains" ? `%${escaped}%` : `${escaped}%`,
          s.nativeType
        );
      }
      case "isNull":
        return sql<SqlBool>`${subject(f.subject).expression} ${f.isNull ? sql`is null` : sql`is not null`}`;
      case "businessDay": {
        const s = subject(f.subject);
        // A timestamp column is read as its UTC instant, as a calculation reads it.
        const read =
          s.type === "timestamp" && s.nativeType !== undefined
            ? dialect.timestampUtc(s.expression, s.nativeType)
            : s.expression;
        const flag = applied(
          compileBusinessDay(
            read,
            s.type === "date" ? "date" : "timestamp",
            f.calendar,
            dialect
          ),
          dialect,
          ctx
        );
        return sql<SqlBool>`${flag} = ${sql.lit(f.is ? 1 : 0)}`;
      }
    }
  };
  return go(filter, mode === "case" ? "neutral" : "positive");
};

/** A filter's conjuncts: what must each hold for it to hold. */
const conjuncts = <S>(f: ResolvedFilter<S>): ResolvedFilter<S>[] =>
  f.kind === "and" ? f.filters.flatMap(conjuncts) : [f];

/**
 * A condition on one column, written against the column's bare name as a
 * ruled read sees it, when it raises no error on any row, so it may be
 * evaluated beside the rule, on rows the rule leaves out; else undefined.
 * That holds when the column is read as it is and compared with values bound
 * as exactly its own type (`ownValue`, `ownMatch`): nothing is converted per
 * row, and a value that could not convert would fail before any row is read.
 * Only `isNull`, comparisons, `between`, a short `in` and a match qualify,
 * never a calculation, a fixed measure or a business-day check. It is
 * written as `compileFilter` writes it, so the same rows match.
 */
const besideRule = (
  f: ResolvedFilter<ColumnRef>,
  dialect: SqlDialect
): Expression<SqlBool> | undefined => {
  if (!("subject" in f)) return undefined;
  const s = f.subject;
  const read = sql.id(s.name);
  if (dialect.column(read, s.nativeType) !== read) return undefined;
  const own = (v: FilterValue) =>
    isPlanValue(v) ? dialect.ownValue(v, s) : undefined;
  // A conjunct of the where is in positive position: `eq` and `in` leave out
  // what the column's type cannot hold, as `compileFilter` does there; a `ne`
  // or `notIn` with such a value stays in the where, which compares it
  // exactly, as no value outside the column's own type is bound here.
  const besideValues = (values: readonly PlanValue[], eq: boolean) => {
    const { held, wider, unbound } = dialect.equalityValues(values, s);
    return eq || (wider.length === 0 && !unbound) ? held : undefined;
  };
  switch (f.kind) {
    case "isNull":
      return sql<SqlBool>`${read} ${f.isNull ? sql`is null` : sql`is not null`}`;
    case "compare": {
      let v = f.value;
      if (!isPlanValue(v)) return undefined;
      if (f.op === "eq" || f.op === "ne") {
        const values = besideValues([v], f.op === "eq");
        if (!values) return undefined;
        if (values.length === 0) return noValueLeft(read, f.op);
        v = values[0]!;
      }
      const bound = own(v);
      return bound && sql<SqlBool>`${read} ${COMPARE_SQL[f.op]} ${bound}`;
    }
    case "between": {
      const low = own(f.low);
      const high = own(f.high);
      return low && high && sql<SqlBool>`${read} between ${low} and ${high}`;
    }
    case "in": {
      const exact = besideValues(f.values, f.op === "in");
      if (!exact) return undefined;
      if (exact.length === 0) {
        return noValueLeft(read, f.op === "in" ? "eq" : "ne");
      }
      if (exact.length > IN_LIST_MAX) return undefined;
      const values = exact.map(own);
      if (values.some((v) => v === undefined)) return undefined;
      return sql<SqlBool>`${read} ${f.op === "in" ? sql`in` : sql`not in`} (${sql.join(values as Expression<unknown>[])})`;
    }
    case "match": {
      const escaped = escapeLike(f.value);
      return dialect.ownMatch(
        read,
        f.op === "contains" ? `%${escaped}%` : `${escaped}%`,
        s.nativeType
      );
    }
    default:
      return undefined;
  }
};

/**
 * Splits `where` into the conditions applied beside the rule of a table of
 * `aliases` (each a whole conjunct of the where, on one column of that
 * table, `besideRule`), by alias, and what is left. Nothing inside an `or`,
 * a `not` or a `case` moves, nor anything of `having`.
 */
const pushDown = <S extends WhereSubject>(
  where: ResolvedFilter<S> | undefined,
  aliases: ReadonlySet<string>,
  comp: Compilation
): {
  pushed: Map<string, Pushed[]>;
  rest: ResolvedFilter<S> | undefined;
} => {
  const pushed = new Map<string, Pushed[]>();
  if (!where || aliases.size === 0 || !comp.pushDown) {
    return { pushed, rest: where };
  }
  const rest: ResolvedFilter<S>[] = [];
  for (const f of conjuncts(where)) {
    const subject = "subject" in f ? (f.subject as WhereSubject) : undefined;
    const onColumn =
      subject && "alias" in subject && aliases.has(subject.alias)
        ? subject
        : undefined;
    const compiled =
      onColumn && besideRule(f as ResolvedFilter<ColumnRef>, comp.dialect);
    if (onColumn && compiled) {
      const list = pushed.get(onColumn.alias) ?? [];
      list.push({ filter: f as ResolvedFilter<ColumnRef>, sql: compiled });
      pushed.set(onColumn.alias, list);
    } else {
      rest.push(f);
    }
  }
  if (pushed.size === 0) return { pushed, rest: where };
  return {
    pushed,
    rest:
      rest.length === 0
        ? undefined
        : rest.length === 1
          ? rest[0]
          : { kind: "and", filters: rest },
  };
};

/**
 * Compiles a plan to SQL text and bound parameters without touching a
 * database. `fetch` is what the engine asks the database for (the requested
 * limit plus one, to see whether more rows exist); `plan.limit` and
 * `plan.offset` are not read. With `fetch.defaultOrder` false, a plan whose
 * order the planner supplied (`plan.defaultOrder`) is compiled with no order
 * at all, so the database need not sort before its first row. Throws `QueryError` `too_many_parameters` when the statement binds more
 * values than the dialect's engine takes.
 */
export const compileSql = (
  plan: SqlPlan,
  dialect: SqlDialect,
  fetch: { limit: number; offset: number; defaultOrder?: boolean },
  /** `pushDown: false` keeps every condition of the caller's outside the rule's read: for tests that compare the two. */
  options: { pushDown?: boolean } = {}
): CompiledQuery => {
  const compile = (provides?: ReadonlyMap<string, readonly string[]>) => {
    const comp: Compilation = {
      dialect,
      staging: { statements: [] },
      scope: "",
      reads: new Map(),
      ruled: new Map(),
      provides,
      made: new Map(),
      pushDown: options.pushDown ?? true,
    };
    const qb =
      plan.kind === "metrics"
        ? compileMetrics(plan, comp, fetch)
        : compileTable(plan, comp, fetch);
    return { comp, qb };
  };
  const first = compile();
  if (first.comp.ruled.size === 0) {
    return finish(first.qb, first.comp.staging, dialect);
  }
  // A ruled table provides only the columns its references read, which are
  // known once the whole plan is compiled: it is compiled again, alike.
  const provides = new Map<string, readonly string[]>();
  for (const [at, key] of first.comp.ruled) {
    const names = new Set([
      ...(provides.get(key) ?? []),
      ...(first.comp.reads.get(at) ?? []),
    ]);
    provides.set(key, [...names].sort());
  }
  const second = compile(provides);
  for (const [at, key] of second.comp.ruled) {
    for (const name of second.comp.reads.get(at) ?? []) {
      if (!provides.get(key)!.includes(name)) {
        throw new Error(
          "a ruled table was read for a column it does not provide"
        );
      }
    }
  }
  return finish(second.qb, second.comp.staging, dialect);
};

/**
 * The staging statements, then the query, as one batch with its parameters
 * numbered across both. Kysely puts a query inside raw SQL in parentheses,
 * which a statement of its own must not have: the query's text is the batch's
 * after the statements' own text, which numbers its parameters alike.
 */
const staged = (
  qb: AnySelect,
  statements: readonly Expression<unknown>[],
  dialect: SqlDialect
): { sql: string; parameters: readonly unknown[] } => {
  const before = sql`${sql.join(statements, sql` `)}`;
  const prefix = before.compile(dialect.kysely).sql + " (";
  const batch = sql`${before} ${qb}`.compile(dialect.kysely);
  if (!batch.sql.startsWith(prefix) || !batch.sql.endsWith(")")) {
    throw new Error("a staged query did not compile as expected");
  }
  return {
    sql: `${prefix.slice(0, -1)}${batch.sql.slice(prefix.length, -1)}`,
    parameters: batch.parameters,
  };
};

/**
 * The statement's text and parameters, after its staging statements, refused
 * when it binds more than the engine takes.
 */
const finish = (
  qb: AnySelect,
  { statements }: Staging,
  dialect: SqlDialect
): CompiledQuery => {
  const { sql: text, parameters } =
    statements.length === 0 ? qb.compile() : staged(qb, statements, dialect);
  if (parameters.length > dialect.maxParameters) {
    throw new QueryError(
      "too_many_parameters",
      `The query binds ${parameters.length} values; this source takes at most ${dialect.maxParameters} in one query, paging included`,
      []
    );
  }
  return { sql: text, parameters: [...parameters] };
};

/**
 * One part of a metric query: its measure's aggregate over its home table and
 * joins, its rows cut to the range on its date column, grouped by the bucket
 * of it as `period`. It selects its value as `v<k>` and null as every other
 * part's, so the union keeps each measure's own type in its own column.
 */
const partQuery = (
  plan: MetricPlan,
  part: MetricPart,
  k: number,
  outer: Compilation
): AnySelect => {
  const comp = { ...outer, scope: `p${k}.` };
  const { dialect } = comp;
  const ctx = levelContext(comp, false);
  const bounds: ResolvedFilter<ColumnRef>[] = [];
  for (const op of ["gte", "lt"] as const) {
    const bound = part.range[op];
    if (bound !== undefined) {
      bounds.push({ kind: "compare", op, subject: part.date!, value: bound });
    }
  }
  // The range is the query's: on the part's own table, beside its rule
  // where it cannot raise.
  const { pushed, rest } = pushDown(
    bounds.length === 0 ? undefined : { kind: "and", filters: bounds },
    part.from.rowFilter ? new Set(["t0"]) : new Set(),
    comp
  );
  let qb = withJoins(
    dialect.kysely.selectFrom(tableSource(part.from, comp, pushed.get("t0"))),
    part.joins,
    comp
  );
  const items: unknown[] = [];
  const named: { expression: Expression<unknown>; alias: string }[] = [];
  let period: Expression<unknown> | undefined;
  if (plan.bucket) {
    period = bucketOf(
      plan.bucket.unit,
      part.date!,
      plan.bucket.fiscalStartMonth,
      plan.bucket.zone,
      dialect,
      ctx
    );
    named.push({ expression: period, alias: "period" });
  }
  const value = compileExpr(part.expr, dialect, ctx);
  // Each other part's column is a null of that part's type: Postgres types a
  // union's columns branch by branch, and two bare nulls would make one text.
  plan.parts.forEach((other, i) =>
    named.push({
      expression:
        i === k ? value : dialect.typedNull(isApproximate(other.expr, dialect)),
      alias: `v${i}`,
    })
  );
  for (const { expression, alias } of named) {
    items.push(sql`${expression}`.as(alias));
  }
  qb = qb.select(items as never);
  // One bound is written alone, as before, not as an `and` of one.
  const range =
    rest?.kind === "and" && rest.filters.length === 1 ? rest.filters[0]! : rest;
  if (range) {
    qb = qb.where(
      compileFilter(range, dialect, columnSubject(comp), { ...ctx, row: true })
    );
  }
  if (period) qb = dialect.groupBy(qb, [{ expression: period, index: 0 }]);
  return withApplied(withFixed(qb, ctx.fixed, comp), ctx.applied);
};

/**
 * A metric query: its parts in a `UNION ALL` as `u`, grouped by `period`
 * (one group without a bucket), each select item computed over the parts'
 * values (`max(u.v<k>)`) and fixed measures' scalar subqueries. With no part
 * (fixed measures only) it reads no table and gives one row.
 */
const compileMetrics = (
  plan: MetricPlan,
  comp: Compilation,
  fetch: { limit: number; offset: number; defaultOrder?: boolean }
): AnySelect => {
  const { dialect } = comp;
  const branches = plan.parts.map((part, k) => partQuery(plan, part, k, comp));
  let qb: AnySelect =
    branches.length === 0
      ? (dialect.kysely.selectNoFrom([]) as unknown as AnySelect)
      : dialect.kysely.selectFrom(
          branches
            .slice(1)
            .reduce((union, branch) => union.unionAll(branch), branches[0]!)
            .as(UNION)
        );
  const ctx = levelContext(comp, false);
  const selected: Expression<unknown>[] = [];
  const outputs: ResolvedSelect[] = [];
  if (plan.bucket) {
    const ref: ColumnRef = {
      alias: UNION,
      name: "period",
      type: "date",
      nativeType: "date",
    };
    selected.push(sql.id(UNION, "period"));
    outputs.push({
      kind: "bucket",
      unit: plan.bucket.unit,
      fiscalStartMonth: plan.bucket.fiscalStartMonth,
      column: ref,
      output: "period",
      type: "date",
    });
  }
  for (const item of plan.select) {
    selected.push(compileExpr(item.expr, dialect, ctx));
    outputs.push({
      kind: "calc",
      expr: item.expr,
      level: "group",
      output: item.output,
      type: item.type,
    });
  }
  qb = qb.select(
    selected.map((e, i) =>
      sql`${dialect.output(outputs[i]!, e)}`.as(`c${i}`)
    ) as never
  );
  if (plan.bucket) {
    qb = dialect.groupBy(qb, [{ expression: selected[0]!, index: 0 }]);
  }
  const ordered = new Set<number>();
  const orderBy =
    fetch.defaultOrder === false && plan.defaultOrder
      ? []
      : plan.orderBy.filter(({ index }) => {
          if (ordered.has(index)) return false;
          ordered.add(index);
          return true;
        });
  for (const { index, direction } of orderBy) {
    qb = dialect.orderBy(
      qb,
      { expression: selected[index]!, alias: sql.id(`c${index}`) },
      direction
    );
  }
  qb = withApplied(withFixed(qb, ctx.fixed, comp), ctx.applied);
  return dialect.page(qb, fetch.limit, fetch.offset, orderBy.length > 0);
};

/** A table query. */
const compileTable = (
  plan: TablePlan,
  comp: Compilation,
  fetch: { limit: number; offset: number; defaultOrder?: boolean }
): AnySelect => {
  const { dialect } = comp;
  // A condition on the from table or an inner-joined one filters it as well
  // before the join as after; on a left-joined one it would turn the outer
  // join's missing rows into rows, so it stays where it is.
  const beside = new Set(
    [
      { alias: plan.from.alias, rowFilter: plan.from.rowFilter },
      ...plan.joins.filter((j) => j.type === "inner"),
    ].flatMap((t) => (t.rowFilter ? [t.alias] : []))
  );
  const { pushed, rest: where } = pushDown(plan.where, beside, comp);
  let qb: AnySelect = withJoins(
    dialect.kysely.selectFrom(
      tableSource(plan.from, comp, pushed.get(plan.from.alias))
    ),
    plan.joins,
    comp,
    pushed
  );
  // The fixed measures read per row, joined once all is compiled.
  const fixed = new Map<string, ScalarPlan>();
  const applied = new Map<string, Expression<unknown>>();

  const selected = plan.select.map((item) =>
    selectExpression(item, comp, fixed, applied)
  );
  qb = qb.select(
    selected.map((e, i) =>
      sql`${dialect.output(plan.select[i]!, e)}`.as(`c${i}`)
    )
  );
  if (plan.distinct) {
    qb = dialect.distinct(
      qb,
      selected.map((expression, index) => ({ expression, index })),
      plan.groupBy.length > 0 || plan.select.some(perGroup)
    );
  }

  if (where) {
    qb = qb.where(
      compileFilter(
        where,
        dialect,
        (s: WhereSubject) =>
          "index" in s
            ? { expression: selected[s.index]!, type: s.type }
            : columnSubject(comp)(s),
        { row: true, comp, fixed, applied }
      )
    );
  }

  if (plan.groupBy.length > 0) {
    qb = dialect.groupBy(
      qb,
      plan.groupBy.map((index) => ({ expression: selected[index]!, index }))
    );
  }

  if (
    plan.groupBy.length === 0 &&
    !plan.having &&
    plan.select.some(perGroup) &&
    !plan.select.some(aggregatesRows)
  ) {
    // Group-level items with no aggregate, only fixed measures: a HAVING makes
    // the query one group over all rows, so one row even over none, as an
    // aggregate would give. SQL Server's GROUP BY () gives no row over none.
    qb = qb.having(sql<SqlBool>`1 = 1`);
  } else if (plan.having) {
    qb = qb.having(
      compileFilter(
        plan.having,
        dialect,
        (h: HavingSubject) => ({
          expression: selected[h.index]!,
          type: h.type,
        }),
        { row: false, comp, fixed, applied }
      )
    );
  }

  // SQL Server refuses an expression named twice in ORDER BY, which two select
  // items computing the same thing would give; a repeat changes no order.
  const ordered = new Set<string>();
  const orderBy = (
    fetch.defaultOrder === false && plan.defaultOrder ? [] : plan.orderBy
  ).flatMap((order) => {
    const { target } = order;
    const sorted =
      target.kind === "output"
        ? {
            expression: selected[target.index]!,
            alias: sql.id(`c${target.index}`),
          }
        : { expression: column(target.column, comp) };
    const key = JSON.stringify(sorted.expression.toOperationNode(), (_, v) =>
      typeof v === "bigint" ? `${v}n` : v
    );
    if (ordered.has(key)) return [];
    ordered.add(key);
    return [{ sorted, direction: order.direction }];
  });
  for (const { sorted, direction } of orderBy) {
    qb = dialect.orderBy(qb, sorted, direction);
  }

  qb = withApplied(withFixed(qb, fixed, comp), applied);
  return dialect.page(qb, fetch.limit, fetch.offset, orderBy.length > 0);
};
