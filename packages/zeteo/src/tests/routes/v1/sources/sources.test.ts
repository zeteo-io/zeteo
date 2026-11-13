// @module-tag int
// @module-tag platform
import { postgresAdapter } from "../../../../adapters/postgres/index.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SourceUnreachableError } from "../../../../utils/errors.js";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { logger } from "../../../../utils/logger.js";
import { fetchJson } from "../../../support/http.js";
import {
  auditRows,
  removeSources,
  sourceBody,
  uniqueSlug,
  writeToken,
  sourceSettings,
} from "../../../support/sources.js";

describe("/v1/sources", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const created: string[] = [];

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await removeSources(created);
    await app.close();
  });

  const post = (body: unknown) =>
    fetchJson("POST", `${app.url}/v1/sources`, writeToken(), body);
  const get = (path: string) =>
    fetchJson("GET", `${app.url}/v1/sources${path}`, writeToken());

  const create = async (overrides: Record<string, unknown> = {}) => {
    const res = await post(sourceBody(sourceSettings("ro"), overrides));
    if (res.status === 201) created.push(res.body.id);
    return res;
  };

  it("creates a source and answers its view without the password", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Sales",
      type: "postgres",
      schemas: ["public"],
      writable_login_allowed: false,
      status: "active",
      last_refreshed_at: expect.any(String),
      archived_at: null,
    });
    expect(res.body.settings).toMatchObject({
      user: "zeteo_ro",
      database: "zeteo_fixture",
      tls: "off",
    });
    expect(JSON.stringify(res.body)).not.toContain("ro-test-password");
    expect(res.body.settings).not.toHaveProperty("password");
    expect(res.body.settings).not.toHaveProperty("ca");
  });

  it("stores the settings sealed, with no plaintext password", async () => {
    const res = await create();
    const row = await prisma.source.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    const stored = JSON.stringify(row.sealedSettings);
    expect(stored).not.toContain("ro-test-password");
    expect(stored).not.toContain("zeteo_ro");
    expect(row.sealedSettings).toHaveProperty("ciphertext");
  });

  it("records zeteo.source.created with the redacted settings, TLS off included, and no password", async () => {
    const res = await create();
    const rows = (await auditRows(res.body.id)).filter(
      (r) => r.payload.metadata.event === "zeteo.source.created"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      action: "CREATE",
      entityType: "source",
      metadata: {
        event: "zeteo.source.created",
        slug: res.body.slug,
        type: "postgres",
      },
    });
    const settings = sourceSettings("ro");
    expect(rows[0].payload.metadata.settings).toEqual({
      host: settings.host,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      tls: "off",
    });
    expect(JSON.stringify(rows[0].payload)).not.toContain("ro-test-password");
  });

  it("reads the schema after the row is committed, so the catalogue is filled when the 201 arrives", async () => {
    const res = await create({ schemas: ["sales"] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("active");
    const tables = await get(`/${res.body.id}/tables`);
    expect(tables.body.data).toHaveLength(5);
    const events = (await auditRows(res.body.id)).map(
      (r) => r.payload.metadata.event
    );
    expect(events).toEqual(["zeteo.source.created", "zeteo.source.refreshed"]);
  });

  it("answers 201 with status unreachable when the first refresh fails", async () => {
    // The login check connects first and passes; the pool the refresh opens is refused.
    const original = postgresAdapter.connect.bind(postgresAdapter);
    let calls = 0;
    const connect = vi
      .spyOn(postgresAdapter, "connect")
      .mockImplementation((...args) =>
        ++calls === 1
          ? original(...args)
          : Promise.reject(new SourceUnreachableError())
      );
    try {
      const res = await create({ schemas: ["sales"] });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("unreachable");
      expect(res.body.last_refreshed_at).toBeNull();
      expect((await get(`/${res.body.id}/tables`)).body.data).toEqual([]);
    } finally {
      connect.mockRestore();
    }
  });

  describe("when the first refresh fails", () => {
    const failSecondConnect = (error: () => Error) => {
      const original = postgresAdapter.connect.bind(postgresAdapter);
      let calls = 0;
      return vi
        .spyOn(postgresAdapter, "connect")
        .mockImplementation((...args) =>
          ++calls === 1 ? original(...args) : Promise.reject(error())
        );
    };

    it("logs an unreachable source as a warning", async () => {
      const connect = failSecondConnect(() => new SourceUnreachableError());
      const warn = vi.spyOn(logger, "warn");
      const error = vi.spyOn(logger, "error");
      try {
        expect((await create({ schemas: ["sales"] })).status).toBe(201);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(SourceUnreachableError) }),
          expect.any(String)
        );
        expect(error).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    });

    it("logs anything else as an error, and still answers 201", async () => {
      const connect = failSecondConnect(() => new Error("boom"));
      const warn = vi.spyOn(logger, "warn");
      const error = vi.spyOn(logger, "error");
      try {
        expect((await create({ schemas: ["sales"] })).status).toBe(201);
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({
            err: expect.objectContaining({ message: "boom" }),
          }),
          expect.any(String)
        );
        expect(warn).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    });
  });

  it("answers 400 invalid_request, not 500, to a name with a NUL character", async () => {
    const res = await post(
      sourceBody(sourceSettings("ro"), { name: "Sa\u0000les" })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("answers 409 slug_taken for a duplicate slug", async () => {
    const first = await create();
    const again = await post(
      sourceBody(sourceSettings("ro"), { slug: first.body.slug })
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("slug_taken");
  });

  it("answers 422 source_type_unavailable for azure-sql", async () => {
    const res = await post(
      sourceBody({ server: "x" }, { type: "azure-sql", slug: uniqueSlug() })
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("source_type_unavailable");
  });

  it("answers 400 invalid_request for a malformed slug, with no row", async () => {
    const slug = "Bad Slug";
    const res = await post(sourceBody(sourceSettings("ro"), { slug }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(await prisma.source.count({ where: { slug } })).toBe(0);
  });

  it("answers 400 for settings the adapter does not accept, without echoing them", async () => {
    const res = await post(
      sourceBody({ ...sourceSettings("ro"), port: "not-a-port", extra: 1 })
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("ro-test-password");
  });

  it("gets one source and answers 404 for an unknown id", async () => {
    const made = await create();
    const res = await get(`/${made.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(made.body.id);
    const missing = await get("/0198f7a2-0000-7000-8000-000000000000");
    expect(missing.status).toBe(404);
    expect((await get("/not-an-id")).status).toBe(400);
  });

  it("lists sources in pages and hides archived ones by default", async () => {
    const tag = uniqueSlug("pg");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const made = await create({ slug: `${tag}-${i}` });
      ids.push(made.body.id);
    }
    const archivedId = ids[2];
    const archived = await fetchJson(
      "POST",
      `${app.url}/v1/sources/${archivedId}/archive`,
      writeToken()
    );
    expect(archived.status).toBe(204);

    const first = await get("?limit=1");
    expect(first.body.data).toHaveLength(1);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await get(`?limit=1&cursor=${first.body.next_cursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(`?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...res.body.data.map((s: { id: string }) => s.id));
      cursor = res.body.next_cursor;
    } while (cursor);
    expect(seen).toContain(ids[0]);
    expect(seen).toContain(ids[1]);
    expect(seen).not.toContain(archivedId);

    const all = await get("?include_archived=true&limit=100");
    expect(all.body.data.map((s: { id: string }) => s.id)).toContain(
      archivedId
    );
  });

  it("answers 400 for a malformed cursor", async () => {
    expect((await get("?cursor=!!!")).status).toBe(400);
  });
});
