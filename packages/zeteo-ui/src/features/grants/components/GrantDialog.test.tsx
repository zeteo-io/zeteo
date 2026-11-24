import { makeSource, SOURCE_ID } from "@/features/sources/testFixtures";
import { GRANT_ID, USER_ID, makeGrant } from "../testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { optionTexts, pickOption } from "@/test/searchSelect";
import { GrantDialog, type FixedSource } from "./GrantDialog";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
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

const onClose = vi.hoisted(() => vi.fn());

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

const renderForm = (
  grant?: ReturnType<typeof makeGrant>,
  source?: FixedSource
) =>
  renderWithProviders(
    <GrantDialog grant={grant} source={source} onClose={onClose} />,
    { route: "/grants" }
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

describe("GrantDialog", () => {
  beforeEach(() => {
    onClose.mockReset();
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
          if (url === "/v1/identity-keys") {
            return {
              data: {
                data: [
                  {
                    id: "f1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
                    name: "netsuite_employee_id",
                    label: "NetSuite employees",
                    description: null,
                    value_count: 3,
                  },
                ],
              },
            };
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
      row_access: "unlimited_default",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("still closes when a choice is made again mid-save", async () => {
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
    await waitFor(() => expect(onClose).toHaveBeenCalled());
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
      row_access: "unlimited_default",
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

  it("opens the existing grant in its place on 409 grant_exists", async () => {
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
      await screen.findByText("They already have access to this table.")
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/v1/grants", {
      params: expect.objectContaining({
        source_id: SOURCE_ID,
        principal_id: USER_ID,
        table_id: ORDERS_ID,
      }),
    });
    await user.click(screen.getByRole("button", { name: "Edit that grant" }));
    expect(
      await screen.findByRole("button", { name: "Save grant" })
    ).toBeInTheDocument();
    expect(screen.getByText("Edit grant")).toBeInTheDocument();
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
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
    expect(screen.queryByText(/already have access/)).not.toBeInTheDocument();
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
      expect(screen.queryByText(/already have access/)).not.toBeInTheDocument();
    });

    it("drops the notice when the source changes", async () => {
      const user = userEvent.setup();
      await conflict(user);
      await pick(user, "Source", "Billing");
      expect(screen.queryByText("exists")).not.toBeInTheDocument();
      expect(screen.queryByText(/already have access/)).not.toBeInTheDocument();
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
      row_access: "unlimited_default",
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
        row_access: "unlimited_default",
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
        row_access: "unlimited_default",
        column_ids: [COL(1)],
      });
    });

    it("sends all_columns true for a grant of every column", async () => {
      const user = userEvent.setup();
      renderForm(makeGrant());
      expect(screen.getByLabelText("All columns")).toBeChecked();
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      await waitFor(() => expect(put).toHaveBeenCalled());
      expect(put.mock.calls[0][1]).toEqual({
        all_columns: true,
        row_access: "unlimited_default",
      });
    });
  });

  describe("from a source's page", () => {
    const fixed: FixedSource = {
      id: SOURCE_ID,
      tables: [
        { id: ORDERS_ID, name: "orders", missing: false },
        { id: CUSTOMERS_ID, name: "customers", missing: false },
        {
          id: "a3333333-1c7a-4a53-9d0e-6a3b1f2c4d03",
          name: "gone",
          missing: true,
        },
      ],
    };

    it("fixes the source and offers its tables that are still there", async () => {
      const user = userEvent.setup();
      renderForm(undefined, fixed);
      expect(screen.getByText("Share a table")).toBeInTheDocument();
      expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
      await user.click(screen.getByLabelText("Table"));
      expect(options()).toEqual(["orders", "customers"]);
      expect(get).not.toHaveBeenCalledWith("/v1/sources", expect.anything());
    });

    it("shares through the admin picker with zeteo.grants.write", async () => {
      const user = userEvent.setup();
      renderForm(undefined, fixed);
      await user.click(
        screen.getByRole("button", { name: "Choose principal" })
      );
      await pick(user, "Table", "orders");
      await user.click(screen.getByRole("button", { name: "Share" }));
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith("/v1/grants", {
          principal_type: "user",
          principal_id: USER_ID,
          table_id: ORDERS_ID,
          all_columns: true,
          row_access: "unlimited_default",
        })
      );
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("searches the people an owner may share with, without zeteo.grants.write", () => {
      held.permissions = ["zeteo.data.read"];
      renderForm(undefined, fixed);
      expect(
        screen.queryByRole("button", { name: "Choose principal" })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Search by name or email" })
      ).toBeInTheDocument();
    });

    it("names the table as the page does when changing a grant", async () => {
      renderForm(makeGrant(), {
        ...fixed,
        tables: [{ id: ORDERS_ID, name: "Orders table", missing: false }],
      });
      expect(screen.getByText("Change what is shared")).toBeInTheDocument();
      expect(screen.getByText("Orders table")).toBeInTheDocument();
      expect(screen.queryByText(/public\./)).not.toBeInTheDocument();
      expect(
        await screen.findByRole("button", { name: "Save" })
      ).toBeInTheDocument();
    });
  });

  describe("rows", () => {
    const chooseRule = async (user: User) => {
      await chooseTable(user);
      await user.click(screen.getByLabelText("Only rows where…"));
    };
    const setCondition = async (user: User, column: string, op: string) => {
      await pick(user, "Column", column);
      await pick(user, "Operator", op);
    };

    it("defaults to not limiting rows", async () => {
      const user = userEvent.setup();
      renderForm();
      await chooseTable(user);
      expect(screen.getByLabelText("Doesn't limit rows")).toBeChecked();
      expect(screen.queryByLabelText("Column")).not.toBeInTheDocument();
    });

    it("sends all rows without a rule", async () => {
      const user = userEvent.setup();
      renderForm();
      await chooseTable(user);
      await user.click(
        screen.getByLabelText("All rows (overrides other limits)")
      );
      await user.click(screen.getByRole("button", { name: "Create grant" }));
      await waitFor(() => expect(post).toHaveBeenCalled());
      expect(post.mock.calls[0][1]).toEqual({
        principal_type: "user",
        principal_id: USER_ID,
        table_id: ORDERS_ID,
        all_columns: true,
        row_access: "all",
      });
    });

    it("sends a rule of status is one of paid", async () => {
      const user = userEvent.setup();
      renderForm();
      await chooseRule(user);
      await setCondition(user, "note", "is one of");
      expect(
        screen.getByRole("button", { name: "Create grant" })
      ).toBeDisabled();
      await user.type(screen.getByLabelText("Values"), "paid{Enter}");
      await user.type(
        screen.getByLabelText("Describe this limit for people who have it"),
        "Paid orders"
      );
      await user.click(screen.getByRole("button", { name: "Create grant" }));
      await waitFor(() => expect(post).toHaveBeenCalled());
      expect(post.mock.calls[0][1]).toEqual({
        principal_type: "user",
        principal_id: USER_ID,
        table_id: ORDERS_ID,
        all_columns: true,
        row_access: "rule",
        row_rule: { note: { in: ["paid"] } },
        row_rule_description: "Paid orders",
      });
    });

    it("sends an identity condition", async () => {
      const user = userEvent.setup();
      renderForm();
      await chooseRule(user);
      await setCondition(
        user,
        "customer_id",
        "is one of my NetSuite employees"
      );
      await user.click(screen.getByRole("button", { name: "Create grant" }));
      await waitFor(() => expect(post).toHaveBeenCalled());
      expect(post.mock.calls[0][1].row_rule).toEqual({
        customer_id: { in: { identity: "netsuite_employee_id" } },
      });
    });

    it("sends below when people who report to me are included", async () => {
      const user = userEvent.setup();
      renderForm();
      await chooseRule(user);
      await setCondition(
        user,
        "customer_id",
        "is one of my NetSuite employees"
      );
      const below = screen.getByLabelText("Include people who report to me");
      expect(below).toBeEnabled();
      expect(below).not.toBeChecked();
      await user.click(below);
      await user.click(screen.getByRole("button", { name: "Create grant" }));
      await waitFor(() => expect(post).toHaveBeenCalled());
      expect(post.mock.calls[0][1].row_rule).toEqual({
        customer_id: {
          in: { identity: "netsuite_employee_id", below: true },
        },
      });
    });

    it("resets the rule draft when the table changes in create mode", async () => {
      const user = userEvent.setup();
      renderForm();
      await chooseRule(user);
      await setCondition(user, "note", "is one of");
      await user.type(screen.getByLabelText("Values"), "paid{Enter}");
      expect(screen.getByLabelText("Remove paid")).toBeInTheDocument();
      await pick(user, "Table", "public.customers");
      await waitFor(() =>
        expect(screen.queryByLabelText("Remove paid")).not.toBeInTheDocument()
      );
      expect(screen.getByLabelText("Column")).toHaveValue("");
      expect(screen.queryByLabelText("Values")).not.toBeInTheDocument();
    });

    it("saves a rule the builder can show back unchanged", async () => {
      const user = userEvent.setup();
      const rule = {
        or: [
          { note: { in: ["paid", "open"] } },
          { and: [{ id: { gte: 5 } }, { note: { isNull: false } }] },
        ],
      };
      renderForm(
        makeGrant({
          row_access: "rule",
          row_rule: rule,
          row_rule_description: "Paid or open",
        })
      );
      await screen.findAllByLabelText("Column");
      expect(screen.queryByLabelText("Row rule")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      await waitFor(() => expect(put).toHaveBeenCalled());
      expect(put.mock.calls[0][1]).toMatchObject({
        row_access: "rule",
        row_rule: rule,
        row_rule_description: "Paid or open",
      });
    });

    it("marks columns that are not in the grant", async () => {
      const user = userEvent.setup();
      renderForm();
      await chooseRule(user);
      await user.click(allColumns());
      await user.click(await screen.findByLabelText("id"));
      await user.click(screen.getByLabelText("Column"));
      await waitFor(() =>
        expect(options()).toEqual([
          "id",
          "customer_id (not in this grant)",
          "note (not in this grant)",
        ])
      );
    });

    it("highlights the condition an invalid_row_rule points at", async () => {
      const user = userEvent.setup();
      put.mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            error: "invalid_row_rule",
            error_description: "note takes text values",
            path: ["row_rule", "and", 1, "note"],
          },
        },
      });
      renderForm(
        makeGrant({
          row_access: "rule",
          row_rule: {
            and: [{ id: { eq: 1 } }, { note: { eq: 2 } }],
          },
        })
      );
      await screen.findAllByLabelText("Column");
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      const alert = await screen.findByText("note takes text values");
      const rows = document.querySelectorAll(".z-rule-condition");
      expect(rows[0]).not.toHaveAttribute("data-invalid");
      expect(rows[1]).toHaveAttribute("data-invalid", "true");
      expect(rows[1]).toContainElement(alert);
    });

    it("shows an invalid_row_rule that points at a group", async () => {
      const user = userEvent.setup();
      put.mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            error: "invalid_row_rule",
            error_description: "the rule is too broad",
            path: ["row_rule"],
          },
        },
      });
      renderForm(
        makeGrant({
          row_access: "rule",
          row_rule: { and: [{ id: { eq: 1 } }, { note: { eq: "a" } }] },
        })
      );
      await screen.findAllByLabelText("Column");
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      const alert = await screen.findByText("the rule is too broad");
      expect(alert.closest(".z-rule-group")).toHaveAttribute(
        "data-invalid",
        "true"
      );
    });

    it("keeps a boolean as a boolean when saved untouched", async () => {
      const user = userEvent.setup();
      renderForm(
        makeGrant({ row_access: "rule", row_rule: { flag: { eq: true } } })
      );
      await screen.findAllByLabelText("Column");
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      await waitFor(() => expect(put).toHaveBeenCalled());
      expect(put.mock.calls[0][1].row_rule).toEqual({ flag: { eq: true } });
    });

    it("labels an operator the column type does not offer", async () => {
      renderForm(
        makeGrant({ row_access: "rule", row_rule: { id: { contains: "x" } } })
      );
      expect(await screen.findByLabelText("Operator")).toHaveValue("contains");
    });

    it("shows a rule it cannot build as read-only JSON and keeps it", async () => {
      const user = userEvent.setup();
      const rule = { not: { id: { eq: 1 } } };
      renderForm(makeGrant({ row_access: "rule", row_rule: rule }));
      expect(screen.getByLabelText("Row rule")).toHaveTextContent('"not"');
      expect(screen.queryByLabelText("Column")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save grant" }));
      await waitFor(() => expect(put).toHaveBeenCalled());
      expect(put.mock.calls[0][1]).toMatchObject({
        row_access: "rule",
        row_rule: rule,
      });
    });

    it("offers an upload source's owner no identity values, which only an admin may use", async () => {
      held.permissions = ["zeteo.data.read", "zeteo.uploads.write"];
      const user = userEvent.setup();
      renderForm(undefined, {
        id: SOURCE_ID,
        tables: [{ id: ORDERS_ID, name: "orders", missing: false }],
      });
      await pick(user, "Table", "orders");
      await user.click(screen.getByLabelText("Only rows where…"));
      expect(
        screen.getByText(/Only an admin can limit rows by people's identity/)
      ).toBeInTheDocument();
      await pick(user, "Column", "customer_id");
      await user.click(screen.getByLabelText("Operator"));
      expect(options()).toContain("is one of");
      expect(options().some((o) => o.includes("my "))).toBe(false);
      expect(get).not.toHaveBeenCalledWith(
        "/v1/identity-keys",
        expect.anything()
      );
    });

    it("shows an owner grant's rows read-only", async () => {
      renderForm(makeGrant({ owner_grant: true }));
      expect(screen.getByLabelText("Doesn't limit rows")).toBeDisabled();
      expect(screen.getByLabelText("Only rows where…")).toBeDisabled();
    });
  });
});
