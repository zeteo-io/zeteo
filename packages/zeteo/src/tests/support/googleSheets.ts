import { readSpreadsheet } from "../../google/sheets.js";
import { stageSheets } from "../../uploads/staging.js";
import env from "../../env.js";

/**
 * A spreadsheet Google would serve, for tests that mock `google/handler.js`:
 * `serve` answers `sheetsApi.getSpreadsheet` from it. Change `tabs` (titles,
 * order, rows) between calls to change what the next read sees; set
 * `failWith` to a plugin error code (`GGL_0009`: not shared) to fail every read.
 */
export interface FakeTab {
  sheetId: number;
  title: string;
  /** Cell text, null for an empty cell; the header is the first row. */
  rows: (string | null)[][];
}

export class FakeSpreadsheet {
  tabs: FakeTab[];
  failWith: string | null = null;

  constructor(
    readonly id: string,
    tabs: FakeTab[],
    readonly title = "Book"
  ) {
    this.tabs = tabs;
  }

  tab(sheetId: number): FakeTab {
    const tab = this.tabs.find((t) => t.sheetId === sheetId);
    if (!tab) throw new Error(`no tab ${sheetId}`);
    return tab;
  }

  /** `sheetsApi.getSpreadsheet` as Google would answer it for this spreadsheet. */
  answer(params: { ranges?: string[] }) {
    if (this.failWith) {
      throw Object.assign(new Error("plugin error"), { code: this.failWith });
    }
    if (!params.ranges) {
      return {
        properties: { title: this.title, timeZone: "UTC" },
        sheets: this.tabs.map((t, index) => ({
          properties: {
            sheetId: t.sheetId,
            title: t.title,
            index,
            sheetType: "GRID",
            gridProperties: {
              rowCount: t.rows.length + 5,
              columnCount: Math.max(1, ...t.rows.map((r) => r.length)),
            },
          },
        })),
      };
    }
    const match = /^'(.*)'!A(\d+):[A-Z]+(\d+)$/.exec(params.ranges[0]!)!;
    const title = match[1]!.replaceAll("''", "'");
    const tab = this.tabs.find((t) => t.title === title)!;
    const rows = tab.rows.slice(Number(match[2]) - 1, Number(match[3]));
    return {
      sheets: [
        {
          data: [
            {
              rowData: rows.map((r) => ({
                values: r.map((v) =>
                  v === null ? {} : { effectiveValue: { stringValue: v } }
                ),
              })),
            },
          ],
        },
      ],
    };
  }
}

/** The mocks a test file hands `google/handler.js`'s mock. */
export interface GoogleMocks {
  googleClient: { mockResolvedValue: (v: string) => unknown };
  getSpreadsheet: {
    mockImplementation: (fn: (...args: never[]) => unknown) => unknown;
  };
}

/** Serves `sheets` (by spreadsheet id) through the handler mocks. */
export const serveSheets = (
  mocks: GoogleMocks,
  sheets: Map<string, FakeSpreadsheet>
) => {
  mocks.googleClient.mockResolvedValue("google:_:main");
  mocks.getSpreadsheet.mockImplementation(((
    _client: string,
    id: string,
    params: { ranges?: string[] }
  ) => {
    const sheet = sheets.get(id);
    if (!sheet) {
      throw Object.assign(new Error("plugin error"), { code: "GGL_0009" });
    }
    return Promise.resolve().then(() => sheet.answer(params));
  }) as never);
};

/** Reads `sheet` through the (mocked) Google reader and stages it for `ownerId`. */
export const stageFakeSheet = async (
  ownerId: string,
  sheet: FakeSpreadsheet
) => {
  const read = await readSpreadsheet(sheet.id, {
    maxRows: env.UPLOAD_MAX_ROWS,
    maxColumns: env.UPLOAD_MAX_COLUMNS,
  });
  return stageSheets({ ownerId, spreadsheet: { id: sheet.id, ...read } });
};
