import { makeGrant, USER_ID } from "@/features/grants/testFixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { FileSourcePage } from "./FileSourcePage";
import { optionTexts } from "@/test/searchSelect";
import { Route, Routes } from "react-router-dom";
import {
  AMOUNT_ID,
  FS_ID,
  REGION_ID,
  TABLE_ID,
  makeFileSource,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read", "zeteo.file_sources.write"],
    api: { get, post, put, patch, delete: del },
  })
);

const NOTES_ID = "f6666666-1c7a-4a53-9d0e-6a3b1f2c4d06";
const RELATION_ID = "f7777777-1c7a-4a53-9d0e-6a3b1f2c4d07";
const NEW_ID = "c1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";

const twoTables = () => {
  const base = makeFileSource();
  return makeFileSource({
    tables: [
      ...base.tables,
      {
        id: NOTES_ID,
        name: "notes",
        description: null,
        row_count: 2,
        last_synced_at: "2026-11-15T09:30:00.000Z",
        missing: false,
        columns: [
          {
            id: "f8888888-1c7a-4a53-9d0e-6a3b1f2c4d08",
            name: "order_region",
            original_name: "Order region",
            type: "text",
            description: null,
            missing: false,
          },
        ],
      },
    ],
  });
};

const shared = makeGrant({
  source: { id: FS_ID, slug: "q3-sales" },
  table: { id: TABLE_ID, schema_name: "zf_x", name: "orders", missing: false },
  all_columns: false,
  columns: [{ id: AMOUNT_ID, name: "amount", missing: false }],
});

const relation = {
  id: RELATION_ID,
  name: "region_orders",
  from_table_id: NOTES_ID,
  from_columns: ["order_region"],
  to_table_id: TABLE_ID,
  to_columns: ["region"],
  to_many: true,
  origin: "declared",
  missing_since: null,
};

const renderAt = (route = `/my/data/${FS_ID}`) =>
  renderWithProviders(
    <Routes>
      <Route path="/my/data/:fileSourceId" element={<FileSourcePage />} />
    </Routes>,
    { route }
  );

describe("FileSourcePage flows", () => {
  beforeEach(() => {
    get.mockReset().mockImplementation(async (url: string) => {
      if (url === "/v1/grants") {
        return { data: { data: [shared], next_cursor: null } };
      }
      if (url === `/v1/sources/${FS_ID}/relations`) {
        return { data: { data: [relation], next_cursor: null } };
      }
      if (url === "/v1/me/principals") {
        return {
          data: {
            data: [
              {
                type: "user",
                id: NEW_ID,
                name: "Nina New",
                email: "nina@example.com",
                status: "active",
              },
            ],
          },
        };
      }
      return { data: twoTables() };
    });
    post.mockReset().mockImplementation(async (url: string) =>
      url === "/v1/principals/lookup"
        ? {
            data: {
              data: [
                {
                  type: "user",
                  id: USER_ID,
                  name: "Sam Shared",
                  email: "sam@example.com",
                  status: "active",
                },
              ],
            },
          }
        : { data: shared }
    );
    put.mockReset().mockResolvedValue({ data: shared });
    patch.mockReset().mockResolvedValue({ data: twoTables() });
    del.mockReset().mockResolvedValue({});
  });

  it("removes a table after a confirmation", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(
      await screen.findByRole("button", { name: "Remove notes" })
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Remove table" })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(
        `/v1/file-sources/${FS_ID}/tables/${NOTES_ID}`
      )
    );
  });

  it("renames the source", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Q3 sales (final)");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/v1/file-sources/${FS_ID}`, {
        name: "Q3 sales (final)",
      })
    );
  });

  it("describes a table through the catalogue's route", async () => {
    const user = userEvent.setup();
    renderAt();
    expect(
      await screen.findByText("Orders of the quarter")
    ).toBeInTheDocument();
    // The orders table has one; notes has none.
    const notes = screen
      .getByRole("heading", { name: "notes" })
      .closest(".k-bordered-section") as HTMLElement;
    await user.click(
      within(notes).getAllByRole("button", { name: "Add description" })[0]!
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Description"), "Free notes");
    await user.click(
      within(dialog).getByRole("button", { name: "Save description" })
    );
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        `/v1/sources/${FS_ID}/tables/${NOTES_ID}`,
        { description: "Free notes" }
      )
    );
  });

  it("names who it is shared with", async () => {
    renderAt(`/my/data/${FS_ID}?tab=sharing`);
    expect(await screen.findByText("Sam Shared")).toBeInTheDocument();
  });

  it("shares a table's chosen columns with a person", async () => {
    const user = userEvent.setup();
    renderAt(`/my/data/${FS_ID}?tab=sharing`);
    await user.click(await screen.findByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("combobox"), "nina");
    await user.click(await screen.findByText("Nina New"));
    // Pick the table.
    await user.click(within(dialog).getByLabelText("Table"));
    expect(optionTexts()).toEqual(["orders", "notes"]);
    await user.click(
      [...document.querySelectorAll(".k-search-list-option")].find(
        (li) => li.textContent === "orders"
      ) as HTMLElement
    );
    await user.click(within(dialog).getByLabelText("All columns"));
    await user.click(within(dialog).getByLabelText("region"));
    await user.click(within(dialog).getByRole("button", { name: "Share" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/v1/grants", {
        principal_type: "user",
        principal_id: NEW_ID,
        table_id: TABLE_ID,
        all_columns: false,
        column_ids: [REGION_ID],
      })
    );
  });

  it("changes a grant to every column", async () => {
    const user = userEvent.setup();
    renderAt(`/my/data/${FS_ID}?tab=sharing`);
    const row = (await screen.findByText("amount")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("amount")).toBeChecked();
    await user.click(within(dialog).getByLabelText("All columns"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(`/v1/grants/${shared.id}`, {
        all_columns: true,
      })
    );
  });

  it("lists relations by table name, renames and removes them", async () => {
    const user = userEvent.setup();
    renderAt(`/my/data/${FS_ID}?tab=relations`);
    const row = (await screen.findByText("region_orders")).closest("tr")!;
    expect(row).toHaveTextContent("notes (order_region)");
    expect(row).toHaveTextContent("orders (region)");
    expect(row).toHaveTextContent("Many");

    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "region_lines");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        `/v1/sources/${FS_ID}/relations/${RELATION_ID}`,
        { name: "region_lines" }
      )
    );

    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Remove relation",
      })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(
        `/v1/sources/${FS_ID}/relations/${RELATION_ID}`
      )
    );
  });

  it("declares a relation between its tables, named without their schema", async () => {
    const user = userEvent.setup();
    renderAt(`/my/data/${FS_ID}?tab=relations`);
    await user.click(
      await screen.findByRole("button", { name: "Declare relation" })
    );
    await user.click(await screen.findByLabelText(/^From table/));
    expect(optionTexts()).toEqual(["orders", "notes"]);
  });
});
