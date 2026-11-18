// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
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

describe("loadCard", () => {
  it("is null when the file does not exist", () => {
    expect(loadCard(path.join(FIXTURE, "..", "missing.html"))).toBeNull();
  });

  it("gives the file twice, differing only in the mode named in <head>", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const cards = loadCard(FIXTURE)!;
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
    expect(() => loadCard(path.join(dir, "favicon.svg"))).toThrow(/<head>/);
  });

  it("names the two cards by ui:// uris", () => {
    expect(PANEL_CARD_URI).toBe("ui://zeteo/panel-card.html");
    expect(DASHBOARD_CARD_URI).toBe("ui://zeteo/dashboard-card.html");
  });
});
