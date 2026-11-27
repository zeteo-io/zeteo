// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  checkRowRulesServer,
  ROW_RULES_MIN_SERVER_VERSION,
} from "../../../adapters/postgres/runQuery.js";

// A table with a row rule is read as a MATERIALIZED WITH query, which
// PostgreSQL parses from 12 on: on an older server a rule-limited query is
// refused with a clear error before it runs, never run without its rule.

describe("checkRowRulesServer", () => {
  it("lets PostgreSQL 12 and later run a rule-limited query", () => {
    expect(ROW_RULES_MIN_SERVER_VERSION).toBe(120000);
    for (const v of [120000, 120022, 140011, 170002]) {
      expect(() => checkRowRulesServer(v)).not.toThrow();
    }
  });

  it("refuses one on an older server, or one whose version it cannot read, as row_rule_unavailable", () => {
    for (const v of [110022, 90624, NaN]) {
      expect(() => checkRowRulesServer(v)).toThrow(
        expect.objectContaining({
          code: "row_rule_unavailable",
          statusCode: 409,
          message: expect.stringContaining("PostgreSQL 12 or later"),
        })
      );
    }
  });
});
