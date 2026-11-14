import { OPERATIONS, type OperationId } from "../operations.js";
import { useStubbedClient } from "./support/callContext.js";
import type { ZeteoClient } from "../client.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SPEC = new URL(
  "../../../zeteo/openapi/bundled-openapi.yaml",
  import.meta.url
);

function operationsInSpec(): {
  found: Record<string, { method: string; path: string }>;
  blocks: number;
} {
  const found: Record<string, { method: string; path: string }> = {};
  let path: string | undefined;
  let method: string | undefined;
  let inPaths = false;
  let blocks = 0;
  for (const line of readFileSync(SPEC, "utf8").split("\n")) {
    if (/^\S/.test(line)) inPaths = line === "paths:";
    if (!inPaths) continue;
    const p = /^ {2}(\/\S*):$/.exec(line);
    if (p) {
      path = p[1];
      method = undefined;
      continue;
    }
    const m = /^ {4}(get|post|put|patch|delete):$/.exec(line);
    if (m) {
      method = m[1];
      blocks += 1;
      continue;
    }
    const id = /^ {6}operationId: (\w+)$/.exec(line);
    if (id && path && method) {
      found[id[1]] = { method: method.toUpperCase(), path };
    }
  }
  return { found, blocks };
}

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const query = { source: "s", from: "t", select: ["id"] };

describe("operations against the API description", () => {
  it("lists the same 28 operations as the description", () => {
    const { found, blocks } = operationsInSpec();
    // A method block without an operationId would otherwise go unnoticed.
    expect(blocks).toBe(28);
    expect(Object.keys(found)).toHaveLength(28);
    expect(found).toEqual(OPERATIONS);
  });

  describe("the client", () => {
    const t = useStubbedClient();

    const calls: [string, (c: ZeteoClient) => Promise<unknown>][] = [
      ["health.get", (c) => c.health.get()],
      ["catalog.get", (c) => c.catalog.get()],
      ["query.run", (c) => c.query.run(query)],
      [
        "export.rows",
        async (c) => {
          const out = await c.export.rows(query);
          for await (const row of out.rows) void row;
        },
      ],
      [
        "export.stream",
        async (c) => {
          const out = await c.export.stream(query);
          out.stream.resume();
          await new Promise((ok) => out.stream.once("close", ok));
        },
      ],
      ["runs.list", (c) => c.runs.list()],
      ["sources.list", (c) => c.sources.list()],
      [
        "sources.create",
        (c) =>
          c.sources.create({
            slug: "sales",
            name: "Sales",
            type: "postgres",
            settings: { host: "h", database: "d", user: "u", password: "p" },
            schemas: ["public"],
          }),
      ],
      ["sources.get", (c) => c.sources.get(ID)],
      ["sources.update", (c) => c.sources.update(ID, { name: "n" })],
      ["sources.archive", (c) => c.sources.archive(ID)],
      ["sources.test", (c) => c.sources.test(ID)],
      ["sources.refresh", (c) => c.sources.refresh(ID)],
      ["sources.tables.list", (c) => c.sources.tables.list(ID)],
      ["sources.tables.get", (c) => c.sources.tables.get(ID, ID2)],
      [
        "sources.tables.update",
        (c) => c.sources.tables.update(ID, ID2, { description: "d" }),
      ],
      ["sources.relations.list", (c) => c.sources.relations.list(ID)],
      [
        "sources.relations.declare",
        (c) =>
          c.sources.relations.declare(ID, {
            name: "r",
            from_table_id: ID,
            from_columns: ["a"],
            to_table_id: ID2,
            to_columns: ["b"],
            to_many: false,
          }),
      ],
      ["sources.relations.delete", (c) => c.sources.relations.delete(ID, ID2)],
      ["grants.list", (c) => c.grants.list()],
      [
        "grants.create",
        (c) =>
          c.grants.create({
            principal_type: "user",
            principal_id: ID,
            table_id: ID2,
            all_columns: true,
          }),
      ],
      ["grants.get", (c) => c.grants.get(ID)],
      ["grants.replace", (c) => c.grants.replace(ID, { all_columns: true })],
      ["grants.delete", (c) => c.grants.delete(ID)],
      ["principalLimits.list", (c) => c.principalLimits.list()],
      [
        "principalLimits.create",
        (c) =>
          c.principalLimits.create({
            principal_type: "user",
            principal_id: ID,
            query_concurrency: 1,
          }),
      ],
      ["principalLimits.get", (c) => c.principalLimits.get(ID)],
      [
        "principalLimits.update",
        (c) => c.principalLimits.update(ID, { query_concurrency: 2 }),
      ],
      ["principalLimits.delete", (c) => c.principalLimits.delete(ID)],
    ];

    it("has a fixture entry for every function on the client", () => {
      const collect = (value: object, prefix: string): string[] =>
        Object.entries(value).flatMap(([key, member]) => {
          const name = prefix + key;
          if (typeof member === "function") return [name];
          return typeof member === "object" && member !== null
            ? collect(member, `${name}.`)
            : [];
        });
      const own = new Set(["withToken", "start", "stop"]);
      const methods = collect(t.client, "").filter((name) => !own.has(name));
      expect(methods.sort()).toEqual(calls.map(([name]) => name).sort());
    });

    it("reaches every operation once, and exportQuery twice", async () => {
      const run = "0193f1c2-7a4e-7c3d-9b1a-2f6e8d0c4b5a";
      t.stub.respond((req) => {
        if (req.path === "/health") return { body: { status: "ok" } };
        if (req.path === "/v1/export") {
          return {
            headers: { "x-zeteo-run-id": run },
            chunks: [
              `${JSON.stringify({ columns: [], warnings: [], run_id: run })}\n`,
              `${JSON.stringify({ status: "complete", rows: 0 })}\n`,
            ],
          };
        }
        return undefined;
      });

      for (const [, call] of calls) await call(t.client);

      const hits = new Map<OperationId, number>();
      for (const request of t.stub.requests) {
        const match = (
          Object.entries(OPERATIONS) as [
            OperationId,
            { method: string; path: string },
          ][]
        ).find(
          ([, op]) =>
            op.method === request.method &&
            new RegExp(`^${op.path.replace(/\{\w+\}/g, "[^/]+")}$`).test(
              request.path
            )
        );
        expect(match, `${request.method} ${request.path}`).toBeDefined();
        hits.set(match![0], (hits.get(match![0]) ?? 0) + 1);
      }

      for (const id of Object.keys(OPERATIONS) as OperationId[]) {
        expect(hits.get(id), id).toBe(id === "exportQuery" ? 2 : 1);
      }
    });
  });
});
