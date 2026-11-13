// @module-tag unit
// @module-tag platform
import { adapterFor, NoAdapterError } from "../../adapters/index.js";
import type { SourceType } from "../../adapters/types.js";
import { describe, expect, it } from "vitest";

describe("adapterFor", () => {
  it("returns each known type's adapter", () => {
    expect(adapterFor("postgres").language.id).toBe("sql");
    expect(adapterFor("azure-sql").language.id).toBe("sql");
  });

  it("throws NoAdapterError for a type it has no adapter for", () => {
    expect(() => adapterFor("mysql" as SourceType)).toThrow(NoAdapterError);
  });
});
