import { beforeEach, describe, expect, it, vi } from "vitest";
import { SavedPanelsPage } from "./SavedPanelsPage";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import type { SavedPanel } from "../api/types";

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

const PANEL_ID = "f1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
const panel: SavedPanel = {
  id: PANEL_ID,
  name: "Revenue",
  description: "",
  owner: { id: "b1111111-1c7a-4a53-9d0e-6a3b1f2c4d01", name: "Ada" },
  state: "ok",
  chart: { version: 1, type: "stat", value: "revenue" },
  saved_query_id: "d1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};
const rows = {
  columns: [{ name: "revenue", type: "number" }],
  rows: [[1]],
  truncated: false,
};

const open = async (limited: boolean) => {
  post.mockImplementation(async (url: string) => {
    if (url === `/v1/saved-panels/${PANEL_ID}/preview`)
      return { data: { ...rows, ...(limited ? { rows_limited: true } : {}) } };
    throw new Error(`unexpected POST ${url}`);
  });
  const user = userEvent.setup();
  renderWithProviders(<SavedPanelsPage />);
  await user.click(await screen.findByRole("button", { name: "Preview" }));
  await screen.findByTestId("chart");
};

describe("SavedPanelsPage preview", () => {
  beforeEach(() => {
    get
      .mockReset()
      .mockImplementation(
        async (url: string, cfg?: { params?: { scope?: string } }) => {
          if (url === "/v1/saved-panels")
            return {
              data: {
                data: cfg?.params?.scope === "mine" ? [panel] : [],
                next_cursor: null,
              },
            };
          throw new Error(`unexpected ${url}`);
        }
      );
    post.mockReset();
  });

  it("shows the Rows limited pill when the viewer's rows are limited", async () => {
    await open(true);
    const pill = screen.getByText("Rows limited");
    expect(pill.closest("[title]")).toHaveAttribute(
      "title",
      expect.stringMatching(/only some rows/)
    );
  });

  it("shows no pill otherwise", async () => {
    await open(false);
    expect(screen.queryByText("Rows limited")).toBeNull();
  });
});
