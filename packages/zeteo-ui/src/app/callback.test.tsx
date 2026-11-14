import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "@/app";

// The real AuthProvider runs; the exchange and /v1/me are replaced.
vi.mock("@/lib/config", () => ({
  loadConfig: async () => ({ tereoUrl: "https://tereo.test", clientId: "c" }),
}));
vi.mock("@/lib/auth/oauth", async () => ({
  ...(await vi.importActual<typeof import("@/lib/auth/oauth")>(
    "@/lib/auth/oauth"
  )),
  completeLogin: vi.fn(async () => ({ returnTo: "/grants" })),
}));
vi.mock("@/lib/auth/me", () => ({
  MeError: class MeError extends Error {},
  fetchMe: vi.fn(async () => ({
    id: "u",
    type: "user",
    name: "Ada",
    email: null,
    permissions: ["admin"],
  })),
}));

describe("sign-in callback", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/callback?code=x&state=y");
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("ends on the return path, with no code in the router's location", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Grants" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Page not found")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/grants");
    expect(window.location.search).toBe("");
  });
});
