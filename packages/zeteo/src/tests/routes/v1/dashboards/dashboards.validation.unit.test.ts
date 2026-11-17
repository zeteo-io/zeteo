// @module-tag unit
// @module-tag platform
import { UpdatePanelSchema } from "../../../../routes/v1/dashboards/dashboard/panels/panel/schemas.js";
import { PanelInputSchema } from "../../../../routes/v1/dashboards/dashboard/panels/schemas.js";
import { UpdateDashboardSchema } from "../../../../routes/v1/dashboards/dashboard/schemas.js";
import { CreateDashboardSchema } from "../../../../routes/v1/dashboards/schemas.js";
import { describe, expect, it } from "vitest";
import env from "../../../../env.js";

const ID = "0197a2f0-0000-7000-8000-000000000001";
const CHART = { type: "table", version: 1 };
const create = (fields: Record<string, unknown>) =>
  CreateDashboardSchema.safeParse({ name: "n", ...fields });
const panel = (fields: Record<string, unknown>) =>
  PanelInputSchema.safeParse({
    kind: "own",
    saved_query_id: ID,
    chart: CHART,
    ...fields,
  });

describe("CreateDashboardSchema", () => {
  it("takes a name alone, trims it, and defaults the rest", () => {
    const parsed = create({ name: "  Sales  " });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ name: "Sales", description: "" });
    expect(parsed.data?.panels).toBeUndefined();
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a name of spaces", { name: "   " }],
    ["a name of 101 characters", { name: "a".repeat(101) }],
    ["a name with NUL", { name: "a\u0000b" }],
    ["a description of 2001 characters", { description: "a".repeat(2001) }],
    ["a description with NUL", { description: "a\u0000" }],
    ["an unknown key", { owner_id: ID }],
    ["an unknown time range", { time_range: "last_week" }],
    ["an unknown theme", { theme: "blue" }],
    [
      "a refresh below the minimum",
      { refresh_seconds: env.DASHBOARD_MIN_REFRESH_SECONDS - 1 },
    ],
    ["a fractional refresh", { refresh_seconds: 61.5 }],
    [
      "more than 50 panels",
      {
        panels: Array.from({ length: 51 }, () => ({
          kind: "own",
          saved_query_id: ID,
          chart: CHART,
        })),
      },
    ],
  ])("refuses %s", (_, fields) => {
    expect(create(fields).success).toBe(false);
  });

  it("accepts the bounds and the nulls", () => {
    expect(create({ name: "a".repeat(100) }).success).toBe(true);
    expect(create({ description: "a".repeat(2000) }).success).toBe(true);
    expect(create({ time_range: null, refresh_seconds: null }).success).toBe(
      true
    );
    expect(
      create({ refresh_seconds: env.DASHBOARD_MIN_REFRESH_SECONDS }).success
    ).toBe(true);
    expect(
      create({ time_range: "previous_quarter", theme: "light" }).success
    ).toBe(true);
  });

  it("refuses a missing name", () => {
    expect(CreateDashboardSchema.safeParse({}).success).toBe(false);
  });
});

describe("UpdateDashboardSchema", () => {
  it("needs at least one field and refuses unknown ones", () => {
    expect(UpdateDashboardSchema.safeParse({}).success).toBe(false);
    expect(UpdateDashboardSchema.safeParse({ name: "n" }).success).toBe(true);
    expect(UpdateDashboardSchema.safeParse({ panels: [] }).success).toBe(true);
    expect(UpdateDashboardSchema.safeParse({ owner: ID }).success).toBe(false);
  });
});

describe("PanelInputSchema", () => {
  it("takes an own panel and a linked panel", () => {
    expect(panel({}).success).toBe(true);
    expect(
      PanelInputSchema.safeParse({ kind: "linked", saved_panel_id: ID }).success
    ).toBe(true);
  });

  it.each([
    ["x + w over 12", { x: 8, y: 0, w: 5, h: 2 }],
    ["w of 13", { x: 0, y: 0, w: 13, h: 2 }],
    ["w of 0", { x: 0, y: 0, w: 0, h: 2 }],
    ["h of 0", { x: 0, y: 0, w: 2, h: 0 }],
    ["a negative x", { x: -1, y: 0 }],
    ["a negative y", { x: 0, y: -1 }],
    ["a fractional x", { x: 0.5, y: 0 }],
    ["x without y", { x: 1 }],
    ["y without x", { y: 1 }],
    ["a title of 101 characters", { title: "a".repeat(101) }],
    ["a title with NUL", { title: "a\u0000" }],
    ["an empty title", { title: "" }],
    ["an unknown key", { extra: 1 }],
    ["a saved panel id on an own panel", { saved_panel_id: ID }],
    ["no chart", { chart: undefined }],
    ["an invalid chart", { chart: { type: "bar", version: 1 } }],
    ["a time column of 201 characters", { time_column: "a".repeat(201) }],
  ])("refuses an own panel with %s", (_, fields) => {
    expect(panel(fields).success).toBe(false);
  });

  it.each([
    ["a chart", { chart: CHART }],
    ["a saved query id", { saved_query_id: ID }],
    ["a time column", { time_column: "created_at" }],
    ["x + w over 12", { x: 10, y: 0, w: 4, h: 2 }],
  ])("refuses a linked panel with %s", (_, fields) => {
    expect(
      PanelInputSchema.safeParse({
        kind: "linked",
        saved_panel_id: ID,
        ...fields,
      }).success
    ).toBe(false);
  });

  it("accepts a place on the edge of the grid", () => {
    expect(panel({ x: 6, y: 0, w: 6, h: 1 }).success).toBe(true);
    expect(panel({ x: 0, y: 3, w: 12, h: 10 }).success).toBe(true);
  });
});

describe("UpdatePanelSchema", () => {
  it("needs a field, bounds the place, and takes a null title", () => {
    expect(UpdatePanelSchema.safeParse({}).success).toBe(false);
    expect(UpdatePanelSchema.safeParse({ title: null }).success).toBe(true);
    expect(UpdatePanelSchema.safeParse({ x: 8, w: 5 }).success).toBe(false);
    expect(UpdatePanelSchema.safeParse({ x: 7, w: 5 }).success).toBe(true);
    expect(UpdatePanelSchema.safeParse({ chart: CHART }).success).toBe(true);
    expect(UpdatePanelSchema.safeParse({ kind: "own" }).success).toBe(false);
  });
});

describe("UpdateDashboardSchema panels by id", () => {
  const place = { x: 0, y: 0, w: 6, h: 2 };
  const update = (panels: unknown[]) =>
    UpdateDashboardSchema.safeParse({ panels });

  it("takes an existing panel by id with its place, and new panels beside it", () => {
    expect(update([{ id: ID, ...place, title: null }]).success).toBe(true);
    expect(
      update([
        { id: ID, ...place },
        { kind: "own", saved_query_id: ID, chart: CHART },
      ]).success
    ).toBe(true);
  });

  it.each([
    ["no place", { id: ID }],
    ["x + w over 12", { id: ID, x: 8, y: 0, w: 5, h: 2 }],
    ["an unknown key", { id: ID, ...place, kind: "own" }],
  ])("refuses an existing panel with %s", (_, entry) => {
    expect(update([entry]).success).toBe(false);
  });
});
