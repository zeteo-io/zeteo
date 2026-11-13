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

/** Lists and reads grants. */
export const GRANTS_READ = "zeteo.grants.read";

/** Creates, changes and removes grants; includes `zeteo.grants.read`. */
export const GRANTS_WRITE = "zeteo.grants.write";

/** Runs queries over the tables and columns the caller is granted. */
export const DATA_READ = "zeteo.data.read";

/** Reads the record of query runs. */
export const RUNS_READ = "zeteo.runs.read";

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
  queryRun: "zeteo.query.run",
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
  [AUDIT_EVENTS.queryRun]: "A query was run, refused or failed",
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
  [AUDIT_EVENTS.queryRun]: RUNS_READ,
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
    // user_resolver lets zeteo read a caller's groups.
    access: { roles: ["audit_writer", "user_resolver"] },
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
        description: "List and read who may query which tables and columns",
        orgAssignable: false,
      },
      {
        name: GRANTS_WRITE,
        displayName: "Manage grants",
        description:
          "Create, change and remove grants; also grants Read grants",
        orgAssignable: false,
      },
      {
        name: DATA_READ,
        displayName: "Query data",
        description: "Run queries over the tables and columns one is granted",
        orgAssignable: false,
      },
      {
        name: RUNS_READ,
        displayName: "Read query runs",
        description: "List the record of queries that were run",
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
          RUNS_READ,
        ],
      },
      {
        name: "zeteo_user",
        displayName: "Zeteo user",
        description: "Queries the data they are granted",
        permissions: [DATA_READ],
      },
    ],
    eventTypes: Object.values(AUDIT_EVENTS).map((eventType) => ({
      eventType,
      description: EVENT_DESCRIPTIONS[eventType],
      readPermission: EVENT_READ_PERMISSION[eventType],
    })),
  },
});
