import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { SOURCE_ID } from "../../sources/testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { makeRelation } from "../testFixtures";
import { RelationForm } from "./RelationForm";
import { AxiosError } from "axios";
import {
  CUSTOMERS_ID,
  makeColumn,
  makeTable,
  makeTableDetail,
  ORDERS_ID,
} from "@/features/tables/testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get, post } })
);

const ordersCols = ["id", "customer_id", "tenant_id"].map((name, i) =>
  makeColumn({
    id: `c1${i}00000-1c7a-4a53-9d0e-6a3b1f2c4d01`,
    name,
    position: i + 1,
  })
);
const customersCols = ["id", "tenant_id"].map((name, i) =>
  makeColumn({
    id: `c2${i}00000-1c7a-4a53-9d0e-6a3b1f2c4d01`,
    name,
    position: i + 1,
  })
);
const tables = [
  makeTable(),
  makeTable({ id: CUSTOMERS_ID, name: "customers" }),
];

const label = (text: string) => new RegExp(`^${text}( \\*)?$`);
const field = (text: string) => screen.getByLabelText(label(text));

const onDeclared = vi.fn();
const onClose = vi.fn();

const renderForm = () =>
  renderWithProviders(
    <RelationForm
      sourceId={SOURCE_ID}
      tables={tables}
      onDeclared={onDeclared}
      onClose={onClose}
    />
  );

type User = ReturnType<typeof userEvent.setup>;

const chooseTables = async (user: User) => {
  await user.selectOptions(field("From table"), ORDERS_ID);
  await user.selectOptions(field("To table"), CUSTOMERS_ID);
  await waitFor(() =>
    expect(
      screen.getByRole("option", { name: "customer_id" })
    ).toBeInTheDocument()
  );
};

describe("RelationForm", () => {
  beforeEach(() => {
    onDeclared.mockReset();
    onClose.mockReset();
    post.mockReset().mockResolvedValue({ data: makeRelation() });
    get.mockReset().mockImplementation(async (url: string) => ({
      data: url.endsWith(ORDERS_ID)
        ? makeTableDetail({ columns: ordersCols })
        : makeTableDetail({
            id: CUSTOMERS_ID,
            name: "customers",
            columns: customersCols,
          }),
    }));
  });

  it("loads a table's columns once it is chosen", async () => {
    renderForm();
    expect(get).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await chooseTables(user);
    expect(get).toHaveBeenCalledWith(
      `/v1/sources/${SOURCE_ID}/tables/${ORDERS_ID}`
    );
  });

  it("posts the pairs in the order they were entered", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(field("Name"), "customer");
    await chooseTables(user);
    await user.selectOptions(field("From column 1"), "tenant_id");
    await user.selectOptions(field("To column 1"), "tenant_id");
    await user.click(screen.getByRole("button", { name: "Add column pair" }));
    await user.selectOptions(field("From column 2"), "customer_id");
    await user.selectOptions(field("To column 2"), "id");
    await user.click(screen.getByLabelText("Each row has many matches"));
    await user.click(screen.getByRole("button", { name: "Declare relation" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(`/v1/sources/${SOURCE_ID}/relations`, {
      name: "customer",
      from_table_id: ORDERS_ID,
      from_columns: ["tenant_id", "customer_id"],
      to_table_id: CUSTOMERS_ID,
      to_columns: ["tenant_id", "id"],
      to_many: true,
    });
    await waitFor(() => expect(onDeclared).toHaveBeenCalled());
  });

  it("refuses a pair with only one side chosen", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(field("Name"), "customer");
    await chooseTables(user);
    await user.selectOptions(field("From column 1"), "customer_id");
    await user.selectOptions(field("To column 1"), "id");
    await user.click(screen.getByRole("button", { name: "Add column pair" }));
    await user.selectOptions(field("From column 2"), "tenant_id");
    await user.click(screen.getByRole("button", { name: "Declare relation" }));
    expect(
      await screen.findByText(/both sides of every column pair/i)
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a column chosen twice on the same side", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(field("Name"), "customer");
    await chooseTables(user);
    await user.selectOptions(field("From column 1"), "customer_id");
    await user.selectOptions(field("To column 1"), "id");
    await user.click(screen.getByRole("button", { name: "Add column pair" }));
    await user.selectOptions(field("From column 2"), "customer_id");
    await user.selectOptions(field("To column 2"), "tenant_id");
    await user.click(screen.getByRole("button", { name: "Declare relation" }));
    expect(await screen.findByText(/more than once/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses an invalid name", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(field("Name"), "Bad-Name");
    await chooseTables(user);
    await user.selectOptions(field("From column 1"), "customer_id");
    await user.selectOptions(field("To column 1"), "id");
    await user.click(screen.getByRole("button", { name: "Declare relation" }));
    expect(await screen.findByText(/lower case letters/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps between 1 and 32 pairs", async () => {
    const user = userEvent.setup();
    renderForm();
    await chooseTables(user);
    expect(
      screen.queryByRole("button", { name: "Remove column pair 1" })
    ).not.toBeInTheDocument();
    for (let i = 0; i < 31; i++) {
      await user.click(screen.getByRole("button", { name: "Add column pair" }));
    }
    expect(
      screen.queryByRole("button", { name: "Add column pair" })
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Remove column pair 32" })
    );
    expect(
      screen.getByRole("button", { name: "Add column pair" })
    ).toBeInTheDocument();
  }, 30000);

  it("shows the API's description of a refused relation", async () => {
    post.mockRejectedValue({
      status: 422,
      code: "invalid_relation",
      message: "customer_id and id differ in type",
    });
    const user = userEvent.setup();
    renderForm();
    await user.type(field("Name"), "customer");
    await chooseTables(user);
    await user.selectOptions(field("From column 1"), "customer_id");
    await user.selectOptions(field("To column 1"), "id");
    await user.click(screen.getByRole("button", { name: "Declare relation" }));
    expect(
      await screen.findByText("customer_id and id differ in type")
    ).toBeInTheDocument();
    expect(onDeclared).not.toHaveBeenCalled();
  });

  it.each([
    ["relation_name_taken", "A relation named customer already exists"],
    ["invalid_relation", "The column types differ"],
  ])("shows the API's description for %s", async (code, description) => {
    post.mockRejectedValue(
      new AxiosError("Conflict", "ERR_BAD_REQUEST", undefined, undefined, {
        status: code === "invalid_relation" ? 422 : 409,
        statusText: "x",
        headers: {},
        config: {} as never,
        data: { error: code, error_description: description },
      })
    );
    const user = userEvent.setup();
    renderForm();
    await user.type(field("Name"), "customer");
    await chooseTables(user);
    await user.selectOptions(field("From column 1"), "customer_id");
    await user.selectOptions(field("To column 1"), "id");
    await user.click(screen.getByRole("button", { name: "Declare relation" }));
    expect(await screen.findByText(description)).toBeInTheDocument();
  });

  it("says so when a table's columns cannot be loaded", async () => {
    get.mockRejectedValue({
      status: 404,
      code: "not_found",
      message: "No such table",
    });
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(field("From table"), ORDERS_ID);
    expect(await screen.findByText("No such table")).toBeInTheDocument();
  });
});
