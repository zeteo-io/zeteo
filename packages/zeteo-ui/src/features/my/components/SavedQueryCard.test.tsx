import { makeSavedQuery } from "@/features/saved-queries/testFixtures";
import { renderWithProviders } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import { SavedQueryCard } from "./SavedQueryCard";
import { screen } from "@testing-library/react";

vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.data.read"],
  })
);

describe("SavedQueryCard", () => {
  it("marks a saved query that is available for dashboards", () => {
    renderWithProviders(
      <SavedQueryCard
        savedQuery={makeSavedQuery({ available_for_dashboards: true })}
        kind="mine"
      />
    );
    expect(screen.getByText("Available for dashboards")).toBeInTheDocument();
  });

  it("has no mark when it is not", () => {
    renderWithProviders(
      <SavedQueryCard
        savedQuery={makeSavedQuery({ available_for_dashboards: false })}
        kind="mine"
      />
    );
    expect(
      screen.queryByText("Available for dashboards")
    ).not.toBeInTheDocument();
  });
});
