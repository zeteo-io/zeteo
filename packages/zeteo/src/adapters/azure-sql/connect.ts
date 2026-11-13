import { sourceBusy, SourceUnreachableError } from "../../utils/errors.js";
import { type AzureSqlSettings, toMssqlConfig } from "./settings.js";
import type { ResolvedTarget } from "../../sources/network.js";
import { bufferedStream } from "../bufferedStream.js";
import { logger } from "../../utils/logger.js";
import { checkLogin } from "./loginCheck.js";
import { readSchema } from "./readSchema.js";
import type { ConnectionPool } from "mssql";
import sql from "mssql";
import {
  isPoolExhausted,
  AzureSqlPreparedQuery,
  runAzureSqlQuery,
} from "./runQuery.js";
import type {
  ConnectOptions,
  LoginFinding,
  OpenLimits,
  PreparedQuery,
  RowStream,
  RunLimits,
  SchemaSnapshot,
  SourceConnection,
} from "../types.js";

const hasCaps = (limits: OpenLimits): limits is RunLimits =>
  typeof (limits as Partial<RunLimits>).maxRows === "number" &&
  typeof (limits as Partial<RunLimits>).maxBytes === "number";

export class AzureSqlConnection implements SourceConnection {
  constructor(readonly pool: ConnectionPool) {}

  checkLogin(): Promise<LoginFinding[]> {
    return this.guarded((pool) => checkLogin(pool));
  }

  readSchema(schemas: string[]): Promise<SchemaSnapshot> {
    return this.guarded((pool) => readSchema(pool, schemas));
  }

  /**
   * Runs the query whole within the row and byte caps the caller's limits
   * carry, then hands its rows out from memory; the first row left out
   * comes last, so the reader sees the cap.
   */
  async openQuery(
    prepared: PreparedQuery,
    limits: OpenLimits,
    signal?: AbortSignal
  ): Promise<RowStream> {
    if (!(prepared instanceof AzureSqlPreparedQuery)) {
      throw new Error("a query prepared by another adapter cannot run here");
    }
    if (!hasCaps(limits)) {
      throw new Error("an Azure SQL query needs row and byte caps");
    }
    const { columns, rows, leftOut } = await runAzureSqlQuery(
      this.pool,
      prepared,
      limits,
      signal
    );
    return bufferedStream(columns, leftOut ? [...rows, leftOut] : rows);
  }

  /**
   * Any driver failure, a timeout included, surfaces as the fixed error; the
   * driver's is logged. A pool with every connection in use is busy (503),
   * not unreachable, so the source keeps its status and its pool.
   */
  async guarded<T>(run: (pool: ConnectionPool) => Promise<T>): Promise<T> {
    try {
      return await run(this.pool);
    } catch (err) {
      logger.warn({ err }, "source query failed");
      if (isPoolExhausted(err)) throw sourceBusy();
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
