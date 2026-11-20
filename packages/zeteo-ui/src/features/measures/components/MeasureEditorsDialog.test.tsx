import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeasureEditorsDialog } from "./MeasureEditorsDialog";
import { SOURCE_ID } from "@/features/sources/testFixtures";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get, post, put } })
);

const USER = "u1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";

describe("MeasureEditorsDialog", () => {
  beforeEach(() => {
    put.mockReset().mockResolvedValue({ data: { data: [] } });
    post.mockReset().mockResolvedValue({
      data: {
        data: [{ type: "user", id: USER, name: "Ada", status: "active" }],
      },
    });
    get.mockReset().mockResolvedValue({
      data: {
        data: [
          {
            type: "user",
            id: USER,
            name: "Ada",
            email: "ada@example.com",
            added_at: "2026-11-01T10:00:00.000Z",
          },
        ],
      },
    });
  });

  it("lists the editors and saves the list without one removed", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MeasureEditorsDialog sourceId={SOURCE_ID} onClose={vi.fn()} />
    );
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Ada" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        `/v1/sources/${SOURCE_ID}/measure-editors`,
        { principals: [] }
      )
    );
  });
});
