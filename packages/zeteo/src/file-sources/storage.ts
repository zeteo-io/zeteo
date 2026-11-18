import type { PrismaClient } from "../../prisma/generated/client/index.js";
import { prisma, type Prisma } from "../utils/db/prisma.js";
import type { FileColumnType } from "./types.js";
import { readerRoleName } from "./readerRole.js";
import { createHash, randomBytes } from "crypto";
import { AppError } from "../utils/errors.js";

export { checkReaderRole } from "./readerRole.js";

/**
 * Where a file source's data lives: one `zf_<32 hex>` schema per source, in
 * Zeteo's own database, one table per file table, read by the reader role
 * only. Uploads wait as raw text in `STAGING_SCHEMA`, which the reader cannot
 * use. Every identifier in this file's SQL comes from `schemaFor`, a random
 * name made here, or a name checked against `NAME`, and is quoted.
 */

/** The schema of staging tables (migration `file_staging_schema`). */
export const STAGING_SCHEMA = "zeteo_file_staging";

type Db = PrismaClient | Prisma.TransactionClient;

/** A normalized name: a lowercase letter, then lowercase letters, digits or `_`, at most 63 bytes. */
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGING_NAME = /^s_[0-9a-f]{32}$/;
/** Postgres's limit on a table's columns. */
const MAX_TABLE_COLUMNS = 1600;
/** Postgres's limit on a statement's bound parameters, with room to spare. */
const MAX_PARAMS = 65_000;
/** A load's transaction: a million rows of wide text take a while to cast. */
const LOAD_TIMEOUT_MS = 600_000;
/** How many failing rows a `CastFailedError` names. */
const FAILING_ROWS = 5;

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

const checkedName = (name: string): string => {
  if (!NAME.test(name)) throw new Error(`Not a normalized name: ${name}`);
  return name;
};

/** A loaded table not yet swapped in: `<prefix>__load_<12 hex>`. */
const LOADED = /^[a-z][a-z0-9_]{0,43}__load_[0-9a-f]{12}$/;

/**
 * A table's name: normalized, and never shaped like a loaded table, which
 * the stale-load cleanup would take for one and drop.
 */
const checkedTableName = (name: string): string => {
  if (LOADED.test(checkedName(name))) {
    throw new Error(`A table cannot be named like a load: ${name}`);
  }
  return name;
};

/**
 * A staging table's name: `s_`, the creation time in unix seconds (8 hex
 * digits), then 12 random bytes. The time lets housekeeping tell an orphan
 * (no staging row names it) that is old from an upload still in flight.
 */
export const stagingNameAt = (at: Date): string =>
  `s_${Math.floor(at.getTime() / 1000)
    .toString(16)
    .padStart(8, "0")}${randomBytes(12).toString("hex")}`;

/** When a staging table was created, from its name. */
export const stagingCreatedAt = (name: string): Date =>
  new Date(parseInt(checkedStaging(name).slice(2, 10), 16) * 1000);

/** Every table in the staging schema. */
export const listStagingTables = async (db: Db = prisma): Promise<string[]> => {
  const rows = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
    STAGING_SCHEMA
  );
  return rows.map((r) => r.table_name).filter((n) => STAGING_NAME.test(n));
};

const checkedStaging = (name: string): string => {
  if (!STAGING_NAME.test(name)) throw new Error(`Not a staging table: ${name}`);
  return name;
};

/** The schema holding a file source's tables: `zf_` and the id's 32 hex digits. */
export const schemaFor = (sourceId: string): string => {
  if (!UUID.test(sourceId)) throw new Error(`Not a source id: ${sourceId}`);
  return `zf_${sourceId.replace(/-/g, "").toLowerCase()}`;
};

const qualified = (sourceId: string, table: string) =>
  `${quote(schemaFor(sourceId))}.${quote(table)}`;
const stagingTable = (name: string) =>
  `${quote(STAGING_SCHEMA)}.${quote(checkedStaging(name))}`;
/** A staging column: `c<index>`, the 0-based column of the file. */
const stagingColumn = (index: number) => quote(`c${index}`);

/** A value that will not cast to its column's type. */
export class CastFailedError extends AppError {
  constructor(
    public readonly column: string,
    /** The first failing rows, 1-based rows of the file. */
    public readonly rows: number[]
  ) {
    super(
      422,
      "cast_failed",
      `Column "${column}" has values that are not of its type`,
      { details: { column, rows } }
    );
    this.name = "CastFailedError";
  }
}

export interface LoadSpec {
  /** The table's normalized name; its load is built as `<name>__load_<random>`. */
  name: string;
  /** The 0-based row of the header, whose rows up to it are not data; null when there is none. */
  headerRow: number | null;
  columns: { index: number; name: string; type: FileColumnType }[];
}

export interface LoadResult {
  physicalName: string;
  rowCount: number;
}

/**
 * A new staging table of `columnsCount` text columns, `c0`..., and its row
 * numbers, `row_no` (0-based). Unlogged: a crash loses only an upload in
 * flight, which expires anyway.
 */
export const createStagingTable = async (
  columnsCount: number,
  db: Db = prisma
): Promise<string> => {
  if (
    !Number.isInteger(columnsCount) ||
    columnsCount < 1 ||
    columnsCount > MAX_TABLE_COLUMNS - 1
  ) {
    throw new Error(`A staging table cannot have ${columnsCount} columns`);
  }
  const name = stagingNameAt(new Date());
  const columns = Array.from(
    { length: columnsCount },
    (_, i) => `${stagingColumn(i)} text`
  );
  await db.$executeRawUnsafe(
    `CREATE UNLOGGED TABLE ${stagingTable(name)} ("row_no" integer PRIMARY KEY, ${columns.join(", ")})`
  );
  return name;
};

/** Appends rows after those already staged, numbering them on; short rows are padded with null. */
export const appendStagingRows = async (
  name: string,
  rows: (string | null)[][],
  db: Db = prisma
): Promise<void> => {
  if (rows.length === 0) return;
  const table = stagingTable(name);
  const [{ count }] = await db.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM pg_attribute
     WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`,
    `${STAGING_SCHEMA}.${name}`
  );
  const width = count - 1;
  const [{ next }] = await db.$queryRawUnsafe<Array<{ next: number }>>(
    `SELECT coalesce(max("row_no") + 1, 0)::int AS next FROM ${table}`
  );
  const columns = [
    `"row_no"`,
    ...Array.from({ length: width }, (_, i) => stagingColumn(i)),
  ].join(", ");
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS / (width + 1)));
  for (let start = 0; start < rows.length; start += perStatement) {
    const batch = rows.slice(start, start + perStatement);
    const params: (string | number | null)[] = [];
    const tuples = batch.map((row, offset) => {
      if (row.length > width) {
        throw new Error(`Row ${next + start + offset} has ${row.length} cells`);
      }
      const base = params.length;
      params.push(next + start + offset);
      for (let i = 0; i < width; i++) params.push(row[i] ?? null);
      return `(${Array.from(
        { length: width + 1 },
        (_, i) => `$${base + i + 1}${i === 0 ? "::int" : "::text"}`
      ).join(", ")})`;
    });
    await db.$executeRawUnsafe(
      `INSERT INTO ${table} (${columns}) VALUES ${tuples.join(", ")}`,
      ...params
    );
  }
};

export const dropStagingTable = async (
  name: string,
  db: Db = prisma
): Promise<void> => {
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS ${stagingTable(name)}`);
};

/** A staged value trimmed of whitespace, null when empty. */
const trimmed = (v: string) => `NULLIF(btrim(${v}, E' \\t\\r\\n'), '')`;

/**
 * What each type accepts: ISO 8601 for dates and timestamps, plain decimals
 * (no `NaN`, no `1_000`) for numbers, `true`/`false` in any case. Postgres
 * must also accept the value (`pg_input_is_valid`, Postgres 16 or later),
 * which rules out `2024-02-30` and the like.
 */
const ACCEPTS: Record<
  Exclude<FileColumnType, "text">,
  { pattern: string; pgType: string }
> = {
  number: {
    pattern: "^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?$",
    pgType: "numeric",
  },
  boolean: { pattern: "^(true|false)$", pgType: "boolean" },
  date: { pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", pgType: "date" },
  timestamp: {
    pattern:
      "^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$",
    pgType: "timestamptz",
  },
};

/** The staged value compared: lowercase for booleans. */
const comparable = (type: FileColumnType, v: string) =>
  type === "boolean" ? `lower(${trimmed(v)})` : trimmed(v);

/** True for a non-empty staged value that will not cast to `type`. */
const badValue = (type: Exclude<FileColumnType, "text">, v: string) => {
  const { pattern, pgType } = ACCEPTS[type];
  const t = comparable(type, v);
  return `(${t} IS NOT NULL AND NOT (${t} ~ '${pattern}' AND pg_input_is_valid(${t}, '${pgType}')))`;
};

/** The staged value as its column's type; empty is null. */
const cast = (type: FileColumnType, v: string) =>
  type === "text"
    ? `NULLIF(${v}, '')`
    : `${comparable(type, v)}::${ACCEPTS[type].pgType}`;

/**
 * Creates the source's schema when missing and lets the reader use it. Nothing
 * in it is readable until `swapIn` grants a table.
 */
export const ensureSourceSchema = async (
  sourceId: string,
  db: Db = prisma
): Promise<void> => {
  const schema = quote(schemaFor(sourceId));
  await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await db.$executeRawUnsafe(
    `GRANT USAGE ON SCHEMA ${schema} TO ${quote(readerRoleName())}`
  );
};

/** Drops the source's schema and every table in it, waiting for queries reading them to end. */
export const dropSourceSchema = async (
  sourceId: string,
  db: Db = prisma
): Promise<void> => {
  await db.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS ${quote(schemaFor(sourceId))} CASCADE`
  );
};

/**
 * The part of a table's loads before `__load_`: the name itself when it fits
 * in 44 bytes, else 35 of its bytes and 8 hex of its hash, so two names never
 * share a prefix.
 */
const loadPrefix = (name: string): string =>
  name.length <= 44
    ? name
    : `${name.slice(0, 35)}${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;

/** The source's loaded tables not yet swapped in, those of `name` only when given. */
const loadsIn = async (
  sourceId: string,
  name: string | null,
  db: Db
): Promise<string[]> => {
  const rows = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = ${schemaFor(sourceId)}`;
  return rows
    .map((r) => r.tablename)
    .filter(
      (t) =>
        LOADED.test(t) &&
        (name === null || t.startsWith(`${loadPrefix(name)}__load_`))
    );
};

/**
 * Drops a table `loadTypedTable` built that will not be swapped in: the
 * caller's way out when its swap fails. Only a loaded table's name is taken.
 */
export const dropLoadedTable = async (
  sourceId: string,
  physicalName: string,
  db: Db = prisma
): Promise<void> => {
  if (!LOADED.test(physicalName)) {
    throw new Error(`Not a loaded table: ${physicalName}`);
  }
  await db.$executeRawUnsafe(
    `DROP TABLE IF EXISTS ${qualified(sourceId, physicalName)}`
  );
};

/**
 * Drops every loaded table of the source left by a load that never swapped
 * in (a crash, a timed-out swap). Call it at the start of a source's loads,
 * under the Redis lock that serializes them: no load of that source is then
 * in flight.
 */
export const dropStaleLoads = async (
  sourceId: string,
  db: Db = prisma
): Promise<void> => {
  for (const t of await loadsIn(sourceId, null, db)) {
    await dropLoadedTable(sourceId, t, db);
  }
};

/**
 * Builds a staged table's typed copy, `<name>__load_<random>`, in the
 * source's schema, ready for `swapIn`. Every value is checked before anything
 * is created: the first column (in row order) with a value that will not
 * cast throws `CastFailedError` with its first failing rows, and nothing is
 * left behind.
 *
 * It first drops this table's earlier loads that were never swapped in (they
 * would count against the owner's quota forever). That is safe because the
 * caller serializes a source's loads under a Redis lock; it leaves the loads
 * of the source's other tables alone, which one upload may be holding for a
 * swap of several tables in one transaction. If the swap fails, the caller
 * drops the load with `dropLoadedTable`.
 */
export const loadTypedTable = async (
  sourceId: string,
  staging: string,
  spec: LoadSpec
): Promise<LoadResult> => {
  const table = stagingTable(staging);
  const columns = spec.columns.map((c) => ({
    ...c,
    name: checkedName(c.name),
    value: stagingColumn(c.index),
  }));
  const names = new Set(columns.map((c) => c.name));
  if (names.size !== columns.length || columns.length === 0) {
    throw new Error("A load needs distinct column names");
  }
  if (
    spec.headerRow !== null &&
    (!Number.isInteger(spec.headerRow) || spec.headerRow < 0)
  ) {
    throw new Error(`Not a header row: ${spec.headerRow}`);
  }
  // Room for the suffix within Postgres's 63 bytes; names are ASCII.
  const physicalName = `${loadPrefix(checkedTableName(spec.name))}__load_${randomBytes(6).toString("hex")}`;
  const firstDataRow = spec.headerRow === null ? 0 : spec.headerRow + 1;
  const typed = columns.flatMap((c) =>
    c.type === "text" ? [] : [{ ...c, type: c.type }]
  );

  for (const stale of await loadsIn(sourceId, spec.name, prisma)) {
    await dropLoadedTable(sourceId, stale);
  }

  return prisma.$transaction(
    async (tx) => {
      // Fixed parsing whatever the role's or server's settings: ISO dates,
      // and a timestamp without an offset is UTC.
      await tx.$executeRawUnsafe(`SET LOCAL datestyle = 'ISO, YMD'`);
      await tx.$executeRawUnsafe(`SET LOCAL timezone = 'UTC'`);

      if (typed.length > 0) {
        const [first] = await tx.$queryRawUnsafe<Array<{ col: number }>>(
          `SELECT CASE ${typed
            .map((c, i) => `WHEN ${badValue(c.type, c.value)} THEN ${i}`)
            .join(" ")} END AS col
           FROM ${table}
           WHERE "row_no" >= $1 AND (${typed.map((c) => badValue(c.type, c.value)).join(" OR ")})
           ORDER BY "row_no" LIMIT 1`,
          firstDataRow
        );
        if (first) {
          const column = typed[first.col];
          const failing = await tx.$queryRawUnsafe<Array<{ row_no: number }>>(
            `SELECT "row_no" FROM ${table}
             WHERE "row_no" >= $1 AND ${badValue(column.type, column.value)}
             ORDER BY "row_no" LIMIT ${FAILING_ROWS}`,
            firstDataRow
          );
          throw new CastFailedError(
            column.name,
            failing.map((r) => r.row_no + 1)
          );
        }
      }

      await ensureSourceSchema(sourceId, tx);
      const target = qualified(sourceId, physicalName);
      await tx.$executeRawUnsafe(
        `CREATE TABLE ${target} (${columns
          .map((c) => `${quote(c.name)} ${pgTypeOf(c.type)}`)
          .join(", ")})`
      );
      const rowCount = await tx.$executeRawUnsafe(
        `INSERT INTO ${target} (${columns.map((c) => quote(c.name)).join(", ")})
         SELECT ${columns.map((c) => cast(c.type, c.value)).join(", ")}
         FROM ${table} WHERE "row_no" >= $1 ORDER BY "row_no"`,
        firstDataRow
      );
      return { physicalName, rowCount };
    },
    { timeout: LOAD_TIMEOUT_MS }
  );
};

const pgTypeOf = (type: FileColumnType) =>
  type === "text" ? "text" : ACCEPTS[type].pgType;

/**
 * Puts a loaded table in place of `tableName`, inside the caller's
 * transaction (which also updates the catalogue): drops the old table,
 * renames the new one and lets the reader select from it. The drop waits for
 * queries reading the old table to end; queries arriving meanwhile wait, then
 * read the new one. No reader sees the table missing, empty or partial.
 */
export const swapIn = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  tableName: string,
  physicalName: string
): Promise<void> => {
  const name = checkedTableName(tableName);
  if (!LOADED.test(physicalName)) {
    throw new Error(`Not a loaded table: ${physicalName}`);
  }
  const loaded = physicalName;
  await tx.$executeRawUnsafe(
    `DROP TABLE IF EXISTS ${qualified(sourceId, name)}`
  );
  await tx.$executeRawUnsafe(
    `ALTER TABLE ${qualified(sourceId, loaded)} RENAME TO ${quote(name)}`
  );
  await tx.$executeRawUnsafe(
    `GRANT SELECT ON ${qualified(sourceId, name)} TO ${quote(readerRoleName())}`
  );
};

/** Bytes stored for the owner's file sources that are not archived, indexes and TOAST included. */
export const storedBytes = async (
  ownerId: string,
  db: Db = prisma
): Promise<number> => {
  const [{ bytes }] = await db.$queryRaw<Array<{ bytes: bigint }>>`
    SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint AS bytes
    FROM "zeteo"."sources" s
    JOIN pg_namespace n ON n.nspname = 'zf_' || replace(s.id::text, '-', '')
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r'
    WHERE s.owner_id = ${ownerId}::uuid
      AND s.type = 'upload'
      AND s.archived_at IS NULL`;
  return Number(bytes);
};
