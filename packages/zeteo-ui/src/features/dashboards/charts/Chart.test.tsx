import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartSettings, RunResult } from "../api/types";
import { act, render, screen } from "@testing-library/react";
import { DARK_PALETTE, LIGHT_PALETTE } from "./theme";
import { Chart } from "./Chart";

const instance = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
}));
const init = vi.hoisted(() => vi.fn());
vi.mock("echarts/core", () => ({ init, use: vi.fn() }));
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

const observed = vi.hoisted(() => ({
  callback: null as null | (() => void),
  disconnect: vi.fn(),
}));

const result: RunResult = {
  columns: [
    { name: "month", type: "text" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["jan", 1],
    ["feb", 2],
  ],
  truncated: false,
};
const line: ChartSettings = {
  version: 1,
  type: "line",
  x: "month",
  y: ["revenue"],
};

beforeEach(() => {
  vi.clearAllMocks();
  init.mockReturnValue(instance);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        observed.callback = cb;
      }
      observe() {}
      disconnect() {
        observed.disconnect();
      }
    }
  );
});

describe("Chart", () => {
  it("initialises on mount and sets the option without merging", () => {
    render(<Chart chart={line} result={result} />);
    expect(init).toHaveBeenCalledTimes(1);
    expect(instance.setOption).toHaveBeenCalledTimes(1);
    const [option, opts] = instance.setOption.mock.calls[0];
    expect(option.series[0].type).toBe("line");
    expect(opts).toEqual({ notMerge: true });
  });

  it("sets the option again when the chart changes, without a new instance", () => {
    const { rerender } = render(<Chart chart={line} result={result} />);
    rerender(<Chart chart={{ ...line, decimals: 2 }} result={result} />);
    expect(init).toHaveBeenCalledTimes(1);
    expect(instance.setOption).toHaveBeenCalledTimes(2);
  });

  it("resizes when its box does", () => {
    render(<Chart chart={line} result={result} />);
    observed.callback?.();
    expect(instance.resize).toHaveBeenCalled();
  });

  it("disposes on unmount", () => {
    const { unmount } = render(<Chart chart={line} result={result} />);
    unmount();
    expect(instance.dispose).toHaveBeenCalledTimes(1);
    expect(observed.disconnect).toHaveBeenCalled();
  });

  it("renders a stat as a panel, not an ECharts chart", () => {
    render(
      <Chart
        chart={{ version: 1, type: "stat", value: "revenue" }}
        result={result}
      />
    );
    expect(init).not.toHaveBeenCalled();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("renders a table as a panel, not an ECharts chart", () => {
    render(<Chart chart={{ version: 1, type: "table" }} result={result} />);
    expect(init).not.toHaveBeenCalled();
    expect(screen.getByText("jan")).toBeInTheDocument();
    expect(screen.getByText("revenue")).toBeInTheDocument();
  });

  it("says so when a setting names a column the result lacks", () => {
    render(<Chart chart={{ ...line, x: "gone" }} result={result} />);
    expect(screen.getByText(/gone/)).toBeInTheDocument();
  });
});

describe("Chart theme", () => {
  it("sets the option again with the new colours when data-theme changes", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    render(<Chart chart={line} result={result} />);
    const first = instance.setOption.mock.calls.at(-1)![0];
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await Promise.resolve();
    });
    const last = instance.setOption.mock.calls.at(-1)![0];
    expect(instance.setOption.mock.calls.length).toBeGreaterThan(1);
    expect(last.textStyle.color).not.toBe(first.textStyle.color);
    expect(first.color).toEqual(LIGHT_PALETTE);
    expect(last.color).toEqual(DARK_PALETTE);
    expect(last.series[0].color).toBe(DARK_PALETTE[0]);
    document.documentElement.removeAttribute("data-theme");
  });
});
