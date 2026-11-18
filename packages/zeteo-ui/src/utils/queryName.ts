/** The query language's name shape, as zeteo checks it: tables, columns and relations. */
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const NAME_RULE =
  "A lowercase letter, then lowercase letters, digits or _ (at most 63).";

/** Why `name` cannot name a table, column or relation; undefined when it can. */
export const nameProblem = (name: string): string | undefined =>
  NAME.test(name) ? undefined : NAME_RULE;
