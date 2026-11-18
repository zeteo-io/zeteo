import { AddDataPage, AddTablesPage, ReuploadPage } from "./AddDataPage";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { optionTexts, pickOption } from "@/test/searchSelect";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import {
  FS_ID,
  STAGING_ID,
  TABLE_ID,
  makeFileSource,
  makePreviewTable,
  makeStaging,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read", "zeteo.file_sources.write"],
    api: { get, post, put },
  })
);

const renderAt = (route: string) =>
  renderWithProviders(
    <Routes>
      <Route path="/my/data/new" element={<AddDataPage />} />
      <Route path="/my/data/:fileSourceId/add" element={<AddTablesPage />} />
      <Route
        path="/my/data/:fileSourceId/tables/:tableId/reupload"
        element={<ReuploadPage />}
      />
      <Route path="/my/data/:fileSourceId" element={<p>Source page</p>} />
    </Routes>,
    { route }
  );

type User = ReturnType<typeof userEvent.setup>;

const upload = async (user: User, name = "Q3 sales.xlsx") => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await user.upload(input, new File(["x"], name));
};

/** The section of one staged table, by its heading. */
const section = (name: string) =>
  screen
    .getByRole("heading", { name })
    .closest(".k-bordered-section, section") as HTMLElement;

describe("AddDataPage", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ data: makeFileSource() });
    post
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === "/v1/file-sources/uploads"
          ? { data: makeStaging() }
          : { data: makeFileSource() }
      );
    put.mockReset().mockResolvedValue({ data: makeFileSource() });
  });

  it("uploads the file as multipart and previews each table with its columns, types, samples and warnings", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);

    expect(
      await screen.findByRole("heading", { name: "orders" })
    ).toBeInTheDocument();
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/v1/file-sources/uploads");
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toBeInstanceOf(File);

    // The name comes from the file's.
    expect(screen.getByRole("textbox", { name: /^Name\W*$/ })).toHaveValue(
      "Q3 sales"
    );
    expect(screen.getByRole("heading", { name: "notes" })).toBeInTheDocument();
    expect(
      screen.getByText('Column "note" has no values in its first rows.')
    ).toBeInTheDocument();
    expect(screen.getByText("North, South")).toBeInTheDocument();
    expect(screen.getByText("ZIP")).toBeInTheDocument();
    expect(screen.getByLabelText("Type of column 2")).toHaveValue("Number");
  });

  it("keeps a chosen type and sends only what changed", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });

    const typeFields = screen.getAllByLabelText("Type of column 2");
    await pickOption(user, typeFields[0]!, "Text");
    expect(optionTexts()).toEqual([]);
    expect(screen.getAllByLabelText("Type of column 2")[0]).toHaveValue("Text");

    // Leave the notes table out.
    await user.click(within(section("notes")).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create source" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]).toEqual([
      "/v1/file-sources",
      {
        staging_id: STAGING_ID,
        name: "Q3 sales",
        tables: [
          { key: "sheet:Orders", columns: [{ index: 1, type: "text" }] },
        ],
      },
    ]);
    expect(await screen.findByText("Source page")).toBeInTheDocument();
  });

  it("refuses a column name the query language cannot take", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    const name = screen.getAllByLabelText("Name of column 1")[0]!;
    await user.clear(name);
    await user.type(name, "Region Name");
    expect(
      screen.getAllByText(/A lowercase letter, then lowercase letters/)[0]
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create source" })
    ).toBeDisabled();
  });

  it("shows the column and rows of a cast_failed, and stays on the preview", async () => {
    const user = userEvent.setup();
    post.mockImplementation(async (url: string) => {
      if (url === "/v1/file-sources/uploads") return { data: makeStaging() };
      throw {
        status: 422,
        code: "cast_failed",
        message:
          'Column "zip" of table "orders" has values that are not of its type',
        cast: { table: "orders", column: "zip", rows: [4, 9, 12] },
      };
    });
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    await user.click(screen.getByRole("button", { name: "Create source" }));

    const alert = await screen.findByText(
      /has values that do not fit its type/
    );
    expect(alert).toHaveTextContent("zip");
    expect(alert).toHaveTextContent("orders");
    expect(alert).toHaveTextContent("rows 4, 9 and 12");
    expect(screen.getByRole("heading", { name: "orders" })).toBeInTheDocument();
  });

  it("shows why an upload was refused", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      status: 415,
      code: "unsupported_file_type",
      message: "Only CSV and xlsx files can be uploaded",
    });
    renderAt("/my/data/new");
    await upload(user, "data.csv");
    expect(
      await screen.findByText("Only CSV and xlsx files can be uploaded")
    ).toBeInTheDocument();
  });

  it("re-uploads one table, proposing its columns' current types", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({
      data: makeStaging([
        makePreviewTable({
          key: "csv",
          kind: "csv",
          columns: [
            {
              index: 0,
              name: "region",
              original_name: "Region",
              type: "text",
              samples: ["North"],
            },
            {
              index: 1,
              name: "amount",
              original_name: "Amount (EUR)",
              type: "text",
              samples: ["12.5"],
            },
          ],
        }),
      ]),
    });
    renderAt(`/my/data/${FS_ID}/tables/${TABLE_ID}/reupload`);
    expect(
      await screen.findByRole("heading", { name: "Re-upload orders" })
    ).toBeInTheDocument();
    await upload(user, "orders.csv");
    await screen.findByRole("heading", { name: "orders" });
    // amount is a number in the source today.
    expect(screen.getByLabelText("Type of column 2")).toHaveValue("Number");
    await user.click(screen.getByRole("button", { name: "Replace data" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        `/v1/file-sources/${FS_ID}/tables/${TABLE_ID}`,
        {
          staging_id: STAGING_ID,
          key: "csv",
          columns: [{ index: 1, type: "number" }],
        }
      )
    );
  });

  it("leaves a table out with its Keep switch, and refuses to create with none kept", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    await user.click(within(section("orders")).getByLabelText("Keep"));
    expect(
      within(section("orders")).getByText("Left out: it is not created.")
    ).toBeInTheDocument();
    expect(within(section("orders")).queryByLabelText("Table name")).toBeNull();
    await user.click(within(section("notes")).getByLabelText("Keep"));
    expect(
      screen.getByRole("button", { name: "Create source" })
    ).toBeDisabled();
    await user.click(within(section("notes")).getByLabelText("Keep"));
    await user.click(screen.getByRole("button", { name: "Create source" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].tables).toEqual([{ key: "sheet:Notes" }]);
  });

  it("sends a changed header row, and says untyped names follow it", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    const orders = section("orders");
    expect(within(orders).getByLabelText("Header row")).toHaveValue("Row 1");
    await pickOption(
      user,
      within(orders).getByLabelText("Header row"),
      "No header"
    );
    expect(
      within(orders).getByText(
        /Column names you have not typed come from the new header row/
      )
    ).toBeInTheDocument();
    await user.click(within(section("notes")).getByLabelText("Keep"));
    await user.click(screen.getByRole("button", { name: "Create source" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].tables).toEqual([
      { key: "sheet:Orders", header_row: null },
    ]);
  });

  it("adds a renamed table to an existing source", async () => {
    const user = userEvent.setup();
    renderAt(`/my/data/${FS_ID}/add`);
    expect(
      await screen.findByRole("heading", { name: "Add tables to Q3 sales" })
    ).toBeInTheDocument();
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    // No name or slug for the source: it exists.
    expect(screen.queryByLabelText("Slug")).toBeNull();
    const name = within(section("orders")).getByLabelText("Table name");
    await user.clear(name);
    await user.type(name, "orders_2026");
    await user.click(within(section("notes")).getByLabelText("Keep"));
    await user.click(screen.getByRole("button", { name: "Add tables" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/v1/file-sources/${FS_ID}/tables`, {
        staging_id: STAGING_ID,
        tables: [{ key: "sheet:Orders", name: "orders_2026" }],
      })
    );
    expect(await screen.findByText("Source page")).toBeInTheDocument();
  });

  it("says when to try again while the source is busy", async () => {
    const user = userEvent.setup();
    post.mockImplementation(async (url: string) => {
      if (url === "/v1/file-sources/uploads") return { data: makeStaging() };
      throw {
        status: 503,
        code: "file_source_busy",
        message: "The file source is busy; retry shortly",
        retryAfter: 5,
      };
    });
    renderAt(`/my/data/${FS_ID}/add`);
    await screen.findByRole("heading", { name: "Add tables to Q3 sales" });
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    await user.click(screen.getByRole("button", { name: "Add tables" }));
    expect(
      await screen.findByText("The file source is busy; retry shortly")
    ).toBeInTheDocument();
    expect(screen.getByText("Try again in 5 seconds.")).toBeInTheDocument();
    // Still on the preview, to try again.
    expect(screen.getByRole("button", { name: "Add tables" })).toBeEnabled();
  });
});
