/** Paths the app shell never answers: the API, probes, MCP and the UI's own files and settings. */
export const RESERVED_PREFIXES = [
  "/v1",
  "/health",
  "/mcp",
  "/.well-known",
  "/assets",
  "/ui-config.json",
];

/** Whether `path` is one of the prefixes or under one, whatever its case. */
export const isReserved = (path: string): boolean => {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // an undecodable path is checked as written
  }
  const lower = decoded.toLowerCase();
  return RESERVED_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}/`)
  );
};
