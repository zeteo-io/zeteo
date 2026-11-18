// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { createTestClient, startStubCore } from "@tereo-io/mcp/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { mcpToken } from "../support/mcp.js";
import path from "path";

const FIXTURE = path.resolve(
  import.meta.dirname,
  "../fixtures/mcp-card/card.html"
);
const PANEL = "ui://zeteo/panel-card.html";
const DASHBOARD = "ui://zeteo/dashboard-card.html";
const MIME = "text/html;profile=mcp-app";

const PANEL_TOOLS = [
  "card_panel_rows",
  "create_saved_panel",
  "get_saved_panel",
  "preview_panel",
  "update_saved_panel",
];
const DASHBOARD_TOOLS = [
  "add_panel",
  "card_dashboard",
  "detach_panel",
  "get_dashboard",
  "link_saved_panel",
  "remove_panel",
  "update_dashboard",
  "update_panel",
];

describe("MCP preview cards", () => {
  let stubCore: Awaited<ReturnType<typeof startStubCore>>;
  let stopTereo: () => Promise<void>;
  let cardPath: string;
  let env: { MCP_CARD_PATH: string };

  /** A server built with MCP_CARD_PATH set to `file`, and a client of it. */
  const connect = async (
    file: string
  ): Promise<{ client: Client; close(): Promise<void> }> => {
    env.MCP_CARD_PATH = file;
    const { createZeteoMcp } = await import("../../mcp/index.js");
    const mcp = createZeteoMcp({ coreUrl: stubCore.coreUrl });
    return createTestClient(mcp, { token: mcpToken([MCP_USE, DATA_READ]) });
  };

  beforeAll(async () => {
    stubCore = await startStubCore();
    const tereo = await import("../../utils/tereo.js");
    await tereo.initializeTereo();
    stopTereo = tereo.stopTereo;
    env = (await import("../../env.js")).default;
    cardPath = env.MCP_CARD_PATH;
  });
  afterAll(async () => {
    env.MCP_CARD_PATH = cardPath;
    await stubCore.close();
    await stopTereo();
  });

  it("lists both cards as MCP Apps resources with a border", async () => {
    const { client, close } = await connect(FIXTURE);
    try {
      const { resources } = await client.listResources();
      expect(
        resources
          .map((r) => ({ uri: r.uri, mimeType: r.mimeType, meta: r._meta }))
          .sort((a, b) => a.uri.localeCompare(b.uri))
      ).toEqual([
        {
          uri: DASHBOARD,
          mimeType: MIME,
          meta: { ui: { prefersBorder: true } },
        },
        { uri: PANEL, mimeType: MIME, meta: { ui: { prefersBorder: true } } },
      ]);
    } finally {
      await close();
    }
  });

  it("reads each card as the HTML naming its mode", async () => {
    const { client, close } = await connect(FIXTURE);
    try {
      for (const [uri, mode] of [
        [PANEL, "panel"],
        [DASHBOARD, "dashboard"],
      ]) {
        const { contents } = await client.readResource({ uri });
        expect(contents).toHaveLength(1);
        const [content] = contents as Array<{
          uri: string;
          mimeType?: string;
          text?: string;
          _meta?: unknown;
        }>;
        expect(content.uri).toBe(uri);
        expect(content.mimeType).toBe(MIME);
        expect(content._meta).toEqual({ ui: { prefersBorder: true } });
        expect(content.text).toContain(
          `<meta name="zeteo-card" content="${mode}">`
        );
        expect(content.text).toContain('<div id="root"></div>');
      }
    } finally {
      await close();
    }
  });

  it("links each card tool to its card, the card's own tools for the app only, and no other tool", async () => {
    const { client, close } = await connect(FIXTURE);
    try {
      const { tools } = await client.listTools();
      const linked = (uri: string) =>
        tools
          .filter(
            (t) =>
              (t._meta?.ui as { resourceUri?: string })?.resourceUri === uri
          )
          .map((t) => t.name)
          .sort();
      expect(linked(PANEL)).toEqual(PANEL_TOOLS);
      expect(linked(DASHBOARD)).toEqual(DASHBOARD_TOOLS);
      for (const tool of tools) {
        const ui = tool._meta?.ui as { visibility?: string[] } | undefined;
        if (tool.name.startsWith("card_")) {
          expect(ui?.visibility, tool.name).toEqual(["app"]);
          expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
        } else if (ui !== undefined) {
          expect(ui.visibility, tool.name).toBeUndefined();
        } else {
          expect(tool._meta?.ui, tool.name).toBeUndefined();
        }
      }
    } finally {
      await close();
    }
  });

  it("serves no card, no link and no card tools when MCP_CARD_PATH names no file, and warns once", async () => {
    const { logger } = await import("../../utils/logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const missing = path.join(path.dirname(FIXTURE), "missing.html");
    try {
      const { client, close } = await connect(missing);
      try {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toEqual({ path: missing });
        expect(client.getServerCapabilities()?.resources).toBeUndefined();
        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);
        for (const tool of tools) {
          expect(tool._meta?.ui, tool.name).toBeUndefined();
          expect(tool._meta?.["ui/resourceUri"], tool.name).toBeUndefined();
          expect(tool.name, tool.name).not.toMatch(/^card_/);
        }
      } finally {
        await close();
      }
    } finally {
      warn.mockRestore();
    }
  });
});
