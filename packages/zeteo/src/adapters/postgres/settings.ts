import type { ResolvedTarget } from "../../sources/network.js";
import type { ConnectOptions } from "../types.js";
import type { PoolConfig } from "pg";
import { isIP } from "node:net";
import { z } from "zod";

export const postgresSettingsSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1),
  tls: z.enum(["verify", "require", "off"]).default("verify"),
  ca: z.string().optional(),
});

export type PostgresSettings = z.infer<typeof postgresSettingsSchema>;

export const APPLICATION_NAME = "zeteo";

/**
 * The one place settings become driver config. The connection dials
 * `target.address`, the address that passed the network rules; `target.host`
 * only names the server in the TLS handshake.
 */
export const toPgConfig = (
  settings: PostgresSettings,
  target: ResolvedTarget,
  options: ConnectOptions
): PoolConfig & { replication: string; sslnegotiation: string } => {
  const servername = isIP(target.host) === 0 ? target.host : undefined;
  const tlsName = servername === undefined ? {} : { servername };
  const ssl: PoolConfig["ssl"] =
    settings.tls === "off"
      ? false
      : settings.tls === "require"
        ? { rejectUnauthorized: false, ...tlsName }
        : {
            rejectUnauthorized: true,
            ...tlsName,
            ...(settings.ca === undefined ? {} : { ca: settings.ca }),
          };
  return {
    host: target.address,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    // A function is used as given. A plain string that is empty would count as
    // missing, and pg would then fall back to PGPASSWORD or ~/.pgpass.
    password: () => settings.password,
    ssl,
    application_name: APPLICATION_NAME,
    connectionTimeoutMillis: options.connectTimeoutMs,
    max: options.poolSize,
    query_timeout: options.queryTimeoutMs,
    statement_timeout: options.queryTimeoutMs,
    // pg reads these from PGREPLICATION and PGSSLNEGOTIATION when unset.
    replication: "false",
    sslnegotiation: "postgres",
    // Sent in the startup packet, so it applies before the connection is
    // usable. A backstop only: the login's own rights are the boundary.
    options: "-c default_transaction_read_only=on",
  };
};
