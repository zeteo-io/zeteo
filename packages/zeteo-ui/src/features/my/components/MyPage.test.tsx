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

/** My Zeteo on one of its tabs (the overview without one). */
const at = (tab?: string, extra = "") =>
  renderWithProviders(<MyPage />, {
    route: tab ? `/my?tab=${tab}${extra}` : "/my",
  });

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
const withheldRun = makeRun({
  id: "a9999999-1c7a-4a53-9d0e-6a3b1f2c4d09",
  outcome: "refused",
  row_count: null,
  source_id: null,
  query: { withheld: true },
});
const unrecordableRun = makeRun({
  id: "a8888888-1c7a-4a53-9d0e-6a3b1f2c4d08",
  query: { unrecordable: true },
});
let runs = [run];

const answer = (scope: string | undefined, url: string) => {
  if (url === "/v1/saved-queries") {
    return {
      data: {
        data: scope === "shared" ? [sharedOk, sharedHidden] : [mine],
        next_cursor: null,
      },
    };
  }
  if (url === "/v1/me/runs") return { data: { data: runs, next_cursor: null } };
  if (url === "/v1/catalog") return { data: catalog };
  if (url === "/v1/me/principals") return { data: { data: [] } };
  return { data: { data: [], next_cursor: null } };
};

describe("MyPage", () => {
  beforeEach(() => {
    runs = [run];
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

  it("shows a withheld run without its source or query actions", async () => {
    runs = [withheldRun];
    at("runs");
    expect(await screen.findByText("Query withheld")).toBeInTheDocument();
    const row = screen.getByText("Query withheld").closest("li") as HTMLElement;
    expect(within(row).queryByText("sales-db")).not.toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Show query" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save as saved query" })
    ).not.toBeInTheDocument();
  });

  it("offers no query actions for a run whose query was not recorded", async () => {
    runs = [unrecordableRun];
    at("runs");
    expect(
      await screen.findByRole("list", { name: "Recent runs" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show query" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save as saved query" })
    ).not.toBeInTheDocument();
  });

  it("deletes a saved query after confirming", async () => {
    const user = userEvent.setup();
    at("mine");
    const card = (await screen.findByText("Weekly revenue")).closest(
      "[data-saved-query]"
    ) as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Delete" }));
    expect(del).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/saved-queries/${SAVED_ID}`)
    );
  });

  it("copies a shared saved query under a name", async () => {
    const user = userEvent.setup();
    at("shared");
    const card = (await screen.findByText("Team signups")).closest(
      "[data-saved-query]"
    ) as HTMLElement;
    await user.click(
      within(card).getByRole("button", { name: "Copy to mine" })
    );
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("Team signups (copy)");
    await user.clear(name);
    await user.type(name, "My signups");
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        `/v1/saved-queries/${sharedOk.id}/copy`,
        {
          name: "My signups",
        }
      )
    );
  });

  it("says a copy's name is taken on 409", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({ status: 409, code: "conflict", message: "dup" });
    at("shared");
    const card = (await screen.findByText("Team signups")).closest(
      "[data-saved-query]"
    ) as HTMLElement;
    await user.click(
      within(card).getByRole("button", { name: "Copy to mine" })
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(
      await within(dialog).findByText(
        "You already have a saved query with this name."
      )
    ).toBeInTheDocument();
  });

  it("opens on the overview: recently used saved queries and the last runs", async () => {
    at();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    for (const name of ["Recently used saved queries", "Recent runs"]) {
      expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
    }
    // Mine and shared together, most recently used first.
    const recent = await screen.findByRole("list", {
      name: "Recently used saved queries",
    });
    expect(
      within(recent)
        .getAllByRole("link")
        .map((a) => a.textContent)
    ).toEqual(expect.arrayContaining(["Weekly revenue", "Team signups"]));
    // A run is labelled by the table it read.
    expect(await screen.findByText("sales-db.orders")).toBeInTheDocument();
    // The full lists are on their own tabs.
    expect(screen.queryByText("Sales database")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /All saved queries/ })
    ).toHaveAttribute("href", "/my?tab=mine");
    expect(screen.getByRole("link", { name: /All runs/ })).toHaveAttribute(
      "href",
      "/my?tab=runs"
    );
  });

  it("shows at most ten runs on the overview, with no Show more", async () => {
    runs = Array.from({ length: 12 }, (_, i) =>
      makeRun({
        id: `a00000${String(i).padStart(2, "0")}-1c7a-4a53-9d0e-6a3b1f2c4d00`,
        query: { source: "sales-db", from: `table_${i}` },
      })
    );
    at();
    const list = await screen.findByRole("list", { name: "Recent runs" });
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")).toHaveLength(10)
    );
    expect(
      screen.queryByRole("button", { name: "Show more" })
    ).not.toBeInTheDocument();
  });

  it("links each saved query to its own page", async () => {
    at();
    expect(
      await screen.findByRole("link", { name: "Team signups" })
    ).toHaveAttribute("href", `/my/saved-queries/${sharedOk.id}`);
  });

  it("links a card's name to the saved query's page", async () => {
    at("mine");
    expect(
      await screen.findByRole("link", { name: "Weekly revenue" })
    ).toHaveAttribute("href", `/my/saved-queries/${SAVED_ID}`);
  });

  it("shows ten runs, then ten more on Show more", async () => {
    const user = userEvent.setup();
    runs = Array.from({ length: 12 }, (_, i) =>
      makeRun({
        id: `a00000${String(i).padStart(2, "0")}-1c7a-4a53-9d0e-6a3b1f2c4d00`,
        query: { source: "sales-db", from: `table_${i}` },
      })
    );
    at("runs");
    const list = await screen.findByRole("list", { name: "Recent runs" });
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")).toHaveLength(10)
    );
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(12);
    expect(
      screen.queryByRole("button", { name: "Show more" })
    ).not.toBeInTheDocument();
  });

  it("lists a source's tables when it is opened", async () => {
    const user = userEvent.setup();
    at("catalog");
    const toggle = await screen.findByRole("button", {
      name: /Sales database/,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("customers")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("customers")).toBeInTheDocument();
  });

  it("shows the notice and no source for an inaccessible shared saved query", async () => {
    at("shared");
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
    at("runs");
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
    at("mine");
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
      await screen.findByRole("heading", {
        name: "Recently used saved queries",
      })
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/my");
    window.history.replaceState(null, "", "/");
  });
});
