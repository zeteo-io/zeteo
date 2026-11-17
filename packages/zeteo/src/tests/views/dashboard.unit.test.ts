// @module-tag unit
// @module-tag platform
import { dashboardView, uiBaseUrl } from "../../views/dashboard.js";
import type { PanelDecision } from "../../dashboards/decide.js";
import { describe, expect, it } from "vitest";

const row = {
  id: "d1",
  ownerId: "o1",
  name: "Sales",
  description: "",
  timeRange: null,
  refreshSeconds: null,
  theme: "auto" as const,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  panels: [],
};
const decisions = new Map<string, PanelDecision>();

describe("uiBaseUrl", () => {
  it("is the public URL, without a trailing slash, when the UI is served", () => {
    expect(
      uiBaseUrl({ PUBLIC_URL: "https://z.example.com/", UI_CLIENT_ID: "c" })
    ).toBe("https://z.example.com");
  });

  it("is null without UI_CLIENT_ID or PUBLIC_URL", () => {
    expect(uiBaseUrl({ PUBLIC_URL: "https://z.example.com" })).toBeNull();
    expect(uiBaseUrl({ UI_CLIENT_ID: "c" })).toBeNull();
  });
});

describe("dashboardView", () => {
  it("links to the dashboard in the UI when it is served, and leaves url out otherwise", () => {
    const withUi = dashboardView(row, decisions, {
      ownerName: "Ann",
      uiBaseUrl: "https://z.example.com",
    });
    expect(withUi.url).toBe("https://z.example.com/dashboards/d1");
    const without = dashboardView(row, decisions, {
      ownerName: null,
      uiBaseUrl: null,
    });
    expect(without).not.toHaveProperty("url");
    expect(without.owner).toEqual({ id: "o1", name: null });
  });

  it("leaves share_count and shared_at out unless given", () => {
    const plain = dashboardView(row, decisions, {
      ownerName: null,
      uiBaseUrl: null,
    });
    expect(plain).not.toHaveProperty("share_count");
    expect(plain).not.toHaveProperty("shared_at");
    const full = dashboardView(row, decisions, {
      ownerName: null,
      uiBaseUrl: null,
      shareCount: 0,
      sharedAt: new Date("2026-01-03T00:00:00Z"),
    });
    expect(full).toMatchObject({
      share_count: 0,
      shared_at: "2026-01-03T00:00:00.000Z",
    });
  });
});
