/** The codes of the `QueryError`s the SQL language's planner and compiler throw. */
export type SqlQueryErrorCode =
  | "not_found_or_not_accessible"
  | "missing_in_source"
  | "column_not_queryable"
  | "invalid_operator"
  | "invalid_value"
  | "invalid_grouping"
  | "invalid_order"
  | "invalid_having"
  | "duplicate_output_name"
  | "join_parent_missing"
  | "too_many_parameters";
