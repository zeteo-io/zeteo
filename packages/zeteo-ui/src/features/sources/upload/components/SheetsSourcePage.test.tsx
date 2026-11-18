import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { SourceTestRoutes } from "../testRoutes";
import {
  FS_ID,
  SHEET_ID,
  TABLE_ID,
  makeSheetsSource,
  makeUploadSource,
  uploadGet,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read", "zeteo.uploads.write"],
    api: { get, post, patch, delete: del },
  })
);

const renderAt = (route = `/sources/${FS_ID}`) =>
  renderWithProviders(<SourceTestRoutes />, { route });

describe("a Google Sheets source's page", () => {
  beforeEach(() => {
    get.mockReset().mockImplementation(uploadGet(() => makeSheetsSource()));
    post.mockReset();
    patch.mockReset().mockResolvedValue({ data: makeSheetsSource() });
    del.mockReset().mockResolvedValue({});
  });

  it("has the upload shell's actions", async () => {
    renderAt();
    await screen.findByRole("heading", { name: "Budget sheet" });
    expect(screen.getByText("Google Sheets")).toBeInTheDocument();
    for (const name of ["Add tables", "Transfer", "Edit", "Delete"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("has no Re-upload on its tables", async () => {
    renderAt(`/sources/${FS_ID}/tables/${TABLE_ID}`);
    await screen.findByRole("heading", { name: "orders" });
    expect(screen.queryByRole("button", { name: "Re-upload" })).toBeNull();
  });

  it("shows the Google Sheet block with the link, interval and last synced", async () => {
    renderAt();
    const block = (
      await screen.findByRole("heading", { name: "Google Sheet" })
    ).closest(".k-bordered-section") as HTMLElement;
    expect(
      within(block).getByRole("link", { name: "Open in Google Sheets" })
    ).toHaveAttribute(
      "href",
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}`
    );
    expect(within(block).getByText("Every hour")).toBeInTheDocument();
    expect(within(block).getByText("Last synced")).toBeInTheDocument();
    expect(within(block).queryByText("Last error")).toBeNull();
  });

  it("shows the last error to the owner", async () => {
    get.mockImplementation(
      uploadGet(() =>
        makeSheetsSource({
          sync: {
            interval_minutes: 60,
            last_attempt_at: "2026-11-18T09:00:00.000Z",
            last_error: {
              code: "sheet_not_accessible",
              message: "Share the sheet with robot@x",
            },
            stale: false,
          },
        })
      )
    );
    renderAt();
    expect(
      await screen.findByText("Share the sheet with robot@x")
    ).toBeInTheDocument();
    expect(screen.getByText("Sync failing")).toBeInTheDocument();
  });

  it("opens Add tables", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Add tables" }));
    await waitFor(() =>
      expect(screen.getByText("Add tables page")).toBeInTheDocument()
    );
  });

  it("shows Sync every in Edit, and sends a changed interval", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const field = await screen.findByLabelText(/Sync every/);
    expect(field).toHaveValue(60);
    await user.clear(field);
    await user.type(field, "30");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/v1/sources/${FS_ID}`, {
        sync_interval_minutes: 30,
      })
    );
  });

  it("rejects an interval outside 15 to 1440 in the form", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const field = await screen.findByLabelText(/Sync every/);
    await user.clear(field);
    await user.type(field, "5");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("Sync every is 15 to 1440 minutes.")
    ).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("shows no Sync every in the Edit dialog of a file upload", async () => {
    const user = userEvent.setup();
    get.mockImplementation(uploadGet(() => makeUploadSource()));
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Save changes" });
    expect(screen.queryByLabelText(/Sync every/)).toBeNull();
  });
});
