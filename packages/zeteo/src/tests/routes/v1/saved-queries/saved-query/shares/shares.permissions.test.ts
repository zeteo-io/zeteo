// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  DATA_READ,
  SAVED_QUERIES_READ,
  SAVED_QUERIES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  savedQueriesCall,
  savedQueryOf,
  shareDirectly,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("/v1/saved-queries/:savedQueryId/shares permissions", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source);
    users.push(u.id);
    return u;
  };
  /** A saved query of a new owner, shared with a new recipient. */
  const shared = async () => {
    const owner = await user();
    const recipient = await user();
    const id = await savedQueryOf(owner.token, source);
    await shareDirectly(id, recipient.principal, owner.id);
    return { owner, recipient, id };
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedsharesperm");
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("is a 404 to a recipient, for reading and replacing alike", async () => {
    const { recipient, id } = await shared();
    const get = await savedQueriesCall("GET", `/${id}/shares`, recipient.token);
    expect(get.status).toBe(404);
    const put = await savedQueriesCall(
      "PUT",
      `/${id}/shares`,
      recipient.token,
      {
        principals: [],
      }
    );
    expect(put.status).toBe(404);
    // Nothing changed.
    const seen = await savedQueriesCall("GET", `/${id}`, recipient.token);
    expect(seen.status).toBe(200);
  });

  it("is a 404 to anyone else", async () => {
    const { id } = await shared();
    const stranger = await user();
    expect(
      (await savedQueriesCall("GET", `/${id}/shares`, stranger.token)).status
    ).toBe(404);
  });

  it("lets an admin with zeteo.saved_queries.write read and replace", async () => {
    const { recipient, id } = await shared();
    const admin = tokenFor({ permissions: [DATA_READ, SAVED_QUERIES_WRITE] });
    const get = await savedQueriesCall("GET", `/${id}/shares`, admin);
    expect(get.status).toBe(200);
    expect(get.body.data.map((s: { id: string }) => s.id)).toEqual([
      recipient.id,
    ]);
    const put = await savedQueriesCall("PUT", `/${id}/shares`, admin, {
      principals: [],
    });
    expect(put.status).toBe(200);
    expect(
      (await savedQueriesCall("GET", `/${id}`, recipient.token)).status
    ).toBe(404);
  });

  it("lets an admin with zeteo.saved_queries.read read but not replace", async () => {
    const { id } = await shared();
    const reader = tokenFor({ permissions: [DATA_READ, SAVED_QUERIES_READ] });
    expect(
      (await savedQueriesCall("GET", `/${id}/shares`, reader)).status
    ).toBe(200);
    const put = await savedQueriesCall("PUT", `/${id}/shares`, reader, {
      principals: [],
    });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe("forbidden");
  });

  it("needs zeteo.data.read", async () => {
    const { id } = await shared();
    const none = tokenFor({ permissions: [SAVED_QUERIES_WRITE] });
    expect((await savedQueriesCall("GET", `/${id}/shares`, none)).status).toBe(
      403
    );
  });
});
