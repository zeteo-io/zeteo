// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../support/sources.js";
import { tokenFor } from "../../../../support/tokens.js";
import { ENGINES } from "../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  SAVED_QUERIES_WRITE,
  SOURCES_READ,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  ordersQuery,
  savedQueriesCall,
  savedQueryOf,
  shareDirectly,
  uniqueName,
  userWithOrders,
} from "../../../../support/savedQueries.js";
import {
  grantTo,
  removeGrant,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../support/queries.js";

describe("/v1/saved-queries/:savedQueryId", () => {
  let source: SeededSource;
  let other: SeededSource;
  const users: string[] = [];
  const owner = async () => {
    const user = await userWithOrders(source);
    users.push(user.id);
    return user;
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedone");
    other = await seedQuerySource(ENGINES[0]!, {}, "savedtwo");
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id, other.id]);
  });

  describe("GET", () => {
    it("gives the owner the saved query, query and source included", async () => {
      const user = await owner();
      const id = await savedQueryOf(user.token, source, { description: "d" });
      const res = await savedQueriesCall("GET", `/${id}`, user.token);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id,
        description: "d",
        accessible: true,
        query: ordersQuery(source),
        source: { id: source.id, slug: source.slug },
      });
    });

    it("is a 404 for a user it is not shared with, and for one that does not exist", async () => {
      const user = await owner();
      const stranger = await owner();
      const id = await savedQueryOf(user.token, source);
      const res = await savedQueriesCall("GET", `/${id}`, stranger.token);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
      const missing = await savedQueriesCall(
        "GET",
        `/${randomUUID()}`,
        stranger.token
      );
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe("not_found");
    });

    it("gives a recipient with access the query", async () => {
      const user = await owner();
      const recipient = await owner();
      const id = await savedQueryOf(user.token, source);
      await shareDirectly(id, recipient.principal, user.id);
      const res = await savedQueriesCall("GET", `/${id}`, recipient.token);
      expect(res.status).toBe(200);
      expect(res.body.accessible).toBe(true);
      expect(res.body.query).toEqual(ordersQuery(source));
      expect(typeof res.body.shared_at).toBe("string");
    });

    it("gives a recipient without access a 200 with no query and no source", async () => {
      const user = await owner();
      const recipient = await userWithOrders(source, ["id"]);
      const id = await savedQueryOf(user.token, source);
      await shareDirectly(id, recipient.principal, user.id);
      const res = await savedQueriesCall("GET", `/${id}`, recipient.token);
      expect(res.status).toBe(200);
      expect(res.body.accessible).toBe(false);
      expect(res.body).not.toHaveProperty("query");
      expect(res.body).not.toHaveProperty("source");
      expect(JSON.stringify(res.body)).not.toContain(source.slug);
    });

    it("lets zeteo.saved_queries.read see any saved query, with the source only for zeteo.sources.read", async () => {
      const user = await owner();
      const id = await savedQueryOf(user.token, source);
      const reader = tokenFor({
        permissions: [DATA_READ, SAVED_QUERIES_WRITE],
      });
      const plain = await savedQueriesCall("GET", `/${id}`, reader);
      expect(plain.status).toBe(200);
      expect(plain.body.accessible).toBe(false);
      expect(plain.body).not.toHaveProperty("query");
      expect(plain.body).not.toHaveProperty("source");

      const withSources = tokenFor({
        permissions: [DATA_READ, SAVED_QUERIES_WRITE, SOURCES_READ],
      });
      const full = await savedQueriesCall("GET", `/${id}`, withSources);
      expect(full.body.source).toEqual({ id: source.id, slug: source.slug });
      expect(full.body).not.toHaveProperty("query");
    });

    it("is a 404 for an id that is not an id", async () => {
      const user = await owner();
      const res = await savedQueriesCall("GET", "/nope", user.token);
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH", () => {
    it("changes the name and description", async () => {
      const user = await owner();
      const id = await savedQueryOf(user.token, source);
      const name = uniqueName("renamed");
      const res = await savedQueriesCall("PATCH", `/${id}`, user.token, {
        name,
        description: "new",
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, name, description: "new" });
    });

    it("re-plans a changed query and moves the saved query to its source", async () => {
      const user = await owner();
      await grantTo(user.principal, other.tables.orders!, "all");
      const id = await savedQueryOf(user.token, source);
      const query = ordersQuery(other, ["id"]);
      const res = await savedQueriesCall("PATCH", `/${id}`, user.token, {
        query,
      });
      expect(res.status).toBe(200);
      expect(res.body.query).toEqual(query);
      expect(res.body.source).toEqual({ id: other.id, slug: other.slug });
    });

    it("refuses a changed query the owner cannot run, and changes nothing", async () => {
      const user = await owner();
      const id = await savedQueryOf(user.token, source);
      const res = await savedQueriesCall("PATCH", `/${id}`, user.token, {
        query: ordersQuery(source, ["id", "total"]),
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("not_found_or_not_accessible");
      const after = await savedQueriesCall("GET", `/${id}`, user.token);
      expect(after.body.query).toEqual(ordersQuery(source));
    });

    it("refuses a name the owner already has", async () => {
      const user = await owner();
      const taken = uniqueName("taken");
      await savedQueryOf(user.token, source, { name: taken });
      const id = await savedQueryOf(user.token, source);
      const res = await savedQueriesCall("PATCH", `/${id}`, user.token, {
        name: taken.toUpperCase(),
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("conflict");
    });

    it("is a 404 for a recipient and for an admin who is not the owner", async () => {
      const user = await owner();
      const recipient = await owner();
      const id = await savedQueryOf(user.token, source);
      await shareDirectly(id, recipient.principal, user.id);
      const body = { name: uniqueName() };
      expect(
        (await savedQueriesCall("PATCH", `/${id}`, recipient.token, body))
          .status
      ).toBe(404);
      const admin = tokenFor({ permissions: [DATA_READ, SAVED_QUERIES_WRITE] });
      expect(
        (await savedQueriesCall("PATCH", `/${id}`, admin, body)).status
      ).toBe(404);
    });

    it("lets an owner who has lost access rename it and still see it under mine without its query", async () => {
      const user = await owner();
      const grant = await grantTo(user.principal, other.tables.orders!, ["id"]);
      const id = await savedQueryOf(user.token, other, {
        query: ordersQuery(other, ["id"]),
      });
      await removeGrant(grant);
      const name = uniqueName("still mine");
      const res = await savedQueriesCall("PATCH", `/${id}`, user.token, {
        name,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, name, accessible: false });
      expect(res.body).not.toHaveProperty("query");
      expect(res.body).not.toHaveProperty("source");

      const mine = await savedQueriesCall("GET", "", user.token);
      const row = mine.body.data.find((s: { id: string }) => s.id === id);
      expect(row.accessible).toBe(false);
      expect(row).not.toHaveProperty("query");
      expect(row).not.toHaveProperty("source");
    });

    it("refuses an empty change and an unknown key", async () => {
      const user = await owner();
      const id = await savedQueryOf(user.token, source);
      expect(
        (await savedQueriesCall("PATCH", `/${id}`, user.token, {})).status
      ).toBe(400);
      expect(
        (
          await savedQueriesCall("PATCH", `/${id}`, user.token, {
            owner_id: id,
          })
        ).status
      ).toBe(400);
    });
  });

  describe("DELETE", () => {
    it("deletes the owner's saved query", async () => {
      const user = await owner();
      const id = await savedQueryOf(user.token, source);
      const res = await savedQueriesCall("DELETE", `/${id}`, user.token);
      expect(res.status).toBe(204);
      expect((await savedQueriesCall("GET", `/${id}`, user.token)).status).toBe(
        404
      );
      expect(
        (await savedQueriesCall("DELETE", `/${id}`, user.token)).status
      ).toBe(404);
    });

    it("lets an owner who has lost access delete it", async () => {
      const user = await owner();
      const grant = await grantTo(user.principal, other.tables.orders!, ["id"]);
      const id = await savedQueryOf(user.token, other, {
        query: ordersQuery(other, ["id"]),
      });
      await removeGrant(grant);
      expect(
        (await savedQueriesCall("DELETE", `/${id}`, user.token)).status
      ).toBe(204);
    });

    it("lets zeteo.saved_queries.write delete another user's, and not a recipient", async () => {
      const user = await owner();
      const recipient = await owner();
      const id = await savedQueryOf(user.token, source);
      await shareDirectly(id, recipient.principal, user.id);
      expect(
        (await savedQueriesCall("DELETE", `/${id}`, recipient.token)).status
      ).toBe(404);
      const admin = tokenFor({ permissions: [DATA_READ, SAVED_QUERIES_WRITE] });
      expect((await savedQueriesCall("DELETE", `/${id}`, admin)).status).toBe(
        204
      );
      expect((await savedQueriesCall("GET", `/${id}`, user.token)).status).toBe(
        404
      );
    });
  });
});
