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
        orgAssignable: true,
      },
      {
        name: SOURCES_WRITE,
        displayName: "Manage sources",
        description:
          "Register, change, archive and refresh sources, and declare relations; also grants Read sources",
        orgAssignable: true,
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
      description: eventType,
      readPermission: SOURCES_READ,
    })),
  },
});
