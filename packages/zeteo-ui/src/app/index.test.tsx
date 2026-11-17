import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { screen } from "@testing-library/react";
import { App } from "@/app";

describe("App", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    // /ui-config.json never answers: the app stays on sign-in's loading state.
    fetchMock.mockReset().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state while it signs in", () => {
    renderWithProviders(<App />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/ui-config.json",
      expect.anything()
    );
  });

  it("sets the theme on the document", () => {
    renderWithProviders(<App />);
    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
  });
});
