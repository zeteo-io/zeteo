// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenFor } from "../../../../../support/tokens.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  SAVED_QUERIES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  savedQueriesCall,
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("saved query transfer audit entries", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source);
    users.push(u.id);
    return u;
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedtransferaudit");
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("records from, to and keep_access, under the new owner", async () => {
    const owner = await user();
    const next = await user();
    const name = uniqueName("handed");
    const id = await savedQueryOf(owner.token, source, { name });
    const res = await savedQueriesCall("POST", `/${id}/transfer`, owner.token, {
      user_id: next.id,
    });
    expect(res.status).toBe(200);
    const rows = await auditRows(id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.payload).toMatchObject({
      action: "UPDATE",
      entityType: "saved_query",
      userId: owner.id,
      metadata: {
        event: "zeteo.saved_query.transferred",
        name,
        source_id: source.id,
        owner_id: next.id,
        from: owner.id,
        to: next.id,
        keep_access: true,
      },
    });
    expect(JSON.stringify(rows)).not.toContain('"select"');
  });

  it("records an admin's transfer with keep_access false, the admin as actor", async () => {
    const owner = await user();
    const next = await user();
    const id = await savedQueryOf(owner.token, source);
    const adminId = randomUUID();
    const admin = tokenFor({
      userId: adminId,
      permissions: [DATA_READ, SAVED_QUERIES_WRITE],
    });
    const res = await savedQueriesCall("POST", `/${id}/transfer`, admin, {
      user_id: next.id,
      keep_access: false,
    });
    expect(res.status).toBe(200);
    const rows = await auditRows(id);
    expect(rows.at(-1)!.payload).toMatchObject({
      userId: adminId,
      metadata: {
        event: "zeteo.saved_query.transferred",
        from: owner.id,
        to: next.id,
        keep_access: false,
      },
    });
  });

  it("records nothing for a refused transfer", async () => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source);
    const res = await savedQueriesCall("POST", `/${id}/transfer`, owner.token, {
      user_id: owner.id,
    });
    expect(res.status).toBe(400);
    expect(await auditRows(id)).toHaveLength(1);
  });
});
