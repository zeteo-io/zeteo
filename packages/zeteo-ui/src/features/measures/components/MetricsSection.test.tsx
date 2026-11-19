import { makeMeasure, makeMetric, makeRedactedMetric } from "../testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCE_ID } from "@/features/sources/testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { MetricsSection } from "./MetricsSection";
import { screen } from "@testing-library/react";

const get = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get, delete: del } })
);

const respond = (can_edit: boolean, can_manage_editors = false) =>
  get.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith("/metrics"))
      return {
        data: {
          data: [makeMetric(), makeRedactedMetric()],
          can_edit,
          can_manage_editors,
        },
      };
    return { data: { data: [makeMeasure()], can_edit, next_cursor: null } };
  });

describe("MetricsSection", () => {
  beforeEach(() => {
    del.mockReset().mockResolvedValue({});
    respond(true);
  });

  it("lists metrics with the measures they use and marks a redacted one", async () => {
    renderWithProviders(<MetricsSection sourceId={SOURCE_ID} canWrite />);
    const row = (await screen.findByText("margin_pct")).closest("tr")!;
    expect(row).toHaveTextContent("Margin as a share of revenue");
    expect(row).toHaveTextContent("paid_revenue");
    expect(row).toHaveTextContent("total_cost");
    expect(row).toHaveTextContent("1 saved query");
    const redacted = screen.getByText("churn").closest("tr")!;
    expect(redacted).toHaveTextContent("Not usable by you");
    expect(redacted.querySelector("button")).toBeNull();
  });

  it("deletes after confirming with the used-by counts", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MetricsSection sourceId={SOURCE_ID} canWrite />);
    const row = (await screen.findByText("margin_pct")).closest("tr")!;
    await user.click(row.querySelector("button[aria-label='Delete']")!);
    expect(
      await screen.findByText(/is used by 1 saved query and 0 panels/)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete metric" }));
    expect(del).toHaveBeenCalledWith(
      `/v1/sources/${SOURCE_ID}/metrics/${makeMetric().id}`
    );
  });

  it("hides the actions from one who is not an editor", async () => {
    respond(false, true);
    renderWithProviders(<MetricsSection sourceId={SOURCE_ID} canWrite />);
    await screen.findByText("margin_pct");
    expect(screen.queryByRole("button", { name: "New metric" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      screen.getByText("Add yourself as an editor to create or change metrics.")
    ).toBeInTheDocument();
  });
});
