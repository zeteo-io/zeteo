// @module-tag int
// @module-tag platform
// @module-tag security
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { TABLE } from "../support/dashboards.js";
import { ENGINES } from "../support/engines.js";
import { randomUUID } from "crypto";
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
  type ToolOutcome,
} from "../support/mcp.js";

// preview_panel with a query that is not saved runs as the query tool does:
// a column the caller holds no grant on fails exactly as through `query`.

const postgres = ENGINES.find((e) => e.type === "postgres")!;

const withoutRequestId = (call: ToolOutcome) => {
  expect(call.isError).toBe(true);
  const { request_id: id, ...rest } = call.json as Record<string, unknown>;
  expect(id).toEqual(expect.any(String));
  return rest;
};

describe("MCP preview_panel with a query: leaks", () => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(postgres, {}, "mcppvleak");
    await grantTo({ type: "user", id: userId }, source.tables.orders!, [
      "id",
      "status",
    ]);
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it.each(["total", "zzqxw"])(
    "refuses %s (ungranted, then invented) exactly as the query tool does",
    async (column) => {
      const query = {
        source: source.slug,
        from: "orders",
        select: ["id", column],
      };
      const [preview, direct] = await Promise.all([
        callTool(session.client, "preview_panel", { query, chart: TABLE }),
        callTool(session.client, "query", query),
      ]);
      expect(preview.json.error).toBe("not_found_or_not_accessible");
      expect(withoutRequestId(preview)).toEqual(withoutRequestId(direct));
      expect(preview.text).not.toMatch(/"rows"|"columns"/);
    }
  );

  it("refuses an ungranted time_column as the query tool refuses it in where", async () => {
    const query = { source: source.slug, from: "orders", select: ["id"] };
    const preview = await callTool(session.client, "preview_panel", {
      query,
      chart: TABLE,
      time_column: "created_at",
      time_range: "last_30_days",
    });
    expect(withoutRequestId(preview).error).toBe("not_found_or_not_accessible");
  });
});
