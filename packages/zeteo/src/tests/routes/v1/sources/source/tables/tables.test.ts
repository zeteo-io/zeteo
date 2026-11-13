// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor } from "../../../../../../utils/cursor.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  auditRows,
  readToken,
  removeSources,
  sourceBody,
  sourceSettings,
  writeToken,
} from "../../../../../support/sources.js";

describe("/v1/sources/:sourceId/tables", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const created: string[] = [];
  let sourceId: string;
  let otherId: string;

  const call = (
    method: string,
    path: string,
    token: string | null = writeToken(),
    body?: unknown
  ) => fetchJson(method, `${app.url}/v1/sources${path}`, token, body);

  const newSource = async () => {
    const res = await call(
      "POST",
      "",
      writeToken(),
      sourceBody(sourceSettings("ro"), { schemas: ["sales"] })
    );
    expect(res.status).toBe(201);
    created.push(res.body.id);
    return res.body.id as string;
  };
  const tableId = async (id: string, name: string) =>
    (
      await prisma.sourceTable.findFirstOrThrow({
        where: { sourceId: id, name },
      })
    ).id;

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await newSource();
    otherId = await newSource();
  });
  afterAll(async () => {
    await removeSources(created);
    await app.close();
  });

  describe("GET /", () => {
    it("lists the source's tables in schema and name order", async () => {
      const res = await call("GET", `/${sourceId}/tables`, readToken());
      expect(res.status).toBe(200);
      expect(res.body.next_cursor).toBeNull();
      expect(res.body.data.map((t: { name: string }) => t.name)).toEqual([
        "blobs",
        "customers",
        "order_lines",
        "orders",
        "paid_orders",
      ]);
      expect(res.body.data[0]).toEqual({
        id: expect.any(String),
        source_id: sourceId,
        schema_name: "sales",
        name: "blobs",
        kind: "table",
        description: null,
        last_seen_at: expect.any(String),
        missing_since: null,
      });
      expect(
        res.body.data.find((t: { name: string }) => t.name === "paid_orders")
          .kind
      ).toBe("view");
    });

    it("pages with limit and cursor", async () => {
      const first = await call("GET", `/${sourceId}/tables?limit=2`);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.next_cursor).toEqual(expect.any(String));
      const second = await call(
        "GET",
        `/${sourceId}/tables?limit=2&cursor=${first.body.next_cursor}`
      );
      expect(second.body.data.map((t: { name: string }) => t.name)).toEqual([
        "order_lines",
        "orders",
      ]);
      const last = await call(
        "GET",
        `/${sourceId}/tables?limit=2&cursor=${second.body.next_cursor}`
      );
      expect(last.body.data).toHaveLength(1);
      expect(last.body.next_cursor).toBeNull();
      expect(
        (await call("GET", `/${sourceId}/tables?cursor=garbage`)).status
      ).toBe(400);
      const nul = encodeCursor(["sa\u0000les", "orders"]);
      const refused = await call("GET", `/${sourceId}/tables?cursor=${nul}`);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("invalid_request");
    });

    it("leaves out missing tables unless include_missing=true", async () => {
      const id = await newSource();
      const blobs = await tableId(id, "blobs");
      await prisma.sourceTable.update({
        where: { id: blobs },
        data: { missingSince: new Date() },
      });
      const names = async (query: string) =>
        (await call("GET", `/${id}/tables${query}`)).body.data.map(
          (t: { name: string }) => t.name
        );
      expect(await names("")).not.toContain("blobs");
      expect(await names("?include_missing=true")).toContain("blobs");
      expect(await names("?include_missing=false")).not.toContain("blobs");
      expect(
        (await call("GET", `/${id}/tables?include_missing=yes`)).status
      ).toBe(400);
    });

    it("answers 404 for an unknown source and 400 for a malformed id", async () => {
      expect((await call("GET", `/${randomUUID()}/tables`)).status).toBe(404);
      expect((await call("GET", "/nope/tables")).status).toBe(400);
    });
  });

  describe("GET /:tableId", () => {
    it("returns the table with its columns and its relations", async () => {
      const id = await tableId(sourceId, "orders");
      const res = await call("GET", `/${sourceId}/tables/${id}`, readToken());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id,
        source_id: sourceId,
        schema_name: "sales",
        name: "orders",
        kind: "table",
        description: null,
      });
      expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
        "id",
        "customer_id",
        "status",
        "total",
        "created_at",
        "notes",
      ]);
      expect(res.body.columns[0]).toEqual({
        id: expect.any(String),
        name: "id",
        type: "number",
        native_type: "integer",
        nullable: false,
        position: 1,
        is_primary_key: true,
        description: null,
        missing_since: null,
      });
      expect(
        res.body.columns.find((c: { name: string }) => c.name === "created_at")
          .type
      ).toBe("timestamp");
      const names = res.body.relations
        .map((r: { name: string }) => r.name)
        .sort();
      expect(names).toEqual(["customer", "order_lines"]);
      expect(res.body.relations[0]).toEqual({
        id: expect.any(String),
        name: expect.any(String),
        from_table_id: id,
        from_columns: expect.any(Array),
        to_table_id: expect.any(String),
        to_columns: expect.any(Array),
        to_many: expect.any(Boolean),
        origin: "discovered",
        missing_since: null,
      });
    });

    it("answers 404 for a table of another source and for an unknown one", async () => {
      const foreign = await tableId(otherId, "orders");
      expect((await call("GET", `/${sourceId}/tables/${foreign}`)).status).toBe(
        404
      );
      expect(
        (await call("GET", `/${sourceId}/tables/${randomUUID()}`)).status
      ).toBe(404);
      expect((await call("GET", `/${sourceId}/tables/nope`)).status).toBe(400);
    });
  });

  describe("PATCH /:tableId", () => {
    it("sets the table's and its columns' descriptions and records an audit entry", async () => {
      const id = await tableId(sourceId, "customers");
      const res = await call(
        "PATCH",
        `/${sourceId}/tables/${id}`,
        writeToken(),
        {
          description: "Who buys",
          columns: [
            { name: "region", description: "Sales region" },
            { name: "email", description: "Contact address" },
          ],
        }
      );
      expect(res.status).toBe(200);
      expect(res.body.description).toBe("Who buys");
      const byName = (n: string) =>
        res.body.columns.find((c: { name: string }) => c.name === n);
      expect(byName("region").description).toBe("Sales region");
      expect(byName("email").description).toBe("Contact address");
      expect(byName("name").description).toBeNull();

      const entries = await auditRows(sourceId);
      expect(entries.at(-1)?.payload).toMatchObject({
        action: "UPDATE",
        metadata: {
          event: "zeteo.source.updated",
          table_id: id,
          table: "sales.customers",
          changed: ["description", "columns"],
        },
      });
    });

    it("changes only what the body names, and null clears a description", async () => {
      const id = await tableId(sourceId, "order_lines");
      await call("PATCH", `/${sourceId}/tables/${id}`, writeToken(), {
        description: "Lines",
      });
      const res = await call(
        "PATCH",
        `/${sourceId}/tables/${id}`,
        writeToken(),
        {
          columns: [{ name: "sku", description: "Item code" }],
        }
      );
      expect(res.body.description).toBe("Lines");
      const cleared = await call(
        "PATCH",
        `/${sourceId}/tables/${id}`,
        writeToken(),
        {
          description: null,
        }
      );
      expect(cleared.body.description).toBeNull();
      expect(
        cleared.body.columns.find((c: { name: string }) => c.name === "sku")
          .description
      ).toBe("Item code");
    });

    it("answers 400 for a description over 2000 characters, an unknown column or an empty body", async () => {
      const id = await tableId(sourceId, "blobs");
      const patch = (body: unknown) =>
        call("PATCH", `/${sourceId}/tables/${id}`, writeToken(), body);
      expect((await patch({ description: "x".repeat(2001) })).status).toBe(400);
      expect((await patch({ description: "x".repeat(2000) })).status).toBe(200);
      expect(
        (await patch({ columns: [{ name: "x".repeat(2), description: "d" }] }))
          .status
      ).toBe(400);
      expect((await patch({})).status).toBe(400);
      expect((await patch({ unknown: 1 })).status).toBe(400);
      expect(
        (
          await patch({
            columns: [
              { name: "id", description: "a" },
              { name: "id", description: "b" },
            ],
          })
        ).status
      ).toBe(400);
    });

    it("answers 404 for a table of another source and 403 for a read-only caller", async () => {
      const foreign = await tableId(otherId, "orders");
      const own = await tableId(sourceId, "orders");
      expect(
        (
          await call("PATCH", `/${sourceId}/tables/${foreign}`, writeToken(), {
            description: "x",
          })
        ).status
      ).toBe(404);
      expect(
        (await prisma.sourceTable.findUniqueOrThrow({ where: { id: foreign } }))
          .description
      ).toBeNull();
      expect(
        (
          await call("PATCH", `/${sourceId}/tables/${own}`, readToken(), {
            description: "x",
          })
        ).status
      ).toBe(403);
    });

    it("answers 409 source_archived for an archived source", async () => {
      const id = await newSource();
      const table = await tableId(id, "blobs");
      await call("POST", `/${id}/archive`);
      const res = await call("PATCH", `/${id}/tables/${table}`, writeToken(), {
        description: "late",
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("source_archived");
      expect((await call("GET", `/${id}/tables/${table}`)).status).toBe(200);
    });
  });
});
