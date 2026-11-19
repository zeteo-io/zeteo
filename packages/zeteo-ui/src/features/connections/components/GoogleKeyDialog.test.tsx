import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { GoogleKeyDialog } from "./GoogleKeyDialog";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";

const put = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { put } })
);

describe("GoogleKeyDialog", () => {
  beforeEach(() => {
    put.mockReset();
  });

  it("shows google_key_rejected inline", async () => {
    const user = userEvent.setup();
    put.mockRejectedValue({
      status: 422,
      code: "google_key_rejected",
      message: "Google rejected this key.",
    });
    renderWithProviders(<GoogleKeyDialog onClose={() => undefined} />);
    await user.click(
      screen.getByRole("textbox", { name: /Service account key/ })
    );
    await user.paste("{}");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(
      await screen.findByText("Google rejected this key.")
    ).toBeInTheDocument();
  });
});
