import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { requestJson } from "../support/http.js";
import { stack } from "../support/stack.js";
import { addGroupMember, createGroup } from "../support/tereo.js";

const e2e = inject("e2e");

// zeteo reads a group's members from Tereo (`listGroupMembers`) to say which
// users a row rule reaches who hold no identity value.
describe("identity keys: users missing a value, through a group", () => {
  const zeteo = (method: string, path: string, body?: unknown) =>
    requestJson(method, `${stack.zeteoUrl}/v1${path}`, {
      token: e2e.admin.zeteoToken,
      body,
    });
  let keyId: string | undefined;
  let grantId: string | undefined;

  afterAll(async () => {
    if (grantId) await zeteo("DELETE", `/grants/${grantId}`);
    if (keyId) await zeteo("DELETE", `/identity-keys/${keyId}`);
  });

  it("lists the members of a group the real Tereo returns who hold no value", async () => {
    const groupId = await createGroup(
      e2e.admin.coreToken,
      `e2e-reps-${randomUUID().slice(0, 8)}`
    );
    await addGroupMember(e2e.admin.coreToken, groupId, e2e.bob.id);
    await addGroupMember(e2e.admin.coreToken, groupId, e2e.dave.id);

    const name = `rep_${randomUUID().slice(0, 8)}`;
    const key = await zeteo("POST", "/identity-keys", { name, label: "Rep" });
    expect(key.status).toBe(201);
    keyId = key.body.id as string;
    const grant = await zeteo("POST", "/grants", {
      principal_type: "group",
      principal_id: groupId,
      table_id: e2e.source.tables.customers,
      all_columns: true,
      row_access: "rule",
      row_rule: { name: { in: { identity: name } } },
    });
    expect(grant.status).toBe(201);
    grantId = grant.body.id as string;

    const both = await zeteo("GET", `/identity-keys/${keyId}/missing`);
    expect(both.status).toBe(200);
    expect(
      both.body.users.map((u: { user_id: string }) => u.user_id).sort()
    ).toEqual([e2e.bob.id, e2e.dave.id].sort());
    expect(both.body.users[0].via_grant_ids).toEqual([grantId]);

    const given = await zeteo("POST", `/identity-keys/${keyId}/values`, {
      values: [{ user_id: e2e.dave.id, value: "Ada" }],
    });
    expect(given.status).toBe(201);
    const left = await zeteo("GET", `/identity-keys/${keyId}/missing`);
    expect(left.body.users.map((u: { user_id: string }) => u.user_id)).toEqual([
      e2e.bob.id,
    ]);
  });
});
