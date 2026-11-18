import type { PostgresSettings } from "../adapters/postgres/settings.js";
import { resolveAllowed, type ResolvedTarget } from "./network.js";
import { openSettings } from "../utils/crypto/envelope.js";
import { logger } from "../utils/logger.js";
import { isIP } from "node:net";
import env from "../env.js";
import type {
  ConnectOptions,
  SourceAdapter,
  SourceConnection,
} from "../adapters/types.js";

export const CONNECT_TIMEOUT_MS = 5000;
export const QUERY_TIMEOUT_MS = 15_000;

/**
 * A source pool's connections: every query and export the source may run at
 * once, plus two, so a refresh still gets a connection while queries and
 * exports hold as many as they may.
 */
export const poolSizeFor = (source: {
  queryConcurrency: number;
  exportConcurrency: number;
}): number => source.queryConcurrency + source.exportConcurrency + 2;

/** A login check's own connection, which runs one statement at a time. */
export const CHECK_POOL_SIZE = 1;

/**
 * A source's settings, parsed by its adapter. A stored value that cannot be
 * opened or parsed (another master key, a changed schema) fails as an
 * ordinary error, which the API answers with its generic 500.
 */
export const readSettings = (
  adapter: SourceAdapter,
  sourceId: string,
  sealed: unknown
): unknown => {
  try {
    return adapter.settingsSchema.parse(
      openSettings(sealed as Parameters<typeof openSettings>[0], sourceId)
    );
  } catch (err) {
    logger.error({ err, source_id: sourceId }, "source settings unreadable");
    throw new Error("source settings cannot be opened", { cause: err });
  }
};

const connectOptions = (poolSize: number): ConnectOptions => ({
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  poolSize,
  queryTimeoutMs: QUERY_TIMEOUT_MS,
});

/** `sslmode` in `FILE_SOURCES_READER_URL` as the Postgres adapter's `tls`. */
const READER_TLS: Record<string, PostgresSettings["tls"]> = {
  disable: "off",
  require: "require",
  "verify-full": "verify",
};

/**
 * The File Sources reader's connection settings, from
 * `FILE_SOURCES_READER_URL`: the role that may only read `zf_*` schemas.
 * `sslmode` is `disable` (the default), `require` or `verify-full`; any other
 * value throws, as does an unset URL.
 */
export const fileReaderSettings = (): PostgresSettings => {
  if (!env.FILE_SOURCES_READER_URL) {
    throw new Error("File Sources are not configured");
  }
  const url = new URL(env.FILE_SOURCES_READER_URL);
  const sslmode = url.searchParams.get("sslmode") ?? "disable";
  const tls = READER_TLS[sslmode];
  if (!tls) {
    throw new Error(
      `FILE_SOURCES_READER_URL's sslmode must be disable, require or verify-full, not "${sslmode}"`
    );
  }
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    tls,
  };
};

/**
 * Connects as the File Sources reader. Not checked against
 * `SOURCE_ALLOWED_HOSTS`: those rules are for the databases admins register,
 * and the reader is Zeteo's own database, named by the operator in its
 * environment. The adapter's queries run READ ONLY at read committed, never
 * REPEATABLE READ: storage swaps tables in with DDL, which is not MVCC-safe.
 */
export const connectFileReader = (
  adapter: SourceAdapter,
  poolSize: number
): Promise<SourceConnection> => {
  const settings = fileReaderSettings();
  const target: ResolvedTarget = {
    host: settings.host,
    address: settings.host,
    family: isIP(settings.host) === 6 ? 6 : 4,
  };
  return adapter.connect(settings, target, connectOptions(poolSize));
};

/**
 * Checks the destination against the network rules, then connects to the
 * address that passed them, with a pool of at most `poolSize` connections.
 * Never dials the host from the settings itself.
 */
export const connectChecked = async (
  adapter: SourceAdapter,
  settings: unknown,
  poolSize: number
): Promise<SourceConnection> => {
  const target = await resolveAllowed(
    adapter.hostOf(settings),
    env.SOURCE_ALLOWED_HOSTS
  );
  return adapter.connect(settings, target, connectOptions(poolSize));
};
