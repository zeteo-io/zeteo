// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCsvValues } from "../../../../../support/pure/csv.js";
import { removeSources } from "../../../../../support/sources.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  ordersQuery,
  savedQueriesCall,
  savedQueryOf,
  shareDirectly,
} from "../../../../../support/savedQueries.js";
import {
  eventually,
  newExportUser,
  postExport,
} from "../../../../../support/exports.js";
import {
  grantTo,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/saved-queries/:savedQueryId/export", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const made = newExportUser();
    users.push(made.id);
    await grantTo(made.principal, source.tables.orders!, ["id", "status"]);
    return made;
  };
  const exportOf = (
    id: string,
    token: string,
    body: unknown = {},
    search = "format=csv"
  ) =>
    postExport({
      token,
      body,
      search,
      path: `/v1/saved-queries/${id}/export`,
    });

  beforeAll(async () => {
    source = await seedQuerySource(
      ENGINES[0]!,
      { export_enabled: true, export_row_cap: 1_000_000 },
      "savedexport"
    );
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("streams a CSV export of the saved query and stamps its run once it ends", async () => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source, {
      query: { ...ordersQuery(source), orderBy: [{ id: "asc" }] },
    });
    const res = await exportOf(id, owner.token);
    expect(res.status, res.text).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    const [header, ...records] = readCsvValues(res.text);
    expect(header).toEqual(["id", "status"]);
    expect(records.length).toBeGreaterThan(1);
    expect(res.trailers).toEqual({
      "x-zeteo-export-status": "complete",
      "x-zeteo-export-rows": String(records.length),
    });

    const run = await eventually(async () => {
      const [found] = await runsOf([owner.id]);
      return found?.outcome === "ok" ? found : undefined;
    });
    expect(run).toMatchObject({
      id: res.headers["x-zeteo-run-id"],
      savedQueryId: id,
      sourceId: source.id,
      entryPoint: "export",
    });
    const seen = await eventually(async () => {
      const got = await savedQueriesCall("GET", `/${id}`, owner.token);
      return got.body.last_run_at && got.body.you_last_ran_at
        ? got.body
        : undefined;
    });
    expect(seen.you_last_ran_at).toBe(seen.last_run_at);
  });

  it("overrides the stored limit with the one given", async () => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source, {
      query: { ...ordersQuery(source), orderBy: [{ id: "asc" }] },
    });
    const res = await exportOf(id, owner.token, { limit: 1 }, "format=ndjson");
    expect(res.status, res.text).toBe(200);
    const lines = res.text.trimEnd().split("\n");
    // The head, one row and the tail; capped by the limit, as any export is.
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!)).toEqual({ status: "truncated", rows: 1 });
  });

  it("is a 404 for a saved query the caller cannot see, and for one that does not exist", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await savedQueryOf(owner.token, source);
    for (const target of [id, randomUUID()]) {
      const res = await exportOf(target, stranger.token);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.text).error).toBe("not_found");
    }
  });

  it("lets a recipient with access export it, stamped as theirs", async () => {
    const owner = await user();
    const recipient = await user();
    const id = await savedQueryOf(owner.token, source);
    await shareDirectly(id, { type: "user", id: recipient.id }, owner.id);
    const res = await exportOf(id, recipient.token);
    expect(res.status, res.text).toBe(200);
    await eventually(async () => {
      const got = await savedQueriesCall("GET", `/${id}`, recipient.token);
      return got.body.you_last_ran_at ?? undefined;
    });
    const ownView = await savedQueriesCall("GET", `/${id}`, owner.token);
    expect(ownView.body.you_last_ran_at).toBeNull();
  });
});
