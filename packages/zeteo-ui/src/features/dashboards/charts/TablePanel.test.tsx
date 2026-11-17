import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TablePanel, cell } from "./TablePanel";
import type { RunResult } from "../api/types";

describe("TablePanel", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows a timestamp in the viewer's zone as YYYY-MM-DD HH:MM", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    expect(cell("2026-05-18T08:25:09.000Z", "timestamp")).toBe(
      "2026-05-18 13:55"
    );
    vi.stubEnv("TZ", "America/New_York");
    expect(cell("2026-05-18T02:05:00.000Z", "timestamp")).toBe(
      "2026-05-17 22:05"
    );
  });

  it("shows a date as given, a number with its decimals, and null as empty", () => {
    expect(cell("2026-05-18", "date")).toBe("2026-05-18");
    expect(cell(2, "number", 1)).toBe("2.0");
    expect(cell(null, "timestamp")).toBe("");
  });

  it("renders the formatted cells", () => {
    vi.stubEnv("TZ", "UTC");
    const result: RunResult = {
      columns: [
        { name: "at", type: "timestamp" },
        { name: "day", type: "date" },
      ],
      rows: [["2026-05-18T08:25:09.000Z", "2026-05-18"]],
      truncated: false,
    };
    render(
      <TablePanel chart={{ version: 1, type: "table" }} result={result} />
    );
    expect(screen.getByText("2026-05-18 08:25")).toBeInTheDocument();
    expect(screen.getByText("2026-05-18")).toBeInTheDocument();
  });
});
