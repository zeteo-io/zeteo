// @module-tag unit
// @module-tag platform
import { ReplaceSharesSchema } from "../../../../../../routes/v1/saved-queries/saved-query/shares/schemas.js";
import { describe, expect, it } from "vitest";

const id = (n: number) =>
  `0197d000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const parse = (body: unknown) => ReplaceSharesSchema.safeParse(body);

describe("ReplaceSharesSchema", () => {
  it("takes users and groups, ids lowercased", () => {
    const parsed = parse({
      principals: [
        { type: "user", id: id(1).toUpperCase() },
        { type: "group", id: id(1) },
      ],
    });
    expect(parsed.data).toEqual({
      principals: [
        { type: "user", id: id(1) },
        { type: "group", id: id(1) },
      ],
    });
  });

  it("accepts an empty list and 100 principals", () => {
    expect(parse({ principals: [] }).success).toBe(true);
    expect(
      parse({
        principals: Array.from({ length: 100 }, (_, i) => ({
          type: "user",
          id: id(i),
        })),
      }).success
    ).toBe(true);
  });

  it.each([
    ["no principals", {}],
    [
      "101 principals",
      {
        principals: Array.from({ length: 101 }, (_, i) => ({
          type: "user",
          id: id(i),
        })),
      },
    ],
    [
      "a repeated principal, whatever its case",
      {
        principals: [
          { type: "user", id: id(10) },
          { type: "user", id: id(10).toUpperCase() },
        ],
      },
    ],
    ["an unknown type", { principals: [{ type: "role", id: id(1) }] }],
    ["an id that is no UUID", { principals: [{ type: "user", id: "x" }] }],
    [
      "an unknown key",
      { principals: [{ type: "user", id: id(1), name: "n" }] },
    ],
    ["an unknown top-level key", { principals: [], notify: true }],
  ])("refuses %s", (_, body) => {
    expect(parse(body).success).toBe(false);
  });
});
