import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { Route, Routes } from "react-router-dom";
import type { Dashboard } from "../api/types";
import { DisplayPage } from "./DisplayPage";
import { AxiosError } from "axios";
import {
  controlledStream,
  DASHBOARD_ID,
  makeDashboard,
  makePanel,
  okLine,
  PANEL_B,
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

const runUrl = `/v1/dashboards/${DASHBOARD_ID}/run`;
let current: Dashboard;

const renderDisplay = () =>
  renderWithProviders(
    <Routes>
      <Route
        path="/dashboards/:dashboardId/display"
        element={<DisplayPage />}
      />
    </Routes>,
    { route: `/dashboards/${DASHBOARD_ID}/display` }
  );

const unauthorized = () =>
  new AxiosError("Unauthorized", "ERR_BAD_REQUEST", undefined, undefined, {
    status: 401,
    statusText: "Unauthorized",
    headers: {},
    config: {} as never,
    data: { error: "unauthorized", error_description: "Sign in again." },
  });

const failedWith = (status: number) =>
  new AxiosError("Failed", "ERR_BAD_RESPONSE", undefined, undefined, {
    status,
    statusText: "Failed",
    headers: {},
    config: {} as never,
    data: { error: "server_error", error_description: `Failed with ${status}` },
  });

const dashboardGets = () =>
  get.mock.calls.filter(([url]) => url === `/v1/dashboards/${DASHBOARD_ID}`)
    .length;

const okRun = async () => ({ data: streamOf([okLine(current.panels[0].id)]) });

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
  current = makeDashboard({ refresh_seconds: 60 });
  get.mockReset().mockImplementation(async (url: string) => {
    if (url === `/v1/dashboards/${DASHBOARD_ID}`) return { data: current };
    throw new Error(`unexpected GET ${url}`);
  });
  post.mockReset().mockImplementation(okRun);
  document.documentElement.setAttribute("data-theme", "light");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DisplayPage", () => {
  it("runs once, then again every refresh_seconds", async () => {
    renderDisplay();
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(runUrl, {}, expect.anything());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(post).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("sets no timer without refresh_seconds", async () => {
    current = makeDashboard({ refresh_seconds: null });
    renderDisplay();
    await screen.findByTestId("chart");
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps the chart of a failing refresh and says when it went stale", async () => {
    renderDisplay();
    await screen.findByTestId("chart");
    vi.setSystemTime(new Date(2026, 10, 17, 10, 41, 0));
    post.mockRejectedValue(new Error("boom"));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByTestId("chart")).toBeInTheDocument();
    expect(screen.getByText("Stale since 10:42")).toBeInTheDocument();
  });

  it("shows the signed-out screen on a 401, keeping the page", async () => {
    renderDisplay();
    await screen.findByTestId("chart");
    post.mockRejectedValue(unauthorized());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(
      screen.getByText("Signed out — sign in again on this screen")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("stays signed out after a 401 and sends no further runs", async () => {
    renderDisplay();
    await screen.findByTestId("chart");
    post.mockRejectedValue(unauthorized());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(post).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect(post).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText("Signed out — sign in again on this screen")
    ).toBeInTheDocument();
  });

  it("skips a tick while a run is still going, without aborting it", async () => {
    const slow = controlledStream();
    post.mockReset().mockResolvedValue({ data: slow.stream });
    renderDisplay();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect(post).toHaveBeenCalledTimes(1);
    const signal = post.mock.calls[0][2].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => {
      slow.push(`${JSON.stringify(okLine(current.panels[0].id))}\n`);
      slow.push(`${JSON.stringify({ done: true })}\n`);
      slow.close();
    });
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
  });

  it("shows the signed-out screen when the dashboard itself answers 401", async () => {
    get.mockRejectedValue(unauthorized());
    renderDisplay();
    expect(
      await screen.findByText("Signed out — sign in again on this screen")
    ).toBeInTheDocument();
  });

  it("has no refresh buttons and applies the dashboard's theme, restoring it after", async () => {
    current = makeDashboard({ theme: "dark", refresh_seconds: null });
    const { unmount } = renderDisplay();
    await screen.findByTestId("chart");
    expect(screen.getByRole("heading", { name: "Sales" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    unmount();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("follows the system preference for the auto theme", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    current = makeDashboard({ theme: "auto", refresh_seconds: null });
    renderDisplay();
    await screen.findByTestId("chart");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("reloads the dashboard on each tick, so a panel added since appears", async () => {
    renderDisplay();
    await screen.findByTestId("chart");
    expect(dashboardGets()).toBe(1);
    current = makeDashboard({
      refresh_seconds: 60,
      panels: [makePanel(), makePanel({ id: PANEL_B, title: "Orders", y: 4 })],
    });
    post.mockImplementation(async () => ({
      data: streamOf([okLine(current.panels[0].id), okLine(PANEL_B)]),
    }));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(dashboardGets()).toBe(2);
    expect(await screen.findAllByTestId("chart")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Orders" })).toBeInTheDocument();
  });

  it("reloads the dashboard when a run's line has another state than its panel", async () => {
    current = makeDashboard({
      refresh_seconds: null,
      panels: [
        makePanel({
          state: "needs_update",
          message: "This panel needs updating by its owner.",
          chart: undefined,
        }),
      ],
    });
    const fixed = makeDashboard({ refresh_seconds: null });
    get.mockImplementationOnce(async () => ({ data: current }));
    get.mockImplementation(async () => ({ data: fixed }));
    renderDisplay();
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
    expect(dashboardGets()).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(dashboardGets()).toBe(2);
  });

  it("retries a failed first load with back-off, then shows the dashboard", async () => {
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "Date",
      ],
    });
    get.mockRejectedValueOnce(failedWith(503));
    renderDisplay();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(dashboardGets()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(dashboardGets()).toBe(2);
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });

  it("does not retry a dashboard that is not found", async () => {
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "Date",
      ],
    });
    get.mockRejectedValue(failedWith(404));
    renderDisplay();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(dashboardGets()).toBe(1);
    expect(screen.getByText("Failed with 404")).toBeInTheDocument();
  });
});

describe("DisplayPage full screen button", () => {
  let enabled: boolean;
  let element: Element | null;
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "Date",
        "setTimeout",
        "clearTimeout",
      ],
    });
    enabled = true;
    element = null;
    request = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "fullscreenEnabled", {
      configurable: true,
      get: () => enabled,
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => element,
    });
    document.documentElement.requestFullscreen =
      request as unknown as typeof document.documentElement.requestFullscreen;
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "fullscreenEnabled");
    Reflect.deleteProperty(document, "fullscreenElement");
  });

  const settle = () => act(async () => vi.advanceTimersByTimeAsync(10));
  const shown = () =>
    screen
      .getByRole("button", { name: /full screen/i })
      .closest(".z-display-fullscreen")!
      .getAttribute("data-visible");

  it("shows on load and requests full screen when clicked", async () => {
    renderDisplay();
    await settle();
    const button = screen.getByRole("button", { name: /full screen/i });
    expect(shown()).toBe("true");
    await act(async () => button.click());
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("ignores a refused request", async () => {
    request.mockRejectedValue(new TypeError("denied"));
    renderDisplay();
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: /full screen/i }).click()
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("hides after 3 seconds idle and reappears on mouse movement", async () => {
    renderDisplay();
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(shown()).toBe("false");
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove"));
    });
    expect(shown()).toBe("true");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(shown()).toBe("false");
  });

  it("is hidden while the document is full screen", async () => {
    renderDisplay();
    await settle();
    element = document.documentElement;
    await act(async () => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(screen.queryByRole("button", { name: /full screen/i })).toBeNull();
    element = null;
    await act(async () => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(
      screen.getByRole("button", { name: /full screen/i })
    ).toBeInTheDocument();
  });

  it("is not rendered where full screen is unavailable", async () => {
    enabled = false;
    renderDisplay();
    await settle();
    expect(screen.queryByRole("button", { name: /full screen/i })).toBeNull();
  });
});
