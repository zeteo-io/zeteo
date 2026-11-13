// @module-tag int
// @module-tag platform
import { clearOrphaned, markOrphaned } from "../../../support/principals.js";
import { removeSources, writeToken } from "../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { tokenFor } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";
import {
  columnsOf,
  grantsReadToken,
  grantsWriteToken,
  registerSource,
  tableOf,
} from "../../../support/grants.js";

const tokenOf = () => tokenFor({ permissions: [] });

describe("/v1/grants", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const sources: string[] = [];
  let sourceId: string;
  let otherSourceId: string;
  let customers: Awaited<ReturnType<typeof tableOf>>;
  let orders: Awaited<ReturnType<typeof tableOf>>;
  let customerColumns: Awaited<ReturnType<typeof columnsOf>>;
  let orderColumns: Awaited<ReturnType<typeof columnsOf>>;

  const call = (
    method: string,
    path: string,
    token: string | null = grantsWriteToken(),
    body?: unknown
  ) => fetchJson(method, `${app.url}/v1/grants${path}`, token, body);

  /** A grant of all columns of `table` to a fresh principal unless overridden. */
  const create = (overrides: Record<string, unknown> = {}, table = customers) =>
    call("POST", "", grantsWriteToken(), {
      principal_type: "user",
      principal_id: randomUUID(),
      table_id: table.id,
      all_columns: true,
      ...overrides,
    });

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    otherSourceId = await registerSource(app.url);
    sources.push(sourceId, otherSourceId);
    customers = await tableOf(sourceId, "customers");
    orders = await tableOf(sourceId, "orders");
    customerColumns = await columnsOf(customers.id);
    orderColumns = await columnsOf(orders.id);
  });
  afterAll(async () => {
    await removeSources(sources);
    await app.close();
  });

  describe("POST /", () => {
    it("creates an all-columns grant and answers 201 with the view", async () => {
      const principalId = randomUUID();
      const res = await create({ principal_id: principalId });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        principal_type: "user",
        principal_id: principalId,
        principal_status: "active",
        source: { id: sourceId, slug: expect.any(String) },
        table: {
          id: customers.id,
          schema_name: "sales",
          name: "customers",
          missing: false,
        },
        all_columns: true,
        columns: [],
        created_by: expect.any(String),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    });

    it("creates a column grant listing the columns in table order", async () => {
      const [first, second] = customerColumns;
      const res = await create(
        {
          principal_type: "group",
          // given in reverse of the table's order
          column_ids: [second!.id, first!.id],
          all_columns: false,
        },
        customers
      );
      expect(res.status).toBe(201);
      expect(res.body.principal_type).toBe("group");
      expect(res.body.all_columns).toBe(false);
      expect(res.body.columns).toEqual([
        { id: first!.id, name: first!.name, missing: false },
        { id: second!.id, name: second!.name, missing: false },
      ]);
    });

    it("does not require the principal to exist", async () => {
      const res = await create({ principal_id: randomUUID() }, orders);
      expect(res.status).toBe(201);
    });

    it("answers 404 not_found for an unknown table", async () => {
      const res = await create({ table_id: randomUUID() });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    it("answers 409 source_archived for a table of an archived source", async () => {
      const archivedId = await registerSource(app.url);
      sources.push(archivedId);
      const table = await tableOf(archivedId, "customers");
      const archive = await fetchJson(
        "POST",
        `${app.url}/v1/sources/${archivedId}/archive`,
        writeToken()
      );
      expect(archive.status).toBe(204);
      const res = await create({}, table);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("source_archived");
    });

    it("answers 422 invalid_grant for a column of another table", async () => {
      const principalId = randomUUID();
      const res = await create({
        principal_id: principalId,
        all_columns: false,
        column_ids: [customerColumns[0]!.id, orderColumns[0]!.id],
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("invalid_grant");
      expect(await prisma.grant.count({ where: { principalId } })).toBe(0);
    });

    it("answers 422 invalid_grant for a column id that does not exist", async () => {
      const res = await create({
        all_columns: false,
        column_ids: [randomUUID()],
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("invalid_grant");
    });

    it("answers 409 grant_exists for the same principal and table", async () => {
      const principalId = randomUUID();
      expect((await create({ principal_id: principalId })).status).toBe(201);
      const again = await create({
        principal_id: principalId,
        all_columns: false,
        column_ids: [customerColumns[0]!.id],
      });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("grant_exists");
      // The same id as a group is another principal.
      const asGroup = await create({
        principal_id: principalId,
        principal_type: "group",
      });
      expect(asGroup.status).toBe(201);
    });

    it("answers 403 to a read-only caller and 401 without a token", async () => {
      expect((await call("POST", "", grantsReadToken(), {})).status).toBe(403);
      expect((await call("POST", "", null, {})).status).toBe(401);
    });
  });

  describe("GET /:id", () => {
    it("returns the grant to a read-only caller", async () => {
      const made = await create();
      const res = await call("GET", `/${made.body.id}`, grantsReadToken());
      expect(res.status).toBe(200);
      expect(res.body).toEqual(made.body);
    });

    it("answers 404 for an unknown grant and 400 for a malformed id", async () => {
      expect(
        (await call("GET", `/${randomUUID()}`, grantsReadToken())).status
      ).toBe(404);
      expect((await call("GET", "/nope", grantsReadToken())).status).toBe(400);
    });

    it("answers 403 to a caller without the permission", async () => {
      const made = await create();
      const res = await call("GET", `/${made.body.id}`, tokenOf());
      expect(res.status).toBe(403);
    });

    it("reports a principal Tereo no longer knows as orphaned", async () => {
      const principalId = randomUUID();
      const made = await create({ principal_id: principalId });
      await markOrphaned(principalId);
      try {
        const res = await call("GET", `/${made.body.id}`, grantsReadToken());
        expect(res.body.principal_status).toBe("orphaned");
      } finally {
        await clearOrphaned(principalId);
      }
    });

    it("keeps a grant's columns when one goes missing from the source", async () => {
      const [first, second] = customerColumns;
      const made = await create({
        principal_type: "group",
        all_columns: false,
        column_ids: [first!.id, second!.id],
      });
      await prisma.sourceColumn.update({
        where: { id: second!.id },
        data: { missingSince: new Date() },
      });
      try {
        const res = await call("GET", `/${made.body.id}`, grantsReadToken());
        expect(res.body.columns).toEqual([
          { id: first!.id, name: first!.name, missing: false },
          { id: second!.id, name: second!.name, missing: true },
        ]);
      } finally {
        await prisma.sourceColumn.update({
          where: { id: second!.id },
          data: { missingSince: null },
        });
      }
    });

    it("shows a missing table as missing", async () => {
      const made = await create({}, orders);
      await prisma.sourceTable.update({
        where: { id: orders.id },
        data: { missingSince: new Date() },
      });
      try {
        const res = await call("GET", `/${made.body.id}`, grantsReadToken());
        expect(res.body.table.missing).toBe(true);
      } finally {
        await prisma.sourceTable.update({
          where: { id: orders.id },
          data: { missingSince: null },
        });
      }
    });
  });

  describe("PUT /:id", () => {
    it("replaces all columns with a list and back", async () => {
      const made = await create();
      const first = customerColumns[0]!;
      const toList = await call("PUT", `/${made.body.id}`, grantsWriteToken(), {
        all_columns: false,
        column_ids: [first.id],
      });
      expect(toList.status).toBe(200);
      expect(toList.body.all_columns).toBe(false);
      expect(toList.body.columns).toEqual([
        { id: first.id, name: first.name, missing: false },
      ]);
      expect(toList.body.id).toBe(made.body.id);

      const toAll = await call("PUT", `/${made.body.id}`, grantsWriteToken(), {
        all_columns: true,
      });
      expect(toAll.status).toBe(200);
      expect(toAll.body.all_columns).toBe(true);
      expect(toAll.body.columns).toEqual([]);
      expect(
        await prisma.grantColumn.count({ where: { grantId: made.body.id } })
      ).toBe(0);
    });

    it("answers 422 invalid_grant for a column of another table and keeps the grant", async () => {
      const made = await create();
      const res = await call("PUT", `/${made.body.id}`, grantsWriteToken(), {
        all_columns: false,
        column_ids: [orderColumns[0]!.id],
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("invalid_grant");
      const kept = await call("GET", `/${made.body.id}`, grantsReadToken());
      expect(kept.body.all_columns).toBe(true);
    });

    it("answers 404 for an unknown grant, 403 to a read-only caller", async () => {
      const body = { all_columns: true };
      expect(
        (await call("PUT", `/${randomUUID()}`, grantsWriteToken(), body)).status
      ).toBe(404);
      const made = await create();
      expect(
        (await call("PUT", `/${made.body.id}`, grantsReadToken(), body)).status
      ).toBe(403);
    });

    it("answers 409 source_archived once the source is archived", async () => {
      const archivedId = await registerSource(app.url);
      sources.push(archivedId);
      const table = await tableOf(archivedId, "customers");
      const made = await create({}, table);
      await fetchJson(
        "POST",
        `${app.url}/v1/sources/${archivedId}/archive`,
        writeToken()
      );
      const res = await call("PUT", `/${made.body.id}`, grantsWriteToken(), {
        all_columns: false,
        column_ids: [(await columnsOf(table.id))[0]!.id],
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("source_archived");
      // A grant on an archived source can still be removed.
      expect((await call("DELETE", `/${made.body.id}`)).status).toBe(204);
    });
  });

  describe("DELETE /:id", () => {
    it("removes the grant with its columns and answers 204", async () => {
      const made = await create({
        all_columns: false,
        column_ids: [customerColumns[0]!.id],
      });
      const res = await call("DELETE", `/${made.body.id}`);
      expect(res.status).toBe(204);
      expect(res.body).toBeNull();
      expect(
        (await call("GET", `/${made.body.id}`, grantsReadToken())).status
      ).toBe(404);
      expect(
        await prisma.grantColumn.count({ where: { grantId: made.body.id } })
      ).toBe(0);
    });

    it("answers 404 for an unknown grant, 403 to a read-only caller", async () => {
      expect((await call("DELETE", `/${randomUUID()}`)).status).toBe(404);
      const made = await create();
      expect(
        (await call("DELETE", `/${made.body.id}`, grantsReadToken())).status
      ).toBe(403);
    });
  });

  describe("GET /", () => {
    const principalId = randomUUID();
    const ids: string[] = [];

    beforeAll(async () => {
      // Three grants to one principal: two tables of one source, one of another.
      const otherCustomers = await tableOf(otherSourceId, "customers");
      for (const table of [customers, orders, otherCustomers]) {
        const res = await create({ principal_id: principalId }, table);
        expect(res.status).toBe(201);
        ids.push(res.body.id);
      }
    });

    const list = (query: string) => call("GET", `?${query}`, grantsReadToken());
    const idsOf = (body: { data: Array<{ id: string }> }) =>
      body.data.map((g) => g.id);

    it("filters by principal", async () => {
      const res = await list(`principal_type=user&principal_id=${principalId}`);
      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual(ids);
      expect(res.body.next_cursor).toBeNull();
      const asGroup = await list(
        `principal_type=group&principal_id=${principalId}`
      );
      expect(asGroup.body.data).toEqual([]);
    });

    it("filters by source and by table", async () => {
      const bySource = await list(
        `principal_id=${principalId}&source_id=${sourceId}`
      );
      expect(idsOf(bySource.body)).toEqual(ids.slice(0, 2));
      expect(
        bySource.body.data.every(
          (g: { source: { id: string } }) => g.source.id === sourceId
        )
      ).toBe(true);
      const byTable = await list(
        `principal_id=${principalId}&table_id=${orders.id}`
      );
      expect(idsOf(byTable.body)).toEqual([ids[1]]);
    });

    it("pages in creation order with a cursor", async () => {
      const first = await list(`principal_id=${principalId}&limit=2`);
      expect(idsOf(first.body)).toEqual(ids.slice(0, 2));
      expect(first.body.next_cursor).toEqual(expect.any(String));
      const second = await list(
        `principal_id=${principalId}&limit=2&cursor=${first.body.next_cursor}`
      );
      expect(idsOf(second.body)).toEqual([ids[2]]);
      expect(second.body.next_cursor).toBeNull();
    });

    it("marks an orphaned principal's grants", async () => {
      await markOrphaned(principalId);
      try {
        const res = await list(`principal_id=${principalId}`);
        expect(
          res.body.data.map(
            (g: { principal_status: string }) => g.principal_status
          )
        ).toEqual(["orphaned", "orphaned", "orphaned"]);
      } finally {
        await clearOrphaned(principalId);
      }
    });

    it("answers 400 for a bad filter, limit or cursor, 403 without permission", async () => {
      for (const query of [
        "principal_type=robot",
        "principal_id=nope",
        "table_id=nope",
        "source_id=nope",
        "limit=0",
        "limit=101",
        "cursor=!!",
        "cursor=W10",
        "extra=1",
      ]) {
        expect((await list(query)).status, query).toBe(400);
      }
      expect((await call("GET", "", tokenOf())).status).toBe(403);
    });
  });
});
