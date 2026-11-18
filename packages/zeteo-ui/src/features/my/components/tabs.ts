export type MyTab =
  "overview" | "sources" | "mine" | "shared" | "runs" | "catalog";

export const TABS: { id: MyTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  // Uploads: shown only with `zeteo.uploads.write` while they are on.
  { id: "sources", label: "My sources" },
  { id: "mine", label: "My saved queries" },
  { id: "shared", label: "Shared with me" },
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
