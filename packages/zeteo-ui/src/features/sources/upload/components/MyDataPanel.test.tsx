import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FS_ID, makeUploadSource } from "../testFixtures";
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

describe("My sources", () => {
  beforeEach(() => {
    state.permissions = ["zeteo.data.read", "zeteo.file_sources.write"];
    state.fileSources = true;
    get.mockReset().mockImplementation(async (url: string) =>
      url === "/v1/sources"
        ? {
            data: {
              data: [
                makeUploadSource(),
                makeUploadSource({
                  id: "f9999999-1c7a-4a53-9d0e-6a3b1f2c4d09",
                  slug: "budget",
                  name: "Budget 2027",
                  share_count: 0,
                  size_bytes: 1024,
                  created_at: "2026-11-12T08:00:00.000Z",
                }),
              ],
              next_cursor: null,
            },
          }
        : { data: { data: [], next_cursor: null } }
    );
    del.mockReset().mockResolvedValue({});
  });

  it("is a tab of My Zeteo with zeteo.file_sources.write", async () => {
    at();
    expect(
      await screen.findByRole("link", { name: "My sources" })
    ).toHaveAttribute("href", "/my?tab=sources");
  });

  it("is hidden without zeteo.file_sources.write, and its address shows the overview", async () => {
    state.permissions = ["zeteo.data.read"];
    at("sources");
    expect(
      await screen.findByRole("heading", { name: "Recent runs" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "My sources" })).toBeNull();
    expect(get).not.toHaveBeenCalledWith("/v1/sources", expect.anything());
  });

  it("is hidden while File Sources are off on the server", async () => {
    state.fileSources = false;
    at();
    await screen.findByRole("link", { name: "Overview" });
    // Give the config a moment to answer.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("link", { name: "My sources" })).toBeNull();
  });

  it("lists the person's own upload sources with their size, sharing and when they were added", async () => {
    at("sources");
    const link = await screen.findByRole("link", { name: "Q3 sales" });
    expect(link).toHaveAttribute("href", `/sources/${FS_ID}`);
    expect(get).toHaveBeenCalledWith(
      "/v1/sources",
      expect.objectContaining({
        params: expect.objectContaining({ type: "upload", owner_id: "me" }),
      })
    );
    expect(
      screen.getAllByRole("columnheader").map((h) => h.textContent)
    ).toEqual(["Name", "Size", "Shared with", "Added", ""]);
    const row = link.closest("tr")!;
    const cells = row.querySelectorAll("td");
    expect(cells[0]).toHaveTextContent("q3-sales");
    expect(cells[1]).toHaveTextContent("2.4 MB");
    // Shared with two people or groups; the other source with nobody.
    expect(cells[2]).toHaveTextContent("2");
    expect(cells[3]!.querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-11-10T10:00:00.000Z"
    );
    const budget = screen.getByText("Budget 2027").closest("tr")!;
    expect(budget).toHaveTextContent("Not shared");
    expect(budget).toHaveTextContent("1.0 KB");
    expect(
      screen.getByRole("button", { name: "Add data" })
    ).toBeInTheDocument();
  });

  it("searches by name", async () => {
    const user = userEvent.setup();
    at("sources");
    await screen.findByText("Budget 2027");
    await user.type(screen.getByLabelText("Search"), "budget");
    await waitFor(() => expect(screen.queryByText("Q3 sales")).toBeNull());
  });

  it("deletes a source after a confirmation", async () => {
    const user = userEvent.setup();
    at("sources");
    const row = (await screen.findByText("Q3 sales")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete source",
      })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/sources/${FS_ID}`)
    );
  });
});
