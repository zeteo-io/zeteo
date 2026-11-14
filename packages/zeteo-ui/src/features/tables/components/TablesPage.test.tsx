import { CUSTOMERS_ID, GONE_ID, makeTable, ORDERS_ID } from "../testFixtures";
import { makeSource, SOURCE_ID } from "../../sources/testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { screen } from "@testing-library/react";
import { TablesPage } from "./TablesPage";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ api: { get } }));
vi.mock("@/lib/auth", async () => (await import("@/test/authMock")).mockAuth());

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

const renderPage = () =>
  renderWithProviders(
    <Routes>
      <Route path="/sources/:sourceId/tables" element={<TablesPage />} />
    </Routes>,
    { route: `/sources/${SOURCE_ID}/tables` }
  );

describe("TablesPage", () => {
  beforeEach(() => {
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
                ? [orders, customers, gone]
                : [orders, customers],
              next_cursor: null,
            },
          };
        }
      );
  });

  it("lists schema, name, kind and description, linking to the table", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: "orders" });
    expect(link).toHaveAttribute(
      "href",
      `/sources/${SOURCE_ID}/tables/${ORDERS_ID}`
    );
    const row = link.closest("tr")!;
    expect(row).toHaveTextContent("public");
    expect(row).toHaveTextContent("Table");
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
    expect(get.mock.calls[0][1].params.include_missing).toBeUndefined();

    await user.click(screen.getByLabelText("Show missing tables"));

    const row = (await screen.findByText("retired")).closest("tr")!;
    expect(row).toHaveTextContent("Missing");
    expect(
      get.mock.calls.some(([, cfg]) => cfg?.params?.include_missing === true)
    ).toBe(true);
  });
});
