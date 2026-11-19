import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AddDataPage, AddTablesPage, ReuploadPage } from "./AddDataPage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { optionTexts, pickOption } from "@/test/searchSelect";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import {
  FS_ID,
  STAGING_ID,
  TABLE_ID,
  makePreviewTable,
  GOOGLE_CONNECTION,
  ROBOT_EMAIL,
  SHEET_ID,
  makeSheetStaging,
  makeSheetsSource,
  makeStaging,
  makeUploadSource,
  uploadGet,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read", "zeteo.uploads.write"],
    api: { get, post, put, delete: del },
  })
);

// A new discard function on every render, as when the API client is rebuilt
// after a token refresh: the page must still discard only when it is left.
vi.mock("../api/uploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/uploads")>()),
  useDiscardStaging: () => (stagingId: string) => {
    void del(`/v1/uploads/${stagingId}`);
  },
}));

const renderAt = (route: string) =>
  renderWithProviders(
    <Routes>
      <Route path="/my/data/new" element={<AddDataPage />} />
      <Route path="/sources/:sourceId/add" element={<AddTablesPage />} />
      <Route
        path="/sources/:sourceId/tables/:tableId/reupload"
        element={<ReuploadPage />}
      />
      <Route path="/sources/:sourceId" element={<p>Source page</p>} />
      <Route path="/my" element={<p>My Zeteo</p>} />
    </Routes>,
    { route }
  );

type User = ReturnType<typeof userEvent.setup>;

const upload = async (user: User, name = "Q3 sales.xlsx") => {
  // Add data opens with a choice; Add tables and Re-upload go straight to a file.
  const choice = screen.queryByRole("button", { name: /Upload a file/ });
  if (choice) await user.click(choice);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await user.upload(input, new File(["x"], name));
};

/** The section of one staged table, by its heading. */
const section = (name: string) =>
  screen
    .getByRole("heading", { name })
    .closest(".k-bordered-section, section") as HTMLElement;

/** Opens a staged table's tab, when the file has several, and returns its section. */
const openSection = async (user: User, name: string) => {
  const tab = screen.queryByRole("tab", { name: new RegExp(`^${name}`) });
  if (tab) await user.click(tab);
  return section(name);
};

describe("AddDataPage", () => {
  beforeEach(() => {
    get.mockReset().mockImplementation(uploadGet());
    post
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === "/v1/uploads"
          ? { data: makeStaging() }
          : { data: makeUploadSource() }
      );
    put.mockReset().mockResolvedValue({ data: makeUploadSource() });
    del.mockReset().mockResolvedValue({});
  });

  it("discards the staging when the person cancels after uploading", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    expect(del).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("My Zeteo")).toBeInTheDocument();
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/uploads/${STAGING_ID}`)
    );
  });

  it("discards nothing when the person cancels before uploading", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("My Zeteo")).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });

  it("discards the staging when the person leaves Add tables without adding", async () => {
    const user = userEvent.setup();
    const { unmount } = renderAt(`/sources/${FS_ID}/add`);
    await screen.findByRole("heading", { name: "Add tables to Q3 sales" });
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    unmount();
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/uploads/${STAGING_ID}`)
    );
  });

  it("does not discard a staging that created the source", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    await user.click(screen.getByRole("button", { name: "Create source" }));
    expect(await screen.findByText("Source page")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(del).not.toHaveBeenCalled();
  });

  it("keeps the staging while the person edits the preview, whatever re-renders", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    await user.type(screen.getAllByLabelText(/^Name/)[0]!, " edited");
    await new Promise((r) => setTimeout(r, 20));
    expect(del).not.toHaveBeenCalled();
  });

  it("says a preview that is gone has expired, above the form, and starts again", async () => {
    const user = userEvent.setup();
    post.mockImplementation(async (url: string) => {
      if (url === "/v1/uploads") return { data: makeStaging() };
      throw {
        status: 404,
        code: "staging_not_found",
        message: "Upload not found or expired",
      };
    });
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    await user.click(screen.getByRole("button", { name: "Create source" }));

    const notice = await screen.findByText(/no longer available/);
    const about = screen.getByRole("heading", { name: "About" });
    expect(
      notice.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByText("Upload not found or expired")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Start again" }));
    // Back to the file picker, the preview gone.
    await waitFor(() =>
      expect(document.querySelector('input[type="file"]')).not.toBeNull()
    );
    expect(screen.queryByRole("heading", { name: "orders" })).toBeNull();
    expect(del).not.toHaveBeenCalled();
  });

  it("uploads the file as multipart and previews each table with its columns, types, samples and warnings", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);

    expect(
      await screen.findByRole("heading", { name: "orders" })
    ).toBeInTheDocument();
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/v1/uploads");
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toBeInstanceOf(File);

    // The name comes from the file's.
    expect(screen.getByRole("textbox", { name: /^Name\W*$/ })).toHaveValue(
      "Q3 sales"
    );
    expect(screen.getByText("North, South")).toBeInTheDocument();
    expect(screen.getByText("ZIP")).toBeInTheDocument();
    expect(screen.getByLabelText("Type of column 2")).toHaveValue("Number");

    // One tab per table; the second shows its own columns and warnings.
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "orders",
      "notes",
    ]);
    expect(screen.getByRole("tab", { name: "orders" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.queryByRole("heading", { name: "notes" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "notes" }));
    expect(screen.getByRole("heading", { name: "notes" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "orders" })).toBeNull();
    expect(
      screen.getByText('Column "note" has no values in its first rows.')
    ).toBeInTheDocument();
  });

  it("fills the slug from the name until the slug is edited", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });

    const name = screen.getByRole("textbox", { name: /^Name\W*$/ });
    const slug = screen.getByRole("textbox", { name: "Slug" });
    expect(slug).toHaveValue("q3-sales");

    await user.clear(name);
    await user.type(name, "Regional sales");
    expect(slug).toHaveValue("regional-sales");

    await user.clear(slug);
    await user.type(slug, "sales");
    await user.type(name, " 2026");
    expect(slug).toHaveValue("sales");
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
    await user.click(
      within(await openSection(user, "notes")).getByRole("checkbox")
    );
    await user.click(screen.getByRole("button", { name: "Create source" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]).toEqual([
      "/v1/sources",
      {
        type: "upload",
        staging_id: STAGING_ID,
        name: "Q3 sales",
        slug: "q3-sales",
        tables: [
          { key: "sheet:Orders", columns: [{ index: 1, type: "text" }] },
        ],
      },
    ]);
    expect(await screen.findByText("Source page")).toBeInTheDocument();
  });

  it("sends a typed description with the new source", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    await user.type(
      screen.getByRole("textbox", { name: "Description" }),
      "  Quarterly sales.  "
    );
    await user.click(screen.getByRole("button", { name: "Create source" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toMatchObject({
      name: "Q3 sales",
      description: "Quarterly sales.",
    });
  });

  it("sends no description when it is left empty", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    await user.type(screen.getByRole("textbox", { name: "Description" }), "  ");
    await user.click(screen.getByRole("button", { name: "Create source" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).not.toHaveProperty("description");
  });

  it("refuses a description over 500 characters and sends nothing", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "x".repeat(501) },
    });
    await user.click(screen.getByRole("button", { name: "Create source" }));
    expect(
      await screen.findByText(/at most 500 characters/)
    ).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
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
      if (url === "/v1/uploads") return { data: makeStaging() };
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
    renderAt(`/sources/${FS_ID}/tables/${TABLE_ID}/reupload`);
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
        `/v1/sources/${FS_ID}/tables/${TABLE_ID}`,
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
    await user.click(
      within(await openSection(user, "orders")).getByLabelText("Keep")
    );
    expect(
      within(await openSection(user, "orders")).getByText(
        "Left out: it is not created."
      )
    ).toBeInTheDocument();
    expect(
      within(await openSection(user, "orders")).queryByLabelText("Table name")
    ).toBeNull();
    await user.click(
      within(await openSection(user, "notes")).getByLabelText("Keep")
    );
    expect(
      screen.getByRole("button", { name: "Create source" })
    ).toBeDisabled();
    await user.click(
      within(await openSection(user, "notes")).getByLabelText("Keep")
    );
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
    await user.click(
      within(await openSection(user, "notes")).getByLabelText("Keep")
    );
    await user.click(screen.getByRole("button", { name: "Create source" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].tables).toEqual([
      { key: "sheet:Orders", header_row: null },
    ]);
  });

  it("adds a renamed table to an existing source", async () => {
    const user = userEvent.setup();
    renderAt(`/sources/${FS_ID}/add`);
    expect(
      await screen.findByRole("heading", { name: "Add tables to Q3 sales" })
    ).toBeInTheDocument();
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    // No name or slug for the source: it exists.
    expect(screen.queryByLabelText("Slug")).toBeNull();
    const name = within(await openSection(user, "orders")).getByLabelText(
      "Table name"
    );
    await user.clear(name);
    await user.type(name, "orders_2026");
    await user.click(
      within(await openSection(user, "notes")).getByLabelText("Keep")
    );
    await user.click(screen.getByRole("button", { name: "Add tables" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/v1/sources/${FS_ID}/tables`, {
        staging_id: STAGING_ID,
        tables: [{ key: "sheet:Orders", name: "orders_2026" }],
      })
    );
    expect(await screen.findByText("Source page")).toBeInTheDocument();
  });

  it("says when to try again while the source is busy", async () => {
    const user = userEvent.setup();
    post.mockImplementation(async (url: string) => {
      if (url === "/v1/uploads") return { data: makeStaging() };
      throw {
        status: 503,
        code: "upload_source_busy",
        message: "The upload source is busy; retry shortly",
        retryAfter: 5,
      };
    });
    renderAt(`/sources/${FS_ID}/add`);
    await screen.findByRole("heading", { name: "Add tables to Q3 sales" });
    await upload(user);
    await screen.findByRole("heading", { name: "orders" });
    await user.click(screen.getByRole("button", { name: "Add tables" }));
    expect(
      await screen.findByText("The upload source is busy; retry shortly")
    ).toBeInTheDocument();
    expect(screen.getByText("Try again in 5 seconds.")).toBeInTheDocument();
    // Still on the preview, to try again.
    expect(screen.getByRole("button", { name: "Add tables" })).toBeEnabled();
  });
});

describe("AddDataPage: Google Sheet", () => {
  const LINK = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  beforeEach(() => {
    get
      .mockReset()
      .mockImplementation(
        uploadGet(makeSheetsSource, undefined, (url) =>
          url === "/v1/connections/google"
            ? { data: GOOGLE_CONNECTION }
            : undefined
        )
      );
    post
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === "/v1/uploads/links"
          ? { data: makeSheetStaging() }
          : { data: makeSheetsSource() }
      );
    del.mockReset().mockResolvedValue({});
  });

  it("offers a file or a Google Sheet first", async () => {
    renderAt("/my/data/new");
    expect(
      await screen.findByRole("button", { name: /Upload a file/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Google Sheet/ })
    ).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("shows the share email, posts the link, then creates the source with its interval", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await user.click(
      await screen.findByRole("button", { name: /Google Sheet/ })
    );
    expect(await screen.findByText(ROBOT_EMAIL)).toBeInTheDocument();
    expect(screen.getByText(/as a Viewer/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Link to the Google Sheet/), LINK);
    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(post).toHaveBeenCalledWith("/v1/uploads/links", { url: LINK });
    expect(
      await screen.findByRole("heading", { name: "orders" })
    ).toBeInTheDocument();
    // The name comes from the spreadsheet's title; Sync every defaults to 60.
    expect(screen.getByRole("textbox", { name: /^Name\W*$/ })).toHaveValue(
      "Budget 2027"
    );
    const every = screen.getByLabelText(/Sync every/);
    expect(every).toHaveValue(60);
    await user.clear(every);
    await user.type(every, "30");
    await user.click(screen.getByRole("button", { name: "Create source" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/v1/sources",
        expect.objectContaining({
          type: "upload",
          staging_id: STAGING_ID,
          name: "Budget 2027",
          sync_interval_minutes: 30,
        })
      )
    );
    expect(await screen.findByText("Source page")).toBeInTheDocument();
  });

  it("blocks an interval outside 15 to 1440", async () => {
    const user = userEvent.setup();
    renderAt("/my/data/new");
    await user.click(
      await screen.findByRole("button", { name: /Google Sheet/ })
    );
    await screen.findByText(ROBOT_EMAIL);
    await user.type(screen.getByLabelText(/Link to the Google Sheet/), LINK);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const every = await screen.findByLabelText(/Sync every/);
    await user.clear(every);
    await user.type(every, "2000");
    expect(
      screen.getByRole("button", { name: "Create source" })
    ).toBeDisabled();
    expect(
      screen.getByText("Sync every is 15 to 1440 minutes.")
    ).toBeInTheDocument();
  });

  it("offers Add tables a file or a Google Sheet, and posts the source with any link", async () => {
    const user = userEvent.setup();
    renderAt(`/sources/${FS_ID}/add`);
    expect(
      await screen.findByRole("heading", { name: "Add tables to Budget sheet" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Upload a file/ })
    ).toBeInTheDocument();
    // Nothing is staged on its own.
    expect(post).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Google Sheet/ }));
    await user.type(screen.getByLabelText(/Link to the Google Sheet/), LINK);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/v1/uploads/links", {
        source_id: FS_ID,
        url: LINK,
      })
    );
    expect(
      await screen.findByRole("heading", { name: "orders" })
    ).toBeInTheDocument();
  });
});
