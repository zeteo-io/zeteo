import type { ResolvedTarget } from "../../sources/network.js";
import { connect, isIP, type Socket } from "node:net";
import type { config as MssqlConfig } from "mssql";
import type { ConnectOptions } from "../types.js";
import { z } from "zod";

export const azureSqlSettingsSchema = z.strictObject({
  // A backslash names an instance, which the driver would find by asking the
  // host over UDP: only a port is accepted.
  host: z
    .string()
    .min(1)
    .max(253)
    .refine((host) => !host.includes("\\"), {
      message: "A host is a name or an address, without an instance name",
    }),
  port: z.number().int().min(1).max(65535).default(1433),
  database: z.string().min(1).max(128),
  user: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
  tls: z.enum(["verify", "trust-server-certificate"]).default("verify"),
});

export type AzureSqlSettings = z.infer<typeof azureSqlSettingsSchema>;

export const APPLICATION_NAME = "zeteo";

/** What tedious passes its `connector`: the server and port it means to reach. */
interface ConnectorOptions {
  host: string;
  port: number;
  localAddress?: string;
}

type Connector = (
  options: ConnectorOptions,
  lookup: unknown,
  signal: AbortSignal
) => Promise<Socket>;

/**
 * Dials `target.address`, the address that passed the network rules, in
 * place of the driver resolving the name itself. Refuses any other server or
 * port: a server that redirects the login (Azure SQL's `Redirect` connection
 * policy) names a host no rule has checked.
 */
const connectorTo =
  (target: ResolvedTarget, port: number): Connector =>
  (options, _lookup, signal) => {
    if (options.host !== target.host || options.port !== port) {
      return Promise.reject(
        new Error(
          `refused a redirect to ${options.host}:${options.port}; only ${target.host}:${port} was checked`
        )
      );
    }
    if (isIP(target.address) === 0) {
      return Promise.reject(new Error("the checked address is not an IP"));
    }
    return new Promise<Socket>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const socket = connect({
        host: target.address,
        port,
        family: target.family,
      });
      const settle = () => {
        signal.removeEventListener("abort", onAbort);
        socket.removeListener("error", onError);
        socket.removeListener("connect", onConnect);
      };
      const onAbort = () => {
        settle();
        socket.destroy();
        reject(signal.reason);
      };
      const onError = (err: Error) => {
        settle();
        socket.destroy();
        reject(err);
      };
      const onConnect = () => {
        settle();
        resolve(socket);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  };

/**
 * The one place settings become driver config. `server` is the checked
 * hostname, which the driver sends in the login packet and checks the
 * certificate against; the socket goes to `target.address` through the
 * connector. Fields only: no connection string is ever built.
 */
export const toMssqlConfig = (
  settings: AzureSqlSettings,
  target: ResolvedTarget,
  options: ConnectOptions
): MssqlConfig => ({
  server: target.host,
  port: settings.port,
  database: settings.database,
  user: settings.user,
  password: settings.password,
  connectionTimeout: options.connectTimeoutMs,
  requestTimeout: options.queryTimeoutMs,
  pool: { max: options.poolSize, min: 0 },
  options: {
    // The pool copies these into tedious's options: an explicit port, so the
    // driver never looks an instance up, and encryption always on.
    port: settings.port,
    encrypt: true,
    trustServerCertificate: settings.tls === "trust-server-certificate",
    appName: APPLICATION_NAME,
    connector: connectorTo(
      target,
      settings.port
    ) as unknown as () => Promise<Socket>,
  },
});
