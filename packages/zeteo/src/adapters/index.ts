import type { SourceAdapter, SourceType } from "./types.js";
import { azureSqlAdapter } from "./azure-sql/index.js";
import { postgresAdapter } from "./postgres/index.js";

export const adapterFor = (type: SourceType): SourceAdapter => {
  switch (type) {
    case "postgres":
      return postgresAdapter as SourceAdapter;
    case "azure-sql":
      return azureSqlAdapter as SourceAdapter;
  }
};
