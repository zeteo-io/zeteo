import { renderWithProviders } from "@/test/render";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "@/app";

describe("App", () => {
  it("shows a loading state", () => {
    renderWithProviders(<App />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("sets the theme on the document", () => {
    renderWithProviders(<App />);
    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
  });
});
