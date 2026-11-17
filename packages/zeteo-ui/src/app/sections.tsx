export interface Section {
  path: string;
  label: string;
  /** Held to see the section; `write` and `admin` include `read`. */
  permission: string;
}

/** The top-level sections: the router and the top bar both read this list. */
export const SECTIONS: Section[] = [
  { path: "/sources", label: "Sources", permission: "zeteo.sources.read" },
  { path: "/grants", label: "Grants", permission: "zeteo.grants.read" },
  { path: "/limits", label: "Limits", permission: "zeteo.grants.read" },
  { path: "/runs", label: "Runs", permission: "zeteo.runs.read" },
  {
    path: "/saved-queries",
    label: "Saved queries",
    permission: "zeteo.saved_queries.read",
  },
  {
    path: "/admin/dashboards",
    label: "Dashboards (all)",
    permission: "zeteo.dashboards.read",
  },
  {
    path: "/admin/saved-panels",
    label: "Saved panels (all)",
    permission: "zeteo.dashboards.read",
  },
  // Near the end, so admins still land on their first admin section and
  // others on My Zeteo, which comes before Dashboards.
  { path: "/my", label: "My Zeteo", permission: "zeteo.data.read" },
  { path: "/dashboards", label: "Dashboards", permission: "zeteo.data.read" },
];
