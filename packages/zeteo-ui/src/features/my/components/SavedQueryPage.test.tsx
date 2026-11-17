import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRun } from "@/features/runs/testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { SavedQueryPage } from "./SavedQueryPage";
import { Route, Routes } from "react-router-dom";
import { TEST_ME } from "@/test/authMock";
import {
  OWNER_ID,
  SAVED_ID,
  makeSavedQuery,
  makeShare,
} from "@/features/saved-queries/testFixtures";

const get = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.data.read"] }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, delete: del, patch },
  })
);

const NOTICE =
  "You need expanded permissions to run this saved query. Ask an admin to extend your access.";

/** Owned by the signed-in test user. */
const mine = makeSavedQuery({
  owner: { id: TEST_ME.id, name: "Test Admin" },
  share_count: 1,
});
const run = makeRun({
  saved_query: { id: SAVED_ID, name: "Weekly revenue" },
  query: mine.query,
});

let current = mine;

const renderPage = () =>
  renderWithProviders(
    <Routes>
      <Route
        path="/my/saved-queries/:savedQueryId"
        element={<SavedQueryPage />}
      />
      <Route path="/my" element={<p>My Zeteo page</p>} />
    </Routes>,
    { route: `/my/saved-queries/${SAVED_ID}` }
  );

describe("SavedQueryPage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.data.read"];
    current = mine;
    del.mockReset().mockResolvedValue({});
    patch.mockReset().mockImplementation(async (_url, body) => ({
      data: { ...current, ...body },
    }));
    get.mockReset().mockImplementation(async (url: string) => {
      if (url === `/v1/saved-queries/${SAVED_ID}`) return { data: current };
      if (url === `/v1/saved-queries/${SAVED_ID}/shares`) {
        return { data: { data: [makeShare()] } };
      }
      if (url === "/v1/me/runs") {
        return { data: { data: [run], next_cursor: null } };
      }
      return { data: { data: [], next_cursor: null } };
    });
  });

  it("shows the owner its query, details, shares, runs and actions", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Weekly revenue" })
    ).toBeInTheDocument();
    expect(screen.getByText("Paid orders per week")).toBeInTheDocument();
    expect(screen.getByText("Yours")).toBeInTheDocument();
    expect(screen.getByLabelText("Query JSON")).toHaveTextContent('"orders"');
    expect(
      await screen.findByRole("list", { name: "Shared with" })
    ).toHaveTextContent("Pat Person");
    const runs = await screen.findByRole("list", { name: "Recent runs" });
    expect(within(runs).getAllByRole("listitem")).toHaveLength(1);
    for (const name of ["Edit details", "Share", "Transfer", "Delete"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("button", { name: "Copy to mine" })
    ).not.toBeInTheDocument();
  });

  it("asks for only the caller's runs of this saved query", async () => {
    renderPage();
    await screen.findByRole("list", { name: "Recent runs" });
    expect(get).toHaveBeenCalledWith(
      "/v1/me/runs",
      expect.objectContaining({
        params: expect.objectContaining({ saved_query_id: SAVED_ID }),
      })
    );
  });

  it("shows a recipient without access the notice and nothing of the query", async () => {
    current = makeSavedQuery({
      owner: { id: OWNER_ID, name: "Olive Owner" },
      shared_at: "2026-11-05T10:00:00.000Z",
      accessible: false,
      source: undefined,
      query: undefined,
    });
    renderPage();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText("From Olive Owner")).toBeInTheDocument();
    expect(screen.queryByLabelText("Query JSON")).not.toBeInTheDocument();
    expect(screen.queryByText("sales-db")).not.toBeInTheDocument();
    // No shares for a recipient, and nothing to manage or copy.
    expect(
      screen.queryByRole("heading", { name: "Shared with" })
    ).not.toBeInTheDocument();
    for (const name of ["Share", "Transfer", "Delete", "Copy to mine"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("lets a recipient with access copy it, but not manage it", async () => {
    current = makeSavedQuery({
      owner: { id: OWNER_ID, name: "Olive Owner" },
      shared_at: "2026-11-05T10:00:00.000Z",
    });
    renderPage();
    expect(
      await screen.findByRole("button", { name: "Copy to mine" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit details" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("lets an admin with write manage another's saved query, but not edit it", async () => {
    held.permissions = ["zeteo.data.read", "zeteo.saved_queries.write"];
    current = makeSavedQuery({
      owner: { id: OWNER_ID, name: "Olive Owner" },
      share_count: 0,
    });
    renderPage();
    expect(
      await screen.findByRole("button", { name: "Share" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Transfer" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit details" })
    ).not.toBeInTheDocument();
  });

  it("goes back to My saved queries after deleting", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/saved-queries/${SAVED_ID}`)
    );
    expect(await screen.findByText("My Zeteo page")).toBeInTheDocument();
  });

  it("says so when the saved query cannot be read", async () => {
    get.mockImplementation(async () => {
      throw {
        status: 404,
        code: "not_found",
        message: "Saved query not found",
      };
    });
    renderPage();
    expect(
      await screen.findByText("Saved query not found")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "My saved queries" })
    ).toHaveAttribute("href", "/my?tab=mine");
  });

  describe("available for dashboards", () => {
    const AVAILABLE_NOTE =
      "Anyone can see its name and description and use it in their dashboards. They can only run it if their own access allows.";
    const USED_WARNING =
      "Used by 2 dashboards and 3 saved panels. They'll change too.";

    it("shows the owner the toggle with its note, and turns it on", async () => {
      const user = userEvent.setup();
      current = { ...mine, available_for_dashboards: false };
      renderPage();
      const toggle = await screen.findByRole("checkbox", {
        name: "Available for dashboards",
      });
      expect(toggle).not.toBeChecked();
      expect(screen.getByText(AVAILABLE_NOTE)).toBeInTheDocument();
      await user.click(toggle);
      await waitFor(() =>
        expect(patch).toHaveBeenCalledWith(`/v1/saved-queries/${SAVED_ID}`, {
          available_for_dashboards: true,
        })
      );
    });

    it("warns before turning it off while dashboards use it", async () => {
      const user = userEvent.setup();
      current = {
        ...mine,
        available_for_dashboards: true,
        used_by: { dashboards: 2, saved_panels: 3 },
      };
      renderPage();
      await user.click(
        await screen.findByRole("checkbox", {
          name: "Available for dashboards",
        })
      );
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(USED_WARNING)).toBeInTheDocument();
      expect(patch).not.toHaveBeenCalled();
      await user.click(
        within(dialog).getByRole("button", { name: "Turn off" })
      );
      await waitFor(() =>
        expect(patch).toHaveBeenCalledWith(`/v1/saved-queries/${SAVED_ID}`, {
          available_for_dashboards: false,
        })
      );
    });

    it("warns before editing a saved query something uses, and edits only once confirmed", async () => {
      const user = userEvent.setup();
      current = { ...mine, used_by: { dashboards: 2, saved_panels: 3 } };
      renderPage();
      await user.click(
        await screen.findByRole("button", { name: "Edit details" })
      );
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(USED_WARNING)).toBeInTheDocument();
      expect(within(dialog).queryByLabelText("Name")).not.toBeInTheDocument();
      await user.click(
        within(dialog).getByRole("button", { name: "Continue" })
      );
      expect(await screen.findByLabelText("Name")).toHaveValue(
        "Weekly revenue"
      );
    });

    it("opens the editor straight away when nothing uses it", async () => {
      const user = userEvent.setup();
      current = { ...mine, used_by: { dashboards: 0, saved_panels: 0 } };
      renderPage();
      await user.click(
        await screen.findByRole("button", { name: "Edit details" })
      );
      expect(await screen.findByLabelText("Name")).toBeInTheDocument();
      expect(screen.queryByText(/They'll change too/)).not.toBeInTheDocument();
    });

    it("shows a recipient no toggle", async () => {
      current = makeSavedQuery({
        owner: { id: OWNER_ID, name: "Olive Owner" },
        shared_at: "2026-11-05T10:00:00.000Z",
        available_for_dashboards: true,
      });
      renderPage();
      await screen.findByRole("heading", { name: "Weekly revenue" });
      expect(
        screen.queryByRole("checkbox", { name: "Available for dashboards" })
      ).not.toBeInTheDocument();
    });
  });
});
