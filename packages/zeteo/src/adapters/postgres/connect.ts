import { sourceBusy, SourceUnreachableError } from "../../utils/errors.js";
import { type PostgresSettings, toPgConfig } from "./settings.js";
import type { ResolvedTarget } from "../../sources/network.js";
import { logger } from "../../utils/logger.js";
import { checkLogin } from "./loginCheck.js";
import { readSchema } from "./readSchema.js";
import { Pool } from "pg";
import {
  isPoolExhausted,
  PostgresPreparedQuery,
  runPostgresQuery,
} from "./runQuery.js";
import type {
  ConnectOptions,
  LoginFinding,
  PreparedQuery,
  QueryResult,
  RunLimits,
  SchemaSnapshot,
  SourceConnection,
} from "../types.js";

export class PostgresConnection implements SourceConnection {
  constructor(readonly pool: Pool) {}

  checkLogin(): Promise<LoginFinding[]> {
    return this.guarded((pool) => checkLogin(pool));
  }

  readSchema(schemas: string[]): Promise<SchemaSnapshot> {
    return this.guarded((pool) => readSchema(pool, schemas));
  }

  runQuery(
    prepared: PreparedQuery,
    limits: RunLimits,
    signal?: AbortSignal
  ): Promise<QueryResult> {
    if (!(prepared instanceof PostgresPreparedQuery)) {
      return Promise.reject(
        new Error("a query prepared by another adapter cannot run here")
      );
    }
    return runPostgresQuery(this.pool, prepared, limits, signal);
  }

  /**
   * Any driver failure, a timeout included, surfaces as the fixed error; the
   * driver's is logged. A pool with every connection in use is busy (503),
   * not unreachable, so the source keeps its status and its pool.
   */
  async guarded<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
    try {
      return await run(this.pool);
    } catch (err) {
      logger.warn({ err }, "source query failed");
      if (isPoolExhausted(err)) throw sourceBusy();
      throw new SourceUnreachableError();
    }
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
  options: ConnectOptions
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
