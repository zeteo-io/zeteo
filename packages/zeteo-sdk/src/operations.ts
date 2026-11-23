export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const OPERATIONS = {
  getHealth: { method: "GET", path: "/health" },
  listSources: { method: "GET", path: "/v1/sources" },
  createSource: { method: "POST", path: "/v1/sources" },
  getSource: { method: "GET", path: "/v1/sources/{sourceId}" },
  updateSource: { method: "PATCH", path: "/v1/sources/{sourceId}" },
  deleteSource: { method: "DELETE", path: "/v1/sources/{sourceId}" },
  archiveSource: { method: "POST", path: "/v1/sources/{sourceId}/archive" },
  testSource: { method: "POST", path: "/v1/sources/{sourceId}/test" },
  transferSource: {
    method: "POST",
    path: "/v1/sources/{sourceId}/transfer",
  },
  refreshSource: { method: "POST", path: "/v1/sources/{sourceId}/refresh" },
  listTables: { method: "GET", path: "/v1/sources/{sourceId}/tables" },
  addTables: { method: "POST", path: "/v1/sources/{sourceId}/tables" },
  getTable: {
    method: "GET",
    path: "/v1/sources/{sourceId}/tables/{tableId}",
  },
  patchTable: {
    method: "PATCH",
    path: "/v1/sources/{sourceId}/tables/{tableId}",
  },
  reuploadTable: {
    method: "PUT",
    path: "/v1/sources/{sourceId}/tables/{tableId}",
  },
  putMergedTable: {
    method: "PUT",
    path: "/v1/sources/{sourceId}/tables/{tableId}/merged",
  },
  deleteTable: {
    method: "DELETE",
    path: "/v1/sources/{sourceId}/tables/{tableId}",
  },
  updateColumn: {
    method: "PATCH",
    path: "/v1/sources/{sourceId}/tables/{tableId}/columns/{columnId}",
  },
  createMergedTable: {
    method: "POST",
    path: "/v1/sources/{sourceId}/merged-tables",
  },
  getMergedColumns: {
    method: "GET",
    path: "/v1/sources/{sourceId}/merged-tables/columns",
  },
  listRelations: { method: "GET", path: "/v1/sources/{sourceId}/relations" },
  declareRelation: {
    method: "POST",
    path: "/v1/sources/{sourceId}/relations",
  },
  updateRelation: {
    method: "PATCH",
    path: "/v1/sources/{sourceId}/relations/{relationId}",
  },
  deleteRelation: {
    method: "DELETE",
    path: "/v1/sources/{sourceId}/relations/{relationId}",
  },
  createUpload: { method: "POST", path: "/v1/uploads" },
  createUploadFromLink: { method: "POST", path: "/v1/uploads/links" },
  getGoogleConnection: { method: "GET", path: "/v1/connections/google" },
  putGoogleConnection: { method: "PUT", path: "/v1/connections/google" },
  deleteUpload: { method: "DELETE", path: "/v1/uploads/{uploadId}" },
  listGrants: { method: "GET", path: "/v1/grants" },
  createGrant: { method: "POST", path: "/v1/grants" },
  getGrant: { method: "GET", path: "/v1/grants/{grantId}" },
  replaceGrant: { method: "PUT", path: "/v1/grants/{grantId}" },
  deleteGrant: { method: "DELETE", path: "/v1/grants/{grantId}" },
  getEffectiveAccess: { method: "GET", path: "/v1/grants/effective" },
  listIdentityKeys: { method: "GET", path: "/v1/identity-keys" },
  createIdentityKey: { method: "POST", path: "/v1/identity-keys" },
  updateIdentityKey: { method: "PATCH", path: "/v1/identity-keys/{keyId}" },
  deleteIdentityKey: { method: "DELETE", path: "/v1/identity-keys/{keyId}" },
  listIdentityValues: {
    method: "GET",
    path: "/v1/identity-keys/{keyId}/values",
  },
  addIdentityValues: {
    method: "POST",
    path: "/v1/identity-keys/{keyId}/values",
  },
  deleteIdentityValue: {
    method: "DELETE",
    path: "/v1/identity-keys/{keyId}/values/{valueId}",
  },
  listMissingIdentityValues: {
    method: "GET",
    path: "/v1/identity-keys/{keyId}/missing",
  },
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
  listMyRuns: { method: "GET", path: "/v1/me/runs" },
  searchMyPrincipals: { method: "GET", path: "/v1/me/principals" },
  listAllMyPrincipals: { method: "GET", path: "/v1/me/principals/all" },
  listSavedQueries: { method: "GET", path: "/v1/saved-queries" },
  createSavedQuery: { method: "POST", path: "/v1/saved-queries" },
  getSavedQuery: { method: "GET", path: "/v1/saved-queries/{savedQueryId}" },
  updateSavedQuery: {
    method: "PATCH",
    path: "/v1/saved-queries/{savedQueryId}",
  },
  deleteSavedQuery: {
    method: "DELETE",
    path: "/v1/saved-queries/{savedQueryId}",
  },
  copySavedQuery: {
    method: "POST",
    path: "/v1/saved-queries/{savedQueryId}/copy",
  },
  runSavedQuery: {
    method: "POST",
    path: "/v1/saved-queries/{savedQueryId}/run",
  },
  exportSavedQuery: {
    method: "POST",
    path: "/v1/saved-queries/{savedQueryId}/export",
  },
  listSavedQueryShares: {
    method: "GET",
    path: "/v1/saved-queries/{savedQueryId}/shares",
  },
  replaceSavedQueryShares: {
    method: "PUT",
    path: "/v1/saved-queries/{savedQueryId}/shares",
  },
  transferSavedQuery: {
    method: "POST",
    path: "/v1/saved-queries/{savedQueryId}/transfer",
  },
  listSavedQueryDashboards: {
    method: "GET",
    path: "/v1/saved-queries/{savedQueryId}/dashboards",
  },
  listDashboards: { method: "GET", path: "/v1/dashboards" },
  createDashboard: { method: "POST", path: "/v1/dashboards" },
  getDashboard: { method: "GET", path: "/v1/dashboards/{dashboardId}" },
  updateDashboard: { method: "PATCH", path: "/v1/dashboards/{dashboardId}" },
  deleteDashboard: { method: "DELETE", path: "/v1/dashboards/{dashboardId}" },
  copyDashboard: {
    method: "POST",
    path: "/v1/dashboards/{dashboardId}/copy",
  },
  runDashboard: { method: "POST", path: "/v1/dashboards/{dashboardId}/run" },
  listDashboardShares: {
    method: "GET",
    path: "/v1/dashboards/{dashboardId}/shares",
  },
  replaceDashboardShares: {
    method: "PUT",
    path: "/v1/dashboards/{dashboardId}/shares",
  },
  transferDashboard: {
    method: "POST",
    path: "/v1/dashboards/{dashboardId}/transfer",
  },
  addDashboardPanel: {
    method: "POST",
    path: "/v1/dashboards/{dashboardId}/panels",
  },
  updateDashboardPanel: {
    method: "PATCH",
    path: "/v1/dashboards/{dashboardId}/panels/{panelId}",
  },
  removeDashboardPanel: {
    method: "DELETE",
    path: "/v1/dashboards/{dashboardId}/panels/{panelId}",
  },
  detachDashboardPanel: {
    method: "POST",
    path: "/v1/dashboards/{dashboardId}/panels/{panelId}/detach",
  },
  saveDashboardPanel: {
    method: "POST",
    path: "/v1/dashboards/{dashboardId}/panels/{panelId}/save",
  },
  listSavedPanels: { method: "GET", path: "/v1/saved-panels" },
  createSavedPanel: { method: "POST", path: "/v1/saved-panels" },
  getSavedPanel: { method: "GET", path: "/v1/saved-panels/{savedPanelId}" },
  updateSavedPanel: {
    method: "PATCH",
    path: "/v1/saved-panels/{savedPanelId}",
  },
  deleteSavedPanel: {
    method: "DELETE",
    path: "/v1/saved-panels/{savedPanelId}",
  },
  copySavedPanel: {
    method: "POST",
    path: "/v1/saved-panels/{savedPanelId}/copy",
  },
  previewSavedPanel: {
    method: "POST",
    path: "/v1/saved-panels/{savedPanelId}/preview",
  },
  listSavedPanelShares: {
    method: "GET",
    path: "/v1/saved-panels/{savedPanelId}/shares",
  },
  replaceSavedPanelShares: {
    method: "PUT",
    path: "/v1/saved-panels/{savedPanelId}/shares",
  },
  transferSavedPanel: {
    method: "POST",
    path: "/v1/saved-panels/{savedPanelId}/transfer",
  },
  listMeasures: { method: "GET", path: "/v1/sources/{sourceId}/measures" },
  createMeasure: { method: "POST", path: "/v1/sources/{sourceId}/measures" },
  previewMeasure: {
    method: "POST",
    path: "/v1/sources/{sourceId}/measures/preview",
  },
  getMeasure: {
    method: "GET",
    path: "/v1/sources/{sourceId}/measures/{measureId}",
  },
  updateMeasure: {
    method: "PATCH",
    path: "/v1/sources/{sourceId}/measures/{measureId}",
  },
  deleteMeasure: {
    method: "DELETE",
    path: "/v1/sources/{sourceId}/measures/{measureId}",
  },
  listMetrics: { method: "GET", path: "/v1/sources/{sourceId}/metrics" },
  createMetric: { method: "POST", path: "/v1/sources/{sourceId}/metrics" },
  previewMetric: {
    method: "POST",
    path: "/v1/sources/{sourceId}/metrics/preview",
  },
  getMetric: {
    method: "GET",
    path: "/v1/sources/{sourceId}/metrics/{metricId}",
  },
  updateMetric: {
    method: "PATCH",
    path: "/v1/sources/{sourceId}/metrics/{metricId}",
  },
  deleteMetric: {
    method: "DELETE",
    path: "/v1/sources/{sourceId}/metrics/{metricId}",
  },
  listMeasureEditors: {
    method: "GET",
    path: "/v1/sources/{sourceId}/measure-editors",
  },
  replaceMeasureEditors: {
    method: "PUT",
    path: "/v1/sources/{sourceId}/measure-editors",
  },
  getCalendar: { method: "GET", path: "/v1/calendar" },
  replaceCalendar: { method: "PUT", path: "/v1/calendar" },
  getMe: { method: "GET", path: "/v1/me" },
  searchPrincipals: { method: "GET", path: "/v1/principals" },
  lookupPrincipals: { method: "POST", path: "/v1/principals/lookup" },
  listAllPrincipals: { method: "GET", path: "/v1/principals/all" },
} as const satisfies Record<string, { method: HttpMethod; path: string }>;

export type OperationId = keyof typeof OPERATIONS;
