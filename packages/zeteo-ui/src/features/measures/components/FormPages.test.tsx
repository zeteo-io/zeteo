import { MeasureEditPage, MeasureNewPage } from "./FormPages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { SOURCE_ID } from "@/features/sources/testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { makeMeasure } from "../testFixtures";
import { MeasuresTab } from "./MeasuresTab";

const get = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get } })
);

const MEASURE_ID = "a1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
const measure = makeMeasure({ id: MEASURE_ID, name: "paid_revenue" });

const respond = (can_edit: boolean) =>
  get.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith("/measures"))
      return {
        data: { data: [measure], can_edit, can_manage_editors: true },
      };
    return { data: { data: [], next_cursor: null } };
  });

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;

const app = (route: string) =>
  renderWithProviders(
    <>
      <Routes>
        <Route
          path="/sources/:sourceId/measures"
          element={
            <MeasuresTab sourceId={SOURCE_ID} canWrite canManageEditors />
          }
        />
        <Route
          path="/sources/:sourceId/measures/new"
          element={<MeasureNewPage />}
        />
        <Route
          path="/sources/:sourceId/measures/:measureId/edit"
          element={<MeasureEditPage />}
        />
      </Routes>
      <Where />
    </>,
    { route }
  );

describe("measure pages", () => {
  beforeEach(() => {
    respond(true);
  });

  it("opens New measure as a page from the tab, and Cancel comes back", async () => {
    const user = userEvent.setup();
    app(`/sources/${SOURCE_ID}/measures`);
    await user.click(
      await screen.findByRole("button", { name: "New measure" })
    );
    expect(
      await screen.findByRole("heading", { name: "New measure" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent(
      `/sources/${SOURCE_ID}/measures/new`
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("where")).toHaveTextContent(
      new RegExp(`/sources/${SOURCE_ID}/measures$`)
    );
  });

  it("opens Edit as a page filled from the measure", async () => {
    const user = userEvent.setup();
    app(`/sources/${SOURCE_ID}/measures`);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(
      await screen.findByRole("heading", { name: "Edit measure" })
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("paid_revenue")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent(
      `/measures/${MEASURE_ID}/edit`
    );
  });

  it("is not found for one who is not an editor", async () => {
    respond(false);
    app(`/sources/${SOURCE_ID}/measures/${MEASURE_ID}/edit`);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Edit measure" })).toBeNull();
  });
});
