import type { BusinessDate, ResolvedExpr } from "./types.js";
import type { SqlDialect } from "./dialect.js";
import { sql, type Expression } from "kysely";
import type {
  BusinessUnit,
  CompiledCalendar,
} from "../../calendar/calendar.js";
import {
  BUSINESS_ANCHOR,
  LAST_BUSINESS_DATE,
  LAST_DAY_NUMBER,
  MAX_BUSINESS_DAY_STEP,
} from "../../calendar/calendar.js";

// Business days in closed form, with no calendar table. Day n counts from
// 1900-01-01, a Monday; a date's working-weekday ordinal is whole weeks times
// the working days in one plus the working weekdays of its own week so far,
// and its business ordinal takes off the holidays (bound as their
// working-weekday ordinals) at or before it. Every count is a difference of
// two ordinals. Each function compiles to one scalar subquery whose steps
// are derived tables, so each intermediate value is written once:
//
//   (select <final> as n from (select bd1.*, … from (select … ) as bd0) as bd1)
//
// Identifiers are the compiler's own; the calendar's numbers are bound
// (holidays) or written as integer literals (weekday offsets).

type Ref = (name: string) => Expression<unknown>;
/** One step: names to expressions over the earlier steps' names. */
type Step = Record<string, (ref: Ref) => Expression<unknown>>;

const ANCHOR = sql`cast(${sql.lit(BUSINESS_ANCHOR)} as date)`;
const lit = (n: number) => sql.lit(n);

/** `steps` as nested derived tables, then `final` over the last one, as one scalar subquery. */
const stepped = (
  steps: Step[],
  final: (ref: Ref) => Expression<unknown>
): Expression<unknown> => {
  let from: Expression<unknown> | undefined;
  let alias = "";
  steps.forEach((step, i) => {
    const prev = alias;
    const ref: Ref = (name) => sql.id(prev, name);
    const items = Object.entries(step).map(
      ([name, f]) => sql`${f(ref)} as ${sql.id(name)}`
    );
    from =
      from === undefined
        ? sql`(select ${sql.join(items)})`
        : sql`(select ${sql.id(prev)}.*, ${sql.join(items)} from ${from} as ${sql.id(prev)})`;
    alias = `bd${i}`;
  });
  const last = alias;
  return sql`(select cast(${final((name) => sql.id(last, name))} as int) as ${sql.id("n")} from ${from!} as ${sql.id(last)})`;
};

/** `case <x> when 0 then values[0] … end`. */
const caseOf = (x: Expression<unknown>, values: readonly number[]) =>
  sql`case ${x} ${sql.join(
    values.map((v, i) => sql`when ${lit(i)} then ${lit(v)}`),
    sql` `
  )} end`;

/** The working weekdays from the anchor through day `n`, for `n` from -7 on. */
const weekdayOrdinal = (n: Expression<unknown>, cal: CompiledCalendar) => {
  const W = cal.weekdays.length;
  const prefix = [0, 1, 2, 3, 4, 5, 6].map(
    (r) => cal.weekdays.filter((w) => w <= r).length
  );
  // n + 7 keeps the division and remainder of n = -1 (the day before a
  // range that starts at the anchor) non-negative.
  return sql`((${n} + 7) / 7 * ${lit(W)} - ${lit(W)} + ${caseOf(sql`(${n} + 7) % 7`, prefix)})`;
};

/** 1 when day `n` falls on a working weekday, else 0. */
const isWorkingWeekday = (n: Expression<unknown>, cal: CompiledCalendar) =>
  sql`case when (${n} + 7) % 7 in (${sql.join(cal.weekdays.map(lit))}) then 1 else 0 end`;

/** A date operand as a date: a timestamp's in the calendar's zone. */
const dateOf = (
  x: Expression<unknown>,
  type: BusinessDate["type"],
  cal: CompiledCalendar,
  dialect: SqlDialect
): Expression<unknown> =>
  type === "timestamp" && cal.zone
    ? dialect.zoneDate(x, cal.zone)
    : sql`cast(${x} as date)`;

const FIRST = sql`cast(${sql.lit(BUSINESS_ANCHOR)} as date)`;
const LAST = sql`cast(${sql.lit(LAST_BUSINESS_DATE)} as date)`;

/**
 * Two steps: each date operand of `dates` as a date, then (under the same
 * name) null unless it is within 1900-01-01 to 9998-12-31, before anything
 * shifts it: SQL Server refuses a date past either end of its range, and
 * Postgres an infinite one. `extra` joins the first step.
 */
const guardedDates = (
  dates: Record<string, () => Expression<unknown>>,
  extra: Step = {}
): Step[] => [
  {
    ...Object.fromEntries(
      Object.entries(dates).map(([name, f]) => [`${name}0`, f])
    ),
    ...extra,
  },
  Object.fromEntries(
    Object.keys(dates).map((name) => [
      name,
      (ref: Ref) =>
        sql`case when ${ref(`${name}0`)} >= ${FIRST} and ${ref(`${name}0`)} <= ${LAST} then ${ref(`${name}0`)} end`,
    ])
  ),
];

const dayNumber = (date: Expression<unknown>, dialect: SqlDialect) =>
  dialect.dateDiff("day", ANCHOR, date, "date");

/** The holidays at or before working-weekday ordinal `w`; 0 with none. */
const holidaysThrough = (
  w: Expression<unknown>,
  cal: CompiledCalendar,
  dialect: SqlDialect
): Expression<unknown> =>
  cal.holidays.length === 0
    ? lit(0)
    : dialect.countWhere(cal.holidays, "<=", w);

/**
 * Steps naming `w<name>` (the working-weekday ordinal) and `c<name>` (the
 * holidays through it) for each day number in `days`, so the business
 * ordinal of each is `w<name> - c<name>`.
 */
const ordinalSteps = (
  days: Record<string, (ref: Ref) => Expression<unknown>>,
  cal: CompiledCalendar,
  dialect: SqlDialect
): Step[] => [
  Object.fromEntries(
    Object.entries(days).map(([name, n]) => [
      `w${name}`,
      (ref: Ref) => weekdayOrdinal(n(ref), cal),
    ])
  ),
  Object.fromEntries(
    Object.keys(days).map((name) => [
      `c${name}`,
      (ref: Ref) => holidaysThrough(ref(`w${name}`), cal, dialect),
    ])
  ),
];

const ordinal = (ref: Ref, name: string) =>
  sql`(${ref(`w${name}`)} - ${ref(`c${name}`)})`;

/** The calendar unit a period steps by to its next start. */
const STEP: Record<
  Exclude<BusinessUnit, "day">,
  "week" | "month" | "quarter" | "year"
> = {
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
  fiscal_quarter: "quarter",
  fiscal_year: "year",
};

/**
 * A business-day expression as one scalar subquery yielding an integer: the
 * count, or for `addBusinessDays` the result's day number (`anchorPlus` makes
 * it a date). `operand` compiles an operand where the expression is.
 */
export const compileBusiness = (
  expr: Extract<
    ResolvedExpr,
    { kind: "businessDays" | "businessPeriod" | "addBusinessDays" }
  >,
  dialect: SqlDialect,
  operand: (e: ResolvedExpr) => Expression<unknown>
): Expression<unknown> => {
  const cal = expr.calendar;
  const date = (d: BusinessDate) =>
    dateOf(operand(d.expr), d.type, cal, dialect);
  switch (expr.kind) {
    case "businessDays": {
      const inclusive = expr.fn === "inclusive";
      return stepped(
        [
          ...guardedDates({
            a: () => date(expr.start),
            b: () => date(expr.end),
          }),
          {
            na: (ref) => dayNumber(ref("a"), dialect),
            nb: (ref) => dayNumber(ref("b"), dialect),
          },
          ...ordinalSteps(
            {
              // NETWORKDAYS counts the start: the ordinal of the day before it.
              a: (ref) => (inclusive ? sql`(${ref("na")} - 1)` : ref("na")),
              b: (ref) => ref("nb"),
            },
            cal,
            dialect
          ),
        ],
        (ref) => {
          const count = sql`${ordinal(ref, "b")} - ${ordinal(ref, "a")}`;
          const value = inclusive
            ? sql`case when ${ref("nb")} < ${ref("na")} then 0 else ${count} end`
            : count;
          return sql`case when ${ref("na")} >= 0 and ${ref("nb")} >= 0 then ${value} end`;
        }
      );
    }
    case "businessPeriod": {
      const { unit } = expr;
      const start = (ref: Ref) =>
        dialect.bucket(
          unit as Exclude<BusinessUnit, "day">,
          ref("d"),
          "date",
          "date",
          expr.fiscalStartMonth
        );
      const bounds: Step =
        unit === "day"
          ? {
              n: (ref) => dayNumber(ref("d"), dialect),
              s: (ref) => dayNumber(ref("d"), dialect),
              e: (ref) => dayNumber(ref("d"), dialect),
            }
          : {
              n: (ref) => dayNumber(ref("d"), dialect),
              s: (ref) => dayNumber(start(ref), dialect),
              e: (ref) =>
                sql`(${dayNumber(dialect.dateAdd(start(ref), 1, STEP[unit], "date"), dialect)} - 1)`,
            };
      const days: Record<string, (ref: Ref) => Expression<unknown>> = {
        // The day before the period: what its first day counts from.
        s: (ref) => sql`(${ref("s")} - 1)`,
        e: (ref) => ref("e"),
        n: (ref) => ref("n"),
      };
      const [lo, hi] =
        expr.fn === "in"
          ? ["s", "e"]
          : expr.fn === "elapsed"
            ? ["s", "n"]
            : ["n", "e"];
      return stepped(
        [
          ...guardedDates({ d: () => date(expr.date) }),
          bounds,
          ...ordinalSteps(
            { [lo!]: days[lo!]!, [hi!]: days[hi!]! },
            cal,
            dialect
          ),
        ],
        (ref) =>
          sql`case when ${ref("s")} >= 0 then ${ordinal(ref, hi!)} - ${ordinal(ref, lo!)} end`
      );
    }
    case "addBusinessDays": {
      const W = cal.weekdays.length;
      const amount = operand(expr.amount);
      return stepped(
        [
          ...guardedDates(
            { d: () => date(expr.date) },
            {
              k: () =>
                sql`case when abs(${amount}) <= ${lit(MAX_BUSINESS_DAY_STEP)} then ${dialect.truncate(amount)} end`,
            }
          ),
          { n: (ref) => dayNumber(ref("d"), dialect) },
          {
            w: (ref) => weekdayOrdinal(ref("n"), cal),
            wk: (ref) => isWorkingWeekday(ref("n"), cal),
          },
          {
            c: (ref) => holidaysThrough(ref("w"), cal, dialect),
            h: (ref) =>
              cal.holidays.length === 0
                ? lit(0)
                : dialect.countWhere(cal.holidays, "=", ref("w")),
          },
          {
            // The target's business ordinal; a step back or none from a day
            // that is not a business day counts from the next one.
            t: (ref) =>
              sql`(${ref("w")} - ${ref("c")} + ${ref("k")} + case when ${ref("k")} <= 0 and not (${ref("wk")} = 1 and ${ref("h")} = 0) then 1 else 0 end)`,
          },
          {
            // Its working-weekday ordinal: one more per holiday before it.
            x: (ref) =>
              cal.shifts.length === 0
                ? ref("t")
                : sql`(${ref("t")} + ${dialect.countWhere(cal.shifts, "<=", ref("t"))})`,
          },
          {
            r: (ref) =>
              sql`((${ref("x")} - 1) / ${lit(W)} * 7 + ${caseOf(sql`(${ref("x")} - 1) % ${lit(W)}`, cal.weekdays)})`,
          },
        ],
        (ref) =>
          sql`case when ${ref("n")} >= 0 and ${ref("t")} >= 1 and ${ref("r")} <= ${lit(LAST_DAY_NUMBER)} then ${ref("r")} end`
      );
    }
  }
};

/**
 * 1 when a date or timestamp is a business day, 0 when it is not, null when
 * it is null or outside 1900-01-01 to 9998-12-31, as one scalar subquery.
 */
export const compileBusinessDay = (
  subject: Expression<unknown>,
  type: BusinessDate["type"],
  cal: CompiledCalendar,
  dialect: SqlDialect
): Expression<unknown> =>
  stepped(
    [
      ...guardedDates({ d: () => dateOf(subject, type, cal, dialect) }),
      { n: (ref) => dayNumber(ref("d"), dialect) },
      {
        w: (ref) => weekdayOrdinal(ref("n"), cal),
        wk: (ref) => isWorkingWeekday(ref("n"), cal),
      },
      {
        h: (ref) =>
          cal.holidays.length === 0
            ? lit(0)
            : dialect.countWhere(cal.holidays, "=", ref("w")),
      },
    ],
    (ref) =>
      sql`case when ${ref("n")} >= 0 then case when ${ref("wk")} = 1 and ${ref("h")} = 0 then 1 else 0 end end`
  );
