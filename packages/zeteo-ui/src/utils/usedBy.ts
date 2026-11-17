const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Whether anything uses the object. */
export const isUsed = (used?: { dashboards: number; saved_panels?: number }) =>
  !!used && used.dashboards + (used.saved_panels ?? 0) > 0;

/**
 * The warning before changing what dashboards rely on: a saved query's
 * counts name dashboards and saved panels, a saved panel's dashboards alone.
 */
export const usedByWarning = (used: {
  dashboards: number;
  saved_panels?: number;
}): string =>
  used.saved_panels === undefined
    ? `Used by ${count(used.dashboards, "dashboard", "dashboards")}. They'll change too.`
    : `Used by ${count(used.dashboards, "dashboard", "dashboards")} and ${count(used.saved_panels, "saved panel", "saved panels")}. They'll change too.`;
