import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { routes } from "./router";
import { App } from "@/app";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuth({
    permissions: ["zeteo.data.read"],
  })
);

describe("signed in with no section permission", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("shows the no-access page at /, not a blank one", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("guards the root route with an error page", () => {
    expect(routes[0].errorElement).toBeDefined();
  });
});
