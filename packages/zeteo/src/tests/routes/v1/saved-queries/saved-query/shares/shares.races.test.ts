// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  savedQueriesCall,
  savedQueryOf,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("concurrent PUT /v1/saved-queries/:savedQueryId/shares", () => {
  let source: SeededSource;
  const users: string[] = [];

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedsharesrace");
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("serialises replacements of one list: every one succeeds and the last wins whole", async () => {
    const owner = await userWithOrders(source);
    users.push(owner.id);
    const id = await savedQueryOf(owner.token, source);
    const recipients = Array.from({ length: 6 }, () => newQueryUser());
    // Overlapping lists, so two at once would insert the same share.
    const lists = Array.from({ length: 6 }, (_, i) =>
      recipients.slice(0, i + 1).map((r) => r.principal)
    );
    const results = await Promise.all(
      lists.map((principals) =>
        savedQueriesCall("PUT", `/${id}/shares`, owner.token, { principals })
      )
    );
    expect(results.map((r) => r.status)).toEqual(lists.map(() => 200));
    const final = await savedQueriesCall("GET", `/${id}/shares`, owner.token);
    const ids = final.body.data.map((s: { id: string }) => s.id).sort();
    expect(
      lists.some(
        (l) => JSON.stringify(l.map((p) => p.id).sort()) === JSON.stringify(ids)
      )
    ).toBe(true);
  });
});
