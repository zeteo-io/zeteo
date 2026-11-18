// @module-tag unit
// @module-tag platform
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";
import { readFileSync } from "fs";
import path from "path";
import {
  DASHBOARD_CARD_URI,
  loadCard,
  PANEL_CARD_URI,
} from "../../mcp/card.js";

const FIXTURE = path.resolve(
  import.meta.dirname,
  "../fixtures/mcp-card/card.html"
);

const meta = (mode: string) => `<meta name="zeteo-card" content="${mode}">`;
const MAX = 2 * 1024 * 1024;

afterEach(() => vi.restoreAllMocks());

describe("loadCard", () => {
  it("is null, with a warning, when the file does not exist", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const missing = path.join(FIXTURE, "..", "missing.html");
    expect(loadCard(missing, MAX)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { path: missing },
      "MCP preview cards are off: MCP_CARD_PATH names no file"
    );
  });

  it("is null, with its own warning, when a page would pass the result cap", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const html = readFileSync(FIXTURE, "utf8");
    // The dashboard page is the larger: the file plus its <meta>.
    const largest = Buffer.byteLength(html) + meta("dashboard").length;
    expect(loadCard(FIXTURE, largest)).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(loadCard(FIXTURE, largest - 1)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { path: FIXTURE, bytes: largest, max_bytes: largest - 1 },
      "MCP preview cards are off: the card at MCP_CARD_PATH is larger than a resource may be"
    );
  });

  it("gives the file twice, differing only in the mode named in <head>", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const cards = loadCard(FIXTURE, MAX)!;
    expect(cards.panel).toContain(meta("panel"));
    expect(cards.dashboard).toContain(meta("dashboard"));
    expect(cards.panel.replace(meta("panel"), "")).toBe(html);
    expect(cards.dashboard.replace(meta("dashboard"), "")).toBe(html);
    // Inside <head>, before the script that reads it.
    const head = cards.panel.indexOf("<head>");
    const at = cards.panel.indexOf(meta("panel"));
    expect(at).toBeGreaterThan(head);
    expect(at).toBeLessThan(cards.panel.indexOf("<script"));
  });

  it("refuses a file with no <head>", () => {
    const dir = path.resolve(import.meta.dirname, "../fixtures/ui-dist");
    expect(() => loadCard(path.join(dir, "favicon.svg"), MAX)).toThrow(
      /<head>/
    );
  });

  it("names the two cards by ui:// uris", () => {
    expect(PANEL_CARD_URI).toBe("ui://zeteo/panel-card.html");
    expect(DASHBOARD_CARD_URI).toBe("ui://zeteo/dashboard-card.html");
  });
});
