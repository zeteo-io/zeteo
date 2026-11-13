// @module-tag int
// @module-tag platform
import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { describeEachEngine } from "../../../support/engines.js";
import { BASE_URL, fetchJson } from "../../../support/http.js";
import { removeSources } from "../../../support/sources.js";
import { TEST_MCP_CLIENT } from "../../../setup/testEnv.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tokenFor } from "../../../support/tokens.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

interface Table {
  name: string;
  schema_name: string;
  columns: Array<{ name: string }>;
  relations: Array<{ name: string; to: string }>;
}
interface Listed {
  sources: Array<{ slug: string; tables: Table[] }>;
}

describeEachEngine("GET /v1/catalog", (engine) => {
  let source: SeededSource;
  let other: SeededSource;
  const wide = newQueryUser();
  const narrow = newQueryUser();
  const nobody = newQueryUser();

  const catalog = (token: string, search = "") =>
    fetchJson("GET", `${BASE_URL}/v1/catalog${search}`, token);

  beforeAll(async () => {
    source = await seedQuerySource(engine);
    other = await seedQuerySource(engine, {}, "catalog-other");
    await grantTo(wide.principal, source.tables.orders!, [
      "id",
      "customer_id",
      "status",
    ]);
    await grantTo(wide.principal, source.tables.customers!, ["id", "region"]);
    await grantTo(narrow.principal, source.tables.orders!, ["id", "status"]);
    await grantTo(wide.principal, other.tables.accounts!, "all");
  });
  afterAll(async () => {
    await removeRunsOf([wide.id, narrow.id]);
    await removeSources([source.id, other.id]);
  });

  const tableOf = (body: Listed, slug: string, name: string): Table => {
    const table = body.sources
      .find((s) => s.slug === slug)
      ?.tables.find((t) => t.name === name);
    if (!table) throw new Error(`no table ${name} in ${slug}`);
    return table;
  };

  it("lists the granted tables and columns, and the relations between them", async () => {
    const res = await catalog(wide.token, `?source=${source.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    const [entry] = res.body.sources;
    expect(entry).toMatchObject({
      slug: source.slug,
      type: engine.type,
      limits: {
        default_rows: 1000,
        max_rows: 50000,
        export: { enabled: false, max_rows: 0 },
      },
    });
    expect(entry.limits.timeout_ms).toBeGreaterThan(0);
    expect(entry.tables.map((t: Table) => t.name)).toEqual([
      "customers",
      "orders",
    ]);
    expect(entry.tables.every((t: Table) => t.schema_name === "sales")).toBe(
      true
    );
    const orders = tableOf(res.body, source.slug, "orders");
    expect(orders.columns.map((c) => c.name)).toEqual([
      "id",
      "customer_id",
      "status",
    ]);
    expect(orders.columns[0]).toEqual({
      name: "id",
      type: "number",
      nullable: false,
      description: null,
      missing: false,
    });
    expect(orders.relations).toEqual([
      { name: "customer", to: "customers", to_many: false, missing: false },
    ]);
    // The reverse of the foreign key, listed under the table it starts from.
    expect(tableOf(res.body, source.slug, "customers").relations).toEqual([
      { name: "orders", to: "orders", to_many: true, missing: false },
    ]);
  });

  it("shows a column-list grant exactly, and drops a relation whose key is not granted", async () => {
    const res = await catalog(narrow.token);
    expect(res.status).toBe(200);
    expect(res.body.sources.map((s: { slug: string }) => s.slug)).toEqual([
      source.slug,
    ]);
    const [orders] = res.body.sources[0].tables as Table[];
    expect(res.body.sources[0].tables).toHaveLength(1);
    if (!orders) throw new Error("no table");
    expect(orders.name).toBe("orders");
    expect(orders.columns.map((c) => c.name)).toEqual(["id", "status"]);
    expect(orders.relations).toEqual([]);
  });

  it("lists every source the caller has a grant on, ordered by slug, when no source is named", async () => {
    const res = await catalog(wide.token);
    const slugs = res.body.sources.map((s: { slug: string }) => s.slug);
    expect(slugs).toEqual([source.slug, other.slug].sort());
  });

  it("answers no sources to a caller without grants", async () => {
    const res = await catalog(nobody.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sources: [] });
  });

  it("answers no sources for a source that is unknown or not granted", async () => {
    for (const slug of [other.slug, "no-such-source"]) {
      const res = await catalog(narrow.token, `?source=${slug}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sources: [] });
    }
  });

  it("holds no id, native type or setting, and no name that is not granted", async () => {
    const res = await catalog(narrow.token);
    const text = JSON.stringify(res.body);
    const ids = [
      source.id,
      other.id,
      ...Object.values(source.tables).flatMap((t) => [
        t.id,
        ...Object.values(t.columns),
      ]),
    ];
    for (const id of ids) expect(text).not.toContain(id);
    for (const hidden of [
      "customer_id",
      "total",
      "notes",
      "external_ref",
      "customers",
      "timestamp with time zone",
      "settings",
      "host",
      "native_type",
    ]) {
      expect(text).not.toContain(hidden);
    }
    expect(Object.keys(res.body.sources[0]).sort()).toEqual([
      "language",
      "limits",
      "name",
      "slug",
      "tables",
      "type",
    ]);
  });

  it("describes the language as a JSON Schema that names select", async () => {
    const res = await catalog(wide.token, `?source=${source.slug}`);
    const { language } = res.body.sources[0];
    expect(language.id).toBe("sql");
    expect(language.schema.type).toBe("object");
    expect(language.schema.properties.select).toBeDefined();
  });

  it("answers a query written only from the response", async () => {
    const res = await catalog(wide.token, `?source=${source.slug}`);
    const orders = tableOf(res.body, source.slug, "orders");
    const [relation] = orders.relations;
    const target = tableOf(res.body, source.slug, relation.to);
    const run = await postQuery(wide.token, {
      source: source.slug,
      from: orders.name,
      join: [relation.name],
      select: [
        orders.columns[0].name,
        `${relation.name}.${target.columns[1].name}`,
      ],
      limit: 5,
    });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
  });

  it("shows whether a source exports, and up to how many rows", async () => {
    const exporting = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 500 },
      "catalog-export"
    );
    try {
      await grantTo(narrow.principal, exporting.tables.accounts!, "all");
      const res = await catalog(narrow.token, `?source=${exporting.slug}`);
      expect(res.body.sources[0].limits.export).toEqual({
        enabled: true,
        max_rows: 500,
      });
    } finally {
      await removeSources([exporting.id]);
    }
  });

  it("accepts a token issued to a client in MCP_ALLOWED_CLIENTS, as any other client's", async () => {
    const own = await catalog(narrow.token);
    const res = await catalog(
      tokenFor({
        userId: narrow.id,
        permissions: [DATA_READ],
        client: TEST_MCP_CLIENT,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(own.body);
  });

  it("needs zeteo.data.read", async () => {
    const res = await catalog(tokenFor({ permissions: [] }));
    expect(res.status).toBe(403);
  });
});
