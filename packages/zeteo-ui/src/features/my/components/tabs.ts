export type MyTab =
  "overview" | "mine" | "shared" | "data" | "runs" | "catalog";

export const TABS: { id: MyTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "mine", label: "My saved queries" },
  { id: "shared", label: "Shared with me" },
  // File Sources: shown only with `zeteo.file_sources.write` while they are on.
  { id: "data", label: "My data" },
  { id: "runs", label: "Recent runs" },
  { id: "catalog", label: "What I can query" },
];

export const isTab = (value: string | null): value is MyTab =>
  TABS.some((t) => t.id === value);

/** A saved query's own page. */
export const savedQueryHref = (id: string) => `/my/saved-queries/${id}`;

/** The address of a tab. */
export const tabHref = (tab: MyTab) =>
  tab === "overview" ? "/my" : `/my?tab=${tab}`;
