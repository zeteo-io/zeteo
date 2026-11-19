import type { Holiday } from "../api/types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is a calendar day, "YYYY-MM-DD". */
export const isDate = (value: string) => {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
};

/** `date,name` lines: the holidays they name, and the lines that are not one. */
export const parseHolidayLines = (
  text: string
): { holidays: Holiday[]; bad: string[] } => {
  const holidays: Holiday[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const comma = line.indexOf(",");
    const date = (comma < 0 ? line : line.slice(0, comma)).trim();
    const name = comma < 0 ? "" : line.slice(comma + 1).trim();
    if (!isDate(date) || !name || name.length > 200) bad.push(line);
    else holidays.push({ date, name });
  }
  return { holidays, bad };
};

/** Adds holidays, a later one replacing an earlier one on the same date; sorted by date. */
export const mergeHolidays = (
  current: Holiday[],
  added: Holiday[]
): Holiday[] => {
  const byDate = new Map(current.map((h) => [h.date, h]));
  for (const h of added) byDate.set(h.date, h);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
};

/** The years to list: those with holidays, and this one and the next. */
export const yearsToShow = (holidays: Holiday[], now = new Date()) => {
  const years = new Set(holidays.map((h) => Number(h.date.slice(0, 4))));
  years.add(now.getFullYear());
  years.add(now.getFullYear() + 1);
  return [...years].sort((a, b) => a - b);
};
