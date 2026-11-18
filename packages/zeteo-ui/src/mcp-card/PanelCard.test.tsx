import type { ChartSettings } from "@/features/dashboards/api/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubResizeObserver } from "@/test/echartsMock";
import { render, screen } from "@testing-library/react";
import { fakeCardHost } from "@/test/cardHost";
import { PanelCard } from "./PanelCard";
import { CardToolError } from "./host";

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

const rows = (overrides: Record<string, unknown> = {}) => ({
  title: "Revenue by month",
  chart: line,
  columns: [
    { name: "month", type: "text" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["jan", 1],
    ["feb", 2],
    ["mar", 3],
  ],
  truncated: false,
  problems: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  echarts.init.mockReturnValue(echarts.instance);
  stubResizeObserver();
});

describe("PanelCard", () => {
  it("previews a saved query with a chart from the tool's input, and draws it", async () => {
    const fake = fakeCardHost("panel", { card_panel_rows: () => rows() });
    render(
      <PanelCard
        host={fake.host}
        input={{
          saved_query_id: "q1",
          chart: line,
          time_column: "month",
          time_range: "last_7_days",
          name: "Not passed on",
        }}
        result={{}}
      />
    );
    expect(await screen.findByText("Revenue by month")).toBeInTheDocument();
    expect(fake.callsTo("card_panel_rows")).toEqual([
      {
        saved_query_id: "q1",
        chart: line,
        time_column: "month",
        time_range: "last_7_days",
      },
    ]);
    expect(echarts.init).toHaveBeenCalled();
    expect(echarts.instance.setOption).toHaveBeenCalled();
  });

  it("reads a saved panel named by the input's id", async () => {
    const fake = fakeCardHost("panel", { card_panel_rows: () => rows() });
    render(
      <PanelCard
        host={fake.host}
        input={{ id: "p1", chart: line, saved_query_id: "q1" }}
        result={{}}
      />
    );
    await screen.findByText("Revenue by month");
    expect(fake.callsTo("card_panel_rows")).toEqual([{ saved_panel_id: "p1" }]);
  });

  it("reads a saved panel named by the result's id", async () => {
    const fake = fakeCardHost("panel", { card_panel_rows: () => rows() });
    render(<PanelCard host={fake.host} input={{}} result={{ id: "p2" }} />);
    await screen.findByText("Revenue by month");
    expect(fake.callsTo("card_panel_rows")).toEqual([{ saved_panel_id: "p2" }]);
  });

  it("lists the chart's problems", async () => {
    const fake = fakeCardHost("panel", {
      card_panel_rows: () =>
        rows({ problems: [{ setting: "y.0", problem: "missing_column" }] }),
    });
    render(<PanelCard host={fake.host} input={{ id: "p1" }} result={{}} />);
    expect(
      await screen.findByText(/The saved query's result has no such column\./)
    ).toBeInTheDocument();
    expect(screen.getByText("y.0")).toBeInTheDocument();
  });

  it("says how many rows it shows when the result was cut", async () => {
    const fake = fakeCardHost("panel", {
      card_panel_rows: () => rows({ truncated: true }),
    });
    render(<PanelCard host={fake.host} input={{ id: "p1" }} result={{}} />);
    expect(
      await screen.findByText("Showing the first 3 rows")
    ).toBeInTheDocument();
  });

  it("shows no note when the result is whole", async () => {
    const fake = fakeCardHost("panel", { card_panel_rows: () => rows() });
    render(<PanelCard host={fake.host} input={{ id: "p1" }} result={{}} />);
    await screen.findByText("Revenue by month");
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
  });

  it("shows the tool's error description", async () => {
    const fake = fakeCardHost("panel", {
      card_panel_rows: () =>
        new CardToolError("You can't run this saved query."),
    });
    render(<PanelCard host={fake.host} input={{ id: "p1" }} result={{}} />);
    expect(
      await screen.findByText("You can't run this saved query.")
    ).toBeInTheDocument();
  });
});
