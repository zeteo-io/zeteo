// @module-tag int
// @module-tag platform
import { removeSources } from "../../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../../support/v1App.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { ENGINES } from "../../../../../../support/engines.js";
import {
  createMeasures,
  measureBody,
  measuresAdminToken,
  measureUser,
  setEditors,
  sourcesApi,
} from "../../../../../../support/measures.js";
import {
  grantTo,
  seedQuerySource,
  type SeededSource,
} from "../../../../../../support/queries.js";

describe("/v1/sources/:sourceId/measures/:measureId", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();
  const admin = measuresAdminToken();
  let ids: Record<string, string>;

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "measures");
    for (const table of ["orders", "customers", "accounts"]) {
      await grantTo(editor.principal, source.tables[table]!, "all");
    }
    await setEditors(app.url, source.id, [editor.principal]);
    ids = await createMeasures(app.url, source.id, editor.token, [
      measureBody("note_count", { count: "notes" }),
      measureBody("plan_count", { countDistinct: "customers.accounts.plan" }),
      measureBody("open_total", { sum: "total" }, { status: { eq: "open" } }),
    ]);
  });
  afterAll(async () => {
    await removeSources([source.id]);
    await app.close();
  });

  it("answers a measure in full to its editor", async () => {
    const res = await api(
      "GET",
      `/${source.id}/measures/${ids.open_total}`,
      editor.token
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: ids.open_total,
      name: "open_total",
      table: "orders",
      formula: { sum: "total" },
      where: { status: { eq: "open" } },
      usable: true,
      used_by: { saved_queries: 0, panels: 0 },
    });
    expect(res.body).not.toHaveProperty("broken");
  });

  it("removes a measure's filter with where: null, and renames one nothing uses", async () => {
    const path = `/${source.id}/measures/${ids.open_total}`;
    const res = await api("PATCH", path, editor.token, {
      where: null,
      name: "all_total",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ name: "all_total", where: null });
    const row = await prisma.measure.findUniqueOrThrow({
      where: { id: ids.open_total },
    });
    expect(row.where).toBeNull();
    expect(row.updatedBy).toBe(editor.id);
  });

  it("answers 400 for an empty change", async () => {
    const res = await api(
      "PATCH",
      `/${source.id}/measures/${ids.open_total}`,
      editor.token,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("shows an admin a measure over a missing column as broken", async () => {
    const notes = source.tables.orders!.columns.notes!;
    await prisma.sourceColumn.update({
      where: { id: notes },
      data: { missingSince: new Date() },
    });
    try {
      const res = await api(
        "GET",
        `/${source.id}/measures/${ids.note_count}`,
        admin
      );
      expect(res.status).toBe(200);
      expect(res.body.broken).toEqual({
        code: "missing_in_source",
        message: expect.any(String),
      });
      // The admin is granted nothing, so may not use it either.
      expect(res.body.usable).toBe(false);
      const list = await api("GET", `/${source.id}/measures`, admin);
      const byName = Object.fromEntries(
        list.body.data.map((m: { name: string }) => [m.name, m])
      );
      expect(byName.note_count.broken.code).toBe("missing_in_source");
      expect(byName.plan_count.broken).toBeNull();
    } finally {
      await prisma.sourceColumn.update({
        where: { id: notes },
        data: { missingSince: null },
      });
    }
  });

  it("shows an admin a measure that no longer fits the source's joins as broken", async () => {
    const { maxJoins } = await prisma.source.findUniqueOrThrow({
      where: { id: source.id },
    });
    await prisma.source.update({
      where: { id: source.id },
      data: { maxJoins: 1 },
    });
    try {
      const res = await api(
        "GET",
        `/${source.id}/measures/${ids.plan_count}`,
        admin
      );
      expect(res.body.broken).toEqual({
        code: "too_many_joins",
        message: expect.any(String),
      });
    } finally {
      await prisma.source.update({
        where: { id: source.id },
        data: { maxJoins },
      });
    }
  });

  it("answers 404 for a measure of another source", async () => {
    const other = await seedQuerySource(ENGINES[0]!, {}, "measures");
    try {
      const res = await api(
        "GET",
        `/${other.id}/measures/${ids.note_count}`,
        admin
      );
      expect(res.status).toBe(404);
      expect(res.body.error_description).toBe("Measure not found");
    } finally {
      await removeSources([other.id]);
    }
  });
});
