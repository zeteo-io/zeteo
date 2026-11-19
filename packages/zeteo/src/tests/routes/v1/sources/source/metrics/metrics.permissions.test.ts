// @module-tag int
// @module-tag platform
import { DATA_READ } from "../../../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { ENGINES } from "../../../../../support/engines.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  clearTestGroups,
  setTestGroups,
} from "../../../../../support/principals.js";
import {
  createMeasures,
  measureBody,
  measuresAdminToken,
  measureUser,
  metricBody,
  setEditors,
  sourcesApi,
} from "../../../../../support/measures.js";
import {
  grantTo,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

// Metrics have the measures' editors: the same list, the same permission.

const DOUBLE = { mul: [{ measure: "revenue" }, 2] };

describe("/v1/sources/:sourceId/metrics: who may change them", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const listed = measureUser();
  const unlisted = measureUser();
  const grouped = measureUser();
  const groupId = randomUUID();

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "metrics");
    for (const who of [
      listed.principal,
      unlisted.principal,
      grouped.principal,
    ]) {
      await grantTo(who, source.tables.orders!, "all");
    }
    await setTestGroups(grouped.id, [{ id: groupId, organizationId: null }]);
    await setEditors(app.url, source.id, [
      listed.principal,
      { type: "group", id: groupId },
    ]);
    await createMeasures(app.url, source.id, listed.token, [
      measureBody("revenue", { sum: "total" }),
    ]);
  });
  afterAll(async () => {
    await clearTestGroups(grouped.id);
    await removeSources([source.id]);
    await app.close();
  });

  it("tells the list's caller whether they may edit and manage editors", async () => {
    const flags = async (token: string) => {
      const res = await api("GET", `/${source.id}/metrics`, token);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return [res.body.can_edit, res.body.can_manage_editors];
    };
    expect(await flags(listed.token)).toEqual([true, false]);
    expect(await flags(grouped.token)).toEqual([true, false]);
    expect(await flags(unlisted.token)).toEqual([false, false]);
    expect(await flags(measuresAdminToken())).toEqual([false, true]);
  });

  it("lets a user listed through a group create a metric", async () => {
    const res = await api(
      "POST",
      `/${source.id}/metrics`,
      grouped.token,
      metricBody("grouped_double", DOUBLE)
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it.each([
    ["a zeteo_user who is not listed", () => unlisted.token],
    ["an admin who is not listed", () => measuresAdminToken()],
    [
      "a listed user without zeteo.measures.write",
      () => tokenFor({ userId: listed.id, permissions: [DATA_READ] }),
    ],
  ])("refuses a create or preview by %s with 403", async (_, token) => {
    const body = metricBody("refused_double", DOUBLE);
    const created = await api("POST", `/${source.id}/metrics`, token(), body);
    expect(created.status).toBe(403);
    const preview = await api(
      "POST",
      `/${source.id}/metrics/preview`,
      token(),
      {
        metric: body,
      }
    );
    expect(preview.status).toBe(403);
  });

  it("refuses a change or delete by a user who is not listed with 403", async () => {
    const created = await api(
      "POST",
      `/${source.id}/metrics`,
      listed.token,
      metricBody("listed_double", DOUBLE)
    );
    const path = `/${source.id}/metrics/${created.body.id}`;
    expect(
      (await api("PATCH", path, unlisted.token, { description: "x" })).status
    ).toBe(403);
    expect((await api("DELETE", path, unlisted.token)).status).toBe(403);
  });

  it("refuses changes once the source is archived", async () => {
    const archived = await seedQuerySource(ENGINES[0]!, {}, "metrics");
    try {
      await grantTo(listed.principal, archived.tables.orders!, "all");
      await setEditors(app.url, archived.id, [listed.principal]);
      await createMeasures(app.url, archived.id, listed.token, [
        measureBody("revenue", { sum: "total" }),
      ]);
      const archive = await api(
        "POST",
        `/${archived.id}/archive`,
        measuresAdminToken()
      );
      expect(archive.status).toBe(204);
      const res = await api(
        "POST",
        `/${archived.id}/metrics`,
        listed.token,
        metricBody("late_double", DOUBLE)
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("source_archived");
    } finally {
      await removeSources([archived.id]);
    }
  });

  it("refuses a caller without any of the read permissions", async () => {
    const res = await api(
      "GET",
      `/${source.id}/metrics`,
      tokenFor({ userId: randomUUID(), permissions: [] })
    );
    expect(res.status).toBe(403);
  });
});
