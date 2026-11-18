import { ErrorNotice } from "@/components/ErrorNotice";
import type { ApiError } from "@/lib/api";
import { Alert } from "@kosmeo-ui/react";
import { listRows } from "./labels";

/**
 * A failed load or retype. A `cast_failed` names the column and the rows whose
 * values do not fit its type (the uploader's own data); any other failure is
 * the usual notice. A load from an upload numbers rows of the file, its header
 * counted (`rowsOf="file"`); a retype reloads the stored table and numbers its
 * data rows (`rowsOf="table"`).
 */
export const LoadFailure = ({
  error,
  rowsOf = "file",
}: {
  error: ApiError | null;
  rowsOf?: "file" | "table";
}) => {
  if (error?.code !== "cast_failed" || !error.cast) {
    return <ErrorNotice error={error} />;
  }
  const { table, column, rows } = error.cast;
  return (
    <Alert variant="danger">
      <p>
        Column <strong>{column}</strong>
        {table && (
          <>
            {" "}
            of <strong>{table}</strong>
          </>
        )}{" "}
        has values that do not fit its type
        {rows.length > 0 && (
          <>
            {" "}
            {rowsOf === "file"
              ? `(row${rows.length > 1 ? "s" : ""} ${listRows(rows)} of the file)`
              : `(data row${rows.length > 1 ? "s" : ""} ${listRows(rows)} of the table)`}
          </>
        )}
        .
      </p>
      <p>
        Choose another type (Text always fits), or fix the file. Nothing was
        changed.
      </p>
    </Alert>
  );
};
