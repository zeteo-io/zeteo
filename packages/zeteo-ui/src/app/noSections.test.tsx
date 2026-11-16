import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { routes } from "./router";
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

describe("signed in with no section permission", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows the no-access page at /, not a blank one", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("guards the root route with an error page", () => {
    expect(routes.find((r) => r.path === "/")?.errorElement).toBeDefined();
  });
});
