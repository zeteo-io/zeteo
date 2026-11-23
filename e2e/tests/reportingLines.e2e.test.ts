import { afterAll, describe, expect, inject, it } from "vitest";
import { randomUUID } from "node:crypto";
import { requestJson } from "../support/http.js";
import { CLIENTS, stack } from "../support/stack.js";
import { signIn } from "../support/oauth.js";
import { query } from "../support/zeteo.js";
import {
  createUser,
  deactivateUser,
  roleId,
  setReportsTo,
} from "../support/tereo.js";

const e2e = inject("e2e");

// zeteo reads Tereo's reporting lines (`listUserReports`, transitive) to
// resolve a row rule's `below`. A director D, a manager M who reports to D
// and is then deactivated, and a rep R who reports to M; another rep O
// reports to no one. R and O each own orders by `customer_id` through an
// identity value. D's rule `customer_id in my values, below` gives D R's
// orders, through the deactivated M, and none of O's.
describe("row rules: everyone below the caller in Tereo's reporting lines", () => {
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

  it("gives a director the orders of a rep under a deactivated manager, and not another rep's", async () => {
    const tag = randomUUID().slice(0, 8);
    const core = e2e.admin.coreToken;
    const userRole = await roleId(core, "zeteo_user");
    const email = (name: string) => `${name}-${tag}@e2e.example.com`;
    const director = await createUser(core, email("director"), [userRole]);
    const manager = await createUser(core, email("manager"), [userRole]);
    const rep = await createUser(core, email("rep"), [userRole]);
    const otherRep = await createUser(core, email("other-rep"), [userRole]);

    await setReportsTo(core, manager, director);
    await setReportsTo(core, rep, manager);
    // Before the director's first query, so nothing cached predates it.
    await deactivateUser(core, manager);

    const name = `rep_id_${tag}`;
    const key = await zeteo("POST", "/identity-keys", {
      name,
      label: "Rep ID",
    });
    expect(key.status).toBe(201);
    keyId = key.body.id as string;
    const values = await zeteo("POST", `/identity-keys/${keyId}/values`, {
      values: [
        { user_id: rep, value: "1" },
        { user_id: otherRep, value: "2" },
      ],
    });
    expect(values.status).toBe(201);

    const grant = await zeteo("POST", "/grants", {
      principal_type: "user",
      principal_id: director,
      table_id: e2e.source.tables.orders,
      all_columns: true,
      row_access: "rule",
      row_rule: { customer_id: { in: { identity: name, below: true } } },
    });
    expect(grant.status).toBe(201);
    grantId = grant.body.id as string;

    const token = await signIn({
      client: CLIENTS.web,
      email: email("director"),
      clientSecret: stack.webClientSecret,
    });
    const res = await query(stack.zeteoUrl, token, e2e.source.slug, {
      from: "orders",
      select: ["id", "customer_id"],
      orderBy: [{ id: "asc" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Customer 1's orders (the rep's), none of customer 2's (the other rep's).
    expect(res.body.rows).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(res.body.rows_limited).toBe(true);

    // The director's own sentence names no one below them.
    const catalog = await requestJson("GET", `${stack.zeteoUrl}/v1/catalog`, {
      token,
    });
    expect(catalog.status).toBe(200);
    const text = JSON.stringify(catalog.body);
    expect(text).toContain("anyone who reports to you");
    for (const id of [manager, rep, otherRep]) expect(text).not.toContain(id);

    // An admin's effective access for the director has no warning.
    const effective = await zeteo(
      "GET",
      `/grants/effective?user_id=${director}&table_id=${e2e.source.tables.orders}`
    );
    expect(effective.status).toBe(200);
    expect(effective.body.rows).toBe("limited");
    expect(effective.body.warnings).toEqual([]);
  });
});
