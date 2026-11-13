import { type AzureSqlSettings, toMssqlConfig } from "./settings.js";
import type { ResolvedTarget } from "../../sources/network.js";
import { SourceUnreachableError } from "../../utils/errors.js";
import { runAzureSqlQuery } from "./runQuery.js";
import { logger } from "../../utils/logger.js";
import type { SqlPlan } from "../sql/types.js";
import { checkLogin } from "./loginCheck.js";
import { readSchema } from "./readSchema.js";
import type { ConnectionPool } from "mssql";
import sql from "mssql";
import type {
  ConnectOptions,
  LoginFinding,
  QueryPlan,
  QueryResult,
  RunLimits,
  SchemaSnapshot,
  SourceConnection,
} from "../types.js";

export class AzureSqlConnection implements SourceConnection {
  constructor(readonly pool: ConnectionPool) {}

  checkLogin(): Promise<LoginFinding[]> {
    return this.guarded((pool) => checkLogin(pool));
  }

  readSchema(schemas: string[]): Promise<SchemaSnapshot> {
    return this.guarded((pool) => readSchema(pool, schemas));
  }

  /** The plan comes from this adapter's own language, so it is a SQL plan. */
  runQuery(
    plan: QueryPlan,
    limits: RunLimits,
    signal?: AbortSignal
  ): Promise<QueryResult> {
    return runAzureSqlQuery(this.pool, plan as SqlPlan, limits, signal);
  }

  /** Any driver failure, a timeout included, surfaces as the fixed error; the driver's is logged. */
  async guarded<T>(run: (pool: ConnectionPool) => Promise<T>): Promise<T> {
    try {
      return await run(this.pool);
    } catch (err) {
      logger.warn({ err }, "source query failed");
      throw new SourceUnreachableError();
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

/**
 * Opens a pool, which logs in once before resolving, so a bad login or an
 * unreachable server fails here. The driver's error is logged, never thrown.
 */
export const connectAzureSql = async (
  settings: AzureSqlSettings,
  target: ResolvedTarget,
  options: ConnectOptions
): Promise<AzureSqlConnection> => {
  const pool = new sql.ConnectionPool(toMssqlConfig(settings, target, options));
  // A pooled connection that fails later must not crash the process.
  pool.on("error", (err) => {
    logger.warn({ err, host: target.host }, "source pool connection error");
  });
  try {
    await pool.connect();
    return new AzureSqlConnection(pool);
  } catch (err) {
    logger.warn(
      { err, host: target.host, port: settings.port },
      "source connection failed"
    );
    await pool.close().catch(() => undefined);
    throw new SourceUnreachableError();
  }
};
