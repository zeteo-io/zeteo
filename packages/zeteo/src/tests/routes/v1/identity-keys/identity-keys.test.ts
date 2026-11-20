// @module-tag int
// @module-tag platform
import { grantsReadToken, grantsWriteToken } from "../../../support/grants.js";
import { UPLOADS_WRITE } from "../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { tokenFor } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";

describe("/v1/identity-keys", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const keyIds: string[] = [];
  const prefix = `t${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  let n = 0;
  const nextName = () => `${prefix}_${n++}`;

  const call = (
    method: string,
    path: string,
    token: string | null = grantsWriteToken(),
    body?: unknown
  ) => fetchJson(method, `${app.url}/v1/identity-keys${path}`, token, body);

  const makeKey = async () => {
    const res = await call("POST", "", grantsWriteToken(), {
      name: nextName(),
      label: "Employee id",
    });
    expect(res.status).toBe(201);
    keyIds.push(res.body.id as string);
    return res.body as { id: string; name: string };
  };

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await prisma.grant.deleteMany({
      where: { identityKeyIds: { hasSome: keyIds } },
    });
    await prisma.identityValue.deleteMany({ where: { keyId: { in: keyIds } } });
    await prisma.$executeRaw`
      DELETE FROM "core"."core_outbox"
      WHERE payload->>'entityId' = ANY(${keyIds}::text[])`;
    await prisma.identityKey.deleteMany({ where: { id: { in: keyIds } } });
    await app.close();
  });

  it("creates, lists, patches and deletes a key", async () => {
    const name = nextName();
    const made = await call("POST", "", grantsWriteToken(), {
      name,
      label: "Rep",
      description: "NetSuite rep",
    });
    expect(made.status).toBe(201);
    keyIds.push(made.body.id);
    expect(made.body).toMatchObject({ name, label: "Rep", value_count: 0 });

    expect(
      (await call("POST", "", grantsWriteToken(), { name, label: "x" })).status
    ).toBe(409);
    expect(
      (
        await call("POST", "", grantsWriteToken(), {
          name: "Bad Name",
          label: "x",
        })
      ).status
    ).toBe(400);

    const list = await call("GET", "", grantsReadToken());
    expect(list.status).toBe(200);
    expect(
      list.body.data.find((k: { name: string }) => k.name === name)
    ).toMatchObject({ id: made.body.id, value_count: 0 });

    const patched = await call(
      "PATCH",
      `/${made.body.id}`,
      grantsWriteToken(),
      {
        label: "Sales rep",
        description: null,
      }
    );
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      name,
      label: "Sales rep",
      description: null,
    });
    expect(
      (
        await call("PATCH", `/${made.body.id}`, grantsWriteToken(), {
          name: "z",
        })
      ).status
    ).toBe(400);

    expect((await call("DELETE", `/${made.body.id}`)).status).toBe(204);
    expect((await call("DELETE", `/${made.body.id}`)).status).toBe(404);
  });

  it("shows an uploads.write-only caller names and labels, and refuses its values", async () => {
    const key = await makeKey();
    const token = tokenFor({ permissions: [UPLOADS_WRITE] });
    const list = await call("GET", "", token);
    expect(list.status).toBe(200);
    const row = list.body.data.find(
      (k: { name: string }) => k.name === key.name
    );
    expect(Object.keys(row).sort()).toEqual(["description", "label", "name"]);
    expect((await call("GET", `/${key.id}/values`, token)).status).toBe(403);
    expect(
      (await call("POST", "", token, { name: nextName(), label: "x" })).status
    ).toBe(403);
    expect((await call("GET", "", tokenFor({ permissions: [] }))).status).toBe(
      403
    );
  });

  it("adds, pages and removes values, all or nothing", async () => {
    const key = await makeKey();
    const a = randomUUID();
    const b = randomUUID();
    const add = await call("POST", `/${key.id}/values`, grantsWriteToken(), {
      values: [
        { user_id: a, value: "101" },
        { user_id: a, value: "Éric 102" },
        { user_id: b, value: "201" },
      ],
    });
    expect(add.status).toBe(201);
    expect(add.body.data).toHaveLength(3);

    const mine = await call(
      "GET",
      `/${key.id}/values?user_id=${a}`,
      grantsReadToken()
    );
    expect(mine.body.data.map((v: { value: string }) => v.value)).toEqual([
      "101",
      "Éric 102",
    ]);
    const page1 = await call(
      "GET",
      `/${key.id}/values?limit=2`,
      grantsReadToken()
    );
    expect(page1.body.data).toHaveLength(2);
    const page2 = await call(
      "GET",
      `/${key.id}/values?limit=2&cursor=${page1.body.next_cursor}`,
      grantsReadToken()
    );
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.next_cursor).toBeNull();

    // Same user, same value: kept, not an error. Another user's value: refused, nothing written.
    const c = randomUUID();
    const clash = await call("POST", `/${key.id}/values`, grantsWriteToken(), {
      values: [
        { user_id: c, value: "301" },
        { user_id: c, value: "201" },
      ],
    });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({
      error: "identity_value_taken",
      value: "201",
    });
    expect(await prisma.identityValue.count({ where: { userId: c } })).toBe(0);
    expect(
      (
        await call("POST", `/${key.id}/values`, grantsWriteToken(), {
          values: [{ user_id: a, value: "101" }],
        })
      ).status
    ).toBe(201);
    expect(await prisma.identityValue.count({ where: { keyId: key.id } })).toBe(
      3
    );

    // Case is significant.
    expect(
      (
        await call("POST", `/${key.id}/values`, grantsWriteToken(), {
          values: [
            { user_id: b, value: "ABC" },
            { user_id: c, value: "abc" },
          ],
        })
      ).status
    ).toBe(201);

    for (const bad of [
      [],
      [{ user_id: "nope", value: "x" }],
      [{ user_id: a, value: "" }],
      [{ user_id: a, value: "x".repeat(501) }],
      [{ user_id: a, value: "a\u0000b" }],
    ]) {
      expect(
        (
          await call("POST", `/${key.id}/values`, grantsWriteToken(), {
            values: bad,
          })
        ).status
      ).toBe(400);
    }

    const one = mine.body.data[0].id as string;
    expect((await call("DELETE", `/${key.id}/values/${one}`)).status).toBe(204);
    expect((await call("DELETE", `/${key.id}/values/${one}`)).status).toBe(404);
    const list = await call("GET", "", grantsReadToken());
    expect(
      list.body.data.find((k: { name: string }) => k.name === key.name)
        .value_count
    ).toBe(4);
  });

  it("refuses to delete a key a grant lists, naming the grants", async () => {
    const key = await makeKey();
    const sourceId = await (
      await import("../../../support/grants.js")
    ).registerSource(app.url);
    const table = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId },
    });
    const grant = await prisma.grant.create({
      data: {
        principalType: "user",
        principalId: randomUUID(),
        tableId: table.id,
        allColumns: true,
        identityKeyIds: [key.id],
        createdBy: randomUUID(),
      },
    });
    const res = await call("DELETE", `/${key.id}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "identity_key_in_use",
      grant_ids: [grant.id],
    });
    await prisma.grant.delete({ where: { id: grant.id } });
    expect((await call("DELETE", `/${key.id}`)).status).toBe(204);
    await (
      await import("../../../support/sources.js")
    ).removeSources([sourceId]);
  });

  it("audits each change and never logs a value's text", async () => {
    const key = await makeKey();
    const user = randomUUID();
    const secret = `secret-${randomUUID()}`;
    await call("PATCH", `/${key.id}`, grantsWriteToken(), { label: "New" });
    const added = await call("POST", `/${key.id}/values`, grantsWriteToken(), {
      values: [{ user_id: user, value: secret }],
    });
    await call("DELETE", `/${key.id}/values/${added.body.data[0].id}`);
    await call("DELETE", `/${key.id}`);
    const rows = await (
      await import("../../../support/sources.js")
    ).auditRows(key.id);
    expect(rows.map((r) => r.payload.metadata.event)).toEqual([
      "zeteo.identity_key.created",
      "zeteo.identity_key.updated",
      "zeteo.identity_value.added",
      "zeteo.identity_value.removed",
      "zeteo.identity_key.removed",
    ]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[2]!.payload.metadata).toMatchObject({
      user_ids: [user],
      count: 1,
    });
  });
});
