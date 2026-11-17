// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  savedQueriesCall,
  savedQueryOf,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  addToDirectory,
  clearDirectory,
} from "../../../../../support/principals.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("saved query share audit entries", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source);
    users.push(u.id);
    return u;
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedsharesaudit");
  });
  afterAll(async () => {
    await clearDirectory();
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("records who was added and who removed, and nothing for no change", async () => {
    const owner = await user();
    const a = await user();
    const b = await user();
    const g = randomUUID();
    await addToDirectory([
      {
        type: "group",
        id: g,
        name: "Audited",
        status: "active",
        organization_id: null,
      },
    ]);
    const id = await savedQueryOf(owner.token, source);
    const put = (principals: unknown[]) =>
      savedQueriesCall("PUT", `/${id}/shares`, owner.token, { principals });

    expect((await put([a.principal, { type: "group", id: g }])).status).toBe(
      200
    );
    expect((await put([b.principal, { type: "group", id: g }])).status).toBe(
      200
    );
    expect((await put([b.principal, { type: "group", id: g }])).status).toBe(
      200
    );

    const rows = (await auditRows(id)).slice(1); // after "created"
    expect(rows).toHaveLength(2);
    const name = rows[0]!.payload.metadata.name;
    expect(rows[0]!.payload).toMatchObject({
      action: "UPDATE",
      entityType: "saved_query",
      userId: owner.id,
      metadata: {
        event: "zeteo.saved_query.shared",
        name,
        source_id: source.id,
        owner_id: owner.id,
        added: [
          { type: "user", id: a.id },
          { type: "group", id: g },
        ],
        removed: [],
      },
    });
    expect(rows[1]!.payload.metadata).toMatchObject({
      event: "zeteo.saved_query.shared",
      added: [{ type: "user", id: b.id }],
      removed: [{ type: "user", id: a.id }],
    });
    expect(JSON.stringify(rows)).not.toContain('"select"');
  });
});
