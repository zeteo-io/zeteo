import type { FileSource, PreviewTable, Staging } from "./api/types";
import { TEST_ME } from "@/test/authMock";

export const FS_ID = "f1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const TABLE_ID = "f2222222-1c7a-4a53-9d0e-6a3b1f2c4d02";
export const AMOUNT_ID = "f3333333-1c7a-4a53-9d0e-6a3b1f2c4d03";
export const REGION_ID = "f4444444-1c7a-4a53-9d0e-6a3b1f2c4d04";
export const STAGING_ID = "f5555555-1c7a-4a53-9d0e-6a3b1f2c4d05";

export const makeFileSource = (over: Partial<FileSource> = {}): FileSource => ({
  id: FS_ID,
  slug: "q3-sales",
  name: "Q3 sales",
  type: "upload",
  owner_id: TEST_ME.id,
  created_at: "2026-11-10T10:00:00.000Z",
  archived_at: null,
  stored_bytes: 2_500_000,
  tables: [
    {
      id: TABLE_ID,
      name: "orders",
      row_count: 1234,
      last_synced_at: "2026-11-15T09:30:00.000Z",
      missing: false,
      columns: [
        {
          id: REGION_ID,
          name: "region",
          original_name: "Region",
          type: "text",
          description: null,
          missing: false,
        },
        {
          id: AMOUNT_ID,
          name: "amount",
          original_name: "Amount (EUR)",
          type: "number",
          description: "Order total",
          missing: false,
        },
      ],
    },
  ],
  ...over,
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
