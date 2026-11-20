import { useStubbedClient } from "../support/callContext.js";
import { describe, expect, it } from "vitest";
import type {
  Metric,
  MetricInput,
  RedactedMetric,
} from "../../types/measures.js";

const SRC = "11111111-1111-4111-8111-111111111111";
const MID = "22222222-2222-4222-8222-222222222222";

const input: MetricInput = {
  name: "cost_per_dollar",
  description: "Ad spend per dollar of revenue.",
  formula: { div: [{ measure: "spend" }, { measure: "revenue" }] },
};

const metric: Metric = {
  id: MID,
  ...input,
  created_at: "2026-11-19T10:00:00.000Z",
  updated_at: "2026-11-19T10:00:00.000Z",
  usable: true,
  used_by: { saved_queries: 1, panels: 0 },
  broken: null,
};

describe("metrics", () => {
  const t = useStubbedClient();

  it("list sends GET /v1/sources/{id}/metrics and may carry redacted metrics", async () => {
    const redacted: RedactedMetric = {
      name: "hidden",
      description: "d",
      usable: false,
    };
    t.stub.respond(() => ({
      body: {
        data: [metric, redacted],
        can_edit: true,
        can_manage_editors: false,
      },
    }));
    const out = await t.client.metrics.list(SRC);
    expect(out.data).toEqual([metric, redacted]);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/sources/${SRC}/metrics`,
    });
  });

  it("create sends POST with the metric and is not repeated", async () => {
    t.stub.respond(() => ({ status: 201, body: metric }));
    expect(await t.client.metrics.create(SRC, input)).toEqual(metric);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/sources/${SRC}/metrics`,
      body: input,
    });
  });

  it("get sends GET and resolves null on 404", async () => {
    t.stub.respond(() => ({ body: metric }));
    expect(await t.client.metrics.get(SRC, MID)).toEqual(metric);
    t.stub.respond(() => ({
      status: 404,
      body: { error: "not_found", error_description: "Metric not found" },
    }));
    expect(await t.client.metrics.get(SRC, MID)).toBeNull();
  });

  it("update sends PATCH with the changed fields", async () => {
    t.stub.respond(() => ({ body: metric }));
    await t.client.metrics.update(SRC, MID, { description: "New." });
    expect(t.stub.requests[0]).toMatchObject({
      method: "PATCH",
      path: `/v1/sources/${SRC}/metrics/${MID}`,
      body: { description: "New." },
    });
  });

  it("delete sends DELETE and resolves void", async () => {
    t.stub.respond(() => ({ status: 204 }));
    expect(await t.client.metrics.delete(SRC, MID)).toBeUndefined();
    expect(t.stub.requests[0]).toMatchObject({
      method: "DELETE",
      path: `/v1/sources/${SRC}/metrics/${MID}`,
    });
  });

  it("preview sends POST .../metrics/preview and returns the query result", async () => {
    const result = {
      columns: [{ name: "cost_per_dollar", type: "number" }],
      rows: [["0.2"]],
      truncated: false,
      warnings: [],
      run_id: "0193f1c2-7a4e-7c3d-9b1a-2f6e8d0c4b5a",
    };
    t.stub.respond(() => ({ body: result }));
    const body = {
      metric: input,
      range: { gte: { date: "2026-01-01" } },
    };
    expect(await t.client.metrics.preview(SRC, body)).toEqual(result);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/sources/${SRC}/metrics/preview`,
      body,
    });
  });
});
