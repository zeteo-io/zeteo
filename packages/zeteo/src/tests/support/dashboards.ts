import { BASE_URL, fetchJson, type JsonResponse } from "./http.js";
import { prisma } from "../../utils/db/prisma.js";
import type { SeededSource } from "./queries.js";
import { uniqueName } from "./savedQueries.js";

/** Any call to `/v1/dashboards` + `path`. */
export const dashboardsCall = (
  method: string,
  path: string,
  token: string,
  body?: unknown,
  baseUrl = BASE_URL
): Promise<JsonResponse> =>
  fetchJson(method, `${baseUrl}/v1/dashboards${path}`, token, body);

/** `POST /v1/dashboards` as `token`. */
export const createDashboard = (
  token: string,
  body: unknown,
  baseUrl = BASE_URL
): Promise<JsonResponse> => dashboardsCall("POST", "", token, body, baseUrl);

/** `POST /v1/dashboards/:id/panels` as `token`. */
export const addPanel = (
  token: string,
  dashboardId: string,
  body: unknown,
  baseUrl = BASE_URL
): Promise<JsonResponse> =>
  dashboardsCall("POST", `/${dashboardId}/panels`, token, body, baseUrl);

/** A query over `orders` with a numeric column to chart. */
export const chartedQuery = (source: SeededSource) => ({
  source: source.slug,
  from: "orders",
  select: ["id", "status", "total"],
});

/** A bar chart that fits `chartedQuery` (6 by 4 on the grid). */
export const BAR = { type: "bar", version: 1, x: "status", y: ["total"] };

/** A table chart (12 by 4 on the grid). */
export const TABLE = { type: "table", version: 1 };

/** An own panel on the saved query. */
export const ownPanel = (
  savedQueryId: string,
  fields: Record<string, unknown> = {}
) => ({ kind: "own", saved_query_id: savedQueryId, chart: BAR, ...fields });

/** Creates a dashboard and returns its id; the create must succeed. */
export const dashboardOf = async (
  token: string,
  fields: Record<string, unknown> = {}
): Promise<string> => {
  const res = await createDashboard(token, {
    name: uniqueName("dash"),
    ...fields,
  });
  if (res.status !== 201) {
    throw new Error(`dashboard not created: ${res.status} ${res.body?.error}`);
  }
  return res.body.id as string;
};

/** Shares a dashboard straight in the database, as the sharing routes do. */
export const shareDashboardDirectly = (
  dashboardId: string,
  principal: { type: "user" | "group"; id: string },
  createdBy: string
) =>
  prisma.dashboardShare.create({
    data: {
      dashboardId,
      principalType: principal.type,
      principalId: principal.id,
      createdBy,
    },
  });
