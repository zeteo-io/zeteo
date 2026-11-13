// @module-tag int
// @module-tag platform
// @module-tag security
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import {
  auditRows,
  readToken,
  removeSources,
  sourceBody,
  uniqueSlug,
  writeToken,
  sourceSettings,
} from "../../../support/sources.js";

const ID = "0198f7a2-0000-7000-8000-000000000000";

describe("/v1/sources failure paths", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const created: string[] = [];

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await removeSources(created);
    await app.close();
  });

  const call = (
    method: string,
    path: string,
    token: string | null,
    body?: unknown
  ) => fetchJson(method, `${app.url}/v1/sources${path}`, token, body);
  const rowCount = (slug: string) => prisma.source.count({ where: { slug } });

  const routes: Array<[string, string, unknown]> = [
    ["POST", "", sourceBody(sourceSettings("ro"))],
    ["GET", "", undefined],
    ["GET", `/${ID}`, undefined],
    ["PATCH", `/${ID}`, { name: "x" }],
    ["POST", `/${ID}/archive`, undefined],
    ["POST", `/${ID}/test`, undefined],
  ];

  it.each(routes)(
    "%s /v1/sources%s answers 401 without a token",
    async (method, path, body) => {
      const res = await call(method, path, null, body);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    }
  );

  it.each(routes.filter(([method]) => method !== "GET"))(
    "%s /v1/sources%s answers 403 to a token that may only read",
    async (method, path, body) => {
      const res = await call(method, path, readToken(), body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    }
  );

  it("lets a read-only token list and get", async () => {
    expect((await call("GET", "", readToken())).status).toBe(200);
    expect((await call("GET", `/${ID}`, readToken())).status).toBe(404);
  });

  it("answers 422 host_not_allowed for a host outside SOURCE_ALLOWED_HOSTS, and stores nothing", async () => {
    const slug = uniqueSlug();
    const res = await call(
      "POST",
      "",
      writeToken(),
      sourceBody(sourceSettings("ro", { host: "192.0.2.10" }), { slug })
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("host_not_allowed");
    expect(await rowCount(slug)).toBe(0);
  });

  it("refuses a login that can write with 422 writable_login listing the findings, and stores nothing", async () => {
    const slug = uniqueSlug();
    const res = await call(
      "POST",
      "",
      writeToken(),
      sourceBody(sourceSettings("rw"), { slug })
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("writable_login");
    expect(res.body.findings).toContain("can_write_tables");
    expect(JSON.stringify(res.body)).not.toContain("rw-test-password");
    expect(await rowCount(slug)).toBe(0);
  });

  it("accepts it with allow_writable_login and records the override in the audit entry", async () => {
    const res = await call(
      "POST",
      "",
      writeToken(),
      sourceBody(sourceSettings("rw"), { allow_writable_login: true })
    );
    expect(res.status).toBe(201);
    created.push(res.body.id);
    expect(res.body.writable_login_allowed).toBe(true);
    const [entry] = await auditRows(res.body.id);
    expect(entry.payload.metadata).toMatchObject({
      event: "zeteo.source.created",
      slug: res.body.slug,
      type: "postgres",
      writable_login_allowed: true,
    });
    expect(entry.payload.metadata.findings).toContain("can_write_tables");
    expect(JSON.stringify(entry.payload)).not.toContain("rw-test-password");
  });

  it("stores writable_login_allowed false when the login is clean, whatever the flag says", async () => {
    const res = await call(
      "POST",
      "",
      writeToken(),
      sourceBody(sourceSettings("ro"), { allow_writable_login: true })
    );
    expect(res.status).toBe(201);
    created.push(res.body.id);
    expect(res.body.writable_login_allowed).toBe(false);
    const [entry] = await auditRows(res.body.id);
    expect(entry.payload.metadata.findings).toBeUndefined();
  });

  it("answers 502 source_unreachable for a wrong password without leaking it or the driver's text", async () => {
    const slug = uniqueSlug();
    const password = "definitely-not-the-password";
    const res = await call(
      "POST",
      "",
      writeToken(),
      sourceBody(sourceSettings("ro", { password }), { slug })
    );
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("source_unreachable");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(password);
    expect(text).not.toContain("password authentication failed");
    expect(await rowCount(slug)).toBe(0);
  });

  it("answers within 7 seconds when the port is closed", async () => {
    const slug = uniqueSlug();
    const started = Date.now();
    const res = await call(
      "POST",
      "",
      writeToken(),
      sourceBody(sourceSettings("ro", { port: 1 }), { slug })
    );
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(7000);
    expect(await rowCount(slug)).toBe(0);
  });
});
