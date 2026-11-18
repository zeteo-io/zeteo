import { makeSource, SOURCE_ID } from "@/features/sources/testFixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSavedQuery, OWNER_ID } from "../testFixtures";
import { SavedQueriesPage } from "./SavedQueriesPage";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import {
  filterOptionChecked,
  openFilterMenu,
  toggleFilterOption,
} from "@/test/whoFilter";

const get = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, post, delete: del },
  })
);

const row = makeSavedQuery({
  share_count: 3,
  last_run_at: "2026-11-10T10:00:00.000Z",
});

const GROUP = "f1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
/** `GET /v1/principals/all`: the Owner and Shared with filters' choices. */
const directory = {
  data: [
    { type: "user", id: OWNER_ID, name: "Olive Owner", status: "active" },
    { type: "group", id: GROUP, name: "Analysts", status: "active" },
  ],
  truncated: false,
};

const listParams = () =>
  get.mock.calls
    .filter(([url]) => url === "/v1/saved-queries")
    .map(([, cfg]) => cfg.params as Record<string, unknown>);

describe("SavedQueriesPage", () => {
  beforeEach(() => {
    held.permissions = [
      "zeteo.saved_queries.read",
      "zeteo.saved_queries.write",
      "zeteo.sources.read",
    ];
    del.mockReset().mockResolvedValue({});
    post
      .mockReset()
      .mockImplementation(
        async (
          _url: string,
          body: { principals: { type: string; id: string }[] }
        ) => ({
          data: {
            data: body.principals.map((p) => ({
              ...p,
              name: "Analysts",
              status: "active",
            })),
          },
        })
      );
    get.mockReset().mockImplementation(async (url: string) => {
      if (url === "/v1/saved-queries") {
        return { data: { data: [row], next_cursor: null } };
      }
      if (url === "/v1/sources") {
        return { data: { data: [makeSource()], next_cursor: null } };
      }
      if (url === "/v1/principals/all") return { data: directory };
      throw new Error(`unexpected ${url}`);
    });
  });

  it("lists every saved query with owner, source, share count and last run", async () => {
    renderWithProviders(<SavedQueriesPage />);
    const cells = (await screen.findByText("Weekly revenue")).closest("tr")!;
    expect(cells).toHaveTextContent("Olive Owner");
    expect(cells).toHaveTextContent("sales-db");
    expect(cells).toHaveTextContent("3");
    expect(cells.querySelector("time")).toHaveAttribute(
      "title",
      expect.stringContaining("2026")
    );
    expect(listParams()[0]).toMatchObject({ scope: "all" });
  });

  it("shows the source column and filter only with zeteo.sources.read", async () => {
    renderWithProviders(<SavedQueriesPage />);
    await screen.findByText("Weekly revenue");
    expect(
      screen.getByRole("columnheader", { name: "Source" })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /^Source/ })
    ).toBeInTheDocument();
  });

  it("omits the source column and filter without it", async () => {
    held.permissions = ["zeteo.saved_queries.read"];
    get.mockImplementation(async (url: string) => {
      if (url === "/v1/saved-queries") {
        return {
          data: {
            data: [{ ...row, source: undefined }],
            next_cursor: null,
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderWithProviders(<SavedQueriesPage />);
    await screen.findByText("Weekly revenue");
    expect(
      screen.queryByRole("columnheader", { name: "Source" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Source/ })
    ).not.toBeInTheDocument();
    expect(get.mock.calls.some(([url]) => url === "/v1/sources")).toBe(false);
  });

  it("hides share, transfer and delete without zeteo.saved_queries.write", async () => {
    held.permissions = ["zeteo.saved_queries.read", "zeteo.sources.read"];
    renderWithProviders(<SavedQueriesPage />);
    await screen.findByText("Weekly revenue");
    for (const name of ["Share", "Transfer", "Delete"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("offers the row actions with write, and deletes after confirming", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SavedQueriesPage />);
    await screen.findByText("Weekly revenue");
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Transfer" })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/saved-queries/${row.id}`)
    );
  });

  it("filters by source", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SavedQueriesPage />);
    await screen.findByText("Weekly revenue");
    await user.click(await screen.findByRole("button", { name: /^Source/ }));
    await user.click(
      await screen.findByRole("checkbox", { name: "Orders DB" })
    );
    await waitFor(() =>
      expect(listParams().at(-1)).toMatchObject({ source_id: SOURCE_ID })
    );
  });

  it("filters by owner given in the address", async () => {
    renderWithProviders(<SavedQueriesPage />, {
      route: `/saved-queries?owner_id=${OWNER_ID}`,
    });
    await screen.findByText("Weekly revenue");
    expect(listParams()[0]).toMatchObject({ owner_id: OWNER_ID });
  });

  it("preselects the owner of the address in the Owner filter, users only", async () => {
    held.permissions.push("zeteo.grants.read");
    const user = userEvent.setup();
    renderWithProviders(<SavedQueriesPage />, {
      route: `/saved-queries?owner_id=${OWNER_ID}`,
    });
    await screen.findByText("Weekly revenue");
    expect(await filterOptionChecked(user, "Olive Owner", "Owner")).toBe(true);
    const owners = await openFilterMenu(user, "Owner");
    expect(owners.queryByRole("checkbox", { name: /Analysts/ })).toBeNull();
  });

  it("filters by the owner and the group a saved query is shared with, chosen by name", async () => {
    held.permissions.push("zeteo.grants.read");
    const user = userEvent.setup();
    renderWithProviders(<SavedQueriesPage />);
    await screen.findByText("Weekly revenue");
    await toggleFilterOption(user, "Analysts (group)", "Shared with");
    await waitFor(() =>
      expect(listParams().at(-1)).toMatchObject({
        shared_with_type: "group",
        shared_with_id: GROUP,
      })
    );
    await toggleFilterOption(user, "Olive Owner", "Owner");
    await waitFor(() =>
      expect(listParams().at(-1)).toMatchObject({
        owner_id: OWNER_ID,
        shared_with_type: "group",
        shared_with_id: GROUP,
      })
    );
  });

  it("without zeteo.grants.read, has no people filters, says why, and keeps the address's owner as a chip", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SavedQueriesPage />, {
      route: `/saved-queries?owner_id=${OWNER_ID}`,
    });
    await screen.findByText("Weekly revenue");
    expect(screen.queryByRole("button", { name: /^Owner/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Shared with/ })).toBeNull();
    expect(
      screen.getByText(/Filtering by owner or by who it is shared with needs/)
    ).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith(
      "/v1/principals/all",
      expect.anything()
    );
    await user.click(screen.getByRole("button", { name: "Clear owner" }));
    await waitFor(() =>
      expect(listParams().at(-1)).not.toHaveProperty("owner_id")
    );
  });
});
