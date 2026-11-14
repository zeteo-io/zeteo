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
];
