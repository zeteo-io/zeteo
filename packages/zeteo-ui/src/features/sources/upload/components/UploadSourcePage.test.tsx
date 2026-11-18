import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeGrant } from "@/features/grants/testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { RETYPE_WARNING } from "./ColumnTypeDialog";
import { SourceTestRoutes } from "../testRoutes";
import { pickOption } from "@/test/searchSelect";
import { formatDate } from "@/utils/formatDate";
import {
  AMOUNT_ID,
  FS_ID,
  TABLE_ID,
  uploadGet,
  makeUploadSource,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({
  permissions: ["zeteo.data.read", "zeteo.file_sources.write"],
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, post, patch, delete: del },
  })
);

const ownerGrant = makeGrant({
  id: "e2222222-1c7a-4a53-9d0e-6a3b1f2c4d02",
  principal_id: "0b6c3c1e-8a52-4f7e-9b1d-2f4f8f0e9a11",
  source: { id: FS_ID, slug: "q3-sales" },
  table: { id: TABLE_ID, schema_name: "zf_x", name: "orders", missing: false },
  owner_grant: true,
});
const shared = makeGrant({
  source: { id: FS_ID, slug: "q3-sales" },
  table: { id: TABLE_ID, schema_name: "zf_x", name: "orders", missing: false },
  all_columns: false,
  columns: [{ id: AMOUNT_ID, name: "amount", missing: false }],
});

const NOBODY = "c9999999-1c7a-4a53-9d0e-6a3b1f2c4d10";
/** Everyone the owner may share with: the Shared with tab's Who choices. */
const directory = {
  data: [
    {
      type: "user",
      id: shared.principal_id,
      name: "Sam Shared",
      status: "active",
    },
    {
      type: "user",
      id: ownerGrant.principal_id,
      name: "Olive Owner",
      status: "active",
    },
    { type: "user", id: NOBODY, name: "Nina Nobody", status: "active" },
  ],
  truncated: false,
};

/** Someone other than the signed-in user. */
const OTHER_OWNER = "c9999999-1c7a-4a53-9d0e-6a3b1f2c4d09";

const TABLE_PAGE = `/sources/${FS_ID}/tables/${TABLE_ID}`;

const renderAt = (route = `/sources/${FS_ID}`) =>
  renderWithProviders(<SourceTestRoutes />, { route });

const TABLES_PAGE = `/sources/${FS_ID}/tables`;
const SHARING_PAGE = `/sources/${FS_ID}/sharing`;

describe("an upload source's page", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.data.read", "zeteo.file_sources.write"];
    get
      .mockReset()
      .mockImplementation(
        uploadGet(makeUploadSource, undefined, (url) =>
          url === "/v1/grants"
            ? { data: { data: [ownerGrant, shared], next_cursor: null } }
            : url === "/v1/me/principals/all"
              ? { data: directory }
              : undefined
        )
      );
    post.mockReset().mockResolvedValue({ data: { data: [] } });
    patch.mockReset().mockResolvedValue({ data: makeUploadSource() });
    del.mockReset().mockResolvedValue({});
  });

  it("shows the data facts and the limits of its source row on the overview", async () => {
    renderAt();
    expect(
      await screen.findByRole("heading", { name: "Q3 sales" })
    ).toBeInTheDocument();
    expect(screen.getByText("q3-sales")).toBeInTheDocument();
    const fact = async (term: string) =>
      (await screen.findByText(term, { selector: "dt" })).nextElementSibling;
    expect(await fact("Owner")).toHaveTextContent("You");
    expect(await fact("Size")).toHaveTextContent("2.4 MB");
    expect(await fact("Tables")).toHaveTextContent("1");
    expect(await screen.findByText("Row cap")).toBeInTheDocument();
  });

  it("lists its tables as a database source does, with their rows and when they were loaded", async () => {
    renderAt(TABLES_PAGE);
    expect(
      await screen.findByRole("heading", { name: "Q3 sales" })
    ).toBeInTheDocument();
    const row = (await screen.findByRole("link", { name: "orders" })).closest(
      "tr"
    )!;
    expect(row).toHaveTextContent("Orders of the quarter");
    expect(row).toHaveTextContent("1,234");
    expect(row.querySelector("time")).toHaveAttribute(
      "title",
      formatDate("2026-11-15T09:30:00.000Z")
    );
    // No schema: Zeteo names a file source's schema itself.
    expect(screen.queryByText("zf_x")).toBeNull();
    expect(screen.getByRole("link", { name: "orders" })).toHaveAttribute(
      "href",
      TABLE_PAGE
    );
  });

  it("shows a table's page as a database source does, with each column's header", async () => {
    renderAt(TABLE_PAGE);
    expect(
      await screen.findByRole("heading", { name: "orders" })
    ).toBeInTheDocument();
    const amount = (await screen.findByText("amount")).closest("tr")!;
    expect(amount).toHaveTextContent("Amount (EUR)");
    expect(amount).toHaveTextContent("number");
    expect(amount).toHaveTextContent("Order total");
    expect(
      screen.getByRole("button", { name: "Edit descriptions" })
    ).toBeInTheDocument();
  });

  it("goes to the re-upload page of a table", async () => {
    const user = userEvent.setup();
    renderAt(TABLE_PAGE);
    await user.click(await screen.findByRole("button", { name: "Re-upload" }));
    expect(await screen.findByText("Re-upload page")).toBeInTheDocument();
  });

  it("warns that saved queries may stop working before a retype, and sends the new type", async () => {
    const user = userEvent.setup();
    renderAt(TABLE_PAGE);
    const row = (await screen.findByText("amount")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(screen.queryByText(RETYPE_WARNING, { exact: false })).toBeNull();
    await pickOption(user, within(dialog).getByLabelText("Type"), "Text");
    expect(
      within(dialog).getByText(
        /Saved queries and dashboards that use this column may stop working/
      )
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Save column" })
    );
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        `/v1/sources/${FS_ID}/tables/${TABLE_ID}/columns/${AMOUNT_ID}`,
        { type: "text" }
      )
    );
  });

  it("shows a retype's cast_failed with the rows, keeping the dialog open", async () => {
    const user = userEvent.setup();
    patch.mockRejectedValue({
      status: 422,
      code: "cast_failed",
      message: "x",
      cast: { column: "region", rows: [2] },
    });
    renderAt(TABLE_PAGE);
    const row = (await screen.findByText("region")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    await pickOption(user, within(dialog).getByLabelText("Type"), "Number");
    await user.click(
      within(dialog).getByRole("button", { name: "Save column" })
    );
    expect(
      await within(dialog).findByText(/has values that do not fit its type/)
    ).toHaveTextContent("data row 2 of the table");
  });

  it("filters by who it is shared with, chosen by name from everyone the owner may share with, and by table, through the API", async () => {
    const user = userEvent.setup();
    renderAt(SHARING_PAGE);
    await screen.findByText("Owner");
    await user.click(await screen.findByRole("button", { name: /Who/ }));
    await user.click(
      await screen.findByRole("checkbox", { name: "Sam Shared" })
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/v1/grants",
        expect.objectContaining({
          params: expect.objectContaining({
            source_id: FS_ID,
            principal_type: "user",
            principal_id: shared.principal_id,
          }),
        })
      )
    );
    await user.click(screen.getByRole("button", { name: /Table/ }));
    await user.click(await screen.findByRole("checkbox", { name: "orders" }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/v1/grants",
        expect.objectContaining({
          params: expect.objectContaining({
            principal_id: shared.principal_id,
            table_id: TABLE_ID,
          }),
        })
      )
    );
  });

  it("offers anyone the owner may share with, shared with or not", async () => {
    const user = userEvent.setup();
    renderAt(SHARING_PAGE);
    await screen.findByText("Owner");
    expect(get).not.toHaveBeenCalledWith(
      "/v1/principals/all",
      expect.anything()
    );
    await user.click(await screen.findByRole("button", { name: /Who/ }));
    await user.click(
      await screen.findByRole("checkbox", { name: "Nina Nobody" })
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/v1/grants",
        expect.objectContaining({
          params: expect.objectContaining({
            principal_type: "user",
            principal_id: NOBODY,
          }),
        })
      )
    );
  });

  it("has no actions column while it is shared with no one but its owner", async () => {
    get.mockImplementation(
      uploadGet(makeUploadSource, undefined, (url) =>
        url === "/v1/grants"
          ? { data: { data: [ownerGrant], next_cursor: null } }
          : undefined
      )
    );
    renderAt(SHARING_PAGE);
    await screen.findByText("Owner");
    expect(
      screen.getAllByRole("columnheader").map((h) => h.textContent)
    ).toEqual(["Who", "Table", "Columns"]);
  });

  it("lists who it is shared with, the owner's grant locked", async () => {
    const user = userEvent.setup();
    renderAt(SHARING_PAGE);
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/v1/grants",
        expect.objectContaining({
          params: expect.objectContaining({ source_id: FS_ID }),
        })
      )
    );
    const owner = (await screen.findByText("Owner")).closest("tr")!;
    expect(within(owner).queryByRole("button", { name: "Edit" })).toBeNull();
    const other = screen.getByText("amount").closest("tr")!;
    expect(
      within(other).getByRole("button", { name: "Edit" })
    ).toBeInTheDocument();

    await user.click(
      within(other).getByRole("button", { name: "Stop sharing" })
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Stop sharing",
      })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/grants/${shared.id}`)
    );
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("transfers to another user, and goes back to My sources", async () => {
    const user = userEvent.setup();
    get.mockImplementation(
      uploadGet(makeUploadSource, undefined, (url) =>
        url === "/v1/me/principals"
          ? {
              data: {
                data: [
                  {
                    type: "user",
                    id: "c1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
                    name: "Nina New",
                    email: "nina@example.com",
                    status: "active",
                  },
                ],
              },
            }
          : undefined
      )
    );
    post.mockResolvedValue({ data: makeUploadSource() });
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Transfer" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("combobox"), "nina");
    await user.click(await screen.findByText("Nina New"));
    await user.click(within(dialog).getByRole("button", { name: "Transfer" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/v1/sources/${FS_ID}/transfer`, {
        user_id: "c1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
        keep_access: true,
      })
    );
    expect(await screen.findByText("My Zeteo")).toBeInTheDocument();
  });

  it("deletes after a confirmation, then goes back to My sources", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("cannot be recovered");
    expect(del).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Delete source" })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/sources/${FS_ID}`)
    );
    expect(await screen.findByText("My Zeteo")).toBeInTheDocument();
  });

  it("is read-only for an admin who may only read sources", async () => {
    held.permissions = ["zeteo.sources.read"];
    get.mockImplementation(
      uploadGet(() =>
        makeUploadSource({ owner_id: "c9999999-1c7a-4a53-9d0e-6a3b1f2c4d09" })
      )
    );
    renderAt(TABLE_PAGE);
    await screen.findByRole("heading", { name: "orders" });
    expect(
      screen.queryByRole("button", { name: "Edit descriptions" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Re-upload" })).toBeNull();
  });

  it("lets an admin with zeteo.sources.write change the limits from Edit, through PATCH /v1/sources/:id", async () => {
    const user = userEvent.setup();
    held.permissions = ["zeteo.data.read", "zeteo.sources.write"];
    const stored = makeUploadSource({
      owner_id: OTHER_OWNER,
      export_enabled: false,
      row_cap: 50000,
    });
    get.mockImplementation(uploadGet(() => stored));
    patch.mockResolvedValue({ data: { ...stored, export_enabled: true } });
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    // A file source has no connection or catalogue to edit.
    expect(within(dialog).queryByText("Connection")).toBeNull();
    expect(within(dialog).queryByLabelText(/Schemas/)).toBeNull();
    expect(await within(dialog).findByLabelText("Row cap")).toHaveValue(50000);
    expect(
      within(dialog).getByText("People can't export from this source.")
    ).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText("Allow exports"));
    // The Exports section's own Row cap, after Querying's.
    const cap = within(dialog).getAllByLabelText("Row cap")[1]!;
    await user.clear(cap);
    await user.type(cap, "10000");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" })
    );
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/v1/sources/${FS_ID}`, {
        export_enabled: true,
        export_row_cap: 10000,
      })
    );
    // One PATCH, and the unchanged name is not in it.
    expect(patch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("refuses an out-of-range limit before sending it", async () => {
    const user = userEvent.setup();
    held.permissions = ["zeteo.data.read", "zeteo.sources.write"];
    get.mockImplementation(
      uploadGet(() => makeUploadSource({ owner_id: OTHER_OWNER }))
    );
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const cap = await within(dialog).findByLabelText("Row cap");
    await user.clear(cap);
    await user.type(cap, "999999");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" })
    );
    expect(
      await within(dialog).findByText("Row cap is 1 to 50000.")
    ).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("lets the owner rename it from Edit, with no limits to change", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const name = await within(dialog).findByLabelText(/^Name/);
    expect(within(dialog).queryByLabelText("Row cap")).toBeNull();
    await user.clear(name);
    await user.type(name, "Q3 sales (final)");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" })
    );
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/v1/sources/${FS_ID}`, {
        name: "Q3 sales (final)",
      })
    );
    // Only the name: the owner may not change the limits.
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("shows Active, as a database source does", async () => {
    renderAt();
    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Upload")).toBeInTheDocument();
  });

  it("shows a deleted source as Deleted, with when, and no actions", async () => {
    get.mockImplementation(
      uploadGet(() =>
        makeUploadSource({ archived_at: "2026-11-16T10:00:00.000Z" })
      )
    );
    renderAt();
    expect(
      await screen.findByText("Deleted", { selector: "dt" })
    ).toBeInTheDocument();
    expect(screen.getAllByText("Deleted").length).toBe(2);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("names someone else's owner, and sends a sources admin back to Sources after deleting", async () => {
    const user = userEvent.setup();
    held.permissions = ["zeteo.data.read", "zeteo.sources.write"];
    get.mockImplementation(
      uploadGet(() => makeUploadSource({ owner_id: OTHER_OWNER }))
    );
    renderAt();
    const owner = (await screen.findByText("Owner", { selector: "dt" }))
      .nextElementSibling;
    expect(owner).not.toHaveTextContent("You");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete source",
      })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/sources/${FS_ID}`)
    );
    expect(await screen.findByText("Sources list")).toBeInTheDocument();
  });

  it("goes to Add tables from the header", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Add tables" }));
    expect(await screen.findByText("Add tables page")).toBeInTheDocument();
  });

  it("hides Shared with from a sources admin who may not read grants", async () => {
    held.permissions = ["zeteo.data.read", "zeteo.sources.write"];
    get.mockImplementation(
      uploadGet(() => makeUploadSource({ owner_id: OTHER_OWNER }))
    );
    renderAt(SHARING_PAGE);
    await screen.findByRole("button", { name: "Edit" });
    expect(screen.queryByRole("link", { name: "Shared with" })).toBeNull();
    // The page is not found, and no grants were asked for.
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith("/v1/grants", expect.anything());
  });

  it("lists grants read-only for an admin who may read but not change them", async () => {
    held.permissions = [
      "zeteo.data.read",
      "zeteo.sources.write",
      "zeteo.grants.read",
    ];
    get.mockImplementation(
      uploadGet(
        () => makeUploadSource({ owner_id: OTHER_OWNER }),
        undefined,
        (url) =>
          url === "/v1/grants"
            ? { data: { data: [ownerGrant, shared], next_cursor: null } }
            : undefined
      )
    );
    renderAt(SHARING_PAGE);
    const other = (await screen.findByText("amount")).closest("tr")!;
    expect(within(other).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      within(other).queryByRole("button", { name: "Stop sharing" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("lets a grants admin share and change grants on someone else's source", async () => {
    held.permissions = ["zeteo.data.read", "zeteo.grants.write"];
    get.mockImplementation(
      uploadGet(
        () => makeUploadSource({ owner_id: OTHER_OWNER }),
        undefined,
        (url) =>
          url === "/v1/grants"
            ? { data: { data: [ownerGrant, shared], next_cursor: null } }
            : undefined
      )
    );
    renderAt(SHARING_PAGE);
    const other = (await screen.findByText("amount")).closest("tr")!;
    expect(
      within(other).getByRole("button", { name: "Edit" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    // Not a sources admin: the source itself is not theirs to change.
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("lets a grants admin remove the former owner grant of a deleted source, and nothing else", async () => {
    const user = userEvent.setup();
    held.permissions = ["zeteo.data.read", "zeteo.grants.write"];
    const former = { ...ownerGrant, owner_grant: false };
    get.mockImplementation(
      uploadGet(
        () =>
          makeUploadSource({
            owner_id: OTHER_OWNER,
            archived_at: "2026-11-16T10:00:00.000Z",
          }),
        undefined,
        (url) =>
          url === "/v1/grants"
            ? { data: { data: [former], next_cursor: null } }
            : undefined
      )
    );
    renderAt(SHARING_PAGE);
    const row = (
      await screen.findByText("orders", { selector: "td *, td" })
    ).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    await user.click(within(row).getByRole("button", { name: "Stop sharing" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Stop sharing",
      })
    );
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/grants/${former.id}`)
    );
  });
});
