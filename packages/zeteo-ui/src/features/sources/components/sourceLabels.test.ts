import { formatCount, sourceTypeName, tlsName } from "./sourceLabels";
import type { SourceType } from "../api/types";
import { describe, expect, it } from "vitest";

describe("sourceLabels", () => {
  it("names a source type by its product", () => {
    expect(sourceTypeName("postgres")).toBe("PostgreSQL");
    expect(sourceTypeName("azure-sql")).toBe("Azure SQL");
    expect(sourceTypeName("oracle" as SourceType)).toBe("oracle");
  });

  it("says a TLS mode in words, and a dash for none", () => {
    expect(tlsName("verify")).toBe("Required, certificate verified");
    expect(tlsName("require")).toBe("Required");
    expect(tlsName("off")).toBe("Off");
    expect(tlsName("trust-server-certificate")).toBe(
      "Required, server certificate trusted"
    );
    expect(tlsName("something-new")).toBe("something-new");
    expect(tlsName(undefined)).toBe("—");
    expect(tlsName({ mode: "verify" })).toBe("—");
  });

  it("groups the digits of a count", () => {
    expect(formatCount(50000)).toBe(new Intl.NumberFormat().format(50000));
    expect(formatCount(7)).toBe("7");
  });
});
