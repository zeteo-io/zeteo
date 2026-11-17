import type { TimeRangeKey } from "./api/types";

/** Each range's name, in the order a picker lists them. */
export const TIME_RANGE_LABELS: Record<TimeRangeKey, string> = {
  last_15_minutes: "Last 15 minutes",
  last_hour: "Last hour",
  last_6_hours: "Last 6 hours",
  last_24_hours: "Last 24 hours",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  last_6_months: "Last 6 months",
  last_year: "Last year",
  last_2_years: "Last 2 years",
  today: "Today",
  this_week: "This week",
  this_month: "This month",
  this_quarter: "This quarter",
  this_year: "This year",
  previous_week: "Previous week",
  previous_month: "Previous month",
  previous_quarter: "Previous quarter",
  previous_year: "Previous year",
};
