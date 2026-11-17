// @module-tag int
// @module-tag platform
import { savedQueriesCall } from "../../../../../support/savedQueries.js";
import { BASE_URL, fetchJson } from "../../../../../support/http.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditRows } from "../../../../../support/sources.js";
import { runsOf } from "../../../../../support/queries.js";
import {
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
  type NoAccessCase,
} from "../../../../../support/savedQueryCauses.js";

// A recipient who cannot run a saved query is refused the same way for each
// of the six causes, and the run recorded for them holds nothing of the query.

describe("POST /v1/saved-queries/:savedQueryId/run: six causes of no access", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  let cases: NoAccessCase[];
  const users: string[] = [];

  beforeAll(async () => {
    sources = await seedCauseSources({}, "runleak");
    users.push(sources.owner.id);
    cases = await setUpNoAccessCases(sources, sources.owner);
    users.push(...cases.map((c) => c.recipient.id));
  });
  afterAll(async () => {
    await removeNoAccessCases(sources, users);
  });

  it("refuses each with the same 403 body, and records it withheld", async () => {
    const bodies: unknown[] = [];
    for (const { cause, recipient, id } of cases) {
      const res = await savedQueriesCall(
        "POST",
        `/${id}/run`,
        recipient.token,
        {}
      );
      expect(res.status, cause).toBe(403);
      expect(res.body.error, cause).toBe("saved_query_not_accessible");
      const { request_id: _r, ...rest } = res.body;
      bodies.push(rest);

      const runs = await runsOf([recipient.id]);
      expect(runs, cause).toHaveLength(1);
      expect(runs[0], cause).toMatchObject({
        savedQueryId: id,
        sourceId: null,
        query: { withheld: true },
        outcome: "refused",
        errorCode: "saved_query_not_accessible",
      });
      const audit = await auditRows(runs[0]!.id);
      expect(audit, cause).toHaveLength(1);
      expect(audit[0]!.payload.metadata, cause).toMatchObject({
        event: "zeteo.query.run",
        saved_query_id: id,
        source_id: null,
        outcome: "refused",
        error_code: "saved_query_not_accessible",
      });
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    for (const on of [sources.source, sources.archived, sources.missing]) {
      expect(JSON.stringify(bodies)).not.toContain(on.slug);
      expect(JSON.stringify(bodies)).not.toContain(on.id);
    }
  });

  it("shows the refused run in GET /v1/me/runs as { withheld: true } with source_id null", async () => {
    for (const { cause, recipient, id } of cases) {
      const res = await fetchJson(
        "GET",
        `${BASE_URL}/v1/me/runs`,
        recipient.token
      );
      expect(res.status, cause).toBe(200);
      const [run] = res.body.data as Array<Record<string, unknown>>;
      expect(run, cause).toMatchObject({
        user_id: recipient.id,
        source_id: null,
        query: { withheld: true },
        outcome: "refused",
        error_code: "saved_query_not_accessible",
      });
      expect(JSON.stringify(res.body), cause).not.toMatch(/"orders"|customers/);
      // Shared with them still, so the saved query's name is attached.
      expect(run!.saved_query, cause).toMatchObject({ id });
    }
  });
});
