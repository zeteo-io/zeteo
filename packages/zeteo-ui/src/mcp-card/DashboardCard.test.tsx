import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ChartSettings } from "@/features/dashboards/api/types";
import { CANNOT_PREVIEW, DashboardCard } from "./DashboardCard";
import { stubResizeObserver } from "@/test/echartsMock";
import userEvent from "@testing-library/user-event";
import { fakeCardHost } from "@/test/cardHost";
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
  GaugeChart: {},
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

const okPanel = (id: string, y = 0) => ({
  id,
  x: 0,
  y,
  w: 6,
  h: 3,
  title: `Panel ${id}`,
  state: "ok",
  chart: line,
});

const layout = (overrides: Record<string, unknown> = {}) => ({
  id: "d1",
  name: "Sales",
  url: "https://zeteo.example/dashboards/d1",
  time_range: "last_30_days",
  panels: [okPanel("a")],
  ...overrides,
});

const okLine = (id: string) => ({
  panel_id: id,
  state: "ok",
  result: {
    columns: [
      { name: "month", type: "text" },
      { name: "revenue", type: "number" },
    ],
    rows: [["jan", 1]],
    truncated: false,
  },
});

/** card_dashboard: the layout without panel_ids, else a line per id (or `lines`). */
const cardDashboard =
  (board: Record<string, unknown>, lines: (id: string) => unknown = okLine) =>
  (args: Record<string, unknown>) =>
    Array.isArray(args.panel_ids)
      ? { panels: (args.panel_ids as string[]).map(lines) }
      : board;

beforeEach(() => {
  vi.clearAllMocks();
  echarts.init.mockReturnValue(echarts.instance);
  stubResizeObserver();
});

afterEach(() => {
  window.innerWidth = 1024;
});

describe("DashboardCard: which dashboard", () => {
  it.each([
    ["the input's dashboard_id", { dashboard_id: "d1", id: "panel" }, {}],
    ["the input's id", { id: "d1" }, { dashboard_id: "other" }],
    ["the result's dashboard_id", {}, { dashboard_id: "d1", id: "other" }],
    ["the result's id", {}, { id: "d1" }],
  ])("takes %s", async (_, input, result) => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(layout()),
    });
    render(<DashboardCard host={fake.host} input={input} result={result} />);
    await screen.findByText("Sales");
    expect(fake.callsTo("card_dashboard")[0]).toEqual({ dashboard_id: "d1" });
  });
});

describe("DashboardCard", () => {
  it("loads the layout first, then rows at most four panels at a time", async () => {
    const panels = [
      ...["a", "b", "c", "d", "e", "f"].map((id, i) => okPanel(id, i * 3)),
      {
        id: "n",
        x: 6,
        y: 0,
        w: 6,
        h: 3,
        title: "Hidden",
        state: "not_accessible",
        message: "Ask an admin for access.",
      },
    ];
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(layout({ panels })),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    await waitFor(() => expect(fake.callsTo("card_dashboard")).toHaveLength(3));
    const [first, ...batches] = fake.callsTo("card_dashboard");
    expect(first).not.toHaveProperty("panel_ids");
    const asked = batches.map((b) => b.panel_ids as string[]);
    for (const ids of asked) expect(ids.length).toBeLessThanOrEqual(4);
    expect(asked.flat().sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(screen.getByText("Ask an admin for access.")).toBeInTheDocument();
    await waitFor(() =>
      expect(echarts.instance.setOption).toHaveBeenCalledTimes(6)
    );
  });

  it("shows a panel's state message from its run", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(layout(), (id) => ({
        panel_id: id,
        state: "not_accessible",
        message: "You need expanded permissions.",
      })),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    expect(
      await screen.findByText("You need expanded permissions.")
    ).toBeInTheDocument();
    expect(echarts.init).not.toHaveBeenCalled();
  });

  it("says a panel too large to preview should be opened in Zeteo, and draws the others", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(
        layout({ panels: [okPanel("a"), okPanel("big", 3)] }),
        (id) => (id === "big" ? { id, state: "too_large" } : okLine(id))
      ),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    expect(
      await screen.findByText("Too large to preview; open in Zeteo.")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(echarts.instance.setOption).toHaveBeenCalledTimes(1)
    );
  });

  it("shows a batch's tool error on its panels", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: (args) =>
        args.panel_ids ? new CardToolError("Zeteo is busy.") : layout(),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    expect(await screen.findByText("Zeteo is busy.")).toBeInTheDocument();
  });

  it("says when there are no panels yet", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(layout({ panels: [] })),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    expect(await screen.findByText("No panels yet")).toBeInTheDocument();
    expect(fake.callsTo("card_dashboard")).toHaveLength(1);
  });

  it("opens the dashboard in Zeteo", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(layout()),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Open in Zeteo" })
    );
    expect(fake.host.openLink).toHaveBeenCalledWith(
      "https://zeteo.example/dashboards/d1"
    );
  });

  it("offers no way to open a dashboard without a url", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(layout({ url: null })),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    await screen.findByText("Sales");
    expect(
      screen.queryByRole("button", { name: "Open in Zeteo" })
    ).not.toBeInTheDocument();
  });

  it("offers no way to open a url that is not a web address", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(layout({ url: "javascript:alert(1)" })),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    await screen.findByText("Sales");
    expect(
      screen.queryByRole("button", { name: "Open in Zeteo" })
    ).not.toBeInTheDocument();
  });

  it("says a panel in a state it does not know can't be previewed", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(
        layout({ panels: [{ ...okPanel("m"), state: "something_new" }] })
      ),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    expect(await screen.findByText(CANNOT_PREVIEW)).toBeInTheDocument();
    expect(fake.callsTo("card_dashboard")).toHaveLength(1);
  });

  it("shows the layout's error description", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: () => new CardToolError("Dashboard not found."),
    });
    render(<DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />);
    expect(await screen.findByText("Dashboard not found.")).toBeInTheDocument();
  });

  it("lays panels on the grid, and stacks them one per row below 480 px", async () => {
    const fake = fakeCardHost("dashboard", {
      card_dashboard: cardDashboard(
        layout({ panels: [okPanel("a"), { ...okPanel("b"), x: 6 }] })
      ),
    });
    const { container } = render(
      <DashboardCard host={fake.host} input={{ id: "d1" }} result={{}} />
    );
    await screen.findByText("Sales");
    const grid = () => container.querySelector("[data-layout]");
    expect(grid()).toHaveAttribute("data-layout", "grid");
    const b = container.querySelector<HTMLElement>('[data-panel="b"]');
    expect(b?.style.gridColumn).toBe("7 / span 6");

    act(() => {
      window.innerWidth = 400;
      window.dispatchEvent(new Event("resize"));
    });
    expect(grid()).toHaveAttribute("data-layout", "stack");
    expect(
      container.querySelector<HTMLElement>('[data-panel="b"]')?.style.gridColumn
    ).toBe("");
  });
});
