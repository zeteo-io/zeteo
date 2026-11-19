import { makeMeasure, makeRedactedMeasure } from "../testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCE_ID } from "@/features/sources/testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { MeasuresTab } from "./MeasuresTab";

const get = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get, delete: del } })
);

const measures = [
  makeMeasure(),
  makeMeasure({
    id: "m2222222-1c7a-4a53-9d0e-6a3b1f2c4d02",
    name: "net_revenue",
    broken: { code: "not_found_or_not_accessible", message: "No column amt" },
    used_by: { saved_queries: 0, panels: 0 },
  }),
  makeRedactedMeasure(),
];

describe("MeasuresTab", () => {
  beforeEach(() => {
    del.mockReset().mockResolvedValue({});
    get.mockReset().mockImplementation(async (url: string) => {
      if (url.endsWith("/measures")) return { data: { data: measures } };
      return { data: { data: [], next_cursor: null } };
    });
  });

  it("lists measures, flags a broken one and marks a redacted one", async () => {
    renderWithProviders(
      <MeasuresTab sourceId={SOURCE_ID} canWrite canManageEditors />
    );
    const paid = (await screen.findByText("paid_revenue")).closest("tr")!;
    expect(paid).toHaveTextContent("Revenue of paid orders");
    expect(paid).toHaveTextContent("2 saved queries");
    expect(paid).toHaveTextContent("1 panel");

    const net = screen.getByText("net_revenue").closest("tr")!;
    expect(net).toHaveTextContent("Broken");
    expect(net).toHaveTextContent("No column amt");

    const margin = screen.getByText("margin").closest("tr")!;
    expect(margin).toHaveTextContent("Not usable by you");
    expect(margin).toHaveTextContent("Gross margin");
    expect(margin.querySelector("button")).toBeNull();
  });

  it("shows write actions only to those who may write", async () => {
    renderWithProviders(
      <MeasuresTab
        sourceId={SOURCE_ID}
        canWrite={false}
        canManageEditors={false}
      />
    );
    await screen.findByText("paid_revenue");
    expect(screen.queryByRole("button", { name: "New measure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Editors" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("confirms a delete with the used-by counts", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MeasuresTab sourceId={SOURCE_ID} canWrite canManageEditors />
    );
    const paid = (await screen.findByText("paid_revenue")).closest("tr")!;
    await user.click(paid.querySelector("button[aria-label='Delete']")!);
    expect(
      await screen.findByText(/is used by 2 saved queries and 1 panel/)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete measure" }));
    expect(del).toHaveBeenCalledWith(
      `/v1/sources/${SOURCE_ID}/measures/${makeMeasure().id}`
    );
  });
});
