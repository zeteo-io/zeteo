import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";

// Pages wait on zeteo forever: these tests are about routing.
const get = vi.hoisted(() => vi.fn(() => new Promise(() => {})));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.runs.read"],
    api: { get },
  })
);
vi.mock("@/lib/config", async () =>
  (await import("@/test/uiConfig")).mockConfig()
);

describe("app routes", () => {
  afterEach(() => {
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
    expect(screen.getByRole("link", { name: "Runs" })).toBeInTheDocument();
  });

  it("shows not found for an unknown path", async () => {
    window.history.replaceState(null, "", "/nowhere");
    render(<App />);
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});
