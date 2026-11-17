/** The auto-refresh choices on a dashboard page, in seconds; null is Off. */
export const REFRESH_CHOICES: (number | null)[] = [
  null,
  60,
  300,
  900,
  1800,
  3600,
];

/** "5 min", "1 hour"; a seconds value that is no whole minute stays in seconds. */
export const intervalLabel = (seconds: number): string => {
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
};

const keyFor = (dashboardId: string) =>
  `zeteo.dashboard.${dashboardId}.refresh`;

/** The viewer's remembered choice here: undefined when none (or storage is blocked), null for Off. */
export const readRefreshChoice = (
  dashboardId: string
): number | null | undefined => {
  try {
    const raw = window.localStorage.getItem(keyFor(dashboardId));
    if (raw === "off") return null;
    const n = Number(raw);
    return raw !== null && Number.isInteger(n) && n >= 60 ? n : undefined;
  } catch {
    return undefined;
  }
};

export const writeRefreshChoice = (
  dashboardId: string,
  seconds: number | null
) => {
  try {
    window.localStorage.setItem(
      keyFor(dashboardId),
      seconds === null ? "off" : String(seconds)
    );
  } catch {
    // Blocked storage: the choice lasts for this page only.
  }
};
