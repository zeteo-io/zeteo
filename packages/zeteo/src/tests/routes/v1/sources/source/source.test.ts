// @module-tag int
// @module-tag platform
import { postgresAdapter } from "../../../../../adapters/postgres/index.js";
import { SourceUnreachableError } from "../../../../../utils/errors.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sealSettings } from "../../../../../utils/crypto/envelope.js";
import { startV1Routes } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  isSourcePoolOpen,
  withSourceConnection,
} from "../../../../../sources/pools.js";
import {
  removeUploadSources,
  seedUploadSource,
} from "../../../../support/uploads.js";
import {
  auditRows,
  removeSources,
  sourceBody,
  writeToken,
  sourceSettings,
} from "../../../../support/sources.js";

describe("/v1/sources/:sourceId", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const created: string[] = [];

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await removeSources(created);
    await app.close();
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetchJson(method, `${app.url}/v1/sources${path}`, writeToken(), body);

  const create = async () => {
    const res = await call("POST", "", sourceBody(sourceSettings("ro")));
    created.push(res.body.id);
    return res.body as { id: string; slug: string };
  };

  it("PATCH with a name only does not contact the source", async () => {
    const source = await create();
    // The stored settings now point at a closed port.
    await prisma.source.update({
      where: { id: source.id },
      data: {
        sealedSettings: sealSettings(
          sourceSettings("ro", { port: 1 }),
          source.id
        ) as object,
      },
    });
    const connect = vi.spyOn(postgresAdapter, "connect");
    try {
      const res = await call("PATCH", `/${source.id}`, {
        name: "Renamed",
        timeout_ms: 5000,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "Renamed", timeout_ms: 5000 });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
    const entries = await auditRows(source.id);
    expect(entries.at(-1)?.payload).toMatchObject({
      action: "UPDATE",
      metadata: { event: "zeteo.source.updated", slug: source.slug },
    });
  });

  it("PATCH changes query_concurrency and export_concurrency without contacting the source, records the limits, and retires the open pool", async () => {
    const source = await create();
    await withSourceConnection(source.id, (c) => c.checkLogin());
    expect(isSourcePoolOpen(source.id)).toBe(true);
    const connect = vi.spyOn(postgresAdapter, "connect");
    let res;
    try {
      res = await call("PATCH", `/${source.id}`, {
        query_concurrency: 1,
        export_concurrency: 10,
      });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      query_concurrency: 1,
      export_concurrency: 10,
    });
    expect(isSourcePoolOpen(source.id)).toBe(false);
    const entry = (await auditRows(source.id)).at(-1)?.payload;
    expect(entry?.metadata).toMatchObject({
      event: "zeteo.source.updated",
      changed: ["query_concurrency", "export_concurrency"],
      limits: {
        timeout_ms: 30_000,
        row_cap: 50_000,
        max_joins: 4,
        export_enabled: false,
        export_row_cap: 0,
        query_concurrency: 1,
        export_concurrency: 10,
      },
    });
  });

  it("PATCH changes max_joins and keeps it when the body omits it", async () => {
    const source = await create();
    const res = await call("PATCH", `/${source.id}`, { max_joins: 2 });
    expect(res.status).toBe(200);
    expect(res.body.max_joins).toBe(2);
    const kept = await call("PATCH", `/${source.id}`, { name: "Renamed" });
    expect(kept.body.max_joins).toBe(2);
    const refused = await call("PATCH", `/${source.id}`, { max_joins: 9 });
    expect(refused.status).toBe(400);
  });

  it("PATCH keeps the open pool when no concurrency setting changed", async () => {
    const source = await create();
    await withSourceConnection(source.id, (c) => c.checkLogin());
    const res = await call("PATCH", `/${source.id}`, {
      name: "Renamed",
      query_concurrency: 5,
    });
    expect(res.status).toBe(200);
    expect(isSourcePoolOpen(source.id)).toBe(true);
  });

  it.each([
    { query_concurrency: 0 },
    { query_concurrency: 51 },
    { export_concurrency: 0 },
    { export_concurrency: 11 },
  ])("PATCH refuses %o with 400 invalid_request", async (limit) => {
    const source = await create();
    const res = await call("PATCH", `/${source.id}`, limit);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect((await call("GET", `/${source.id}`)).body).toMatchObject({
      query_concurrency: 5,
      export_concurrency: 2,
    });
  });

  it("PATCH with settings re-runs the login check and replaces the settings", async () => {
    const source = await create();
    const refused = await call("PATCH", `/${source.id}`, {
      settings: sourceSettings("rw"),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("writable_login");
    expect(refused.body.findings).toContainEqual({
      code: "can_write_tables",
      detail: expect.stringContaining("sales.orders"),
    });
    expect((await call("GET", `/${source.id}`)).body.settings.user).toBe(
      "zeteo_ro"
    );

    const unreachable = await call("PATCH", `/${source.id}`, {
      settings: sourceSettings("ro", { port: 1 }),
    });
    expect(unreachable.status).toBe(502);

    const allowed = await call("PATCH", `/${source.id}`, {
      settings: sourceSettings("rw"),
      allow_writable_login: true,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.settings.user).toBe("zeteo_rw");
    expect(allowed.body.writable_login_allowed).toBe(true);
    expect(JSON.stringify(allowed.body)).not.toContain("rw-test-password");
    const entries = await auditRows(source.id);
    expect(JSON.stringify(entries)).not.toContain("rw-test-password");
    const updated = entries.filter(
      (r) => r.payload.metadata.event === "zeteo.source.updated"
    );
    expect(updated.at(-1)?.payload.metadata.findings).toContain(
      "can_write_tables"
    );
  });

  it("PATCH settings records the new redacted settings in the audit entry, and no password", async () => {
    const source = await create();
    const settings = sourceSettings("ro");
    const changed = await call("PATCH", `/${source.id}`, { settings });
    expect(changed.status).toBe(200);
    const entry = (await auditRows(source.id)).find(
      (r) =>
        r.payload.metadata.event === "zeteo.source.updated" &&
        r.payload.metadata.changed.includes("settings")
    );
    expect(entry?.payload.metadata.settings).toEqual({
      host: settings.host,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      tls: "off",
    });
    expect(JSON.stringify(entry?.payload)).not.toContain("ro-test-password");
  });

  it("PATCH without settings records no settings in the audit entry", async () => {
    const source = await create();
    expect(
      (await call("PATCH", `/${source.id}`, { name: "Plain" })).status
    ).toBe(200);
    const entries = (await auditRows(source.id)).filter(
      (r) => r.payload.metadata.event === "zeteo.source.updated"
    );
    expect(entries.at(-1)?.payload.metadata).not.toHaveProperty("settings");
  });

  it("PATCH schemas refreshes the catalogue: tables of a schema taken off the list are missing", async () => {
    const res = await call(
      "POST",
      "",
      sourceBody(sourceSettings("ro"), { schemas: ["sales", "hr"] })
    );
    expect(res.status).toBe(201);
    created.push(res.body.id);
    const tables = await call("GET", `/${res.body.id}/tables`);
    expect(tables.body.data).toHaveLength(13);

    const patched = await call("PATCH", `/${res.body.id}`, { schemas: ["hr"] });
    expect(patched.status).toBe(200);
    expect(patched.body.schemas).toEqual(["hr"]);
    expect((await call("GET", `/${res.body.id}/tables`)).body.data).toEqual([]);
    const all = await call(
      "GET",
      `/${res.body.id}/tables?include_missing=true`
    );
    expect(all.body.data).toHaveLength(13);
    for (const table of all.body.data) {
      expect(table.missing_since).toEqual(expect.any(String));
    }
  });

  it("PATCH settings refreshes the catalogue, so a source fixed by new settings is active again", async () => {
    const source = await create();
    await prisma.source.update({
      where: { id: source.id },
      data: { status: "unreachable" },
    });
    const res = await call("PATCH", `/${source.id}`, {
      settings: sourceSettings("ro"),
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });

  it("PATCH answers 200 with the change when the refresh after it fails", async () => {
    const source = await create();
    const connect = postgresAdapter.connect.bind(postgresAdapter);
    let calls = 0;
    // The first connection is the login check's; the second, the refresh's.
    const spy = vi
      .spyOn(postgresAdapter, "connect")
      .mockImplementation(async (...args) => {
        calls++;
        if (calls === 2) throw new SourceUnreachableError();
        return connect(...args);
      });
    try {
      const res = await call("PATCH", `/${source.id}`, {
        settings: sourceSettings("ro"),
        name: "Still saved",
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: "Still saved",
        status: "unreachable",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("PATCH settings closes the source's open pool", async () => {
    const source = await create();
    const old = await withSourceConnection(source.id, async (c) => c);
    const close = vi.spyOn(old, "close");
    const res = await call("PATCH", `/${source.id}`, {
      settings: sourceSettings("ro"),
    });
    expect(res.status).toBe(200);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("answers 400 to allow_writable_login without settings, and to slug or type", async () => {
    const source = await create();
    for (const body of [
      { allow_writable_login: true },
      { slug: "other-slug" },
      { type: "postgres" },
      {},
    ]) {
      const res = await call("PATCH", `/${source.id}`, body);
      expect(res.status).toBe(400);
    }
  });

  it("archives with 204, closes the pool, and refuses later changes with 409 source_archived", async () => {
    const source = await create();
    await withSourceConnection(source.id, (c) => c.checkLogin());
    expect(isSourcePoolOpen(source.id)).toBe(true);

    const res = await call("POST", `/${source.id}/archive`);
    expect(res.status).toBe(204);
    expect(isSourcePoolOpen(source.id)).toBe(false);

    const patch = await call("PATCH", `/${source.id}`, { name: "late" });
    expect(patch.status).toBe(409);
    expect(patch.body.error).toBe("source_archived");
    expect((await call("POST", `/${source.id}/archive`)).body.error).toBe(
      "source_archived"
    );
    expect((await call("POST", `/${source.id}/test`)).body.error).toBe(
      "source_archived"
    );
    await expect(
      withSourceConnection(source.id, (c) => c.checkLogin())
    ).rejects.toMatchObject({ code: "source_archived" });

    const view = await call("GET", `/${source.id}`);
    expect(view.body.archived_at).toEqual(expect.any(String));
    const entries = await auditRows(source.id);
    expect(entries.at(-1)?.payload).toMatchObject({
      action: "ARCHIVE",
      metadata: { event: "zeteo.source.archived" },
    });
  });

  it("GET shows the size the refresh after creating measured", async () => {
    const posted = await call(
      "POST",
      "",
      sourceBody(sourceSettings("ro"), { schemas: ["sales"] })
    );
    const source = posted.body as { id: string };
    created.push(source.id);
    const res = await call("GET", `/${source.id}`);
    expect(res.status).toBe(200);
    expect(res.body.size_bytes).toEqual(expect.any(Number));
    expect(res.body.size_bytes).toBeGreaterThan(0);
    expect(new Date(res.body.size_measured_at).toISOString()).toBe(
      res.body.size_measured_at
    );
  });

  describe("an upload source", () => {
    const ownerId = randomUUID();
    let fileId: string;
    beforeAll(async () => {
      fileId = (await seedUploadSource({ ownerId, tables: [] })).id;
    });
    afterAll(async () => {
      await removeUploadSources([fileId]);
    });

    it("GET shows settings null and the owner", async () => {
      const res = await call("GET", `/${fileId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        type: "upload",
        settings: null,
        owner_id: ownerId,
      });
    });

    it("GET shows an upload source's stored bytes as its size, never measured", async () => {
      const res = await call("GET", `/${fileId}`);
      expect(res.body).toMatchObject({
        size_bytes: 0,
        size_measured_at: null,
        share_count: 0,
      });
    });

    it("GET shows owner_id null for a database source", async () => {
      const source = await create();
      expect((await call("GET", `/${source.id}`)).body.owner_id).toBeNull();
    });

    it("GET shows a database source's share_count: the people and groups its tables are granted to", async () => {
      const posted = await call(
        "POST",
        "",
        sourceBody(sourceSettings("ro"), { schemas: ["sales"] })
      );
      const source = posted.body as { id: string };
      created.push(source.id);
      const tables = await prisma.sourceTable.findMany({
        where: { sourceId: source.id },
        take: 2,
      });
      expect(tables).toHaveLength(2);
      expect((await call("GET", `/${source.id}`)).body.share_count).toBe(0);
      const user = randomUUID();
      const group = randomUUID();
      // The user on two tables, the group on one: two principals.
      await prisma.grant.createMany({
        data: [
          {
            principalType: "user" as const,
            principalId: user,
            tableId: tables[0]!.id,
          },
          {
            principalType: "user" as const,
            principalId: user,
            tableId: tables[1]!.id,
          },
          {
            principalType: "group" as const,
            principalId: group,
            tableId: tables[0]!.id,
          },
        ].map((g) => ({ ...g, allColumns: true, createdBy: user })),
      });
      try {
        expect((await call("GET", `/${source.id}`)).body.share_count).toBe(2);
      } finally {
        await prisma.grant.deleteMany({
          where: { principalId: { in: [user, group] } },
        });
      }
    });

    it("PATCH changes only its limits, and records the change", async () => {
      const limits = {
        timeout_ms: 5000,
        row_cap: 10,
        max_joins: 2,
        export_enabled: true,
        export_row_cap: 100,
        query_concurrency: 3,
        export_concurrency: 1,
      };
      const res = await call("PATCH", `/${fileId}`, limits);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ ...limits, type: "upload" });
      const entry = (await auditRows(fileId)).at(-1)?.payload;
      expect(entry).toMatchObject({
        metadata: { event: "zeteo.source.updated", limits },
      });
      await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'entityId' = ${fileId}`;
    });

    it.each([
      ["schemas", { schemas: ["public"] }],
      ["settings", { settings: { host: "x" } }],
      ["settings and a name", { name: "Renamed", settings: { host: "x" } }],
    ])("PATCH with %s answers 409 not_a_database_source", async (_, body) => {
      const res = await call("PATCH", `/${fileId}`, body);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("not_a_database_source");
    });

    it.each([
      ["PATCH", "", { schemas: ["public"] }],
      ["POST", "/test", undefined],
      ["POST", "/archive", undefined],
    ])(
      "%s %s answers 409 not_a_database_source and changes nothing",
      async (method, path, body) => {
        const before = await prisma.source.findUniqueOrThrow({
          where: { id: fileId },
        });
        const res = await call(method, `/${fileId}${path}`, body);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("not_a_database_source");
        expect(
          await prisma.source.findUniqueOrThrow({ where: { id: fileId } })
        ).toEqual(before);
        expect(await auditRows(fileId)).toEqual([]);
      }
    );
  });

  it("POST /test returns the findings and changes nothing", async () => {
    const source = await create();
    const clean = await call("POST", `/${source.id}/test`);
    expect(clean.status).toBe(200);
    expect(clean.body).toEqual({ ok: true, findings: [] });

    await prisma.source.update({
      where: { id: source.id },
      data: {
        sealedSettings: sealSettings(sourceSettings("rw"), source.id) as object,
      },
    });
    const before = await prisma.source.findUniqueOrThrow({
      where: { id: source.id },
    });
    const dirty = await call("POST", `/${source.id}/test`);
    expect(dirty.status).toBe(200);
    expect(dirty.body.ok).toBe(true);
    expect(dirty.body.findings.map((f: { code: string }) => f.code)).toContain(
      "can_write_tables"
    );

    const after = await prisma.source.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.writableLoginAllowed).toBe(false);
  });

  it("POST /test lists at most 20 findings, and says so", async () => {
    const source = await create();
    const connect = postgresAdapter.connect.bind(postgresAdapter);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        code: "can_write_tables" as const,
        detail: `The login can INSERT on sales.t${i}`,
      }));
    const spy = vi
      .spyOn(postgresAdapter, "connect")
      .mockImplementation(async (...args) => {
        const conn = await connect(...args);
        conn.checkLogin = async () => many(21);
        return conn;
      });
    try {
      const res = await call("POST", `/${source.id}/test`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        findings: many(20),
        truncated: true,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
