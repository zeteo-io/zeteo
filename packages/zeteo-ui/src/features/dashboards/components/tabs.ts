export type DashboardsTab = "mine" | "shared" | "panels";

export const TABS: { id: DashboardsTab; label: string }[] = [
  { id: "mine", label: "My dashboards" },
  { id: "shared", label: "Shared with me" },
  { id: "panels", label: "Saved panels" },
];

export const isTab = (value: string | null): value is DashboardsTab =>
  TABS.some((t) => t.id === value);

/** The address of a tab of the Dashboards section. */
export const dashboardsHref = (tab: DashboardsTab) =>
  tab === "mine" ? "/dashboards" : `/dashboards?tab=${tab}`;
