// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  auditRows,
  readToken,
  removeAuditRows,
  removeSources,
  sourceBody,
  sourceSettings,
  writeToken,
} from "../../../../../support/sources.js";

describe("/v1/sources/:sourceId/relations", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const created: string[] = [];
  const relations: string[] = [];
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
    created.push(res.body.id);
    return res.body.id as string;
  };
  const tableId = async (id: string, name: string) =>
    (
      await prisma.sourceTable.findFirstOrThrow({
        where: { sourceId: id, name },
      })
    ).id;

  /** A valid body for the source: orders.status (text) to customers.region (text). */
  const declare = async (
    overrides: Record<string, unknown> = {},
    id = sourceId
  ) => ({
    name: "by_region",
    from_table_id: await tableId(id, "orders"),
    from_columns: ["status"],
    to_table_id: await tableId(id, "customers"),
    to_columns: ["region"],
    to_many: false,
    ...overrides,
  });
  const post = async (
    overrides: Record<string, unknown> = {},
    id = sourceId
  ) => {
    const res = await call(
      "POST",
      `/${id}/relations`,
      writeToken(),
      await declare(overrides, id)
    );
    if (res.status === 201) relations.push(res.body.id);
    return res;
  };

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await newSource();
    otherId = await newSource();
  });
  afterAll(async () => {
    await removeAuditRows(relations);
    await removeSources(created);
    await app.close();
  });

  describe("GET /", () => {
    it("lists the four discovered relations of the sales schema", async () => {
      const res = await call("GET", `/${sourceId}/relations`, readToken());
      expect(res.status).toBe(200);
      const discovered = res.body.data.filter(
        (r: { origin: string }) => r.origin === "discovered"
      );
      expect(discovered).toHaveLength(4);
      expect(res.body.data[0]).toEqual({
        id: expect.any(String),
        name: expect.any(String),
        from_table_id: expect.any(String),
        from_columns: expect.any(Array),
        to_table_id: expect.any(String),
        to_columns: expect.any(Array),
        to_many: expect.any(Boolean),
        origin: expect.any(String),
        missing_since: null,
      });
    });

    it("pages with limit and cursor, and never lists another source's relations", async () => {
      const seen: string[] = [];
      let cursor = "";
      for (let i = 0; i < 10; i++) {
        const res = await call(
          "GET",
          `/${otherId}/relations?limit=3${cursor && `&cursor=${cursor}`}`
        );
        expect(res.status).toBe(200);
        seen.push(...res.body.data.map((r: { id: string }) => r.id));
        if (!res.body.next_cursor) break;
        cursor = res.body.next_cursor;
      }
      const stored = await prisma.relation.findMany({
        where: { sourceId: otherId },
      });
      expect(seen.sort()).toEqual(stored.map((r) => r.id).sort());
      expect(
        (await call("GET", `/${otherId}/relations?cursor=garbage`)).status
      ).toBe(400);
    });
  });

  describe("POST /", () => {
    it("declares a relation, shows it on its from table and records an audit entry", async () => {
      const res = await post();
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "by_region",
        from_columns: ["status"],
        to_columns: ["region"],
        to_many: false,
        origin: "declared",
        missing_since: null,
      });

      const view = await call(
        "GET",
        `/${sourceId}/tables/${res.body.from_table_id}`
      );
      expect(
        view.body.relations.find((r: { id: string }) => r.id === res.body.id)
      ).toMatchObject({ name: "by_region", origin: "declared" });
      expect(
        (
          await call("GET", `/${sourceId}/tables/${res.body.to_table_id}`)
        ).body.relations.some((r: { id: string }) => r.id === res.body.id)
      ).toBe(false);

      const entries = await auditRows(res.body.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].payload).toMatchObject({
        action: "CREATE",
        entityType: "relation",
        metadata: {
          event: "zeteo.relation.declared",
          source_id: sourceId,
          name: "by_region",
        },
      });
    });

    it("answers 403 to a read-only caller before looking at the body", async () => {
      const res = await call("POST", `/${sourceId}/relations`, readToken(), {});
      expect(res.status).toBe(403);
    });

    it("answers 400 for a malformed body", async () => {
      for (const overrides of [
        { name: "Bad Name" },
        { name: "1abc" },
        { name: "a".repeat(64) },
        { from_columns: [] },
        { to_columns: [] },
        { from_table_id: "nope" },
        { to_many: "yes" },
        { extra: 1 },
      ]) {
        const res = await post(overrides);
        expect(res.status, JSON.stringify(overrides)).toBe(400);
      }
      expect(
        (await post({ name: "a".repeat(63) })).status,
        "63 characters is the longest name"
      ).toBe(201);
    });

    it.each([
      [
        "a from table in another source",
        async () => ({ from_table_id: await tableId(otherId, "orders") }),
      ],
      [
        "a to table in another source",
        async () => ({ to_table_id: await tableId(otherId, "customers") }),
      ],
      ["an unknown table", async () => ({ to_table_id: randomUUID() })],
      [
        "a from column that does not exist",
        async () => ({ from_columns: ["nope"] }),
      ],
      [
        "a to column that does not exist",
        async () => ({ to_columns: ["nope"] }),
      ],
      [
        "different column counts",
        async () => ({ from_columns: ["status", "total"] }),
      ],
      [
        "paired columns of different types",
        async () => ({ from_columns: ["total"] }),
      ],
      [
        "a column of type other",
        async () => ({
          from_table_id: await tableId(sourceId, "blobs"),
          from_columns: ["data"],
          to_columns: ["data"],
          to_table_id: await tableId(sourceId, "blobs"),
        }),
      ],
      [
        "a repeated column",
        async () => ({
          from_columns: ["status", "status"],
          to_columns: ["region", "name"],
        }),
      ],
    ])("answers 422 invalid_relation for %s", async (_, overrides) => {
      const res = await post(await overrides(), sourceId);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("invalid_relation");
      expect(res.body.error_description).toEqual(expect.any(String));
    });

    it("answers 422 for a missing column and for a json column", async () => {
      const id = await newSource();
      const orders = await tableId(id, "orders");
      const customers = await tableId(id, "customers");
      await prisma.sourceColumn.updateMany({
        where: { tableId: orders, name: "status" },
        data: { missingSince: new Date() },
      });
      await prisma.sourceColumn.updateMany({
        where: { tableId: customers, name: "name" },
        data: { type: "json" },
      });
      await prisma.sourceColumn.updateMany({
        where: { tableId: orders, name: "notes" },
        data: { type: "json" },
      });
      const body = {
        name: "r",
        from_table_id: orders,
        from_columns: ["status"],
        to_table_id: customers,
        to_columns: ["region"],
        to_many: false,
      };
      const missing = await call(
        "POST",
        `/${id}/relations`,
        writeToken(),
        body
      );
      expect(missing.status).toBe(422);
      expect(missing.body.error).toBe("invalid_relation");
      const json = await call("POST", `/${id}/relations`, writeToken(), {
        ...body,
        from_columns: ["notes"],
        to_columns: ["name"],
      });
      expect(json.status).toBe(422);
      expect(json.body.error).toBe("invalid_relation");
    });

    it("answers 409 relation_name_taken for a name already on the from table, discovered or declared", async () => {
      const first = await post({ name: "dup" });
      expect(first.status).toBe(201);
      const again = await post({ name: "dup" });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("relation_name_taken");
      const discovered = await post({ name: "customer" });
      expect(discovered.status).toBe(409);
      expect(discovered.body.error).toBe("relation_name_taken");
      // Another table may reuse the name.
      const elsewhere = await post({
        name: "dup",
        from_table_id: await tableId(sourceId, "customers"),
        from_columns: ["region"],
        to_table_id: await tableId(sourceId, "orders"),
        to_columns: ["status"],
      });
      expect(elsewhere.status).toBe(201);
    });

    it("answers 409 for two concurrent declarations of one name, never a 500", async () => {
      const results = await Promise.all(
        [1, 2, 3].map(() => post({ name: "racing" }))
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });

    it("answers 404 for an unknown source and 409 for an archived one", async () => {
      expect(
        (
          await call(
            "POST",
            `/${randomUUID()}/relations`,
            writeToken(),
            await declare()
          )
        ).status
      ).toBe(404);
      const id = await newSource();
      await call("POST", `/${id}/archive`);
      const res = await call("POST", `/${id}/relations`, writeToken(), {
        name: "late",
        from_table_id: await tableId(id, "orders"),
        from_columns: ["status"],
        to_table_id: await tableId(id, "customers"),
        to_columns: ["region"],
        to_many: false,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("source_archived");
    });
  });

  describe("DELETE /:relationId", () => {
    it("removes a declared relation with 204 and records an audit entry", async () => {
      const made = await post({ name: "to_delete" });
      const res = await call(
        "DELETE",
        `/${sourceId}/relations/${made.body.id}`
      );
      expect(res.status).toBe(204);
      expect(await prisma.relation.count({ where: { id: made.body.id } })).toBe(
        0
      );
      const entries = await auditRows(made.body.id);
      expect(entries.at(-1)?.payload).toMatchObject({
        action: "DELETE",
        entityType: "relation",
        metadata: { event: "zeteo.relation.removed", source_id: sourceId },
      });
      expect(
        (await call("DELETE", `/${sourceId}/relations/${made.body.id}`)).status
      ).toBe(404);
    });

    it("answers 409 relation_discovered for a discovered relation and keeps it", async () => {
      const found = await prisma.relation.findFirstOrThrow({
        where: { sourceId, origin: "discovered" },
      });
      const res = await call("DELETE", `/${sourceId}/relations/${found.id}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("relation_discovered");
      expect(await prisma.relation.count({ where: { id: found.id } })).toBe(1);
    });

    it("answers 404 for a relation of another source, leaving it in place", async () => {
      const other = await post({ name: "elsewhere" }, otherId);
      const res = await call(
        "DELETE",
        `/${sourceId}/relations/${other.body.id}`
      );
      expect(res.status).toBe(404);
      expect(
        await prisma.relation.count({ where: { id: other.body.id } })
      ).toBe(1);
    });

    it("answers 403 to a read-only caller, 400 to a malformed id and 409 for an archived source", async () => {
      const made = await post({ name: "guarded" });
      expect(
        (
          await call(
            "DELETE",
            `/${sourceId}/relations/${made.body.id}`,
            readToken()
          )
        ).status
      ).toBe(403);
      expect((await call("DELETE", `/${sourceId}/relations/nope`)).status).toBe(
        400
      );
      const id = await newSource();
      const other = await post({ name: "in_archived" }, id);
      await call("POST", `/${id}/archive`);
      const res = await call("DELETE", `/${id}/relations/${other.body.id}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("source_archived");
    });
  });
});
