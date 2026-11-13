import { fixtureAdminSettings } from "./fixtureDb.js";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { Client } from "pg";

const SALES_SQL = fileURLToPath(
  new URL("../fixtures/postgres/sales.sql", import.meta.url)
);

const clientFor = (database: string) => {
  const { host, port, user, password } = fixtureAdminSettings();
  return new Client({ host, port, user, password, database });
};

export interface ThrowawayDb {
  name: string;
  /** Runs SQL as the server's superuser inside the throwaway database. */
  run: (sql: string) => Promise<void>;
  drop: () => Promise<void>;
}

/**
 * A database of its own holding `sales.sql`, for tests that change the
 * schema between catalogue refreshes. Its name starts with `zeteo_`.
 */
export const createThrowawayDb = async (): Promise<ThrowawayDb> => {
  const name = `zeteo_refresh_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = clientFor("postgres");
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const run = async (sql: string) => {
    const client = clientFor(name);
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await run(await readFile(SALES_SQL, "utf8"));
  return {
    name,
    run,
    drop: async () => {
      const dropper = clientFor("postgres");
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
};
