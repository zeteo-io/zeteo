import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { GRANT_ID, makeGrant } from "../testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { GrantEditPage } from "./GrantFormPages";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ api: { get, post, delete: del } }));
vi.mock("@/lib/auth", async () => {
  const { mockAuth } = await import("@/test/authMock");
  return mockAuth({ permissions: ["zeteo.grants.write"] });
});

const renderEdit = () =>
  renderWithProviders(
    <Routes>
      <Route path="/grants" element={<p>list</p>} />
      <Route path="/grants/:grantId/edit" element={<GrantEditPage />} />
    </Routes>,
    { route: `/grants/${GRANT_ID}/edit` }
  );

describe("GrantEditPage", () => {
  beforeEach(() => {
    del.mockReset().mockResolvedValue({ data: undefined });
    post.mockReset().mockResolvedValue({ data: { data: [] } });
    get.mockReset().mockResolvedValue({ data: makeGrant() });
  });

  it("says so when the grant does not exist", async () => {
    get.mockRejectedValue({ status: 404, code: "not_found", message: "no" });
    renderEdit();
    expect(await screen.findByText("Grant not found")).toBeInTheDocument();
  });

  it("deletes after confirming and goes back to the list", async () => {
    const user = userEvent.setup();
    renderEdit();
    await user.click(
      await screen.findByRole("button", { name: "Delete grant" })
    );
    await user.click(screen.getByRole("button", { name: "Remove grant" }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`/v1/grants/${GRANT_ID}`)
    );
    expect(await screen.findByText("list")).toBeInTheDocument();
  });
});
