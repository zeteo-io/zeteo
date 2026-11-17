import { makeSource, SOURCE_ID } from "@/features/sources/testFixtures";
import { GRANT_ID, USER_ID, makeGrant } from "../testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { optionTexts, pickOption } from "@/test/searchSelect";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { GrantForm } from "./GrantForm";
import {
  CUSTOMERS_ID,
  ORDERS_ID,
  makeColumn,
  makeTable,
  makeTableDetail,
} from "@/features/tables/testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({
  permissions: ["zeteo.grants.write", "zeteo.sources.read"],
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, post, put },
  })
);
// Searching is not under test: a picker that chooses the user on one click.
vi.mock("@/features/principals", async () => {
  const actual = await vi.importActual<object>("@/features/principals");
  return {
    ...actual,
    PrincipalPicker: ({
      value,
      onChange,
    }: {
      value: unknown;
      onChange: (v: { type: "user"; id: string }) => void;
    }) => (
      <button
        type="button"
        onClick={() => onChange({ type: "user", id: USER_ID })}
      >
        {value ? "principal chosen" : "Choose principal"}
      </button>
    ),
    usePrincipalNames: () => ({
      get: () => undefined,
      unavailable: false,
      error: null,
    }),
  };
});

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;

const billing = makeSource({
  id: "8b2e1c1f-2d8b-4b64-8e1f-7b4c2d3e5f77",
  slug: "billing",
  name: "Billing",
});
const archived = makeSource({
  id: "7a1d0b0e-1c7a-4a53-9d0e-6a3b1f2c4d66",
  slug: "legacy",
  name: "Legacy DB",
  archived_at: "2026-11-02T10:00:00.000Z",
});
const detail = makeTableDetail({
  columns: [
    ...makeTableDetail().columns,
    {
      ...makeTableDetail().columns[0],
      id: "c0000000-1c7a-4a53-9d0e-6a3b1f2c4d09",
      name: "dropped",
      missing_since: "2026-11-05T10:00:00.000Z",
    },
  ],
});
const COL = (n: number) => `c0000000-1c7a-4a53-9d0e-6a3b1f2c4d0${n}`;

const renderForm = (grant?: ReturnType<typeof makeGrant>) =>
  renderWithProviders(
    <>
      <Where />
      <Routes>
        <Route path="/grants" element={<p>list</p>} />
        <Route path="*" element={<GrantForm grant={grant} title="Grant" />} />
      </Routes>
    </>,
    { route: "/grants/new" }
  );

type User = ReturnType<typeof userEvent.setup>;

const options = optionTexts;
const pick = (user: User, label: string, option: string) =>
  pickOption(user, screen.getByLabelText(label), option);
const allColumns = () => screen.getByLabelText("All columns");

const chooseTable = async (user: User) => {
  await user.click(screen.getByRole("button", { name: "Choose principal" }));
  await waitFor(() => expect(screen.getByLabelText("Source")).toBeEnabled());
  await pick(user, "Source", "Orders DB");
  await waitFor(() => expect(screen.getByLabelText("Table")).toBeEnabled());
  await pick(user, "Table", "public.orders");
};

describe("GrantForm", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.grants.write", "zeteo.sources.read"];
    post
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === "/v1/grants" ? { data: makeGrant() } : { data: { data: [] } }
      );
    put.mockReset().mockResolvedValue({ data: makeGrant() });
    get
      .mockReset()
      .mockImplementation(
        async (url: string, cfg?: { params?: Record<string, unknown> }) => {
          if (url === "/v1/sources") {
            return {
              data: {
                data: [makeSource(), billing, archived],
                next_cursor: null,
              },
            };
          }
          if (url === `/v1/sources/${billing.id}/tables`) {
            return { data: { data: [], next_cursor: null } };
          }
          if (url === `/v1/sources/${SOURCE_ID}/tables`) {
            return {
              data: {
                data: [
                  makeTable(),
                  makeTable({ id: CUSTOMERS_ID, name: "customers" }),
                  makeTable({
                    id: "a3333333-1c7a-4a53-9d0e-6a3b1f2c4d03",
                    name: "gone",
                    missing_since: "2026-11-05T10:00:00.000Z",
                  }),
                ],
                next_cursor: null,
              },
            };
          }
          if (url === `/v1/sources/${SOURCE_ID}/tables/${CUSTOMERS_ID}`) {
            return {
              data: makeTableDetail({
                id: CUSTOMERS_ID,
                name: "customers",
                columns: [
                  makeColumn({ id: COL(7), name: "email", position: 1 }),
                ],
              }),
            };
          }
          if (url === `/v1/sources/${SOURCE_ID}/tables/${ORDERS_ID}`) {
            return { data: detail };
          }
          if (url === "/v1/grants")
            return { data: { data: [], next_cursor: null, ...cfg } };
          throw new Error(`unexpected ${url}`);
        }
      );
  });

  it("offers non-archived sources by name and non-missing tables", async () => {
    const user = userEvent.setup();
    renderForm();
    const source = await screen.findByLabelText("Source");
    await waitFor(() => expect(source).toBeEnabled());
    expect(screen.getByLabelText("Table")).toBeDisabled();
    await user.click(source);
    await waitFor(() => expect(options()).toEqual(["Orders DB", "Billing"]));
    await pick(user, "Source", "Orders DB");
    await waitFor(() => expect(screen.getByLabelText("Table")).toBeEnabled());
    await user.click(screen.getByLabelText("Table"));
    await waitFor(() =>
      expect(options()).toEqual(["public.orders", "public.customers"])
    );
  });

  it("narrows the tables as you type", async () => {
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => expect(screen.getByLabelText("Source")).toBeEnabled());
    await pick(user, "Source", "Orders DB");
    await waitFor(() => expect(screen.getByLabelText("Table")).toBeEnabled());
    await user.type(screen.getByLabelText("Table"), "cust");
    await waitFor(() => expect(options()).toEqual(["public.customers"]));
  });

  it("sends all_columns true and no column_ids for All columns", async () => {
    const user = userEvent.setup();
    renderForm();
    await chooseTable(user);
    await user.click(screen.getByRole("button", { name: "Create grant" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/v1/grants", {
      principal_type: "user",
      principal_id: USER_ID,
      table_id: ORDERS_ID,
      all_columns: true,
    });
    expect(await screen.findByText("list")).toBeInTheDocument();
  });

  it("still returns to the list when a choice is made again mid-save", async () => {
    const user = userEvent.setup();
    let finish: (value: unknown) => void = () => undefined;
    post.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    renderForm();
    await chooseTable(user);
    await user.click(screen.getByRole("button", { name: "Create grant" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    // Picking again resets the mutation while the request is in flight.
    await user.click(screen.getByRole("button", { name: "principal chosen" }));
    finish({ data: makeGrant() });
    expect(await screen.findByText("list")).toBeInTheDocument();
  });

  it("sends the chosen columns, not the missing ones", async () => {
    const user = userEvent.setup();
    renderForm();
    await chooseTable(user);
    await user.click(allColumns());
    await user.click(await screen.findByLabelText("id"));
    expect(screen.queryByLabelText(/dropped/)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("note"));
    await user.click(screen.getByRole("button", { name: "Create grant" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual({
      principal_type: "user",
      principal_id: USER_ID,
      table_id: ORDERS_ID,
      all_columns: false,
      column_ids: [COL(1), COL(3)],
    });
  });

  it("cannot submit with no column chosen, and select all / none helps", async () => {
    const user = userEvent.setup();
    renderForm();
    await chooseTable(user);
    await user.click(allColumns());
    const submit = screen.getByRole("button", { name: "Create grant" });
    expect(submit).toBeDisabled();
    expect(
      await screen.findByText(
        "Choose at least one column, or grant all columns."
      )
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select all" }));
    for (const name of ["id", "customer_id", "note"]) {
      expect(screen.getByLabelText(name)).toBeChecked();
    }
    expect(submit).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Select none" }));
    expect(submit).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("clears the table and columns when the source changes", async () => {
    const user = userEvent.setup();
    renderForm();
    await chooseTable(user);
    await pick(user, "Source", "Billing");
    expect(screen.getByLabelText("Table")).toHaveValue("");
    expect(
      screen.queryByRole("heading", { name: "Columns" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create grant" })).toBeDisabled();
  });

  it("links to the existing grant on 409 grant_exists", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      status: 409,
      code: "grant_exists",
      message: "The principal already has a grant on this table",
    });
    const base = get.getMockImplementation()!;
    get.mockImplementation(
      async (url: string, cfg?: { params?: Record<string, unknown> }) =>
        url === "/v1/grants"
          ? { data: { data: [makeGrant()], next_cursor: null } }
          : base(url, cfg)
    );
    renderForm();
    await chooseTable(user);
    await user.click(screen.getByRole("button", { name: "Create grant" }));
    expect(
      await screen.findByText(
        "This principal already has a grant on this table"
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Edit that grant" })
    ).toHaveAttribute("href", `/grants/${GRANT_ID}/edit`);
  });

  it("shows the description of other refusals", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      status: 409,
      code: "source_archived",
      message: "The source is archived",
    });
    renderForm();
    await chooseTable(user);
    await user.click(screen.getByRole("button", { name: "Create grant" }));
    expect(
      await screen.findByText("The source is archived")
    ).toBeInTheDocument();
  });

  it("says what is missing instead of loading forever without zeteo.sources.read", async () => {
    held.permissions = ["zeteo.grants.write"];
    renderForm();
    expect(
      await screen.findByText(
        /Choosing a table needs the Read sources permission/
      )
    ).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("sends explicit ids, not all_columns, when every box is ticked", async () => {
    const user = userEvent.setup();
    renderForm();
    await chooseTable(user);
    await user.click(allColumns());
    for (const name of ["id", "customer_id", "note"]) {
      await user.click(await screen.findByLabelText(name));
    }
    await user.click(screen.getByRole("button", { name: "Create grant" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({
      all_columns: false,
      column_ids: [COL(1), COL(2), COL(3)],
    });
  });

  it("submits only the new table's columns after the table changes", async () => {
    const user = userEvent.setup();
    renderForm();
    await chooseTable(user);
    await user.click(allColumns());
    await user.click(await screen.findByLabelText("id"));
    await pick(user, "Table", "public.customers");
    expect(screen.getByRole("button", { name: "Create grant" })).toBeDisabled();
    await user.click(await screen.findByLabelText("email"));
    await user.click(screen.getByRole("button", { name: "Create grant" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({
      table_id: CUSTOMERS_ID,
      column_ids: [COL(7)],
    });
  });

  it("does not say the new table already has a grant after changing it", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      status: 409,
      code: "grant_exists",
      message: "exists",
    });
    renderForm();
    await chooseTable(user);
    await user.click(screen.getByRole("button", { name: "Create grant" }));
    await screen.findByText("exists");
    await pick(user, "Table", "public.customers");
    expect(screen.queryByText("exists")).not.toBeInTheDocument();
    expect(screen.queryByText(/already has a grant/)).not.toBeInTheDocument();
  });

  describe("after a 409 grant_exists", () => {
    const conflict = async (user: ReturnType<typeof userEvent.setup>) => {
      post.mockImplementation(async (url: string) => {
        if (url !== "/v1/grants") return { data: { data: [] } };
        throw { status: 409, code: "grant_exists", message: "exists" };
      });
      renderForm();
      await chooseTable(user);
      await user.click(screen.getByRole("button", { name: "Create grant" }));
      await screen.findByText("exists");
    };

    it("drops the notice when the principal changes", async () => {
      const user = userEvent.setup();
      await conflict(user);
      await user.click(
        screen.getByRole("button", { name: "principal chosen" })
      );
      expect(screen.queryByText("exists")).not.toBeInTheDocument();
      expect(screen.queryByText(/already has a grant/)).not.toBeInTheDocument();
    });

    it("drops the notice when the source changes", async () => {
      const user = userEvent.setup();
      await conflict(user);
      await pick(user, "Source", "Billing");
      expect(screen.queryByText("exists")).not.toBeInTheDocument();
      expect(screen.queryByText(/already has a grant/)).not.toBeInTheDocument();
    });
  });

  describe("a held but missing column", () => {
    const partial = () =>
      makeGrant({
        all_columns: false,
        columns: [
          { id: COL(1), name: "id", missing: false },
          { id: COL(9), name: "dropped", missing: true },
        ],
      });

    it("is kept through Select all and a plain Save", async () => {
      const user = userEvent.setup();
      renderForm(partial());
      await user.click(
        await screen.findByRole("button", { name: "Select all" })
      );
      expect(screen.getByLabelText(/dropped/)).toBeChecked();
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      await waitFor(() => expect(put).toHaveBeenCalled());
      expect(put.mock.calls[0][1].column_ids).toContain(COL(9));
    });

    it("is released by Select none", async () => {
      const user = userEvent.setup();
      renderForm(partial());
      await user.click(
        await screen.findByRole("button", { name: "Select none" })
      );
      expect(screen.getByLabelText(/dropped/)).not.toBeChecked();
    });
  });

  it("keeps a missing column in column_ids when saved unchanged", async () => {
    const user = userEvent.setup();
    renderForm(
      makeGrant({
        all_columns: false,
        columns: [
          { id: COL(1), name: "id", missing: false },
          { id: COL(9), name: "dropped", missing: true },
        ],
      })
    );
    await screen.findByLabelText("note");
    await user.click(screen.getByRole("button", { name: "Save grant" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1]).toEqual({
      all_columns: false,
      column_ids: [COL(1), COL(9)],
    });
  });

  describe("editing", () => {
    const partial = makeGrant({
      all_columns: false,
      columns: [
        { id: COL(1), name: "id", missing: false },
        { id: COL(9), name: "dropped", missing: true },
      ],
    });

    it("shows the table read-only and sends columns only in a PUT", async () => {
      const user = userEvent.setup();
      renderForm(partial);
      expect(screen.getByText(/public\./).closest("p")).toHaveTextContent(
        "orders · public.orders"
      );
      expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
      expect(await screen.findByLabelText("note")).toBeInTheDocument();
      expect(screen.getByLabelText("id")).toBeChecked();
      expect(screen.getByLabelText(/dropped/)).toBeChecked();
      await user.click(screen.getByLabelText("note"));
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      await waitFor(() => expect(put).toHaveBeenCalled());
      expect(put).toHaveBeenCalledWith(`/v1/grants/${GRANT_ID}`, {
        all_columns: false,
        column_ids: [COL(1), COL(3), COL(9)],
      });
    });

    it("drops a missing column that is unticked", async () => {
      const user = userEvent.setup();
      renderForm(partial);
      await user.click(await screen.findByLabelText(/dropped/));
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      await waitFor(() => expect(put).toHaveBeenCalled());
      expect(put.mock.calls[0][1]).toEqual({
        all_columns: false,
        column_ids: [COL(1)],
      });
    });

    it("sends only all_columns true for a grant of every column", async () => {
      const user = userEvent.setup();
      renderForm(makeGrant());
      expect(screen.getByLabelText("All columns")).toBeChecked();
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      await waitFor(() => expect(put).toHaveBeenCalled());
      expect(put.mock.calls[0][1]).toEqual({ all_columns: true });
    });
  });
});
