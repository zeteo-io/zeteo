import type { ListOptions, Page } from "./types/common.js";

export async function* paginate<T, O extends ListOptions>(
  list: (options: O) => Promise<Page<T>>,
  options?: O
): AsyncGenerator<T> {
  let cursor = options?.cursor;
  do {
    const page = await list({ ...options, cursor } as O);
    yield* page.data;
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
}
