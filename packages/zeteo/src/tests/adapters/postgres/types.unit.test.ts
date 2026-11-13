// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  mapPostgresType,
  postgresBaseType,
} from "../../../adapters/postgres/types.js";

describe("mapPostgresType", () => {
  // What each type maps to, and so which operators the planner allows on it.
  // Every queryable one is covered by a query on the fixture; what no
  // operator can use as it is maps to `other`.
  it.each([
    ["int2", "b", "number"],
    ["int4", "b", "number"],
    ["int8", "b", "number"],
    ["numeric", "b", "number"],
    ["float4", "b", "number"],
    ["float8", "b", "number"],
    ["money", "b", "number"],
    ["text", "b", "text"],
    ["varchar", "b", "text"],
    ["bpchar", "b", "text"],
    ["citext", "b", "text"],
    ["name", "b", "text"],
    ["uuid", "b", "text"],
    ["mood", "e", "text"],
    ["bool", "b", "boolean"],
    ["date", "b", "date"],
    ["timestamp", "b", "timestamp"],
    ["timestamptz", "b", "timestamp"],
    ["json", "b", "json"],
    ["jsonb", "b", "json"],
    ["_text", "b", "other"],
    ["_mood", "b", "other"],
    ["int4range", "r", "other"],
    ["int4multirange", "m", "other"],
    ["address", "c", "other"],
    ["char", "b", "other"],
    ["inet", "b", "other"],
    ["cidr", "b", "other"],
    ["macaddr", "b", "other"],
    ["interval", "b", "other"],
    ["time", "b", "other"],
    ["timetz", "b", "other"],
    ["bytea", "b", "other"],
    ["xml", "b", "other"],
    ["bit", "b", "other"],
    ["varbit", "b", "other"],
    ["tsvector", "b", "other"],
    ["point", "b", "other"],
    ["oid", "b", "other"],
  ])("maps %s (typtype %s) to %s", (typname, typtype, type) => {
    expect(mapPostgresType(typname, typtype)).toBe(type);
  });

  it("maps a domain through its base type, and a domain over a domain to other", () => {
    expect(
      mapPostgresType("price", "d", { typname: "money", typtype: "b" })
    ).toBe("number");
    expect(
      mapPostgresType("feeling", "d", { typname: "mood", typtype: "e" })
    ).toBe("text");
    expect(
      mapPostgresType("outer", "d", { typname: "inner", typtype: "d" })
    ).toBe("other");
  });
});

describe("postgresBaseType", () => {
  it.each([
    ["integer", "integer"],
    ["numeric(12,2)", "numeric(12,2)"],
    ["money", "money"],
    ["uuid", "uuid"],
    ["sales.mood (enum)", "enum"],
    ['"Mood (enum)" (enum)', "enum"],
    ["sales.price (domain over money)", "money"],
    ["sales.token (domain over uuid)", "uuid"],
    ["sales.feeling (domain over sales.mood (enum))", "enum"],
    [
      "stamp (domain over timestamp(3) without time zone)",
      "timestamp(3) without time zone",
    ],
    ['"d (domain over uuid)" (domain over money)', "money"],
  ])("reads %s as %s", (nativeType, base) => {
    expect(postgresBaseType(nativeType)).toBe(base);
  });

  it("does not take a quoted name that only looks like an enum for one", () => {
    expect(postgresBaseType('"x (enum)"')).toBe('"x (enum)"');
  });
});
