import { AMOUNT_ID, FS_ID, TABLE_ID, makeFileSource } from "../testFixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeGrant } from "@/features/grants/testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { RETYPE_WARNING } from "./ColumnTypeDialog";
import { FileSourcePage } from "./FileSourcePage";
import { pickOption } from "@/test/searchSelect";
import { Route, Routes } from "react-router-dom";

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

const renderAt = (route = `/my/data/${FS_ID}`) =>
  renderWithProviders(
    <Routes>
      <Route path="/my/data/:fileSourceId" element={<FileSourcePage />} />
      <Route path="/my" element={<p>My Zeteo</p>} />
      <Route
        path="/my/data/:fileSourceId/tables/:tableId/reupload"
        element={<p>Re-upload page</p>}
      />
    </Routes>,
    { route }
  );

describe("FileSourcePage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.data.read", "zeteo.file_sources.write"];
    get
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === "/v1/grants"
          ? { data: { data: [ownerGrant, shared], next_cursor: null } }
          : { data: makeFileSource() }
      );
    post.mockReset().mockResolvedValue({ data: { data: [] } });
    patch.mockReset().mockResolvedValue({ data: makeFileSource() });
    del.mockReset().mockResolvedValue({});
  });

  it("shows each table with its rows, when it was loaded and its columns", async () => {
    renderAt();
    expect(
      await screen.findByRole("heading", { name: "Q3 sales" })
    ).toBeInTheDocument();
    expect(screen.getByText("q3-sales")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "orders" })).toBeInTheDocument();
    expect(screen.getByText("1,234 rows")).toBeInTheDocument();
    const loaded = screen.getByText(/^Loaded/);
    expect(loaded.querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-11-15T09:30:00.000Z"
    );
    const amount = screen.getByText("amount").closest("tr")!;
    expect(amount).toHaveTextContent("Amount (EUR)");
    expect(amount).toHaveTextContent("Number");
    expect(amount).toHaveTextContent("Order total");
    expect(screen.getByText("2.4 MB stored")).toBeInTheDocument();
  });

  it("goes to the re-upload page of a table", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Re-upload" }));
    expect(await screen.findByText("Re-upload page")).toBeInTheDocument();
  });

  it("warns that saved queries may stop working before a retype, and sends the new type", async () => {
    const user = userEvent.setup();
    renderAt();
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
        `/v1/file-sources/${FS_ID}/tables/${TABLE_ID}/columns/${AMOUNT_ID}`,
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
    renderAt();
    const row = (await screen.findByText("region")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    await pickOption(user, within(dialog).getByLabelText("Type"), "Number");
    await user.click(
      within(dialog).getByRole("button", { name: "Save column" })
    );
    expect(
      await within(dialog).findByText(/has values that do not fit its type/)
    ).toHaveTextContent("row 2 of the file");
  });

  it("lists who it is shared with, the owner's grant locked", async () => {
    const user = userEvent.setup();
    renderAt(`/my/data/${FS_ID}?tab=sharing`);
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

  it("transfers to another user, and goes back to My data", async () => {
    const user = userEvent.setup();
    get.mockImplementation(async (url: string) =>
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
        : { data: makeFileSource() }
    );
    post.mockResolvedValue({ data: makeFileSource() });
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Transfer" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("combobox"), "nina");
    await user.click(await screen.findByText("Nina New"));
    await user.click(within(dialog).getByRole("button", { name: "Transfer" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/v1/file-sources/${FS_ID}/transfer`, {
        user_id: "c1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
        keep_access: true,
      })
    );
    expect(await screen.findByText("My Zeteo")).toBeInTheDocument();
  });

  it("deletes after a confirmation, then goes back to My data", async () => {
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
      expect(del).toHaveBeenCalledWith(`/v1/file-sources/${FS_ID}`)
    );
    expect(await screen.findByText("My Zeteo")).toBeInTheDocument();
  });

  it("is read-only for an admin who may only read sources", async () => {
    held.permissions = ["zeteo.sources.read"];
    get.mockResolvedValue({
      data: makeFileSource({
        owner_id: "c9999999-1c7a-4a53-9d0e-6a3b1f2c4d09",
      }),
    });
    renderAt();
    await screen.findByRole("heading", { name: "Q3 sales" });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Re-upload" })).toBeNull();
    expect(screen.getByRole("link", { name: /Sources/ })).toHaveAttribute(
      "href",
      "/sources"
    );
  });
});
