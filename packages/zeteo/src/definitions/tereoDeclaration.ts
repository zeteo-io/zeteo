import type { ProvisioningDocument } from "@tereo-io/sdk";

/**
 * Zeteo's service slug in tereo. Its permissions and event types are named
 * under it, and tereo refuses an audit entry from any other source.
 */
export const SERVICE_SLUG = "zeteo";

/** Lists and reads sources and what they expose. */
export const SOURCES_READ = "zeteo.sources.read";

/** Registers, changes, archives and refreshes sources; includes `zeteo.sources.read`. */
export const SOURCES_WRITE = "zeteo.sources.write";

/** Lists and reads grants and the concurrency limits of users and groups. */
export const GRANTS_READ = "zeteo.grants.read";

/** Creates, changes and removes grants and concurrency limits; includes `zeteo.grants.read`. */
export const GRANTS_WRITE = "zeteo.grants.write";

/** Runs queries over the tables and columns the caller is granted. */
export const DATA_READ = "zeteo.data.read";

/**
 * Exports what a query over the caller's grants returns, up to the source's
 * export cap. `POST /v1/export` needs only this permission, not
 * `zeteo.data.read` as well.
 */
export const DATA_EXPORT = "zeteo.data.export";

/** Reads the record of query runs. */
export const RUNS_READ = "zeteo.runs.read";

/**
 * Uses zeteo through an AI connected over MCP: without it a caller sees no
 * MCP tools. Each tool also needs the permission its HTTP route needs.
 */
export const MCP_USE = "zeteo.mcp.use";

/** Lists and reads every saved query, whoever owns it or shares it. */
export const SAVED_QUERIES_READ = "zeteo.saved_queries.read";

/** Changes, shares, transfers and deletes any saved query. */
export const SAVED_QUERIES_WRITE = "zeteo.saved_queries.write";

/** Lists and reads every dashboard and saved panel, whoever owns it or shares it. */
export const DASHBOARDS_READ = "zeteo.dashboards.read";

/** Changes, shares, transfers and deletes any dashboard or saved panel. */
export const DASHBOARDS_WRITE = "zeteo.dashboards.write";

/**
 * Creates upload sources, and manages and grants those the holder owns. Every
 * upload route also requires `zeteo.data.read`.
 */
export const UPLOADS_WRITE = "zeteo.uploads.write";

/** Changes the calendar: working days, holidays, fiscal year start and time zone. */
export const CALENDAR_WRITE = "zeteo.calendar.write";

/** Creates, changes and deletes measures on sources the holder may edit measures of. */
export const MEASURES_WRITE = "zeteo.measures.write";

/** The audit trail's event names, one per recorded change. */
export const AUDIT_EVENTS = {
  sourceCreated: "zeteo.source.created",
  sourceUpdated: "zeteo.source.updated",
  sourceArchived: "zeteo.source.archived",
  sourceRefreshed: "zeteo.source.refreshed",
  sourceDeleted: "zeteo.source.deleted",
  sourceTransferred: "zeteo.source.transferred",
  sourceTablesAdded: "zeteo.source.tables_added",
  sourceTableReuploaded: "zeteo.source.table_reuploaded",
  sourceTableRemoved: "zeteo.source.table_removed",
  sourceMergedTableSaved: "zeteo.source.merged_table_saved",
  connectionUpdated: "zeteo.connection.updated",
  relationDeclared: "zeteo.relation.declared",
  relationRenamed: "zeteo.relation.renamed",
  relationRemoved: "zeteo.relation.removed",
  grantCreated: "zeteo.grant.created",
  grantUpdated: "zeteo.grant.updated",
  grantRemoved: "zeteo.grant.removed",
  principalLimitCreated: "zeteo.principal_limit.created",
  principalLimitUpdated: "zeteo.principal_limit.updated",
  principalLimitRemoved: "zeteo.principal_limit.removed",
  identityKeyCreated: "zeteo.identity_key.created",
  identityKeyUpdated: "zeteo.identity_key.updated",
  identityKeyRemoved: "zeteo.identity_key.removed",
  identityValuesAdded: "zeteo.identity_value.added",
  identityValueRemoved: "zeteo.identity_value.removed",
  savedQueryCreated: "zeteo.saved_query.created",
  savedQueryUpdated: "zeteo.saved_query.updated",
  savedQueryDeleted: "zeteo.saved_query.deleted",
  savedQueryShared: "zeteo.saved_query.shared",
  savedQueryTransferred: "zeteo.saved_query.transferred",
  savedQueryCopied: "zeteo.saved_query.copied",
  dashboardCreated: "zeteo.dashboard.created",
  dashboardUpdated: "zeteo.dashboard.updated",
  dashboardDeleted: "zeteo.dashboard.deleted",
  dashboardShared: "zeteo.dashboard.shared",
  dashboardTransferred: "zeteo.dashboard.transferred",
  dashboardCopied: "zeteo.dashboard.copied",
  savedPanelCreated: "zeteo.saved_panel.created",
  savedPanelUpdated: "zeteo.saved_panel.updated",
  savedPanelDeleted: "zeteo.saved_panel.deleted",
  savedPanelShared: "zeteo.saved_panel.shared",
  savedPanelTransferred: "zeteo.saved_panel.transferred",
  savedPanelCopied: "zeteo.saved_panel.copied",
  calendarUpdated: "zeteo.calendar.updated",
  measureCreated: "zeteo.measure.created",
  measureUpdated: "zeteo.measure.updated",
  measureDeleted: "zeteo.measure.deleted",
  measureEditorsUpdated: "zeteo.measure_editors.updated",
  metricCreated: "zeteo.metric.created",
  metricUpdated: "zeteo.metric.updated",
  metricDeleted: "zeteo.metric.deleted",
  queryRun: "zeteo.query.run",
  exportStarted: "zeteo.export.started",
  exportRun: "zeteo.export.run",
} as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

const EVENT_DESCRIPTIONS: Record<AuditEvent, string> = {
  [AUDIT_EVENTS.sourceCreated]:
    "A source was registered, or an upload source created from an upload",
  [AUDIT_EVENTS.sourceUpdated]:
    "A source's settings, limits, descriptions, name or columns were changed",
  [AUDIT_EVENTS.sourceArchived]: "A source was archived",
  [AUDIT_EVENTS.sourceRefreshed]: "A source's catalogue was refreshed",
  [AUDIT_EVENTS.sourceDeleted]:
    "An upload source and its stored tables were deleted",
  [AUDIT_EVENTS.sourceTransferred]:
    "An upload source was transferred to another owner",
  [AUDIT_EVENTS.sourceTablesAdded]:
    "Tables were added to an upload source from an upload",
  [AUDIT_EVENTS.sourceTableReuploaded]:
    "An upload source's table was replaced by a new upload",
  [AUDIT_EVENTS.sourceTableRemoved]:
    "A table was removed from an upload source",
  [AUDIT_EVENTS.sourceMergedTableSaved]:
    "A merged table of an upload source was created or changed",
  [AUDIT_EVENTS.connectionUpdated]:
    "The Google service-account key was set or replaced",
  [AUDIT_EVENTS.relationDeclared]: "A relation was declared between two tables",
  [AUDIT_EVENTS.relationRenamed]: "A relation was renamed",
  [AUDIT_EVENTS.relationRemoved]: "A declared relation was removed",
  [AUDIT_EVENTS.grantCreated]: "A grant to a table was created",
  [AUDIT_EVENTS.grantUpdated]: "A grant's columns were changed",
  [AUDIT_EVENTS.grantRemoved]: "A grant was removed",
  [AUDIT_EVENTS.principalLimitCreated]:
    "A user or group was given its own concurrency limits",
  [AUDIT_EVENTS.principalLimitUpdated]:
    "A user's or group's concurrency limits were changed",
  [AUDIT_EVENTS.principalLimitRemoved]:
    "A user's or group's own concurrency limits were removed",
  [AUDIT_EVENTS.identityKeyCreated]: "An identity key was created",
  [AUDIT_EVENTS.identityKeyUpdated]:
    "An identity key's label or description was changed",
  [AUDIT_EVENTS.identityKeyRemoved]: "An identity key was removed",
  [AUDIT_EVENTS.identityValuesAdded]:
    "Values of an identity key were added for users",
  [AUDIT_EVENTS.identityValueRemoved]: "A value of an identity key was removed",
  [AUDIT_EVENTS.savedQueryCreated]: "A saved query was created",
  [AUDIT_EVENTS.savedQueryUpdated]: "A saved query was changed",
  [AUDIT_EVENTS.savedQueryDeleted]: "A saved query was deleted",
  [AUDIT_EVENTS.savedQueryShared]: "A saved query's shares were changed",
  [AUDIT_EVENTS.savedQueryTransferred]:
    "A saved query was transferred to another owner",
  [AUDIT_EVENTS.savedQueryCopied]: "A saved query was copied",
  [AUDIT_EVENTS.dashboardCreated]: "A dashboard was created",
  [AUDIT_EVENTS.dashboardUpdated]: "A dashboard was changed",
  [AUDIT_EVENTS.dashboardDeleted]: "A dashboard was deleted",
  [AUDIT_EVENTS.dashboardShared]: "A dashboard's shares were changed",
  [AUDIT_EVENTS.dashboardTransferred]:
    "A dashboard was transferred to another owner",
  [AUDIT_EVENTS.dashboardCopied]: "A dashboard was copied",
  [AUDIT_EVENTS.savedPanelCreated]: "A saved panel was created",
  [AUDIT_EVENTS.savedPanelUpdated]: "A saved panel was changed",
  [AUDIT_EVENTS.savedPanelDeleted]: "A saved panel was deleted",
  [AUDIT_EVENTS.savedPanelShared]: "A saved panel's shares were changed",
  [AUDIT_EVENTS.savedPanelTransferred]:
    "A saved panel was transferred to another owner",
  [AUDIT_EVENTS.savedPanelCopied]: "A saved panel was copied",
  [AUDIT_EVENTS.calendarUpdated]:
    "The calendar's working days, holidays, fiscal year or time zone were changed",
  [AUDIT_EVENTS.measureCreated]: "A measure was created",
  [AUDIT_EVENTS.measureUpdated]: "A measure was changed",
  [AUDIT_EVENTS.measureDeleted]: "A measure was deleted",
  [AUDIT_EVENTS.measureEditorsUpdated]:
    "The people and groups who may change a source's measures were changed",
  [AUDIT_EVENTS.metricCreated]: "A metric was created",
  [AUDIT_EVENTS.metricUpdated]: "A metric was changed",
  [AUDIT_EVENTS.metricDeleted]: "A metric was deleted",
  [AUDIT_EVENTS.queryRun]: "A query was run, refused or failed",
  [AUDIT_EVENTS.exportStarted]: "An export started sending rows",
  [AUDIT_EVENTS.exportRun]: "An export ended, was refused or failed",
};

const EVENT_READ_PERMISSION: Record<AuditEvent, string> = {
  [AUDIT_EVENTS.sourceCreated]: SOURCES_READ,
  [AUDIT_EVENTS.sourceUpdated]: SOURCES_READ,
  [AUDIT_EVENTS.sourceArchived]: SOURCES_READ,
  [AUDIT_EVENTS.sourceRefreshed]: SOURCES_READ,
  [AUDIT_EVENTS.sourceDeleted]: SOURCES_READ,
  [AUDIT_EVENTS.sourceTransferred]: SOURCES_READ,
  [AUDIT_EVENTS.sourceTablesAdded]: SOURCES_READ,
  [AUDIT_EVENTS.sourceTableReuploaded]: SOURCES_READ,
  [AUDIT_EVENTS.sourceTableRemoved]: SOURCES_READ,
  [AUDIT_EVENTS.sourceMergedTableSaved]: SOURCES_READ,
  [AUDIT_EVENTS.connectionUpdated]: SOURCES_READ,
  [AUDIT_EVENTS.relationDeclared]: SOURCES_READ,
  [AUDIT_EVENTS.relationRenamed]: SOURCES_READ,
  [AUDIT_EVENTS.relationRemoved]: SOURCES_READ,
  [AUDIT_EVENTS.grantCreated]: GRANTS_READ,
  [AUDIT_EVENTS.grantUpdated]: GRANTS_READ,
  [AUDIT_EVENTS.grantRemoved]: GRANTS_READ,
  [AUDIT_EVENTS.principalLimitCreated]: GRANTS_READ,
  [AUDIT_EVENTS.principalLimitUpdated]: GRANTS_READ,
  [AUDIT_EVENTS.principalLimitRemoved]: GRANTS_READ,
  [AUDIT_EVENTS.identityKeyCreated]: GRANTS_READ,
  [AUDIT_EVENTS.identityKeyUpdated]: GRANTS_READ,
  [AUDIT_EVENTS.identityKeyRemoved]: GRANTS_READ,
  [AUDIT_EVENTS.identityValuesAdded]: GRANTS_READ,
  [AUDIT_EVENTS.identityValueRemoved]: GRANTS_READ,
  [AUDIT_EVENTS.savedQueryCreated]: SAVED_QUERIES_READ,
  [AUDIT_EVENTS.savedQueryUpdated]: SAVED_QUERIES_READ,
  [AUDIT_EVENTS.savedQueryDeleted]: SAVED_QUERIES_READ,
  [AUDIT_EVENTS.savedQueryShared]: SAVED_QUERIES_READ,
  [AUDIT_EVENTS.savedQueryTransferred]: SAVED_QUERIES_READ,
  [AUDIT_EVENTS.savedQueryCopied]: SAVED_QUERIES_READ,
  [AUDIT_EVENTS.dashboardCreated]: DASHBOARDS_READ,
  [AUDIT_EVENTS.dashboardUpdated]: DASHBOARDS_READ,
  [AUDIT_EVENTS.dashboardDeleted]: DASHBOARDS_READ,
  [AUDIT_EVENTS.dashboardShared]: DASHBOARDS_READ,
  [AUDIT_EVENTS.dashboardTransferred]: DASHBOARDS_READ,
  [AUDIT_EVENTS.dashboardCopied]: DASHBOARDS_READ,
  [AUDIT_EVENTS.savedPanelCreated]: DASHBOARDS_READ,
  [AUDIT_EVENTS.savedPanelUpdated]: DASHBOARDS_READ,
  [AUDIT_EVENTS.savedPanelDeleted]: DASHBOARDS_READ,
  [AUDIT_EVENTS.savedPanelShared]: DASHBOARDS_READ,
  [AUDIT_EVENTS.savedPanelTransferred]: DASHBOARDS_READ,
  [AUDIT_EVENTS.savedPanelCopied]: DASHBOARDS_READ,
  [AUDIT_EVENTS.calendarUpdated]: SOURCES_READ,
  [AUDIT_EVENTS.measureCreated]: SOURCES_READ,
  [AUDIT_EVENTS.measureUpdated]: SOURCES_READ,
  [AUDIT_EVENTS.measureDeleted]: SOURCES_READ,
  [AUDIT_EVENTS.measureEditorsUpdated]: SOURCES_READ,
  [AUDIT_EVENTS.metricCreated]: SOURCES_READ,
  [AUDIT_EVENTS.metricUpdated]: SOURCES_READ,
  [AUDIT_EVENTS.metricDeleted]: SOURCES_READ,
  [AUDIT_EVENTS.queryRun]: RUNS_READ,
  [AUDIT_EVENTS.exportStarted]: RUNS_READ,
  [AUDIT_EVENTS.exportRun]: RUNS_READ,
};

/**
 * What Zeteo declares to tereo as an app service. Core applies the generated
 * `tereo-provisioning.json` from its provisioning folder.
 */
export const buildTereoDocument = (version: string): ProvisioningDocument => ({
  version,
  service: {
    slug: SERVICE_SLUG,
    name: "Zeteo",
    secretFrom: "TEREO_CLIENT_SECRET",
    // Audit entries leave through the outbox in the SDK, under audit_writer;
    // user_resolver lets zeteo read a caller's groups. group_resolver is
    // read-only access to every group in every organization (roles, members'
    // names and emails, SCIM skipped members, auth.group.* events); zeteo uses
    // it only to read a group by id, for a group principal's status.
    access: { roles: ["audit_writer", "user_resolver", "group_resolver"] },
    permissions: [
      {
        name: SOURCES_READ,
        displayName: "Read sources",
        description: "List and read the sources zeteo knows about",
        // Sources are not scoped to an organization: a grant inside one would reach them all.
        orgAssignable: false,
      },
      {
        name: SOURCES_WRITE,
        displayName: "Manage sources",
        description:
          "Register, change, archive and refresh sources, and declare relations; also grants Read sources",
        orgAssignable: false,
      },
      {
        name: GRANTS_READ,
        displayName: "Read grants",
        description:
          "List and read who may query which tables and columns, and users' and groups' concurrency limits; also lets the holder look up users' names and email addresses",
        orgAssignable: false,
      },
      {
        name: GRANTS_WRITE,
        displayName: "Manage grants",
        description:
          "Create, change and remove grants and concurrency limits; also grants Read grants",
        orgAssignable: false,
      },
      {
        name: DATA_READ,
        displayName: "Query data",
        description: "Run queries over the tables and columns one is granted",
        orgAssignable: false,
      },
      {
        name: DATA_EXPORT,
        displayName: "Export data",
        description:
          "Export query results over the tables and columns one is granted, from sources that allow it",
        orgAssignable: false,
      },
      {
        name: RUNS_READ,
        displayName: "Read query runs",
        description:
          "List the record of queries that were run; also lets the holder look up users' names and email addresses",
        orgAssignable: false,
      },
      {
        name: MCP_USE,
        displayName: "Use over MCP",
        description: "Use zeteo through an AI connected over MCP",
        orgAssignable: false,
      },
      {
        name: SAVED_QUERIES_READ,
        displayName: "Read saved queries",
        description:
          "List and read every user's saved queries and who they are shared with; also lets the holder look up users' names and email addresses",
        orgAssignable: false,
      },
      {
        name: SAVED_QUERIES_WRITE,
        displayName: "Manage saved queries",
        description:
          "Change, share, transfer and delete any user's saved queries; also grants Read saved queries",
        orgAssignable: false,
      },
      {
        name: DASHBOARDS_READ,
        displayName: "Read dashboards",
        description:
          "List and read every user's dashboards and saved panels and who they are shared with",
        orgAssignable: false,
      },
      {
        name: DASHBOARDS_WRITE,
        displayName: "Manage dashboards",
        description:
          "Change, share, transfer and delete any user's dashboards and saved panels; also grants Read dashboards",
        orgAssignable: false,
      },
      {
        name: UPLOADS_WRITE,
        displayName: "Manage upload sources",
        description:
          "Create upload sources from uploaded files, and manage and grant the ones the holder owns",
        orgAssignable: false,
      },
      {
        name: MEASURES_WRITE,
        displayName: "Manage measures",
        description:
          "Create, change and delete measures: named group-level calculations that queries on a source can use",
        orgAssignable: false,
      },
      {
        name: CALENDAR_WRITE,
        displayName: "Manage the calendar",
        description:
          "Change the working days, holidays, fiscal year start and time zone that dates and business-day functions use",
        orgAssignable: false,
      },
    ],
    systemRoles: [
      {
        // Core's role names allow no ".", so the slug and the name join with "_".
        name: "zeteo_admin",
        displayName: "Zeteo administrator",
        description:
          "Manages sources, grants, saved queries, dashboards and the record of query runs",
        permissions: [
          SOURCES_READ,
          SOURCES_WRITE,
          GRANTS_READ,
          GRANTS_WRITE,
          DATA_READ,
          DATA_EXPORT,
          RUNS_READ,
          MCP_USE,
          SAVED_QUERIES_READ,
          SAVED_QUERIES_WRITE,
          DASHBOARDS_READ,
          DASHBOARDS_WRITE,
          UPLOADS_WRITE,
          MEASURES_WRITE,
          CALENDAR_WRITE,
        ],
      },
      {
        name: "zeteo_user",
        displayName: "Zeteo user",
        description: "Queries the data they are granted",
        permissions: [DATA_READ, MEASURES_WRITE],
      },
      {
        name: "zeteo_mcp_user",
        displayName: "Zeteo MCP user",
        description:
          "Queries the data they are granted, also through an AI connected over MCP",
        permissions: [DATA_READ, MCP_USE],
      },
    ],
    eventTypes: Object.values(AUDIT_EVENTS).map((eventType) => ({
      eventType,
      description: EVENT_DESCRIPTIONS[eventType],
      readPermission: EVENT_READ_PERMISSION[eventType],
    })),
  },
});
