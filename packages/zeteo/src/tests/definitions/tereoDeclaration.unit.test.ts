// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import {
  AUDIT_EVENTS,
  DATA_EXPORT,
  DATA_READ,
  GRANTS_READ,
  GRANTS_WRITE,
  MCP_USE,
  RUNS_READ,
  SAVED_QUERIES_READ,
  SAVED_QUERIES_WRITE,
  DASHBOARDS_READ,
  DASHBOARDS_WRITE,
  UPLOADS_WRITE,
  SERVICE_SLUG,
  SOURCES_READ,
  SOURCES_WRITE,
  buildTereoDocument,
} from "../../definitions/tereoDeclaration.js";

const packageRoot = new URL("../../../", import.meta.url);
const readJson = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(name, packageRoot)), "utf-8"));

const document = buildTereoDocument("1.2.3");
const service = document.service!;

describe("buildTereoDocument", () => {
  it("declares the service zeteo, with its secret read from TEREO_CLIENT_SECRET", () => {
    expect(document.version).toBe("1.2.3");
    expect(SERVICE_SLUG).toBe("zeteo");
    expect(service.slug).toBe("zeteo");
    expect(service.secretFrom).toBe("TEREO_CLIENT_SECRET");
  });

  it("asks for the core roles that write audit entries and read users and groups", () => {
    expect(service.access?.roles).toEqual([
      "audit_writer",
      "user_resolver",
      "group_resolver",
    ]);
  });

  it("declares exactly the thirteen zeteo permissions", () => {
    expect(SOURCES_READ).toBe("zeteo.sources.read");
    expect(SOURCES_WRITE).toBe("zeteo.sources.write");
    expect(GRANTS_READ).toBe("zeteo.grants.read");
    expect(GRANTS_WRITE).toBe("zeteo.grants.write");
    expect(DATA_READ).toBe("zeteo.data.read");
    expect(DATA_EXPORT).toBe("zeteo.data.export");
    expect(RUNS_READ).toBe("zeteo.runs.read");
    expect(MCP_USE).toBe("zeteo.mcp.use");
    expect(service.permissions!.map((p) => p.name).sort()).toEqual(
      [
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
      ].sort()
    );
  });

  it("makes no permission assignable inside an organization: sources are not organization-scoped", () => {
    for (const permission of service.permissions!) {
      expect(permission.orgAssignable).toBe(false);
    }
  });

  it("describes each event type in words, not by its name", () => {
    for (const eventType of service.eventTypes!) {
      expect(eventType.description).not.toBe(eventType.eventType);
      expect(eventType.description!.length).toBeGreaterThan(0);
    }
  });

  it("describes zeteo.mcp.use as the use of zeteo through an AI over MCP", () => {
    const mcp = service.permissions!.find((p) => p.name === MCP_USE);
    expect(mcp).toMatchObject({
      description: "Use zeteo through an AI connected over MCP",
      orgAssignable: false,
    });
  });

  it("declares zeteo_admin with all thirteen permissions, zeteo_user with data read only, and zeteo_mcp_user with data read and MCP use", () => {
    const roles = Object.fromEntries(
      service.systemRoles!.map((r) => [r.name, [...r.permissions!].sort()])
    );
    expect(Object.keys(roles).sort()).toEqual([
      "zeteo_admin",
      "zeteo_mcp_user",
      "zeteo_user",
    ]);
    expect(roles.zeteo_admin).toEqual(
      [
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
      ].sort()
    );
    expect(roles.zeteo_user).toEqual([DATA_READ]);
    expect(roles.zeteo_mcp_user).toEqual([DATA_READ, MCP_USE].sort());
  });

  it("gates grant events on grants read and query and export runs on runs read", () => {
    const read = Object.fromEntries(
      service.eventTypes!.map((e) => [e.eventType, e.readPermission])
    );
    expect(read[AUDIT_EVENTS.grantCreated]).toBe(GRANTS_READ);
    expect(read[AUDIT_EVENTS.grantUpdated]).toBe(GRANTS_READ);
    expect(read[AUDIT_EVENTS.grantRemoved]).toBe(GRANTS_READ);
    expect(read[AUDIT_EVENTS.queryRun]).toBe(RUNS_READ);
    expect(read[AUDIT_EVENTS.exportStarted]).toBe(RUNS_READ);
    expect(read[AUDIT_EVENTS.exportRun]).toBe(RUNS_READ);
    expect(read[AUDIT_EVENTS.sourceCreated]).toBe(SOURCES_READ);
  });

  it("gates principal limit events on grants read", () => {
    const read = Object.fromEntries(
      service.eventTypes!.map((e) => [e.eventType, e.readPermission])
    );
    expect(AUDIT_EVENTS.principalLimitCreated).toBe(
      "zeteo.principal_limit.created"
    );
    expect(AUDIT_EVENTS.principalLimitUpdated).toBe(
      "zeteo.principal_limit.updated"
    );
    expect(AUDIT_EVENTS.principalLimitRemoved).toBe(
      "zeteo.principal_limit.removed"
    );
    expect(read[AUDIT_EVENTS.principalLimitCreated]).toBe(GRANTS_READ);
    expect(read[AUDIT_EVENTS.principalLimitUpdated]).toBe(GRANTS_READ);
    expect(read[AUDIT_EVENTS.principalLimitRemoved]).toBe(GRANTS_READ);
  });

  it("declares the saved query permissions for zeteo_admin only", () => {
    expect(SAVED_QUERIES_READ).toBe("zeteo.saved_queries.read");
    expect(SAVED_QUERIES_WRITE).toBe("zeteo.saved_queries.write");
    const roles = Object.fromEntries(
      service.systemRoles!.map((r) => [r.name, r.permissions!])
    );
    expect(roles.zeteo_admin).toEqual(
      expect.arrayContaining([SAVED_QUERIES_READ, SAVED_QUERIES_WRITE])
    );
    for (const name of ["zeteo_user", "zeteo_mcp_user"]) {
      expect(
        roles[name].some((p) => p.startsWith("zeteo.saved_queries."))
      ).toBe(false);
    }
    expect(service.permissions!.map((p) => p.name)).toEqual(
      expect.arrayContaining([SAVED_QUERIES_READ, SAVED_QUERIES_WRITE])
    );
  });

  it("gates the six saved query events on saved queries read", () => {
    const events = Object.fromEntries(
      service.eventTypes!.map((e) => [e.eventType, e])
    );
    const names = [
      "created",
      "updated",
      "deleted",
      "shared",
      "transferred",
      "copied",
    ];
    for (const n of names) {
      const e = events[`zeteo.saved_query.${n}`];
      expect(e.readPermission).toBe(SAVED_QUERIES_READ);
      expect(e.description).toBeTruthy();
    }
    expect(AUDIT_EVENTS.savedQueryCreated).toBe("zeteo.saved_query.created");
    expect(AUDIT_EVENTS.savedQueryCopied).toBe("zeteo.saved_query.copied");
  });

  it("declares the dashboard permissions for zeteo_admin only", () => {
    expect(DASHBOARDS_READ).toBe("zeteo.dashboards.read");
    expect(DASHBOARDS_WRITE).toBe("zeteo.dashboards.write");
    const roles = Object.fromEntries(
      service.systemRoles!.map((r) => [r.name, r.permissions!])
    );
    expect(roles.zeteo_admin).toEqual(
      expect.arrayContaining([DASHBOARDS_READ, DASHBOARDS_WRITE])
    );
    for (const name of ["zeteo_user", "zeteo_mcp_user"]) {
      expect(roles[name].some((p) => p.startsWith("zeteo.dashboards."))).toBe(
        false
      );
    }
    expect(service.permissions!.map((p) => p.name)).toEqual(
      expect.arrayContaining([DASHBOARDS_READ, DASHBOARDS_WRITE])
    );
  });

  it("gates the twelve dashboard and saved panel events on dashboards read", () => {
    const events = Object.fromEntries(
      service.eventTypes!.map((e) => [e.eventType, e])
    );
    const names = [
      "created",
      "updated",
      "deleted",
      "shared",
      "transferred",
      "copied",
    ];
    for (const prefix of ["dashboard", "saved_panel"]) {
      for (const n of names) {
        const e = events[`zeteo.${prefix}.${n}`];
        expect(e.readPermission).toBe(DASHBOARDS_READ);
        expect(e.description).toBeTruthy();
      }
    }
    expect(AUDIT_EVENTS.dashboardCreated).toBe("zeteo.dashboard.created");
    expect(AUDIT_EVENTS.savedPanelCopied).toBe("zeteo.saved_panel.copied");
  });

  it("declares every audit event as an event type", () => {
    expect(Object.values(AUDIT_EVENTS).sort()).toEqual([
      "zeteo.connection.updated",
      "zeteo.dashboard.copied",
      "zeteo.dashboard.created",
      "zeteo.dashboard.deleted",
      "zeteo.dashboard.shared",
      "zeteo.dashboard.transferred",
      "zeteo.dashboard.updated",
      "zeteo.export.run",
      "zeteo.export.started",
      "zeteo.grant.created",
      "zeteo.grant.removed",
      "zeteo.grant.updated",
      "zeteo.principal_limit.created",
      "zeteo.principal_limit.removed",
      "zeteo.principal_limit.updated",
      "zeteo.query.run",
      "zeteo.relation.declared",
      "zeteo.relation.removed",
      "zeteo.relation.renamed",
      "zeteo.saved_panel.copied",
      "zeteo.saved_panel.created",
      "zeteo.saved_panel.deleted",
      "zeteo.saved_panel.shared",
      "zeteo.saved_panel.transferred",
      "zeteo.saved_panel.updated",
      "zeteo.saved_query.copied",
      "zeteo.saved_query.created",
      "zeteo.saved_query.deleted",
      "zeteo.saved_query.shared",
      "zeteo.saved_query.transferred",
      "zeteo.saved_query.updated",
      "zeteo.source.archived",
      "zeteo.source.created",
      "zeteo.source.deleted",
      "zeteo.source.refreshed",
      "zeteo.source.table_removed",
      "zeteo.source.table_reuploaded",
      "zeteo.source.tables_added",
      "zeteo.source.transferred",
      "zeteo.source.updated",
    ]);
    expect(service.eventTypes!.map((e) => e.eventType).sort()).toEqual(
      Object.values(AUDIT_EVENTS).sort()
    );
  });
});

describe("tereo-provisioning.json", () => {
  it("is the document buildTereoDocument builds for the package version", () => {
    const { version } = readJson("package.json");
    expect(readJson("tereo-provisioning.json")).toEqual(
      buildTereoDocument(version)
    );
  });
});

describe("upload sources declaration", () => {
  it("declares zeteo.uploads.write, not organization-assignable, in zeteo_admin only", () => {
    expect(UPLOADS_WRITE).toBe("zeteo.uploads.write");
    const permission = service.permissions!.find(
      (p) => p.name === UPLOADS_WRITE
    );
    expect(permission).toMatchObject({ orgAssignable: false });
    const holders = service
      .systemRoles!.filter((r) => r.permissions!.includes(UPLOADS_WRITE))
      .map((r) => r.name);
    expect(holders).toEqual(["zeteo_admin"]);
  });

  it("declares the upload source audit events under zeteo.source, with descriptions", () => {
    expect(AUDIT_EVENTS.sourceDeleted).toBe("zeteo.source.deleted");
    expect(AUDIT_EVENTS.sourceTransferred).toBe("zeteo.source.transferred");
    expect(AUDIT_EVENTS.sourceTablesAdded).toBe("zeteo.source.tables_added");
    expect(AUDIT_EVENTS.sourceTableReuploaded).toBe(
      "zeteo.source.table_reuploaded"
    );
    expect(AUDIT_EVENTS.sourceTableRemoved).toBe("zeteo.source.table_removed");
    for (const name of [
      "deleted",
      "transferred",
      "tables_added",
      "table_reuploaded",
      "table_removed",
    ]) {
      const event = service.eventTypes!.find(
        (e) => e.eventType === `zeteo.source.${name}`
      );
      expect(event?.description?.length).toBeGreaterThan(0);
      expect(event?.readPermission).toBe(SOURCES_READ);
    }
    expect(
      service.eventTypes!.some((e) => e.eventType.startsWith("zeteo.file_"))
    ).toBe(false);
  });
});
