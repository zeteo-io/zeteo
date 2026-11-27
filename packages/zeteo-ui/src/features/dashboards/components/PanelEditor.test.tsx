import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { pickOption } from "@/test/searchSelect";
import { PanelEditor } from "./PanelEditor";
import { problemText } from "../editing";
import {
  makeSavedQuery,
  SAVED_ID,
} from "@/features/saved-queries/testFixtures";

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

const monthly = makeSavedQuery({
  name: "Monthly revenue",
  query: {
    source: "sales-db",
    from: "orders",
    select: [
      { bucket: "month", column: "created_at", as: "month" },
      { sum: "total", as: "revenue" },
    ],
    groupBy: ["month"],
  },
});

const catalog = {
  sources: [
    {
      slug: "sales-db",
      name: "Sales",
      type: "postgres",
      tables: [
        {
          name: "orders",
          kind: "table",
          columns: [
            { name: "created_at", type: "timestamp" },
            { name: "shipped_at", type: "timestamp" },
            { name: "total", type: "number" },
          ],
          relations: [],
        },
      ],
    },
  ],
};

const result = {
  columns: [
    { name: "month", type: "timestamp" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["2026-09-01T00:00:00.000Z", 10],
    ["2026-10-01T00:00:00.000Z", 20],
  ],
  truncated: false,
  warnings: [],
  run_id: "r1",
};

const field = (label: string) => screen.getByLabelText(label);

const open = async (onSubmit = vi.fn().mockResolvedValue({})) => {
  const user = userEvent.setup();
  renderWithProviders(
    <PanelEditor
      heading="Add panel"
      submitLabel="Add panel"
      purpose="dashboard"
      allowLinked
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />
  );
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      "/v1/saved-queries",
      expect.objectContaining({
        params: expect.objectContaining({ scope: "mine" }),
      })
    )
  );
  await pickOption(user, field("Saved query"), "Monthly revenue");
  return { user, onSubmit };
};

describe("PanelEditor", () => {
  beforeEach(() => {
    get.mockReset().mockImplementation(async (url: string, opts) => {
      if (url === "/v1/saved-queries") {
        return {
          data: {
            data: opts?.params?.scope === "mine" ? [monthly] : [],
            next_cursor: null,
          },
        };
      }
      if (url === `/v1/saved-queries/${SAVED_ID}`) return { data: monthly };
      if (url === "/v1/catalog") return { data: catalog };
      return { data: { data: [], next_cursor: null } };
    });
    post.mockReset().mockImplementation(async (url: string) => {
      if (url === `/v1/saved-queries/${SAVED_ID}/run`) return { data: result };
      throw new Error(`unexpected POST ${url}`);
    });
  });

  it("suggests a line for a date bucket and a number, and preselects the bucket's column as the time column", async () => {
    await open();
    await waitFor(() => expect(field("Chart type")).toHaveValue("Line"));
    await waitFor(() => expect(field("Time column")).toHaveValue("created_at"));
    expect(await screen.findByTestId("chart")).toHaveTextContent("line chart");
    expect(field("X axis")).toHaveValue("month");
    expect(screen.getByRole("checkbox", { name: "revenue" })).toBeChecked();
  });

  it("offers every reachable date or timestamp column as the time column", async () => {
    const { user } = await open();
    await waitFor(() => expect(field("Time column")).toHaveValue("created_at"));
    await pickOption(user, field("Time column"), "shipped_at");
    expect(field("Time column")).toHaveValue("shipped_at");
  });

  it("sends the saved query, chart and time column", async () => {
    const { user, onSubmit } = await open();
    await waitFor(() => expect(field("Time column")).toHaveValue("created_at"));
    await user.click(screen.getByRole("button", { name: "Add panel" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        kind: "own",
        saved_query_id: SAVED_ID,
        chart: { type: "line", version: 1, x: "month", y: ["revenue"] },
        time_column: "created_at",
      })
    );
  });

  it("shows a server invalid_panel problem next to its setting", async () => {
    const onSubmit = vi.fn().mockRejectedValue({
      status: 400,
      code: "invalid_panel",
      message: "The chart does not fit the saved query",
      problems: [{ setting: "x", problem: "wrong_type" }],
    });
    const { user } = await open(onSubmit);
    await waitFor(() => expect(field("Chart type")).toHaveValue("Line"));
    await user.click(screen.getByRole("button", { name: "Add panel" }));
    const problem = await screen.findByText(problemText("wrong_type"));
    expect(problem.closest("[data-setting]")).toHaveAttribute(
      "data-setting",
      "x"
    );
  });

  it("shows the Rows limited pill beside a preview of limited rows, with its default tooltip", async () => {
    post.mockImplementation(async (url: string) => {
      if (url === `/v1/saved-queries/${SAVED_ID}/run`)
        return {
          data: { ...result, rows_limited: true },
        };
      throw new Error(`unexpected POST ${url}`);
    });
    await open();
    const pill = await screen.findByText("Rows limited");
    expect(pill.closest("[title]")).toHaveAttribute(
      "title",
      expect.stringMatching(/only some rows/)
    );
  });

  it("shows no pill when the rows are not limited", async () => {
    await open();
    await screen.findByTestId("chart");
    expect(screen.queryByText("Rows limited")).toBeNull();
  });
});
