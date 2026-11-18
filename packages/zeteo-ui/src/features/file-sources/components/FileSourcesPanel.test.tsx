import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FS_ID, makeFileSource } from "../testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { TEST_UI_CONFIG } from "@/test/uiConfig";
import { MyPage } from "@/features/my";

const get = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  permissions: ["zeteo.data.read", "zeteo.file_sources.write"],
  fileSources: true,
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => state.permissions,
    api: { get, delete: del },
  })
);
vi.mock("@/lib/config", async () => ({
  ...(await vi.importActual<typeof import("@/lib/config")>("@/lib/config")),
  loadConfig: async () => ({
    ...TEST_UI_CONFIG,
    fileSources: state.fileSources,
  }),
}));

const at = (tab?: string) =>
  renderWithProviders(<MyPage />, { route: tab ? `/my?tab=${tab}` : "/my" });

describe("My data", () => {
  beforeEach(() => {
    state.permissions = ["zeteo.data.read", "zeteo.file_sources.write"];
    state.fileSources = true;
    get.mockReset().mockImplementation(async (url: string) =>
      url === "/v1/file-sources"
        ? {
            data: {
              data: [
                makeFileSource(),
                makeFileSource({
                  id: "f9999999-1c7a-4a53-9d0e-6a3b1f2c4d09",
                  slug: "budget",
                  name: "Budget 2027",
                  tables: [],
                }),
              ],
            },
          }
        : { data: { data: [], next_cursor: null } }
    );
    del.mockReset().mockResolvedValue({});
  });

  it("is a tab of My Zeteo with zeteo.file_sources.write", async () => {
    at();
    expect(
      await screen.findByRole("link", { name: "My data" })
    ).toHaveAttribute("href", "/my?tab=data");
  });

  it("is hidden without zeteo.file_sources.write, and its address shows the overview", async () => {
    state.permissions = ["zeteo.data.read"];
    at("data");
    expect(
      await screen.findByRole("heading", { name: "Recent runs" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "My data" })).toBeNull();
    expect(get).not.toHaveBeenCalledWith("/v1/file-sources", expect.anything());
  });

  it("is hidden while File Sources are off on the server", async () => {
    state.fileSources = false;
    at();
    await screen.findByRole("link", { name: "Overview" });
    // Give the config a moment to answer.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("link", { name: "My data" })).toBeNull();
  });

  it("lists the person's own file sources with their tables, last load and size", async () => {
    at("data");
    const link = await screen.findByRole("link", { name: "Q3 sales" });
    expect(link).toHaveAttribute("href", `/my/data/${FS_ID}`);
    expect(get).toHaveBeenCalledWith(
      "/v1/file-sources",
      expect.objectContaining({ params: { scope: "mine" } })
    );
    const row = link.closest("tr")!;
    expect(row).toHaveTextContent("orders");
    expect(row).toHaveTextContent("2.4 MB");
    expect(row.querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-11-15T09:30:00.000Z"
    );
    expect(
      screen.getByRole("button", { name: "Add data" })
    ).toBeInTheDocument();
  });

  it("searches by name", async () => {
    const user = userEvent.setup();
    at("data");
    await screen.findByText("Budget 2027");
    await user.type(screen.getByLabelText("Search"), "budget");
    await waitFor(() => expect(screen.queryByText("Q3 sales")).toBeNull());
  });

  it("deletes a source after a confirmation", async () => {
    const user = userEvent.setup();
    at("data");
    const row = (await screen.findByText("Q3 sales")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete source",
      })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/file-sources/${FS_ID}`)
    );
  });
});
