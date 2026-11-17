// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { eventually } from "../../../../../support/exports.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  ordersQuery,
  savedQueriesCall,
  savedQueryOf,
  shareDirectly,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/saved-queries/:savedQueryId/run", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const made = await userWithOrders(source);
    users.push(made.id);
    return made;
  };
  const run = (id: string, token: string, body: unknown = {}) =>
    savedQueriesCall("POST", `/${id}/run`, token, body);
  const get = async (id: string, token: string) => {
    const res = await savedQueriesCall("GET", `/${id}`, token);
    expect(res.status).toBe(200);
    return res.body as {
      last_run_at: string | null;
      you_last_ran_at: string | null;
    };
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedrun");
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("runs the owner's saved query, records it against the saved query and stamps it", async () => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source);
    const res = await run(id, owner.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
      "id",
      "status",
    ]);
    expect(res.body.rows.length).toBeGreaterThan(1);

    const runs = await runsOf([owner.id]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: res.body.run_id,
      savedQueryId: id,
      sourceId: source.id,
      outcome: "ok",
      query: ordersQuery(source),
    });

    const seen = await eventually(async () => {
      const body = await get(id, owner.token);
      return body.last_run_at && body.you_last_ran_at ? body : undefined;
    });
    expect(seen.you_last_ran_at).toBe(seen.last_run_at);
  });

  it("stamps a recipient's run as theirs, not the owner's", async () => {
    const owner = await user();
    const recipient = await user();
    const id = await savedQueryOf(owner.token, source);
    await shareDirectly(id, { type: "user", id: recipient.id }, owner.id);
    const res = await run(id, recipient.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const theirs = await eventually(async () => {
      const body = await get(id, recipient.token);
      return body.you_last_ran_at ? body : undefined;
    });
    expect(theirs.last_run_at).not.toBeNull();
    const ownView = await get(id, owner.token);
    expect(ownView.last_run_at).toBe(theirs.last_run_at);
    expect(ownView.you_last_ran_at).toBeNull();
    expect((await runsOf([recipient.id]))[0]?.savedQueryId).toBe(id);
  });

  it("overrides the stored limit and offset with those given", async () => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source, {
      query: { ...ordersQuery(source), orderBy: [{ id: "asc" }] },
    });
    const one = await run(id, owner.token, { limit: 1 });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.rows).toHaveLength(1);
    const next = await run(id, owner.token, { limit: 1, offset: 1 });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.rows).toHaveLength(1);
    expect(next.body.rows[0][0]).not.toEqual(one.body.rows[0][0]);
    const runs = await runsOf([owner.id]);
    expect(runs.map((r) => r.query)).toEqual([
      { ...ordersQuery(source), orderBy: [{ id: "asc" }], limit: 1 },
      { ...ordersQuery(source), orderBy: [{ id: "asc" }], limit: 1, offset: 1 },
    ]);
  });

  it("refuses a body with anything but limit and offset", async () => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source);
    for (const body of [{ limit: 0 }, { offset: -1 }, { from: "orders" }]) {
      const res = await run(id, owner.token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await runsOf([owner.id])).toHaveLength(0);
  });

  it("leaves both stamps alone for an ad-hoc query of the same JSON", async () => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source);
    const res = await postQuery(owner.token, ordersQuery(source));
    expect(res.status).toBe(200);
    const runs = await runsOf([owner.id]);
    expect(runs[0]?.savedQueryId).toBeNull();
    // A stamp is written after the response; give one the time it would take.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await get(id, owner.token)).toMatchObject({
      last_run_at: null,
      you_last_ran_at: null,
    });
  });

  it("is a 404 for a saved query the caller cannot see, and for one that does not exist", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await savedQueryOf(owner.token, source);
    for (const target of [id, randomUUID()]) {
      const res = await run(target, stranger.token);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    }
    expect(await runsOf([stranger.id])).toHaveLength(0);
  });
});
