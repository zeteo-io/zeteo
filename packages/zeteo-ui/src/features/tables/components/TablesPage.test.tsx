import { CUSTOMERS_ID, GONE_ID, makeTable, ORDERS_ID } from "../testFixtures";
import { makeSource, SOURCE_ID } from "../../sources/testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { TablesPage } from "./TablesPage";

const get = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.sources.write"] }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get },
  })
);

const TABLES_URL = `/v1/sources/${SOURCE_ID}/tables`;
const tableCalls = () => get.mock.calls.filter(([url]) => url === TABLES_URL);

const orders = makeTable();
const customers = makeTable({
  id: CUSTOMERS_ID,
  name: "customers_view",
  kind: "view",
  description: null,
});
const gone = makeTable({
  id: GONE_ID,
  name: "retired",
  missing_since: "2026-11-05T10:00:00.000Z",
});
const sales = makeTable({
  id: "a4444444-1c7a-4a53-9d0e-6a3b1f2c4d04",
  schema_name: "sales",
  name: "invoices",
  description: null,
});

const renderPage = () =>
  renderWithProviders(
    <Routes>
      <Route path="/sources/:sourceId/tables" element={<TablesPage />} />
    </Routes>,
    { route: `/sources/${SOURCE_ID}/tables` }
  );

describe("TablesPage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.sources.write"];
    get
      .mockReset()
      .mockImplementation(
        async (url: string, cfg?: { params: Record<string, unknown> }) => {
          if (url === `/v1/sources/${SOURCE_ID}`) {
            return { data: makeSource() };
          }
          return {
            data: {
              data: cfg?.params.include_missing
                ? [orders, customers, sales, gone]
                : [orders, customers, sales],
              next_cursor: null,
            },
          };
        }
      );
  });

  it("lists name, schema and description, with a View pill, linking to the table", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: "orders" });
    expect(link).toHaveAttribute(
      "href",
      `/sources/${SOURCE_ID}/tables/${ORDERS_ID}`
    );
    const row = link.closest("tr")!;
    expect(row).toHaveTextContent("public");
    expect(row).not.toHaveTextContent("View");
    expect(row).toHaveTextContent("Customer orders");
    expect(
      screen.getByRole("link", { name: "customers_view" }).closest("tr")
    ).toHaveTextContent("View");
  });

  it("hides missing tables until the toggle asks for them, then flags them", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("orders");
    expect(screen.queryByText("retired")).not.toBeInTheDocument();
    expect(tableCalls()[0][1].params.include_missing).toBeUndefined();

    await user.click(screen.getByLabelText("Show missing"));

    const row = (await screen.findByText("retired")).closest("tr")!;
    expect(row).toHaveTextContent("Missing");
    expect(
      tableCalls().some(([, cfg]) => cfg?.params?.include_missing === true)
    ).toBe(true);
  });

  it("offers editors a link to add a missing description", async () => {
    renderPage();
    const row = (await screen.findByRole("link", { name: "invoices" })).closest(
      "tr"
    )!;
    const add = await screen.findAllByRole("link", { name: "Add description" });
    expect(add.some((a) => row.contains(a))).toBe(true);
  });

  it("shows a dash, not a link, for a missing description without zeteo.sources.write", async () => {
    held.permissions = ["zeteo.sources.read"];
    renderPage();
    const row = (await screen.findByRole("link", { name: "invoices" })).closest(
      "tr"
    )!;
    expect(row).toHaveTextContent("—");
    expect(
      screen.queryByRole("link", { name: "Add description" })
    ).not.toBeInTheDocument();
  });

  it("filters by name as you type", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("orders");
    await user.type(screen.getByLabelText("Name"), "INVO");
    await waitFor(() =>
      expect(screen.queryByText("orders")).not.toBeInTheDocument()
    );
    expect(screen.getByText("invoices")).toBeInTheDocument();
  });

  it("filters by schema and by kind, and says when nothing matches", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("orders");
    await user.click(screen.getByRole("button", { name: /Schema/ }));
    await user.click(screen.getByRole("checkbox", { name: "sales" }));
    await waitFor(() =>
      expect(screen.queryByText("orders")).not.toBeInTheDocument()
    );
    expect(screen.getByText("invoices")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Kind/ }));
    await user.click(screen.getByRole("checkbox", { name: "Views" }));
    expect(
      await screen.findByText("No tables match these filters.")
    ).toBeInTheDocument();
  });

  it("says to refresh the catalogue when there are no tables", async () => {
    get.mockImplementation(async (url: string) =>
      url === `/v1/sources/${SOURCE_ID}`
        ? { data: makeSource() }
        : { data: { data: [], next_cursor: null } }
    );
    renderPage();
    expect(await screen.findByText(/No tables yet/)).toBeInTheDocument();
  });
});
