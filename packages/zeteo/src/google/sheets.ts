import { readGoogleConnectionView } from "./connectionStore.js";
import type { Spreadsheet } from "@dianemo/plugin-google";
import { googleClient, sheetsApi } from "./handler.js";
import { logger } from "../utils/logger.js";
import { cellText } from "./cells.js";
import {
  FileParseError,
  type ParsedSheet,
  type ParseLimits,
  type Row,
} from "../uploads/parse/types.js";
import {
  GoogleSignInFailedError,
  GoogleUnavailableError,
  SheetNotAccessibleError,
} from "../utils/errors.js";

/** Rows asked of Google per request. */
const CHUNK_ROWS = 5000;
const SPREADSHEET_FIELDS =
  "properties(title,timeZone),sheets.properties(sheetId,title,index,sheetType,gridProperties)";
const GRID_FIELDS =
  "sheets.data(startRow,rowData.values(effectiveValue,effectiveFormat.numberFormat.type))";

export type SpreadsheetTab = ParsedSheet & { sheetId: number };

/**
 * The plugin's failure as Zeteo's: `GGL_0009` (the account may not read it, or it does not
 * exist) is `sheet_not_accessible`, `GGL_0013` (Google refused the key at sign-in)
 * `google_sign_in_failed`, anything else `google_unavailable`. Nothing of the plugin's error
 * is kept; only its code and status are logged.
 */
const mapPluginError = async (err: unknown): Promise<Error> => {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    code?: unknown;
    statusCode?: unknown;
    metadata?: { status?: unknown };
  };
  const code = typeof e.code === "string" ? e.code : undefined;
  if (code === "GGL_0009") {
    const view = await readGoogleConnectionView().catch(() => null);
    return new SheetNotAccessibleError(
      view?.serviceAccountEmail ?? "the Google service account"
    );
  }
  if (code === "GGL_0013") return new GoogleSignInFailedError();
  logger.warn(
    { code, statusCode: e.statusCode, status: e.metadata?.status },
    "Reading a Google spreadsheet failed"
  );
  return new GoogleUnavailableError();
};

const call = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (err) {
    throw await mapPluginError(err);
  }
};

/** `1` is `A`, `27` is `AA`. */
const columnLetters = (n: number): string => {
  let out = "";
  for (let c = Math.max(1, n); c > 0; c = Math.floor((c - 1) / 26)) {
    out = String.fromCharCode(65 + ((c - 1) % 26)) + out;
  }
  return out;
};

const validZone = (zone: string | undefined): zone is string => {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const tooManyRows = (limits: ParseLimits) =>
  new FileParseError(
    "too_many_rows",
    `A sheet has more than ${limits.maxRows} rows.`
  );

/**
 * One tab's rows, read from Google `CHUNK_ROWS` at a time. Trailing empty rows are not
 * yielded and columns are trimmed to the widest row of the first chunk holding data (a
 * stream cannot know a later width, so a value past it fails the read rather than being lost).
 */
async function* readTab(
  clientName: string,
  spreadsheetId: string,
  tab: { title: string; rowCount?: number; columnCount?: number },
  timeZone: string,
  limits: ParseLimits
): AsyncGenerator<Row> {
  const quoted = `'${tab.title.replaceAll("'", "''")}'`;
  const lastColumn = columnLetters(tab.columnCount ?? 26);
  let width: number | undefined;
  let pendingEmpty = 0;
  let emitted = 0;
  for (let start = 1; tab.rowCount === undefined || start <= tab.rowCount;) {
    const end = start + CHUNK_ROWS - 1;
    const response: Spreadsheet = await call(() =>
      sheetsApi.getSpreadsheet(clientName, spreadsheetId, {
        ranges: [`${quoted}!A${start}:${lastColumn}${end}`],
        includeGridData: true,
        fields: GRID_FIELDS,
      })
    );
    const rowData = response.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const rows = rowData.map((r) =>
      (r.values ?? []).map((cell) => cellText(cell, timeZone))
    );
    const chunkWidth = rows.reduce((max, row) => {
      let last = row.length;
      while (last > 0 && row[last - 1] === null) last -= 1;
      return Math.max(max, last);
    }, 0);
    if (width === undefined) {
      if (chunkWidth > 0) width = chunkWidth;
    } else if (chunkWidth > width) {
      throw new FileParseError(
        "malformed_xlsx",
        `A column to the right of the first rows of "${tab.title}" holds data further down; move the data or clear the column.`
      );
    }
    for (const row of rows) {
      if (
        width === undefined ||
        chunkWidth === 0 ||
        !row.some((c) => c !== null)
      ) {
        pendingEmpty += 1;
        continue;
      }
      const line = (row: Row): Row =>
        Array.from({ length: width! }, (_, i) => row[i] ?? null);
      for (; pendingEmpty > 0; pendingEmpty -= 1) {
        emitted += 1;
        if (emitted > limits.maxRows + 1) throw tooManyRows(limits);
        yield line([]);
      }
      emitted += 1;
      if (emitted > limits.maxRows + 1) throw tooManyRows(limits);
      yield line(row);
    }
    if (rowData.length < CHUNK_ROWS) return;
    start = end + 1;
  }
}

/**
 * The tabs of a spreadsheet as typed text rows: grid tabs only (charts are skipped), in tab
 * order, `only` limiting them to those sheetIds. A tab wider than `limits.maxColumns` is
 * refused before any row is read; each tab's `rows` reads from Google as it is consumed, so
 * nothing holds a whole tab. Google's failures are `sheet_not_accessible` (the service account
 * may not read it), `google_sign_in_failed` or `google_unavailable`.
 */
export const readSpreadsheet = async (
  spreadsheetId: string,
  limits: ParseLimits,
  only?: number[]
): Promise<{ title: string; tabs: SpreadsheetTab[] }> => {
  const clientName = await googleClient();
  const meta: Spreadsheet = await call(() =>
    sheetsApi.getSpreadsheet(clientName, spreadsheetId, {
      fields: SPREADSHEET_FIELDS,
    })
  );
  let timeZone = meta.properties?.timeZone;
  if (!validZone(timeZone)) {
    logger.warn(
      { hasTimeZone: timeZone !== undefined },
      "A spreadsheet's time zone is missing or unknown; reading its date-times as UTC"
    );
    timeZone = "UTC";
  }
  const zone = timeZone;
  const grids = (meta.sheets ?? [])
    .map((s) => s.properties)
    .filter((p) => p?.sheetType === "GRID" && p.sheetId !== undefined)
    .filter((p) => !only || only.includes(p!.sheetId!))
    .sort((a, b) => (a!.index ?? 0) - (b!.index ?? 0));
  for (const p of grids) {
    if ((p!.gridProperties?.columnCount ?? 0) > limits.maxColumns) {
      throw new FileParseError(
        "too_many_columns",
        `A sheet has more than ${limits.maxColumns} columns.`
      );
    }
  }
  return {
    title: meta.properties?.title ?? "",
    tabs: grids.map((p) => ({
      sheetId: p!.sheetId!,
      name: p!.title ?? "",
      kind: "sheet" as const,
      rows: readTab(
        clientName,
        spreadsheetId,
        {
          title: p!.title ?? "",
          rowCount: p!.gridProperties?.rowCount,
          columnCount: p!.gridProperties?.columnCount,
        },
        zone,
        limits
      ),
    })),
  };
};
