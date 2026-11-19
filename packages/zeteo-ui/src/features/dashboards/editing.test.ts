import { describe, expect, it } from "vitest";
import {
  bucketColumn,
  defaultChart,
  fieldOf,
  suggestChart,
  timeColumnOptions,
} from "./editing";

const col = (name: string, type: string) => ({ name, type });

describe("suggestChart", () => {
  it("suggests a stat for one row with one number", () => {
    expect(suggestChart([col("total", "number")], 1)).toBe("stat");
  });
  it("suggests a line for a date or timestamp plus numbers", () => {
    expect(
      suggestChart([col("month", "timestamp"), col("revenue", "number")], 12)
    ).toBe("line");
  });
  it("suggests a bar for text plus a number", () => {
    expect(
      suggestChart([col("region", "text"), col("revenue", "number")], 4)
    ).toBe("bar");
  });
  it("suggests a table otherwise", () => {
    expect(suggestChart([col("name", "text"), col("email", "text")], 4)).toBe(
      "table"
    );
  });
});

describe("defaultChart", () => {
  it("fills a line from the time column and the numbers", () => {
    expect(
      defaultChart("line", [
        col("month", "date"),
        col("revenue", "number"),
        col("orders", "number"),
      ])
    ).toEqual({
      type: "line",
      version: 1,
      x: "month",
      y: ["revenue", "orders"],
    });
  });
});

describe("timeColumnOptions", () => {
  const catalog = {
    slug: "sales-db",
    tables: [
      {
        name: "orders",
        columns: [
          col("created_at", "timestamp"),
          col("total", "number"),
          { name: "old_at", type: "date", missing: true },
        ],
        relations: [{ name: "customers", to: "customers" }],
      },
      {
        name: "customers",
        columns: [col("signed_up", "date")],
        relations: [],
      },
    ],
  };

  it("offers the from table's and the joined tables' date columns", () => {
    expect(
      timeColumnOptions(
        {
          source: "sales-db",
          from: "orders",
          join: [{ relation: "customers" }],
        },
        catalog
      )
    ).toEqual(["created_at", "customers.signed_up"]);
  });

  it("offers nothing without a catalogue", () => {
    expect(timeColumnOptions({ from: "orders" }, undefined)).toEqual([]);
  });
});

describe("bucketColumn", () => {
  it("is the column behind a date bucket", () => {
    expect(
      bucketColumn({
        select: [
          { bucket: "month", column: "created_at", as: "month" },
          { sum: "total", as: "revenue" },
        ],
      })
    ).toBe("created_at");
  });
});

describe("fieldOf", () => {
  it("takes a list setting to its field", () => {
    expect(fieldOf("y.1")).toBe("y");
  });
});

describe("timeColumnOptions for a metric query", () => {
  it("offers range, the metric query's own time column", () => {
    expect(
      timeColumnOptions({ source: "s", metrics: ["margin_pct"] }, undefined)
    ).toEqual(["range"]);
    expect(
      timeColumnOptions(
        { source: "s", metrics: ["margin_pct"] },
        {
          slug: "s",
          tables: [],
        }
      )
    ).toEqual(["range"]);
  });
});
