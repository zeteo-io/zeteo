import { uploadsReaderSettings } from "../sources/connect.js";
import { prisma } from "../utils/db/prisma.js";
import env from "../env.js";
import pg from "pg";
import {
  UploadsMisconfiguredError,
  UploadsNotConfiguredError,
} from "../utils/errors.js";

/** The schemas the reader role must never use: Zeteo's own and staging's. */
const FORBIDDEN_SCHEMAS = ["zeteo", "core", "zeteo_upload_staging"] as const;

/** How long the start-up check waits to connect as the reader. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * The role `UPLOADS_READER_URL` signs in as, which storage grants
 * `USAGE` on each `zu_` schema and `SELECT` on its tables. Throws when File
 * Sources are off.
 */
export const readerRoleName = (): string => {
  if (!env.UPLOADS_READER_URL) {
    throw new UploadsNotConfiguredError();
  }
  const name = decodeURIComponent(new URL(env.UPLOADS_READER_URL).username);
  if (!name) throw new Error("UPLOADS_READER_URL names no user");
  return name;
};

/**
 * The start-up check of the reader. It holds only what storage grants it,
 * `USAGE` on `zu_*` schemas and `SELECT` on their tables, so this refuses a
 * reader that:
 * - is on another database than Zeteo's (upload source data lives beside the
 *   `zeteo` schema);
 * - signs in as another role than the one storage grants to;
 * - is a superuser, bypasses row security, or is a member of any role (it
 *   would hold that role's privileges);
 * - can use `zeteo`, `core` or the staging schema;
 * - may create temporary tables or schemas in the database (`TEMP`, `CREATE`;
 *   PUBLIC holds `TEMP` by default, so the operator revokes it, see
 *   docker/postgres/uploads-reader.sql).
 * Postgres's own privileges are what keep the reader out; this refuses a
 * deployment whose role was given more.
 */
export const checkReaderRole = async (
  url: string | undefined = env.UPLOADS_READER_URL
): Promise<void> => {
  if (!url) throw new Error("UPLOADS_READER_URL is not set");
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
      throw new Error(`The uploads reader role "${reader.role}" ${problem}`);
    };
    if (reader.db !== own) {
      throw new Error(
        `UPLOADS_READER_URL must name Zeteo's own database "${own}", not "${reader.db}"`
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

/** `server_version_num` of PostgreSQL 16: loads use `pg_input_is_valid`. */
export const MIN_SERVER_VERSION_NUM = 160_000;

/**
 * What is wrong with Zeteo's own database for Uploads, or null: it must
 * be PostgreSQL 16 or later (`pg_input_is_valid`), and Zeteo's own role must
 * hold `CREATE` on it (each upload source gets its own `zu_` schema).
 */
export const ownDatabaseProblem = ({
  database,
  versionNum,
  canCreate,
}: {
  database: string;
  versionNum: number;
  canCreate: boolean;
}): string | null => {
  if (versionNum < MIN_SERVER_VERSION_NUM) {
    return `Uploads need PostgreSQL 16 or later; the database "${database}" runs server_version_num ${versionNum}`;
  }
  if (!canCreate) {
    return `Uploads need CREATE on the database "${database}" for Zeteo's own role, which creates a schema per upload source (GRANT CREATE ON DATABASE)`;
  }
  return null;
};

/**
 * The start-up check of Uploads, run when `UPLOADS_READER_URL` is
 * set: the URL's `sslmode` is one Zeteo supports, Zeteo's own database fits
 * (`ownDatabaseProblem`), and the reader role holds no more than it should
 * (`checkReaderRole`). Each failure throws an error that says what to fix, so
 * a misconfiguration stops the start instead of failing queries later.
 */
export const checkUploadsSetup = async (): Promise<void> => {
  try {
    uploadsReaderSettings();
  } catch (err) {
    if (err instanceof UploadsMisconfiguredError) {
      throw new Error(err.problem, { cause: err });
    }
    if (err instanceof UploadsNotConfiguredError) {
      throw new Error("UPLOADS_READER_URL is not set", { cause: err });
    }
    throw err;
  }
  const [own] = await prisma.$queryRaw<
    Array<{ database: string; version_num: number; can_create: boolean }>
  >`
    SELECT current_database() AS database,
           current_setting('server_version_num')::int AS version_num,
           has_database_privilege(current_database(), 'CREATE') AS can_create`;
  const problem = ownDatabaseProblem({
    database: own.database,
    versionNum: own.version_num,
    canCreate: own.can_create,
  });
  if (problem) throw new Error(problem);
  await checkReaderRole();
};
