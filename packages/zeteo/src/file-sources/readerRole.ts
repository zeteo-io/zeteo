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
 * The start-up check of the reader: it connects, its database is Zeteo's own
 * (file-source data lives beside the `zeteo` schema), and it is not a
 * superuser and can use none of `zeteo`, `core` or the staging schema.
 * Postgres's own privileges are what keep the reader out; this refuses a
 * deployment whose role was given more.
 */
export const checkReaderRole = async (
  url: string | undefined = env.FILE_SOURCES_READER_URL
): Promise<void> => {
  if (!url) throw new Error("FILE_SOURCES_READER_URL is not set");
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
      usable: string[];
    }>(
      `SELECT current_database() AS db, current_user AS role,
              r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
              ARRAY(
                SELECT s FROM unnest($1::text[]) AS s
                WHERE CASE WHEN to_regnamespace(quote_ident(s)) IS NULL
                           THEN false
                           ELSE has_schema_privilege(s, 'USAGE') END
              ) AS usable
       FROM pg_roles r WHERE r.rolname = current_user`,
      [FORBIDDEN_SCHEMAS]
    );
    const [reader] = rows;
    if (reader.db !== own) {
      throw new Error(
        `FILE_SOURCES_READER_URL must name Zeteo's own database "${own}", not "${reader.db}"`
      );
    }
    if (reader.superuser || reader.bypassrls) {
      throw new Error(
        `The File Sources reader role "${reader.role}" must not be a superuser or bypass row security`
      );
    }
    if (reader.usable.length > 0) {
      throw new Error(
        `The File Sources reader role "${reader.role}" must not use the schemas ${reader.usable.join(", ")}`
      );
    }
  } finally {
    await client.end();
  }
};
