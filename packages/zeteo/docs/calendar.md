# The calendar

One calendar for the whole install, kept by an admin. It decides what a business day is, when a
fiscal year starts and which time zone "now" is in. There is no calendar per source or per
organisation, no external calendar, and a source's own date table is not used as the calendar.

| Field | Rules |
|---|---|
| `working_days` | Weekdays as numbers, 1 (Monday) to 7 (Sunday), each once, at least one. Default Monday to Friday (`[1,2,3,4,5]`). |
| `holidays` | `{ date, name }` entries, `date` as `YYYY-MM-DD`, unique by date, at most 5,000. A holiday on a non-working day has no effect. Default none. |
| `fiscal_year_start_month` | 1 to 12. Default 1 (January). |
| `time_zone` | An IANA name the server can format in, current or legacy (`Asia/Kolkata` and `Asia/Calcutta` both), kept as given; an offset such as `+05:00` is refused. Default `UTC`. |

A **business day** is a working weekday that is not a holiday. With the defaults, everything
behaves as it did before the calendar existed.

## The API

| Call | Permission | Returns |
|---|---|---|
| `GET /v1/calendar` | `zeteo.data.read` | the calendar: `working_days`, `holidays`, `fiscal_year_start_month`, `time_zone` and `updated_at` (null while it has never been saved) |
| `PUT /v1/calendar` | `zeteo.calendar.write` | the calendar, after replacing it whole (audited as `zeteo.calendar.updated`) |

`zeteo.calendar.write` ("Manage the calendar") is on `zeteo_admin` only. The SDK has
`zeteo.calendar.get()` and `zeteo.calendar.replace()`.

## What the calendar changes in queries

- **Business-day functions** (`businessDays`, `businessDaysBetween`, `businessDaysIn`,
  `businessDaysInMonth`, `businessDaysElapsed`, `businessDaysRemaining`, `addBusinessDays`, the
  `datePart` part `business_day`, the filter operator `isBusinessDay` and, in a metric's formula,
  `businessDaysInPeriod`) count with the working days and holidays, over columns or any date or
  timestamp expression: see below.
- **Fiscal buckets and relative units**: `fiscal_quarter` and `fiscal_year` as a `bucket` return
  the start date of the fiscal period; as a relative date `unit` they offset in those units, and
  `startOf` cuts to the period's start. `datePart` `fiscal_year` is the calendar year in which the
  fiscal year ends.
- **Time zone**: "now" for relative dates (in `where`, a measure's filter, calendar functions and a
  dashboard's time range) is read in the calendar's time zone: `startOf` yesterday is that zone's
  midnight, sent as a UTC instant for timestamp columns and as a calendar date for date columns.
  Every business-day function and `isBusinessDay` read a timestamp as its date in the calendar's
  time zone (a pick at 23:00 on a Thursday in Los Angeles is Thursday); a date is used as it is.
  Buckets and the other `datePart` parts on timestamp columns stay in UTC.

The calendar's values are folded into the plan as bound values, so changing the calendar changes
plans and with them the dashboard cache's identity: nothing else is invalidated.

## Business days in queries

| Form | Result |
|---|---|
| `{ "businessDays": [start, end] }` | business days from `start` to `end`, both inclusive, 0 when `end` is before `start` (Excel's NETWORKDAYS) |
| `{ "businessDaysBetween": [start, end] }` | business days after `start` through `end`: a duration, negative when `end` is before `start` (Monday to Tuesday is 1, Friday to Monday 1 with a Monday-to-Friday week) |
| `{ "businessDaysIn": [unit, date] }` | business days of the period of `unit` holding `date` |
| `{ "businessDaysInMonth": date }` | `businessDaysIn` `["month", date]` |
| `{ "businessDaysElapsed": date }` or `[unit, date]` | the period's first day through `date`, inclusive (the month without a unit) |
| `{ "businessDaysRemaining": date }` or `[unit, date]` | after `date` through the period's last day (the month without a unit) |
| `{ "addBusinessDays": [date, n] }` | the date `n` business days after `date` (before it when `n` is negative), `n` any number expression truncated toward zero; counted from `date` itself as Excel's WORKDAY (Saturday + 1 is Monday, Saturday - 1 is Friday), except that `n = 0` gives `date` when it is a business day, else the next one |
| `{ "datePart": ["business_day", date] }` | which business day of its month `date` is (`businessDaysElapsed` of the month); 0 before the month's first |
| `where: { path: { "isBusinessDay": true \| false } }` | rows whose date or timestamp is (or is not) a business day; also in a `case`'s `if`, not in `having`; a null date matches neither |
| `{ "businessDaysInPeriod": true }` | in a metric's formula only: the business days of each period of the query's `bucket`, or of its `range` without one ([measures.md](measures.md)) |

A `unit` is `week` (ISO, from Monday, as the `week` bucket), `month`, `quarter`, `year`,
`fiscal_quarter` or `fiscal_year`. Each operand is a column, a bucket's column, a date operation, a
literal or a relative date; anything that is not a date or timestamp is refused with
`invalid_operator`. A function whose operands are all literals is computed when the query is
planned and bound as a value; any other is computed per row, so it can be filtered, grouped,
ordered and aggregated like any row-level calculation (`{ "avg": { "businessDaysBetween":
["opened_at", "closed_at"] } }` is an average turnaround in business days).

How it is computed: in closed form, with no calendar table. Days count from 1900-01-01 (a
Monday); a date's business ordinal is its working weekdays since then less the holidays on or
before it, and every count is a difference of two ordinals. The holidays go into the query as one
bound parameter (an integer array on Postgres, a JSON text on SQL Server), the working weekdays as
integers in the SQL. Each function is one scalar subquery; on SQL Server, which aggregates no
subquery, a per-row one is applied to every row (`OUTER APPLY`) and read as a column. Any date
counts, however far from now.

A timestamp's date in the calendar's zone: Postgres converts natively (`AT TIME ZONE`, the zone
name bound). SQL Server knows only Windows zone names, so Zeteo binds the zone's UTC offsets from
January 1st 25 years before the current year to January 1st 26 years after it, computed from the
same zone rules, and adds the one in effect. Outside that window a timestamp's business days are
null on both engines, so both give the same answers. A calendar in `UTC` (or any zone at UTC
throughout) converts nothing and has no window.

Null: when an operand is null; when a date, or the first day of its period, is before 1900-01-01;
when `addBusinessDays`' result would be before 1900-01-01 or after 9999-12-31, or `n` is beyond
±3,000,000.

## Not supported

- Business hours, and a calendar per location or per source: one calendar for the install.
- On SQL Server, a period that ends after 9999-12-31 (in the last days of year 9999) cannot be
  counted: the server refuses the date.
- The admin UI keeps the holiday list by year and shows which years have holidays entered; queries
  give no warning when a year has none.

The language side is in [querying.md](querying.md), measures in [measures.md](measures.md).
