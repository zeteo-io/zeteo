export { createZeteoClient } from "./client.js";
export type { ZeteoClient, ZeteoClientOptions } from "./client.js";
export { zeteoPlugin } from "./plugin.js";
export { ZETEO_TEMPLATE } from "./template.js";
export type { ZeteoCredentials } from "./template.js";
export {
  ZeteoError,
  QueryRefusedError,
  ExportInterruptedError,
} from "./errors.js";
export { paginate } from "./paginate.js";
export type {
  Page,
  ListOptions,
  ColumnType,
  PrincipalType,
  SourceType,
  HealthStatus,
} from "./types/common.js";
export type {
  Path,
  Alias,
  SelectItem,
  JoinItem,
  FilterValue,
  FilterOperators,
  Filter,
  Query,
  QueryWarning,
  QueryResult,
} from "./types/query.js";
export type {
  GetCatalogOptions,
  DiscoveredColumn,
  DiscoveredRelation,
  DiscoveredTable,
  DiscoveredSource,
  Catalog,
} from "./types/catalog.js";
export type { RunOutcome, QueryRun, ListRunsOptions } from "./types/runs.js";
export type { ExportEnd, ExportRows, ExportStream } from "./calls/export.js";
