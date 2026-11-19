import type { Measure, MeasureInput } from "../../types/measures.js";
import { useStubbedClient } from "../support/callContext.js";
import { describe, expect, it } from "vitest";
import { ZeteoError } from "../../errors.js";

const SRC = "11111111-1111-4111-8111-111111111111";
const MID = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const input: MeasureInput = {
  name: "total_revenue",
  description: "Revenue before refunds.",
  table: "orders",
  formula: { sum: "total" },
  where: { status: { eq: "paid" } },
};

const measure: Measure = {
  id: MID,
  name: "total_revenue",
  description: "Revenue before refunds.",
  table: "orders",
  formula: { sum: "total" },
  where: { status: { eq: "paid" } },
  created_at: "2026-11-19T10:00:00.000Z",
  updated_at: "2026-11-19T10:00:00.000Z",
  usable: true,
  used_by: { saved_queries: 1, panels: 0 },
  broken: null,
};

describe("measures", () => {
  const t = useStubbedClient();

  it("list sends GET /v1/sources/{id}/measures", async () => {
    t.stub.respond(() => ({ body: { data: [measure] } }));
    const out = await t.client.measures.list(SRC);
    expect(out.data).toEqual([measure]);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/sources/${SRC}/measures`,
    });
  });

  it("create sends POST with the measure and is not repeated", async () => {
    t.stub.respond(() => ({ status: 201, body: measure }));
    expect(await t.client.measures.create(SRC, input)).toEqual(measure);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/sources/${SRC}/measures`,
      body: input,
    });
  });

  it("get sends GET and resolves null on 404", async () => {
    t.stub.respond(() => ({ body: measure }));
    expect(await t.client.measures.get(SRC, MID)).toEqual(measure);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/sources/${SRC}/measures/${MID}`,
    });
    t.stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    expect(await t.client.measures.get(SRC, MID)).toBeNull();
  });

  it("update sends PATCH with only the fields to change", async () => {
    t.stub.respond(() => ({ body: measure }));
    await t.client.measures.update(SRC, MID, { where: null });
    expect(t.stub.requests[0]).toMatchObject({
      method: "PATCH",
      path: `/v1/sources/${SRC}/measures/${MID}`,
      body: { where: null },
    });
  });

  it("delete sends DELETE and resolves void", async () => {
    t.stub.respond(() => ({ status: 204 }));
    expect(await t.client.measures.delete(SRC, MID)).toBeUndefined();
    expect(t.stub.requests[0]).toMatchObject({
      method: "DELETE",
      path: `/v1/sources/${SRC}/measures/${MID}`,
    });
  });

  it("a measure in use is a ZeteoError carrying its dependents", async () => {
    t.stub.respond(() => ({
      status: 409,
      body: {
        error: "measure_in_use",
        error_description: "Other measures use this one",
        dependents: ["aov"],
      },
    }));
    const err = await t.client.measures.delete(SRC, MID).catch((e) => e);
    expect(err).toBeInstanceOf(ZeteoError);
    expect((err as ZeteoError).code).toBe("measure_in_use");
    expect((err as ZeteoError).status).toBe(409);
  });

  it("preview sends POST .../measures/preview and returns the query result", async () => {
    const result = {
      columns: [{ name: "total_revenue", type: "number" }],
      rows: [["10"]],
      truncated: false,
      warnings: [],
      run_id: "0193f1c2-7a4e-7c3d-9b1a-2f6e8d0c4b5a",
    };
    t.stub.respond(() => ({ body: result }));
    const body = {
      measure: input,
      bucket: { unit: "month" as const, column: "created_at" },
    };
    expect(await t.client.measures.preview(SRC, body)).toEqual(result);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/sources/${SRC}/measures/preview`,
      body,
    });
  });

  it("editors sends GET .../measure-editors", async () => {
    const editor = {
      type: "user",
      id: USER,
      name: "Ada",
      added_at: "2026-11-19T10:00:00.000Z",
    };
    t.stub.respond(() => ({ body: { data: [editor] } }));
    expect((await t.client.measures.editors(SRC)).data).toEqual([editor]);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/sources/${SRC}/measure-editors`,
    });
  });

  it("replaceEditors sends PUT with the principals", async () => {
    t.stub.respond(() => ({ body: { data: [] } }));
    await t.client.measures.replaceEditors(SRC, [{ type: "user", id: USER }]);
    expect(t.stub.requests[0]).toMatchObject({
      method: "PUT",
      path: `/v1/sources/${SRC}/measure-editors`,
      body: { principals: [{ type: "user", id: USER }] },
    });
  });
});
