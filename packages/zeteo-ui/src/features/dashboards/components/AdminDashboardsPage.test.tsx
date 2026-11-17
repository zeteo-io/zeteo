import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSavedPanelsPage } from "./AdminSavedPanelsPage";
import { AdminDashboardsPage } from "./AdminDashboardsPage";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { makeDashboard } from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, delete: del },
  })
);

const OWNER = {
  id: "d1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
  name: "Olive Owner",
};
const dashboard = makeDashboard({
  owner: OWNER,
  share_count: 2,
  panels: undefined as never,
});
const panel = {
  id: "e1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
  name: "Revenue by region",
  description: "",
  owner: OWNER,
  state: "ok",
  used_by: { dashboards: 3 },
  share_count: 1,
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-02T10:00:00.000Z",
};

const listParams = (url: string) =>
  get.mock.calls
    .filter(([u]) => u === url)
    .map(([, cfg]) => cfg.params as Record<string, unknown>);

beforeEach(() => {
  held.permissions = ["zeteo.dashboards.read", "zeteo.dashboards.write"];
  del.mockReset().mockResolvedValue({});
  get.mockReset().mockImplementation(async (url: string) => {
    if (url === "/v1/dashboards") {
      return { data: { data: [dashboard], next_cursor: null } };
    }
    if (url === "/v1/saved-panels") {
      return { data: { data: [panel], next_cursor: null } };
    }
    throw new Error(`unexpected ${url}`);
  });
});

describe("AdminDashboardsPage", () => {
  it("lists every dashboard with owner and share count", async () => {
    renderWithProviders(<AdminDashboardsPage />);
    const row = (await screen.findByText("Sales")).closest("tr")!;
    expect(row).toHaveTextContent("Olive Owner");
    expect(row).toHaveTextContent("2");
    expect(listParams("/v1/dashboards")[0]).toMatchObject({ scope: "all" });
    expect(screen.getByRole("link", { name: "Sales" })).toHaveAttribute(
      "href",
      `/dashboards/${dashboard.id}`
    );
  });

  it("offers share, transfer and delete with the write permission, and deletes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminDashboardsPage />);
    const row = (await screen.findByText("Sales")).closest("tr")!;
    expect(within(row).getByRole("button", { name: "Share" })).toBeVisible();
    expect(within(row).getByRole("button", { name: "Transfer" })).toBeVisible();
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" })
    );
    expect(del).toHaveBeenCalledWith(`/v1/dashboards/${dashboard.id}`);
  });

  it("hides the actions without the write permission", async () => {
    held.permissions = ["zeteo.dashboards.read"];
    renderWithProviders(<AdminDashboardsPage />);
    await screen.findByText("Sales");
    for (const name of ["Share", "Transfer", "Delete"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});

describe("AdminSavedPanelsPage", () => {
  it("lists every saved panel with where it is used", async () => {
    renderWithProviders(<AdminSavedPanelsPage />);
    const row = (await screen.findByText("Revenue by region")).closest("tr")!;
    expect(row).toHaveTextContent("Olive Owner");
    expect(row).toHaveTextContent("3 dashboards");
    expect(listParams("/v1/saved-panels")[0]).toMatchObject({ scope: "all" });
    expect(within(row).getByRole("button", { name: "Share" })).toBeVisible();
  });

  it("hides the actions without the write permission", async () => {
    held.permissions = ["zeteo.dashboards.read"];
    renderWithProviders(<AdminSavedPanelsPage />);
    await screen.findByText("Revenue by region");
    for (const name of ["Share", "Transfer", "Delete"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});
