// @module-tag int
// @module-tag platform
// @module-tag security
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { prisma } from "../../utils/db/prisma.js";
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

/** The error with the echoed name and the request id taken out. */
const normalised = (text: string, name: string): string => {
  const { request_id: _id, ...rest } = JSON.parse(text) as Record<
    string,
    unknown
  >;
  return JSON.stringify(rest).split(name).join("<name>");
};

/** Every string value in a JSON value, at any depth; keys are left out. */
const stringValues = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringValues)
      : value !== null && typeof value === "object"
        ? Object.values(value).flatMap(stringValues)
        : [];

/** A name of the same length as `name` that nothing in the catalogue carries. */
const lookalike = (name: string): string =>
  `${name.slice(0, -8)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;

describe("MCP discovery tools: what the caller may not see", () => {
  let visible: SeededSource;
  let hidden: SeededSource;
  let session: McpSession;

  beforeAll(async () => {
    visible = await seedQuerySource(postgres, {}, "mcpseen");
    // A slug far from the visible one, so neither error carries a suggestion.
    hidden = await seedQuerySource(postgres, {}, "zzhidden");
    const userId = randomUUID();
    await grantTo({ type: "user", id: userId }, visible.tables.orders!, [
      "id",
      "status",
    ]);
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeSources([visible.id, hidden.id]);
  });

  it("answers an ungranted source and a nonexistent one with the same error", async () => {
    const missing = lookalike(hidden.slug);
    for (const [tool, extra] of [
      ["list_tables", {}],
      ["describe_table", { table: "orders" }],
    ] as const) {
      const ungranted = await callTool(session.client, tool, {
        source: hidden.slug,
        ...extra,
      });
      const nonexistent = await callTool(session.client, tool, {
        source: missing,
        ...extra,
      });
      expect(ungranted.isError).toBe(true);
      expect(ungranted.json.error).toBe("not_found_or_not_accessible");
      expect(normalised(ungranted.text, hidden.slug)).toBe(
        normalised(nonexistent.text, missing)
      );
    }
  });

  it("answers an ungranted table and a nonexistent one with the same error", async () => {
    const ungranted = await callTool(session.client, "describe_table", {
      source: visible.slug,
      table: "customers",
    });
    const nonexistent = await callTool(session.client, "describe_table", {
      source: visible.slug,
      table: "qustomers",
    });
    expect(ungranted.isError).toBe(true);
    expect(ungranted.json.error).toBe("not_found_or_not_accessible");
    expect(normalised(ungranted.text, "customers")).toBe(
      normalised(nonexistent.text, "qustomers")
    );
  });

  it("names no ungranted table, column or relation in any result", async () => {
    const results = [
      await callTool(session.client, "list_sources"),
      await callTool(session.client, "list_tables", { source: visible.slug }),
      await callTool(session.client, "describe_table", {
        source: visible.slug,
        table: "orders",
      }),
    ];
    for (const result of results) expect(result.isError).toBe(false);

    const sourceIds = [visible.id, hidden.id];
    const tables = await prisma.sourceTable.findMany({
      where: { sourceId: { in: sourceIds } },
      include: { columns: true },
    });
    const relations = await prisma.relation.findMany({
      where: { sourceId: { in: sourceIds } },
    });
    const granted = new Set(["orders", "id", "status"]);
    const ungranted = new Set(
      [
        ...tables.map((t) => t.name),
        ...tables.flatMap((t) => t.columns.map((c) => c.name)),
        ...relations.map((r) => r.name),
        hidden.slug,
      ].filter((name) => !granted.has(name))
    );
    expect(ungranted.size).toBeGreaterThan(10);

    // Values only: a key such as "name" may coincide with a column's name.
    const values = new Set(results.flatMap((r) => stringValues(r.json)));
    for (const name of ungranted) expect(values.has(name), name).toBe(false);
    const text = results.map((r) => r.text).join("\n");
    // Nor an id from the catalogue.
    for (const table of tables) {
      expect(text).not.toContain(table.id);
      for (const column of table.columns) expect(text).not.toContain(column.id);
    }
    expect(text).not.toContain(visible.id);
  });
});
