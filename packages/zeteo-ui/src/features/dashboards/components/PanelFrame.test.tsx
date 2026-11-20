import { render, screen } from "@testing-library/react";
import { makePanel, makeResult } from "../testFixtures";
import { describe, expect, it, vi } from "vitest";
import { PanelFrame } from "./PanelFrame";

vi.mock("../charts/Chart", () => ({
  Chart: ({ chart }: { chart: { type: string } }) => (
    <div data-testid="chart">{chart.type} chart</div>
  ),
}));

describe("PanelFrame", () => {
  it("shows no endless spinner for a result whose panel has no chart settings yet", () => {
    render(
      <PanelFrame
        panel={makePanel({
          state: "needs_update",
          message: "This panel needs updating by its owner.",
          chart: undefined,
        })}
        run={{ state: "ok", result: makeResult(), loading: false }}
        now={Date.now()}
      />
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("chart")).toBeNull();
    expect(
      screen.getByText("This panel changed; reloading the dashboard.")
    ).toBeInTheDocument();
  });

  it("draws the chart of a result", () => {
    render(
      <PanelFrame
        panel={makePanel()}
        run={{ state: "ok", result: makeResult(), loading: false }}
        now={Date.now()}
      />
    );
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });

  it("shows a Rows limited pill only when the viewer's rows are limited", () => {
    const { rerender } = render(
      <PanelFrame
        panel={makePanel()}
        run={{
          state: "ok",
          result: makeResult(),
          rowsLimited: true,
          loading: false,
        }}
        now={Date.now()}
      />
    );
    expect(screen.getByText("Rows limited")).toBeInTheDocument();
    rerender(
      <PanelFrame
        panel={makePanel()}
        run={{ state: "ok", result: makeResult(), loading: false }}
        now={Date.now()}
      />
    );
    expect(screen.queryByText("Rows limited")).toBeNull();
  });
});
