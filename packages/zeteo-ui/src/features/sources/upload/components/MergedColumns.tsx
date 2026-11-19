import type { UnionColumn } from "../api/merged";
import { Alert, Input } from "@kosmeo-ui/react";

export const TYPE_CLASH = "Members disagree on the type; it will be text";

interface Props {
  columns: UnionColumn[];
  /** How many members are chosen: the "m" of "n of m". */
  memberCount: number;
  isIncluded: (column: UnionColumn) => boolean;
  nameOf: (column: UnionColumn) => string;
  /** A problem with the name a column would get; shown beside it. */
  problemOf?: (column: UnionColumn) => string | undefined;
  onInclude: (column: UnionColumn, include: boolean) => void;
  onRename: (column: UnionColumn, name: string) => void;
}

/** Whether the members of a union column disagree on its type. */
export const clashes = (column: UnionColumn): boolean =>
  column.types.length > 1;

/** The editor's columns table: the members' column union, what to include and what to call it. */
export const MergedColumns = ({
  columns,
  memberCount,
  isIncluded,
  nameOf,
  problemOf,
  onInclude,
  onRename,
}: Props) => (
  <table className="z-merged-table z-merged-columns">
    <thead>
      <tr>
        <th>Column</th>
        <th>In</th>
        <th>Type</th>
        <th>Include</th>
        <th>Name</th>
      </tr>
    </thead>
    <tbody>
      {columns.map((c) => {
        const included = isIncluded(c);
        return (
          <tr key={c.name}>
            <td>{c.name}</td>
            <td>{`${c.members.length} of ${memberCount}`}</td>
            <td>
              <span className="z-column-type">{c.type}</span>
              {clashes(c) && <Alert variant="warning">{TYPE_CLASH}</Alert>}
            </td>
            <td>
              <input
                type="checkbox"
                aria-label={`Include ${c.name}`}
                checked={included}
                onChange={(e) => onInclude(c, e.target.checked)}
              />
            </td>
            <td>
              <Input
                aria-label={`Name of column ${c.name}`}
                value={nameOf(c)}
                disabled={!included}
                error={included ? problemOf?.(c) : undefined}
                onChange={(e) => onRename(c, e.target.value)}
              />
            </td>
          </tr>
        );
      })}
    </tbody>
  </table>
);
