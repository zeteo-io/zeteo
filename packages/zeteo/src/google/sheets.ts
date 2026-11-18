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
  "sheets.data(rowData.values(effectiveValue,effectiveFormat.numberFormat.type))";

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
 * yielded; every row is as wide as the tab's grid (`stageTable` trims the unused columns).
 */
async function* readTab(
  clientName: string,
  spreadsheetId: string,
  tab: { title: string; rowCount?: number; columnCount?: number },
  timeZone: string,
  limits: ParseLimits
): AsyncGenerator<Row> {
  const quoted = `'${tab.title.replaceAll("'", "''")}'`;
  const gridCols = tab.columnCount ?? 26;
  const lastColumn = columnLetters(gridCols);
  const rowCount = tab.rowCount ?? 0;
  const line = (row: Row): Row =>
    Array.from({ length: gridCols }, (_, i) => row[i] ?? null);
  let pendingEmpty = 0;
  let emitted = 0;
  for (let start = 1; start <= rowCount; start += CHUNK_ROWS) {
    const end = Math.min(start + CHUNK_ROWS - 1, rowCount);
    const response: Spreadsheet = await call(() =>
      sheetsApi.getSpreadsheet(clientName, spreadsheetId, {
        ranges: [`${quoted}!A${start}:${lastColumn}${end}`],
        includeGridData: true,
        fields: GRID_FIELDS,
      })
    );
    // Google leaves out the trailing empty rows of the range (and each row's trailing empty cells).
    const rowData = response.sheets?.[0]?.data?.[0]?.rowData ?? [];
    for (const data of rowData) {
      const row = (data.values ?? []).map((cell) => cellText(cell, timeZone));
      if (!row.some((c) => c !== null)) {
        pendingEmpty += 1;
        continue;
      }
      for (; pendingEmpty > 0; pendingEmpty -= 1) {
        emitted += 1;
        if (emitted > limits.maxRows + 1) throw tooManyRows(limits);
        yield line([]);
      }
      emitted += 1;
      if (emitted > limits.maxRows + 1) throw tooManyRows(limits);
      yield line(row);
    }
    // The rows Google left out at the end of the range are empty too.
    pendingEmpty += Math.max(0, end - start + 1 - rowData.length);
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
