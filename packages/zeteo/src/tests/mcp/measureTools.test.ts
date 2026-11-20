// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measureUser, setEditors } from "../support/measures.js";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import { BASE_URL } from "../support/http.js";
import {
  DATA_READ,
  MCP_USE,
  MEASURES_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  grantTo,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";
import {
  callTool,
  connectMcp,
  mcpToken,
  type McpSession,
} from "../support/mcp.js";

const postgres = ENGINES.find((e) => e.type === "postgres")!;

describe("MCP measure and metric tools", () => {
  let source: SeededSource;
  let session: McpSession;
  const editor = measureUser();

  beforeAll(async () => {
    source = await seedQuerySource(postgres, {}, "mcpmeasures");
    for (const table of ["orders", "ad_spend"]) {
      await grantTo(editor.principal, source.tables[table]!, "all");
    }
    await setEditors(BASE_URL, source.id, [editor.principal]);
    session = await connectMcp(
      mcpToken([MCP_USE, DATA_READ, MEASURES_WRITE], editor.id)
    );
  });
  afterAll(async () => {
    await session?.close();
    await removeRunsOf([editor.id]);
    await removeSources([source.id]);
  });

  const call = (name: string, args: Record<string, unknown>) =>
    callTool(session.client, name, { source: source.slug, ...args });

  it("previews, creates, lists, changes and deletes a measure by name", async () => {
    const draft = {
      name: "paid_total",
      description: "Total of paid orders",
      table: "orders",
      formula: { sum: "total" },
      where: { status: { eq: "paid" } },
    };
    const preview = await call("preview_measure", draft);
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.json.columns).toEqual([
      { name: "paid_total", type: "number" },
    ]);
    expect(preview.json.rows).toHaveLength(1);

    const created = await call("create_measure", draft);
    expect(created.isError, created.text).toBe(false);
    expect(created.json).toMatchObject({
      name: "paid_total",
      table: "orders",
      formula: { sum: "total" },
      where: { status: { eq: "paid" } },
      fixed: false,
      date_column: null,
    });
    expect(created.json).not.toHaveProperty("id");

    const query = await callTool(session.client, "query", {
      source: source.slug,
      from: "orders",
      select: [{ measure: "paid_total" }],
    });
    expect(query.isError, query.text).toBe(false);
    expect(query.json.rows).toEqual(preview.json.rows);

    const listed = await call("list_measures", {});
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.json.can_edit).toBe(true);
    expect(listed.json.measures).toContainEqual(
      expect.objectContaining({
        name: "paid_total",
        used_by: { saved_queries: 0, panels: 0 },
      })
    );

    const changed = await call("update_measure", {
      measure: "paid_total",
      name: "order_total",
      where: null,
      date_column: "created_at",
    });
    expect(changed.isError, changed.text).toBe(false);
    expect(changed.json).toMatchObject({
      name: "order_total",
      where: null,
      date_column: "created_at",
    });

    const deleted = await call("delete_measure", { measure: "order_total" });
    expect(deleted.json).toEqual({ deleted: true });
    const after = await call("list_measures", {});
    expect(
      after.json.measures.map((m: { name: string }) => m.name)
    ).not.toContain("order_total");
  });

  it("previews and keeps a metric over two tables, and refuses deleting a measure it uses", async () => {
    for (const measure of [
      {
        name: "revenue",
        description: "Order totals",
        table: "orders",
        formula: { sum: "total" },
        date_column: "created_at",
      },
      {
        name: "spend",
        description: "Ad spend",
        table: "ad_spend",
        formula: { sum: "cost" },
        date_column: "day",
      },
    ]) {
      const res = await call("create_measure", measure);
      expect(res.isError, res.text).toBe(false);
    }
    const roas = {
      name: "roas",
      description: "Revenue per unit of ad spend",
      formula: { div: [{ measure: "revenue" }, { measure: "spend" }] },
    };
    const preview = await call("preview_metric", { ...roas, bucket: "month" });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.json.columns.map((c: { name: string }) => c.name)).toEqual([
      "period",
      "roas",
    ]);

    const created = await call("create_metric", roas);
    expect(created.isError, created.text).toBe(false);
    expect(created.json).toMatchObject({ name: "roas", formula: roas.formula });
    expect(created.json).not.toHaveProperty("id");

    const listed = await call("list_metrics", {});
    expect(listed.json.can_edit).toBe(true);
    expect(listed.json.metrics.map((m: { name: string }) => m.name)).toEqual([
      "roas",
    ]);

    const refused = await call("delete_measure", { measure: "spend" });
    expect(refused.isError).toBe(true);
    expect(refused.json).toMatchObject({
      error: "measure_in_use",
      dependents: [{ kind: "metric", name: "roas" }],
    });

    const changed = await call("update_metric", {
      metric: "roas",
      description: "Return on ad spend",
    });
    expect(changed.json).toMatchObject({ description: "Return on ad spend" });
    expect((await call("delete_metric", { metric: "roas" })).json).toEqual({
      deleted: true,
    });
    expect((await call("delete_measure", { measure: "spend" })).json).toEqual({
      deleted: true,
    });
  });

  it("checks arguments with the API's schemas, at the same paths", async () => {
    const res = await call("create_measure", {
      name: "Bad Name",
      description: "x",
      table: "orders",
      formula: { sum: "total" },
    });
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe("invalid_request");
    expect(res.json.issues).toContainEqual(
      expect.objectContaining({ path: "name" })
    );
  });

  it("reports a plan error in a draft formula with its path", async () => {
    const res = await call("preview_measure", {
      name: "nope",
      description: "x",
      table: "orders",
      formula: { sum: "no_such_column" },
    });
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe("not_found_or_not_accessible");
  });
});
