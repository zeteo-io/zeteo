// @module-tag unit
// @module-tag platform
import { HOSTILE, hostileCatalog } from "../../support/pure/hostileCatalog.js";
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { describe, expect, it } from "vitest";

const { schema, parent, child, relation, columns } = HOSTILE;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const compile = (query: object) =>
  compileSql(
    planSql(
      sqlQuerySchema.parse({
        source: "hostile",
        from: `${schema}.${parent}`,
        ...query,
      }),
      hostileCatalog()
    ),
    postgresDialect,
    { limit: 11, offset: 0 }
  );

const HOSTILE_VALUES = [
  "'; DROP TABLE y; --",
  '" or 1=1 --',
  "\\'; select pg_sleep(10); --",
  "$1",
];

/** The text with every correctly quoted hostile identifier removed. */
const withoutIdentifiers = (text: string) =>
  [schema, parent, child, relation, ...Object.values(columns)]
    .map(quote)
    .sort((a, b) => b.length - a.length)
    .reduce((rest, id) => rest.replaceAll(id, "ID"), text);

describe("compileSql: hostile catalogue names", () => {
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

  it("appears only inside correctly doubled quoted identifiers", () => {
    const { sql } = compile(query);
    expect(sql).toContain(quote(schema) + "." + quote(parent));
    expect(sql).toContain(quote(schema) + "." + quote(child));
    const rest = withoutIdentifiers(sql);
    for (const raw of [
      schema,
      parent,
      child,
      relation,
      ...Object.values(columns),
    ]) {
      expect(rest).not.toContain(raw);
    }
    expect(rest).not.toMatch(/DROP|[\]']/);
    expect(rest).not.toContain('"b');
  });

  it("quotes the first column exactly as a doubled identifier", () => {
    expect(compile({ select: [columns.quote] }).sql).toBe(
      `select "t0".${quote(columns.quote)} as "c0" from ${quote(schema)}.${quote(parent)} as "t0"` +
        ' order by "c0" asc nulls last limit $1 offset $2'
    );
  });
});

describe("compileSql: hostile values", () => {
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
    expect(sql.match(/\$\d+/g)).toHaveLength(parameters.length);
    expect(parameters).toEqual([
      HOSTILE_VALUES[0],
      ...HOSTILE_VALUES.slice(1),
      "%\\\\'; select pg\\_sleep(10); --%",
      '" or 1=1 --%',
      HOSTILE_VALUES[0],
      HOSTILE_VALUES[3],
      11,
      0,
    ]);
  });

  it("escapes %, _ and the escape character in a contains value", () => {
    const { parameters } = compile({
      select: [columns.quote],
      where: { [columns.apostrophe]: { contains: "100%_sure\\" } },
    });
    expect(parameters[0]).toBe("%100\\%\\_sure\\\\%");
  });
});
