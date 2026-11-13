// @module-tag unit
// @module-tag platform
import { HOSTILE, hostileCatalog } from "../../support/pure/hostileCatalog.js";
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import type { SqlDialect } from "../../../adapters/sql/dialect.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { describe, expect, it } from "vitest";

const { schema, parent, child, relation, columns, dotted, longTable } = HOSTILE;

const HOSTILE_VALUES = [
  "'; DROP TABLE y; --",
  '" or 1=1 --',
  "\\'; select pg_sleep(10); --",
  "$1",
];

interface Engine {
  dialect: SqlDialect;
  /** An identifier as the dialect must quote it. */
  quote: (name: string) => string;
  /** The dialect's own aliases, `t0` and `c0`…, quoted. */
  aliases: RegExp;
  /** What may never remain once every quoted identifier is removed. */
  stray: RegExp;
  placeholders: RegExp;
  /** The first parameter's placeholder. */
  first: string;
  /** A bound text value as the dialect binds it. */
  text: (value: string) => unknown;
  /** The paging parameters for fetch `{ limit: 11, offset: 0 }`. */
  page: unknown[];
  /** ORDER BY each item ascending, then paging after `used` parameters. */
  ordered: (
    items: { expression: string; alias: string }[],
    used: number
  ) => string;
}

const ENGINES: Engine[] = [
  {
    dialect: postgresDialect,
    quote: (name) => `"${name.replaceAll('"', '""')}"`,
    aliases: /"[tc]\d+"/g,
    stray: /DROP|[\]']|"b/,
    placeholders: /\$\d+/g,
    first: "$1",
    text: (value) => value,
    page: [11, 0],
    ordered: (items, used) =>
      ` order by ${items.map((i) => `${i.alias} asc nulls last`).join(", ")}` +
      ` limit $${used + 1} offset $${used + 2}`,
  },
  {
    dialect: mssqlDialect,
    quote: (name) => `[${name.replaceAll("]", "]]")}]`,
    aliases: /\[[tc]\d+\]/g,
    stray: /DROP|[[\]'"]/,
    placeholders: /@\d+/g,
    first: "@1",
    text: (value) => ({ type: "nvarchar", value }),
    page: [
      { type: "bigint", value: "0" },
      { type: "bigint", value: "11" },
    ],
    ordered: (items, used) =>
      ` order by ${items
        .map(
          (i) =>
            `case when ${i.expression} is null then 1 else 0 end, ${i.expression} asc`
        )
        .join(", ")}` +
      ` offset @${used + 1} rows fetch next @${used + 2} rows only`,
  },
];

describe.each(ENGINES)("compileSql ($dialect.name)", (engine) => {
  const { quote } = engine;
  const t0 = quote("t0");
  const c = (i: number) => quote(`c${i}`);

  const compile = (query: object) =>
    compileSql(
      planSql(
        sqlQuerySchema.parse({
          source: "hostile",
          from: `${schema}.${parent}`,
          ...query,
        }),
        hostileCatalog(engine.dialect.name)
      ),
      engine.dialect,
      { limit: 11, offset: 0 }
    );

  /** The text with every correctly quoted hostile identifier, and the dialect's own aliases, removed. */
  const withoutIdentifiers = (text: string) =>
    [
      schema,
      parent,
      child,
      relation,
      dotted.schema,
      dotted.table,
      longTable,
      ...Object.values(columns),
    ]
      .map(quote)
      .sort((a, b) => b.length - a.length)
      .reduce((rest, id) => rest.replaceAll(id, "ID"), text)
      .replace(engine.aliases, "ID");

  describe("hostile catalogue names", () => {
    const query = {
      join: [relation],
      select: [
        columns.quote,
        { max: columns.apostrophe, as: "m" },
        { bucket: "day", column: columns.drop, as: "d" },
        `${relation}.${columns.quote}`,
      ],
      where: { [columns.bracket]: { gt: 1 } },
      groupBy: [columns.quote, "d", `${relation}.${columns.quote}`],
      orderBy: [{ m: "desc" }],
    };

    it("appear only inside correctly doubled quoted identifiers", () => {
      const { sql } = compile(query);
      expect(sql).toContain(quote(schema) + "." + quote(parent));
      expect(sql).toContain(quote(schema) + "." + quote(child));
      const rest = withoutIdentifiers(sql);
      for (const raw of [
        schema,
        parent,
        child,
        relation,
        ...Object.values(columns).filter((c) => c !== columns.placeholder),
      ]) {
        expect(rest).not.toContain(raw);
      }
      expect(rest).not.toMatch(engine.stray);
    });

    it("quote the first column exactly as a doubled identifier", () => {
      const column = `${t0}.${quote(columns.quote)}`;
      expect(compile({ select: [columns.quote] }).sql).toBe(
        `select ${column} as ${c(0)} from ${quote(schema)}.${quote(parent)} as ${t0}` +
          engine.ordered([{ expression: column, alias: c(0) }], 0)
      );
    });
  });

  describe("hostile values", () => {
    it("binds filter values, in members and patterns, and writes none into the text", () => {
      const { sql, parameters } = compile({
        select: [columns.quote],
        where: {
          and: [
            { [columns.quote]: { eq: HOSTILE_VALUES[0] } },
            { [columns.quote]: { in: HOSTILE_VALUES.slice(1) } },
            { [columns.apostrophe]: { contains: HOSTILE_VALUES[2] } },
            { [columns.apostrophe]: { startsWith: HOSTILE_VALUES[1] } },
            {
              [columns.apostrophe]: {
                between: [HOSTILE_VALUES[0], HOSTILE_VALUES[3]],
              },
            },
          ],
        },
      });
      const rest = withoutIdentifiers(sql);
      expect(rest).not.toMatch(/DROP|pg_sleep|1=1/);
      expect(rest).not.toContain("'; ");
      expect(sql.match(engine.placeholders)).toHaveLength(parameters.length);
      expect(parameters).toEqual([
        ...[
          HOSTILE_VALUES[0]!,
          ...HOSTILE_VALUES.slice(1),
          "%\\\\'; select pg\\_sleep(10); --%",
          '" or 1=1 --%',
          HOSTILE_VALUES[0]!,
          HOSTILE_VALUES[3]!,
        ].map(engine.text),
        ...engine.page,
      ]);
    });

    it("escapes %, _ and the escape character in a contains value", () => {
      const { parameters } = compile({
        select: [columns.quote],
        where: { [columns.apostrophe]: { contains: "100%_sure\\" } },
      });
      expect(parameters[0]).toEqual(engine.text("%100\\%\\_sure\\\\%"));
    });
  });

  describe("dots, backslashes, placeholders and long names", () => {
    it("never splits a name that holds dots", () => {
      const column = `${t0}.${quote(columns.quote)}`;
      expect(
        compile({
          from: `${dotted.schema}.${dotted.table}`,
          select: [columns.quote],
        }).sql
      ).toBe(
        `select ${column} as ${c(0)} from ${quote("dot.ted")}.${quote("ta.ble")} as ${t0}` +
          engine.ordered([{ expression: column, alias: c(0) }], 0)
      );
    });

    it("keeps a backslash, a $1 name and a 128-character column as single quoted identifiers", () => {
      const { sql, parameters } = compile({
        select: [columns.backslash, columns.placeholder, columns.long],
        where: { [columns.placeholder]: { eq: "v" } },
      });
      const items = [columns.backslash, columns.placeholder, columns.long].map(
        (name, i) => ({ expression: `${t0}.${quote(name)}`, alias: c(i) })
      );
      expect(sql).toBe(
        `select ${items.map((i) => `${i.expression} as ${i.alias}`).join(", ")}` +
          ` from ${quote(schema)}.${quote(parent)} as ${t0}` +
          ` where ${t0}.${quote("$1")} = ${engine.first}` +
          engine.ordered(items, 1)
      );
      expect(sql).toContain(`${t0}.${quote("back\\slash\\")}`);
      expect(parameters).toEqual([engine.text("v"), ...engine.page]);
    });

    it("quotes a 200-character table name whole", () => {
      expect(
        compile({ from: `${schema}.${longTable}`, select: [columns.quote] }).sql
      ).toContain(`from ${quote(schema)}.${quote(longTable)} as ${t0}`);
    });
  });
});

describe("compileSql (mssql): brackets in a name", () => {
  it("doubles a closing bracket and leaves an opening one as it is", () => {
    const { sql } = compileSql(
      planSql(
        sqlQuerySchema.parse({
          source: "hostile",
          from: `${schema}.${child}`,
          select: [columns.bracket],
        }),
        hostileCatalog("mssql")
      ),
      mssqlDialect,
      { limit: 11, offset: 0 }
    );
    expect(sql).toContain('select [t0].[]]] as [c0] from [a"b].[]]] as [t0]');
    expect(mssqlDialect.kysely.selectFrom("[x").selectAll().compile().sql).toBe(
      "select * from [[x]"
    );
  });
});
