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

/** The audit trail's event names, one per recorded change. */
export const AUDIT_EVENTS = {
  sourceCreated: "zeteo.source.created",
  sourceUpdated: "zeteo.source.updated",
  sourceArchived: "zeteo.source.archived",
  sourceRefreshed: "zeteo.source.refreshed",
  relationDeclared: "zeteo.relation.declared",
  relationRemoved: "zeteo.relation.removed",
  grantCreated: "zeteo.grant.created",
  grantUpdated: "zeteo.grant.updated",
  grantRemoved: "zeteo.grant.removed",
  principalLimitCreated: "zeteo.principal_limit.created",
  principalLimitUpdated: "zeteo.principal_limit.updated",
  principalLimitRemoved: "zeteo.principal_limit.removed",
  queryRun: "zeteo.query.run",
  exportStarted: "zeteo.export.started",
  exportRun: "zeteo.export.run",
} as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

const EVENT_DESCRIPTIONS: Record<AuditEvent, string> = {
  [AUDIT_EVENTS.sourceCreated]: "A source was registered",
  [AUDIT_EVENTS.sourceUpdated]:
    "A source's settings, limits or descriptions were changed",
  [AUDIT_EVENTS.sourceArchived]: "A source was archived",
  [AUDIT_EVENTS.sourceRefreshed]: "A source's catalogue was refreshed",
  [AUDIT_EVENTS.relationDeclared]: "A relation was declared between two tables",
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
  [AUDIT_EVENTS.queryRun]: "A query was run, refused or failed",
  [AUDIT_EVENTS.exportStarted]: "An export started sending rows",
  [AUDIT_EVENTS.exportRun]: "An export ended, was refused or failed",
};

const EVENT_READ_PERMISSION: Record<AuditEvent, string> = {
  [AUDIT_EVENTS.sourceCreated]: SOURCES_READ,
  [AUDIT_EVENTS.sourceUpdated]: SOURCES_READ,
  [AUDIT_EVENTS.sourceArchived]: SOURCES_READ,
  [AUDIT_EVENTS.sourceRefreshed]: SOURCES_READ,
  [AUDIT_EVENTS.relationDeclared]: SOURCES_READ,
  [AUDIT_EVENTS.relationRemoved]: SOURCES_READ,
  [AUDIT_EVENTS.grantCreated]: GRANTS_READ,
  [AUDIT_EVENTS.grantUpdated]: GRANTS_READ,
  [AUDIT_EVENTS.grantRemoved]: GRANTS_READ,
  [AUDIT_EVENTS.principalLimitCreated]: GRANTS_READ,
  [AUDIT_EVENTS.principalLimitUpdated]: GRANTS_READ,
  [AUDIT_EVENTS.principalLimitRemoved]: GRANTS_READ,
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
    // user_resolver lets zeteo read a caller's groups, and group_resolver a
    // group by id, for a group principal's status.
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
          "List and read who may query which tables and columns, and users' and groups' concurrency limits",
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
        description: "List the record of queries that were run",
        orgAssignable: false,
      },
      {
        name: MCP_USE,
        displayName: "Use over MCP",
        description: "Use zeteo through an AI connected over MCP",
        orgAssignable: false,
      },
    ],
    systemRoles: [
      {
        // Core's role names allow no ".", so the slug and the name join with "_".
        name: "zeteo_admin",
        displayName: "Zeteo administrator",
        description: "Manages sources, grants and the record of query runs",
        permissions: [
          SOURCES_READ,
          SOURCES_WRITE,
          GRANTS_READ,
          GRANTS_WRITE,
          DATA_READ,
          DATA_EXPORT,
          RUNS_READ,
          MCP_USE,
        ],
      },
      {
        name: "zeteo_user",
        displayName: "Zeteo user",
        description: "Queries the data they are granted",
        permissions: [DATA_READ],
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
