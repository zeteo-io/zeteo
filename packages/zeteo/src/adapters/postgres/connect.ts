import { type PostgresSettings, toPgConfig } from "./settings.js";
import { SourceUnreachableError } from "../../utils/errors.js";
import type { ResolvedTarget } from "../../sources/network.js";
import { logger } from "../../utils/logger.js";
import { checkLogin } from "./loginCheck.js";
import { readSchema } from "./readSchema.js";
import { Pool } from "pg";
import type {
  LoginFinding,
  SchemaSnapshot,
  SourceConnection,
} from "../types.js";

export class PostgresConnection implements SourceConnection {
  constructor(readonly pool: Pool) {}

  checkLogin(schemas: string[]): Promise<LoginFinding[]> {
    return checkLogin(this.pool, schemas);
  }

  readSchema(schemas: string[]): Promise<SchemaSnapshot> {
    return readSchema(this.pool, schemas);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Opens a pool and acquires one client before resolving, so a bad login or an
 * unreachable server fails here. The driver's error is logged, never thrown.
 */
export const connectPostgres = async (
  settings: PostgresSettings,
  target: ResolvedTarget,
  options: { connectTimeoutMs: number; poolSize: number }
): Promise<PostgresConnection> => {
  const pool = new Pool(toPgConfig(settings, target, options));
  // An idle client dropped by the server must not crash the process.
  pool.on("error", (err) => {
    logger.warn({ err, host: target.host }, "source pool client error");
  });
  try {
    const client = await pool.connect();
    client.release();
    return new PostgresConnection(pool);
  } catch (err) {
    logger.warn(
      { err, host: target.host, port: settings.port },
      "source connection failed"
    );
    await pool.end().catch(() => undefined);
    throw new SourceUnreachableError();
  }
};
