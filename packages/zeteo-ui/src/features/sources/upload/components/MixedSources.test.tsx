import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { SourceTestRoutes } from "../testRoutes";
import {
  FS_ID,
  makeSheetsSource,
  makeUploadSource,
  ordersTable,
  sheetOrigin,
  sheetsOrders,
  uploadGet,
  type UploadTable,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read", "zeteo.uploads.write"],
    api: { get, post },
  })
);

const T = (n: number) => `b${n}000000-1c7a-4a53-9d0e-6a3b1f2c4d0${n}`;
const file = (n: number, over: Partial<UploadTable> = {}): UploadTable => ({
  ...ordersTable(),
  id: T(n),
  name: `file_${n}`,
  origin: { kind: "file", filename: `data ${n}.csv` },
  ...over,
});
const sheet = (
  n: number,
  title: string,
  tab: string,
  id: string,
  over: Partial<UploadTable> = {}
): UploadTable => ({
  ...ordersTable(),
  id: T(n),
  name: `sheet_${n}`,
  origin: sheetOrigin(id, title, tab),
  ...over,
});
const merged = (n: number): UploadTable => ({
  ...ordersTable(),
  id: T(n),
  name: `merged_${n}`,
  origin: { kind: "merged", members: 3 },
});

const serve = (source = makeSheetsSource(), tables: UploadTable[] = []) =>
  get.mockImplementation(
    uploadGet(
      () => source,
      () => tables
    )
  );
const renderAt = (path = "") =>
  renderWithProviders(<SourceTestRoutes />, {
    route: `/sources/${FS_ID}${path}`,
  });

describe("the Tables tab's Origin column", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  it("shows a Sheets table as a Google Sheet link, with the spreadsheet in its tooltip and the tab below", async () => {
    const user = userEvent.setup();
    serve(makeSheetsSource(), [sheet(2, "Budget 2027", "Orders", "SPREAD1")]);
    renderAt("/tables");
    const link = await screen.findByRole("link", { name: "Google Sheet" });
    expect(link).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/SPREAD1"
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Orders")).toBeInTheDocument();
    // The spreadsheet's name shows at once on hover (kosmeo's Tooltip, not a slow native title).
    expect(screen.queryByText("Budget 2027")).toBeNull();
    await user.hover(link);
    expect(await screen.findByText("Budget 2027")).toBeInTheDocument();
  });

  it("shows a file table as File Upload with the file name in its tooltip, and an xlsx's sheet below", async () => {
    const user = userEvent.setup();
    serve(makeSheetsSource(), [
      file(1),
      file(2, {
        origin: { kind: "file", filename: "book.xlsx", tab_title: "Costs" },
      }),
    ]);
    renderAt("/tables");
    await screen.findAllByText("File Upload");
    const cells = screen.getAllByText("File Upload");
    expect(cells).toHaveLength(2);
    expect(screen.getByText("Costs")).toBeInTheDocument();
    await user.hover(cells[0]!);
    expect(await screen.findByText("data 1.csv")).toBeInTheDocument();
    await user.unhover(cells[0]!);
    await user.hover(cells[1]!);
    expect(await screen.findByText("book.xlsx")).toBeInTheDocument();
    // A CSV has no sheet line under it.
    expect(screen.getAllByText("Costs")).toHaveLength(1);
  });

  it("leaves a merged table as it was", async () => {
    serve(makeSheetsSource(), [merged(3)]);
    renderAt("/tables");
    expect(await screen.findByText("Merged · 3 tables")).toBeInTheDocument();
  });

  it("shows no second line for a Sheets table with no tab title", async () => {
    const old = sheet(1, "Budget 2027", "Orders", "S1");
    if (old.origin?.kind === "google-sheets") delete old.origin.tab_title;
    serve(makeSheetsSource(), [old]);
    renderAt("/tables");
    const link = await screen.findByRole("link", { name: "Google Sheet" });
    expect(link.parentElement!.children).toHaveLength(1);
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("flags a Sheets table whose sync is failing, with the message", async () => {
    serve(makeSheetsSource(), [
      sheet(1, "Budget", "Orders", "S1", {
        sync_error: { code: "sheet_not_accessible", message: "Share it again" },
      }),
      sheet(2, "Budget", "Notes", "S1"),
    ]);
    renderAt("/tables");
    const badge = await screen.findByText("Sync failing");
    await userEvent.setup().hover(badge);
    expect(await screen.findByText("Share it again")).toBeInTheDocument();
    expect(screen.getAllByText("Sync failing")).toHaveLength(1);
  });

  it("shows no badge when the server sends no sync_error (a reader who is neither owner nor admin)", async () => {
    serve(makeSheetsSource(), [sheet(1, "Budget", "Orders", "S1")]);
    renderAt("/tables");
    await screen.findByRole("link", { name: "Google Sheet" });
    expect(screen.queryByText("Sync failing")).toBeNull();
  });
});

describe("Add merged table", () => {
  beforeEach(() => get.mockReset());

  it("goes to the editor when the source has two non-merged tables", async () => {
    const user = userEvent.setup();
    serve(makeUploadSource(), [file(1), file(2)]);
    renderAt();
    await user.click(
      await screen.findByRole("button", { name: "Add merged table" })
    );
    expect(
      await screen.findByText("Add merged table page")
    ).toBeInTheDocument();
  });

  it("is hidden with one non-merged table, merged and missing ones not counting", async () => {
    serve(makeUploadSource(), [file(1), merged(2), file(3, { missing: true })]);
    renderAt();
    await screen.findByRole("button", { name: "Add tables" });
    expect(
      screen.queryByRole("button", { name: "Add merged table" })
    ).toBeNull();
  });

  it("is hidden on a deleted source", async () => {
    serve(makeUploadSource({ archived_at: "2026-11-17T00:00:00.000Z" }), [
      file(1),
      file(2),
    ]);
    renderAt();
    await screen.findByRole("heading", { name: "Q3 sales" });
    expect(
      screen.queryByRole("button", { name: "Add merged table" })
    ).toBeNull();
  });
});

describe("a source's Upload Sources and overview", () => {
  beforeEach(() => get.mockReset());

  it("lists each file and spreadsheet on Upload Sources, with its tables", async () => {
    serve(makeSheetsSource(), [
      sheet(1, "Budget 2027", "Orders", "S1"),
      sheet(2, "Budget 2027", "Notes", "S1", {
        sync_error: { code: "x", message: "Broke" },
      }),
      sheet(3, "Forecast", "Q1", "S2"),
      file(4),
      file(5, {
        origin: { kind: "file", filename: "plan.xlsx", tab_title: "Q2" },
      }),
      merged(6),
    ]);
    renderAt("/uploads");
    const budget = (
      await screen.findByRole("link", { name: "Budget 2027" })
    ).closest("tr") as HTMLElement;
    expect(
      within(budget).getByRole("link", { name: "Budget 2027" })
    ).toHaveAttribute("href", "https://docs.google.com/spreadsheets/d/S1");
    expect(within(budget).getByText("Google Sheet")).toBeInTheDocument();
    expect(
      within(budget).getByRole("link", { name: "sheet_1" })
    ).toBeInTheDocument();
    expect(
      within(budget).getByRole("link", { name: "sheet_2" })
    ).toBeInTheDocument();
    expect(within(budget).getByText("Sync failing")).toBeInTheDocument();
    const forecast = screen
      .getByRole("link", { name: "Forecast" })
      .closest("tr") as HTMLElement;
    expect(within(forecast).getByText("Syncing")).toBeInTheDocument();
    const csv = screen.getByText("data 4.csv").closest("tr") as HTMLElement;
    expect(within(csv).getByText("CSV")).toBeInTheDocument();
    const xlsx = screen.getByText("plan.xlsx").closest("tr") as HTMLElement;
    expect(within(xlsx).getByText("Excel")).toBeInTheDocument();
    expect(within(xlsx).getByText(/Q2/)).toBeInTheDocument();
    expect(screen.queryByText("merged_6")).toBeNull();
  });

  it("shows the interval and last synced on the overview, without a Google Sheets card", async () => {
    serve(makeSheetsSource(), [sheet(1, "Budget 2027", "Orders", "S1")]);
    renderAt();
    await screen.findByRole("heading", { name: "Data" });
    expect(screen.getByText("Every hour")).toBeInTheDocument();
    expect(screen.getByText("Last synced")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Google Sheets" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Upload Sources" })
    ).toBeInTheDocument();
  });

  it("has no sync facts for a file-only source", async () => {
    serve(makeUploadSource(), [file(1)]);
    renderAt();
    await screen.findByRole("heading", { name: "Data" });
    expect(screen.queryByText("Last synced")).toBeNull();
  });

  it("shows Sync every in Edit for a source with Sheets tables only", async () => {
    const user = userEvent.setup();
    serve(makeSheetsSource(), [sheetsOrders()]);
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText(/Sync every/)).toHaveValue(60);
  });
});
