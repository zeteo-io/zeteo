// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import {
  asMssqlAdmin,
  dropLoginSql,
  ensureLoginSql,
  mssqlSourceSettings,
} from "../../../support/mssqlFixture.js";
import {
  auditRows,
  removeSources,
  sourceBody,
  uniqueSlug,
  writeToken,
} from "../../../support/sources.js";

describe("/v1/sources with azure-sql", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const created: string[] = [];

  // A second read-only login, to change an audited setting to.
  const READER = { user: "zeteo_ro_second", password: "Ro-second-password-1" };

  beforeAll(async () => {
    await asMssqlAdmin(
      [ensureLoginSql(READER.user, READER.password)],
      "master"
    );
    await asMssqlAdmin([
      `DROP USER IF EXISTS ${READER.user}`,
      `CREATE USER ${READER.user} FOR LOGIN ${READER.user}`,
      `ALTER ROLE db_datareader ADD MEMBER ${READER.user}`,
    ]);
    app = await startV1Routes();
  });
  afterAll(async () => {
    await removeSources(created);
    await app.close();
    await asMssqlAdmin([`DROP USER IF EXISTS ${READER.user}`]);
    await asMssqlAdmin([dropLoginSql(READER.user)], "master");
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetchJson(method, `${app.url}/v1/sources${path}`, writeToken(), body);

  const create = async (
    login: "ro" | "rw" = "ro",
    overrides: Record<string, unknown> = {}
  ) => {
    const res = await call(
      "POST",
      "",
      sourceBody(mssqlSourceSettings(login), {
        type: "azure-sql",
        schemas: ["sales"],
        ...overrides,
      })
    );
    if (res.status === 201) created.push(res.body.id);
    return res;
  };

  it("creates a source, fills its catalogue and answers its view without the password", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: "azure-sql",
      schemas: ["sales"],
      status: "active",
      writable_login_allowed: false,
    });
    const settings = mssqlSourceSettings("ro");
    expect(res.body.settings).toEqual({
      host: settings.host,
      port: settings.port,
      database: "zeteo_fixture",
      user: "zeteo_ro",
      tls: "trust-server-certificate",
    });
    expect(JSON.stringify(res.body)).not.toContain(settings.password);

    const tables = await call("GET", `/${res.body.id}/tables`);
    expect(tables.status).toBe(200);
    expect(
      tables.body.data.map((t: { name: string }) => t.name).sort()
    ).toEqual([
      "accounts",
      "broken_orders",
      "customers",
      "order_lines",
      "orders",
      "paid_orders",
      "slow_orders",
    ]);
    const viewed = await call("GET", `/${res.body.id}`);
    expect(viewed.body.settings).not.toHaveProperty("password");
    expect(JSON.stringify(viewed.body)).not.toContain(settings.password);
  });

  it("stores the type as azure_sql", async () => {
    const res = await create();
    const row = await prisma.source.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row.type).toBe("azure_sql");
  });

  it("refuses a login that can write with 422 writable_login", async () => {
    const slug = uniqueSlug();
    const res = await create("rw", { slug });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("writable_login");
    expect(res.body.findings).toEqual([
      {
        code: "can_write_tables",
        detail: expect.stringContaining("sales.orders"),
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(
      mssqlSourceSettings("rw").password
    );
    expect(await prisma.source.count({ where: { slug } })).toBe(0);
  });

  it("answers 400 invalid_request for settings the adapter refuses", async () => {
    const res = await call(
      "POST",
      "",
      sourceBody(
        { ...mssqlSourceSettings("ro"), password: "" },
        { type: "azure-sql", schemas: ["sales"] }
      )
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  // The fixture's certificate is self-signed, so a source on it cannot start
  // from `verify` (the connection is refused, see connect.test.ts): the
  // relaxed mode is on record from the create, and a settings change records
  // it again beside the setting that changed.
  it("records the TLS mode and every settings change in the audit entries, with no password", async () => {
    const res = await create();
    const settings = mssqlSourceSettings("ro");
    const changed = await call("PATCH", `/${res.body.id}`, {
      settings: { ...settings, ...READER, tls: "trust-server-certificate" },
    });
    expect(changed.status).toBe(200);
    const rows = await auditRows(res.body.id);
    const redacted = {
      host: settings.host,
      port: settings.port,
      database: "zeteo_fixture",
      user: "zeteo_ro",
      tls: "trust-server-certificate",
    };
    const createdEntry = rows.find(
      (r) => r.payload.metadata.event === "zeteo.source.created"
    );
    expect(createdEntry?.payload.metadata).toMatchObject({
      type: "azure-sql",
      settings: redacted,
    });
    const updated = rows.find(
      (r) =>
        r.payload.metadata.event === "zeteo.source.updated" &&
        r.payload.metadata.changed.includes("settings")
    );
    expect(updated?.payload.metadata.settings).toEqual({
      ...redacted,
      user: READER.user,
    });
    expect(JSON.stringify(rows)).not.toContain(settings.password);
    expect(JSON.stringify(rows)).not.toContain(READER.password);
  });
});
