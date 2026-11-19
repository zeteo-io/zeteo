import { SourceMeasuresPage, SourceTablesPage } from "./SourceTabs";
import { makeMeasure } from "@/features/measures/testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTable } from "@/features/tables/testFixtures";
import { makeSource, SOURCE_ID } from "../testFixtures";
import { renderWithProviders } from "@/test/render";
import { Route, Routes } from "react-router-dom";
import { screen } from "@testing-library/react";
import { SourceLayout } from "./SourceLayout";

const get = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.sources.read", "zeteo.measures.write"],
    api: { get },
  })
);

const renderTables = () =>
  renderWithProviders(
    <Routes>
      <Route path="/sources/:sourceId" element={<SourceLayout />}>
        <Route path="tables" element={<SourceTablesPage />} />
        <Route path="measures" element={<SourceMeasuresPage />} />
      </Route>
    </Routes>,
    { route: `/sources/${SOURCE_ID}/tables` }
  );

describe("SourceTablesPage (database)", () => {
  beforeEach(() => {
    get.mockReset().mockImplementation(async (url: string) =>
      url === `/v1/sources/${SOURCE_ID}/tables`
        ? {
            data: {
              data: [
                makeTable({ row_count: 1234567 }),
                makeTable({
                  id: "a2222222-1c7a-4a53-9d0e-6a3b1f2c4d02",
                  name: "never_analyzed",
                  row_count: null,
                }),
              ],
              next_cursor: null,
            },
          }
        : { data: makeSource() }
    );
  });

  it("shows each table's estimated rows, and — where the database has none", async () => {
    renderTables();
    expect(
      await screen.findByRole("columnheader", { name: "Rows (approx.)" })
    ).toBeInTheDocument();
    const orders = (
      await screen.findByRole("link", { name: "orders" })
    ).closest("tr")!;
    expect(orders).toHaveTextContent("1,234,567");
    const never = screen
      .getByRole("link", { name: "never_analyzed" })
      .closest("tr")!;
    expect(never).toHaveTextContent("—");
  });
});

describe("SourceMeasuresPage", () => {
  it("lists the measures, with write actions for a measures writer", async () => {
    get
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === `/v1/sources/${SOURCE_ID}/measures`
          ? { data: { data: [makeMeasure()] } }
          : { data: makeSource() }
      );
    renderWithProviders(
      <Routes>
        <Route path="/sources/:sourceId" element={<SourceLayout />}>
          <Route path="measures" element={<SourceMeasuresPage />} />
        </Route>
      </Routes>,
      { route: `/sources/${SOURCE_ID}/measures` }
    );
    expect(await screen.findByText("paid_revenue")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New measure" })
    ).toBeInTheDocument();
    // Editors are a sources admin's or an owner's to change.
    expect(screen.queryByRole("button", { name: "Editors" })).toBeNull();
    expect(screen.getByRole("link", { name: "Measures" })).toBeInTheDocument();
  });
});
