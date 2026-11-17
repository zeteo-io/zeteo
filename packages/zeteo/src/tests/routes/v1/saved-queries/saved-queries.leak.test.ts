// @module-tag int
// @module-tag platform
import { savedQueriesCall } from "../../../support/savedQueries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
} from "../../../support/savedQueryCauses.js";

// A recipient who cannot run a saved query learns nothing of why: for each of
// the six causes the list entry and the GET answer are the same, but for the
// ids, the name and the timestamps.

const stripped = (body: Record<string, unknown>) => {
  const {
    id: _id,
    name: _name,
    created_at: _c,
    updated_at: _u,
    shared_at: _s,
    last_run_at: _l,
    you_last_ran_at: _y,
    request_id: _r,
    ...rest
  } = body;
  return rest;
};

describe("saved queries: six causes of no access look the same", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  const users: string[] = [];

  beforeAll(async () => {
    sources = await seedCauseSources({}, "leak");
    users.push(sources.owner.id);
  });
  afterAll(async () => {
    await removeNoAccessCases(sources, users);
  });

  it("answers list and get with the same body for each cause", async () => {
    const cases = await setUpNoAccessCases(sources, sources.owner);
    const seen: Array<{ cause: string; list: unknown; get: unknown }> = [];
    for (const { cause, recipient, id } of cases) {
      users.push(recipient.id);
      const list = await savedQueriesCall(
        "GET",
        "?scope=shared",
        recipient.token
      );
      const get = await savedQueriesCall("GET", `/${id}`, recipient.token);
      expect(list.status, cause).toBe(200);
      expect(get.status, cause).toBe(200);
      const entry = list.body.data.find((s: { id: string }) => s.id === id);
      expect(entry.accessible, cause).toBe(false);
      for (const body of [entry, get.body]) {
        expect(body, cause).not.toHaveProperty("query");
        expect(body, cause).not.toHaveProperty("source");
      }
      seen.push({ cause, list: stripped(entry), get: stripped(get.body) });
    }

    expect(seen).toHaveLength(6);
    for (const s of seen) {
      expect(s.list, s.cause).toEqual(seen[0]!.list);
      expect(s.get, s.cause).toEqual(seen[0]!.get);
    }
    // The list entry and the single answer differ in nothing either.
    expect(seen[0]!.list).toEqual(seen[0]!.get);
    for (const on of [sources.source, sources.archived, sources.missing]) {
      expect(JSON.stringify(seen)).not.toContain(on.slug);
    }
  });
});
