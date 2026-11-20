// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import { BASE_URL } from "../support/http.js";
import {
  DATA_READ,
  MCP_USE,
  MEASURES_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  measureBody,
  measureUser,
  seedMeasures,
  setEditors,
} from "../support/measures.js";
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

const withoutRequestId = (json: Record<string, unknown>) => {
  const { request_id: _id, ...rest } = json;
  return rest;
};

describe("MCP measure tools: who may change what", () => {
  let source: SeededSource;
  // An editor granted only orders.id and status: the total is not theirs.
  const partial = measureUser();
  // Holds zeteo.measures.write but is not on the editor list.
  const outsider = measureUser();
  const reader = measureUser();
  const sessions: McpSession[] = [];
  const connect = async (permissions: string[], userId: string) => {
    const session = await connectMcp(mcpToken(permissions, userId));
    sessions.push(session);
    return session;
  };
  const WRITE = [MCP_USE, DATA_READ, MEASURES_WRITE];

  beforeAll(async () => {
    source = await seedQuerySource(postgres, {}, "mcpmeasureleak");
    await seedMeasures(BASE_URL, source, [
      measureBody("total_revenue", { sum: "total" }),
    ]);
    await grantTo(partial.principal, source.tables.orders!, ["id", "status"]);
    await grantTo(outsider.principal, source.tables.orders!, "all");
    await grantTo(reader.principal, source.tables.orders!, "all");
    await setEditors(BASE_URL, source.id, [partial.principal]);
  });
  afterAll(async () => {
    await Promise.all(sessions.map((s) => s.close()));
    await removeRunsOf([partial.id, outsider.id, reader.id]);
    await removeSources([source.id]);
  });

  it("refuses every change without zeteo.measures.write", async () => {
    const session = await connect([MCP_USE, DATA_READ], reader.id);
    for (const [tool, args] of [
      [
        "create_measure",
        {
          name: "x",
          description: "x",
          table: "orders",
          formula: { sum: "total" },
        },
      ],
      ["update_measure", { measure: "total_revenue", name: "y" }],
      ["delete_measure", { measure: "total_revenue" }],
      [
        "create_metric",
        { name: "x", description: "x", formula: { measure: "total_revenue" } },
      ],
      ["delete_metric", { metric: "x" }],
    ] as const) {
      const res = await callTool(session.client, tool, {
        source: source.slug,
        ...args,
      });
      expect(res.isError, tool).toBe(true);
      expect(withoutRequestId(res.json), tool).toEqual({
        error: "forbidden",
        error_description: `Requires the ${MEASURES_WRITE} permission`,
      });
    }
    // Reading stays open to whoever may query.
    const listed = await callTool(session.client, "list_measures", {
      source: source.slug,
    });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.json.can_edit).toBe(false);
  });

  it("refuses a writer who is not one of the source's editors", async () => {
    const session = await connect(WRITE, outsider.id);
    const res = await callTool(session.client, "create_measure", {
      source: source.slug,
      name: "mine",
      description: "x",
      table: "orders",
      formula: { count: "*" },
    });
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe("forbidden");
  });

  it("answers a measure the editor cannot fully see as one that does not exist", async () => {
    const session = await connect(WRITE, partial.id);
    const listed = await callTool(session.client, "list_measures", {
      source: source.slug,
    });
    expect(listed.json.measures).toEqual([
      {
        name: "total_revenue",
        description: "The total revenue",
        table: "orders",
        usable: false,
      },
    ]);
    for (const tool of ["update_measure", "delete_measure"]) {
      const hidden = await callTool(session.client, tool, {
        source: source.slug,
        measure: "total_revenue",
        ...(tool === "update_measure" && { name: "renamed" }),
      });
      const missing = await callTool(session.client, tool, {
        source: source.slug,
        measure: "no_such_measure",
        ...(tool === "update_measure" && { name: "renamed" }),
      });
      expect(hidden.isError, tool).toBe(true);
      expect(withoutRequestId(hidden.json), tool).toEqual(
        withoutRequestId(missing.json)
      );
    }
  });

  it("answers an unknown source as a source the caller cannot edit", async () => {
    const session = await connect(WRITE, outsider.id);
    const args = {
      name: "x",
      description: "x",
      table: "orders",
      formula: { count: "*" },
    };
    const unknown = await callTool(session.client, "create_measure", {
      source: "no-such-source",
      ...args,
    });
    const notEditor = await callTool(session.client, "create_measure", {
      source: source.slug,
      ...args,
    });
    expect(unknown.isError).toBe(true);
    expect(withoutRequestId(unknown.json)).toEqual(
      withoutRequestId(notEditor.json)
    );
  });
});
