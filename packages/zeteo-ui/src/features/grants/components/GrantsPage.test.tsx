import { GROUP_ID, GRANT_ID, USER_ID, makeGrant } from "../testFixtures";
import { makeSource, SOURCE_ID } from "@/features/sources/testFixtures";
import { ORDERS_ID, makeTable } from "@/features/tables/testFixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { GrantsPage } from "./GrantsPage";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({
  permissions: ["zeteo.grants.write", "zeteo.sources.read"],
}));
vi.mock("@/lib/api/client", () => ({ api: { get, post, delete: del } }));
vi.mock("@/lib/auth", async () => {
  const { mockAuth } = await import("@/test/authMock");
  return {
    ...mockAuth(),
    useAuth: () => mockAuth({ permissions: held.permissions }).useAuth(),
  };
});

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
      throw new Error(`unexpected ${url}`);
    });
  });

  it("labels the rows through one lookup for the page", async () => {
    renderWithProviders(<GrantsPage />);
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].principals).toHaveLength(2);
    const row = screen.getByText("Ada Lovelace").closest("tr")!;
    expect(row).toHaveTextContent("orders");
    expect(row).toHaveTextContent("public.orders");
    expect(row).toHaveTextContent("All columns");
  });

  it("counts the columns of a partial grant and flags a missing table", async () => {
    renderWithProviders(<GrantsPage />);
    const row = (await screen.findByText("public.gone")).closest("tr")!;
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
    const row = (await screen.findByText("public.gone")).closest("tr")!;
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
    await screen.findByText("Ada Lovelace");
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
    const table = screen.getByLabelText("Table");
    expect(table).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Source"), SOURCE_ID);
    await waitFor(() =>
      expect(grantParams().some((p) => p.source_id === SOURCE_ID)).toBe(true)
    );
    await waitFor(() => expect(screen.getByLabelText("Table")).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("Table"), ORDERS_ID);
    await waitFor(() =>
      expect(grantParams().some((p) => p.table_id === ORDERS_ID)).toBe(true)
    );
  });

  it("clears the principal filter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<GrantsPage />, {
      route: `/grants?principal_type=user&principal_id=${USER_ID}`,
    });
    await screen.findByText("Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Clear principal" }));
    await waitFor(() =>
      expect(grantParams().at(-1)).not.toHaveProperty("principal_id")
    );
  });

  it("offers Edit and Delete rows with zeteo.grants.write, and deletes after confirming", async () => {
    const user = userEvent.setup();
    renderWithProviders(<GrantsPage />);
    const row = (await screen.findByText("Ada Lovelace")).closest("tr")!;
    expect(within(row).getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      `/grants/${GRANT_ID}/edit`
    );
    expect(
      screen.getByRole("button", { name: "New grant" })
    ).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete grant" }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/grants/${GRANT_ID}`)
    );
  });

  it("has no write control without zeteo.grants.write", async () => {
    held.permissions = ["zeteo.grants.read"];
    renderWithProviders(<GrantsPage />);
    await screen.findByText("Ada Lovelace");
    expect(
      screen.queryByRole("link", { name: "Edit" })
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
});
