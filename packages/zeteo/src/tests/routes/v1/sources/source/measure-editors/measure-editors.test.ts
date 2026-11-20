// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSource } from "../../../../../support/grants.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  addToDirectory,
  clearDirectory,
} from "../../../../../support/principals.js";
import {
  measuresAdminToken,
  sourcesApi,
} from "../../../../../support/measures.js";

describe("/v1/sources/:sourceId/measure-editors", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let sourceId: string;
  const api = sourcesApi(() => app.url);
  const admin = measuresAdminToken();
  const userId = randomUUID();
  const groupId = randomUUID();

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    await addToDirectory([
      {
        type: "user",
        id: userId,
        name: "Ada Editor",
        email: "ada@example.com",
        status: "active",
      },
      { type: "group", id: groupId, name: "Analysts", status: "active" },
    ]);
  });
  afterAll(async () => {
    await clearDirectory();
    await removeSources([sourceId]);
    await app.close();
  });

  it("starts empty", async () => {
    const res = await api("GET", `/${sourceId}/measure-editors`, admin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("replaces the whole list and answers it with the directory's names", async () => {
    const put = await api("PUT", `/${sourceId}/measure-editors`, admin, {
      principals: [
        { type: "user", id: userId },
        { type: "group", id: groupId },
      ],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toEqual([
      {
        type: "user",
        id: userId,
        name: "Ada Editor",
        email: "ada@example.com",
        added_at: expect.any(String),
      },
      {
        type: "group",
        id: groupId,
        name: "Analysts",
        added_at: expect.any(String),
      },
    ]);

    const replaced = await api("PUT", `/${sourceId}/measure-editors`, admin, {
      principals: [{ type: "group", id: groupId }],
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.map((e: { id: string }) => e.id)).toEqual([
      groupId,
    ]);
    const rows = await prisma.measureEditor.findMany({ where: { sourceId } });
    expect(rows.map((r) => r.principalId)).toEqual([groupId]);
  });

  it("records who was added and who removed", async () => {
    await api("PUT", `/${sourceId}/measure-editors`, admin, {
      principals: [{ type: "user", id: userId }],
    });
    const entries = (await auditRows(sourceId)).filter(
      (r) => r.payload.metadata?.event === "zeteo.measure_editors.updated"
    );
    expect(entries.at(-1)!.payload.metadata).toMatchObject({
      added: [{ type: "user", id: userId }],
      removed: [{ type: "group", id: groupId }],
    });
  });

  it("refuses a principal listed twice with 400", async () => {
    const res = await api("PUT", `/${sourceId}/measure-editors`, admin, {
      principals: [
        { type: "user", id: userId },
        { type: "user", id: userId },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("answers 404 for a source that does not exist", async () => {
    const res = await api("GET", `/${randomUUID()}/measure-editors`, admin);
    expect(res.status).toBe(404);
  });
});
