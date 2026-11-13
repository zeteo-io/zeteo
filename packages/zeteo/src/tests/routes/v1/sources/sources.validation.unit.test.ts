// @module-tag unit
// @module-tag platform
import { CreateSourceSchema } from "../../../../routes/v1/sources/schemas.js";
import { describe, expect, it } from "vitest";

const create = (schemas: unknown) =>
  CreateSourceSchema.safeParse({
    slug: "sales",
    type: "postgres",
    name: "Sales",
    settings: {},
    schemas,
  });

describe("source schema names", () => {
  it.each([
    [["public"]],
    [["sales", "hr"]],
    [["with space inside"]],
    [["ünïcode"]],
    [["a".repeat(63)]],
  ])("accepts %j", (schemas) => {
    expect(create(schemas).success).toBe(true);
  });

  it.each([
    ["an empty name", [""]],
    ["a name of 64 bytes", ["a".repeat(64)]],
    ["a name of 64 bytes in multibyte characters", ["é".repeat(32)]],
    ["a leading space", [" sales"]],
    ["a trailing space", ["sales "]],
    ["a leading tab", ["\tsales"]],
    ["a trailing newline", ["sales\n"]],
    ["a newline inside", ["sa\nles"]],
    ["a NUL character", ["sa\u0000les"]],
    ["a DEL character", ["sa\u007fles"]],
    ["a C1 control character", ["sa\u0085les"]],
    ["a duplicate", ["sales", "sales"]],
  ])("refuses %s", (_, schemas) => {
    expect(create(schemas).success).toBe(false);
  });
});
