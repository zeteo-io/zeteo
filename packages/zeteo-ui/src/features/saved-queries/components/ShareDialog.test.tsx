import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERSON_ID, SAVED_ID, makeShare } from "../testFixtures";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { ShareDialog } from "./ShareDialog";

const get = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read"],
    api: { get, put },
  })
);

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("ShareDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    get.mockReset().mockImplementation(async (url: string) =>
      url === "/v1/me/principals"
        ? {
            data: {
              data: [
                {
                  type: "user",
                  id: PERSON_ID,
                  name: "Pat Person",
                  email: "pat@example.com",
                  status: "active",
                },
              ],
            },
          }
        : { data: { data: [] } }
    );
    put.mockReset().mockResolvedValue({
      data: {
        data: [makeShare()],
        warnings: [{ type: "user", id: PERSON_ID, accessible: false }],
      },
    });
  });
  afterEach(() => vi.useRealTimers());

  const search = async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(
      <ShareDialog objectType="saved_query" id={SAVED_ID} onClose={vi.fn()} />
    );
    await user.type(
      await screen.findByLabelText("Search by name or email"),
      "pat"
    );
    await advance(600);
    return user;
  };

  it("lists the people the search finds", async () => {
    await search();
    expect(
      await screen.findByRole("option", { name: /Pat Person/ })
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/v1/me/principals", {
      params: { type: "user", q: "pat", limit: 10 },
    });
  });

  it("says the name and description are visible to everyone", async () => {
    renderWithProviders(
      <ShareDialog objectType="saved_query" id={SAVED_ID} onClose={vi.fn()} />
    );
    expect(
      await screen.findByText(
        "The name and description are visible to everyone it's shared with, including people who can't run it."
      )
    ).toBeInTheDocument();
  });

  it("warns about each user who cannot run it after saving", async () => {
    const user = await search();
    await user.click(await screen.findByRole("option", { name: /Pat Person/ }));
    await user.click(screen.getByRole("button", { name: "Save sharing" }));
    expect(
      await screen.findByText(
        "Pat Person can't run this saved query until their access is expanded."
      )
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(`/v1/saved-queries/${SAVED_ID}/shares`, {
        principals: [{ type: "user", id: PERSON_ID }],
      })
    );
  });

  it("works for a dashboard: its own path, title and note, no warnings", async () => {
    const DASHBOARD_ID = "a2222222-1c7a-4a53-9d0e-6a3b1f2c4d01";
    put.mockResolvedValue({ data: { data: [makeShare()] } });
    const onClose = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(
      <ShareDialog objectType="dashboard" id={DASHBOARD_ID} onClose={onClose} />
    );
    expect(await screen.findByText("Share dashboard")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Everyone it's shared with can open it. Each panel shows only what their own access lets them run."
      )
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(`/v1/dashboards/${DASHBOARD_ID}/shares`)
    );
    await user.type(screen.getByLabelText("Search by name or email"), "pat");
    await advance(600);
    await user.click(await screen.findByRole("option", { name: /Pat Person/ }));
    await user.click(screen.getByRole("button", { name: "Save sharing" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        `/v1/dashboards/${DASHBOARD_ID}/shares`,
        {
          principals: [{ type: "user", id: PERSON_ID }],
        }
      )
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
