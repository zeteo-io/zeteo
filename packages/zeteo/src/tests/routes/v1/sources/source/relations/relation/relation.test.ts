// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../../support/v1App.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  auditRows,
  readToken,
  removeAuditRows,
  removeSources,
  sourceBody,
  sourceSettings,
  writeToken,
} from "../../../../../../support/sources.js";

describe("/v1/sources/:sourceId/relations/:relationId", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const created: string[] = [];
  const declared: string[] = [];
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
  const discovered = async (id: string, from: string, name: string) =>
    prisma.relation.findFirstOrThrow({
      where: {
        sourceId: id,
        origin: "discovered",
        fromTableId: await tableId(id, from),
        name,
      },
    });
  const rename = (id: string, relationId: string, body: unknown) =>
    call("PATCH", `/${id}/relations/${relationId}`, writeToken(), body);

  beforeAll(async () => {
    app = await startV1Routes();
    otherId = await newSource();
  });
  // Renaming changes the catalogue, so each test gets a source of its own.
  beforeEach(async () => {
    sourceId = await newSource();
  });
  afterAll(async () => {
    await removeAuditRows(declared);
    await removeSources(created);
    await app.close();
  });

  describe("PATCH /", () => {
    it("renames a discovered relation, locks its name and records an audit entry", async () => {
      const found = await discovered(sourceId, "orders", "customers");
      expect(found.nameLocked).toBe(false);
      const res = await rename(sourceId, found.id, { name: "buyer" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: found.id,
        name: "buyer",
        from_table_id: found.fromTableId,
        from_columns: found.fromColumns,
        to_table_id: found.toTableId,
        to_columns: found.toColumns,
        to_many: false,
        origin: "discovered",
        missing_since: null,
      });
      expect(
        (await prisma.relation.findUniqueOrThrow({ where: { id: found.id } }))
          .nameLocked
      ).toBe(true);
      const entries = await auditRows(found.id);
      expect(entries.at(-1)?.payload).toMatchObject({
        action: "UPDATE",
        entityType: "relation",
        metadata: {
          event: "zeteo.relation.renamed",
          source_id: sourceId,
          name: "buyer",
          previous_name: "customers",
        },
      });
      await removeAuditRows([found.id]);
    });

    it("renames a declared relation", async () => {
      const made = await call("POST", `/${sourceId}/relations`, writeToken(), {
        name: "by_region",
        from_table_id: await tableId(sourceId, "orders"),
        from_columns: ["status"],
        to_table_id: await tableId(sourceId, "customers"),
        to_columns: ["region"],
        to_many: false,
      });
      expect(made.status).toBe(201);
      declared.push(made.body.id);
      const res = await rename(sourceId, made.body.id, { name: "by_area" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: made.body.id,
        name: "by_area",
        origin: "declared",
      });
      expect(
        (
          await prisma.relation.findUniqueOrThrow({
            where: { id: made.body.id },
          })
        ).nameLocked
      ).toBe(false);
    });

    it("answers 200 when the name is the relation's own", async () => {
      const found = await discovered(sourceId, "customers", "orders");
      const res = await rename(sourceId, found.id, { name: "orders" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("orders");
    });

    it("answers 401 without a token and 403 to a read-only caller", async () => {
      const found = await discovered(sourceId, "customers", "accounts");
      const path = `/${sourceId}/relations/${found.id}`;
      expect((await call("PATCH", path, null, { name: "x" })).status).toBe(401);
      expect(
        (await call("PATCH", path, readToken(), { name: "x" })).status
      ).toBe(403);
    });

    it("answers 400 with the field named for an invalid name or body", async () => {
      const found = await discovered(sourceId, "order_lines", "orders");
      for (const body of [
        { name: "Bad Name" },
        { name: "1abc" },
        { name: "a".repeat(64) },
        { name: "" },
        {},
        { name: "ok", extra: 1 },
      ]) {
        const res = await rename(sourceId, found.id, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      const res = await rename(sourceId, found.id, { name: "Bad Name" });
      expect(res.body.issues.map((i: { path: string }) => i.path)).toEqual([
        "name",
      ]);
      expect(
        (await rename(sourceId, found.id, { name: "a".repeat(63) })).status
      ).toBe(200);
      expect(
        (
          await call("PATCH", `/${sourceId}/relations/nope`, writeToken(), {
            name: "x",
          })
        ).status
      ).toBe(400);
    });

    it("answers 409 relation_name_taken for a name on the same from table, and allows it on another", async () => {
      const toCustomers = await discovered(sourceId, "orders", "customers");
      const toLines = await discovered(sourceId, "orders", "order_lines");
      const taken = await rename(sourceId, toCustomers.id, {
        name: "order_lines",
      });
      expect(taken.status).toBe(409);
      expect(taken.body.error).toBe("relation_name_taken");
      expect(
        (
          await prisma.relation.findUniqueOrThrow({
            where: { id: toCustomers.id },
          })
        ).name
      ).toBe("customers");
      // `orders` is on customers and order_lines; another table may reuse it.
      const elsewhere = await rename(sourceId, toLines.id, { name: "orders" });
      expect(elsewhere.status).toBe(200);
    });

    it("answers 404 for an unknown relation and for one of another source", async () => {
      expect((await rename(sourceId, randomUUID(), { name: "x" })).status).toBe(
        404
      );
      const other = await discovered(otherId, "orders", "customers");
      const res = await rename(sourceId, other.id, { name: "x" });
      expect(res.status).toBe(404);
      expect(
        (await prisma.relation.findUniqueOrThrow({ where: { id: other.id } }))
          .name
      ).toBe("customers");
    });

    it("answers 409 source_archived for an archived source", async () => {
      const id = await newSource();
      const found = await discovered(id, "orders", "customers");
      await call("POST", `/${id}/archive`);
      const res = await rename(id, found.id, { name: "late" });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("source_archived");
    });
  });
});
