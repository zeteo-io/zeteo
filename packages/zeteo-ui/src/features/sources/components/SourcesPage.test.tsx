import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { makeSource, SOURCE_ID } from "../testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { SourcesPage } from "./SourcesPage";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.sources.write"] }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, post },
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

  it("lists name, slug, database, status and last refresh, linking to the source", async () => {
    renderWithProviders(<SourcesPage />);
    const link = await screen.findByRole("link", { name: "Orders DB" });
    expect(link).toHaveAttribute("href", `/sources/${SOURCE_ID}`);
    const row = link.closest("tr")!;
    expect(row).toHaveTextContent("orders");
    expect(row).toHaveTextContent("PostgreSQL");
    expect(row).toHaveTextContent("Active");
    expect(row.querySelector("time")).toHaveAttribute(
      "title",
      expect.stringContaining("2026")
    );
  });

  it("loads archived sources once and shows them when asked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SourcesPage />);
    await screen.findByText("Orders DB");
    expect(get.mock.calls[0][1].params.include_archived).toBe(true);
    expect(screen.queryByText("Legacy DB")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Show archived"));
    const row = (await screen.findByText("Legacy DB")).closest("tr")!;
    expect(row).toHaveTextContent("Archived");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("filters by name or slug as you type", async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({
      data: {
        data: [
          makeSource(),
          makeSource({
            id: "8b2e1c1f-2d8b-4b64-8e1f-7b4c2d3e5f77",
            slug: "billing",
            name: "Billing",
          }),
        ],
        next_cursor: null,
      },
    });
    renderWithProviders(<SourcesPage />);
    await screen.findByText("Billing");
    await user.type(screen.getByLabelText("Search"), "bill");
    await waitFor(() =>
      expect(screen.queryByText("Orders DB")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Billing")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search"));
    await user.type(screen.getByLabelText("Search"), "ORDERS");
    await waitFor(() =>
      expect(screen.queryByText("Billing")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Orders DB")).toBeInTheDocument();
  });

  it("filters by kind, and says when nothing matches", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SourcesPage />);
    await screen.findByText("Orders DB");
    await user.click(screen.getByRole("button", { name: /Kind/ }));
    await user.click(screen.getByRole("checkbox", { name: "Azure SQL" }));
    expect(
      await screen.findByText("No sources match these filters.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Orders DB")).not.toBeInTheDocument();
  });

  it("lists file sources with their owner, linking to their own page, and filters them by kind", async () => {
    const user = userEvent.setup();
    const ownerId = "9c3f2d20-3e9c-4c75-9f20-8c5d3e4f6a88";
    const upload = makeSource({
      id: "6e1f0a0e-1c7a-4a53-9d0e-6a3b1f2c4d99",
      slug: "q3-sales",
      name: "Q3 sales",
      type: "upload",
      settings: null,
      schemas: [],
      owner_id: ownerId,
      last_refreshed_at: null,
    });
    get.mockResolvedValue({
      data: { data: [makeSource(), upload], next_cursor: null },
    });
    post.mockResolvedValue({
      data: {
        data: [
          {
            type: "user",
            id: ownerId,
            name: "Olive Owner",
            email: "olive@example.com",
            status: "active",
          },
        ],
      },
    });
    renderWithProviders(<SourcesPage />);
    const link = await screen.findByRole("link", { name: "Q3 sales" });
    expect(link).toHaveAttribute("href", `/my/data/${upload.id}`);
    const row = link.closest("tr")!;
    expect(row).toHaveTextContent("Upload");
    await waitFor(() => expect(row).toHaveTextContent("Olive Owner"));
    // A database source has no owner.
    expect(
      screen.getByRole("link", { name: "Orders DB" }).closest("tr")
    ).toHaveTextContent("—");

    await user.click(screen.getByRole("button", { name: /Kind/ }));
    await user.click(screen.getByRole("checkbox", { name: "Upload" }));
    await waitFor(() =>
      expect(screen.queryByText("Orders DB")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Q3 sales")).toBeInTheDocument();
  });

  it("says there are no sources yet when there are none", async () => {
    get.mockResolvedValue({ data: { data: [archived], next_cursor: null } });
    renderWithProviders(<SourcesPage />);
    expect(await screen.findByText(/No sources yet/)).toBeInTheDocument();
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
