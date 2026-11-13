/** How long one of zeteo's own Redis commands on a request's path may take. */
export const REDIS_COMMAND_TIMEOUT_MS = 1000;

export class RedisTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Redis did not answer within ${timeoutMs} ms`);
    this.name = "RedisTimeoutError";
  }
}

/**
 * `command`, or a `RedisTimeoutError` once it has taken `timeoutMs`. The
 * shared client queues commands while it reconnects and waits on them
 * forever; tereo's SDK uses the same client, so the bound is per call, not
 * the client's. A command that times out stays queued and may still run once
 * Redis is back.
 */
export const withinRedisTimeout = <T>(
  command: Promise<T>,
  timeoutMs = REDIS_COMMAND_TIMEOUT_MS
): Promise<T> => {
  // Settling after the timeout, it must not be an unhandled rejection.
  command.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RedisTimeoutError(timeoutMs)),
      timeoutMs
    );
  });
  return Promise.race([command, timedOut]).finally(() => clearTimeout(timer));
};
