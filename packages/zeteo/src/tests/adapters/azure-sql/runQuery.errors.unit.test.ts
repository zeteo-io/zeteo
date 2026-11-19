// @module-tag unit
// @module-tag platform
import { DATE_OVERFLOW } from "../../../adapters/azure-sql/runQuery.js";
import { describe, expect, it } from "vitest";

const overflow = (type: string) =>
  `Arithmetic overflow error converting expression to data type ${type}.`;

describe("DATE_OVERFLOW (SQL Server error 8115)", () => {
  it.each(["date", "datetime", "datetime2", "datetimeoffset", "smalldatetime"])(
    "matches an overflow to %s, a value the caller gave",
    (type) => {
      expect(DATE_OVERFLOW.test(overflow(type))).toBe(true);
    }
  );

  it.each([
    "int",
    "bigint",
    "smallint",
    "numeric",
    "decimal",
    "money",
    "float",
  ])("does not match an overflow to %s, a failure of the source", (type) => {
    expect(DATE_OVERFLOW.test(overflow(type))).toBe(false);
  });

  it("does not match the message in another language", () => {
    expect(
      DATE_OVERFLOW.test(
        "Erreur de dépassement arithmétique lors de la conversion de l'expression en type de données datetime."
      )
    ).toBe(false);
  });
});
