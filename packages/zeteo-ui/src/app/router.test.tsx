import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { App } from "@/app";

// Pages wait on zeteo forever: these tests are about routing.
const get = vi.hoisted(() => vi.fn(() => new Promise(() => {})));
const held = vi.hoisted(() => ({
  permissions: ["zeteo.runs.read"] as string[],
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get },
  })
);
vi.mock("@/lib/config", async () =>
  (await import("@/test/uiConfig")).mockConfig()
);

describe("app routes", () => {
  afterEach(() => {
    held.permissions = ["zeteo.runs.read"];
    window.history.replaceState(null, "", "/");
  });

  it("shows only the sections the person can read, and / lands on the first of them", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Runs" })
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/runs");
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(within(nav).queryAllByRole("link")).toEqual([]);
    // Runs is the only admin section, so the Admin menu lists only it.
    await userEvent.click(within(nav).getByRole("button", { name: "Admin" }));
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent)
    ).toEqual(["Runs"]);
  });

  it("shows the no-access page for a section without the permission, keeping the nav", async () => {
    window.history.replaceState(null, "", "/sources");
    render(<App />);

    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(screen.getByText(/zeteo\.sources\.read/)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Sources" })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(screen.getByRole("link", { name: "Runs" })).toBeInTheDocument();
  });

  it("shows not found for an unknown path", async () => {
    window.history.replaceState(null, "", "/nowhere");
    render(<App />);
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });

  it("lands on My Zeteo for a person who may query, even one who also reads runs", async () => {
    held.permissions = ["zeteo.data.read", "zeteo.runs.read"];
    window.history.replaceState(null, "", "/");
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe("/my"));
  });
});
