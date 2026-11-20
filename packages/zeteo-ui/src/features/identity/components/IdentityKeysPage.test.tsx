import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { IdentityKeysPage } from "./IdentityKeysPage";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.grants.write"],
    api: { get, post },
  })
);

const key = {
  id: "d1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
  name: "rep_region",
  label: "regions",
  description: "Sales regions",
  value_count: 12,
};

describe("IdentityKeysPage", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ data: { data: [key], next_cursor: null } });
  });

  it("lists keys, each linking to its values", async () => {
    renderWithProviders(<IdentityKeysPage />);
    const link = await screen.findByRole("link", { name: "regions" });
    expect(link).toHaveAttribute("href", `/identities/${key.id}`);
    expect(screen.getByText("rep_region")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("creates a key", async () => {
    post.mockResolvedValue({ data: { ...key, id: "x" } });
    const user = userEvent.setup();
    renderWithProviders(<IdentityKeysPage />);
    await user.click(await screen.findByRole("button", { name: "New key" }));
    await user.type(screen.getByLabelText("Label"), "territories");
    await user.type(screen.getByLabelText("Name"), "territory");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/v1/identity-keys", {
        name: "territory",
        label: "territories",
      })
    );
  });

  it("refuses a bad name without calling the API", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IdentityKeysPage />);
    await user.click(await screen.findByRole("button", { name: "New key" }));
    await user.type(screen.getByLabelText("Label"), "Territories");
    await user.type(screen.getByLabelText("Name"), "Bad Name");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText(/lowercase letter/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});
