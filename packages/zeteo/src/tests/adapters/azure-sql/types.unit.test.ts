// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  azureSqlNativeType,
  mapAzureSqlType,
} from "../../../adapters/azure-sql/types.js";

describe("mapAzureSqlType", () => {
  it.each([
    ["char", "text"],
    ["varchar", "text"],
    ["nchar", "text"],
    ["nvarchar", "text"],
    ["text", "text"],
    ["ntext", "text"],
    ["uniqueidentifier", "text"],
    ["xml", "text"],
    ["tinyint", "number"],
    ["smallint", "number"],
    ["int", "number"],
    ["bigint", "number"],
    ["decimal", "number"],
    ["numeric", "number"],
    ["money", "number"],
    ["smallmoney", "number"],
    ["float", "number"],
    ["real", "number"],
    ["bit", "boolean"],
    ["date", "date"],
    ["datetime", "timestamp"],
    ["datetime2", "timestamp"],
    ["smalldatetime", "timestamp"],
    ["datetimeoffset", "timestamp"],
    ["time", "other"],
    ["varbinary", "other"],
    ["timestamp", "other"],
    ["sql_variant", "other"],
    ["geography", "other"],
    ["hierarchyid", "other"],
  ] as const)("%s is %s", (name, type) => {
    expect(mapAzureSqlType(name)).toBe(type);
  });
});

describe("azureSqlNativeType", () => {
  const col = (name: string, maxLength: number, precision = 0, scale = 0) => ({
    name,
    maxLength,
    precision,
    scale,
  });

  it.each([
    [col("nvarchar", 200), "nvarchar(100)"],
    [col("nvarchar", -1), "nvarchar(max)"],
    [col("nchar", 20), "nchar(10)"],
    [col("varchar", 50), "varchar(50)"],
    [col("varchar", -1), "varchar(max)"],
    [col("char", 3), "char(3)"],
    [col("varbinary", -1), "varbinary(max)"],
    [col("binary", 16), "binary(16)"],
    [col("decimal", 9, 12, 2), "decimal(12,2)"],
    [col("numeric", 17, 38, 10), "numeric(38,10)"],
    [col("datetime2", 7, 23, 3), "datetime2(3)"],
    [col("datetimeoffset", 10, 32, 6), "datetimeoffset(6)"],
    [col("time", 5, 16, 7), "time(7)"],
    [col("int", 4, 10), "int"],
    [col("bigint", 8, 19), "bigint"],
    [col("float", 8, 53), "float"],
    [col("bit", 1, 1), "bit"],
    [col("datetime", 8, 23, 3), "datetime"],
    [col("uniqueidentifier", 16), "uniqueidentifier"],
  ])("%o is %s", (column, expected) => {
    expect(azureSqlNativeType(column)).toBe(expected);
  });
});
