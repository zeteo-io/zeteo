/** What can be shared and transferred: each has `/shares` and `/transfer` under its own path. */
export type SharedObjectType = "saved_query" | "dashboard" | "saved_panel";

const RESOURCE: Record<SharedObjectType, string> = {
  saved_query: "saved-queries",
  dashboard: "dashboards",
  saved_panel: "saved-panels",
};

/** The query-key prefix of the object's resource: invalidating it refreshes every list and view of it. */
export const resourceKey = (type: SharedObjectType) => [RESOURCE[type]];

/** The object's address in the API. */
export const objectPath = (type: SharedObjectType, id: string) =>
  `/v1/${RESOURCE[type]}/${id}`;

/** The object's name in a sentence ("saved query", "dashboard", "saved panel"). */
export const NOUNS: Record<SharedObjectType, string> = {
  saved_query: "saved query",
  dashboard: "dashboard",
  saved_panel: "saved panel",
};
