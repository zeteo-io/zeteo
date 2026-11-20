import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { CatalogList } from "./CatalogPanel";

const get = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get } })
);

const source = (extra: object) => ({
  slug: "sales",
  name: "Sales",
  type: "postgres",
  tables: [{ name: "orders", kind: "table", columns: [], relations: [] }],
  ...extra,
});

describe("CatalogList metrics", () => {
  it("lists a source's metrics with their descriptions", async () => {
    get.mockResolvedValue({
      data: {
        sources: [
          source({
            metrics: [{ name: "margin_pct", description: "Margin as a share" }],
          }),
        ],
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<CatalogList />);
    await user.click(await screen.findByRole("button", { name: /Sales/ }));
    const list = screen.getByRole("list", { name: "Metrics in Sales" });
    expect(list).toHaveTextContent("margin_pct");
    expect(list).toHaveTextContent("Margin as a share");
  });

  it("shows no metrics list when the catalogue has none", async () => {
    get.mockResolvedValue({ data: { sources: [source({})] } });
    const user = userEvent.setup();
    renderWithProviders(<CatalogList />);
    await user.click(await screen.findByRole("button", { name: /Sales/ }));
    expect(screen.queryByRole("list", { name: /Metrics in/ })).toBeNull();
  });

  it("marks a table whose rows are limited, with the reason as its tooltip", async () => {
    get.mockResolvedValue({
      data: {
        sources: [
          source({
            tables: [
              {
                name: "orders",
                kind: "table",
                rows_limited: true,
                rows_limited_reason: "region is one of your regions",
              },
              { name: "items", kind: "table", rows_limited: false },
            ],
          }),
        ],
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<CatalogList />);
    await user.click(await screen.findByRole("button", { name: /Sales/ }));
    const pills = screen.getAllByText("Rows limited");
    expect(pills).toHaveLength(1);
    expect(pills[0].closest("[title]")).toHaveAttribute(
      "title",
      "region is one of your regions"
    );
  });
});
