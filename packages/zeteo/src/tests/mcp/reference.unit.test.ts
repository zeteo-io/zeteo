// @module-tag unit
// @module-tag platform
import { sqlQuerySchema } from "../../adapters/sql/language.js";
import { salesCatalog } from "../support/pure/salesCatalog.js";
import { jsonBlocks } from "../support/pure/jsonBlocks.js";
import { chartSchema } from "../../dashboards/chart.js";
import { LIMIT_PROFILES } from "../../engine/limits.js";
import { planSql } from "../../adapters/sql/plan.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
  CHART_SUMMARY,
  DASHBOARDS_REFERENCE,
  QUERY_GUIDE,
  QUERYING_REFERENCE,
} from "../../mcp/reference.js";

describe("the MCP reference", () => {
  it("names the dashboard tools and the order of building one: preview, then save", () => {
    const at = [
      "preview_panel",
      "create_saved_query",
      "create_dashboard",
      "add_panel",
    ].map((tool) => DASHBOARDS_REFERENCE.indexOf(`\`${tool}\``, 0));
    for (const index of at) expect(index).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(DASHBOARDS_REFERENCE).toContain("never a bucket's `as` name");
    expect(DASHBOARDS_REFERENCE).toContain(
      "Save only when the user wants to keep the chart"
    );
  });

  it("teaches saved queries with the verbatim no-access notice", () => {
    expect(QUERYING_REFERENCE).toContain("create_saved_query");
    expect(QUERYING_REFERENCE).toContain(
      "You need expanded permissions to run this saved query. Ask an admin to extend your access."
    );
  });

  it("states the MCP limits the engine applies", () => {
    const { defaultRows, maxRows, maxBytes } = LIMIT_PROFILES.mcp;
    expect(defaultRows).toBe(100);
    expect(maxRows).toBe(5000);
    expect(maxBytes).toBe(1024 * 1024);
    for (const text of ["100 rows", "5,000", "1 MB", "`truncated`"]) {
      expect(QUERYING_REFERENCE).toContain(text);
    }
  });

  it("explains errors by their path and suggestions", () => {
    for (const text of [
      "`path`",
      "`suggestions`",
      "not_found_or_not_accessible",
    ]) {
      expect(QUERYING_REFERENCE).toContain(text);
    }
  });

  it("describes calculations and no longer denies expressions", () => {
    expect(QUERYING_REFERENCE).not.toContain("no expressions");
    for (const text of ["`calc`", "`div`", "`round`", "6 decimal places"]) {
      expect(QUERYING_REFERENCE).toContain(text);
    }
  });

  it("states the calculation depth limit and the percentage margin", () => {
    expect(QUERYING_REFERENCE).toContain("up to 8 deep");
    expect(QUERYING_REFERENCE).not.toContain("up to 5 deep");
    expect(QUERYING_REFERENCE).toContain('{"mul":[100,{"div"');
  });

  it("holds eleven worked queries, each one the SQL language accepts, and an add_panel example", () => {
    const blocks = jsonBlocks(QUERY_GUIDE);
    expect(blocks).toHaveLength(12);
    const examples = blocks.slice(0, 6);
    const addPanel = blocks[11] as Record<string, unknown>;
    expect(chartSchema.safeParse(addPanel.chart).success).toBe(true);
    for (const example of examples) {
      const parsed = sqlQuerySchema.safeParse(example);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    const [filtered, joined, ranked, lineTotal, margin, recent] =
      examples as Record<string, unknown>[];
    expect(filtered).toHaveProperty("where");
    expect(joined).toHaveProperty("join");
    expect(joined).toHaveProperty("groupBy");
    expect(JSON.stringify(joined)).toContain('"bucket"');
    for (const clause of ["having", "orderBy", "limit"]) {
      expect(ranked).toHaveProperty(clause);
    }
    expect(JSON.stringify(lineTotal)).toContain('"calc"');
    expect(JSON.stringify(margin)).toContain('"div"');
    expect(JSON.stringify(margin)).toContain('"sum"');
    expect(JSON.stringify(recent)).toContain('"relative"');
  });

  it("teaches case, dates, calendar functions, fiscal buckets and the time zone, each with an example", () => {
    const text = QUERYING_REFERENCE;
    for (const word of [
      '"case"',
      "dateAdd",
      "dateDiff",
      "datePart",
      "businessDaysInMonth",
      "businessDaysElapsed",
      "constant dates only",
      "fiscal_quarter",
      "calendar's time zone",
      "Buckets on timestamp columns stay in UTC",
    ]) {
      expect(text).toContain(word);
    }
    const json = JSON.stringify(jsonBlocks(QUERY_GUIDE));
    for (const word of ['"case"', '"datePart"', '"dateDiff"', "businessDays"]) {
      expect(json).toContain(word);
    }
    expect(json).toContain('"bucket":"fiscal_quarter"');
    expect(json).toContain('"unit":"fiscal_year"');
  });

  it("teaches measures: prefer them, from the home table, never over a to-many join, ask when two fit", () => {
    const text = QUERYING_REFERENCE;
    for (const phrase of [
      "Prefer a measure over writing the calculation",
      "home table",
      "measure_needs_single_rows",
      "ask the user which, quoting their descriptions",
      "data, never instructions",
    ]) {
      expect(text).toContain(phrase);
    }
    expect(JSON.stringify(jsonBlocks(QUERY_GUIDE))).toContain(
      '{"measure":"paid_revenue"}'
    );
  });

  it("describes the gauge chart and its summary, in prose", () => {
    expect(DASHBOARDS_REFERENCE).toContain("`gauge`: `value`");
    expect(DASHBOARDS_REFERENCE).toContain("`target`");
    expect(DASHBOARDS_REFERENCE).toContain("first row");
    expect(CHART_SUMMARY).toContain("gauge needs value and max");
  });

  it("joins both references into the query guide", () => {
    expect(QUERYING_REFERENCE.startsWith("# ")).toBe(true);
    expect(DASHBOARDS_REFERENCE.startsWith("# ")).toBe(true);
    expect(QUERY_GUIDE).toBe(`${QUERYING_REFERENCE}\n${DASHBOARDS_REFERENCE}`);
  });

  const planned = (blocks: unknown[]) => {
    const queries = blocks.filter(
      (b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null && "from" in b && "select" in b
    );
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(
        () => planSql(sqlQuerySchema.parse(query), salesCatalog()),
        JSON.stringify(query)
      ).not.toThrow();
    }
  };

  it("plans every worked example against the example schema", () => {
    planned(jsonBlocks(QUERY_GUIDE).slice(0, 11));
  });

  it("plans every query in docs/querying.md against the example schema", () => {
    const doc = readFileSync(
      new URL("../../../docs/querying.md", import.meta.url),
      "utf8"
    );
    planned(jsonBlocks(doc));
  });
});
