/** Where the MCP endpoint is served; its metadata is under `/.well-known/oauth-protected-resource/mcp`. */
export const MCP_PATH = "/mcp";

/** What the MCP router serves: the endpoint and its two discovery documents. */
export const MCP_PATHS = [
  MCP_PATH,
  `/.well-known/oauth-protected-resource${MCP_PATH}`,
  "/.well-known/oauth-authorization-server",
];
