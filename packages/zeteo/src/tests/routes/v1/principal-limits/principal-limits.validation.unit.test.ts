// @module-tag unit
// @module-tag platform
import { UpdatePrincipalLimitSchema } from "../../../../routes/v1/principal-limits/principal-limit/schemas.js";
import { CreatePrincipalLimitSchema } from "../../../../routes/v1/principal-limits/schemas.js";
import { describe, expect, it } from "vitest";

const PRINCIPAL = {
  principal_type: "user",
  principal_id: "0197d000-0000-7000-8000-000000000001",
};

describe("CreatePrincipalLimitSchema", () => {
  it.each([
    [{ query_concurrency: 1 }],
    [{ query_concurrency: 100 }],
    [{ export_concurrency: 1 }],
    [{ export_concurrency: 10 }],
    [{ query_concurrency: 5, export_concurrency: 2 }],
  ])("accepts %j", (limits) => {
    expect(
      CreatePrincipalLimitSchema.safeParse({ ...PRINCIPAL, ...limits }).success
    ).toBe(true);
  });

  it.each([
    ["neither limit", {}],
    ["a null limit and no other", { query_concurrency: null }],
    ["query_concurrency 0", { query_concurrency: 0 }],
    ["query_concurrency 101", { query_concurrency: 101 }],
    ["export_concurrency 0", { export_concurrency: 0 }],
    ["export_concurrency 11", { export_concurrency: 11 }],
    ["a fraction", { query_concurrency: 1.5 }],
    ["a string", { query_concurrency: "3" }],
    ["an unknown field", { query_concurrency: 3, burst: 1 }],
    [
      "a principal type that is neither",
      { query_concurrency: 3, principal_type: "robot" },
    ],
    [
      "a principal id that is not an id",
      { query_concurrency: 3, principal_id: "nope" },
    ],
  ])("refuses %s", (_, fields) => {
    expect(
      CreatePrincipalLimitSchema.safeParse({ ...PRINCIPAL, ...fields }).success
    ).toBe(false);
  });
});

describe("UpdatePrincipalLimitSchema", () => {
  it.each([
    [{ query_concurrency: 2 }],
    [{ export_concurrency: null }],
    [{ query_concurrency: null, export_concurrency: 3 }],
  ])("accepts %j", (body) => {
    expect(UpdatePrincipalLimitSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ["an empty change", {}],
    ["query_concurrency 101", { query_concurrency: 101 }],
    ["export_concurrency 11", { export_concurrency: 11 }],
    ["a principal", { principal_type: "group" }],
  ])("refuses %s", (_, body) => {
    expect(UpdatePrincipalLimitSchema.safeParse(body).success).toBe(false);
  });
});
