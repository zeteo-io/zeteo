import { describe, expect, it } from "vitest";
import { hasPermission } from "./permissions";

describe("hasPermission", () => {
  it("admin covers everything", () => {
    expect(hasPermission(["admin"], "zeteo.sources.write")).toBe(true);
    expect(hasPermission(["admin"], "zeteo.runs.read")).toBe(true);
  });

  it("write covers read of the same area", () => {
    expect(hasPermission(["zeteo.sources.write"], "zeteo.sources.read")).toBe(
      true
    );
  });

  it("read does not cover write", () => {
    expect(hasPermission(["zeteo.sources.read"], "zeteo.sources.write")).toBe(
      false
    );
  });

  it("write of one area does not cover another", () => {
    expect(hasPermission(["zeteo.grants.write"], "zeteo.sources.read")).toBe(
      false
    );
  });

  it("otherwise needs an exact match", () => {
    expect(hasPermission(["zeteo.runs.read"], "zeteo.runs.read")).toBe(true);
    expect(hasPermission([], "zeteo.runs.read")).toBe(false);
    expect(hasPermission(["zeteo.runs"], "zeteo.runs.read")).toBe(false);
    expect(hasPermission(["zeteo.admin"], "zeteo.runs.read")).toBe(false);
  });
});
