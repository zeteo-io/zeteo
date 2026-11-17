import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { pickOption } from "@/test/searchSelect";
import { Route, Routes } from "react-router-dom";
import { DashboardView } from "./DashboardView";
import type { Dashboard } from "../api/types";
import {
  DASHBOARD_ID,
  PANEL_A,
  PANEL_B,
  makeDashboard,
  makePanel,
  makeResult,
  okLine,
  streamOf,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read"],
    api: { get, post, patch },
  })
);
vi.mock("../charts/Chart", () => ({
  Chart: ({ chart }: { chart: { type: string } }) => (
    <div data-testid="chart">{chart.type} chart</div>
  ),
}));

const COPY = {
  not_accessible:
    "You need expanded permissions to run this saved query. Ask an admin to extend your access.",
  saved_query_deleted: "This panel's saved query was deleted.",
  saved_panel_deleted: "This panel's saved panel was deleted.",
  not_available: "This saved query is no longer available for dashboards.",
  needs_update: "This panel needs updating by its owner.",
} as const;

let current: Dashboard;

const renderView = () =>
  renderWithProviders(
    <Routes>
      <Route path="/dashboards/:dashboardId" element={<DashboardView />} />
    </Routes>,
    { route: `/dashboards/${DASHBOARD_ID}` }
  );

const runUrl = `/v1/dashboards/${DASHBOARD_ID}/run`;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  current = makeDashboard();
  get.mockReset().mockImplementation(async (url: string) => {
    if (url === `/v1/dashboards/${DASHBOARD_ID}`) return { data: current };
    return { data: { data: [], next_cursor: null } };
  });
  patch.mockReset();
  post.mockReset().mockImplementation(async (url: string) => {
    if (url === runUrl) {
      return { data: streamOf(current.panels.map((p) => okLine(p.id))) };
    }
    throw new Error(`unexpected POST ${url}`);
  });
});

describe("DashboardView", () => {
  it("reloads the dashboard once when a run's line has another state than its panel", async () => {
    current = makeDashboard({
      panels: [
        makePanel({
          state: "needs_update",
          message: COPY.needs_update,
          chart: undefined,
        }),
      ],
    });
    const fixed = makeDashboard();
    let loads = 0;
    get.mockImplementation(async (url: string) => {
      if (url !== `/v1/dashboards/${DASHBOARD_ID}`) {
        return { data: { data: [], next_cursor: null } };
      }
      loads += 1;
      return { data: loads === 1 ? current : fixed };
    });
    renderView();
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
    expect(
      screen.queryByText("This panel changed; reloading the dashboard.")
    ).not.toBeInTheDocument();
    expect(loads).toBe(2);
  });

  it("draws each panel from the run, with its title and when it was updated", async () => {
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Sales" })
    ).toBeInTheDocument();
    expect(await screen.findByTestId("chart")).toHaveTextContent("table chart");
    expect(screen.getByText("Revenue")).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(runUrl, {}, expect.anything());
  });

  it.each(Object.entries(COPY))(
    "shows the copy of a %s panel",
    async (state, text) => {
      current = makeDashboard({
        panels: [
          makePanel({
            state: state as keyof typeof COPY,
            chart: undefined,
            saved_query_id: undefined,
          }),
        ],
      });
      post.mockImplementation(async () => ({
        data: streamOf([
          { panel_id: PANEL_A, state: state as keyof typeof COPY },
        ]),
      }));
      renderView();
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    }
  );

  it("shows the notice the server sends for a panel cut at the row cap", async () => {
    const notice =
      "Showing the first 5,000 rows; aggregate the saved query to see everything.";
    const rows = Array.from({ length: 5000 }, (_, i) => [`r${i}`, i]);
    post.mockImplementation(async () => ({
      data: streamOf([
        okLine(PANEL_A, {
          ...makeResult({ rows, truncated: true, truncated_by: "rows" }),
          notice,
        }),
      ]),
    }));
    renderView();
    expect(await screen.findByText(notice)).toBeInTheDocument();
  });

  it("shows no notice when the server sends none, as for a saved query's own limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`r${i}`, i]);
    post.mockImplementation(async () => ({
      data: streamOf([
        okLine(
          PANEL_A,
          makeResult({ rows, truncated: true, truncated_by: "rows" })
        ),
      ]),
    }));
    renderView();
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
  });

  it("re-runs with the time range chosen, without saving it", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chart");
    expect(screen.getByLabelText("Time range")).toHaveValue("Last 30 days");
    await pickOption(user, screen.getByLabelText("Time range"), "Last 7 days");
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(
        runUrl,
        { time_range: "last_7_days" },
        expect.anything()
      )
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("refreshes one panel on its own", async () => {
    const user = userEvent.setup();
    current = makeDashboard({
      panels: [makePanel(), makePanel({ id: PANEL_B, title: "Orders", x: 6 })],
    });
    renderView();
    await screen.findAllByTestId("chart");
    const panel = screen
      .getByText("Orders")
      .closest("[data-panel]") as HTMLElement;
    await user.click(within(panel).getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(
        runUrl,
        { panels: [PANEL_B] },
        expect.anything()
      )
    );
  });

  it("gives the owner the edit controls", async () => {
    renderView();
    await screen.findByTestId("chart");
    for (const name of [
      "Edit layout",
      "Share",
      "Transfer",
      "Edit details",
      "Delete",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("gives a viewer who is not the owner no edit controls", async () => {
    current = makeDashboard({
      owner: {
        id: "d9999999-1c7a-4a53-9d0e-6a3b1f2c4d01",
        name: "Olive Owner",
      },
      share_count: undefined,
      shared_at: "2026-11-05T10:00:00.000Z",
    });
    renderView();
    await screen.findByTestId("chart");
    for (const name of [
      "Edit layout",
      "Add panel",
      "Share",
      "Transfer",
      "Edit details",
      "Delete",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "Copy to mine" })
    ).toBeInTheDocument();
    expect(screen.getByText("From Olive Owner")).toBeInTheDocument();
  });

  it("saves the layout by panel id after editing", async () => {
    const user = userEvent.setup();
    patch.mockResolvedValue({ data: current });
    renderView();
    await screen.findByTestId("chart");
    await user.click(screen.getByRole("button", { name: "Edit layout" }));
    expect(
      screen.getByRole("button", { name: "Add panel" })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save layout" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/v1/dashboards/${DASHBOARD_ID}`, {
        panels: [{ id: PANEL_A, x: 0, y: 0, w: 6, h: 4 }],
      })
    );
  });
});
