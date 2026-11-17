import type { RunResult, StatSettings } from "../api/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatPanel } from "./StatPanel";

const result = (...values: unknown[]): RunResult => ({
  columns: [{ name: "total", type: "number" }],
  rows: values.map((v) => [v]),
  truncated: false,
});
const settings: StatSettings = { version: 1, type: "stat", value: "total" };
const compared: StatSettings = { ...settings, compare: "next_row" };

describe("StatPanel", () => {
  it("shows the first row's value", () => {
    render(<StatPanel chart={settings} result={result(1234, 1000)} />);
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("shows the change from the next row as a signed percentage", () => {
    render(<StatPanel chart={compared} result={result(112.5, 100)} />);
    expect(screen.getByText("+12.5%")).toBeInTheDocument();
  });

  it("shows a decrease with a minus sign", () => {
    render(<StatPanel chart={compared} result={result(90, 100)} />);
    expect(screen.getByText("-10.0%")).toBeInTheDocument();
  });

  it("shows no change with one row", () => {
    render(<StatPanel chart={compared} result={result(5)} />);
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("shows no change when the next row is zero or null", () => {
    const { rerender } = render(
      <StatPanel chart={compared} result={result(5, 0)} />
    );
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    rerender(<StatPanel chart={compared} result={result(5, null)} />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("applies decimals and the unit", () => {
    render(
      <StatPanel
        chart={{ ...settings, decimals: 2, unit: "kg" }}
        result={result(3)}
      />
    );
    expect(screen.getByText("3.00")).toBeInTheDocument();
    expect(screen.getByText("kg")).toBeInTheDocument();
  });

  it("shows a dash when there is no row or the value is null", () => {
    const { rerender } = render(
      <StatPanel chart={settings} result={result()} />
    );
    expect(screen.getByText("-")).toBeInTheDocument();
    rerender(<StatPanel chart={settings} result={result(null)} />);
    expect(screen.getByText("-")).toBeInTheDocument();
  });
});
