// @module-tag int
// @module-tag platform
// @module-tag security
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, connectMcp, mcpToken } from "../support/mcp.js";
import {
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
  type NoAccessCase,
} from "../support/savedQueryCauses.js";

// A recipient who cannot run a saved query gets the same tool error for each
// of the six causes, with nothing of the query or its source.

describe("MCP saved query tools: six causes of no access", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  let cases: NoAccessCase[];
  const users: string[] = [];

  beforeAll(async () => {
    sources = await seedCauseSources({}, "mcpsqleak");
    users.push(sources.owner.id);
    cases = await setUpNoAccessCases(sources, sources.owner);
    users.push(...cases.map((c) => c.recipient.id));
  });
  afterAll(async () => {
    await removeNoAccessCases(sources, users);
  });

  it("answers run_saved_query identically for each cause", async () => {
    const bodies: unknown[] = [];
    for (const { cause, recipient, id } of cases) {
      const session = await connectMcp(
        mcpToken([MCP_USE, DATA_READ], recipient.id)
      );
      try {
        const call = await callTool(session.client, "run_saved_query", { id });
        expect(call.isError, cause).toBe(true);
        expect(call.json.error, cause).toBe("saved_query_not_accessible");
        expect(call.json.error_description, cause).toBe(
          "You need expanded permissions to run this saved query. Ask an admin to extend your access."
        );
        const { request_id: _r, ...rest } = call.json;
        bodies.push(rest);
      } finally {
        await session.close();
      }
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    const text = JSON.stringify(bodies);
    for (const on of [sources.source, sources.archived, sources.missing]) {
      expect(text).not.toContain(on.slug);
      expect(text).not.toContain(on.id);
    }
    expect(text).not.toMatch(/orders|customers|"path"|candidates/);
  });

  it("get_saved_query shows no query or source to a recipient without access", async () => {
    for (const { cause, recipient, id } of cases) {
      const session = await connectMcp(
        mcpToken([MCP_USE, DATA_READ], recipient.id)
      );
      try {
        const call = await callTool(session.client, "get_saved_query", { id });
        expect(call.isError, cause).toBe(false);
        expect(call.json.accessible, cause).toBe(false);
        expect(call.json, cause).not.toHaveProperty("query");
        expect(call.json, cause).not.toHaveProperty("source");
        expect(call.json.owner, cause).not.toHaveProperty("id");
      } finally {
        await session.close();
      }
    }
  });
});
