// @module-tag int
// @module-tag platform
import { SavedQueryNotAccessibleError } from "../../utils/errors.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { planSaved } from "../../engine/savedPlan.js";
import type { Progress } from "../../engine/index.js";
import { loadAccess } from "../../grants/access.js";
import { ENGINES } from "../support/engines.js";
import {
  grantTo,
  newQueryUser,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

const callerOf = (userId: string): Caller => ({
  userId,
  organizationId: null,
  permissions: [],
  isServiceAccount: false,
});

describe("planSaved", () => {
  let source: SeededSource;
  const user = newQueryUser();

  const saved = (query: Record<string, unknown> = {}) => ({
    sourceId: source.id,
    query: {
      source: source.slug,
      from: "orders",
      select: ["id", "status"],
      ...query,
    },
  });

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedplan");
    await grantTo(user.principal, source.tables.orders!, ["id", "status"]);
  });
  afterAll(() => removeSources([source.id]));

  it("returns the visible catalogue, the adapter and the plan, and records the source", async () => {
    const access = await loadAccess(callerOf(user.id));
    const progress: Progress = { sourceId: null, unrecorded: false };
    const { catalog, adapter, plan } = await planSaved(
      access,
      saved(),
      progress
    );
    expect(catalog.source.id).toBe(source.id);
    expect(catalog.tables.map((t) => t.name)).toEqual(["orders"]);
    expect(adapter.type).toBe("postgres");
    expect(plan.columns.map((c) => c.name)).toEqual(["id", "status"]);
    expect(progress).toEqual({ sourceId: source.id, unrecorded: false });
  });

  it("plans with the source's id from the row, whatever slug the stored query names", async () => {
    const access = await loadAccess(callerOf(user.id));
    const { catalog } = await planSaved(
      access,
      saved({ source: "renamed-since" }),
      { sourceId: null, unrecorded: false }
    );
    expect(catalog.source.id).toBe(source.id);
  });

  it.each([
    ["the planner refuses", { select: ["id", "total"] }],
    ["the language refuses", { zzqxw: true }],
  ])("leaves the progress untouched when %s", async (_, query) => {
    const access = await loadAccess(callerOf(user.id));
    const progress: Progress = { sourceId: null, unrecorded: false };
    await expect(
      planSaved(access, saved(query), progress)
    ).rejects.toBeInstanceOf(SavedQueryNotAccessibleError);
    expect(progress).toEqual({ sourceId: null, unrecorded: false });
  });
});
