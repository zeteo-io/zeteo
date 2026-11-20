// @module-tag int
// @module-tag platform
import { removeUploadSourcesOf, seedUploadSource } from "../support/uploads.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeRunsOf, runsOf } from "../support/queries.js";
import { LIMIT_PROFILES } from "../../engine/limits.js";
import { sourcesApi } from "../support/measures.js";
import { tokenFor } from "../support/tokens.js";
import { BASE_URL } from "../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  MCP_USE,
  MEASURES_WRITE,
  UPLOADS_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  callTool,
  connectMcp,
  mcpToken,
  type McpSession,
} from "../support/mcp.js";

// preview_measure and preview_metric run under MCP's limits, as the query
// tool does; the API's preview routes keep the API's.

const DAYS = 150;
const day = (i: number) =>
  new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

describe("MCP measure previews: limits", () => {
  let session: McpSession;
  let slug: string;
  let sourceId: string;
  const ownerId = randomUUID();
  const permissions = [MCP_USE, DATA_READ, MEASURES_WRITE, UPLOADS_WRITE];
  const api = sourcesApi(() => BASE_URL);
  const draft = {
    name: "sold",
    description: "Units sold",
    table: "sales",
    formula: { sum: "amount" },
    date_column: "day",
  };

  beforeAll(async () => {
    const source = await seedUploadSource({
      ownerId,
      tables: [
        {
          name: "sales",
          columns: [
            { name: "day", type: "date" },
            { name: "amount", type: "number" },
          ],
          rows: Array.from({ length: DAYS }, (_, i) => [day(i), "1"]),
        },
      ],
    });
    slug = source.slug;
    sourceId = source.id;
    session = await connectMcp(mcpToken(permissions, ownerId));
  });
  afterAll(async () => {
    await session?.close();
    await removeRunsOf([ownerId]);
    await removeUploadSourcesOf([ownerId]);
  });

  it("truncates a daily preview of a measure at MCP's default rows, recorded as a preview", async () => {
    const preview = await callTool(session.client, "preview_measure", {
      source: slug,
      ...draft,
      bucket: { unit: "day", column: "day" },
    });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.json.rows).toHaveLength(LIMIT_PROFILES.mcp.defaultRows);
    expect(preview.json.truncated).toBe(true);
    const runs = await runsOf([ownerId]);
    expect(runs.at(-1)?.entryPoint).toBe("measure_preview");
  });

  it("truncates a daily preview of a metric at MCP's default rows", async () => {
    const created = await api(
      "POST",
      `/${sourceId}/measures`,
      tokenFor({ userId: ownerId, permissions }),
      draft
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const preview = await callTool(session.client, "preview_metric", {
      source: slug,
      name: "sold_x2",
      description: "Twice the units sold",
      formula: { mul: [{ measure: "sold" }, 2] },
      bucket: "day",
      range: { gte: { date: day(0) }, lt: { date: day(DAYS) } },
    });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.json.rows).toHaveLength(LIMIT_PROFILES.mcp.defaultRows);
    expect(preview.json.truncated).toBe(true);
  });

  it("keeps the API's limits for the same preview over HTTP", async () => {
    const res = await api(
      "POST",
      `/${sourceId}/measures/preview`,
      tokenFor({ userId: ownerId, permissions }),
      {
        measure: { ...draft, name: "sold_api" },
        bucket: { unit: "day", column: "day" },
      }
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows).toHaveLength(DAYS);
    expect(res.body.truncated).toBe(false);
  });
});
