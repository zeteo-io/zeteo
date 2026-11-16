import { makeSource, SOURCE_ID } from "../../sources/testFixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { RelationsPage } from "./RelationsPage";
import { makeRelation } from "../testFixtures";
import { AxiosError } from "axios";
import {
  CUSTOMERS_ID,
  GONE_ID,
  makeTable,
} from "@/features/tables/testFixtures";

const get = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.sources.write"] }));
const sourceOver = vi.hoisted(() => ({ archived_at: null as string | null }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, delete: del },
  })
);

const discovered = makeRelation({
  id: "d2222222-1c7a-4a53-9d0e-6a3b1f2c4d02",
  name: "fk_orders_customers",
  origin: "discovered",
});
const declared = makeRelation();
const stale = makeRelation({
  id: "d3333333-1c7a-4a53-9d0e-6a3b1f2c4d03",
  name: "stale_fk",
  origin: "discovered",
  to_table_id: GONE_ID,
  missing_since: "2026-11-05T10:00:00.000Z",
});

const renderPage = () =>
  renderWithProviders(
    <Routes>
      <Route path="/sources/:sourceId/relations" element={<RelationsPage />} />
    </Routes>,
    { route: `/sources/${SOURCE_ID}/relations` }
  );

describe("RelationsPage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.sources.write"];
    sourceOver.archived_at = null;
    del.mockReset().mockResolvedValue({ data: undefined });
    get.mockReset().mockImplementation(async (url: string) => {
      if (url === `/v1/sources/${SOURCE_ID}`) {
        return { data: makeSource({ archived_at: sourceOver.archived_at }) };
      }
      if (url.endsWith("/relations")) {
        return {
          data: { data: [discovered, declared, stale], next_cursor: null },
        };
      }
      return {
        data: {
          data: [
            makeTable(),
            makeTable({ id: CUSTOMERS_ID, name: "customers" }),
            makeTable({
              id: GONE_ID,
              name: "retired",
              missing_since: "2026-11-05T10:00:00.000Z",
            }),
          ],
          next_cursor: null,
        },
      };
    });
  });

  it("lists each relation with resolved table names, columns, to-many and origin", async () => {
    renderPage();
    const row = (await screen.findByText("customer")).closest("tr")!;
    await waitFor(() => expect(row).toHaveTextContent("public.orders"));
    expect(row).toHaveTextContent("customer_id");
    expect(row).toHaveTextContent("public.customers");
    expect(row).toHaveTextContent("declared");
    expect(row).toHaveTextContent("No");
  });

  it("flags a relation a refresh no longer finds", async () => {
    renderPage();
    const row = (await screen.findByText("stale_fk")).closest("tr")!;
    expect(row).toHaveTextContent("Missing");
    await waitFor(() => expect(row).toHaveTextContent("public.retired"));
  });

  it("offers no delete on a discovered relation", async () => {
    renderPage();
    const row = (await screen.findByText("fk_orders_customers")).closest("tr")!;
    expect(
      within(row).queryByRole("button", { name: "Delete" })
    ).not.toBeInTheDocument();
  });

  it("deletes a declared relation after confirmation", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("customer")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(del).not.toHaveBeenCalled();
    await user.click(
      await screen.findByRole("button", { name: "Delete relation" })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(
        `/v1/sources/${SOURCE_ID}/relations/${declared.id}`
      )
    );
  });

  it("shows the API's description when the delete is refused", async () => {
    del.mockRejectedValue(
      new AxiosError("Conflict", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 409,
        statusText: "Conflict",
        headers: {},
        config: {} as never,
        data: {
          error: "relation_discovered",
          error_description: "A discovered relation cannot be removed",
        },
      })
    );
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("customer")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(
      await screen.findByRole("button", { name: "Delete relation" })
    );
    expect(
      await screen.findByText("A discovered relation cannot be removed")
    ).toBeInTheDocument();
  });

  it("shows a placeholder, not raw ids, while table names load", async () => {
    get.mockImplementation(async (url: string) => {
      if (url === `/v1/sources/${SOURCE_ID}`) return { data: makeSource() };
      if (url.endsWith("/relations")) {
        return { data: { data: [declared], next_cursor: null } };
      }
      return new Promise(() => {});
    });
    renderPage();
    const row = (await screen.findByText("customer")).closest("tr")!;
    expect(row).not.toHaveTextContent(CUSTOMERS_ID);
    expect(
      screen.getByRole("button", { name: "Declare relation" })
    ).toBeDisabled();
  });

  it("has no write controls without zeteo.sources.write", async () => {
    held.permissions = ["zeteo.sources.read"];
    renderPage();
    await screen.findByText("customer");
    expect(
      screen.queryByRole("button", { name: "Delete" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Declare relation" })
    ).not.toBeInTheDocument();
  });

  it("has no write controls on an archived source", async () => {
    sourceOver.archived_at = "2026-11-02T10:00:00.000Z";
    renderPage();
    await screen.findByText("customer");
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(`/v1/sources/${SOURCE_ID}`)
    );
    expect(
      screen.queryByRole("button", { name: "Delete" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Declare relation" })
    ).not.toBeInTheDocument();
  });

  it("opens the declare form for someone who can write", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Declare relation" })
    );
    expect(await screen.findByLabelText(/^Name/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("option", { name: "public.customers" })
    ).toHaveLength(2);
    expect(screen.queryByRole("option", { name: "public.retired" })).toBeNull();
  });
});
