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

  it("says where each table came from", async () => {
    serve(makeSheetsSource(), [
      file(1),
      sheet(2, "Budget 2027", "Orders", "SPREAD1"),
      merged(3),
    ]);
    renderAt("/tables");
    expect(await screen.findByText("Origin")).toBeInTheDocument();
    expect(screen.getByText("data 1.csv")).toBeInTheDocument();
    expect(screen.getByText("Budget 2027 · Orders")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open .* in Google Sheets/ })
    ).toHaveAttribute("href", "https://docs.google.com/spreadsheets/d/SPREAD1");
    expect(screen.getByText("Merged · 3 tables")).toBeInTheDocument();
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
    expect(badge.closest("[title]")).toHaveAttribute("title", "Share it again");
    expect(screen.getAllByText("Sync failing")).toHaveLength(1);
  });

  it("shows no badge when the server sends no sync_error (a reader who is neither owner nor admin)", async () => {
    serve(makeSheetsSource(), [sheet(1, "Budget", "Orders", "S1")]);
    renderAt("/tables");
    await screen.findByText("Budget · Orders");
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

describe("a source's overview with Google Sheets", () => {
  beforeEach(() => get.mockReset());

  it("groups the tables by spreadsheet, with the interval and last synced", async () => {
    serve(
      makeSheetsSource({
        sync: {
          interval_minutes: 60,
          last_attempt_at: "2026-11-18T09:00:00.000Z",
          failing: [
            { table_id: T(2), name: "sheet_2", code: "x", message: "Broke" },
          ],
          stale: false,
        },
      }),
      [
        sheet(1, "Budget 2027", "Orders", "S1"),
        sheet(2, "Budget 2027", "Notes", "S1", {
          sync_error: { code: "x", message: "Broke" },
        }),
        sheet(3, "Forecast", "Q1", "S2"),
        file(4),
      ]
    );
    renderAt();
    const block = (
      await screen.findByRole("heading", { name: "Google Sheets" })
    ).closest(".k-bordered-section") as HTMLElement;
    const budget = (await within(block).findByText("Budget 2027")).closest(
      "li"
    ) as HTMLElement;
    expect(within(budget).getByText(/2 tabs/)).toBeInTheDocument();
    expect(within(budget).getByText(/1 failing/)).toBeInTheDocument();
    expect(
      within(budget).getByRole("link", { name: /Open .* in Google Sheets/ })
    ).toHaveAttribute("href", "https://docs.google.com/spreadsheets/d/S1");
    const forecast = within(block).getByText("Forecast").closest("li")!;
    expect(
      within(forecast as HTMLElement).getByText(/1 tab\b/)
    ).toBeInTheDocument();
    expect(within(block).getByText("Every hour")).toBeInTheDocument();
    expect(within(block).getByText("Last synced")).toBeInTheDocument();
  });

  it("has no Google Sheets section for a file-only source", async () => {
    serve(makeUploadSource(), [file(1)]);
    renderAt();
    await screen.findByRole("heading", { name: "Data" });
    expect(screen.queryByRole("heading", { name: "Google Sheets" })).toBeNull();
  });

  it("shows Sync every in Edit for a source with Sheets tables only", async () => {
    const user = userEvent.setup();
    serve(makeSheetsSource(), [sheetsOrders()]);
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText(/Sync every/)).toHaveValue(60);
  });
});
