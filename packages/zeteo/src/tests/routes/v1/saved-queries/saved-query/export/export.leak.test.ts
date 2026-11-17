// @module-tag int
// @module-tag platform
import { newExportUser, postExport } from "../../../../../support/exports.js";
import { auditRows, removeSources } from "../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINES } from "../../../../../support/engines.js";
import {
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
  type NoAccessCase,
} from "../../../../../support/savedQueryCauses.js";
import {
  savedQueryOf,
  shareDirectly,
} from "../../../../../support/savedQueries.js";
import {
  grantTo,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

// An export of a saved query the caller cannot run is refused before its
// first byte, the same way for every cause, and before the source's export
// switch is read.

const exportOf = (id: string, token: string) =>
  postExport({
    token,
    body: {},
    search: "format=csv",
    path: `/v1/saved-queries/${id}/export`,
  });

describe("POST /v1/saved-queries/:savedQueryId/export: no access", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  let cases: NoAccessCase[];
  let off: SeededSource;
  const users: string[] = [];

  beforeAll(async () => {
    sources = await seedCauseSources(
      { export_enabled: true, export_row_cap: 1_000_000 },
      "exportleak",
      newExportUser()
    );
    users.push(sources.owner.id);
    cases = await setUpNoAccessCases(sources, sources.owner, newExportUser);
    users.push(...cases.map((c) => c.recipient.id));
    off = await seedQuerySource(ENGINES[0]!, {}, "exportoff");
  });
  afterAll(async () => {
    await removeNoAccessCases(sources, users);
    await removeRunsOf(users);
    await removeSources([off.id]);
  });

  it("is saved_query_not_accessible, not export_not_enabled, on a hidden source with exports off", async () => {
    const owner = newExportUser();
    const recipient = newExportUser();
    users.push(owner.id, recipient.id);
    await grantTo(owner.principal, off.tables.orders!, ["id", "status"]);
    const id = await savedQueryOf(owner.token, off);
    await shareDirectly(id, { type: "user", id: recipient.id }, owner.id);

    // The source does refuse exports: its owner, who can see it, is told so.
    const own = await exportOf(id, owner.token);
    expect(own.status).toBe(403);
    expect(JSON.parse(own.text).error).toBe("export_not_enabled");

    const res = await exportOf(id, recipient.token);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text).error).toBe("saved_query_not_accessible");
    const runs = await runsOf([recipient.id]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      savedQueryId: id,
      sourceId: null,
      entryPoint: "export",
      query: { withheld: true },
      outcome: "refused",
      errorCode: "saved_query_not_accessible",
    });
  });

  it("refuses each of the six causes with the same body, recorded withheld", async () => {
    const bodies: unknown[] = [];
    for (const { cause, recipient, id } of cases) {
      const res = await exportOf(id, recipient.token);
      expect(res.status, cause).toBe(403);
      const { request_id: _r, ...rest } = JSON.parse(res.text);
      expect(rest.error, cause).toBe("saved_query_not_accessible");
      bodies.push(rest);

      const runs = await runsOf([recipient.id]);
      expect(runs, cause).toHaveLength(1);
      expect(runs[0], cause).toMatchObject({
        savedQueryId: id,
        sourceId: null,
        query: { withheld: true },
      });
      const audit = await auditRows(runs[0]!.id);
      expect(audit, cause).toHaveLength(1);
      expect(audit[0]!.payload.metadata, cause).toMatchObject({
        event: "zeteo.export.run",
        saved_query_id: id,
        source_id: null,
      });
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    for (const on of [sources.source, sources.archived, sources.missing]) {
      expect(JSON.stringify(bodies)).not.toContain(on.slug);
    }
  });
});
