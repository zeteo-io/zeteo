import type { ListOptions, Page } from "./types/common.js";
import { ZeteoError } from "./errors.js";

export async function* paginate<T, O extends ListOptions>(
  list: (options: O) => Promise<Page<T>>,
  options?: O
): AsyncGenerator<T> {
  let cursor = options?.cursor;
  do {
    const sent = cursor;
    const page = await list({ ...options, cursor } as O);
    yield* page.data;
    cursor = page.next_cursor ?? undefined;
    if (cursor !== undefined && cursor === sent) {
      throw new ZeteoError("next_cursor repeats the cursor just sent", {
        status: null,
        code: "pagination_stuck",
      });
    }
  } while (cursor !== undefined);
}
