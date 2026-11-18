// @module-tag unit
// @module-tag platform
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Row } from "../../uploads/parse/types.js";

const getSpreadsheet = vi.fn();
const warn = vi.fn();

vi.mock("../../google/handler.js", () => ({
  googleClient: vi.fn(async () => "google:_:main"),
  sheetsApi: {
    getSpreadsheet: (...args: unknown[]) => getSpreadsheet(...args),
  },
}));
vi.mock("../../google/connectionStore.js", () => ({
  readGoogleConnectionView: vi.fn(async () => ({
    serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
  })),
}));
vi.mock("../../utils/logger.js", () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), error: vi.fn() },
}));

const { readSpreadsheet } = await import("../../google/sheets.js");

const LIMITS = { maxRows: 100_000, maxColumns: 50 };

const str = (stringValue: string) => ({ effectiveValue: { stringValue } });
const num = (numberValue: number) => ({ effectiveValue: { numberValue } });

const meta = (
  sheets: {
    sheetId: number;
    title: string;
    index: number;
    sheetType?: string;
    rows?: number;
    cols?: number;
  }[],
  timeZone: string | null = "UTC"
) => ({
  properties: { title: "Budget", ...(timeZone ? { timeZone } : {}) },
  sheets: sheets.map((s) => ({
    properties: {
      sheetId: s.sheetId,
      title: s.title,
      index: s.index,
      sheetType: s.sheetType ?? "GRID",
      gridProperties: { rowCount: s.rows ?? 1000, columnCount: s.cols ?? 26 },
    },
  })),
});

const isEmpty = (cell: unknown) =>
  !cell || Object.keys(cell as object).length === 0;
/** A response as Google makes it: no trailing empty cells in a row, no trailing empty rows. */
const chunk = (_startRow: number, rows: unknown[][]) => {
  const trimmed = rows.map((values) => {
    const v = [...values];
    while (v.length > 0 && isEmpty(v[v.length - 1])) v.pop();
    return v;
  });
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.length === 0) {
    trimmed.pop();
  }
  return {
    sheets: [{ data: [{ rowData: trimmed.map((values) => ({ values })) }] }],
  };
};

const collect = async (rows: AsyncIterable<Row> | Row[]) => {
  const out: Row[] = [];
  for await (const row of rows) out.push(row);
  return out;
};

const pluginError = (code: string) =>
  Object.assign(new Error("plugin failed, secret detail"), {
    code,
    statusCode: 403,
    metadata: { status: "PERMISSION_DENIED", secret: "do-not-leak" },
  });

beforeEach(() => {
  getSpreadsheet.mockReset();
  warn.mockReset();
});

describe("readSpreadsheet", () => {
  it("skips chart tabs and orders tabs by index", async () => {
    getSpreadsheet.mockResolvedValueOnce(
      meta([
        { sheetId: 2, title: "B", index: 1 },
        { sheetId: 9, title: "Chart", index: 2, sheetType: "OBJECT" },
        { sheetId: 1, title: "A", index: 0 },
      ])
    );
    const result = await readSpreadsheet("id", LIMITS);
    expect(result.title).toBe("Budget");
    expect(result.tabs.map((t) => [t.sheetId, t.name, t.kind])).toEqual([
      [1, "A", "sheet"],
      [2, "B", "sheet"],
    ]);
    expect(getSpreadsheet).toHaveBeenCalledTimes(1);
    expect(getSpreadsheet.mock.calls[0]).toEqual([
      "google:_:main",
      "id",
      {
        fields:
          "properties(title,timeZone),sheets.properties(sheetId,title,index,sheetType,gridProperties)",
      },
    ]);
  });

  it("filters by sheetId with only", async () => {
    getSpreadsheet.mockResolvedValueOnce(
      meta([
        { sheetId: 1, title: "A", index: 0 },
        { sheetId: 2, title: "B", index: 1 },
      ])
    );
    const result = await readSpreadsheet("id", LIMITS, [2]);
    expect(result.tabs.map((t) => t.sheetId)).toEqual([2]);
  });

  it("a 1000x26 grid with 3 data rows yields 3 rows as wide as the grid", async () => {
    getSpreadsheet
      .mockResolvedValueOnce(meta([{ sheetId: 1, title: "Costs", index: 0 }]))
      .mockResolvedValueOnce(
        chunk(0, [
          [str("item"), str("amount"), str("paid"), str("when")],
          [str("rent"), num(1200), { effectiveValue: { boolValue: true } }, {}],
          [
            str("food"),
            num(300.5),
            {},
            {
              effectiveValue: { numberValue: 45292 },
              effectiveFormat: { numberFormat: { type: "DATE" } },
            },
          ],
          [],
          [{}, {}],
          ...Array.from({ length: 995 }, () => []),
        ])
      );
    const result = await readSpreadsheet("id", LIMITS);
    const rows = await collect(result.tabs[0]!.rows);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.length === 26)).toBe(true);
    expect(rows.map((r) => r.slice(0, 4))).toEqual([
      ["item", "amount", "paid", "when"],
      ["rent", "1200", "true", null],
      ["food", "300.5", null, "2024-01-01"],
    ]);
    expect(rows.flatMap((r) => r.slice(4)).every((c) => c === null)).toBe(true);
    expect(getSpreadsheet).toHaveBeenCalledTimes(2);
  });

  it("reads 12,000 rows in three chunks", async () => {
    getSpreadsheet.mockResolvedValueOnce(
      meta([{ sheetId: 1, title: "Big", index: 0, rows: 12_000, cols: 1 }])
    );
    const rowsOf = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => [str(`r${from + i}`)]);
    getSpreadsheet
      .mockResolvedValueOnce(chunk(0, rowsOf(0, 5000)))
      .mockResolvedValueOnce(chunk(5000, rowsOf(5000, 5000)))
      .mockResolvedValueOnce(chunk(10_000, rowsOf(10_000, 2000)));
    const result = await readSpreadsheet("id", LIMITS);
    const rows = await collect(result.tabs[0]!.rows);
    expect(rows).toHaveLength(12_000);
    expect(rows[11_999]).toEqual(["r11999"]);
    expect(getSpreadsheet).toHaveBeenCalledTimes(4);
    const calls = getSpreadsheet.mock.calls.slice(1);
    expect(calls.map((c) => c[2].ranges)).toEqual([
      ["'Big'!A1:A5000"],
      ["'Big'!A5001:A10000"],
      ["'Big'!A10001:A12000"],
    ]);
    expect(calls[0]![2]).toMatchObject({
      includeGridData: true,
      fields:
        "sheets.data(rowData.values(effectiveValue,effectiveFormat.numberFormat.type))",
    });
  });

  it("stops at the grid's last row without asking for more", async () => {
    getSpreadsheet.mockResolvedValueOnce(
      meta([{ sheetId: 1, title: "Full", index: 0, rows: 5000, cols: 1 }])
    );
    getSpreadsheet.mockResolvedValueOnce(
      chunk(
        0,
        Array.from({ length: 5000 }, () => [str("x")])
      )
    );
    const result = await readSpreadsheet("id", LIMITS);
    expect(await collect(result.tabs[0]!.rows)).toHaveLength(5000);
    expect(getSpreadsheet).toHaveBeenCalledTimes(2);
  });

  it("quotes a tab title containing an apostrophe", async () => {
    getSpreadsheet
      .mockResolvedValueOnce(
        meta([{ sheetId: 1, title: "Bob's costs", index: 0, cols: 3 }])
      )
      .mockResolvedValueOnce(chunk(0, [[str("a")]]));
    const result = await readSpreadsheet("id", LIMITS);
    await collect(result.tabs[0]!.rows);
    expect(getSpreadsheet.mock.calls[1]![2].ranges).toEqual([
      "'Bob''s costs'!A1:C1000",
    ]);
  });

  it("refuses a tab wider than maxColumns before reading its rows", async () => {
    getSpreadsheet.mockResolvedValueOnce(
      meta([{ sheetId: 1, title: "Wide", index: 0, cols: 51 }])
    );
    await expect(readSpreadsheet("id", LIMITS)).rejects.toMatchObject({
      code: "too_many_columns",
    });
    expect(getSpreadsheet).toHaveBeenCalledTimes(1);
  });

  it("throws too_many_rows past maxRows data rows", async () => {
    getSpreadsheet
      .mockResolvedValueOnce(
        meta([{ sheetId: 1, title: "T", index: 0, cols: 1 }])
      )
      .mockResolvedValueOnce(
        chunk(
          0,
          Array.from({ length: 5 }, () => [str("x")])
        )
      );
    const result = await readSpreadsheet("id", { maxRows: 3, maxColumns: 5 });
    await expect(collect(result.tabs[0]!.rows)).rejects.toMatchObject({
      code: "too_many_rows",
    });
  });

  it("403 becomes sheet_not_accessible naming the service account", async () => {
    getSpreadsheet.mockRejectedValueOnce(pluginError("GGL_0009"));
    const err = await readSpreadsheet("id", LIMITS).catch((e: unknown) => e);
    expect(err).toMatchObject({
      statusCode: 422,
      code: "sheet_not_accessible",
      message:
        "Zeteo can't read this spreadsheet. Share it with sa@proj.iam.gserviceaccount.com as a Viewer.",
    });
    expect(JSON.stringify(err)).not.toContain("do-not-leak");
  });

  it("a refused sign-in is google_sign_in_failed; any other failure is google_unavailable", async () => {
    getSpreadsheet.mockRejectedValueOnce(pluginError("GGL_0013"));
    await expect(readSpreadsheet("id", LIMITS)).rejects.toMatchObject({
      code: "google_sign_in_failed",
    });
    getSpreadsheet.mockRejectedValueOnce(pluginError("GGL_0011"));
    await expect(readSpreadsheet("id", LIMITS)).rejects.toMatchObject({
      statusCode: 502,
      code: "google_unavailable",
    });
    getSpreadsheet.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(readSpreadsheet("id", LIMITS)).rejects.toMatchObject({
      code: "google_unavailable",
    });
  });

  it("maps a failure while reading a chunk the same way", async () => {
    getSpreadsheet
      .mockResolvedValueOnce(
        meta([{ sheetId: 1, title: "T", index: 0, cols: 1 }])
      )
      .mockRejectedValueOnce(pluginError("GGL_0009"));
    const result = await readSpreadsheet("id", LIMITS);
    await expect(collect(result.tabs[0]!.rows)).rejects.toMatchObject({
      code: "sheet_not_accessible",
    });
  });

  it.each([
    ["missing", null],
    ["rejected", "Mars/Olympus"],
  ])("a %s time zone reads as UTC and logs a warning", async (_, zone) => {
    const dateTime = {
      effectiveValue: { numberValue: 45292.75 },
      effectiveFormat: { numberFormat: { type: "DATE_TIME" } },
    };
    getSpreadsheet
      .mockResolvedValueOnce(
        meta([{ sheetId: 1, title: "T", index: 0, cols: 1 }], zone)
      )
      .mockResolvedValueOnce(chunk(0, [[dateTime]]));
    const result = await readSpreadsheet("id", LIMITS);
    expect(await collect(result.tabs[0]!.rows)).toEqual([
      ["2024-01-01T18:00:00.000Z"],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("45292");
  });

  it("does not stop at a short chunk: blank rows at a chunk's end drop nothing", async () => {
    getSpreadsheet.mockResolvedValueOnce(
      meta([{ sheetId: 1, title: "T", index: 0, rows: 6000, cols: 1 }])
    );
    // Rows 4,991-5,000 are blank, so Google returns 4,990 entries.
    getSpreadsheet
      .mockResolvedValueOnce(
        chunk(
          0,
          Array.from({ length: 4990 }, (_, i) => [str(`r${i}`)])
        )
      )
      .mockResolvedValueOnce(chunk(5000, [[str("later")], [str("last")]]));
    const result = await readSpreadsheet("id", LIMITS);
    const rows = await collect(result.tabs[0]!.rows);
    expect(rows).toHaveLength(5002);
    expect(rows[4989]).toEqual(["r4989"]);
    expect(rows[4990]).toEqual([null]);
    expect(rows[5000]).toEqual(["later"]);
    expect(rows[5001]).toEqual(["last"]);
    expect(getSpreadsheet.mock.calls.slice(1).map((c) => c[2].ranges)).toEqual([
      ["'T'!A1:A5000"],
      ["'T'!A5001:A6000"],
    ]);
  });

  it("a later row wider than the first loads at the grid's width", async () => {
    getSpreadsheet.mockResolvedValueOnce(
      meta([{ sheetId: 1, title: "T", index: 0, rows: 6000, cols: 3 }])
    );
    getSpreadsheet
      .mockResolvedValueOnce(
        chunk(
          0,
          Array.from({ length: 5000 }, () => [str("a")])
        )
      )
      .mockResolvedValueOnce(chunk(5000, [[str("a"), str("b"), str("c")]]));
    const result = await readSpreadsheet("id", LIMITS);
    const rows = await collect(result.tabs[0]!.rows);
    expect(rows).toHaveLength(5001);
    expect(rows[0]).toEqual(["a", null, null]);
    expect(rows[5000]).toEqual(["a", "b", "c"]);
  });

  it("a tab without a rowCount has no rows and makes no request", async () => {
    getSpreadsheet.mockResolvedValueOnce({
      properties: { title: "B", timeZone: "UTC" },
      sheets: [
        {
          properties: {
            sheetId: 1,
            title: "T",
            index: 0,
            sheetType: "GRID",
            gridProperties: { columnCount: 3 },
          },
        },
      ],
    });
    const result = await readSpreadsheet("id", LIMITS);
    expect(await collect(result.tabs[0]!.rows)).toEqual([]);
    expect(getSpreadsheet).toHaveBeenCalledTimes(1);
  });
});
