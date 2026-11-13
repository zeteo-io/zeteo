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

/** The audit trail's event names, one per recorded change. */
export const AUDIT_EVENTS = {
  sourceCreated: "zeteo.source.created",
  sourceUpdated: "zeteo.source.updated",
  sourceArchived: "zeteo.source.archived",
  sourceRefreshed: "zeteo.source.refreshed",
  relationDeclared: "zeteo.relation.declared",
  relationRemoved: "zeteo.relation.removed",
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
    // Audit entries leave through the outbox in the SDK, under this core role.
    access: { roles: ["audit_writer"] },
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
    ],
    systemRoles: [
      {
        // Core's role names allow no ".", so the slug and the name join with "_".
        name: "zeteo_admin",
        displayName: "Zeteo administrator",
        description: "Manages sources",
        permissions: [SOURCES_READ, SOURCES_WRITE],
      },
    ],
    eventTypes: Object.values(AUDIT_EVENTS).map((eventType) => ({
      eventType,
      description: EVENT_DESCRIPTIONS[eventType],
      readPermission: SOURCES_READ,
    })),
  },
});
