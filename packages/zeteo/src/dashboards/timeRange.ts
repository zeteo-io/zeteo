import type { RelativeDate } from "../adapters/sql/relative.js";

export const TIME_RANGE_KEYS = [
  "last_15_minutes",
  "last_hour",
  "last_6_hours",
  "last_24_hours",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "last_6_months",
  "last_year",
  "last_2_years",
  "today",
  "this_week",
  "this_month",
  "this_quarter",
  "this_year",
  "previous_week",
  "previous_month",
  "previous_quarter",
  "previous_year",
] as const;

export type TimeRangeKey = (typeof TIME_RANGE_KEYS)[number];

type Unit = RelativeDate["relative"]["unit"];

const at = (unit: Unit, offset: number, startOf?: true): RelativeDate => ({
  relative: startOf ? { unit, offset, startOf } : { unit, offset },
});

/** "The last N units": from N units before now to the start of the next minute. */
const last = (unit: Unit, n: number) => ({
  start: at(unit, -n),
  end: at("minute", 1, true),
});

/** A calendar unit `offset` units from this one: from its start to the next one's. */
const calendar = (unit: Unit, offset: number) => ({
  start: at(unit, offset, true),
  end: at(unit, offset + 1, true),
});

/** Each range as a half-open interval [start, end) of relative dates. */
export const TIME_RANGES: Record<
  TimeRangeKey,
  { start: RelativeDate; end: RelativeDate }
> = {
  last_15_minutes: last("minute", 15),
  last_hour: last("hour", 1),
  last_6_hours: last("hour", 6),
  last_24_hours: last("hour", 24),
  last_7_days: last("day", 7),
  last_30_days: last("day", 30),
  last_90_days: last("day", 90),
  last_6_months: last("month", 6),
  last_year: last("year", 1),
  last_2_years: last("year", 2),
  today: calendar("day", 0),
  this_week: calendar("week", 0),
  this_month: calendar("month", 0),
  this_quarter: calendar("quarter", 0),
  this_year: calendar("year", 0),
  previous_week: calendar("week", -1),
  previous_month: calendar("month", -1),
  previous_quarter: calendar("quarter", -1),
  previous_year: calendar("year", -1),
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The query with `<column> >= start` and `<column> < end` ANDed onto its
 * `where`: `{ and: [<stored where>, { <column>: { gte: start } }, { <column>: { lt: end } }] }`,
 * without the stored part when it had none. Two conditions, as the language
 * takes one operator per path. A new object: the stored query is not changed.
 * Anything but an object is returned as it was, for the planner to refuse.
 */
export const withTimeFilter = (
  query: unknown,
  column: string,
  key: TimeRangeKey
): unknown => {
  if (!isObject(query)) return query;
  const { start, end } = TIME_RANGES[key];
  const bounds = [{ [column]: { gte: start } }, { [column]: { lt: end } }];
  return {
    ...query,
    where: {
      and: query.where === undefined ? bounds : [query.where, ...bounds],
    },
  };
};
