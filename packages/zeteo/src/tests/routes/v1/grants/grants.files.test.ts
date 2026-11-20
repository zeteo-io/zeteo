// @module-tag int
// @module-tag platform
import { addToDirectory, clearDirectory } from "../../../support/principals.js";
import { columnsOf, registerSource, tableOf } from "../../../support/grants.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../support/sources.js";
import { startV1Routes } from "../../../support/v1App.js";
import { tokenFor } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
  GRANTS_READ,
  GRANTS_WRITE,
} from "../../../../definitions/tereoDeclaration.js";
import {
  removeUploadSources,
  seedUploadSource,
  type UploadTableSpec,
} from "../../../support/uploads.js";

const TABLE = (name: string): UploadTableSpec => ({
  name,
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "text" },
  ],
  rows: [["1", "Acme"]],
});

const ORG = randomUUID();
const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  org: ORG,
  permissions: [DATA_READ, UPLOADS_WRITE],
});
const otherOwnerId = randomUUID();
const admin = tokenFor({ permissions: [GRANTS_READ, GRANTS_WRITE] });
/** A caller with no permissions: the 403 bodies owners must not tell apart from. */
const nobody = tokenFor({ permissions: [] });

/** A response body without its `request_id`, to compare two 403s. */
const bodyOf = (res: { body: Record<string, unknown> }) => {
  const { request_id: _, ...rest } = res.body;
  return rest;
};

describe("/v1/grants (upload sources)", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let own: Awaited<ReturnType<typeof seedUploadSource>>;
  let others: Awaited<ReturnType<typeof seedUploadSource>>;
  let databaseSourceId: string;
  let databaseTableId: string;

  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetchJson(method, `${app.url}/v1/grants${path}`, token, body);
  const grant = (
    token: string,
    tableId: string,
    overrides: Record<string, unknown> = {}
  ) =>
    call("POST", "", token, {
      principal_type: "user",
      principal_id: randomUUID(),
      table_id: tableId,
      all_columns: true,
      ...overrides,
    });
  const group = async (org: string | null) => {
    const id = randomUUID();
    await addToDirectory([
      {
        type: "group",
        id,
        name: `Group ${id.slice(0, 6)}`,
        status: "active",
        organization_id: org,
      },
    ]);
    return id;
  };
  /** The 403 a caller without any permission gets for the same request. */
  const forbidden = async (method: string, path: string, body?: unknown) =>
    bodyOf(await call(method, path, nobody, body));

  beforeAll(async () => {
    app = await startV1Routes();
    own = await seedUploadSource({
      ownerId,
      tables: [TABLE("customers"), TABLE("orders")],
    });
    others = await seedUploadSource({
      ownerId: otherOwnerId,
      tables: [TABLE("customers")],
    });
    databaseSourceId = await registerSource(app.url);
    databaseTableId = (await tableOf(databaseSourceId, "customers")).id;
  });
  afterAll(async () => {
    await removeUploadSources([own.id, others.id]);
    await removeSources([databaseSourceId]);
    await clearDirectory();
    await app.close();
  });

  it("lists every grant on the owner's source, an admin's included, with owner_grant", async () => {
    const made = await grant(admin, own.tables.customers!.id);
    expect(made.status).toBe(201);
    expect(made.body.owner_grant).toBe(false);

    const res = await call("GET", `?source_id=${own.id}&limit=100`, owner);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((g: { id: string }) => g.id);
    expect(ids).toContain(made.body.id);
    const ownerGrants = res.body.data.filter(
      (g: { owner_grant: boolean }) => g.owner_grant
    );
    expect(ownerGrants).toHaveLength(2);
    expect(ownerGrants[0]).toMatchObject({
      principal_type: "user",
      principal_id: ownerId,
      all_columns: true,
    });
  });

  it("refuses an owner a list without source_id or of a source they do not own, as today", async () => {
    for (const query of ["", `?source_id=${others.id}`]) {
      const res = await call("GET", query, owner);
      expect(res.status, query).toBe(403);
      expect(bodyOf(res), query).toEqual(await forbidden("GET", query));
    }
    const res = await call("GET", `?source_id=${databaseSourceId}`, owner);
    expect(res.status).toBe(403);
  });

  it("lets the owner grant to a user, a global group and a group of their organization", async () => {
    const user = await grant(owner, own.tables.customers!.id);
    expect(user.status).toBe(201);
    expect(user.body.created_by).toBe(ownerId);

    for (const org of [ORG, null]) {
      const res = await grant(owner, own.tables.customers!.id, {
        principal_type: "group",
        principal_id: await group(org),
      });
      expect(res.status, String(org)).toBe(201);
    }

    const columns = await columnsOf(own.tables.orders!.id);
    const listed = await grant(owner, own.tables.orders!.id, {
      all_columns: false,
      column_ids: [columns[0]!.id],
    });
    expect(listed.status).toBe(201);
  });

  it("refuses the owner a group of another organization, or one unknown, with 422 group_not_allowed", async () => {
    for (const principalId of [await group(randomUUID()), randomUUID()]) {
      const res = await grant(owner, own.tables.customers!.id, {
        principal_type: "group",
        principal_id: principalId,
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("group_not_allowed");
    }
  });

  it("lets an admin grant to a group of any organization", async () => {
    const res = await grant(admin, own.tables.customers!.id, {
      principal_type: "group",
      principal_id: await group(randomUUID()),
    });
    expect(res.status).toBe(201);
  });

  it("lets the owner change and remove an admin's grant", async () => {
    const made = await grant(admin, own.tables.orders!.id);
    const columns = await columnsOf(own.tables.orders!.id);
    const changed = await call("PUT", `/${made.body.id}`, owner, {
      row_access: "unlimited_default",
      all_columns: false,
      column_ids: [columns[1]!.id],
    });
    expect(changed.status).toBe(200);
    expect(changed.body.all_columns).toBe(false);
    expect((await call("GET", `/${made.body.id}`, owner)).status).toBe(200);
    expect((await call("DELETE", `/${made.body.id}`, owner)).status).toBe(204);
  });

  it("refuses the owner grants on a database source or another owner's upload source, as today", async () => {
    for (const tableId of [databaseTableId, others.tables.customers!.id]) {
      const body = {
        principal_type: "user",
        principal_id: randomUUID(),
        table_id: tableId,
        all_columns: true,
      };
      const created = await call("POST", "", owner, body);
      expect(created.status).toBe(403);
      expect(bodyOf(created)).toEqual(await forbidden("POST", "", body));

      const made = await grant(admin, tableId);
      expect(made.status).toBe(201);
      const path = `/${made.body.id}`;
      for (const [method, payload] of [
        ["GET", undefined],
        ["PUT", { row_access: "unlimited_default", all_columns: true }],
        ["DELETE", undefined],
      ] as const) {
        const res = await call(method, path, owner, payload);
        expect(res.status, `${method} ${tableId}`).toBe(403);
        expect(bodyOf(res)).toEqual(await forbidden(method, path, payload));
      }
    }
    // An unknown table or grant is refused the same way.
    const unknown = await grant(owner, randomUUID());
    expect(unknown.status).toBe(403);
    expect((await call("DELETE", `/${randomUUID()}`, owner)).status).toBe(403);
  });

  it("refuses an owner who no longer holds zeteo.uploads.write", async () => {
    const lapsed = tokenFor({ userId: ownerId, permissions: [DATA_READ] });
    const res = await grant(lapsed, own.tables.customers!.id);
    expect(res.status).toBe(403);
    expect(bodyOf(res)).toEqual(
      await forbidden("POST", "", {
        principal_type: "user",
        principal_id: randomUUID(),
        table_id: own.tables.customers!.id,
        all_columns: true,
      })
    );
    const list = await call("GET", `?source_id=${own.id}`, lapsed);
    expect(list.status).toBe(403);
  });

  it("locks the owner grant against removal and narrowing, for owners and admins", async () => {
    const list = await call(
      "GET",
      `?source_id=${own.id}&principal_id=${ownerId}&table_id=${own.tables.customers!.id}`,
      owner
    );
    const ownerGrant = list.body.data[0] as { id: string; owner_grant: true };
    expect(ownerGrant.owner_grant).toBe(true);
    const path = `/${ownerGrant.id}`;
    const columns = await columnsOf(own.tables.customers!.id);
    const narrow = {
      row_access: "unlimited_default",
      all_columns: false,
      column_ids: [columns[0]!.id],
    };

    for (const token of [owner, admin]) {
      const removed = await call("DELETE", path, token);
      expect(removed.status).toBe(409);
      expect(removed.body.error).toBe("owner_grant_locked");
      const narrowed = await call("PUT", path, token, narrow);
      expect(narrowed.status).toBe(409);
      expect(narrowed.body.error).toBe("owner_grant_locked");
    }
    const same = await call("PUT", path, owner, {
      row_access: "unlimited_default",
      all_columns: true,
    });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ all_columns: true, owner_grant: true });
  });
});
