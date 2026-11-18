import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { SourceTestRoutes } from "../testRoutes";
import {
  FS_ID,
  makeSheetsSource,
  makeUploadSource,
  uploadGet,
} from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({
  permissions: ["zeteo.data.read", "zeteo.uploads.write"],
  me: {} as Record<string, unknown>,
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, post },
  })
);

const SYNCED = {
  data: {
    synced_at: "2026-11-18T10:00:00.000Z",
    tables: [{ id: "t1", name: "orders", row_count: 12, missing: false }],
  },
};

const renderAt = () =>
  renderWithProviders(<SourceTestRoutes />, { route: `/sources/${FS_ID}` });

describe("Sync now", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.data.read", "zeteo.uploads.write"];
    get.mockReset().mockImplementation(uploadGet(() => makeSheetsSource()));
    post
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === "/v1/principals/lookup" ? { data: { data: [] } } : SYNCED
      );
  });

  it("is shown to a Sheets source's owner", async () => {
    renderAt();
    expect(
      await screen.findByRole("button", { name: "Sync now" })
    ).toBeInTheDocument();
  });

  it("is shown to a sources admin who is not the owner", async () => {
    held.permissions = ["zeteo.data.read", "zeteo.sources.write"];
    get.mockImplementation(
      uploadGet(() => makeSheetsSource({ owner_id: "someone-else" }), undefined)
    );
    renderAt();
    expect(
      await screen.findByRole("button", { name: "Sync now" })
    ).toBeInTheDocument();
  });

  it("is not shown for a file upload", async () => {
    get.mockImplementation(uploadGet(() => makeUploadSource()));
    renderAt();
    await screen.findByRole("button", { name: "Add tables" });
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  });

  it("is not shown on an archived source", async () => {
    get.mockImplementation(
      uploadGet(() =>
        makeSheetsSource({ archived_at: "2026-11-17T00:00:00.000Z" })
      )
    );
    renderAt();
    await screen.findByRole("heading", { name: "Budget sheet" });
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  });

  it("calls the refresh endpoint and confirms", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/v1/sources/${FS_ID}/refresh`)
    );
    expect(await screen.findByText(/Synced 1 table/)).toBeInTheDocument();
  });

  it("says so on sync_too_soon", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      status: 429,
      code: "sync_too_soon",
      message: "Wait.",
    });
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByText("Synced less than a minute ago")
    ).toBeInTheDocument();
  });

  it("shows the server's message on sheet_not_accessible", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      status: 422,
      code: "sheet_not_accessible",
      message: "Share the sheet with robot@x",
    });
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByText("Share the sheet with robot@x")
    ).toBeInTheDocument();
  });

  it("is busy while syncing and cannot be clicked twice", async () => {
    const user = userEvent.setup();
    let finish: (v: unknown) => void = () => undefined;
    post.mockReturnValue(new Promise((r) => (finish = r)));
    renderAt();
    const button = await screen.findByRole("button", { name: "Sync now" });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(post).toHaveBeenCalledTimes(1);
    finish(SYNCED);
    await waitFor(() => expect(button).toBeEnabled());
  });
});
