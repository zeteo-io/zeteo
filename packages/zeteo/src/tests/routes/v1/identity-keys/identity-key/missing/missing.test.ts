// @module-tag int
// @module-tag platform
import { UPLOADS_WRITE } from "../../../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  clearTestGroupMembers,
  setTestGroupMembers,
} from "../../../../../support/principals.js";
import {
  grantsReadToken,
  grantsWriteToken,
  registerSource,
  tableOf,
} from "../../../../../support/grants.js";

describe("GET /v1/identity-keys/:keyId/missing", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let sourceId: string;
  let orders: Awaited<ReturnType<typeof tableOf>>;
  const keyName = `mis_${randomUUID().slice(0, 8)}`;
  let keyId: string;
  const groupId = randomUUID();

  const missing = (id: string, token = grantsReadToken()) =>
    fetchJson("GET", `${app.url}/v1/identity-keys/${id}/missing`, token);

  const ruleGrant = async (
    principalType: "user" | "group",
    principalId: string
  ): Promise<string> => {
    const res = await fetchJson(
      "POST",
      `${app.url}/v1/grants`,
      grantsWriteToken(),
      {
        principal_type: principalType,
        principal_id: principalId,
        table_id: orders.id,
        all_columns: true,
        row_access: "rule",
        row_rule: { notes: { in: { identity: keyName } } },
      }
    );
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    orders = await tableOf(sourceId, "orders");
    keyId = (
      await prisma.identityKey.create({
        data: { name: keyName, label: "Rep", createdBy: randomUUID() },
      })
    ).id;
  });
  afterAll(async () => {
    await clearTestGroupMembers(groupId);
    await removeSources([sourceId]);
    await prisma.identityValue.deleteMany({ where: { keyId } });
    await prisma.identityKey.deleteMany({ where: { id: keyId } });
    await app.close();
  });

  it("is empty when no grant uses the key", async () => {
    const res = await missing(keyId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ users: [] });
  });

  it("lists the users a rule names who hold no value, directly or through a group", async () => {
    const without = randomUUID();
    const withValue = randomUUID();
    const member = randomUUID();
    const withoutGrant = await ruleGrant("user", without);
    const withValueGrant = await ruleGrant("user", withValue);
    const groupGrant = await ruleGrant("group", groupId);
    await setTestGroupMembers(groupId, [member, withValue, without]);
    await prisma.identityValue.create({
      data: { keyId, userId: withValue, value: "R-9", createdBy: withValue },
    });
    // A user with a value under the key but no grant using it is not listed either.
    await prisma.identityValue.create({
      data: {
        keyId,
        userId: randomUUID(),
        value: "R-10",
        createdBy: withValue,
      },
    });

    const res = await missing(keyId);
    expect(res.status).toBe(200);
    const expected = [
      { user_id: without, via_grant_ids: [withoutGrant, groupGrant].sort() },
      { user_id: member, via_grant_ids: [groupGrant] },
    ].sort((a, b) => a.user_id.localeCompare(b.user_id));
    expect(res.body).toEqual({ users: expected });
    expect(
      (res.body.users as { user_id: string }[]).map((u) => u.user_id)
    ).not.toContain(withValue);
    expect(withValueGrant).toBeTypeOf("string");
  });

  it("is 404 for a key that does not exist", async () => {
    expect((await missing(randomUUID())).status).toBe(404);
  });

  it("is 403 without zeteo.grants.read", async () => {
    const res = await missing(
      keyId,
      tokenFor({ permissions: [UPLOADS_WRITE] })
    );
    expect(res.status).toBe(403);
  });
});
