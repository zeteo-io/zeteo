export interface Section {
  path: string;
  label: string;
  /** Held to see the section; `write` and `admin` include `read`. */
  permission: string;
  /** `admin` sections sit under the top bar's Admin menu; the rest are top-bar items of their own. */
  group?: "admin";
}

/**
 * Every section: the router reads all of them, the top bar groups them.
 * The order is the landing order too: `/` goes to the first the person may
 * read, so My Zeteo comes first (everyone who may query lands there, admins
 * included) and the admin sections after it, for those who cannot.
 */
export const SECTIONS: Section[] = [
  { path: "/my", label: "My Zeteo", permission: "zeteo.data.read" },
  { path: "/dashboards", label: "Dashboards", permission: "zeteo.data.read" },
  {
    path: "/sources",
    label: "Sources",
    permission: "zeteo.sources.read",
    group: "admin",
  },
  {
    path: "/grants",
    label: "Grants",
    permission: "zeteo.grants.read",
    group: "admin",
  },
  {
    path: "/limits",
    label: "Limits",
    permission: "zeteo.grants.read",
    group: "admin",
  },
  {
    path: "/runs",
    label: "Runs",
    permission: "zeteo.runs.read",
    group: "admin",
  },
  {
    path: "/saved-queries",
    label: "Saved queries",
    permission: "zeteo.saved_queries.read",
    group: "admin",
  },
  {
    path: "/admin/dashboards",
    label: "Dashboards",
    permission: "zeteo.dashboards.read",
    group: "admin",
  },
  {
    path: "/admin/saved-panels",
    label: "Saved panels",
    permission: "zeteo.dashboards.read",
    group: "admin",
  },
];

/** The top-bar items of their own. */
export const USER_SECTIONS = SECTIONS.filter((s) => s.group !== "admin");

/** What the Admin menu lists. */
export const ADMIN_SECTIONS = SECTIONS.filter((s) => s.group === "admin");
