import { makeGrant, USER_ID } from "@/features/grants/testFixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { optionTexts } from "@/test/searchSelect";
import { SourceTestRoutes } from "../testRoutes";
import {
  AMOUNT_ID,
  FS_ID,
  REGION_ID,
  TABLE_ID,
  uploadGet,
  makeUploadSource,
  ordersTable,
  type UploadTable,
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

const twoTables = (): UploadTable[] => [
  ordersTable(),
  {
    id: NOTES_ID,
    name: "notes",
    description: null,
    row_count: 2,
    last_loaded_at: "2026-11-15T09:30:00.000Z",
    columns: [
      {
        id: "f8888888-1c7a-4a53-9d0e-6a3b1f2c4d08",
        name: "order_region",
        original_name: "Order region",
        type: "text",
        description: null,
      },
    ],
  },
];

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

const renderAt = (route = `/sources/${FS_ID}`) =>
  renderWithProviders(<SourceTestRoutes />, { route });

const TABLES_PAGE = `/sources/${FS_ID}/tables`;
const SHARING_PAGE = `/sources/${FS_ID}/sharing`;
const RELATIONS_PAGE = `/sources/${FS_ID}/relations`;

describe("an upload source's page: flows", () => {
  beforeEach(() => {
    get.mockReset().mockImplementation(
      uploadGet(makeUploadSource, twoTables, (url) => {
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
        return undefined;
      })
    );
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
    patch.mockReset().mockResolvedValue({ data: makeUploadSource() });
    del.mockReset().mockResolvedValue({});
  });

  it("removes a table after a confirmation", async () => {
    const user = userEvent.setup();
    renderAt(`/sources/${FS_ID}/tables/${NOTES_ID}`);
    await user.click(
      await screen.findByRole("button", { name: "Remove notes" })
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Remove table" })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(
        `/v1/sources/${FS_ID}/tables/${NOTES_ID}`
      )
    );
  });

  it("describes a table through the catalogue's route", async () => {
    const user = userEvent.setup();
    renderAt(TABLES_PAGE);
    // The list offers a description where there is none.
    const notesRow = (
      await screen.findByRole("link", { name: "notes" })
    ).closest("tr")!;
    await user.click(
      within(notesRow).getByRole("link", { name: "Add description" })
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit descriptions" })
    );
    await user.type(screen.getByLabelText("Table description"), "Free notes");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        `/v1/sources/${FS_ID}/tables/${NOTES_ID}`,
        { description: "Free notes" }
      )
    );
  });

  it("names who it is shared with", async () => {
    renderAt(SHARING_PAGE);
    expect(await screen.findByText("Sam Shared")).toBeInTheDocument();
  });

  it("shares a table's chosen columns with a person", async () => {
    const user = userEvent.setup();
    renderAt(SHARING_PAGE);
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
    renderAt(SHARING_PAGE);
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
    renderAt(RELATIONS_PAGE);
    const row = (await screen.findByText("region_orders")).closest("tr")!;
    expect(row).toHaveTextContent("notes");
    expect(row).toHaveTextContent("orders");
    expect(row).toHaveTextContent("order_region → region");
    expect(row).not.toHaveTextContent("zf_x");
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
        name: "Delete relation",
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
    renderAt(RELATIONS_PAGE);
    await user.click(
      await screen.findByRole("button", { name: "Declare relation" })
    );
    await user.click(await screen.findByLabelText(/^From table/));
    expect(optionTexts()).toEqual(["orders", "notes"]);
  });
});
