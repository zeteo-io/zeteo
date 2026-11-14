export { createZeteoClient } from "./client.js";
export type { ZeteoClient, ZeteoCalls, ZeteoClientOptions } from "./client.js";
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
export type {
  PostgresSettings,
  AzureSqlSettings,
  LoginFindingCode,
  LoginFinding,
  Source,
  CreateSourceRequest,
  UpdateSourceRequest,
  TestSourceResponse,
  RefreshCounts,
  RefreshSummary,
  Table,
  Column,
  Relation,
  TableDetail,
  PatchTableRequest,
  DeclareRelationRequest,
  ListSourcesOptions,
  ListTablesOptions,
} from "./types/sources.js";
export type {
  PrincipalStatus,
  Grant,
  CreateGrantRequest,
  ReplaceGrantRequest,
  ListGrantsOptions,
} from "./types/grants.js";
export type {
  PrincipalLimit,
  CreatePrincipalLimitRequest,
  UpdatePrincipalLimitRequest,
  ListPrincipalLimitsOptions,
} from "./types/principalLimits.js";
export type {
  Me,
  Principal,
  PrincipalRef,
  DirectoryPrincipalStatus,
  SearchPrincipalsOptions,
} from "./types/principals.js";
