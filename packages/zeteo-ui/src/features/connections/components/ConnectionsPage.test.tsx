import { GOOGLE_CONNECTION } from "../../sources/upload/testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { ConnectionsPage } from "./ConnectionsPage";
import userEvent from "@testing-library/user-event";

const get = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({
  permissions: ["zeteo.sources.write"] as string[],
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, put },
  })
);

const notConfigured = {
  status: 404,
  code: "google_not_configured",
  message: "Google is not set up",
};

describe("ConnectionsPage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.sources.write"];
    get.mockReset();
    put.mockReset();
  });

  it("shows the service account email and who set it, with Set key", async () => {
    get.mockResolvedValue({ data: GOOGLE_CONNECTION });
    renderWithProviders(<ConnectionsPage />);
    expect(
      await screen.findByText(GOOGLE_CONNECTION.service_account_email)
    ).toBeInTheDocument();
    expect(get.mock.calls[0]?.[0]).toBe("/v1/connections/google");
    expect(screen.getByRole("button", { name: "Set key" })).toBeInTheDocument();
  });

  it("shows Not set up when zeteo has no key, and no Set key to a reader", async () => {
    held.permissions = ["zeteo.sources.read"];
    get.mockRejectedValue(notConfigured);
    renderWithProviders(<ConnectionsPage />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set key" })).toBeNull();
  });

  it("sets the key from pasted JSON", async () => {
    const user = userEvent.setup();
    get.mockRejectedValue(notConfigured);
    put.mockResolvedValue({ data: GOOGLE_CONNECTION });
    renderWithProviders(<ConnectionsPage />);
    await user.click(await screen.findByRole("button", { name: "Set key" }));
    const text = '{"type":"service_account"}';
    await user.click(
      screen.getByRole("textbox", { name: /Service account key/ })
    );
    await user.paste(text);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/v1/connections/google", {
        service_account_key: text,
      })
    );
  });
});
