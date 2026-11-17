// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINES } from "../../../support/engines.js";
import {
  createSavedQuery,
  ordersQuery,
  savedQueriesCall,
  shareDirectly,
  uniqueName,
  userWithOrders,
} from "../../../support/savedQueries.js";
import {
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

describe("saved query audit entries", () => {
  let source: SeededSource;

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedaudit");
  });
  afterAll(() => removeSources([source.id]));

  it("records created, updated and deleted, with ids and names and never the query", async () => {
    const user = await userWithOrders(source);
    const name = uniqueName("audited");
    const made = await createSavedQuery(user.token, {
      name,
      description: "secret description",
      query: ordersQuery(source),
    });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    expect((await auditRows(id)).map((r) => r.payload)).toEqual([
      expect.objectContaining({
        action: "CREATE",
        entityType: "saved_query",
        metadata: {
          event: "zeteo.saved_query.created",
          name,
          source_id: source.id,
          owner_id: user.id,
        },
      }),
    ]);

    const renamed = uniqueName("renamed");
    await savedQueriesCall("PATCH", `/${id}`, user.token, {
      name: renamed,
      query: ordersQuery(source, ["id"]),
    });
    const afterUpdate = await auditRows(id);
    expect(afterUpdate).toHaveLength(2);
    expect(afterUpdate[1]!.payload).toMatchObject({
      action: "UPDATE",
      entityType: "saved_query",
      metadata: {
        event: "zeteo.saved_query.updated",
        name: renamed,
        previous_name: name,
        source_id: source.id,
        owner_id: user.id,
        changed: ["name", "query"],
      },
    });

    await savedQueriesCall("DELETE", `/${id}`, user.token);
    const afterDelete = await auditRows(id);
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete[2]!.payload).toMatchObject({
      action: "DELETE",
      entityType: "saved_query",
      metadata: {
        event: "zeteo.saved_query.deleted",
        name: renamed,
        source_id: source.id,
        owner_id: user.id,
      },
    });

    const all = JSON.stringify(afterDelete);
    expect(all).not.toContain('"select"');
    expect(all).not.toContain('"from"');
    expect(all).not.toContain("secret description");
  });

  it("records a copy against the new saved query, naming the one it came from", async () => {
    const sharer = await userWithOrders(source);
    const recipient = await userWithOrders(source);
    const made = await createSavedQuery(sharer.token, {
      name: uniqueName(),
      query: ordersQuery(source),
    });
    await shareDirectly(made.body.id, recipient.principal, sharer.id);
    const name = uniqueName("copied");
    const copy = await savedQueriesCall(
      "POST",
      `/${made.body.id}/copy`,
      recipient.token,
      { name }
    );
    expect(copy.status).toBe(201);
    const rows = await auditRows(copy.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      action: "CREATE",
      entityType: "saved_query",
      metadata: {
        event: "zeteo.saved_query.copied",
        name,
        source_id: source.id,
        owner_id: recipient.id,
        copied_from: made.body.id,
      },
    });
    expect(JSON.stringify(rows)).not.toContain('"select"');
  });

  it("records nothing for a refused create, update or delete", async () => {
    const user = await userWithOrders(source, ["id"]);
    const stranger = await userWithOrders(source);
    const refused = await createSavedQuery(user.token, {
      name: uniqueName(),
      query: ordersQuery(source),
    });
    expect(refused.status).toBe(422);

    const mine = await userWithOrders(source);
    const made = await createSavedQuery(mine.token, {
      name: uniqueName(),
      query: ordersQuery(source),
    });
    const id = made.body.id as string;
    await savedQueriesCall("PATCH", `/${id}`, stranger.token, { name: "x" });
    await savedQueriesCall("DELETE", `/${id}`, stranger.token);
    await savedQueriesCall("PATCH", `/${id}`, mine.token, {
      query: ordersQuery(source, ["id", "total"]),
    });
    expect(await auditRows(id)).toHaveLength(1);
  });
});
