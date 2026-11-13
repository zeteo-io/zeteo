import { mssqlSourceSettings, queryMssqlAdmin } from "./mssqlFixture.js";
import type { SourceType } from "../../adapters/types.js";
import { fixtureAdminSettings } from "./fixtureDb.js";
import { sourceSettings } from "./sources.js";
import { describe } from "vitest";
import { Client } from "pg";

/**
 * One source engine the query suite runs against: how to register a source
 * over its copy of the fixture, and how to look at what is running there.
 */
export interface EngineFixture {
  name: string;
  type: SourceType;
  /** Settings for a source over the fixture, as its read-only login. */
  sourceSettings(): unknown;
  /** The schemas holding the portable fixture tables. */
  schemas: string[];
  /** How many statements reading `view` are running on the fixture database now. */
  runningOn(view: string): Promise<number>;
}

const postgres: EngineFixture = {
  name: "postgres",
  type: "postgres",
  sourceSettings: () => sourceSettings("ro"),
  schemas: ["sales"],
  runningOn: async (view) => {
    const admin = new Client({ ...fixtureAdminSettings(), ssl: false });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND state = 'active'
           AND pid <> pg_backend_pid() AND query LIKE $1`,
        [`%${view}%`]
      );
      return rows[0]!.n;
    } finally {
      await admin.end();
    }
  },
};

const azureSql: EngineFixture = {
  name: "azure-sql",
  type: "azure-sql",
  sourceSettings: () => mssqlSourceSettings("ro"),
  schemas: ["sales"],
  runningOn: async (view) => {
    const [{ n }] = await queryMssqlAdmin<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sys.dm_exec_requests r
        CROSS APPLY sys.dm_exec_input_buffer(r.session_id, r.request_id) b
        WHERE r.database_id = DB_ID() AND r.session_id <> @@SPID
          AND b.event_info LIKE @p0`,
      [`%${view}%`]
    );
    return n;
  },
};

export const ENGINES: EngineFixture[] = [postgres, azureSql];

/** A `describe` per engine, named `<name> (<engine>)`. */
export const describeEachEngine = (
  name: string,
  fn: (engine: EngineFixture) => void
): void => {
  for (const engine of ENGINES) {
    describe(`${name} (${engine.name})`, () => fn(engine));
  }
};
