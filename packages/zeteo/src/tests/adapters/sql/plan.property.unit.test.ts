// @module-tag unit
// @module-tag platform
// @module-tag security
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import type { VisibleCatalog } from "../../../grants/visibleCatalog.js";
import { queryNameOf, planSql } from "../../../adapters/sql/plan.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import type { SqlDialect } from "../../../adapters/sql/dialect.js";
import { shopCatalog } from "../../support/pure/shopCatalog.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import fc from "fast-check";

// For random grants over the shop and random structurally valid queries
// written from the FULL catalogue's names (hidden ones included), whatever
// the planner accepts references only what is granted, and whatever it
// refuses names, and suggests, only what the caller can see.
//
// Columns are named `<table>_<column>` so every column name is one column's;
// the compiled SQL is then searched for each ungranted column's quoted name.

const NUM_RUNS = 400;
/** Reproduce a failure with `FC_SEED=<seed>`; fast-check prints the seed with the counterexample. */
const SEED = Number(process.env.FC_SEED ?? 20261112);

const FULL = shopCatalog({ uniqueNames: true });

const TABLE_KEYS = FULL.tables.map((t) => t.id);
// A column's id is `<table key>.<plain name>`, whatever its unique name.
const COLUMN_IDS = FULL.tables.flatMap((t) => t.columns.map((c) => c.id));

const ERROR_CODES = new Set([
  "not_found_or_not_accessible",
  "missing_in_source",
  "column_not_queryable",
  "invalid_operator",
  "invalid_value",
  "invalid_grouping",
  "invalid_order",
  "invalid_having",
  "duplicate_output_name",
  "join_parent_missing",
]);

// ---- grants -------------------------------------------------------------

interface Grants {
  hidden: string[];
  missing: string[];
}

const subsetOf = (items: string[], max: number) =>
  fc.uniqueArray(fc.constantFrom(...items), { maxLength: max });

const grantsArb: fc.Arbitrary<Grants> = fc.record({
  // Mostly column-level hiding, sometimes a whole table.
  hidden: fc
    .tuple(subsetOf(TABLE_KEYS, 1), subsetOf(COLUMN_IDS, 7))
    .map(([tables, columns]) => [...tables, ...columns]),
  missing: subsetOf([...TABLE_KEYS, ...COLUMN_IDS], 1),
});

// ---- queries over the full catalogue --------------------------------------

const tableById = new Map(FULL.tables.map((t) => [t.id, t]));

type Type =
  "text" | "number" | "boolean" | "date" | "timestamp" | "json" | "other";
interface Path {
  path: string;
  type: Type;
}

/** Every relation path reachable from `table` in the full catalogue, two steps at most. */
const pathsFrom = (tableId: string): Array<[path: string, tableId: string]> => {
  const first = FULL.relations
    .filter((r) => r.fromTableId === tableId)
    .map((r) => [r.name, r.toTableId] as [string, string]);
  const second = first.flatMap(([path, id]) =>
    FULL.relations
      .filter((r) => r.fromTableId === id && r.toTableId !== tableId)
      .map((r) => [`${path}.${r.name}`, r.toTableId] as [string, string])
  );
  return [...first, ...second];
};

const VALUES: Record<Type, fc.Arbitrary<string | number | boolean>> = {
  text: fc.constantFrom("a", "paid", "pa"),
  number: fc.oneof(fc.integer({ min: -5, max: 5000 }), fc.constant("12.50")),
  boolean: fc.boolean(),
  date: fc.constantFrom("2026-01-02", "2025-12-31"),
  timestamp: fc.constantFrom(
    "2026-01-02T10:00:00Z",
    "2025-12-31T00:00:00.500+02:00"
  ),
  json: fc.constant("x"),
  other: fc.constant("x"),
};

/** A condition of the kind the column's type takes (a json or `other` column takes only `isNull`), now and then the wrong kind. */
const conditionArb = (type: Type) => {
  const value = VALUES[type];
  const any = fc.oneof(...Object.values(VALUES));
  const kinds: Array<fc.Arbitrary<object>> = [
    fc.boolean().map((v) => ({ isNull: v })),
  ];
  if (type !== "json" && type !== "other") {
    kinds.push(
      ...(["eq", "ne"] as const).map((op) => value.map((v) => ({ [op]: v })))
    );
  }
  if (type === "number" || type === "date" || type === "timestamp") {
    kinds.push(
      ...(["gt", "gte", "lt", "lte"] as const).map((op) =>
        value.map((v) => ({ [op]: v }))
      ),
      fc.tuple(value, value).map(([a, b]) => ({ between: [a, b] })),
      fc.array(value, { minLength: 1, maxLength: 3 }).map((v) => ({ in: v })),
      fc.array(value, { minLength: 1, maxLength: 3 }).map((v) => ({ notIn: v }))
    );
  }
  if (type === "text") {
    kinds.push(
      fc.constantFrom("a", "pa").map((v) => ({ contains: v })),
      fc.constantFrom("a", "pa").map((v) => ({ startsWith: v })),
      fc.array(value, { minLength: 1, maxLength: 3 }).map((v) => ({ in: v }))
    );
  }
  // A condition of the wrong kind, for the planner's own refusals.
  kinds.push(any.map((v) => ({ gt: v })));
  return fc.oneof(
    { arbitrary: fc.oneof(...kinds), weight: 9 },
    { arbitrary: any.map((v) => ({ contains: String(v) })), weight: 1 }
  );
};

const AGGREGATES: Record<string, Type[] | undefined> = {
  count: undefined,
  countDistinct: undefined,
  sum: ["number"],
  avg: ["number"],
  min: ["text", "number", "date", "timestamp"],
  max: ["text", "number", "date", "timestamp"],
};
const UNITS = ["day", "week", "month", "quarter", "year"] as const;

/** The join entries a set of column paths needs: every relation prefix, parents first. */
const joinsFor = (paths: string[]): string[] => {
  const needed: string[] = [];
  for (const path of paths) {
    const segments = path.split(".").slice(0, -1);
    segments.forEach((_, i) => {
      const prefix = segments.slice(0, i + 1).join(".");
      if (!needed.includes(prefix)) needed.push(prefix);
    });
  }
  return needed.sort((a, b) => a.split(".").length - b.split(".").length);
};

const queryArb = fc
  .constantFrom(...TABLE_KEYS)
  .chain((fromKey) => {
    const from = tableById.get(fromKey)!;
    const columns: Path[] = [
      ...from.columns.map((c) => ({ path: c.name, type: c.type as Type })),
      ...pathsFrom(fromKey).flatMap(([prefix, id]) =>
        tableById.get(id)!.columns.map((c) => ({
          path: `${prefix}.${c.name}`,
          type: c.type as Type,
        }))
      ),
    ];
    const columnArb = fc.constantFrom(...columns);
    const dated = columns.filter(
      (c) => c.type === "date" || c.type === "timestamp"
    );

    const comparisonArb = fc
      .uniqueArray(
        columnArb.chain((c) =>
          conditionArb(c.type).map((cond) => [c.path, cond] as const)
        ),
        { minLength: 1, maxLength: 2, selector: ([path]) => path }
      )
      .map((entries) => Object.fromEntries(entries));
    const { filter } = fc.letrec<{ filter: object }>((tie) => ({
      filter: fc.oneof(
        { depthSize: "small", maxDepth: 3 },
        comparisonArb,
        comparisonArb,
        fc
          .array(tie("filter"), { minLength: 1, maxLength: 3 })
          .map((f) => ({ and: f })),
        fc
          .array(tie("filter"), { minLength: 1, maxLength: 3 })
          .map((f) => ({ or: f })),
        tie("filter").map((f) => ({ not: f }))
      ),
    }));

    // Plain rows: some columns. Grouped: key columns and buckets, and aggregates over them.
    const plainArb = fc
      .uniqueArray(columnArb, {
        minLength: 1,
        maxLength: 5,
        selector: (c) => c.path,
      })
      .map((picked) => ({
        select: picked.map((c) => c.path) as unknown[],
        outputs: picked.map((c) => c.path),
        numeric: [] as string[],
        groupBy: [] as string[],
        used: picked.map((c) => c.path),
      }));

    const aggregateArb = fc
      .tuple(
        fc.uniqueArray(columnArb, { maxLength: 2, selector: (c) => c.path }),
        dated.length > 0
          ? fc.option(
              fc.tuple(fc.constantFrom(...dated), fc.constantFrom(...UNITS)),
              {
                nil: undefined,
              }
            )
          : fc.constant(undefined),
        fc.array(
          fc.tuple(
            fc.constantFrom(...Object.keys(AGGREGATES)),
            fc.nat(),
            fc.boolean()
          ),
          { minLength: 1, maxLength: 3 }
        )
      )
      .chain(([keys, bucket, aggregates]) => {
        const aggArb = fc.tuple(
          ...aggregates.map(([fn, , star]) => {
            const takes = AGGREGATES[fn];
            const compatible = columns.filter(
              (c) => !takes || takes.includes(c.type)
            );
            return fn === "count" && star
              ? fc.constant("*")
              : fc
                  .constantFrom(
                    ...(compatible.length > 0 ? compatible : columns)
                  )
                  .map((c) => c.path);
          })
        );
        return aggArb.map((targets) => {
          const select: unknown[] = keys.map((c) => c.path);
          const outputs = keys.map((c) => c.path);
          const groupBy = keys.map((c) => c.path);
          const used = keys.map((c) => c.path);
          if (bucket) {
            select.push({
              bucket: bucket[1],
              column: bucket[0].path,
              as: "bk",
            });
            outputs.push("bk");
            groupBy.push("bk");
            used.push(bucket[0].path);
          }
          const numeric: string[] = [];
          aggregates.forEach(([fn], i) => {
            const target = targets[i]!;
            select.push({ [fn]: target, as: `m${i}` });
            outputs.push(`m${i}`);
            numeric.push(`m${i}`);
            if (target !== "*") used.push(target);
          });
          return { select, outputs, numeric, groupBy, used };
        });
      });

    return fc
      .tuple(
        fc.oneof(plainArb, aggregateArb),
        fc.option(filter, { nil: undefined }),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom("inner", "left"),
        fc.nat({ max: 3 }),
        fc.array(fc.tuple(fc.nat(), fc.constantFrom("asc", "desc")), {
          maxLength: 2,
        })
      )
      .chain(
        ([shape, where, distinct, objectJoins, joinType, noise, order]) => {
          // having filters aggregates of a grouped query
          const havingArb =
            shape.numeric.length > 0
              ? fc.option(
                  fc
                    .constantFrom(...shape.numeric)
                    .chain((alias) =>
                      conditionArb("number").map((cond) => ({ [alias]: cond }))
                    ),
                  { nil: undefined }
                )
              : fc.constant(undefined);
          return havingArb.map((having) => {
            const used = [
              ...shape.used,
              ...JSON.stringify(where ?? {}).matchAll(/"([a-z_.]+)":\{/g),
            ].flatMap((m) => (typeof m === "string" ? [m] : [m[1]!]));
            let joins = joinsFor(used);
            // Now and then the join list is wrong: a relation left out or listed before its parent.
            if (noise === 0 && joins.length > 0) joins = joins.slice(1);
            if (noise === 1) joins = [...joins].reverse();
            const orderBy = order.map(([i, dir]) => ({
              [shape.outputs[i % shape.outputs.length]!]: dir,
            }));
            return {
              source: "shop",
              from: noise === 2 ? `${from.schemaName}.${from.name}` : from.name,
              ...(joins.length > 0 && {
                join: joins.map((relation) =>
                  objectJoins ? { relation, type: joinType } : relation
                ),
              }),
              select: shape.select,
              ...(distinct && shape.groupBy.length === 0 && { distinct }),
              ...(where && { where }),
              ...(shape.groupBy.length > 0 && { groupBy: shape.groupBy }),
              ...(having && { having }),
              ...(orderBy.length > 0 && { orderBy }),
            };
          });
        }
      );
  })
  .map((q) => sqlQuerySchema.parse(q));

// ---- the property ---------------------------------------------------------

const quote = (dialect: SqlDialect, name: string) =>
  sql`${sql.id(name)}`.compile(dialect.kysely).sql;

const visibleOf = (grants: Grants): VisibleCatalog =>
  shopCatalog({ ...grants, uniqueNames: true });

const isGranted = (grants: Grants, tableId: string, columnId: string) =>
  !grants.hidden.includes(tableId) && !grants.hidden.includes(columnId);

/**
 * What a plan or error shows that the caller may not see, as sentences; an
 * empty list means nothing. `catalog` is what the planner was given, which
 * the property takes to be the visible catalogue.
 */
const leaksOf = (
  query: ReturnType<typeof sqlQuerySchema.parse>,
  grants: Grants,
  catalog: VisibleCatalog,
  dialect: SqlDialect
): string[] => {
  const leaks: string[] = [];
  const visibleColumns = new Set(
    catalog.tables.flatMap((t) => t.columns.map((c) => c.name))
  );
  const visibleRelations = new Set(catalog.relations.map((r) => r.name));
  const visibleTables = new Set(
    catalog.tables.flatMap((t) => [
      queryNameOf(catalog.tables, t),
      `${t.schemaName}.${t.name}`,
      t.name,
    ])
  );
  const ungrantedColumns = FULL.tables.flatMap((t) =>
    t.columns.filter((c) => !isGranted(grants, t.id, c.id)).map((c) => c.name)
  );

  let plan;
  try {
    plan = planSql(query, catalog);
  } catch (err) {
    if (!(err instanceof QueryError)) {
      return [`planSql threw a ${String(err)}, not a QueryError`];
    }
    if (!ERROR_CODES.has(err.code)) leaks.push(`unknown code ${err.code}`);
    // A name that is not visible: any column, relation or table name of the full catalogue that the visible one lacks.
    const forbidden = new Set([
      ...FULL.tables.flatMap((t) => [
        ...t.columns.map((c) => c.name),
        `${t.schemaName}.${t.name}`,
        t.name,
      ]),
      ...FULL.relations.map((r) => r.name),
    ]);
    for (const known of [
      ...visibleColumns,
      ...visibleRelations,
      ...visibleTables,
    ]) {
      forbidden.delete(known);
    }
    for (const suggestion of err.suggestions) {
      const last = suggestion.split(".").at(-1)!;
      if (forbidden.has(suggestion) || forbidden.has(last)) {
        leaks.push(`suggested ${suggestion}`);
      }
    }
    return leaks;
  }

  for (const { tableId, columnId } of plan.references) {
    if (!isGranted(grants, tableId, columnId)) {
      leaks.push(`references ${columnId}`);
    }
  }
  const compiled = compileSql(plan, dialect, { limit: 101, offset: 0 });
  for (const name of ungrantedColumns) {
    if (compiled.sql.includes(quote(dialect, name))) {
      leaks.push(`SQL names ${name}`);
    }
  }
  const visibleTableIds = new Set(catalog.tables.map((t) => t.id));
  for (const t of FULL.tables) {
    if (visibleTableIds.has(t.id)) continue;
    if (
      compiled.sql.includes(
        `${quote(dialect, t.schemaName)}.${quote(dialect, t.name)}`
      )
    ) {
      leaks.push(`SQL names table ${t.id}`);
    }
  }
  return leaks;
};

/** The properties for one dialect; each dialect's test file calls this. */
export const describeLeakProperties = (dialect: SqlDialect) => {
  describe(`planSql and compileSql (${dialect.name}): generated grants and queries (seed ${SEED})`, () => {
    it("never reference, suggest or emit anything ungranted", () => {
      fc.assert(
        fc.property(grantsArb, queryArb, (grants, query) => {
          expect(leaksOf(query, grants, visibleOf(grants), dialect)).toEqual(
            []
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS }
      );
    });

    it("plans and refuses a fair share of the generated queries, so both branches are exercised", () => {
      let planned = 0;
      let refused = 0;
      fc.assert(
        fc.property(grantsArb, queryArb, (grants, query) => {
          try {
            planSql(query, visibleOf(grants));
            planned++;
          } catch {
            refused++;
          }
        }),
        { seed: SEED, numRuns: NUM_RUNS }
      );
      expect(planned).toBeGreaterThan(NUM_RUNS * 0.05);
      expect(refused).toBeGreaterThan(NUM_RUNS * 0.05);
    });

    it("detects a leak: the same checks fail when the planner is given the full catalogue", () => {
      const grants: Grants = { hidden: ["orders.notes"], missing: [] };
      const query = sqlQuerySchema.parse({
        source: "shop",
        from: "orders",
        select: ["orders_id", "orders_notes"],
        orderBy: [{ orders_notes: "asc" }],
      });
      expect(leaksOf(query, grants, visibleOf(grants), dialect)).toEqual([]);
      const leaks = leaksOf(query, grants, FULL, dialect);
      expect(leaks).toContain("references orders.notes");
      expect(leaks).toContain("SQL names orders_notes");
    });

    it("prints every table as the planner accepts it in from", () => {
      fc.assert(
        fc.property(grantsArb, (grants) => {
          const catalog = visibleOf(grants);
          for (const table of catalog.tables) {
            const name = queryNameOf(catalog.tables, table);
            const query = sqlQuerySchema.parse({
              source: "shop",
              from: name,
              select: [table.columns[0]!.name],
            });
            try {
              const plan = planSql(query, catalog);
              expect(plan.from.name).toBe(table.name);
              expect(plan.from.schemaName).toBe(table.schemaName);
            } catch (err) {
              // The only refusal a visible table may meet is being missing in the source.
              expect((err as QueryError).code).toBe("missing_in_source");
            }
          }
        }),
        { seed: SEED, numRuns: 200 }
      );
    });
  });
};

describeLeakProperties(postgresDialect);
