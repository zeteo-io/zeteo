// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, fetchJson } from "../../../support/http.js";
import { removeSources } from "../../../support/sources.js";
import { tokenFor } from "../../../support/tokens.js";
import { ENGINES } from "../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  SAVED_QUERIES_READ,
  SOURCES_READ,
} from "../../../../definitions/tereoDeclaration.js";
import {
  createSavedQuery,
  ordersQuery,
  savedQueriesCall,
  savedQueryOf,
  shareDirectly,
  uniqueName,
  userWithOrders,
} from "../../../support/savedQueries.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

describe("/v1/saved-queries", () => {
  let source: SeededSource;
  const users: string[] = [];
  const owner = () => userWithOrders(source);

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedroutes");
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  describe("POST", () => {
    it("creates a saved query for the caller", async () => {
      const user = await owner();
      users.push(user.id);
      const query = ordersQuery(source);
      const res = await createSavedQuery(user.token, {
        name: "  Open orders  ",
        description: "Orders by status",
        query,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "Open orders",
        description: "Orders by status",
        owner: { id: user.id },
        accessible: true,
        query,
        source: { id: source.id, slug: source.slug },
        last_run_at: null,
        you_last_ran_at: null,
      });
      expect(res.body).not.toHaveProperty("shared_at");
      expect(typeof res.body.id).toBe("string");
      expect(typeof res.body.created_at).toBe("string");
      expect(typeof res.body.updated_at).toBe("string");
    });

    it("defaults the description to an empty string", async () => {
      const user = await owner();
      const res = await createSavedQuery(user.token, {
        name: uniqueName(),
        query: ordersQuery(source),
      });
      expect(res.status).toBe(201);
      expect(res.body.description).toBe("");
    });

    it("refuses a name an owner already has, whatever its case", async () => {
      const user = await owner();
      const name = uniqueName("Dup");
      expect(
        (
          await createSavedQuery(user.token, {
            name,
            query: ordersQuery(source),
          })
        ).status
      ).toBe(201);
      const again = await createSavedQuery(user.token, {
        name: name.toUpperCase(),
        query: ordersQuery(source),
      });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("conflict");

      const other = await owner();
      expect(
        (
          await createSavedQuery(other.token, {
            name,
            query: ordersQuery(source),
          })
        ).status
      ).toBe(201);
    });

    it("answers a query naming an ungranted column as POST /v1/query does", async () => {
      const user = await userWithOrders(source, ["id"]);
      const query = ordersQuery(source, ["id", "status"]);
      const direct = await postQuery(user.token, query);
      expect(direct.status).toBe(422);
      const res = await createSavedQuery(user.token, {
        name: uniqueName(),
        query,
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("not_found_or_not_accessible");
      expect(res.body.error_description).toBe(direct.body.error_description);
      expect(res.body.path).toEqual(direct.body.path);
    });

    it("answers a source the caller cannot see as POST /v1/query does", async () => {
      const user = newQueryUser();
      const query = ordersQuery(source);
      const direct = await postQuery(user.token, query);
      const res = await createSavedQuery(user.token, {
        name: uniqueName(),
        query,
      });
      expect(res.status).toBe(direct.status);
      expect(res.body.error).toBe(direct.body.error);
    });

    it("stores nothing for a refused create", async () => {
      const user = await userWithOrders(source, ["id"]);
      await createSavedQuery(user.token, {
        name: uniqueName(),
        query: ordersQuery(source),
      });
      const list = await savedQueriesCall("GET", "", user.token);
      expect(list.body.data).toEqual([]);
    });

    it("lets a service account create and list its own", async () => {
      const id = randomUUID();
      const token = tokenFor({
        userId: id,
        client: id,
        permissions: [DATA_READ],
      });
      await grantTo({ type: "user", id }, source.tables.orders!, "all");
      const name = uniqueName("svc");
      const made = await createSavedQuery(token, {
        name,
        query: ordersQuery(source),
      });
      expect(made.status).toBe(201);
      const list = await savedQueriesCall("GET", "", token);
      expect(list.status).toBe(200);
      expect(list.body.data.map((s: { name: string }) => s.name)).toEqual([
        name,
      ]);
    });

    it("needs zeteo.data.read", async () => {
      const res = await createSavedQuery(tokenFor({ permissions: [] }), {
        name: uniqueName(),
        query: ordersQuery(source),
      });
      expect(res.status).toBe(403);
    });

    it("needs a token", async () => {
      const res = await fetchJson(
        "POST",
        `${BASE_URL}/v1/saved-queries`,
        null,
        { name: "x", query: ordersQuery(source) }
      );
      expect(res.status).toBe(401);
    });
  });

  describe("GET", () => {
    it("lists what the caller owns under mine, newest first, and pages", async () => {
      const user = await owner();
      const first = await savedQueryOf(user.token, source);
      const second = await savedQueryOf(user.token, source);
      const third = await savedQueryOf(user.token, source);
      const page = await savedQueriesCall("GET", "?limit=2", user.token);
      expect(page.status).toBe(200);
      expect(page.body.data.map((s: { id: string }) => s.id)).toEqual([
        third,
        second,
      ]);
      expect(typeof page.body.next_cursor).toBe("string");
      const rest = await savedQueriesCall(
        "GET",
        `?scope=mine&limit=2&cursor=${page.body.next_cursor}`,
        user.token
      );
      expect(rest.body.data.map((s: { id: string }) => s.id)).toEqual([first]);
      expect(rest.body.next_cursor).toBeNull();
    });

    it("filters by name with q", async () => {
      const user = await owner();
      await savedQueryOf(user.token, source, { name: "Alpha report" });
      await savedQueryOf(user.token, source, { name: "Beta report" });
      const res = await savedQueriesCall("GET", "?q=alpha", user.token);
      expect(res.body.data.map((s: { name: string }) => s.name)).toEqual([
        "Alpha report",
      ]);
    });

    it("lists what is shared with the caller under shared, never what they own", async () => {
      const sharer = await owner();
      const recipient = await userWithOrders(source);
      users.push(sharer.id, recipient.id);
      const id = await savedQueryOf(sharer.token, source);
      await shareDirectly(id, recipient.principal, sharer.id);
      const own = await savedQueryOf(recipient.token, source);

      const shared = await savedQueriesCall(
        "GET",
        "?scope=shared",
        recipient.token
      );
      expect(shared.status).toBe(200);
      expect(shared.body.data).toHaveLength(1);
      expect(shared.body.data[0]).toMatchObject({
        id,
        accessible: true,
        owner: { id: sharer.id },
      });
      expect(typeof shared.body.data[0].shared_at).toBe("string");

      const mine = await savedQueriesCall("GET", "", recipient.token);
      expect(mine.body.data.map((s: { id: string }) => s.id)).toEqual([own]);
      expect(mine.body.data[0]).not.toHaveProperty("shared_at");
    });

    it("withholds the query and source of a saved query the viewer cannot run", async () => {
      const sharer = await owner();
      const recipient = await userWithOrders(source, ["id"]);
      const id = await savedQueryOf(sharer.token, source);
      await shareDirectly(id, recipient.principal, sharer.id);
      const res = await savedQueriesCall(
        "GET",
        "?scope=shared",
        recipient.token
      );
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].accessible).toBe(false);
      expect(res.body.data[0]).not.toHaveProperty("query");
      expect(res.body.data[0]).not.toHaveProperty("source");
    });

    it("refuses scope=all without zeteo.saved_queries.read", async () => {
      const user = await owner();
      const res = await savedQueriesCall("GET", "?scope=all", user.token);
      expect(res.status).toBe(403);
    });

    it("lists every saved query under all for zeteo.saved_queries.read", async () => {
      const user = await owner();
      const id = await savedQueryOf(user.token, source);
      const admin = tokenFor({ permissions: [DATA_READ, SAVED_QUERIES_READ] });
      const res = await savedQueriesCall(
        "GET",
        `?scope=all&owner_id=${user.id}`,
        admin
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([id]);
      // The admin holds no grants and no sources.read: nothing of the source.
      expect(res.body.data[0].accessible).toBe(false);
      expect(res.body.data[0]).not.toHaveProperty("query");
      expect(res.body.data[0]).not.toHaveProperty("source");
    });

    it("filters all by source for a caller who reads sources, and refuses it otherwise", async () => {
      const user = await owner();
      const id = await savedQueryOf(user.token, source);
      const reader = tokenFor({
        permissions: [DATA_READ, SAVED_QUERIES_READ, SOURCES_READ],
      });
      const res = await savedQueriesCall(
        "GET",
        `?scope=all&source_id=${source.id}&owner_id=${user.id}`,
        reader
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id,
        source: { id: source.id, slug: source.slug },
      });
      expect(res.body.data[0]).not.toHaveProperty("query");

      const noSources = tokenFor({
        permissions: [DATA_READ, SAVED_QUERIES_READ],
      });
      const refused = await savedQueriesCall(
        "GET",
        `?scope=all&source_id=${source.id}`,
        noSources
      );
      expect(refused.status).toBe(403);
    });

    it("refuses source_id and owner_id outside scope=all", async () => {
      const user = await owner();
      const res = await savedQueriesCall(
        "GET",
        `?source_id=${source.id}`,
        user.token
      );
      expect(res.status).toBe(400);
      const res2 = await savedQueriesCall(
        "GET",
        `?scope=shared&owner_id=${user.id}`,
        user.token
      );
      expect(res2.status).toBe(400);
    });

    it("refuses an unknown scope", async () => {
      const user = await owner();
      const res = await savedQueriesCall(
        "GET",
        "?scope=everything",
        user.token
      );
      expect(res.status).toBe(400);
    });
  });
});
