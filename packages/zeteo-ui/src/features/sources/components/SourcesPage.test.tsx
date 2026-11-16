import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { makeSource, SOURCE_ID } from "../testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { SourcesPage } from "./SourcesPage";

const get = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.sources.write"] }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get },
  })
);

const archived = makeSource({
  id: "7a1d0b0e-1c7a-4a53-9d0e-6a3b1f2c4d66",
  slug: "legacy",
  name: "Legacy DB",
  archived_at: "2026-11-02T10:00:00.000Z",
});

describe("SourcesPage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.sources.write"];
    get
      .mockReset()
      .mockImplementation(
        async (_url: string, cfg: { params: Record<string, unknown> }) => ({
          data: {
            data: cfg.params.include_archived
              ? [makeSource(), archived]
              : [makeSource()],
            next_cursor: null,
          },
        })
      );
  });

  it("lists name, slug, type, status and last refresh, linking to the source", async () => {
    renderWithProviders(<SourcesPage />);
    const link = await screen.findByRole("link", { name: "Orders DB" });
    expect(link).toHaveAttribute("href", `/sources/${SOURCE_ID}`);
    const row = link.closest("tr")!;
    expect(row).toHaveTextContent("orders");
    expect(row).toHaveTextContent("postgres");
    expect(row).toHaveTextContent("active");
    expect(row).toHaveTextContent("2026");
  });

  it("refetches with include_archived=true when archived sources are shown", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SourcesPage />);
    await screen.findByText("Orders DB");
    expect(get.mock.calls[0][1].params.include_archived).toBeUndefined();
    expect(screen.queryByText("Legacy DB")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Show archived"));
    const row = (await screen.findByText("Legacy DB")).closest("tr")!;
    expect(row).toHaveTextContent("Archived");
    expect(
      get.mock.calls.some(([, cfg]) => cfg.params.include_archived === true)
    ).toBe(true);
  });

  it("offers New source to someone who can write", async () => {
    renderWithProviders(<SourcesPage />);
    expect(
      await screen.findByRole("button", { name: "New source" })
    ).toBeInTheDocument();
  });

  it("has no New source control without zeteo.sources.write", async () => {
    held.permissions = ["zeteo.sources.read"];
    renderWithProviders(<SourcesPage />);
    await screen.findByText("Orders DB");
    expect(
      screen.queryByRole("button", { name: "New source" })
    ).not.toBeInTheDocument();
  });

  it("shows the API's error without losing the page", async () => {
    get.mockRejectedValue({
      status: 503,
      code: "unavailable",
      message: "Tereo is down",
    });
    renderWithProviders(<SourcesPage />);
    await waitFor(() =>
      expect(screen.getByText("Tereo is down")).toBeInTheDocument()
    );
    expect(
      screen.getByRole("heading", { name: "Sources" })
    ).toBeInTheDocument();
  });
});
