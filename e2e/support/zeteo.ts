import { expectJson, requestJson } from "./http.js";
import { stack } from "./stack.js";

/** The source's settings for the run's TLS Postgres; `tls` and `ca` vary per case. */
export const sourceSettings = (
  tls: "verify" | "require" | "off",
  ca?: string
) => ({
  host: "source-pg",
  port: 5432,
  database: "source",
  user: "zeteo_ro",
  password: stack.sourceReaderPassword,
  tls,
  ...(ca !== undefined && { ca }),
});

/** `POST /v1/sources` on `baseUrl`, for the run's source database. */
export const registerSource = (
  baseUrl: string,
  token: string,
  slug: string,
  settings: ReturnType<typeof sourceSettings>
) =>
  requestJson("POST", `${baseUrl}/v1/sources`, {
    token,
    body: {
      slug,
      name: slug,
      type: "postgres",
      settings,
      schemas: ["sales"],
      export_enabled: true,
      export_row_cap: 1000,
    },
  });

/** The ids of a source's tables, by bare name. */
export const tableIds = async (
  baseUrl: string,
  token: string,
  sourceId: string
): Promise<Record<string, string>> => {
  const page = await expectJson(
    200,
    "GET",
    `${baseUrl}/v1/sources/${sourceId}/tables`,
    { token }
  );
  return Object.fromEntries(
    (page.data as Array<{ id: string; name: string }>).map((t) => [
      t.name,
      t.id,
    ])
  );
};

/** An all-columns grant of `tableId` to a user or group; returns the grant. */
export const grantTable = (
  baseUrl: string,
  token: string,
  principal: { type: "user" | "group"; id: string },
  tableId: string
) =>
  expectJson(201, "POST", `${baseUrl}/v1/grants`, {
    token,
    body: {
      principal_type: principal.type,
      principal_id: principal.id,
      table_id: tableId,
      all_columns: true,
    },
  });

/** The query every case runs: paid orders, in id order. */
export const PAID_ORDERS = {
  from: "orders",
  select: ["id", "total"],
  where: { status: { eq: "paid" } },
  orderBy: [{ id: "asc" }],
};

/** The rows `PAID_ORDERS` returns from e2e/source/init.sql's data. */
export const PAID_ORDER_IDS = [1, 3, 5];

export const query = (
  baseUrl: string,
  token: string,
  source: string,
  body: Record<string, unknown> = PAID_ORDERS
) =>
  requestJson("POST", `${baseUrl}/v1/query`, {
    token,
    body: { source, ...body },
  });
