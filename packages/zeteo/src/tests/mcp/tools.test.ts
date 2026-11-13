// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import { randomUUID } from "crypto";
import {
  grantTo,
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

describe("MCP discovery tools", () => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(postgres, { row_cap: 2000 }, "mcp-tools");
    const principal = { type: "user" as const, id: userId };
    await grantTo(principal, source.tables.orders!, [
      "id",
      "customer_id",
      "status",
    ]);
    await grantTo(principal, source.tables.customers!, ["id", "region"]);
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeSources([source.id]);
  });

  it("list_sources lists the granted source with its table count and MCP limits", async () => {
    const call = await callTool(session.client, "list_sources");
    expect(call.isError).toBe(false);
    expect(call.json.sources).toHaveLength(1);
    const [listed] = call.json.sources;
    expect(listed).toEqual({
      slug: source.slug,
      name: "Sales",
      type: "postgres",
      language: expect.any(String),
      tables: 2,
      limits: {
        default_rows: 100,
        // The profile's 5,000, under the source's own cap.
        max_rows: 2000,
        timeout_ms: expect.any(Number),
      },
    });
  });

  it("list_tables lists exactly the granted tables, each with its granted column count", async () => {
    const call = await callTool(session.client, "list_tables", {
      source: source.slug,
    });
    expect(call.isError).toBe(false);
    expect(call.json).toEqual({
      source: source.slug,
      tables: [
        {
          name: "customers",
          schema_name: "sales",
          kind: "table",
          description: null,
          missing: false,
          columns: 2,
        },
        {
          name: "orders",
          schema_name: "sales",
          kind: "table",
          description: null,
          missing: false,
          columns: 3,
        },
      ],
    });
  });

  it("describe_table shows exactly the granted columns and the relations whose keys are granted", async () => {
    const call = await callTool(session.client, "describe_table", {
      source: source.slug,
      table: "orders",
    });
    expect(call.isError).toBe(false);
    expect(call.json).toEqual({
      source: source.slug,
      table: {
        name: "orders",
        schema_name: "sales",
        kind: "table",
        description: null,
        missing: false,
        columns: [
          {
            name: "id",
            type: "number",
            nullable: false,
            description: null,
            missing: false,
          },
          {
            name: "customer_id",
            type: "number",
            nullable: false,
            description: null,
            missing: false,
          },
          {
            name: "status",
            type: "text",
            nullable: false,
            description: null,
            missing: false,
          },
        ],
        relations: [
          { name: "customer", to: "customers", to_many: false, missing: false },
        ],
      },
    });
  });

  it("answers an unknown table with not_found_or_not_accessible, suggesting only visible names", async () => {
    const call = await callTool(session.client, "describe_table", {
      source: source.slug,
      table: "orderz",
    });
    expect(call.isError).toBe(true);
    expect(call.json).toEqual({
      error: "not_found_or_not_accessible",
      error_description: 'Table "orderz" was not found or is not accessible',
      path: ["table"],
      suggestions: ["orders"],
      request_id: expect.any(String),
    });
  });

  it("answers an unknown source the same way, suggesting the visible slug", async () => {
    const near = `${source.slug.slice(0, -1)}_`;
    const call = await callTool(session.client, "list_tables", {
      source: near,
    });
    expect(call.isError).toBe(true);
    expect(call.json).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["source"],
      suggestions: [source.slug],
    });
  });

  it("lists no sources to a user with no grants", async () => {
    const other = await connectMcp(mcpToken([MCP_USE, DATA_READ]));
    try {
      const call = await callTool(other.client, "list_sources");
      expect(call.json).toEqual({ sources: [] });
    } finally {
      await other.close();
    }
  });
});
