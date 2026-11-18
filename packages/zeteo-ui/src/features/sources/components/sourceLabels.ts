import type { SourceType } from "../api/types";

const TYPE_NAMES: Record<SourceType, string> = {
  postgres: "PostgreSQL",
  "azure-sql": "Azure SQL",
  upload: "Upload",
};

/** A source type by its product name. */
export const sourceTypeName = (type: SourceType): string =>
  TYPE_NAMES[type] ?? type;

const TLS_NAMES: Record<string, string> = {
  verify: "Required, certificate verified",
  require: "Required",
  off: "Off",
  "trust-server-certificate": "Required, server certificate trusted",
};

/** A connection's TLS mode in words. */
export const tlsName = (tls: unknown): string =>
  typeof tls === "string" ? (TLS_NAMES[tls] ?? tls) : "—";

const count = new Intl.NumberFormat();

/** A whole number with grouping: 50000 → "50,000". */
export const formatCount = (n: number): string => count.format(n);
