// @module-tag int
// @module-tag platform
// @module-tag security
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { TEST_MCP_CLIENT, TEST_MCP_ORIGIN } from "../setup/testEnv.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BASE_URL, fetchJson } from "../support/http.js";
import { tokenFor } from "../support/tokens.js";
import { randomUUID } from "crypto";
import type { Server } from "http";
import {
  callTool,
  connectMcp,
  initializeBody,
  mcpPostHeaders,
  mcpToken,
  rawRequest,
} from "../support/mcp.js";

const TOOLS = ["describe_table", "list_sources", "list_tables", "query"];
const RESOURCE_METADATA = `${BASE_URL}/.well-known/oauth-protected-resource/mcp`;

describe("MCP endpoint", () => {
  it("answers 401 without a token, naming the resource metadata", async () => {
    const { Authorization: _none, ...headers } = mcpPostHeaders("");
    const res = await rawRequest("POST", "/mcp", headers, initializeBody);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain(
      `resource_metadata="${RESOURCE_METADATA}"`
    );
  });

  it("serves the protected-resource metadata naming this endpoint", async () => {
    const res = await fetchJson("GET", RESOURCE_METADATA, null);
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(`${BASE_URL}/mcp`);
    expect(res.body.authorization_servers).toHaveLength(1);
  });

  it("refuses a token issued to a client not in MCP_ALLOWED_CLIENTS", async () => {
    const token = tokenFor({
      permissions: [MCP_USE, DATA_READ],
      client: "some-other-client",
    });
    const res = await rawRequest(
      "POST",
      "/mcp",
      mcpPostHeaders(token),
      initializeBody
    );
    expect(res.status).toBe(401);
  });

  it("refuses a service account's token, even from an allowed client", async () => {
    // A token whose subject is its client is a service account's.
    const token = tokenFor({
      userId: TEST_MCP_CLIENT,
      permissions: [MCP_USE, DATA_READ],
      client: TEST_MCP_CLIENT,
    });
    const res = await rawRequest(
      "POST",
      "/mcp",
      mcpPostHeaders(token),
      initializeBody
    );
    expect(res.status).toBe(401);
  });

  it("lists no tools to a user without zeteo.mcp.use, even with zeteo.data.read", async () => {
    const session = await connectMcp(mcpToken([DATA_READ]));
    try {
      const { tools } = await session.client.listTools();
      expect(tools).toEqual([]);
      // Calling a tool they lack fails as calling one that does not exist.
      const message = async (name: string) =>
        (await callTool(session.client, name).then(
          () => "answered",
          (err: Error) => err.message
        )) as string;
      expect(await message("list_sources")).toBe(
        (await message("no_such_tool")).replace("no_such_tool", "list_sources")
      );
    } finally {
      await session.close();
    }
  });

  it("lists the read-only tools to a user with zeteo.mcp.use and refuses each call without zeteo.data.read", async () => {
    const session = await connectMcp(mcpToken([MCP_USE]));
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
      const args: Record<string, Record<string, unknown>> = {
        list_sources: {},
        list_tables: { source: "anything" },
        describe_table: { source: "anything", table: "anything" },
        query: { source: "anything", from: "anything", select: ["x"] },
      };
      for (const name of TOOLS) {
        const call = await callTool(session.client, name, args[name]);
        expect(call.isError).toBe(true);
        expect(call.json).toEqual({
          error: "forbidden",
          error_description: "Requires the zeteo.data.read permission",
          request_id: expect.any(String),
        });
      }
    } finally {
      await session.close();
    }
  });

  it("refuses a Host other than PUBLIC_URL's on the endpoint and its metadata, but not on /health", async () => {
    const token = mcpToken([MCP_USE, DATA_READ]);
    const endpoint = await rawRequest(
      "POST",
      "/mcp",
      { ...mcpPostHeaders(token), Host: "evil.example.com" },
      initializeBody
    );
    expect(endpoint.status).toBe(403);
    const metadata = await rawRequest(
      "GET",
      "/.well-known/oauth-protected-resource/mcp",
      { Host: "evil.example.com" }
    );
    expect(metadata.status).toBe(403);
    const health = await rawRequest("GET", "/health", {
      Host: "evil.example.com",
    });
    expect(health.status).toBe(200);
  });

  it("does not apply the Host check to /v1", async () => {
    const res = await rawRequest("GET", "/v1/catalog", {
      Authorization: `Bearer ${tokenFor({ permissions: [DATA_READ] })}`,
      Host: "evil.example.com",
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sources: [] });
  });

  it("refuses an Origin not in MCP_ALLOWED_ORIGINS, and accepts a listed one", async () => {
    const token = mcpToken([MCP_USE, DATA_READ]);
    const refused = await rawRequest(
      "POST",
      "/mcp",
      { ...mcpPostHeaders(token), Origin: "https://evil.example.com" },
      initializeBody
    );
    expect(refused.status).toBe(403);
    const accepted = await rawRequest(
      "POST",
      "/mcp",
      { ...mcpPostHeaders(token), Origin: TEST_MCP_ORIGIN },
      initializeBody
    );
    expect(accepted.status).toBe(200);
  });

  it("refuses a body over 64 kb with 413", async () => {
    const token = mcpToken([MCP_USE, DATA_READ]);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { padding: "x".repeat(70 * 1024) },
    });
    const res = await rawRequest("POST", "/mcp", mcpPostHeaders(token), body);
    expect(res.status).toBe(413);
  });

  it("answers a malformed body with zeteo's JSON error, not an HTML page", async () => {
    const token = mcpToken([MCP_USE, DATA_READ]);
    const res = await rawRequest(
      "POST",
      "/mcp",
      mcpPostHeaders(token),
      "{not json"
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_request" });
  });
});

describe("createMcpRouter", () => {
  it("returns null and says MCP is off when MCP_ALLOWED_CLIENTS is empty", async () => {
    const { createMcpRouter } = await import("../../mcp/index.js");
    const { logger } = await import("../../utils/logger.js");
    const { default: env } = await import("../../env.js");
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const allowed = env.MCP_ALLOWED_CLIENTS;
    env.MCP_ALLOWED_CLIENTS = [];
    try {
      expect(await createMcpRouter()).toBeNull();
      expect(info).toHaveBeenCalledWith(
        "MCP is off: MCP_ALLOWED_CLIENTS is empty"
      );
    } finally {
      env.MCP_ALLOWED_CLIENTS = allowed;
      info.mockRestore();
    }
  });
});

describe("MCP off", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const { createApp } = await import("../../app.js");
    const app = createApp(null);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    url = `http://localhost:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it("serves no /mcp and no protected-resource metadata when MCP_ALLOWED_CLIENTS is empty", async () => {
    const token = mcpToken([MCP_USE, DATA_READ], randomUUID());
    const endpoint = await fetchJson("POST", `${url}/mcp`, token, {});
    expect(endpoint.status).toBe(404);
    expect(endpoint.body.error).toBe("not_found");
    const metadata = await fetchJson(
      "GET",
      `${url}/.well-known/oauth-protected-resource/mcp`,
      null
    );
    expect(metadata.status).toBe(404);
  });
});
