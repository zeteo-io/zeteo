import { openSettings } from "../utils/crypto/envelope.js";
import { SOURCE_CONCURRENCY } from "../engine/limits.js";
import { resolveAllowed } from "./network.js";
import { logger } from "../utils/logger.js";
import env from "../env.js";
import type {
  ConnectOptions,
  SourceAdapter,
  SourceConnection,
} from "../adapters/types.js";

export const CONNECT_TIMEOUT_MS = 5000;
/**
 * Every query the source may run at once, plus two: a refresh or login check
 * still gets a connection while user queries hold as many as they may.
 */
export const POOL_SIZE = SOURCE_CONCURRENCY + 2;
export const QUERY_TIMEOUT_MS = 15_000;

export const CONNECT_OPTIONS: ConnectOptions = {
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  poolSize: POOL_SIZE,
  queryTimeoutMs: QUERY_TIMEOUT_MS,
};

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
 * address that passed them. Never dials the host from the settings itself.
 */
export const connectChecked = async (
  adapter: SourceAdapter,
  settings: unknown
): Promise<SourceConnection> => {
  const target = await resolveAllowed(
    adapter.hostOf(settings),
    env.SOURCE_ALLOWED_HOSTS
  );
  return adapter.connect(settings, target, CONNECT_OPTIONS);
};
