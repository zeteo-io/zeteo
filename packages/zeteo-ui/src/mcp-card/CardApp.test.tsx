import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ChartSettings } from "@/features/dashboards/api/types";
import { stubResizeObserver } from "@/test/echartsMock";
import { existsSync, readFileSync } from "node:fs";
import { readKind, readToolResult } from "./host";
import { fakeCardHost } from "@/test/cardHost";
import { fileURLToPath } from "node:url";
import { CardApp } from "./CardApp";
import path from "node:path";
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
} from "@/features/dashboards/charts/theme";

const echarts = vi.hoisted(() => ({
  instance: { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() },
  init: vi.fn(),
}));
vi.mock("echarts/core", () => ({ init: echarts.init, use: vi.fn() }));
vi.mock("echarts/charts", () => ({
  LineChart: {},
  BarChart: {},
  PieChart: {},
}));
vi.mock("echarts/components", () => ({
  GridComponent: {},
  TooltipComponent: {},
  LegendComponent: {},
  DatasetComponent: {},
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));

const line: ChartSettings = {
  version: 1,
  type: "line",
  x: "month",
  y: ["revenue"],
};

const panelRows = () => ({
  title: "Revenue",
  chart: line,
  columns: [
    { name: "month", type: "text" },
    { name: "revenue", type: "number" },
  ],
  rows: [["jan", 1]],
  truncated: false,
  problems: [],
});

/** The palette of the last option drawn. */
const lastPalette = () =>
  (echarts.instance.setOption.mock.calls.at(-1)?.[0] as { color?: string[] })
    ?.color;

beforeEach(() => {
  vi.clearAllMocks();
  echarts.init.mockReturnValue(echarts.instance);
  stubResizeObserver();
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("CardApp", () => {
  it("waits for the tool's result before reading rows", async () => {
    const fake = fakeCardHost("panel", { card_panel_rows: panelRows });
    render(<CardApp host={fake.host} />);
    act(() => fake.sendInput({ id: "p1" }));
    expect(fake.host.callTool).not.toHaveBeenCalled();
    act(() => fake.sendResult({ ok: true, value: { id: "p1" } }));
    expect(await screen.findByText("Revenue")).toBeInTheDocument();
    expect(fake.callsTo("card_panel_rows")).toEqual([{ saved_panel_id: "p1" }]);
  });

  it("shows the tool's own error and reads nothing", async () => {
    const fake = fakeCardHost("dashboard");
    render(<CardApp host={fake.host} />);
    act(() => {
      fake.sendInput({ id: "d1" });
      fake.sendResult({ ok: false, error: "Dashboard not found." });
    });
    expect(await screen.findByText("Dashboard not found.")).toBeInTheDocument();
    expect(fake.host.callTool).not.toHaveBeenCalled();
  });

  it("draws the dashboard card for a dashboard tool", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: () => ({
        id: "d1",
        name: "Sales",
        url: null,
        time_range: null,
        panels: [],
      }),
    });
    render(<CardApp host={fake.host} />);
    act(() => {
      fake.sendInput({ id: "d1" });
      fake.sendResult({ ok: true, value: {} });
    });
    expect(await screen.findByText("No panels yet")).toBeInTheDocument();
  });

  it("follows the host's theme, redrawing charts dark", async () => {
    const fake = fakeCardHost("panel", { card_panel_rows: panelRows });
    render(<CardApp host={fake.host} />);
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => {
      fake.sendInput({ id: "p1" });
      fake.sendResult({ ok: true, value: {} });
    });
    await waitFor(() => expect(lastPalette()).toEqual(LIGHT_PALETTE));
    act(() => fake.setTheme("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() => expect(lastPalette()).toEqual(DARK_PALETTE));
  });

  it("reports its height after rendering", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 320.4,
    } as DOMRect);
    const fake = fakeCardHost("panel", { card_panel_rows: panelRows });
    render(<CardApp host={fake.host} />);
    act(() => {
      fake.sendInput({ id: "p1" });
      fake.sendResult({ ok: true, value: {} });
    });
    await screen.findByText("Revenue");
    expect(fake.host.reportSize).toHaveBeenLastCalledWith(321);
  });
});

describe("readToolResult", () => {
  it("reads structured content", () => {
    expect(
      readToolResult({ content: [], structuredContent: { id: "a" } })
    ).toEqual({ ok: true, value: { id: "a" } });
  });

  it("reads JSON text", () => {
    expect(
      readToolResult({ content: [{ type: "text", text: '{"id":"b"}' }] })
    ).toEqual({ ok: true, value: { id: "b" } });
  });

  it("reads zeteo's error body", () => {
    expect(
      readToolResult({
        isError: true,
        content: [
          {
            type: "text",
            text: '{"error":"not_found","error_description":"Not found."}',
          },
        ],
      })
    ).toEqual({ ok: false, error: "Not found." });
  });

  it("reads a plain-text error", () => {
    expect(
      readToolResult({
        isError: true,
        content: [
          { type: "text", text: "Rate limit reached; retry in 5 seconds" },
        ],
      })
    ).toEqual({ ok: false, error: "Rate limit reached; retry in 5 seconds" });
  });
});

describe("readKind", () => {
  it("reads the card's kind from the page's meta tag", () => {
    const meta = document.createElement("meta");
    meta.name = "zeteo-card";
    meta.content = "dashboard";
    document.head.append(meta);
    expect(readKind(document)).toBe("dashboard");
    meta.content = "other";
    expect(readKind(document)).toBeNull();
    meta.remove();
    expect(readKind(document)).toBeNull();
  });
});

// The host's default CSP allows no external scripts or stylesheets, so the
// built card must carry everything inline. Checked when the card is built.
const built = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist-mcp/card.html"
);

describe.skipIf(!existsSync(built))("the built card", () => {
  it("loads no external script or stylesheet", () => {
    const html = readFileSync(built, "utf8");
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b[^>]*\bhref\s*=/i);
    expect(html).not.toMatch(/@import\s/i);
    expect(html).toMatch(/<script\b[^>]*>/i);
  });
});
