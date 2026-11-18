import type { PreviewTable, Staging } from "./api/types";
import { makeSource } from "../testFixtures";
import type { Source } from "../api/types";
import { TEST_ME } from "@/test/authMock";

export const FS_ID = "f1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const TABLE_ID = "f2222222-1c7a-4a53-9d0e-6a3b1f2c4d02";
export const AMOUNT_ID = "f3333333-1c7a-4a53-9d0e-6a3b1f2c4d03";
export const REGION_ID = "f4444444-1c7a-4a53-9d0e-6a3b1f2c4d04";
export const STAGING_ID = "f5555555-1c7a-4a53-9d0e-6a3b1f2c4d05";

/** An upload source as `GET /v1/sources/:id` gives it. */
export const makeUploadSource = (over: Partial<Source> = {}): Source =>
  makeSource({
    id: FS_ID,
    slug: "q3-sales",
    name: "Q3 sales",
    type: "upload",
    settings: null,
    schemas: [],
    owner_id: TEST_ME.id,
    last_refreshed_at: null,
    size_bytes: 2_500_000,
    size_measured_at: null,
    share_count: 2,
    created_at: "2026-11-10T10:00:00.000Z",
    ...over,
  });

export interface UploadColumn {
  id: string;
  name: string;
  original_name: string | null;
  type: string;
  description: string | null;
  missing?: boolean;
}

/** An upload's table, from which the catalogue's answers are made. */
export interface UploadTable {
  id: string;
  name: string;
  description: string | null;
  row_count: number;
  last_loaded_at: string | null;
  missing?: boolean;
  columns: UploadColumn[];
}

export const ordersTable = (): UploadTable => ({
  id: TABLE_ID,
  name: "orders",
  description: "Orders of the quarter",
  row_count: 1234,
  last_loaded_at: "2026-11-15T09:30:00.000Z",
  columns: [
    {
      id: REGION_ID,
      name: "region",
      original_name: "Region",
      type: "text",
      description: null,
    },
    {
      id: AMOUNT_ID,
      name: "amount",
      original_name: "Amount (EUR)",
      type: "number",
      description: "Order total",
    },
  ],
});

export const makePreviewTable = (
  over: Partial<PreviewTable> = {}
): PreviewTable => ({
  key: "sheet:Orders",
  name: "orders",
  kind: "sheet",
  header_row: 0,
  row_count: 3,
  columns: [
    {
      index: 0,
      name: "region",
      original_name: "Region",
      type: "text",
      samples: ["North", "South"],
    },
    {
      index: 1,
      name: "zip",
      original_name: "ZIP",
      type: "number",
      samples: ["1000", "2000"],
    },
  ],
  warnings: [],
  ...over,
});

export const makeStaging = (tables?: PreviewTable[]): Staging => ({
  staging_id: STAGING_ID,
  expires_at: "2026-11-17T12:00:00.000Z",
  tables: tables ?? [
    makePreviewTable(),
    makePreviewTable({
      key: "sheet:Notes",
      name: "notes",
      columns: [
        {
          index: 0,
          name: "note",
          original_name: "Note",
          type: "text",
          samples: ["hello"],
        },
      ],
      warnings: ['Column "note" has no values in its first rows.'],
    }),
  ],
});

/**
 * The catalogue's answers for an upload's tables (`GET /v1/sources/:id/tables`
 * and `.../tables/:tableId`) and the source itself (`GET /v1/sources/:id`);
 * undefined for any other URL.
 */
export const catalogueOf = (
  source: Source,
  tables: UploadTable[],
  url: string,
  config?: { params?: { include_missing?: boolean } }
) => {
  const base = `/v1/sources/${source.id}/tables`;
  const tableOf = (t: UploadTable) => ({
    id: t.id,
    source_id: source.id,
    schema_name: "zu_x",
    name: t.name,
    kind: "table" as const,
    description: t.description,
    last_seen_at: "2026-11-15T09:30:00.000Z",
    missing_since: t.missing ? "2026-11-15T09:30:00.000Z" : null,
    row_count: t.row_count,
    last_loaded_at: t.last_loaded_at,
  });
  if (url === `/v1/sources/${source.id}`) return { data: source };
  if (url === base) {
    const listed = config?.params?.include_missing
      ? tables
      : tables.filter((t) => !t.missing);
    return { data: { data: listed.map(tableOf), next_cursor: null } };
  }
  const table = tables.find((t) => url === `${base}/${t.id}`);
  if (!table) return undefined;
  return {
    data: {
      ...tableOf(table),
      columns: table.columns.map((c, i) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        native_type: c.type,
        nullable: true,
        position: i + 1,
        is_primary_key: false,
        description: c.description,
        missing_since: c.missing ? "2026-11-15T09:30:00.000Z" : null,
        original_name: c.original_name,
      })),
      relations: [],
    },
  };
};

/**
 * A `get` mock for an upload's pages: `own` answers first (undefined to
 * pass), then the source and its catalogue, then an empty page.
 */
export const uploadGet =
  (
    source: () => Source = makeUploadSource,
    tables: () => UploadTable[] = () => [ordersTable()],
    own?: (url: string) => unknown
  ) =>
  async (url: string, config?: { params?: { include_missing?: boolean } }) =>
    own?.(url) ??
    catalogueOf(source(), tables(), url, config) ?? {
      data: { data: [], next_cursor: null },
    };

export const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
export const ROBOT_EMAIL = "zeteo@proj.iam.gserviceaccount.com";

/** A Google Sheets source as `GET /v1/sources/:id` gives its owner. */
export const makeSheetsSource = (over: Partial<Source> = {}): Source =>
  makeUploadSource({
    type: "google-sheets",
    name: "Budget sheet",
    slug: "budget-sheet",
    last_refreshed_at: "2026-11-18T08:00:00.000Z",
    sheet: {
      spreadsheet_id: SHEET_ID,
      url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}`,
    },
    sync: {
      interval_minutes: 60,
      last_attempt_at: "2026-11-18T08:00:00.000Z",
      last_error: null,
      stale: false,
    },
    ...over,
  });

/** What `POST /v1/uploads/links` answers. */
export const makeSheetStaging = (tables?: PreviewTable[]) => ({
  ...makeStaging(tables),
  spreadsheet: { id: SHEET_ID, title: "Budget 2027" },
});

/** The Google connection `GET /v1/connections/google` answers. */
export const GOOGLE_CONNECTION = {
  provider: "google" as const,
  service_account_email: ROBOT_EMAIL,
  updated_at: "2026-11-10T10:00:00.000Z",
  updated_by: TEST_ME.id,
};
