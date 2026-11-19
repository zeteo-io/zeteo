import { describe, expect, it } from "vitest";
import { timeZoneOptions } from "./timeZones";

describe("timeZoneOptions", () => {
  it("lists UTC once, first, and each zone once", () => {
    const zones = timeZoneOptions("UTC");
    expect(zones[0]).toBe("UTC");
    expect(zones.filter((z) => z === "UTC")).toHaveLength(1);
    expect(new Set(zones).size).toBe(zones.length);
  });

  it("offers current names such as Asia/Kolkata and Europe/Kyiv", () => {
    const zones = timeZoneOptions();
    expect(zones).toContain("Asia/Kolkata");
    expect(zones).toContain("Europe/Kyiv");
  });

  it("offers the saved zone even when the browser does not list it", () => {
    expect(timeZoneOptions("Etc/GMT+5")).toContain("Etc/GMT+5");
  });
});
