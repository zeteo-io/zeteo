/**
 * `fn` over `items` with at most `limit` running at once, results in the
 * items' order. After one rejects, or once `signal` aborts, no further item
 * is started; the returned promise rejects with that failure (or the abort
 * reason), while calls already running are left to settle.
 */
export const mapConcurrently = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      try {
        results[i] = await fn(items[i]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
};
