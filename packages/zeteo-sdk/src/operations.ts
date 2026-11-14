export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const OPERATIONS = {
  getHealth: { method: "GET", path: "/health" },
  listSources: { method: "GET", path: "/v1/sources" },
  createSource: { method: "POST", path: "/v1/sources" },
  getSource: { method: "GET", path: "/v1/sources/{sourceId}" },
  updateSource: { method: "PATCH", path: "/v1/sources/{sourceId}" },
  archiveSource: { method: "POST", path: "/v1/sources/{sourceId}/archive" },
  testSource: { method: "POST", path: "/v1/sources/{sourceId}/test" },
  refreshSource: { method: "POST", path: "/v1/sources/{sourceId}/refresh" },
  listTables: { method: "GET", path: "/v1/sources/{sourceId}/tables" },
  getTable: {
    method: "GET",
    path: "/v1/sources/{sourceId}/tables/{tableId}",
  },
  patchTable: {
    method: "PATCH",
    path: "/v1/sources/{sourceId}/tables/{tableId}",
  },
  listRelations: { method: "GET", path: "/v1/sources/{sourceId}/relations" },
  declareRelation: {
    method: "POST",
    path: "/v1/sources/{sourceId}/relations",
  },
  deleteRelation: {
    method: "DELETE",
    path: "/v1/sources/{sourceId}/relations/{relationId}",
  },
  listGrants: { method: "GET", path: "/v1/grants" },
  createGrant: { method: "POST", path: "/v1/grants" },
  getGrant: { method: "GET", path: "/v1/grants/{grantId}" },
  replaceGrant: { method: "PUT", path: "/v1/grants/{grantId}" },
  deleteGrant: { method: "DELETE", path: "/v1/grants/{grantId}" },
  listPrincipalLimits: { method: "GET", path: "/v1/principal-limits" },
  createPrincipalLimit: { method: "POST", path: "/v1/principal-limits" },
  getPrincipalLimit: {
    method: "GET",
    path: "/v1/principal-limits/{principalLimitId}",
  },
  updatePrincipalLimit: {
    method: "PATCH",
    path: "/v1/principal-limits/{principalLimitId}",
  },
  deletePrincipalLimit: {
    method: "DELETE",
    path: "/v1/principal-limits/{principalLimitId}",
  },
  getCatalog: { method: "GET", path: "/v1/catalog" },
  runQuery: { method: "POST", path: "/v1/query" },
  exportQuery: { method: "POST", path: "/v1/export" },
  listRuns: { method: "GET", path: "/v1/runs" },
  getMe: { method: "GET", path: "/v1/me" },
  searchPrincipals: { method: "GET", path: "/v1/principals" },
  lookupPrincipals: { method: "POST", path: "/v1/principals/lookup" },
} as const satisfies Record<string, { method: HttpMethod; path: string }>;

export type OperationId = keyof typeof OPERATIONS;
