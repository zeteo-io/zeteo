import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERSON_ID, SAVED_ID, makeSavedQuery } from "../testFixtures";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { TransferDialog } from "./TransferDialog";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read"],
    api: { get, post },
  })
);

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("TransferDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    get.mockReset().mockResolvedValue({
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
    });
    post.mockReset().mockResolvedValue({ data: { data: makeSavedQuery() } });
  });
  afterEach(() => vi.useRealTimers());

  const chosen = async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    renderWithProviders(
      <TransferDialog
        objectType="saved_query"
        id={SAVED_ID}
        onClose={onClose}
      />
    );
    await user.type(
      await screen.findByLabelText("Search by name or email"),
      "pat"
    );
    await advance(600);
    await user.click(await screen.findByRole("option", { name: /Pat Person/ }));
    return { user, onClose };
  };

  it("keeps my access by default", async () => {
    const { user } = await chosen();
    expect(
      screen.getByRole("checkbox", { name: "Keep my access" })
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Transfer" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        `/v1/saved-queries/${SAVED_ID}/transfer`,
        { user_id: PERSON_ID, keep_access: true }
      )
    );
  });

  it("says why on a 409", async () => {
    post.mockRejectedValue({
      status: 409,
      code: "conflict",
      message: "dup",
    });
    const { user, onClose } = await chosen();
    await user.click(screen.getByRole("button", { name: "Transfer" }));
    expect(
      await screen.findByText(
        "Pat Person already has a saved query with this name. Rename this one, then transfer it."
      )
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
