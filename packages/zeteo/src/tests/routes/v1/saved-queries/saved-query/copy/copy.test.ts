// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  ordersQuery,
  savedQueriesCall,
  savedQueryOf,
  shareDirectly,
  uniqueName,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/saved-queries/:savedQueryId/copy", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async (columns: string[] | "all" = ["id", "status"]) => {
    const u = await userWithOrders(source, columns);
    users.push(u.id);
    return u;
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedcopy");
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("copies a saved query a recipient can run, owned by the caller", async () => {
    const sharer = await user();
    const recipient = await user();
    const id = await savedQueryOf(sharer.token, source, {
      description: "kept",
    });
    await shareDirectly(id, recipient.principal, sharer.id);
    const name = uniqueName("copy");
    const res = await savedQueriesCall("POST", `/${id}/copy`, recipient.token, {
      name,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name,
      description: "kept",
      owner: { id: recipient.id },
      accessible: true,
      query: ordersQuery(source),
      source: { id: source.id, slug: source.slug },
    });
    expect(res.body.id).not.toBe(id);
    expect(res.body).not.toHaveProperty("shared_at");
    const original = await savedQueriesCall("GET", `/${id}`, sharer.token);
    expect(original.body.owner.id).toBe(sharer.id);
  });

  it("lets an owner copy their own saved query", async () => {
    const me = await user();
    const id = await savedQueryOf(me.token, source);
    const res = await savedQueriesCall("POST", `/${id}/copy`, me.token, {
      name: uniqueName("mine"),
    });
    expect(res.status).toBe(201);
  });

  it("refuses a recipient without access with saved_query_not_accessible", async () => {
    const sharer = await user();
    const recipient = await user(["id"]);
    const id = await savedQueryOf(sharer.token, source);
    await shareDirectly(id, recipient.principal, sharer.id);
    const res = await savedQueriesCall("POST", `/${id}/copy`, recipient.token, {
      name: uniqueName(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("saved_query_not_accessible");
    expect(res.body).not.toHaveProperty("path");
    const list = await savedQueriesCall("GET", "", recipient.token);
    expect(list.body.data).toEqual([]);
  });

  it("is a 404 for a saved query that is not shared with the caller", async () => {
    const sharer = await user();
    const stranger = await user();
    const id = await savedQueryOf(sharer.token, source);
    const res = await savedQueriesCall("POST", `/${id}/copy`, stranger.token, {
      name: uniqueName(),
    });
    expect(res.status).toBe(404);
  });

  it("refuses a name the caller already has", async () => {
    const me = await user();
    const name = uniqueName("same");
    const id = await savedQueryOf(me.token, source, { name });
    const res = await savedQueriesCall("POST", `/${id}/copy`, me.token, {
      name: name.toLowerCase(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
  });

  it("needs a name", async () => {
    const me = await user();
    const id = await savedQueryOf(me.token, source);
    const res = await savedQueriesCall("POST", `/${id}/copy`, me.token, {});
    expect(res.status).toBe(400);
  });
});
