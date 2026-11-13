// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  resolveUserLimits,
  type PrincipalLimitRow,
} from "../../limits/resolve.js";

const USER = "0197d000-0000-7000-8000-000000000001";
const GROUP_A = "0197d000-0000-7000-8000-00000000000a";
const GROUP_B = "0197d000-0000-7000-8000-00000000000b";
const DEFAULTS = { queryConcurrency: 5, exportConcurrency: 1 };

const row = (
  principalType: "user" | "group",
  principalId: string,
  queryConcurrency: number | null,
  exportConcurrency: number | null
): PrincipalLimitRow => ({
  principalType,
  principalId,
  queryConcurrency,
  exportConcurrency,
});

describe("resolveUserLimits", () => {
  it("gives the defaults when there are no rows", () => {
    expect(resolveUserLimits([], USER, [GROUP_A], DEFAULTS)).toEqual(DEFAULTS);
  });

  it("raises a limit to a group's row", () => {
    expect(
      resolveUserLimits(
        [row("group", GROUP_A, 20, 4)],
        USER,
        [GROUP_A],
        DEFAULTS
      )
    ).toEqual({ queryConcurrency: 20, exportConcurrency: 4 });
  });

  it("lowers a limit to a group's row too: a group's row replaces the default", () => {
    expect(
      resolveUserLimits(
        [row("group", GROUP_A, 1, null)],
        USER,
        [GROUP_A],
        DEFAULTS
      )
    ).toEqual({ queryConcurrency: 1, exportConcurrency: 1 });
  });

  it("takes the higher of two groups' rows, field by field", () => {
    expect(
      resolveUserLimits(
        [row("group", GROUP_A, 8, 2), row("group", GROUP_B, 3, 6)],
        USER,
        [GROUP_A, GROUP_B],
        DEFAULTS
      )
    ).toEqual({ queryConcurrency: 8, exportConcurrency: 6 });
  });

  it("lets the user's own row below a group's row win, for the field it sets only", () => {
    expect(
      resolveUserLimits(
        [row("group", GROUP_A, 20, 4), row("user", USER, 2, null)],
        USER,
        [GROUP_A],
        DEFAULTS
      )
    ).toEqual({ queryConcurrency: 2, exportConcurrency: 4 });
  });

  it("leaves queries at the group's or default value for a row with only export_concurrency", () => {
    expect(
      resolveUserLimits([row("user", USER, null, 3)], USER, [GROUP_A], DEFAULTS)
    ).toEqual({ queryConcurrency: 5, exportConcurrency: 3 });
    expect(
      resolveUserLimits(
        [row("group", GROUP_A, 9, null), row("user", USER, null, 3)],
        USER,
        [GROUP_A],
        DEFAULTS
      )
    ).toEqual({ queryConcurrency: 9, exportConcurrency: 3 });
  });

  it("ignores rows of other principals: another user, a group the user is not in, a group id given as a user", () => {
    expect(
      resolveUserLimits(
        [
          row("user", GROUP_A, 40, 9),
          row("group", GROUP_B, 30, 8),
          row("group", USER, 20, 7),
        ],
        USER,
        [GROUP_A],
        DEFAULTS
      )
    ).toEqual(DEFAULTS);
  });
});
