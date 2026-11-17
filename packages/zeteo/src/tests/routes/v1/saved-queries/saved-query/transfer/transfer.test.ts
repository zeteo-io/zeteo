// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  SAVED_QUERIES_READ,
  SAVED_QUERIES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  savedQueriesCall,
  savedQueryOf,
  shareDirectly,
  uniqueName,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  addToDirectory,
  addUserToDirectory,
  clearDirectory,
  markOrphaned,
  clearOrphaned,
} from "../../../../../support/principals.js";
import {
  grantTo,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/saved-queries/:savedQueryId/transfer", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async (columns: string[] | "all" = ["id", "status"]) => {
    const u = await userWithOrders(source, columns);
    users.push(u.id);
    await addUserToDirectory(u.id);
    return u;
  };
  const transfer = (id: string, token: string, body: unknown) =>
    savedQueriesCall("POST", `/${id}/transfer`, token, body);
  const ids = (res: { body: { data: Array<{ id: string }> } }) =>
    res.body.data.map((s) => s.id);

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedtransfer");
  });
  afterAll(async () => {
    await clearDirectory();
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("hands it to the new owner; the old one keeps it as shared", async () => {
    const owner = await user();
    const next = await user();
    const id = await savedQueryOf(owner.token, source);
    const res = await transfer(id, owner.token, { user_id: next.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, owner: { id: next.id } });
    expect(res.body).not.toHaveProperty("warning");
    expect(ids(await savedQueriesCall("GET", "", next.token))).toEqual([id]);
    expect(ids(await savedQueriesCall("GET", "", owner.token))).toEqual([]);
    expect(
      ids(await savedQueriesCall("GET", "?scope=shared", owner.token))
    ).toEqual([id]);
    // The new owner manages it now; the old one cannot.
    expect(
      (await savedQueriesCall("GET", `/${id}/shares`, next.token)).body.data
    ).toEqual([expect.objectContaining({ type: "user", id: owner.id })]);
    expect(
      (await savedQueriesCall("GET", `/${id}/shares`, owner.token)).status
    ).toBe(404);
  });

  it("with keep_access false, leaves the old owner nothing", async () => {
    const owner = await user();
    const next = await user();
    const id = await savedQueryOf(owner.token, source);
    const res = await transfer(id, owner.token, {
      user_id: next.id,
      keep_access: false,
    });
    expect(res.status).toBe(200);
    expect((await savedQueriesCall("GET", `/${id}`, owner.token)).status).toBe(
      404
    );
  });

  it("removes the new owner's own direct share", async () => {
    const owner = await user();
    const next = await user();
    const id = await savedQueryOf(owner.token, source);
    await shareDirectly(id, next.principal, owner.id);
    expect((await transfer(id, owner.token, { user_id: next.id })).status).toBe(
      200
    );
    const shares = await savedQueriesCall("GET", `/${id}/shares`, next.token);
    expect(shares.body.data.map((s: { id: string }) => s.id)).toEqual([
      owner.id,
    ]);
  });

  it("refuses a service account as the new owner", async () => {
    const owner = await user();
    const service = randomUUID();
    await addToDirectory([
      {
        type: "user",
        id: service,
        name: "Nightly job",
        email: "job@example.com",
        status: "active",
        user_type: "service_account",
      },
    ]);
    const id = await savedQueryOf(owner.token, source);
    const res = await transfer(id, owner.token, { user_id: service });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_transfer");
    const still = await savedQueriesCall("GET", `/${id}`, owner.token);
    expect(still.body.owner.id).toBe(owner.id);
  });

  it("refuses a user the directory does not have, or has as orphaned", async () => {
    const owner = await user();
    const orphan = await user();
    await markOrphaned(orphan.id);
    try {
      const id = await savedQueryOf(owner.token, source);
      for (const target of [randomUUID(), orphan.id]) {
        const res = await transfer(id, owner.token, { user_id: target });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_transfer");
      }
      const still = await savedQueriesCall("GET", `/${id}`, owner.token);
      expect(still.body.owner.id).toBe(owner.id);
    } finally {
      await clearOrphaned(orphan.id);
    }
  });

  it("refuses the current owner as the new owner", async () => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source);
    const res = await transfer(id, owner.token, { user_id: owner.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_transfer");
  });

  it("refuses a name the new owner already has, whatever its case", async () => {
    const owner = await user();
    const next = await user();
    const name = uniqueName("clash");
    const id = await savedQueryOf(owner.token, source, { name });
    await savedQueryOf(next.token, source, { name: name.toUpperCase() });
    const res = await transfer(id, owner.token, { user_id: next.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
    const still = await savedQueriesCall("GET", `/${id}`, owner.token);
    expect(still.body.owner.id).toBe(owner.id);
  });

  it("warns when the new owner cannot run it, and still transfers", async () => {
    const owner = await user();
    const next = await user(["id"]);
    const id = await savedQueryOf(owner.token, source);
    const res = await transfer(id, owner.token, { user_id: next.id });
    expect(res.status).toBe(200);
    expect(res.body.warning).toEqual({ accessible: false });
    expect(res.body.data.owner.id).toBe(next.id);
  });

  it("lets an admin with write transfer away from a service account", async () => {
    const service = randomUUID();
    const serviceToken = tokenFor({
      userId: service,
      client: service,
      permissions: [DATA_READ],
    });
    await grantTo({ type: "user", id: service }, source.tables.orders!, "all");
    const id = await savedQueryOf(serviceToken, source);
    const next = await user();
    const admin = tokenFor({ permissions: [DATA_READ, SAVED_QUERIES_WRITE] });
    const res = await transfer(id, admin, { user_id: next.id });
    expect(res.status).toBe(200);
    expect(res.body.data.owner.id).toBe(next.id);
  });

  it("is a 404 to a recipient and a 403 to an admin who only reads", async () => {
    const owner = await user();
    const recipient = await user();
    const id = await savedQueryOf(owner.token, source);
    await shareDirectly(id, recipient.principal, owner.id);
    expect(
      (await transfer(id, recipient.token, { user_id: recipient.id })).status
    ).toBe(404);
    const reader = tokenFor({ permissions: [DATA_READ, SAVED_QUERIES_READ] });
    const res = await transfer(id, reader, { user_id: recipient.id });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it.each([
    ["no user_id", {}],
    ["a user_id that is no UUID", { user_id: "x" }],
    ["a keep_access that is no boolean", { keep_access: "no" }],
    ["an unknown key", { group_id: "x" }],
  ])("refuses %s", async (_, body) => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source);
    const res = await transfer(id, owner.token, {
      ...(Object.keys(body).length > 0 && { user_id: randomUUID() }),
      ...body,
    });
    expect(res.status).toBe(400);
  });
});
