import { openSettings } from "../utils/crypto/envelope.js";
import { resolveAllowed } from "./network.js";
import { logger } from "../utils/logger.js";
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
  const options: ConnectOptions = {
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    poolSize,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
  };
  return adapter.connect(settings, target, options);
};
