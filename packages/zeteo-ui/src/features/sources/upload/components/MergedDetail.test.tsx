import { renderWithProviders } from "@/test/render";
import { screen } from "@testing-library/react";
import { MergedDetail } from "./MergedDetail";
import { describe, expect, it } from "vitest";

const A = "a1000000-1c7a-4a53-9d0e-6a3b1f2c4d01";
const B = "a2000000-1c7a-4a53-9d0e-6a3b1f2c4d02";

const merged = {
  label_column: "brand",
  members: [
    {
      table_id: A,
      name: "watermelon",
      label: "Watermelon Ball",
      missing: false,
    },
    { table_id: B, name: "chomchom", label: "ChomChom", missing: true },
  ],
  columns: [
    {
      id: "c1",
      name: "sku",
      from_name: "sku",
      type: "text",
      members: [A, B],
      missing: false,
    },
    {
      id: "c2",
      name: "price",
      from_name: "price",
      type: "number",
      members: [A],
      missing: false,
    },
  ],
  available: [{ name: "vivo_sku", type: "text", members: [A] }],
  warnings: [{ column_id: "c2", table_id: B }],
};

describe("MergedDetail", () => {
  it("lists members with labels and flags a missing one", () => {
    renderWithProviders(
      <MergedDetail sourceId="s1" tableId="t1" merged={merged} canEdit />
    );
    expect(screen.getByText("Watermelon Ball")).toBeInTheDocument();
    expect(screen.getByText("ChomChom")).toBeInTheDocument();
    expect(screen.getAllByText("Missing")).toHaveLength(1);
    expect(screen.getByText("brand")).toBeInTheDocument();
  });

  it("lists available columns and warnings", () => {
    renderWithProviders(
      <MergedDetail sourceId="s1" tableId="t1" merged={merged} canEdit />
    );
    expect(screen.getByText("Available columns")).toBeInTheDocument();
    expect(screen.getByText("vivo_sku")).toBeInTheDocument();
    expect(
      screen.getByText(/price.*no usable value.*chomchom/i)
    ).toBeInTheDocument();
  });

  it("offers Edit to an editor only", async () => {
    const { unmount } = renderWithProviders(
      <MergedDetail sourceId="s1" tableId="t1" merged={merged} canEdit />
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    unmount();
    renderWithProviders(
      <MergedDetail
        sourceId="s1"
        tableId="t1"
        merged={merged}
        canEdit={false}
      />
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});
