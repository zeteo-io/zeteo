import type { Source } from "./api/types";

export const SOURCE_ID = "5f0c8f0e-1c7a-4a53-9d0e-6a3b1f2c4d55";

export const makeSource = (over: Partial<Source> = {}): Source => ({
  id: SOURCE_ID,
  slug: "orders",
  name: "Orders DB",
  description: "",
  type: "postgres",
  settings: {
    host: "db.example.test",
    port: 5432,
    database: "orders",
    user: "reader",
    tls: "verify",
  },
  schemas: ["public"],
  timeout_ms: 30000,
  row_cap: 50000,
  export_enabled: false,
  export_row_cap: 0,
  query_concurrency: 5,
  export_concurrency: 2,
  writable_login_allowed: false,
  owner_id: null,
  status: "active",
  last_refreshed_at: "2026-11-01T10:00:00.000Z",
  size_bytes: 5_000_000,
  size_measured_at: "2026-11-01T10:00:00.000Z",
  share_count: 0,
  created_at: "2026-10-01T10:00:00.000Z",
  archived_at: null,
  ...over,
});
