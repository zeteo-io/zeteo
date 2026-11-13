// @module-tag int
// @module-tag platform
// @module-tag security
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { startV1App } from "../support/v1App.js";
import { tokenFor } from "../support/tokens.js";
import { fetchJson } from "../support/http.js";
import { randomUUID } from "crypto";
import { Router } from "express";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  authenticate,
  callerOf,
  requirePermission,
} from "../../middleware/auth.js";

// Mounted only here, never in the production app.
const probe = Router();
probe.get("/whoami", authenticate, (req, res) => {
  res.json(callerOf(req));
});
probe.get(
  "/read",
  authenticate,
  requirePermission(SOURCES_READ),
  (_req, res) => {
    res.json({ ok: true });
  }
);
probe.get(
  "/write",
  authenticate,
  requirePermission(SOURCES_WRITE),
  (_req, res) => {
    res.json({ ok: true });
  }
);

describe("authenticate and requirePermission", () => {
  let app: Awaited<ReturnType<typeof startV1App>>;

  beforeAll(async () => {
    await initializeTereo();
    app = await startV1App(probe);
  });
  afterAll(async () => {
    await app.close();
    await stopTereo();
  });

  const get = (path: string, token: string | null) =>
    fetchJson("GET", `${app.url}/v1${path}`, token);

  it("answers 401 unauthorized without a token", async () => {
    const res = await get("/read", null);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("answers 401 when introspection of the token fails", async () => {
    const res = await get("/read", "not-a-token-of-this-core");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("answers 403 forbidden to a token without the permission", async () => {
    const res = await get("/read", tokenFor({ permissions: [] }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("answers 403 to a token whose permission does not cover the route", async () => {
    const res = await get("/write", tokenFor({ permissions: [SOURCES_READ] }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("lets the permission itself through", async () => {
    const res = await get("/read", tokenFor({ permissions: [SOURCES_READ] }));
    expect(res.status).toBe(200);
  });

  it("lets zeteo.sources.write satisfy zeteo.sources.read", async () => {
    const res = await get("/read", tokenFor({ permissions: [SOURCES_WRITE] }));
    expect(res.status).toBe(200);
  });

  it("describes the caller from the token", async () => {
    const userId = randomUUID();
    const res = await get(
      "/whoami",
      tokenFor({ userId, permissions: [SOURCES_READ] })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId,
      organizationId: null,
      permissions: [SOURCES_READ],
      isServiceAccount: false,
    });
  });

  it("marks a token whose subject is its own client as a service account", async () => {
    const id = randomUUID();
    const res = await get("/whoami", `test-token-${id}|client=${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: id, isServiceAccount: true });
  });

  it("takes the organization from the token's org_id", async () => {
    const org = randomUUID();
    const res = await get("/whoami", `test-token-${randomUUID()}|org=${org}`);
    expect(res.body.organizationId).toBe(org);
  });
});
