import { describe, expect, inject, it } from "vitest";
import { CLIENTS, stack } from "../support/stack.js";
import { expectJson } from "../support/http.js";
import { signIn } from "../support/oauth.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const e2e = inject("e2e");

const initialize = (token?: string) =>
  fetch(`${stack.zeteoUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0.0.0" },
      },
    }),
  });

/**
 * What an MCP client does: from the 401 challenge to the resource metadata,
 * from there to Tereo's authorization server metadata, then a sign-in through
 * the connector's login client. Returns the access token.
 */
const signInAsMcpClient = async (email: string): Promise<string> => {
  const challenge = await initialize();
  const header = challenge.headers.get("www-authenticate") ?? "";
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
  if (!metadataUrl) throw new Error(`no resource_metadata in ${header}`);
  const resource = await expectJson(200, "GET", metadataUrl);
  const [issuer] = resource.authorization_servers as string[];
  const server = await expectJson(
    200,
    "GET",
    `${issuer}/.well-known/oauth-authorization-server`
  );
  return signIn({
    client: CLIENTS.mcp,
    email,
    authorizationEndpoint: server.authorization_endpoint,
    tokenEndpoint: server.token_endpoint,
    resource: resource.resource,
  });
};

describe("MCP through Tereo's sign-in", () => {
  it("an unauthenticated initialize gets the 401 challenge naming the resource metadata", async () => {
    const res = await initialize();

    expect(res.status).toBe(401);
    const metadataUrl = `${stack.zeteoUrl}/.well-known/oauth-protected-resource/mcp`;
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${metadataUrl}"`
    );
    const resource = await expectJson(200, "GET", metadataUrl);
    expect(resource.resource).toBe(`${stack.zeteoUrl}/mcp`);
    expect(resource.authorization_servers).toEqual([stack.tereoUrl]);
  });

  it("a token from a client not listed in MCP_ALLOWED_CLIENTS is refused at /mcp", async () => {
    // alice's token from the web client, which /v1 accepts.
    const res = await initialize(e2e.alice.token);

    expect(res.status).toBe(401);
  });

  it("a user signed in through the login client lists four tools and runs query", async () => {
    const token = await signInAsMcpClient(e2e.alice.email);
    const client = new Client({ name: "zeteo-e2e", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${stack.zeteoUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "describe_table",
        "list_sources",
        "list_tables",
        "query",
      ]);

      const result = await client.callTool({
        name: "query",
        arguments: {
          source: e2e.source.slug,
          from: "orders",
          join: ["customer"],
          select: ["id", "customer.name"],
          where: { status: { eq: "paid" } },
          orderBy: [{ id: "asc" }],
        },
      });

      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const body = JSON.parse(text) as { rows: unknown[][] };
      expect(body.rows).toEqual([
        [1, "Ada"],
        [3, "Brook"],
        [5, "Cyd"],
      ]);
    } finally {
      await client.close();
    }
  });
});
