import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";

// Pages wait on zeteo forever: these tests are about routing.
const get = vi.hoisted(() => vi.fn(() => new Promise(() => {})));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read"],
    api: { get },
  })
);
vi.mock("@/lib/config", async () =>
  (await import("@/test/uiConfig")).mockConfig()
);

describe("the Dashboards section", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("comes after My Zeteo, which stays the landing page", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "My Zeteo" })
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent)
    ).toEqual(["My Zeteo", "Dashboards"]);
  });

  it("opens at /dashboards", async () => {
    window.history.replaceState(null, "", "/dashboards");
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Dashboards" })
    ).toBeInTheDocument();
  });

  it("sends /saved-panels to the Saved panels tab", async () => {
    window.history.replaceState(null, "", "/saved-panels");
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe("/dashboards"));
    expect(window.location.search).toBe("?tab=panels");
  });

  it("shows a dashboard's display outside the layout, with no top bar", async () => {
    window.history.replaceState(
      null,
      "",
      "/dashboards/a1111111-1c7a-4a53-9d0e-6a3b1f2c4d01/display"
    );
    const { container } = render(<App />);
    await waitFor(() =>
      expect(
        container.querySelector(".z-display, [role=status]")
      ).not.toBeNull()
    );
    expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
  });
});
