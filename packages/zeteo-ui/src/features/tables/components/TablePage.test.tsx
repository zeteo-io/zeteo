import { fireEvent, screen, waitFor } from "@testing-library/react";
import { makeSource, SOURCE_ID } from "../../sources/testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRelation } from "../../relations/testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { TablePage } from "./TablePage";
import {
  makeTableDetail,
  makeTable,
  ORDERS_ID,
  CUSTOMERS_ID,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.sources.write"] }));
const sourceOver = vi.hoisted(() => ({ archived_at: null as string | null }));
vi.mock("@/lib/api/client", () => ({ api: { get, patch } }));
vi.mock("@/lib/auth", async () => {
  const { mockAuth } = await import("@/test/authMock");
  return {
    ...mockAuth(),
    useAuth: () => mockAuth({ permissions: held.permissions }).useAuth(),
  };
});

const TABLE_URL = `/v1/sources/${SOURCE_ID}/tables/${ORDERS_ID}`;

const renderPage = () =>
  renderWithProviders(
    <Routes>
      <Route
        path="/sources/:sourceId/tables/:tableId"
        element={<TablePage />}
      />
    </Routes>,
    { route: `/sources/${SOURCE_ID}/tables/${ORDERS_ID}` }
  );

const openEditor = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    await screen.findByRole("button", { name: "Edit descriptions" })
  );
};

describe("TablePage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.sources.write"];
    sourceOver.archived_at = null;
    patch.mockReset().mockResolvedValue({ data: makeTableDetail() });
    get.mockReset().mockImplementation(async (url: string) => {
      if (url === `/v1/sources/${SOURCE_ID}`) {
        return { data: makeSource({ archived_at: sourceOver.archived_at }) };
      }
      if (url === TABLE_URL) return { data: makeTableDetail() };
      return {
        data: {
          data: [
            makeTable(),
            makeTable({ id: CUSTOMERS_ID, name: "customers" }),
          ],
          next_cursor: null,
        },
      };
    });
  });

  it("shows the table, its columns and its relations", async () => {
    get.mockImplementation(async (url: string) => {
      if (url === `/v1/sources/${SOURCE_ID}`) return { data: makeSource() };
      if (url === TABLE_URL) {
        return {
          data: makeTableDetail({
            columns: [
              ...makeTableDetail().columns,
              {
                ...makeTableDetail().columns[2],
                id: "c0000000-1c7a-4a53-9d0e-6a3b1f2c4d09",
                name: "legacy",
                missing_since: "2026-11-05T10:00:00.000Z",
              },
            ],
            relations: [makeRelation()],
          }),
        };
      }
      return {
        data: {
          data: [
            makeTable(),
            makeTable({ id: CUSTOMERS_ID, name: "customers" }),
          ],
          next_cursor: null,
        },
      };
    });
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "public.orders" })
    ).toBeInTheDocument();
    const pk = screen.getByText("id").closest("tr")!;
    expect(pk).toHaveTextContent("integer");
    expect(pk).toHaveTextContent("Primary key");
    expect(screen.getByText("note").closest("tr")).toHaveTextContent("Yes");
    expect(screen.getByText("legacy").closest("tr")).toHaveTextContent(
      "Missing"
    );
    const relation = (await screen.findByText("customer")).closest("tr")!;
    expect(relation).toHaveTextContent("public.customers");
    expect(relation).toHaveTextContent("customer_id");
    expect(relation).toHaveTextContent("declared");
  });

  it("sends only the column whose description changed", async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    const input = screen.getByLabelText("Description of column note");
    await user.type(input, "Free text");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(TABLE_URL, {
      columns: [{ name: "note", description: "Free text" }],
    });
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Description of column note")
      ).not.toBeInTheDocument()
    );
  });

  it("sends null for an emptied table description", async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    await user.clear(screen.getByLabelText("Table description"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(TABLE_URL, { description: null });
  });

  it("sends null for an emptied column description", async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    await user.clear(
      screen.getByLabelText("Description of column customer_id")
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(TABLE_URL, {
      columns: [{ name: "customer_id", description: null }],
    });
  });

  it("leaves edit mode without a request when nothing changed", async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(patch).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "Edit descriptions" })
    ).toBeInTheDocument();
  });

  it("discards edits on Cancel", async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    await user.type(screen.getByLabelText("Description of column note"), "x");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(patch).not.toHaveBeenCalled();
    await openEditor(user);
    expect(screen.getByLabelText("Description of column note")).toHaveValue("");
  });

  it("refuses a description over 2000 characters", async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    fireEvent.change(screen.getByLabelText("Description of column note"), {
      target: { value: "x".repeat(2001) },
    });
    expect(screen.getByText(/2001 \/ 2000/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("shows the API's error and stays in edit mode", async () => {
    patch.mockRejectedValue({
      status: 409,
      code: "source_archived",
      message: "The source is archived",
    });
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    await user.type(screen.getByLabelText("Description of column note"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("The source is archived")
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Description of column note")
    ).toBeInTheDocument();
  });

  it("has no edit control without zeteo.sources.write", async () => {
    held.permissions = ["zeteo.sources.read"];
    renderPage();
    await screen.findByRole("heading", { name: "public.orders" });
    expect(
      screen.queryByRole("button", { name: "Edit descriptions" })
    ).not.toBeInTheDocument();
  });

  it("has no edit control on an archived source", async () => {
    sourceOver.archived_at = "2026-11-02T10:00:00.000Z";
    renderPage();
    await screen.findByRole("heading", { name: "public.orders" });
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(`/v1/sources/${SOURCE_ID}`)
    );
    expect(
      screen.queryByRole("button", { name: "Edit descriptions" })
    ).not.toBeInTheDocument();
  });
});
