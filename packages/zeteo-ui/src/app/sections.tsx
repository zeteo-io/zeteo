export interface Section {
  path: string;
  label: string;
  /** Held to see the section; `write` and `admin` include `read`. */
  permission: string;
  /** `admin` sections sit under the top bar's Admin menu; the rest are top-bar items of their own. */
  group?: "admin";
  /**
   * When set, the menus list the section only to holders of one of these as
   * well; the route stays open to `permission`.
   */
  listedFor?: string[];
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
    path: "/connections",
    label: "Connections",
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
    // Read by anyone who can query (the route), changed with
    // `zeteo.calendar.write`; listed only to those who may change it or
    // administer sources, so a query-only user gets no Admin menu.
    path: "/calendar",
    label: "Calendar",
    permission: "zeteo.data.read",
    group: "admin",
    listedFor: ["zeteo.calendar.write", "zeteo.sources.read"],
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

/** Whether the menus list the section to someone holding what `has` says. */
export const isListed = (
  section: Section,
  has: (permission: string) => boolean
): boolean => has(section.permission) && (section.listedFor?.some(has) ?? true);

/** The top-bar items of their own. */
export const USER_SECTIONS = SECTIONS.filter((s) => s.group !== "admin");

/** What the Admin menu lists. */
export const ADMIN_SECTIONS = SECTIONS.filter((s) => s.group === "admin");
