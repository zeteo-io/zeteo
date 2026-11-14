import { LIMIT_GROUP_ID, LIMIT_USER_ID, makeLimit } from "../testFixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { LimitsPage } from "./LimitsPage";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.grants.write"] }));
vi.mock("@/lib/api/client", () => ({ api: { get, post, delete: del } }));
vi.mock("@/lib/auth", async () => {
  const { mockAuth } = await import("@/test/authMock");
  return {
    ...mockAuth(),
    useAuth: () => mockAuth({ permissions: held.permissions }).useAuth(),
  };
});

const userLimit = makeLimit();
const groupLimit = makeLimit({
  id: "f2222222-1c7a-4a53-9d0e-6a3b1f2c4d02",
  principal_type: "group",
  principal_id: LIMIT_GROUP_ID,
  principal_status: "orphaned",
  query_concurrency: null,
  export_concurrency: 2,
});

const lookupAnswer = async (_url: string, body: { principals: unknown[] }) => ({
  data: {
    data: (body.principals as { type: string; id: string }[]).map((p) => ({
      ...p,
      name: p.id === LIMIT_USER_ID ? "Ada Lovelace" : "Analysts",
      status: p.id === LIMIT_USER_ID ? "active" : "orphaned",
    })),
  },
});

const limitParams = () =>
  get.mock.calls
    .filter(([url]) => url === "/v1/principal-limits")
    .map(([, cfg]) => cfg.params as Record<string, unknown>);

describe("LimitsPage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.grants.write"];
    del.mockReset().mockResolvedValue({ data: undefined });
    post.mockReset().mockImplementation(lookupAnswer);
    get.mockReset().mockImplementation(async (url: string) => {
      if (url === "/v1/principal-limits") {
        return { data: { data: [userLimit, groupLimit], next_cursor: null } };
      }
      throw new Error(`unexpected ${url}`);
    });
  });

  it("lists principals and values, Default for a null", async () => {
    renderWithProviders(<LimitsPage />);
    const row = (await screen.findByText("Ada Lovelace")).closest("tr")!;
    expect(row).toHaveTextContent("8");
    expect(row).toHaveTextContent("3");
    const orphanRow = (await screen.findByText(/Analysts|b2222222/)).closest(
      "tr"
    )!;
    expect(within(orphanRow).getByText("Default")).toBeInTheDocument();
    expect(within(orphanRow).getByText("Orphaned")).toBeInTheDocument();
  });

  it("does not turn a failed name lookup into an orphaned badge", async () => {
    post.mockReset().mockRejectedValue({
      status: 502,
      code: "tereo_unreachable",
      message: "Tereo could not be reached",
    });
    renderWithProviders(<LimitsPage />);
    const row = (await screen.findByText(LIMIT_USER_ID)).closest("tr")!;
    await waitFor(() => expect(row).toHaveTextContent("name unavailable"));
    expect(within(row).queryByText(/orphaned/i)).not.toBeInTheDocument();
  });

  it("sends the filters of the address", async () => {
    renderWithProviders(<LimitsPage />, {
      route: `/limits?principal_type=user&principal_id=${LIMIT_USER_ID}`,
    });
    await screen.findByText("Ada Lovelace");
    expect(limitParams()[0]).toMatchObject({
      principal_type: "user",
      principal_id: LIMIT_USER_ID,
    });
  });

  it("clears the principal filter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LimitsPage />, {
      route: `/limits?principal_type=group&principal_id=${LIMIT_GROUP_ID}`,
    });
    await screen.findByText("Analysts");
    await user.click(screen.getByRole("button", { name: "Clear principal" }));
    await waitFor(() =>
      expect(limitParams().at(-1)).not.toHaveProperty("principal_id")
    );
  });

  it("has write controls with zeteo.grants.write", async () => {
    renderWithProviders(<LimitsPage />);
    await screen.findByText("Ada Lovelace");
    expect(screen.getByRole("button", { name: "New limit" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
  });

  it("has no write control with only zeteo.grants.read", async () => {
    held.permissions = ["zeteo.grants.read"];
    renderWithProviders(<LimitsPage />);
    await screen.findByText("Ada Lovelace");
    expect(
      screen.queryByRole("button", { name: "New limit" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" })
    ).not.toBeInTheDocument();
  });

  it("deletes after a confirmation that names the principal", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LimitsPage />);
    const row = (await screen.findByText("Ada Lovelace")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Ada Lovelace falls back/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete limit" }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/principal-limits/${userLimit.id}`)
    );
  });

  it("opens the edit form for a row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LimitsPage />);
    const row = (await screen.findByText("Ada Lovelace")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText("Query concurrency")).toHaveValue("8");
  });
});
