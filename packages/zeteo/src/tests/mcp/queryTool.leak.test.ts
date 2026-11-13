// @module-tag int
// @module-tag platform
// @module-tag security
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { describeEachEngine } from "../support/engines.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
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

// The caller holds two columns of `orders` (id and status). Every other name
// must fail exactly as a name that does not exist.

const UNGRANTED_COLUMNS = ["customer_id", "total", "notes"];
/** Not a column of any fixture table, and far from every name in it. */
const INVENTED = "zzqxw";

/** Each place a column can be named, as a query over `orders`. */
const POSITIONS: Array<[string, (column: string) => Record<string, unknown>]> =
  [
    ["select", (c) => ({ select: ["id", c] })],
    ["an aggregate", (c) => ({ select: [{ max: c }] })],
    ["a bucket", (c) => ({ select: [{ bucket: "day", column: c }] })],
    ["where", (c) => ({ select: ["id"], where: { [c]: { isNull: true } } })],
    [
      "a nested where",
      (c) => ({
        select: ["id"],
        where: { or: [{ id: { eq: 1 } }, { not: { [c]: { isNull: true } } }] },
      }),
    ],
    ["orderBy", (c) => ({ select: ["id"], orderBy: [{ [c]: "asc" }] })],
  ];

/** The tool error with the echoed name and the request id taken out. */
const shapeOf = (call: ToolOutcome, name: string) => {
  expect(call.isError).toBe(true);
  const { request_id: id, ...rest } = call.json as Record<string, unknown>;
  expect(id).toEqual(expect.any(String));
  return JSON.parse(JSON.stringify(rest).split(name).join("<name>"));
};

describeEachEngine("MCP query tool: leaks", (engine) => {
  let source: SeededSource;
  let other: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "mcpleak");
    other = await seedQuerySource(engine, {}, "zzhidden");
    await grantTo({ type: "user", id: userId }, source.tables.orders!, [
      "id",
      "status",
    ]);
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeRunsOf([userId]);
    await removeSources([source.id, other.id]);
  });

  const query = (body: Record<string, unknown>) =>
    callTool(session.client, "query", {
      source: source.slug,
      from: "orders",
      ...body,
    });

  it("answers the granted columns", async () => {
    const call = await query({
      select: ["id", "status"],
      where: { id: { eq: 4 } },
    });
    expect(call.isError).toBe(false);
    expect(call.json.rows).toEqual([[4, "paid"]]);
  });

  for (const [position, build] of POSITIONS) {
    it.each(UNGRANTED_COLUMNS)(
      `refuses ungranted %s in ${position} exactly as an invented name`,
      async (column) => {
        const ungranted = await query(build(column));
        const invented = await query(build(INVENTED));
        expect(ungranted.json.error).toBe("not_found_or_not_accessible");
        expect(invented.json.error).toBe("not_found_or_not_accessible");
        expect(shapeOf(ungranted, column)).toEqual(shapeOf(invented, INVENTED));
      }
    );
  }

  // groupBy names select items, never catalogue columns: a name there is
  // refused before any lookup, the same way whether it exists or not.
  it.each(UNGRANTED_COLUMNS)(
    "refuses ungranted %s in groupBy, which names only select items, exactly as an invented name",
    async (column) => {
      const build = (c: string) => ({ select: ["id"], groupBy: [c] });
      const ungranted = await query(build(column));
      const invented = await query(build(INVENTED));
      expect(ungranted.json.error).toBe("invalid_grouping");
      expect(shapeOf(ungranted, column)).toEqual(shapeOf(invented, INVENTED));
    }
  );

  it("refuses an ungranted table exactly as an invented one", async () => {
    const ungranted = await query({ from: "customers", select: ["id"] });
    const invented = await query({ from: "zzqxwtable", select: ["id"] });
    expect(ungranted.json.error).toBe("not_found_or_not_accessible");
    expect(shapeOf(ungranted, "customers")).toEqual(
      shapeOf(invented, "zzqxwtable")
    );
  });

  it("refuses a source without grants exactly as an unknown one", async () => {
    const body = { from: "orders", select: ["id"] };
    const ungranted = await callTool(session.client, "query", {
      source: other.slug,
      ...body,
    });
    const unknown = await callTool(session.client, "query", {
      source: "invented-zzqxw",
      ...body,
    });
    expect(ungranted.json).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["source"],
      suggestions: [],
    });
    expect(shapeOf(ungranted, other.slug)).toEqual(
      shapeOf(unknown, "invented-zzqxw")
    );
  });
});
