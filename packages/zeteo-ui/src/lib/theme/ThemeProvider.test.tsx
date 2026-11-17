import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "@/lib/theme";

const Probe = () => {
  const { theme, setTheme } = useTheme();
  return (
    <button onClick={() => setTheme("dark")} type="button">
      {theme}
    </button>
  );
};

const renderProbe = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  );

describe("ThemeProvider", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute("data-theme");
  });

  it("uses a stored theme", () => {
    localStorage.setItem("zeteo-theme", JSON.stringify("dark"));
    renderProbe();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("falls back to system for a stored value it does not know", () => {
    localStorage.setItem("zeteo-theme", JSON.stringify("neon"));
    renderProbe();
    expect(screen.getByRole("button")).toHaveTextContent("system");
    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
  });

  it("changes the theme when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderProbe();
    act(() => screen.getByRole("button").click());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
