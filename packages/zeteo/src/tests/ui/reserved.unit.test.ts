// @module-tag unit
// @module-tag platform
import { isReserved, RESERVED_PREFIXES } from "../../ui/reserved.js";
import { describe, expect, it } from "vitest";

describe("isReserved", () => {
  it("lists the prefixes the UI never answers", () => {
    expect(RESERVED_PREFIXES).toEqual([
      "/v1",
      "/health",
      "/mcp",
      "/.well-known",
      "/assets",
      "/ui-config.json",
    ]);
  });

  it.each([
    "/v1",
    "/v1/",
    "/V1/x",
    "/v1/catalog/tables",
    "/health",
    "/health/x",
    "/HEALTH/",
    "/mcp",
    "/mcp/x",
    "/.well-known/x",
    "/.well-known/oauth-protected-resource/mcp",
    "/assets",
    "/assets/app.js",
    "/ui-config.json",
    "/UI-Config.json",
  ])("reserves %s", (path) => {
    expect(isReserved(path)).toBe(true);
  });

  it.each([
    "/",
    "/v1x",
    "/sources",
    "/sources/abc/tables",
    "/healthy",
    "/mcpx",
    "/assetsx",
    "/ui-config.json5",
    "/x/v1",
  ])("leaves %s to the app", (path) => {
    expect(isReserved(path)).toBe(false);
  });
});
