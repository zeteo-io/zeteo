import { makeSource, SOURCE_ID } from "@/features/sources/testFixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_USER_ID, makeRun } from "../testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { RunsPage } from "./RunsPage";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({
  permissions: ["zeteo.runs.read", "zeteo.sources.read"],
}));
vi.mock("@/lib/api/client", () => ({ api: { get, post } }));
vi.mock("@/lib/auth", async () => {
  const { mockAuth } = await import("@/test/authMock");
  return {
    ...mockAuth(),
    useAuth: () => mockAuth({ permissions: held.permissions }).useAuth(),
  };
});

const XSS = "<img src=x onerror=alert(1)>";
const hostile = makeRun({
  id: "a2222222-1c7a-4a53-9d0e-6a3b1f2c4d02",
  outcome: "failed",
  error_code: "query_failed",
  truncated: true,
  entry_point: "mcp",
  query: { note: XSS },
});
const running = makeRun({
  id: "a3333333-1c7a-4a53-9d0e-6a3b1f2c4d03",
  outcome: "running",
  entry_point: "export",
  duration_ms: 0,
  row_count: null,
  source_id: null,
  query: null,
});

const runParams = () =>
  get.mock.calls
    .filter(([url]) => url === "/v1/runs")
    .map(([, cfg]) => cfg.params as Record<string, unknown>);

describe("RunsPage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.runs.read", "zeteo.sources.read"];
    post
      .mockReset()
      .mockImplementation(
        async (
          _url: string,
          body: { principals: { type: string; id: string }[] }
        ) => ({
          data: {
            data: body.principals.map((p) => ({
              ...p,
              name: "Ada Lovelace",
              status: "active",
            })),
          },
        })
      );
    get.mockReset().mockImplementation(async (url: string) => {
      if (url === "/v1/runs") {
        return {
          data: { data: [makeRun(), hostile, running], next_cursor: null },
        };
      }
      if (url === "/v1/sources") {
        return { data: { data: [makeSource()], next_cursor: null } };
      }
      throw new Error(`unexpected ${url}`);
    });
  });

  it("lists runs in the order given, with person, source and outcome", async () => {
    renderWithProviders(<RunsPage />);
    await screen.findAllByText("Ada Lovelace");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("orders");
    expect(rows[0]).toHaveTextContent("ok");
    expect(rows[0]).toHaveTextContent("1.5 s");
    expect(rows[1]).toHaveTextContent("query_failed");
    expect(rows[1]).toHaveTextContent("Truncated");
    expect(rows[1]).toHaveTextContent("mcp");
    expect(rows[2]).toHaveTextContent("running");
    expect(rows[2]).toHaveTextContent("export");
  });

  it("shows the raw source id without zeteo.sources.read", async () => {
    held.permissions = ["zeteo.runs.read"];
    renderWithProviders(<RunsPage />);
    await screen.findAllByText("Ada Lovelace");
    expect(screen.getAllByText(SOURCE_ID).length).toBeGreaterThan(0);
    expect(get.mock.calls.some(([url]) => url === "/v1/sources")).toBe(false);
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
  });

  it("maps the filters of the address to user_id, source_id and outcome", async () => {
    renderWithProviders(<RunsPage />, {
      route: `/runs?user_id=${RUN_USER_ID}&source_id=${SOURCE_ID}&outcome=timeout`,
    });
    await screen.findAllByText("Ada Lovelace");
    expect(runParams()[0]).toMatchObject({
      user_id: RUN_USER_ID,
      source_id: SOURCE_ID,
      outcome: "timeout",
    });
  });

  it("ignores hand-edited invalid values in the address", async () => {
    renderWithProviders(<RunsPage />, {
      route: "/runs?user_id=nope&source_id=%3Cx%3E&outcome=weird",
    });
    await screen.findAllByText("Ada Lovelace");
    const params = runParams()[0];
    expect(params).not.toHaveProperty("user_id");
    expect(params).not.toHaveProperty("source_id");
    expect(params).not.toHaveProperty("outcome");
  });

  it("filters by outcome and by source with the selects", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RunsPage />);
    await screen.findAllByText("Ada Lovelace");
    await user.selectOptions(screen.getByLabelText("Outcome"), "refused");
    await waitFor(() =>
      expect(runParams().at(-1)).toMatchObject({ outcome: "refused" })
    );
    await user.selectOptions(screen.getByLabelText("Source"), SOURCE_ID);
    await waitFor(() =>
      expect(runParams().at(-1)).toMatchObject({
        outcome: "refused",
        source_id: SOURCE_ID,
      })
    );
  });

  it("clears the person filter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RunsPage />, {
      route: `/runs?user_id=${RUN_USER_ID}`,
    });
    await screen.findAllByText("Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Clear person" }));
    await waitFor(() =>
      expect(runParams().at(-1)).not.toHaveProperty("user_id")
    );
  });

  it("shows the query as text and adds no element from it", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<RunsPage />);
    await screen.findAllByText("Ada Lovelace");
    const row = screen.getAllByRole("row")[2];
    await user.click(within(row).getByRole("button", { name: "Details" }));
    const pre = await screen.findByTestId("run-query");
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toContain(XSS);
    expect(document.querySelector("img")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("says no query was recorded", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RunsPage />);
    await screen.findAllByText("Ada Lovelace");
    const row = screen.getAllByRole("row")[3];
    await user.click(within(row).getByRole("button", { name: "Details" }));
    expect(await screen.findByText("No query recorded")).toBeVisible();
  });

  it("copies the query when the clipboard exists and survives its absence", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RunsPage />);
    await screen.findAllByText("Ada Lovelace");
    await user.click(
      within(screen.getAllByRole("row")[1]).getByRole("button", {
        name: "Details",
      })
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        JSON.stringify(makeRun().query, null, 2)
      )
    );
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByTestId("run-query")).toBeVisible();
  });

  it("is read-only", async () => {
    renderWithProviders(<RunsPage />);
    await screen.findAllByText("Ada Lovelace");
    for (const name of [/new|create|add/i, /edit/i, /delete|remove/i]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    }
  });
});
