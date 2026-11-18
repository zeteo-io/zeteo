// @module-tag int
// @module-tag platform
import type { PlannedColumn } from "../../uploads/loading.js";
import { matchColumns } from "../../uploads/service.js";
import { describe, expect, it } from "vitest";

const column = (
  id: string,
  name: string,
  originalName: string | null,
  missing = false
) => ({
  id,
  name,
  originalName,
  type: "number",
  missingSince: missing ? new Date() : null,
});

const planned = (name: string, originalName: string): PlannedColumn[] => [
  { index: 0, name, originalName, type: "text", typeGiven: false },
];

describe("matchColumns (the sync matches by header)", () => {
  it("matches a live column before a missing one with the same header", () => {
    // `amount` went missing; the live `total` was renamed in Zeteo from the same header.
    const existing = [
      column("old", "amount", "Amount", true),
      column("live", "total", "Amount"),
    ];
    const plan = planned("amount", "Amount");
    const { matched, gone } = matchColumns(existing, plan, "original_name");
    expect(matched.map((c) => c?.id)).toEqual(["live"]);
    expect(plan[0]).toMatchObject({ name: "total", type: "number" });
    expect(gone).toEqual([]);
  });

  it("restores a missing column when no live one matches", () => {
    const existing = [column("old", "amount", "Amount", true)];
    const { matched } = matchColumns(
      existing,
      planned("amount", "Amount"),
      "original_name"
    );
    expect(matched.map((c) => c?.id)).toEqual(["old"]);
  });

  it("by name, renames a new column whose name a catalogue column has", () => {
    const existing = [column("a", "cost", "Amount")];
    const plan = [
      ...planned("amount", "Amount"),
      {
        index: 1,
        name: "cost",
        originalName: "Cost",
        type: "text" as const,
        typeGiven: false,
      },
    ];
    const { matched } = matchColumns(existing, plan, "original_name");
    expect(matched.map((c) => c?.id)).toEqual(["a", undefined]);
    expect(plan.map((p) => p.name)).toEqual(["cost", "cost_2"]);
  });
});
