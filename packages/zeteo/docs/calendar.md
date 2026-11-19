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

- **Business-day functions** (`businessDays`, `businessDaysInMonth`, `businessDaysElapsed`,
  `businessDaysRemaining`) count with the working days and holidays. `businessDaysInMonth` also takes
  a column (or any date or timestamp expression, a bucket included): see below.
- **Fiscal buckets and relative units**: `fiscal_quarter` and `fiscal_year` as a `bucket` return
  the start date of the fiscal period; as a relative date `unit` they offset in those units, and
  `startOf` cuts to the period's start. `datePart` `fiscal_year` is the calendar year in which the
  fiscal year ends.
- **Time zone**: "now" for relative dates (in `where`, a measure's filter, calendar functions and a
  dashboard's time range) is read in the calendar's time zone: `startOf` yesterday is that zone's
  midnight, sent as a UTC instant for timestamp columns and as a calendar date for date columns.
  Buckets on timestamp columns stay in UTC.

The calendar's values are folded into the plan as bound values, so changing the calendar changes
plans and with them the dashboard cache's identity: nothing else is invalidated.

## `businessDaysInMonth` over a column

Given a date or timestamp expression, `businessDaysInMonth` is the business days in that value's
month, per row: for a daily budget charted per month, `{ "div": [{ "sum": "aop" }, { "businessDaysInMonth": "month" }] }`.
Zeteo sends the calendar's per-month counts for a window of 25 years either side of now as bound
parameters (Postgres arrays, SQL Server one JSON parameter) and looks the month up; a month
outside the window, or a null value, gives null. A timestamp is read as its UTC date, as buckets are.

## Not supported

- `businessDays`, `businessDaysElapsed` and `businessDaysRemaining` take a date literal or a
  relative date; a column is refused with `invalid_operator`.
- The admin UI keeps the holiday list by year and shows which years have holidays entered; queries
  give no warning when a year has none.

The language side is in [querying.md](querying.md), measures in [measures.md](measures.md).
