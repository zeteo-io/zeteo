// @module-tag unit
// @module-tag platform
import { requireAnyPermission } from "../../middleware/auth.js";
import { describe, expect, it } from "vitest";
import type { Request } from "express";

const run = (held: string[]) => {
  const req = { caller: { permissions: held } } as unknown as Request;
  let result: unknown = "not called";
  requireAnyPermission(["zeteo.grants.read", "zeteo.runs.read"])(
    req,
    {} as never,
    (err?: unknown) => {
      result = err;
    }
  );
  return result as { statusCode?: number; message?: string } | undefined;
};

describe("requireAnyPermission", () => {
  it.each([
    [["zeteo.grants.read"]],
    [["zeteo.runs.read"]],
    [["zeteo.grants.write"]],
    [["zeteo.runs.write"]],
    [["admin"]],
  ])("lets %j through", (held) => {
    expect(run(held)).toBeUndefined();
  });

  it("refuses 403 naming the list when the caller holds none", () => {
    const err = run(["zeteo.data.read"]);
    expect(err?.statusCode).toBe(403);
    expect(err?.message).toBe(
      "Requires one of: zeteo.grants.read, zeteo.runs.read"
    );
  });
});
