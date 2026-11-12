import { SourceTypeUnavailableError } from "../utils/errors.js";
import type { SourceAdapter, SourceType } from "./types.js";
import { postgresAdapter } from "./postgres/index.js";

export const adapterFor = (type: SourceType): SourceAdapter => {
  switch (type) {
    case "postgres":
      return postgresAdapter as SourceAdapter;
    case "azure-sql":
      throw new SourceTypeUnavailableError(type);
  }
};
