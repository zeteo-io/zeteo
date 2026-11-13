import type { TestTagDefinition } from "vitest/config";

export const TIER_TAGS = ["unit", "int"] as const;
export const AREA_TAGS = ["platform"] as const;
export const DETAIL_TAGS = ["race", "job", "security", "slow"] as const;
export const ASPECTS = [
  "validation",
  "permissions",
  "races",
  "audit",
  "limits",
  "errors",
  "leak",
  "injection",
] as const;
export const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export type TierTag = (typeof TIER_TAGS)[number];
export type AreaTag = (typeof AREA_TAGS)[number];
export type DetailTag = (typeof DETAIL_TAGS)[number];

declare module "vitest" {
  interface TestTags {
    tag: TierTag | AreaTag | DetailTag;
  }
}

export const TAGS: TestTagDefinition[] = [
  { name: "unit", description: "Runs with no database, Redis or server" },
  {
    name: "int",
    description: "Runs against the real server, Postgres and Redis",
  },
  { name: "platform", description: "Health, startup and shutdown" },
  { name: "race", description: "Concurrent requests or processes" },
  { name: "job", description: "Background jobs and schedulers" },
  { name: "security", description: "Security properties and attack paths" },
  {
    name: "slow",
    description: "Takes long; raises the test timeout",
    timeout: 120_000,
  },
];

/**
 * Areas a test file may carry, by path under `src/tests`. The longest
 * matching prefix wins; a path matching none accepts any area.
 */
export const AREA_BY_PATH: ReadonlyArray<
  readonly [prefix: string, area: AreaTag]
> = [
  ["routes/health", "platform"],
  ...AREA_TAGS.map((a) => [`flows/${a}`, a] as const),
];
