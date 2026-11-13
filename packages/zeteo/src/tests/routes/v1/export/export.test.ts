// @module-tag int
// @module-tag platform
import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { readCsv, readCsvValues } from "../../../support/pure/csv.js";
import { describeEachEngine } from "../../../support/engines.js";
import { removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tokenFor } from "../../../support/tokens.js";
import { performance } from "node:perf_hooks";
import {
  eventually,
  ndjsonLines,
  newExportUser,
  openExport,
  postExport,
} from "../../../support/exports.js";
import {
  grantTo,
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

const ORDERS = {
  from: "orders",
  select: [
    "id",
    "customer_id",
    "status",
    "total",
    "created_at",
    "notes",
    "external_ref",
  ],
  orderBy: [{ id: "asc" }],
};

describeEachEngine("POST /v1/export", (engine) => {
  let source: SeededSource;
  let capped: SeededSource;
  let off: SeededSource;
  /** The sales and probe schemas, for the trickle view. */
  let probe: SeededSource;
  const user = newExportUser();

  const orders = (on: SeededSource = source, extra: object = {}) => ({
    source: on.slug,
    ...ORDERS,
    ...extra,
  });

  /** The rows `/v1/query` answers for the same body. */
  const queried = async (body: object) => {
    const res = await postQuery(user.token, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { columns: unknown[]; rows: unknown[][] };
  };

  beforeAll(async () => {
    source = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 1_000_000 },
      "export"
    );
    capped = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 2 },
      "export"
    );
    off = await seedQuerySource(engine, {}, "export");
    probe = await seedQuerySource(
      engine,
      {
        export_enabled: true,
        export_row_cap: 1_000_000,
        schemas: ["sales", "probe"],
      },
      "export"
    );
    for (const on of [source, capped, off]) {
      await grantTo(user.principal, on.tables.orders!, "all");
      await grantTo(user.principal, on.tables.customers!, "all");
    }
    await grantTo(user.principal, probe.tables.trickle!, "all");
  });
  afterAll(async () => {
    await removeRunsOf([user.id]);
    await removeSources([source.id, capped.id, off.id, probe.id]);
  });

  it("streams NDJSON: the head, the rows /v1/query answers, and a complete tail", async () => {
    const expected = await queried(orders());
    const res = await postExport({ token: user.token, body: orders() });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["content-length"]).toBeUndefined();
    const lines = ndjsonLines(res.text);
    const head = lines[0] as { run_id: string };
    expect(head).toEqual({
      columns: expected.columns,
      warnings: [],
      run_id: expect.any(String),
    });
    expect(res.headers["x-zeteo-run-id"]).toBe(head.run_id);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="zeteo-export-${head.run_id}.ndjson"`
    );
    expect(lines.slice(1, -1)).toEqual(expected.rows);
    expect(lines.at(-1)).toEqual({ status: "complete", rows: 12 });
    // NDJSON says how it ended in its last line, not in trailers.
    expect(res.trailers).toEqual({});

    // Recorded once the response has finished, so after the client has it.
    const run = await eventually(async () => {
      const found = (await runsOf([user.id])).find((r) => r.id === head.run_id);
      return found?.outcome === "running" ? undefined : found;
    });
    expect(run).toMatchObject({
      entryPoint: "export",
      outcome: "ok",
      rowCount: 12,
      truncated: false,
    });
  });

  it("streams CSV: a header row, the same rows, and the ending in trailers", async () => {
    const expected = await queried(orders());
    const res = await postExport({
      token: user.token,
      body: orders(),
      search: "format=csv",
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["trailer"]).toBe(
      "X-Zeteo-Export-Status, X-Zeteo-Export-Rows"
    );
    expect(res.headers["x-zeteo-warnings"]).toBeUndefined();
    const runId = res.headers["x-zeteo-run-id"] as string;
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="zeteo-export-${runId}.csv"`
    );
    expect(res.text.startsWith("﻿")).toBe(false);
    const [header, ...records] = readCsvValues(res.text);
    expect(header).toEqual(ORDERS.select);
    // Every value as its text; null as an empty field. external_ref's -42 is
    // a number, never guarded.
    expect(records).toEqual(
      expected.rows.map((row) => row.map((v) => (v === null ? "" : String(v))))
    );
    expect(records.flat()).toContain("-42");
    expect(res.trailers).toEqual({
      "x-zeteo-export-status": "complete",
      "x-zeteo-export-rows": "12",
    });
  });

  it("says which warnings a CSV export has in X-Zeteo-Warnings", async () => {
    const many = await postExport({
      token: user.token,
      body: {
        source: source.slug,
        from: "customers",
        join: ["orders"],
        select: [{ count: "*" }],
      },
      search: "format=csv",
    });
    expect(many.status).toBe(200);
    expect(many.headers["x-zeteo-warnings"]).toBe("join_multiplies_rows");
    expect(readCsvValues(many.text)).toEqual([["count"], ["12"]]);
  });

  it("ends an export of zero rows with its head and tail (NDJSON) or its header and trailers (CSV)", async () => {
    const none = orders(source, { where: { id: { eq: -1 } } });
    const nd = await postExport({ token: user.token, body: none });
    expect(nd.status).toBe(200);
    const lines = ndjsonLines(nd.text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ columns: expect.any(Array) });
    expect(lines[1]).toEqual({ status: "complete", rows: 0 });

    const csv = await postExport({
      token: user.token,
      body: none,
      search: "format=csv",
    });
    expect(csv.status).toBe(200);
    expect(readCsvValues(csv.text)).toEqual([ORDERS.select]);
    expect(csv.trailers).toEqual({
      "x-zeteo-export-status": "complete",
      "x-zeteo-export-rows": "0",
    });
  });

  it("gzips the stream when the client accepts gzip, and not otherwise", async () => {
    for (const format of ["ndjson", "csv"]) {
      const plain = await postExport({
        token: user.token,
        body: orders(),
        search: `format=${format}`,
        acceptEncoding: "identity",
      });
      const zipped = await postExport({
        token: user.token,
        body: orders(),
        search: `format=${format}`,
        acceptEncoding: "br;q=0.9, gzip;q=0.5",
      });
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(zipped.headers["content-encoding"]).toBe("gzip");
      expect(zipped.headers["vary"]).toMatch(/accept-encoding/i);
      expect(zipped.raw.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      const withoutRunId = (r: typeof plain) =>
        r.text.replaceAll(r.headers["x-zeteo-run-id"] as string, "RUN");
      expect(withoutRunId(zipped)).toBe(withoutRunId(plain));
      if (format === "csv") {
        expect(zipped.trailers).toEqual({
          "x-zeteo-export-status": "complete",
          "x-zeteo-export-rows": "12",
        });
      }
    }
  });

  it("stops at the source's export cap and says the stream was truncated", async () => {
    const nd = await postExport({ token: user.token, body: orders(capped) });
    const lines = ndjsonLines(nd.text);
    expect(lines.slice(1, -1)).toHaveLength(2);
    expect(lines.at(-1)).toEqual({ status: "truncated", rows: 2 });

    const csv = await postExport({
      token: user.token,
      body: orders(capped),
      search: "format=csv",
    });
    expect(readCsv(csv.text)).toHaveLength(3);
    expect(csv.trailers).toEqual({
      "x-zeteo-export-status": "truncated",
      "x-zeteo-export-rows": "2",
    });
  });

  it("answers 403 without zeteo.data.export", async () => {
    const res = await postExport({
      token: tokenFor({ userId: user.id, permissions: [DATA_READ] }),
      body: orders(),
    });
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("answers 400 invalid_request for an unknown format, in the service's error shape", async () => {
    const res = await postExport({
      token: user.token,
      body: orders(),
      search: "format=xml",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({
      error: "invalid_request",
      error_description: expect.any(String),
      request_id: expect.any(String),
    });
  });

  it("refuses as an ordinary JSON error, with nothing streamed, when the source's exports are off", async () => {
    for (const acceptEncoding of [undefined, "gzip"]) {
      const res = await postExport({
        token: user.token,
        body: orders(off),
        search: "format=csv",
        acceptEncoding,
      });
      expect(res.status).toBe(403);
      expect(res.headers["content-type"]).toBe(
        "application/json; charset=utf-8"
      );
      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.headers["trailer"]).toBeUndefined();
      expect(res.headers["x-zeteo-run-id"]).toBeUndefined();
      expect(JSON.parse(res.text)).toMatchObject({
        error: "export_not_enabled",
      });
    }
  });

  it("refuses a table the caller is not granted as one that does not exist", async () => {
    const hidden = await postExport({
      token: user.token,
      body: { source: source.slug, from: "accounts", select: ["id"] },
    });
    const missing = await postExport({
      token: user.token,
      body: { source: source.slug, from: "acounts", select: ["id"] },
    });
    expect(hidden.status).toBe(422);
    const shape = (text: string) => {
      const { request_id: _id, ...rest } = JSON.parse(text) as Record<
        string,
        unknown
      >;
      return JSON.stringify(rest).replace(/acc?ounts/g, "…");
    };
    expect(shape(hidden.text)).toBe(shape(missing.text));
  });
  it("streams the first row of an export with no orderBy at once, while the source is still making the rest", async () => {
    // 30 rows of the trickle view, 200 ms apart after the first: about 6 s.
    // Sorted, every row would be made before the first is sent.
    const began = performance.now();
    const res = await openExport({
      token: user.token,
      body: {
        source: probe.slug,
        from: "trickle",
        select: ["id", "filler"],
        limit: 30,
      },
    });
    expect(res.statusCode).toBe(200);
    let text = "";
    let firstRowAt: number | undefined;
    for await (const chunk of res) {
      text += (chunk as Buffer).toString("utf8");
      // The head is the first line; the first row ends the second.
      if (firstRowAt === undefined && text.split("\n").length > 2) {
        firstRowAt = performance.now() - began;
      }
    }
    const endedAt = performance.now() - began;
    expect(firstRowAt).toBeDefined();
    expect(endedAt).toBeGreaterThanOrEqual(5000);
    expect(firstRowAt!).toBeLessThan(1500);
    const lines = ndjsonLines(text);
    // The view has more rows than the limit.
    expect(lines.at(-1)).toEqual({ status: "truncated", rows: 30 });
    expect(
      new Set(lines.slice(1, -1).map((row) => (row as unknown[])[0])).size
    ).toBe(30);
  }, 60_000);

  it("exports with no orderBy the same rows as with one, as a set", async () => {
    const { orderBy: _orderBy, ...unordered } = ORDERS;
    const sorted = await postExport({ token: user.token, body: orders() });
    const unsorted = await postExport({
      token: user.token,
      body: { source: source.slug, ...unordered, offset: 0 },
    });
    const rowsOf = (text: string) =>
      ndjsonLines(text).slice(1, -1) as unknown[][];
    const byId = (rows: unknown[][]) =>
      [...rows].sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(rowsOf(sorted.text)).toHaveLength(12);
    expect(byId(rowsOf(unsorted.text))).toEqual(rowsOf(sorted.text));
  });

  it("exports in the orderBy's order", async () => {
    const res = await postExport({
      token: user.token,
      body: orders(source, { orderBy: [{ id: "desc" }] }),
    });
    const ids = ndjsonLines(res.text)
      .slice(1, -1)
      .map((row) => Number((row as unknown[])[0]));
    expect(ids).toHaveLength(12);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("answers 422 invalid_order for an offset without orderBy, recorded as refused, and pages with one", async () => {
    const { orderBy: _orderBy, ...unordered } = ORDERS;
    for (const orderBy of [undefined, []]) {
      const refused = await postExport({
        token: user.token,
        body: { source: source.slug, ...unordered, orderBy, offset: 5 },
      });
      expect(refused.status).toBe(422);
      expect(JSON.parse(refused.text)).toMatchObject({
        error: "invalid_order",
        error_description: "An export with an offset needs an orderBy",
        path: ["offset"],
      });
    }
    const refusals = (await runsOf([user.id])).filter(
      (run) => run.errorCode === "invalid_order"
    );
    expect(refusals).toHaveLength(2);
    for (const run of refusals) {
      expect(run).toMatchObject({ entryPoint: "export", outcome: "refused" });
    }

    // A table the caller cannot see is reported first.
    const hidden = await postExport({
      token: user.token,
      body: {
        source: source.slug,
        from: "accounts",
        select: ["id"],
        offset: 5,
      },
    });
    expect(hidden.status).toBe(422);
    expect(JSON.parse(hidden.text)).toMatchObject({
      error: "not_found_or_not_accessible",
    });

    const all = await postExport({ token: user.token, body: orders() });
    const paged = await postExport({
      token: user.token,
      body: orders(source, { offset: 5 }),
    });
    expect(paged.status).toBe(200);
    expect(ndjsonLines(paged.text).slice(1, -1)).toEqual(
      ndjsonLines(all.text).slice(6, -1)
    );
  });
});
