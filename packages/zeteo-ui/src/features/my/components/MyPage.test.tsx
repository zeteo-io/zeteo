import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRun } from "@/features/runs/testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { MyPage } from "./MyPage";
import { App } from "@/app";
import {
  OWNER_ID,
  SAVED_ID,
  makeSavedQuery,
} from "@/features/saved-queries/testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read"],
    api: { get, post, patch, delete: del },
  })
);
vi.mock("@/lib/config", async () =>
  (await import("@/test/uiConfig")).mockConfig()
);

const NOTICE =
  "You need expanded permissions to run this saved query. Ask an admin to extend your access.";

const mine = makeSavedQuery();
const sharedOk = makeSavedQuery({
  id: "c2222222-1c7a-4a53-9d0e-6a3b1f2c4d02",
  name: "Team signups",
  description: "Signups by day",
  owner: { id: OWNER_ID, name: "Sam Sharer" },
  shared_at: "2026-11-05T10:00:00.000Z",
});
const sharedHidden = makeSavedQuery({
  id: "c3333333-1c7a-4a53-9d0e-6a3b1f2c4d03",
  name: "Finance close",
  description: "Month-end numbers",
  owner: { id: OWNER_ID, name: "Fiona Finance" },
  shared_at: "2026-11-06T10:00:00.000Z",
  accessible: false,
  source: undefined,
  query: undefined,
});

const catalog = {
  sources: [
    {
      slug: "sales-db",
      name: "Sales database",
      type: "postgres",
      tables: [
        { name: "orders", kind: "table", columns: [], relations: [] },
        { name: "customers", kind: "table", columns: [], relations: [] },
      ],
    },
  ],
};

const run = makeRun({ query: { source: "sales-db", from: "orders" } });

const answer = (scope: string | undefined, url: string) => {
  if (url === "/v1/saved-queries") {
    return {
      data: {
        data: scope === "shared" ? [sharedOk, sharedHidden] : [mine],
        next_cursor: null,
      },
    };
  }
  if (url === "/v1/me/runs")
    return { data: { data: [run], next_cursor: null } };
  if (url === "/v1/catalog") return { data: catalog };
  if (url === "/v1/me/principals") return { data: { data: [] } };
  return { data: { data: [], next_cursor: null } };
};

describe("MyPage", () => {
  beforeEach(() => {
    get
      .mockReset()
      .mockImplementation(
        async (url: string, cfg?: { params?: { scope?: string } }) =>
          answer(cfg?.params?.scope, url)
      );
    post.mockReset().mockResolvedValue({ data: mine });
    patch.mockReset().mockResolvedValue({ data: mine });
    del.mockReset().mockResolvedValue({});
  });

  it("has the four panels", async () => {
    renderWithProviders(<MyPage />);
    for (const name of [
      "My saved queries",
      "Shared with me",
      "What I can query",
      "My recent runs",
    ]) {
      expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
    }
    expect(await screen.findByText("Weekly revenue")).toBeInTheDocument();
    expect(await screen.findByText("Team signups")).toBeInTheDocument();
    expect(await screen.findByText("Sales database")).toBeInTheDocument();
  });

  it("shows the notice and no source for an inaccessible shared saved query", async () => {
    renderWithProviders(<MyPage />);
    const card = (await screen.findByText("Finance close")).closest(
      "[data-saved-query]"
    ) as HTMLElement;
    expect(within(card).getByText(NOTICE)).toBeInTheDocument();
    expect(within(card).queryByText(/sales-db/)).not.toBeInTheDocument();
    expect(
      within(card).queryByRole("button", { name: "Copy to mine" })
    ).not.toBeInTheDocument();
    // An accessible one can be copied and shows its source.
    const ok = screen
      .getByText("Team signups")
      .closest("[data-saved-query]") as HTMLElement;
    expect(
      within(ok).getByRole("button", { name: "Copy to mine" })
    ).toBeInTheDocument();
    expect(within(ok).getByText("sales-db")).toBeInTheDocument();
  });

  it("opens the create dialog pre-filled from a run's JSON", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MyPage />);
    await user.click(
      await screen.findByRole("button", { name: "Save as saved query" })
    );
    const dialog = await screen.findByRole("dialog");
    const json = within(dialog).getByLabelText("Query (JSON)");
    expect(JSON.parse((json as HTMLTextAreaElement).value)).toEqual(run.query);
    await user.type(within(dialog).getByLabelText("Name"), "Orders list");
    await user.click(
      within(dialog).getByRole("button", { name: "Save saved query" })
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/v1/saved-queries", {
        name: "Orders list",
        description: "",
        query: run.query,
      })
    );
  });

  it("edits only name and description, with no JSON editor", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MyPage />);
    const card = (await screen.findByText("Weekly revenue")).closest(
      "[data-saved-query]"
    ) as HTMLElement;
    await user.click(
      within(card).getByRole("button", { name: "Edit details" })
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).queryByLabelText("Query (JSON)")
    ).not.toBeInTheDocument();
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Revenue by week");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/v1/saved-queries/${SAVED_ID}`, {
        name: "Revenue by week",
      })
    );
  });

  it("lands a user with only zeteo.data.read on /my from /", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "My saved queries" })
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/my");
    window.history.replaceState(null, "", "/");
  });
});
