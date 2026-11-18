import { prisma } from "../utils/db/prisma.js";
import env from "../env.js";
import pg from "pg";

/** The schemas the reader role must never use: Zeteo's own and staging's. */
const FORBIDDEN_SCHEMAS = ["zeteo", "core", "zeteo_file_staging"] as const;

/** How long the start-up check waits to connect as the reader. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * The role `FILE_SOURCES_READER_URL` signs in as, which storage grants
 * `USAGE` on each `zf_` schema and `SELECT` on its tables. Throws when File
 * Sources are off.
 */
export const readerRoleName = (): string => {
  if (!env.FILE_SOURCES_READER_URL) {
    throw new Error("File Sources are not configured");
  }
  const name = decodeURIComponent(
    new URL(env.FILE_SOURCES_READER_URL).username
  );
  if (!name) throw new Error("FILE_SOURCES_READER_URL names no user");
  return name;
};

/**
 * The start-up check of the reader. It holds only what storage grants it,
 * `USAGE` on `zf_*` schemas and `SELECT` on their tables, so this refuses a
 * reader that:
 * - is on another database than Zeteo's (file-source data lives beside the
 *   `zeteo` schema);
 * - signs in as another role than the one storage grants to;
 * - is a superuser, bypasses row security, or is a member of any role (it
 *   would hold that role's privileges);
 * - can use `zeteo`, `core` or the staging schema;
 * - may create temporary tables or schemas in the database (`TEMP`, `CREATE`;
 *   PUBLIC holds `TEMP` by default, so the operator revokes it, see
 *   docker/postgres/files-reader.sql).
 * Postgres's own privileges are what keep the reader out; this refuses a
 * deployment whose role was given more.
 */
export const checkReaderRole = async (
  url: string | undefined = env.FILE_SOURCES_READER_URL
): Promise<void> => {
  if (!url) throw new Error("FILE_SOURCES_READER_URL is not set");
  const expected = readerRoleName();
  const [{ db: own }] = await prisma.$queryRaw<Array<{ db: string }>>`
    SELECT current_database() AS db`;
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const { rows } = await client.query<{
      db: string;
      role: string;
      superuser: boolean;
      bypassrls: boolean;
      member_of: string[];
      usable: string[];
      temp: boolean;
      create: boolean;
    }>(
      `SELECT current_database() AS db, current_user AS role,
              r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
              ARRAY(
                SELECT g.rolname::text FROM pg_auth_members m
                JOIN pg_roles g ON g.oid = m.roleid
                WHERE m.member = r.oid ORDER BY 1
              ) AS member_of,
              ARRAY(
                SELECT s FROM unnest($1::text[]) AS s
                WHERE CASE WHEN to_regnamespace(quote_ident(s)) IS NULL
                           THEN false
                           ELSE has_schema_privilege(s, 'USAGE') END
              ) AS usable,
              has_database_privilege(current_database(), 'TEMP') AS temp,
              has_database_privilege(current_database(), 'CREATE') AS create
       FROM pg_roles r WHERE r.rolname = current_user`,
      [FORBIDDEN_SCHEMAS]
    );
    const [reader] = rows;
    const refuse = (problem: string) => {
      throw new Error(
        `The File Sources reader role "${reader.role}" ${problem}`
      );
    };
    if (reader.db !== own) {
      throw new Error(
        `FILE_SOURCES_READER_URL must name Zeteo's own database "${own}", not "${reader.db}"`
      );
    }
    if (reader.role !== expected) {
      refuse(`must sign in as "${expected}", the role it is granted to`);
    }
    if (reader.superuser || reader.bypassrls) {
      refuse("must not be a superuser or bypass row security");
    }
    if (reader.member_of.length > 0) {
      refuse(
        `must not be a member of any role (${reader.member_of.join(", ")})`
      );
    }
    if (reader.usable.length > 0) {
      refuse(`must not use the schemas ${reader.usable.join(", ")}`);
    }
    if (reader.temp || reader.create) {
      refuse(
        `must not have TEMP or CREATE on the database "${own}" (revoke TEMP from PUBLIC)`
      );
    }
  } finally {
    await client.end();
  }
};
