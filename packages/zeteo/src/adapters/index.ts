import type { SourceAdapter, SourceType } from "./types.js";
import { azureSqlAdapter } from "./azure-sql/index.js";
import { postgresAdapter } from "./postgres/index.js";

/** A stored source type this build has no adapter for, such as one a newer release added. */
export class NoAdapterError extends Error {
  constructor(readonly type: string) {
    super(`No adapter for source type ${type}`);
    this.name = "NoAdapterError";
  }
}

/** The adapter for `type`; throws `NoAdapterError` for a type with none. */
export const adapterFor = (type: SourceType): SourceAdapter => {
  switch (type) {
    case "postgres":
      return postgresAdapter as SourceAdapter;
    case "azure-sql":
      return azureSqlAdapter as SourceAdapter;
    default:
      throw new NoAdapterError(String(type));
  }
};
