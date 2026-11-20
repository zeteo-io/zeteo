import type { Condition } from "../adapters/sql/language.js";

/** A value taken from the caller's identity (API: key name; stored: key id). */
export type IdentityRef = { identity: string; below?: boolean };

export type RuleCondition =
  | Condition
  | { eq: IdentityRef }
  | { ne: IdentityRef }
  | { in: IdentityRef }
  | { notIn: IdentityRef };

export type RuleFilter =
  | { and: RuleFilter[] }
  | { or: RuleFilter[] }
  | { not: RuleFilter }
  | Record<string, RuleCondition>;

export type RowAccess = "unlimited_default" | "all" | "rule";
