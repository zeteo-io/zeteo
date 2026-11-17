import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { pickOption } from "@/test/searchSelect";
import { Route, Routes } from "react-router-dom";
import { DashboardView } from "./DashboardView";
import type { Dashboard } from "../api/types";
import {
  controlledStream,
  DASHBOARD_ID,
  makeDashboard,
  okLine,
  streamOf,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read"],
    api: { get, post },
  })
);
vi.mock("../charts/Chart", () => ({
  Chart: ({ chart }: { chart: { type: string } }) => (
    <div data-testid="chart">{chart.type} chart</div>
  ),
}));

const KEY = `zeteo.dashboard.${DASHBOARD_ID}.refresh`;
let current: Dashboard;

const renderView = () =>
  renderWithProviders(
    <Routes>
      <Route path="/dashboards/:dashboardId" element={<DashboardView />} />
    </Routes>,
    { route: `/dashboards/${DASHBOARD_ID}` }
  );

const okRun = async () => ({ data: streamOf([okLine(current.panels[0].id)]) });
const advance = (ms: number) =>
  act(async () => vi.advanceTimersByTimeAsync(ms));

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  window.localStorage.clear();
  current = makeDashboard({ refresh_seconds: null });
  get.mockReset().mockImplementation(async (url: string) => {
    if (url === `/v1/dashboards/${DASHBOARD_ID}`) return { data: current };
    return { data: { data: [], next_cursor: null } };
  });
  post.mockReset().mockImplementation(okRun);
});

afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DashboardView auto-refresh", () => {
  it("defaults to the dashboard's refresh_seconds", async () => {
    current = makeDashboard({ refresh_seconds: 300 });
    renderView();
    await screen.findByTestId("chart");
    expect(screen.getByLabelText("Auto-refresh")).toHaveValue("5 min");
    expect(screen.getByText("Live · every 5 min")).toBeInTheDocument();
  });

  it("shows a refresh_seconds that is not an option as its own option", async () => {
    current = makeDashboard({ refresh_seconds: 120 });
    renderView();
    await screen.findByTestId("chart");
    expect(screen.getByLabelText("Auto-refresh")).toHaveValue("Every 2 min");
    expect(screen.getByText("Live · every 2 min")).toBeInTheDocument();
  });

  it("is Off when the dashboard has none, with no indicator", async () => {
    renderView();
    await screen.findByTestId("chart");
    expect(screen.getByLabelText("Auto-refresh")).toHaveValue("Off");
    expect(screen.queryByText(/^Live/)).not.toBeInTheDocument();
    await advance(3_600_000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("offers the manual refresh buttons only while auto-refresh is off", async () => {
    renderView();
    await screen.findByTestId("chart");
    expect(
      screen.getByRole("button", { name: "Refresh all" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("hides the manual refresh buttons while live", async () => {
    current = makeDashboard({ refresh_seconds: 300 });
    renderView();
    await screen.findByTestId("chart");
    expect(
      screen.queryByRole("button", { name: "Refresh all" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh" })
    ).not.toBeInTheDocument();
  });

  it("prefers the viewer's remembered choice", async () => {
    current = makeDashboard({ refresh_seconds: 300 });
    window.localStorage.setItem(KEY, "900");
    renderView();
    await screen.findByTestId("chart");
    expect(screen.getByLabelText("Auto-refresh")).toHaveValue("15 min");
  });

  it("remembers Off over the dashboard's interval", async () => {
    current = makeDashboard({ refresh_seconds: 300 });
    window.localStorage.setItem(KEY, "off");
    renderView();
    await screen.findByTestId("chart");
    expect(screen.getByLabelText("Auto-refresh")).toHaveValue("Off");
  });

  it("stores a chosen option, runs on its interval, and Off stops the runs", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderView();
    await screen.findByTestId("chart");
    await pickOption(user, screen.getByLabelText("Auto-refresh"), "1 min");
    expect(window.localStorage.getItem(KEY)).toBe("60");
    expect(screen.getByText("Live · every 1 min")).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    const dashboardGets = () =>
      get.mock.calls.filter(([u]) => u === `/v1/dashboards/${DASHBOARD_ID}`)
        .length;
    const before = dashboardGets();
    await advance(60_000);
    expect(post).toHaveBeenCalledTimes(2);
    expect(dashboardGets()).toBeGreaterThan(before);
    await user.clear(screen.getByLabelText("Auto-refresh"));
    await pickOption(user, screen.getByLabelText("Auto-refresh"), "Off");
    expect(window.localStorage.getItem(KEY)).toBe("off");
    expect(screen.queryByText(/^Live/)).not.toBeInTheDocument();
    await advance(300_000);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("works when storage is blocked", async () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    current = makeDashboard({ refresh_seconds: 60 });
    renderView();
    await screen.findByTestId("chart");
    expect(screen.getByLabelText("Auto-refresh")).toHaveValue("1 min");
    spy.mockRestore();
  });

  it("starts no run while one is pending, and does not abort it", async () => {
    current = makeDashboard({ refresh_seconds: 60 });
    const pending = controlledStream();
    post.mockReset().mockResolvedValue({ data: pending.stream });
    renderView();
    await advance(0);
    await screen.findByLabelText("Auto-refresh");
    await advance(0);
    expect(post).toHaveBeenCalledTimes(1);
    await advance(120_000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][2].signal.aborted).toBe(false);
  });

  it("runs nothing in a hidden tab, and once on return after an interval", async () => {
    current = makeDashboard({ refresh_seconds: 60 });
    renderView();
    await screen.findByTestId("chart");
    setVisibility("hidden");
    await advance(300_000);
    expect(post).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await advance(0);
    expect(post).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("does not refresh on return when less than an interval has passed", async () => {
    current = makeDashboard({ refresh_seconds: 300 });
    renderView();
    await screen.findByTestId("chart");
    setVisibility("hidden");
    await advance(10_000);
    setVisibility("visible");
    await advance(0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps the chart of a failing refresh and says it is stale", async () => {
    current = makeDashboard({ refresh_seconds: 60 });
    renderView();
    await screen.findByTestId("chart");
    vi.setSystemTime(new Date(2026, 10, 17, 10, 41, 0));
    post.mockRejectedValue(new Error("boom"));
    await advance(60_000);
    expect(screen.getByTestId("chart")).toBeInTheDocument();
    expect(screen.getByText("Stale since 10:42")).toBeInTheDocument();
  });
});
