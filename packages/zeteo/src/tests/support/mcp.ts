import { TEST_MCP_CLIENT } from "../setup/testEnv.js";
import { tokenFor } from "./tokens.js";
import { BASE_URL } from "./http.js";
import { request } from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

/** The shared server's MCP endpoint. */
export const MCP_URL = `${BASE_URL}/mcp`;

/** A token issued to the test connector client, for a new user unless `userId` is given. */
export const mcpToken = (permissions: string[], userId?: string): string =>
  tokenFor({ permissions, userId, client: TEST_MCP_CLIENT });

export interface McpSession {
  client: Client;
  close(): Promise<void>;
}

/** An MCP client signed in with `token`, connected to `url` (the shared server's endpoint by default). */
export const connectMcp = async (
  token: string,
  url = MCP_URL
): Promise<McpSession> => {
  const client = new Client({ name: "zeteo-test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return { client, close: () => client.close() };
};

export interface ToolOutcome {
  isError: boolean;
  /** The result's text block as it was sent. */
  text: string;
  /** That text read as JSON, or undefined when it is not JSON. */
  // Each test asserts the shape it expects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

/** Calls a tool and returns its one text block, raw and as JSON. */
export const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolOutcome> => {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
};

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * A request to the shared server with headers `fetch` will not let a caller
 * set, such as `Host`.
 */
export const rawRequest = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = request(
      {
        method,
        // As fetch reaches BASE_URL: the server listens on every address,
        // and another process may hold the port on 127.0.0.1 alone.
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          Host: url.host,
          ...headers,
          ...(body !== undefined && {
            "Content-Length": String(Buffer.byteLength(body)),
          }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end(body);
  });

/** An MCP `initialize` request body, for raw requests. */
export const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0.0.0" },
  },
});

/** The headers an MCP POST carries, signed in with `token`. */
export const mcpPostHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
});
