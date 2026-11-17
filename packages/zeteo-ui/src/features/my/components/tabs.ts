export type MyTab = "overview" | "mine" | "shared" | "runs" | "catalog";

export const TABS: { id: MyTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "mine", label: "My saved queries" },
  { id: "shared", label: "Shared with me" },
  { id: "runs", label: "Recent runs" },
  { id: "catalog", label: "What I can query" },
];

export const isTab = (value: string | null): value is MyTab =>
  TABS.some((t) => t.id === value);

/** The address of a tab, optionally with one saved query picked out. */
export const tabHref = (tab: MyTab, savedQueryId?: string) => {
  const params = new URLSearchParams();
  if (tab !== "overview") params.set("tab", tab);
  if (savedQueryId) params.set("saved_query", savedQueryId);
  const search = params.toString();
  return search ? `/my?${search}` : "/my";
};
