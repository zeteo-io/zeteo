import { GROUP_ID, GRANT_ID, USER_ID, makeGrant } from "../testFixtures";
import { makeSource, SOURCE_ID } from "@/features/sources/testFixtures";
import { ORDERS_ID, makeTable } from "@/features/tables/testFixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocation, useNavigate } from "react-router-dom";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { rowNamed } from "@/test/rowNamed";
import { GrantsPage } from "./GrantsPage";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({
  permissions: ["zeteo.grants.write", "zeteo.sources.read"],
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, post, delete: del },
  })
);

const Where = () => {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="where">{location.search}</p>
      <p data-testid="path">{location.pathname}</p>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  );
};
const renderPage = (route = "/grants") =>
  renderWithProviders(
    <>
      <Where />
      <GrantsPage />
    </>,
    { route }
  );

const userGrant = makeGrant();
const orphan = makeGrant({
  id: "e2222222-1c7a-4a53-9d0e-6a3b1f2c4d02",
  principal_type: "group",
  principal_id: GROUP_ID,
  principal_status: "orphaned",
  all_columns: false,
  columns: [
    { id: "c1", name: "id", missing: false },
    { id: "c2", name: "note", missing: false },
  ],
  table: { id: ORDERS_ID, schema_name: "public", name: "gone", missing: true },
});

const lookupAnswer = async (_url: string, body: { principals: unknown[] }) => ({
  data: {
    data: (body.principals as { type: string; id: string }[]).map((p) => ({
      ...p,
      name: p.id === USER_ID ? "Ada Lovelace" : "Analysts",
      status: p.id === USER_ID ? "active" : "orphaned",
    })),
  },
});

const NOBODY_ID = "a9999999-1c7a-4a53-9d0e-6a3b1f2c4d77";
/** `GET /v1/principals/all`: the Who filter's choices. */
const directory = {
  data: [
    { type: "user", id: USER_ID, name: "Ada Lovelace", status: "active" },
    { type: "group", id: GROUP_ID, name: "Analysts", status: "active" },
    { type: "user", id: NOBODY_ID, name: "Nina Nobody", status: "active" },
  ],
  truncated: false,
};

// Who, Source and Table are kosmeo TableFilters menus: a button, then a checkbox.
const chooseFilter = async (
  user: ReturnType<typeof userEvent.setup>,
  title: string,
  option: string
) => {
  await user.click(
    await screen.findByRole("button", { name: new RegExp(`^${title}`) })
  );
  await user.click(await screen.findByRole("checkbox", { name: option }));
};

const grantParams = () =>
  get.mock.calls
    .filter(([url]) => url === "/v1/grants")
    .map(([, cfg]) => cfg.params as Record<string, unknown>);

describe("GrantsPage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.grants.write", "zeteo.sources.read"];
    del.mockReset().mockResolvedValue({ data: undefined });
    post.mockReset().mockImplementation(lookupAnswer);
    get.mockReset().mockImplementation(async (url: string) => {
      if (url === "/v1/grants") {
        return { data: { data: [userGrant, orphan], next_cursor: null } };
      }
      if (url === "/v1/sources") {
        return { data: { data: [makeSource()], next_cursor: null } };
      }
      if (url.endsWith("/tables")) {
        return { data: { data: [makeTable()], next_cursor: null } };
      }
      if (url === "/v1/principals/all") return { data: directory };
      throw new Error(`unexpected ${url}`);
    });
  });

  it("labels the rows through one lookup for the page", async () => {
    renderWithProviders(<GrantsPage />);
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].principals).toHaveLength(2);
    const row = await rowNamed("Ada Lovelace");
    expect(row).toHaveTextContent("orders");
    expect(row).toHaveTextContent("public.orders");
    expect(row).toHaveTextContent("All columns");
  });

  it("counts the columns of a partial grant and flags a missing table", async () => {
    renderWithProviders(<GrantsPage />);
    const row = (
      await screen.findByRole("link", { name: "public.gone" })
    ).closest("tr")!;
    expect(row).toHaveTextContent("2 columns");
    expect(row).toHaveTextContent(/missing/i);
  });

  it("keeps ids and says the name is unavailable when the lookup answers 502, without an orphaned badge of its own", async () => {
    post.mockReset().mockRejectedValue({
      status: 502,
      code: "tereo_unreachable",
      message: "Tereo could not be reached",
    });
    renderWithProviders(<GrantsPage />);
    const userRow = (await screen.findByText(USER_ID)).closest("tr")!;
    await waitFor(() => expect(userRow).toHaveTextContent("name unavailable"));
    expect(within(userRow).queryByText(/orphaned/i)).not.toBeInTheDocument();
    // The grants API itself called this one orphaned: that stays.
    const orphanRow = screen.getByText(GROUP_ID).closest("tr")!;
    expect(within(orphanRow).getByText("Orphaned")).toBeInTheDocument();
  });

  it("shows one badge for a grant whose principal both sources call orphaned", async () => {
    renderWithProviders(<GrantsPage />);
    const row = (
      await screen.findByRole("link", { name: "public.gone" })
    ).closest("tr")!;
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(within(row).getAllByText(/orphaned/i)).toHaveLength(1);
  });

  it("shows Unknown for a principal_status of unknown", async () => {
    get.mockImplementation(async (url: string) =>
      url === "/v1/grants"
        ? {
            data: {
              data: [makeGrant({ principal_status: "unknown" })],
              next_cursor: null,
            },
          }
        : { data: { data: [], next_cursor: null } }
    );
    renderWithProviders(<GrantsPage />);
    expect(await screen.findByText("Unknown")).toBeInTheDocument();
  });

  it("sends the filters of the address as the query", async () => {
    renderWithProviders(<GrantsPage />, {
      route: `/grants?source_id=${SOURCE_ID}&table_id=${ORDERS_ID}&principal_type=user&principal_id=${USER_ID}`,
    });
    await screen.findAllByText("Ada Lovelace");
    expect(grantParams()[0]).toMatchObject({
      source_id: SOURCE_ID,
      table_id: ORDERS_ID,
      principal_type: "user",
      principal_id: USER_ID,
    });
  });

  it("filters by source, then offers that source's tables", async () => {
    const user = userEvent.setup();
    renderWithProviders(<GrantsPage />);
    await screen.findByText("Ada Lovelace");
    expect(
      screen.queryByRole("button", { name: /^Table/ })
    ).not.toBeInTheDocument();

    await chooseFilter(user, "Source", "Orders DB");
    await waitFor(() =>
      expect(grantParams().some((p) => p.source_id === SOURCE_ID)).toBe(true)
    );
    await chooseFilter(user, "Table", "public.orders");
    await waitFor(() =>
      expect(grantParams().some((p) => p.table_id === ORDERS_ID)).toBe(true)
    );
  });

  it("names the sources in the filter, archived ones marked", async () => {
    const user = userEvent.setup();
    get.mockImplementation(async (url: string) => {
      if (url === "/v1/sources") {
        return {
          data: {
            data: [
              makeSource(),
              makeSource({
                id: "7a1d0b0e-1c7a-4a53-9d0e-6a3b1f2c4d66",
                name: "Legacy DB",
                archived_at: "2026-11-02T10:00:00.000Z",
              }),
            ],
            next_cursor: null,
          },
        };
      }
      if (url === "/v1/principals/all") return { data: directory };
      return { data: { data: [userGrant], next_cursor: null } };
    });
    renderWithProviders(<GrantsPage />);
    await screen.findByText("Ada Lovelace");
    await user.click(await screen.findByRole("button", { name: /^Source/ }));
    expect(screen.getByRole("checkbox", { name: "Orders DB" })).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Legacy DB (archived)" })
    ).toBeVisible();
  });

  it("drops a table from the address without a source once a source is chosen", async () => {
    const user = userEvent.setup();
    renderPage(`/grants?table_id=${ORDERS_ID}`);
    await screen.findByRole("button", { name: "Clear table" });
    await chooseFilter(user, "Source", "Orders DB");
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(
        `?source_id=${SOURCE_ID}`
      )
    );
    expect(screen.getByTestId("where").textContent).not.toContain("table_id");
    expect(grantParams().at(-1)).not.toHaveProperty("table_id");
  });

  it("drops the table when the source changes", async () => {
    const user = userEvent.setup();
    renderPage(`/grants?source_id=${SOURCE_ID}&table_id=${ORDERS_ID}`);
    await screen.findByText("Ada Lovelace");
    await user.click(await screen.findByRole("button", { name: /^Source/ }));
    await user.click(screen.getByRole("checkbox", { name: "Orders DB" }));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(/^$/)
    );
  });

  it("filters by anyone in the directory, granted or not, through the API and the address", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Ada Lovelace");
    await chooseFilter(user, "Who", "Nina Nobody");
    await waitFor(() =>
      expect(grantParams().at(-1)).toMatchObject({
        principal_type: "user",
        principal_id: NOBODY_ID,
      })
    );
    expect(screen.getByTestId("where")).toHaveTextContent(
      `?principal_type=user&principal_id=${NOBODY_ID}`
    );
    await chooseFilter(user, "Who", "Analysts (group)");
    await waitFor(() =>
      expect(grantParams().at(-1)).toMatchObject({
        principal_type: "group",
        principal_id: GROUP_ID,
      })
    );
    expect(get).toHaveBeenCalledWith("/v1/principals/all", expect.anything());
  });

  it("finds a person with the Who filter's own search", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Ada Lovelace");
    await user.click(await screen.findByRole("button", { name: /^Who/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Search Who options" }),
      "nina"
    );
    expect(screen.getByRole("checkbox", { name: "Nina Nobody" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Ada Lovelace" })).toBeNull();
  });

  it("preselects the principal of a deep link, and clears it", async () => {
    const user = userEvent.setup();
    renderPage(`/grants?principal_type=user&principal_id=${USER_ID}`);
    await screen.findAllByText("Ada Lovelace");
    await user.click(await screen.findByRole("button", { name: /^Who/ }));
    const ada = screen.getByRole("checkbox", { name: "Ada Lovelace" });
    expect(ada).toBeChecked();
    await user.click(ada);
    await waitFor(() =>
      expect(grantParams().at(-1)).not.toHaveProperty("principal_id")
    );
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(/^$/)
    );
  });

  it("keeps a deep link to someone the directory does not list", async () => {
    const user = userEvent.setup();
    const gone = "a8888888-1c7a-4a53-9d0e-6a3b1f2c4d88";
    renderPage(`/grants?principal_type=group&principal_id=${gone}`);
    await screen.findByText("Ada Lovelace");
    await user.click(await screen.findByRole("button", { name: /^Who/ }));
    expect(
      screen.getByRole("checkbox", { name: "Unknown group (group)" })
    ).toBeChecked();
    expect(grantParams().at(-1)).toMatchObject({ principal_id: gone });
    expect(screen.getByTestId("where")).toHaveTextContent(
      `principal_id=${gone}`
    );
  });

  it("shows a deep-linked principal as a chip when the directory is unreachable", async () => {
    const user = userEvent.setup();
    const answer = get.getMockImplementation()!;
    get.mockImplementation(async (url: string, cfg: unknown) => {
      if (url === "/v1/principals/all") {
        throw {
          isAxiosError: true,
          response: { status: 502, data: { error: "tereo_unreachable" } },
        };
      }
      return answer(url, cfg);
    });
    renderPage(`/grants?principal_type=user&principal_id=${USER_ID}`);
    await screen.findAllByText("Ada Lovelace");
    expect(screen.queryByRole("button", { name: /^Who/ })).toBeNull();
    await user.click(
      await screen.findByRole("button", { name: "Clear person or group" })
    );
    await waitFor(() =>
      expect(grantParams().at(-1)).not.toHaveProperty("principal_id")
    );
  });

  it("offers Edit and Delete rows with zeteo.grants.write, and deletes after confirming", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowNamed("Ada Lovelace");
    expect(
      screen.getByRole("button", { name: "New grant" })
    ).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete grant" }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/grants/${GRANT_ID}`)
    );
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit grant")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("opens New grant as a dialog over the list", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "New grant" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "Create grant" })
    ).toBeDisabled();
    expect(screen.getByTestId("path")).toHaveTextContent(/^\/grants$/);
  });

  it("has no write control without zeteo.grants.write", async () => {
    held.permissions = ["zeteo.grants.read"];
    renderWithProviders(<GrantsPage />);
    await screen.findByText("Ada Lovelace");
    expect(
      screen.queryByRole("button", { name: "Edit" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New grant" })
    ).not.toBeInTheDocument();
  });

  it("lists grants from the names the grants API gives, without the sources API, and says why the filters are missing", async () => {
    held.permissions = ["zeteo.grants.read"];
    renderWithProviders(<GrantsPage />);
    await screen.findByText("Ada Lovelace");
    expect(get.mock.calls.some(([url]) => url === "/v1/sources")).toBe(false);
    expect(
      screen.getByText(/needs the Read sources permission/)
    ).toBeInTheDocument();
  });

  it("names whose grant on which table is removed in the confirmation", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowNamed("Ada Lovelace");
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(
      screen.getByText(
        "Remove Ada Lovelace's grant on orders · public.orders? They will no longer be able to query this table through this grant."
      )
    ).toBeInTheDocument();
  });

  it("names the principal by type and id while the lookup has no name", async () => {
    post
      .mockReset()
      .mockRejectedValue({ status: 502, code: "x", message: "x" });
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText(USER_ID)).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(
      screen.getByText(new RegExp(`^Remove user ${USER_ID}'s grant on orders`))
    ).toBeInTheDocument();
  });

  describe("filters in the address", () => {
    it("drops invalid values from the request and the address", async () => {
      renderPage(
        `/grants?source_id=nope&table_id=${ORDERS_ID}&principal_type=robot&principal_id=${USER_ID}`
      );
      await screen.findByText("Ada Lovelace");
      expect(grantParams()[0]).toEqual({ table_id: ORDERS_ID, limit: 50 });
      await waitFor(() =>
        expect(screen.getByTestId("where")).toHaveTextContent(
          `?table_id=${ORDERS_ID}`
        )
      );
      expect(screen.getByTestId("where").textContent).not.toMatch(/nope|robot/);
    });

    it("applies a principal only as a complete pair", async () => {
      renderPage(`/grants?principal_type=user`);
      await screen.findByText("Ada Lovelace");
      expect(grantParams()[0]).toEqual({ limit: 50 });
      await waitFor(() =>
        expect(screen.getByTestId("where")).toHaveTextContent(/^$/)
      );
      expect(
        screen.queryByRole("button", { name: "Clear person or group" })
      ).toBeNull();
    });

    it("keeps a table without a source, shows it, and lets it be cleared", async () => {
      const user = userEvent.setup();
      renderPage(`/grants?table_id=${ORDERS_ID}`);
      await screen.findByText("Ada Lovelace");
      expect(grantParams()[0]).toMatchObject({ table_id: ORDERS_ID });
      const chip = (
        await screen.findByRole("button", { name: "Clear table" })
      ).closest(".z-filter-chip")!;
      expect(chip).toHaveTextContent("Table: public.orders");
      expect(screen.getByTestId("where")).toHaveTextContent(
        `?table_id=${ORDERS_ID}`
      );
      await user.click(screen.getByRole("button", { name: "Clear table" }));
      await waitFor(() =>
        expect(grantParams().at(-1)).not.toHaveProperty("table_id")
      );
    });

    it("shows every active filter as a chip with its own clear, without zeteo.sources.read", async () => {
      held.permissions = ["zeteo.grants.read"];
      const user = userEvent.setup();
      renderPage(
        `/grants?source_id=${SOURCE_ID}&table_id=${ORDERS_ID}&principal_type=user&principal_id=${USER_ID}`
      );
      await screen.findAllByText("Ada Lovelace");
      const chip = async (name: string) =>
        (await screen.findByRole("button", { name })).closest(
          ".z-filter-chip"
        )!;
      expect(await chip("Clear source")).toHaveTextContent("Source: orders");
      expect(await chip("Clear table")).toHaveTextContent(
        "Table: public.orders"
      );
      expect(screen.queryByRole("button", { name: /^Source/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Clear source" }));
      await waitFor(() =>
        expect(screen.getByTestId("where").textContent).not.toMatch(
          /source_id|table_id/
        )
      );
      // The person is in the Who filter, which needs no Read sources.
      await user.click(await screen.findByRole("button", { name: /^Who/ }));
      await user.click(screen.getByRole("checkbox", { name: "Ada Lovelace" }));
      await waitFor(() =>
        expect(screen.getByTestId("where")).toHaveTextContent(/^$/)
      );
    });

    it("applies an upper-case UUID in lower case, in the request and the address", async () => {
      renderPage(
        `/grants?principal_type=user&principal_id=${USER_ID.toUpperCase()}&table_id=${ORDERS_ID.toUpperCase()}`
      );
      await screen.findAllByText("Ada Lovelace");
      expect(grantParams()[0]).toMatchObject({
        principal_id: USER_ID,
        table_id: ORDERS_ID,
      });
      await waitFor(() =>
        expect(screen.getByTestId("where")).toHaveTextContent(
          `?table_id=${ORDERS_ID}&principal_type=user&principal_id=${USER_ID}`
        )
      );
    });

    it("says no grant matches when filters are active, and no grants yet when none are", async () => {
      get.mockImplementation(async () => ({
        data: { data: [], next_cursor: null },
      }));
      renderPage(`/grants?table_id=${ORDERS_ID}`);
      expect(
        await screen.findByText("No grant matches these filters.")
      ).toBeInTheDocument();
      expect(screen.queryByText("No grants yet.")).toBeNull();

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Clear table" }));
      expect(await screen.findByText("No grants yet.")).toBeInTheDocument();
      expect(screen.queryByText("No grant matches these filters.")).toBeNull();
    });

    it("steps through filter states with Back", async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText("Ada Lovelace");
      await chooseFilter(user, "Source", "Orders DB");
      await waitFor(() =>
        expect(screen.getByTestId("where")).toHaveTextContent(
          `source_id=${SOURCE_ID}`
        )
      );
      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() =>
        expect(screen.getByTestId("where")).toHaveTextContent(/^$/)
      );
      expect(grantParams().at(-1)).not.toHaveProperty("source_id");
    });
  });

  describe("one status badge", () => {
    const only = async (grant: ReturnType<typeof makeGrant>) => {
      get.mockImplementation(async (url: string) =>
        url === "/v1/grants"
          ? { data: { data: [grant], next_cursor: null } }
          : { data: { data: [], next_cursor: null } }
      );
      renderPage();
      return (await screen.findByText(/Ada Lovelace|name unavailable/)).closest(
        "tr"
      )!;
    };

    it("shows only Unknown when the grant is unknown and the lookup says inactive", async () => {
      post.mockImplementation(
        async (_u: string, body: { principals: object[] }) => ({
          data: {
            data: body.principals.map((p) => ({
              ...p,
              name: "Ada Lovelace",
              status: "inactive",
            })),
          },
        })
      );
      const row = await only(makeGrant({ principal_status: "unknown" }));
      expect(within(row).getByText("Unknown")).toBeInTheDocument();
      expect(within(row).queryByText("Inactive")).toBeNull();
    });

    it("shows Inactive from the lookup alone", async () => {
      post.mockImplementation(
        async (_u: string, body: { principals: object[] }) => ({
          data: {
            data: body.principals.map((p) => ({
              ...p,
              name: "Ada Lovelace",
              status: "inactive",
            })),
          },
        })
      );
      const row = await only(makeGrant());
      expect(await within(row).findByText("Inactive")).toBeInTheDocument();
    });

    it("adds no Orphaned badge when only the lookup says orphaned", async () => {
      post.mockImplementation(
        async (_u: string, body: { principals: object[] }) => ({
          data: {
            data: body.principals.map((p) => ({
              ...p,
              name: null,
              status: "orphaned",
            })),
          },
        })
      );
      get.mockImplementation(async (url: string) =>
        url === "/v1/grants"
          ? { data: { data: [makeGrant()], next_cursor: null } }
          : { data: { data: [], next_cursor: null } }
      );
      renderPage();
      const row = (await screen.findByText(USER_ID)).closest("tr")!;
      await waitFor(() => expect(post).toHaveBeenCalled());
      expect(within(row).queryByText(/orphaned/i)).toBeNull();
    });

    it("shows Orphaned and name unavailable when the grant is orphaned and the lookup fails", async () => {
      post
        .mockReset()
        .mockRejectedValue({ status: 502, code: "x", message: "x" });
      const row = await only(makeGrant({ principal_status: "orphaned" }));
      expect(within(row).getByText("Orphaned")).toBeInTheDocument();
      expect(row).toHaveTextContent("name unavailable");
    });
  });
});
